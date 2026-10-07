import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { AuthError, AuthService } from "./auth.service";

describe("AuthService", () => {
  let dir: string;
  let service: AuthService;
  const oldDb = process.env.RELATIONSHIP_DB;
  const password = "correct-horse-battery-staple";
  let adminId: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "auth-test-"));
    process.env.RELATIONSHIP_DB = join(dir, "test.sqlite");
    service = new AuthService();
  });
  after(() => {
    service.close();
    if (oldDb === undefined) delete process.env.RELATIONSHIP_DB;
    else process.env.RELATIONSHIP_DB = oldDb;
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows only first operator bootstrap", async () => {
    const admin = await service.bootstrapAdmin("admin", password);
    adminId = admin.id;
    assert.equal(admin.role, "admin");
    await assert.rejects(service.bootstrapAdmin("second", password), {
      code: "UNAVAILABLE",
    });
  });

  it("supports administrator invites, expiry, and one redemption", async () => {
    const admin = { id: adminId };
    assert.throws(
      () => service.createInvitation("bad", Date.now() + 60_000),
      AuthError,
    );
    const invite = service.createInvitation(admin.id, Date.now() + 60_000);
    assert.equal(service.listInvitationMetadata(admin.id).length, 1);
    const attempts = await Promise.allSettled([
      service.redeemInvitation(invite.token, "member", password),
      service.redeemInvitation(invite.token, "member-two", password),
    ]);
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const user = attempts.find(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<
      Awaited<ReturnType<typeof service.redeemInvitation>>
    >;
    assert.equal(user.value.role, "user");
    await assert.rejects(
      service.redeemInvitation(invite.token, "member2", password),
      { code: "UNAVAILABLE" },
    );
    const expired = service.createInvitation(admin.id, Date.now() + 60_000);
    service.close();
    const Database = require("better-sqlite3");
    const db = new Database(process.env.RELATIONSHIP_DB);
    db.prepare(
      "UPDATE auth_invitations SET expires_at=? WHERE token_hash=?",
    ).run(
      new Date(0).toISOString(),
      require("crypto")
        .createHash("sha256")
        .update(expired.token)
        .digest("hex"),
    );
    db.close();
    service = new AuthService();
    await assert.rejects(
      service.redeemInvitation(expired.token, "member3", password),
      { code: "UNAVAILABLE" },
    );
  });

  it("uses generic credential failures, throttles, and expires/revokes sessions", async () => {
    // The first test bootstrapped shared suite database.
    await assert.rejects(
      service.login("missing", "wrong"),
      /Invalid credentials/,
    );
    await assert.rejects(
      service.login("admin", "wrong"),
      /Invalid credentials/,
    );
    for (let i = 0; i < 9; i++)
      await assert.rejects(service.login("missing", "wrong", "throttle"), {
        code: "INVALID_CREDENTIALS",
      });
    await assert.rejects(service.login("missing", "wrong", "throttle"), {
      code: "RATE_LIMITED",
    });
    const memberSession = await service.login("member", password, "throttle");
    assert.ok(service.authenticateSession(memberSession.token));
    const session = await service.login("admin", password);
    assert.ok(service.authenticateSession(session.token)?.id);
    service.logout(session.token);
    assert.equal(service.authenticateSession(session.token), null);
    const another = await service.login("admin", password);
    const rotated = await service.login("admin", password);
    assert.ok(service.authenticateSession(rotated.token));
    assert.equal(
      service.authenticateSession(another.token),
      null,
      "new login rotates prior token",
    );
    const Database = require("better-sqlite3");
    const db = new Database(process.env.RELATIONSHIP_DB);
    db.prepare("UPDATE auth_sessions SET expires_at=? WHERE token_hash=?").run(
      new Date(0).toISOString(),
      require("crypto")
        .createHash("sha256")
        .update(rotated.token)
        .digest("hex"),
    );
    assert.equal(service.authenticateSession(rotated.token), null);
    const events = db
      .prepare("SELECT event_type, subject_hash FROM auth_security_events")
      .all() as Array<{ event_type: string; subject_hash: string }>;
    assert.ok(events.some((event) => event.event_type === "login_failure"));
    assert.ok(
      events.every(
        (event) =>
          event.subject_hash !== password &&
          event.subject_hash !== another.token,
      ),
    );
    db.close();
  });
});
