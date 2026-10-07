import {
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import type { ParsedUpload } from "@instagram-manager/import-format";
import { getHostedConfig } from "./hosted-config";

type Side = "followers" | "following";
@Injectable()
export class RelationshipService {
  private db: Database.Database;
  constructor() {
    const path = getHostedConfig().databasePath;
    const fs = require("fs");
    fs.mkdirSync(require("path").dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username_normalized TEXT NOT NULL UNIQUE, display_username TEXT NOT NULL, profile_url TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, source_type TEXT NOT NULL, file_sha256 TEXT NOT NULL, status TEXT NOT NULL, warnings_json TEXT NOT NULL, identity TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS import_sides(import_id TEXT NOT NULL REFERENCES imports(id), side TEXT NOT NULL, coverage TEXT NOT NULL, observed_count INTEGER NOT NULL, latest_source_timestamp INTEGER, files_json TEXT NOT NULL, PRIMARY KEY(import_id,side));
       CREATE TABLE IF NOT EXISTS import_entries(import_id TEXT NOT NULL REFERENCES imports(id), side TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), source_relationship_timestamp INTEGER CHECK(source_relationship_timestamp IS NULL OR source_relationship_timestamp >= 0), source_timestamp_kind TEXT, PRIMARY KEY(import_id,side,account_id));
      CREATE TABLE IF NOT EXISTS relationships(account_id TEXT NOT NULL REFERENCES accounts(id), side TEXT NOT NULL, is_present INTEGER NOT NULL, first_observed_at TEXT, last_observed_at TEXT, absence_first_detected_at TEXT, source_relationship_timestamp INTEGER, source_timestamp_kind TEXT, last_complete_import_id TEXT, last_positive_import_id TEXT, PRIMARY KEY(account_id,side));
      CREATE TABLE IF NOT EXISTS relationship_changes(id TEXT PRIMARY KEY, import_id TEXT NOT NULL, account_id TEXT NOT NULL, side TEXT NOT NULL, kind TEXT NOT NULL, detected_at TEXT NOT NULL, previous_complete_import_id TEXT, evidence_coverage TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_preferences(account_id TEXT PRIMARY KEY REFERENCES accounts(id), keep_following INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0, manual_status TEXT, note TEXT, updated_at TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }

  proposedRemovals(side: Side, names: string[]) {
    return this.db
      .prepare(
        "SELECT count(*) n FROM relationships r JOIN accounts a ON a.id=r.account_id WHERE r.side=? AND r.is_present=1 AND a.username_normalized NOT IN (SELECT value FROM json_each(?))",
      )
      .pluck()
      .get(side, JSON.stringify(names)) as number;
  }

  commit(
    preview: { parsed: ParsedUpload; hash: string },
    coverage: Partial<Record<Side, "complete" | "partial">>,
    opts: { idempotencyToken?: string; confirmHistoricalReplay?: boolean },
  ) {
    const { parsed, hash } = preview,
      sides = ["followers", "following"] as Side[];
    const selectedCoverage = Object.fromEntries(
      sides
        .filter((s) => parsed.sides[s])
        .map((s) => [s, coverage[s] ?? "partial"]),
    );
    const canonicalContent = createHash("sha256")
      .update(
        JSON.stringify({
          sides: Object.fromEntries(
            sides
              .filter((s) => parsed.sides[s])
              .map((s) => [
                s,
                parsed.sides[s]!.entries.map((e) => [
                  e.usernameNormalized,
                  e.displayUsername,
                  e.profileUrl,
                  e.sourceTimestamp,
                  e.sourceTimestampKind,
                ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
              ]),
          ),
        }),
      )
      .digest("hex");
    const identityHash = createHash("sha256")
      .update(JSON.stringify({ canonicalContent, coverage: selectedCoverage }))
      .digest("hex");
    const identity = opts.idempotencyToken
      ? `token:${opts.idempotencyToken}`
      : identityHash;
    const prior = this.db
      .prepare("SELECT id FROM imports WHERE identity=?")
      .pluck()
      .get(identity) as string | undefined;
    if (prior) return { id: prior, idempotent: true };
    const now = new Date().toISOString();
    const importId = randomUUID();
    const tx = this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO imports VALUES(?,?,?,?,?,?,?)")
        .run(
          importId,
          now,
          "instagram_export",
          hash,
          "committed",
          JSON.stringify(parsed.warnings),
          identity,
        );
      // Materialize the account union first. Complete absence baselines must see accounts
      // first introduced by either side in this same import.
      for (const side of sides) {
        const data = parsed.sides[side];
        if (!data) continue;
        for (const entry of data.entries) {
          let id = this.db
            .prepare("SELECT id FROM accounts WHERE username_normalized=?")
            .pluck()
            .get(entry.usernameNormalized) as string | undefined;
          if (!id) {
            id = randomUUID();
            this.db
              .prepare("INSERT INTO accounts VALUES(?,?,?,?,?)")
              .run(
                id,
                entry.usernameNormalized,
                entry.displayUsername,
                entry.profileUrl,
                now,
              );
          }
        }
      }
      for (const side of sides) {
        const data = parsed.sides[side];
        if (!data) continue;
        const cov = coverage[side] ?? "partial";
        const latest = Math.max(
          0,
          ...data.entries.map((e) => e.sourceTimestamp ?? 0),
        );
        const currentMax =
          (this.db
            .prepare(
              "SELECT max(source_relationship_timestamp) FROM relationships WHERE side=? AND is_present=1",
            )
            .pluck()
            .get(side) as number) ?? 0;
        if (
          latest &&
          currentMax &&
          latest < currentMax &&
          !opts.confirmHistoricalReplay
        )
          throw new ConflictException(
            "Older source data requires confirmHistoricalReplay",
          );
        this.db
          .prepare("INSERT INTO import_sides VALUES(?,?,?,?,?,?)")
          .run(
            importId,
            side,
            cov,
            data.entries.length,
            latest || null,
            JSON.stringify(data.files),
          );
        const selectRel = this.db.prepare(
          "SELECT * FROM relationships WHERE account_id=? AND side=?",
        );
        for (const entry of data.entries) {
          let id = this.db
            .prepare("SELECT id FROM accounts WHERE username_normalized=?")
            .pluck()
            .get(entry.usernameNormalized) as string | undefined;
          if (!id) {
            id = randomUUID();
            this.db
              .prepare("INSERT INTO accounts VALUES(?,?,?,?,?)")
              .run(
                id,
                entry.usernameNormalized,
                entry.displayUsername,
                entry.profileUrl,
                now,
              );
          }
          this.db
            .prepare("INSERT INTO import_entries VALUES(?,?,?,?,?)")
            .run(
              importId,
              side,
              id,
              entry.sourceTimestamp,
              entry.sourceTimestampKind,
            );
          const old = selectRel.get(id, side) as
            | { is_present: number; last_complete_import_id: string | null }
            | undefined;
          const kind = !old
            ? "first_seen"
            : old.is_present
              ? null
              : "newly_present";
          this.db
            .prepare(
              `INSERT INTO relationships(account_id,side,is_present,first_observed_at,last_observed_at,absence_first_detected_at,source_relationship_timestamp,source_timestamp_kind,last_complete_import_id,last_positive_import_id) VALUES(?,?,1,?,?,NULL,?,?,?,?) ON CONFLICT(account_id,side) DO UPDATE SET is_present=1,last_observed_at=excluded.last_observed_at,absence_first_detected_at=NULL,source_relationship_timestamp=excluded.source_relationship_timestamp,source_timestamp_kind=excluded.source_timestamp_kind,last_positive_import_id=excluded.last_positive_import_id,last_complete_import_id=CASE WHEN ?='complete' THEN excluded.last_complete_import_id ELSE relationships.last_complete_import_id END`,
            )
            .run(
              id,
              side,
              now,
              now,
              entry.sourceTimestamp,
              entry.sourceTimestampKind,
              cov === "complete" ? importId : null,
              importId,
              cov,
            );
          if (kind)
            this.change(
              importId,
              id,
              side,
              kind,
              now,
              old?.last_complete_import_id ?? null,
              cov,
            );
        }
        if (cov === "complete") {
          const known = this.db
            .prepare("SELECT id FROM accounts")
            .pluck()
            .all() as string[];
          for (const accountId of known) {
            const present = this.db
              .prepare(
                "SELECT is_present,last_positive_import_id,last_complete_import_id FROM relationships WHERE account_id=? AND side=?",
              )
              .get(accountId, side) as
              | {
                  is_present: number;
                  last_positive_import_id: string | null;
                  last_complete_import_id: string | null;
                }
              | undefined;
            const included = Boolean(
              this.db
                .prepare(
                  "SELECT 1 FROM import_entries WHERE import_id=? AND side=? AND account_id=?",
                )
                .get(importId, side, accountId),
            );
            if (!present) {
              this.db
                .prepare(
                  "INSERT INTO relationships(account_id,side,is_present,absence_first_detected_at,last_complete_import_id) VALUES(?,?,0,?,?)",
                )
                .run(accountId, side, now, importId);
            } else if (present.is_present && !included) {
              this.db
                .prepare(
                  "UPDATE relationships SET is_present=0,absence_first_detected_at=?,last_complete_import_id=? WHERE account_id=? AND side=?",
                )
                .run(now, importId, accountId, side);
              this.change(
                importId,
                accountId,
                side,
                "no_longer_present",
                now,
                present.last_complete_import_id,
                cov,
              );
            } else if (included)
              this.db
                .prepare(
                  "UPDATE relationships SET last_complete_import_id=? WHERE account_id=? AND side=?",
                )
                .run(importId, accountId, side);
            else
              this.db
                .prepare(
                  "UPDATE relationships SET last_complete_import_id=? WHERE account_id=? AND side=?",
                )
                .run(importId, accountId, side);
          }
        }
      }
      return { id: importId, idempotent: false };
    });
    return tx();
  }
  private change(
    i: string,
    a: string,
    s: string,
    k: string,
    n: string,
    p: string | null,
    c: string,
  ) {
    this.db
      .prepare("INSERT INTO relationship_changes VALUES(?,?,?,?,?,?,?,?)")
      .run(randomUUID(), i, a, s, k, n, p, c);
  }
  imports() {
    return this.db
      .prepare(
        `SELECT i.*, (SELECT json_group_array(json_object('side',s.side,'coverage',s.coverage,'observed_count',s.observed_count,'latest_source_timestamp',s.latest_source_timestamp,'files',json(s.files_json),'latest_complete_at',(SELECT max(ci.created_at) FROM import_sides cs JOIN imports ci ON ci.id=cs.import_id WHERE cs.side=s.side AND cs.coverage='complete'))) FROM import_sides s WHERE s.import_id=i.id) sides_json FROM imports i ORDER BY i.created_at DESC`,
      )
      .all()
      .map((row) => {
        const item = row as Record<string, unknown>;
        return { ...item, sides: JSON.parse(String(item.sides_json ?? "[]")) };
      });
  }
  importDetail(id: string) {
    const row = this.db.prepare("SELECT * FROM imports WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new NotFoundException();
    return {
      ...row,
      sides: this.db
        .prepare("SELECT * FROM import_sides WHERE import_id=?")
        .all(id),
      entries: this.db
        .prepare(
          "SELECT e.*,a.username_normalized,a.display_username FROM import_entries e JOIN accounts a ON a.id=e.account_id WHERE e.import_id=?",
        )
        .all(id),
    };
  }
  changes() {
    return this.db
      .prepare(
        "SELECT c.*,a.username_normalized,a.display_username FROM relationship_changes c JOIN accounts a ON a.id=c.account_id ORDER BY detected_at DESC",
      )
      .all();
  }
  relationships(q: Record<string, string>) {
    const page = Math.max(1, Number(q.page) || 1),
      limit = 100,
      search = `%${q.search ?? ""}%`;
    let where = "1=1";
    if (q.includeDeleted !== "true")
      where += " AND coalesce(p.manual_status,'')!='deleted'";
    if (q.includeKeepFollowing !== "true")
      where += " AND coalesce(p.keep_following,0)=0";
    if (q.ignored !== "true") where += " AND coalesce(p.ignored,0)=0";
    if (q.manualStatus) where += " AND p.manual_status=?";
    const base = ` FROM accounts a LEFT JOIN relationships r ON r.account_id=a.id LEFT JOIN account_preferences p ON p.account_id=a.id WHERE ${where} AND (a.username_normalized LIKE ? OR a.display_username LIKE ?) GROUP BY a.id`;
    const params: (string | number)[] = [];
    if (q.manualStatus) params.push(q.manualStatus);
    params.push(search, search);
    const view = q.view;
    const havingFor = (f: string, g: string) =>
      view === "mutual"
        ? ` HAVING ${f}=1 AND ${g}=1`
        : view === "not-following-back"
          ? ` HAVING ${g}=1 AND followers_last_complete_import_id IS NOT NULL AND coalesce(${f},0)=0`
          : view === "follower-only"
            ? ` HAVING ${f}=1 AND following_last_complete_import_id IS NOT NULL AND coalesce(${g},0)=0`
            : "";
    const projection = `SELECT a.*,p.keep_following,p.ignored,p.manual_status,p.note,max(CASE WHEN r.side='followers' THEN r.is_present END) followers_present,max(CASE WHEN r.side='following' THEN r.is_present END) following_present,max(CASE WHEN r.side='followers' THEN r.last_observed_at END) followers_last_observed,max(CASE WHEN r.side='following' THEN r.last_observed_at END) following_last_observed,max(CASE WHEN r.side='followers' THEN r.last_complete_import_id END) followers_last_complete_import_id,max(CASE WHEN r.side='following' THEN r.last_complete_import_id END) following_last_complete_import_id`;
    const sort =
      q.sort === "created_at" ? "a.created_at" : "a.username_normalized";
    const order = q.order === "desc" ? "DESC" : "ASC";
    const having = havingFor("followers_present", "following_present");
    const rows = this.db
      .prepare(
        `${projection}${base}${having} ORDER BY ${sort} ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      )
      .all(...params)
      .map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          ...row,
          followers_present:
            row.followers_present === null
              ? null
              : Boolean(row.followers_present),
          following_present:
            row.following_present === null
              ? null
              : Boolean(row.following_present),
        };
      });
    const total = this.db
      .prepare(`SELECT count(*) FROM (${projection}${base}${having})`)
      .pluck()
      .get(...params) as number;
    return { page, pageSize: limit, total, items: rows };
  }

  summary() {
    const count = this.db
      .prepare("SELECT count(*) FROM accounts")
      .pluck()
      .get() as number;
    const category = (sql: string) =>
      this.db.prepare(sql).pluck().get() as number;
    return {
      totalAccounts: count,
      notFollowingBack: category(
        `SELECT count(*) FROM relationships f JOIN relationships r ON r.account_id=f.account_id AND r.side='followers' AND r.is_present=0 WHERE f.side='following' AND f.is_present=1 AND r.last_complete_import_id IS NOT NULL`,
      ),
      followerOnly: category(
        `SELECT count(*) FROM relationships f JOIN relationships r ON r.account_id=f.account_id AND r.side='following' AND r.is_present=0 WHERE f.side='followers' AND f.is_present=1 AND r.last_complete_import_id IS NOT NULL`,
      ),
      mutual: category(
        `SELECT count(*) FROM relationships f JOIN relationships r ON r.account_id=f.account_id AND r.side='followers' AND r.is_present=1 WHERE f.side='following' AND f.is_present=1`,
      ),
      freshness: this.db
        .prepare(
          `SELECT s.side,max(i.created_at) latestUpload,max(CASE WHEN s.coverage='complete' THEN i.created_at END) latestComplete FROM import_sides s JOIN imports i ON i.id=s.import_id GROUP BY s.side`,
        )
        .all(),
    };
  }
  account(id: string) {
    const account = this.db
      .prepare(
        "SELECT a.*,p.* FROM accounts a LEFT JOIN account_preferences p ON p.account_id=a.id WHERE a.id=?",
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!account) throw new NotFoundException();
    const relations = this.db
      .prepare("SELECT * FROM relationships WHERE account_id=?")
      .all(id) as Array<Record<string, unknown>>;
    const sides: Record<string, Record<string, unknown>> = {};
    for (const side of ["followers", "following"]) {
      const row = relations.find((r) => r.side === side);
      sides[side] = {
        present: row ? Boolean(row.is_present) : null,
        is_present: row ? Boolean(row.is_present) : null,
        last_observed_at: row?.last_observed_at ?? null,
        last_complete_import_id: row?.last_complete_import_id ?? null,
        source_relationship_timestamp:
          row?.source_relationship_timestamp ?? null,
        source_timestamp_kind: row?.source_timestamp_kind ?? null,
      };
    }
    return {
      ...account,
      followers_present: sides.followers.present,
      following_present: sides.following.present,
      relationships: sides,
      timeline: this.db
        .prepare(
          "SELECT c.* FROM relationship_changes c WHERE account_id=? ORDER BY detected_at DESC",
        )
        .all(id),
    };
  }
  preferences(id: string, b: Record<string, unknown>) {
    if (!this.db.prepare("SELECT 1 FROM accounts WHERE id=?").get(id))
      throw new NotFoundException();
    const existing = this.db
      .prepare(
        "SELECT keep_following,ignored,manual_status,note FROM account_preferences WHERE account_id=?",
      )
      .get(id) as
      | {
          keep_following: number;
          ignored: number;
          manual_status: string | null;
          note: string | null;
        }
      | undefined;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO account_preferences(account_id,keep_following,ignored,manual_status,note,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET keep_following=excluded.keep_following,ignored=excluded.ignored,manual_status=excluded.manual_status,note=excluded.note,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        b.keepFollowing === undefined
          ? (existing?.keep_following ?? 0)
          : b.keepFollowing
            ? 1
            : 0,
        b.ignored === undefined ? (existing?.ignored ?? 0) : b.ignored ? 1 : 0,
        b.manualStatus === undefined
          ? (existing?.manual_status ?? null)
          : b.manualStatus,
        b.note === undefined ? (existing?.note ?? null) : b.note,
        now,
      );
    return this.account(id);
  }
}
