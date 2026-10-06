import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { RelationshipService } from "./relationship.service";
import type { ParsedUpload } from "@instagram-manager/import-format";

let service: RelationshipService;
const entry = (name: string) => ({
  usernameNormalized: name.toLowerCase(),
  displayUsername: name,
  profileUrl: `https://www.instagram.com/${name}/`,
  sourceTimestamp: null,
  sourceTimestampKind: null,
});
function upload(
  followers: string[],
  following: string[],
): { parsed: ParsedUpload; hash: string } {
  return {
    hash: "synthetic",
    parsed: {
      warnings: [],
      sides: {
        followers: {
          entries: followers.map(entry),
          files: ["followers.json"],
          invalidCount: 0,
          duplicateCount: 0,
        },
        following: {
          entries: following.map(entry),
          files: ["following.json"],
          invalidCount: 0,
          duplicateCount: 0,
        },
      },
    },
  };
}
function names(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}
beforeEach(() => {
  process.env.RELATIONSHIP_DB = ":memory:";
  service = new RelationshipService();
});
afterEach(() => service.close());

describe("relationship reconciliation", () => {
  it("derives supplied synthetic aggregates with baseline certainty", () => {
    const following = names("f", 810);
    const followers = [...following.slice(0, 747), ...names("only", 36)];
    service.commit(
      upload(followers, following),
      { followers: "complete", following: "complete" },
      {},
    );
    assert.equal(
      (
        service.relationships({ search: "f809" }).items[0] as Record<
          string,
          unknown
        >
      ).followers_present,
      false,
    );
    const result = service.summary();
    assert.equal(result.notFollowingBack, 63);
    assert.equal(result.mutual, 747);
    assert.equal(result.followerOnly, 36);
    const items = service.relationships({ view: "not-following-back" })
      .items as unknown[];
    assert.equal(items.length, 63);
    assert.equal(
      service.relationships({ view: "follower-only" }).items.length,
      36,
    );
    assert.equal(service.relationships({ view: "mutual" }).items.length, 100); // default page size
    assert.equal(service.relationships({}).total, 846);
  });
  it("keeps category unknown until absent side has complete baseline", () => {
    service.commit(
      upload(["alice"], ["alice", "bob"]),
      { following: "complete" },
      {},
    );
    assert.equal(service.summary().notFollowingBack, 0);
    assert.equal(
      (service.relationships({ view: "not-following-back" }).items as unknown[])
        .length,
      0,
    );
  });
  it("partial import never removes; complete import detects removals", () => {
    service.commit(upload([], ["alice", "bob"]), { following: "complete" }, {});
    service.commit(upload([], ["alice"]), { following: "partial" }, {});
    assert.equal(
      service.changes().filter((c: any) => c.kind === "no_longer_present")
        .length,
      0,
    );
    service.commit(upload([], ["alice"]), { following: "complete" }, {});
    assert.equal(
      service.changes().filter((c: any) => c.kind === "no_longer_present")
        .length,
      1,
    );
  });
  it("canonical repeated payload and coverage is idempotent", () => {
    const p = upload([], ["alice"]);
    const first = service.commit(p, {}, {});
    const second = service.commit(p, { following: "partial" }, {});
    assert.deepEqual(second, { id: first.id, idempotent: true });
    assert.equal(service.imports().length, 1);
  });
  it("rolls back import, accounts, entries and changes on failed transaction", () => {
    const p = upload([], ["alice"]);
    // Invalid timestamp is rejected by SQLite after import/account/entry writes begin.
    p.parsed.sides.following!.entries[0].sourceTimestamp = -1;
    assert.throws(() => service.commit(p, { following: "partial" }, {}));
    assert.equal(service.imports().length, 0);
    assert.equal(service.changes().length, 0);
  });
  it("single-side refresh leaves opposite relationship untouched", () => {
    service.commit(
      upload(["alice"], ["alice"]),
      { followers: "complete", following: "complete" },
      {},
    );
    service.commit(
      {
        parsed: {
          warnings: [],
          sides: {
            following: {
              entries: [entry("bob")],
              files: ["following.json"],
              invalidCount: 0,
              duplicateCount: 0,
            },
          },
        },
        hash: "second",
      },
      { following: "partial" },
      {},
    );
    const alice = service.relationships({ search: "alice" }).items[0] as Record<
      string,
      unknown
    >;
    assert.equal(alice.followers_present, true);
    assert.equal(alice.following_present, true);
  });
  it("reports unknown side state distinctly from complete absence", () => {
    service.commit(upload([], ["alice"]), { following: "complete" }, {});
    const alice = service.relationships({ search: "alice" }).items[0] as Record<
      string,
      unknown
    >;
    assert.equal(alice.followers_present, null);
    assert.equal(alice.followers_last_complete_import_id, null);
  });
  it("returns filtered result total for search and category pagination", () => {
    service.commit(
      upload([], ["alice", "alicia", "bob"]),
      { followers: "complete", following: "complete" },
      {},
    );
    assert.equal(service.relationships({ search: "ali" }).total, 2);
    assert.equal(
      service.relationships({ view: "not-following-back" }).total,
      3,
    );
    assert.equal(
      service.relationships({ view: "not-following-back", page: "2" }).total,
      3,
    );
  });
  it("persists manual statuses and independent partial preferences across imports", () => {
    service.commit(upload([], ["alice", "bob"]), { following: "complete" }, {});
    const alice = (
      service.relationships({ search: "alice" }).items[0] as Record<
        string,
        unknown
      >
    ).id as string;
    const bob = (
      service.relationships({ search: "bob" }).items[0] as Record<
        string,
        unknown
      >
    ).id as string;
    service.preferences(alice, {
      keepFollowing: true,
      ignored: true,
      note: "keep",
    });
    service.preferences(alice, { manualStatus: "deleted" });
    service.preferences(bob, { manualStatus: "inactive" });
    service.commit(upload([], ["bob"]), { following: "complete" }, {});
    assert.equal(
      (service.account(alice) as Record<string, unknown>).manual_status,
      "deleted",
    );
    assert.equal(
      (service.account(bob) as Record<string, unknown>).manual_status,
      "inactive",
    );
    const filtered = service.relationships({
      manualStatus: "deleted",
      includeDeleted: "true",
      includeKeepFollowing: "true",
      ignored: "true",
    }).items as Array<Record<string, unknown>>;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, alice);
    service.preferences(alice, { manualStatus: null });
    const cleared = service.account(alice) as Record<string, unknown>;
    assert.equal(cleared.manual_status, null);
    assert.equal(cleared.keep_following, 1);
    assert.equal(cleared.ignored, 1);
    assert.equal(cleared.note, "keep");
  });
  it("excludes deleted accounts before filtering, counting, and pagination unless included", () => {
    const accounts = names("acct", 101);
    service.commit(upload([], accounts), { following: "complete" }, {});
    const deleted = service.relationships({ search: "acct100" })
      .items[0] as Record<string, unknown>;
    service.preferences(String(deleted.id), { manualStatus: "deleted" });
    assert.equal(service.relationships({}).total, 100);
    assert.equal(service.relationships({ page: "2" }).items.length, 0);
    assert.equal(service.relationships({ search: "acct100" }).total, 0);
    assert.equal(service.relationships({ manualStatus: "deleted" }).total, 0);
    assert.equal(
      service.relationships({ manualStatus: "deleted", includeDeleted: "true" })
        .total,
      1,
    );
    assert.equal(service.relationships({ includeDeleted: "true" }).total, 101);
  });
  it("excludes keep-following accounts by default and combines inclusion flags", () => {
    service.commit(
      upload([], ["alice", "bob", "carol"]),
      { following: "complete" },
      {},
    );
    const ids = Object.fromEntries(
      ["alice", "bob", "carol"].map((name) => [
        name,
        (
          service.relationships({ search: name }).items[0] as Record<
            string,
            unknown
          >
        ).id as string,
      ]),
    );
    service.preferences(ids.alice, { keepFollowing: true });
    service.preferences(ids.bob, {
      keepFollowing: true,
      manualStatus: "deleted",
    });
    assert.equal(service.relationships({}).total, 1);
    assert.equal(
      service.relationships({ includeKeepFollowing: "true" }).total,
      2,
    );
    assert.equal(service.relationships({ includeDeleted: "true" }).total, 1);
    assert.equal(
      service.relationships({
        includeDeleted: "true",
        includeKeepFollowing: "true",
      }).total,
      3,
    );
    service.preferences(ids.alice, { keepFollowing: false });
    assert.equal(service.relationships({}).total, 2);
  });
});
