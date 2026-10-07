import Database from "better-sqlite3";
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "crypto";
import { promisify } from "util";
import { getHostedConfig } from "./hosted-config";

const scrypt = promisify(scryptCallback);
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 10;
const MAX_RATE_KEYS = 10_000;
const RATE_KEY_MAX_LENGTH = 128;
const LOCAL_OWNER_ID = "local";
const GENERIC_LOGIN_ERROR = "Invalid credentials";
const GENERIC_REDEEM_ERROR = "Invitation unavailable";

export interface AuthUser {
  id: string;
  username: string;
  role: "admin" | "user";
}

export interface InvitationMetadata {
  id: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_CREDENTIALS"
      | "RATE_LIMITED"
      | "FORBIDDEN"
      | "UNAVAILABLE"
      | "INVALID_INPUT",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validUsername(username: string): boolean {
  return (
    typeof username === "string" && /^[a-zA-Z0-9_.-]{3,64}$/.test(username)
  );
}

function validPassword(password: string): boolean {
  return (
    typeof password === "string" &&
    Buffer.byteLength(password, "utf8") >= 12 &&
    Buffer.byteLength(password, "utf8") <= 1024
  );
}

function opaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

@Injectable()
export class AuthService implements OnModuleDestroy {
  private readonly db: Database.Database;
  private readonly attempts = new Map<string, number[]>();

  constructor() {
    const path = getHostedConfig().databasePath;
    require("fs").mkdirSync(require("path").dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_users(id TEXT PRIMARY KEY, username TEXT NOT NULL, username_normalized TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
      CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
      CREATE TABLE IF NOT EXISTS auth_invitations(token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES auth_users(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_at TEXT, redeemed_by TEXT REFERENCES auth_users(id));
      CREATE INDEX IF NOT EXISTS auth_invitations_admin_idx ON auth_invitations(created_by, created_at);
      CREATE TABLE IF NOT EXISTS auth_security_events(id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, subject_hash TEXT NOT NULL, occurred_at TEXT NOT NULL);
    `);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO auth_schema_migrations(version, applied_at) VALUES(1, ?)",
      )
      .run(new Date().toISOString());
  }

  onModuleDestroy(): void {
    this.close();
  }
  close(): void {
    if (this.db.open) this.db.close();
  }

  /** Local-mode identity; requires no auth database lookup. */
  localPrincipal(): { id: string; role: "admin" } {
    return { id: LOCAL_OWNER_ID, role: "admin" };
  }

  async bootstrapAdmin(username: string, password: string): Promise<AuthUser> {
    this.validateCredentials(username, password);
    const normalized = username.toLowerCase();
    const passwordSalt = randomBytes(16).toString("base64");
    const passwordHash = await this.hashPassword(password, passwordSalt);
    const tx = this.db.transaction(() => {
      if (
        (
          this.db.prepare("SELECT count(*) AS n FROM auth_users").get() as {
            n: number;
          }
        ).n !== 0
      ) {
        throw new AuthError("Bootstrap unavailable", "UNAVAILABLE");
      }
      return this.insertUser(
        username,
        normalized,
        passwordSalt,
        passwordHash,
        "admin",
      );
    });
    try {
      return await tx.immediate();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (String(error).includes("UNIQUE"))
        throw new AuthError("Bootstrap unavailable", "UNAVAILABLE");
      throw error;
    }
  }

  async login(
    username: string,
    password: string,
    rateKey = "unknown",
  ): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
    const normalized =
      typeof username === "string" && username.length <= 64
        ? username.toLowerCase()
        : "";
    const clientTag = this.safeRateTag(rateKey);
    const accountRateKey = `login-account:${digest(normalized || "<invalid>")}`;
    const rateKeyForLogin = `${accountRateKey}:${clientTag}`;
    this.checkRate(accountRateKey);
    this.checkRate(rateKeyForLogin);
    const user = this.db
      .prepare(
        "SELECT id,username,role,password_salt,password_hash FROM auth_users WHERE username_normalized=?",
      )
      .get(normalized) as
      | (AuthUser & { password_salt: string; password_hash: string })
      | undefined;
    const salt = user?.password_salt ?? "AAAAAAAAAAAAAAAAAAAAAA==";
    const expected = user?.password_hash ?? "0".repeat(128);
    const candidate = Buffer.from(
      await this.hashPassword(
        typeof password === "string" ? password.slice(0, 1024) : "",
        salt,
      ),
      "hex",
    );
    const expectedBytes = Buffer.from(expected, "hex");
    const valid =
      candidate.length === expectedBytes.length &&
      timingSafeEqual(candidate, expectedBytes);
    if (
      !user ||
      !valid ||
      typeof password !== "string" ||
      Buffer.byteLength(password, "utf8") > 1024
    ) {
      this.recordFailure(rateKeyForLogin);
      this.recordFailure(accountRateKey);
      this.recordSecurityEvent("login_failure", normalized || "<invalid>");
      throw new AuthError(GENERIC_LOGIN_ERROR, "INVALID_CREDENTIALS");
    }
    this.attempts.delete(rateKeyForLogin);
    this.attempts.delete(accountRateKey);
    const token = opaqueToken();
    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() + SESSION_TTL_MS,
    ).toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
        )
        .run(createdAt.toISOString(), user.id);
      this.db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL)",
        )
        .run(digest(token), user.id, createdAt.toISOString(), expiresAt);
    });
    tx();
    this.recordSecurityEvent("login_success", normalized);
    return {
      user: { id: user.id, username: user.username, role: user.role },
      token,
      expiresAt,
    };
  }

  logout(token: string): void {
    if (typeof token !== "string" || token.length > 256) return;
    this.db
      .prepare(
        "UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL",
      )
      .run(new Date().toISOString(), digest(token));
    this.recordSecurityEvent("logout", digest(token));
  }

  authenticateSession(token: string): AuthUser | null {
    if (typeof token !== "string" || token.length > 256) return null;
    const row = this.db
      .prepare(
        `SELECT u.id,u.username,u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`,
      )
      .get(digest(token), new Date().toISOString()) as AuthUser | undefined;
    return row ?? null;
  }

  createInvitation(
    adminId: string,
    expiry: Date | string | number,
  ): { id: string; token: string; expiresAt: string } {
    this.requireAdmin(adminId);
    const expiryDate = new Date(expiry);
    const now = Date.now();
    if (
      !Number.isFinite(expiryDate.getTime()) ||
      expiryDate.getTime() <= now ||
      expiryDate.getTime() > now + INVITE_TTL_MAX_MS
    )
      throw new AuthError("Invalid expiry", "INVALID_INPUT");
    const token = opaqueToken();
    const id = randomBytes(16).toString("hex");
    const createdAt = new Date(now).toISOString();
    const expiresAt = expiryDate.toISOString();
    this.db
      .prepare(
        "INSERT INTO auth_invitations(token_hash,id,created_by,created_at,expires_at) VALUES(?,?,?,?,?)",
      )
      .run(digest(token), id, adminId, createdAt, expiresAt);
    return { id, token, expiresAt };
  }

  async redeemInvitation(
    token: string,
    username: string,
    password: string,
    rateKey = "unknown",
  ): Promise<AuthUser> {
    // Limit attempts per opaque invitation, not proxy IP: one shared web proxy
    // must not let guesses against one invite starve unrelated invitations.
    const throttleKey = `redeem:${digest(typeof token === "string" ? token.slice(0, 256) : "<invalid>")}`;
    this.checkRate(throttleKey);
    if (typeof token !== "string" || token.length > 256) {
      this.recordFailure(throttleKey);
      this.recordSecurityEvent("invite_redeem_failure", "<invalid>");
      throw new AuthError(GENERIC_REDEEM_ERROR, "UNAVAILABLE");
    }
    if (!validUsername(username) || !validPassword(password)) {
      this.recordSecurityEvent("invite_redeem_invalid_input", digest(token));
      throw new AuthError("Invalid account details", "INVALID_INPUT");
    }
    const passwordSalt = randomBytes(16).toString("base64");
    const passwordHash = await this.hashPassword(password, passwordSalt);
    const tx = this.db.transaction(() => {
      const invite = this.db
        .prepare(
          "SELECT token_hash FROM auth_invitations WHERE token_hash=? AND redeemed_at IS NULL AND expires_at>?",
        )
        .get(digest(token), new Date().toISOString()) as
        | { token_hash: string }
        | undefined;
      if (!invite) throw new AuthError(GENERIC_REDEEM_ERROR, "UNAVAILABLE");
      const user = {
        id: randomBytes(16).toString("hex"),
        username,
        role: "user" as const,
      };
      this.db
        .prepare(
          "INSERT INTO auth_users(id,username,username_normalized,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,'user',?)",
        )
        .run(
          user.id,
          username,
          username.toLowerCase(),
          passwordSalt,
          passwordHash,
          new Date().toISOString(),
        );
      const result = this.db
        .prepare(
          "UPDATE auth_invitations SET redeemed_at=?,redeemed_by=? WHERE token_hash=? AND redeemed_at IS NULL AND expires_at>?",
        )
        .run(
          new Date().toISOString(),
          user.id,
          invite.token_hash,
          new Date().toISOString(),
        );
      if (result.changes !== 1)
        throw new AuthError(GENERIC_REDEEM_ERROR, "UNAVAILABLE");
      return user;
    });
    try {
      const user = tx.immediate();
      this.attempts.delete(throttleKey);
      this.recordSecurityEvent("invite_redeem_success", inviteSubject(token));
      return user;
    } catch (error) {
      if (error instanceof AuthError && error.code === "INVALID_INPUT")
        throw error;
      this.recordFailure(throttleKey);
      this.recordSecurityEvent("invite_redeem_failure", inviteSubject(token));
      if (error instanceof AuthError) throw error;
      if (String(error).includes("UNIQUE"))
        throw new AuthError(GENERIC_REDEEM_ERROR, "UNAVAILABLE");
      throw error;
    }
  }

  listInvitationMetadata(adminId: string): InvitationMetadata[] {
    this.requireAdmin(adminId);
    return this.db
      .prepare(
        "SELECT id,created_at AS createdAt,expires_at AS expiresAt,redeemed_at AS redeemedAt FROM auth_invitations WHERE created_by=? ORDER BY created_at DESC",
      )
      .all(adminId) as InvitationMetadata[];
  }

  private requireAdmin(id: string): void {
    const row = this.db
      .prepare("SELECT role FROM auth_users WHERE id=?")
      .get(id) as { role: string } | undefined;
    if (!row || row.role !== "admin")
      throw new AuthError("Administrator required", "FORBIDDEN");
  }

  private validateCredentials(username: string, password: string): void {
    if (!validUsername(username) || !validPassword(password))
      throw new AuthError("Invalid account details", "INVALID_INPUT");
  }

  private insertUser(
    username: string,
    normalized: string,
    salt: string,
    hash: string,
    role: "admin" | "user",
  ): AuthUser {
    const user = {
      id: randomBytes(16).toString("hex"),
      username,
      role,
    } as AuthUser;
    this.db
      .prepare(
        "INSERT INTO auth_users(id,username,username_normalized,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        user.id,
        username,
        normalized,
        salt,
        hash,
        role,
        new Date().toISOString(),
      );
    return user;
  }

  private async hashPassword(password: string, salt: string): Promise<string> {
    return ((await scrypt(password, salt, 64)) as Buffer).toString("hex");
  }

  private checkRate(key: string): void {
    this.pruneRateKeys();
    const now = Date.now();
    const active = (this.attempts.get(key) ?? []).filter(
      (time) => now - time < RATE_WINDOW_MS,
    );
    this.attempts.set(key, active);
    if (active.length >= RATE_LIMIT)
      throw new AuthError("Too many attempts", "RATE_LIMITED");
  }

  private recordFailure(key: string): void {
    this.pruneRateKeys();
    const now = Date.now();
    const active = (this.attempts.get(key) ?? []).filter(
      (time) => now - time < RATE_WINDOW_MS,
    );
    active.push(now);
    this.attempts.set(key, active);
  }

  private safeRateTag(value: string): string {
    return digest(
      typeof value === "string"
        ? value.slice(0, RATE_KEY_MAX_LENGTH)
        : "unknown",
    );
  }

  private pruneRateKeys(): void {
    if (this.attempts.size < MAX_RATE_KEYS) return;
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [key, values] of this.attempts) {
      const recent = values.filter((time) => time > cutoff);
      if (recent.length) this.attempts.set(key, recent);
      else this.attempts.delete(key);
    }
    while (this.attempts.size >= MAX_RATE_KEYS) {
      const first = this.attempts.keys().next().value as string | undefined;
      if (!first) break;
      this.attempts.delete(first);
    }
  }

  private recordSecurityEvent(type: string, subject: string): void {
    this.db
      .prepare(
        "INSERT INTO auth_security_events(event_type,subject_hash,occurred_at) VALUES(?,?,?)",
      )
      .run(type, digest(subject), new Date().toISOString());
    this.db
      .prepare(
        "DELETE FROM auth_security_events WHERE id NOT IN (SELECT id FROM auth_security_events ORDER BY id DESC LIMIT 1000)",
      )
      .run();
  }
}

function inviteSubject(token: string): string {
  return digest(token);
}
