import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { RelationshipService } from "./relationship.service";
import { LOCAL_OWNER_ID } from "./relationship-migrations";
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
  it("isolates imports, accounts, reconciliation, reads, and preferences by owner", () => {
    const otherOwner = "other-owner";
    const localFirst = service.commit(
      LOCAL_OWNER_ID,
      upload([], ["same", "local-only"]),
      { following: "complete" },
      { idempotencyToken: "same-token" },
    );
    const otherFirst = service.commit(
      otherOwner,
      upload([], ["same", "other-only"]),
      { following: "complete" },
      { idempotencyToken: "same-token" },
    );
    assert.notEqual(localFirst.id, otherFirst.id);
    assert.deepEqual(
      service.commit(
        otherOwner,
        upload([], ["same", "other-only"]),
        { following: "complete" },
        { idempotencyToken: "same-token" },
      ),
      { id: otherFirst.id, idempotent: true },
    );

    const localRows = service.relationships(LOCAL_OWNER_ID, {
      includeDeleted: "true",
    }).items as Array<Record<string, unknown>>;
    const otherRows = service.relationships(otherOwner, {
      includeDeleted: "true",
    }).items as Array<Record<string, unknown>>;
    assert.deepEqual(localRows.map((row) => row.username_normalized).sort(), [
      "local-only",
      "same",
    ]);
    assert.deepEqual(otherRows.map((row) => row.username_normalized).sort(), [
      "other-only",
      "same",
    ]);
    assert.notEqual(
      localRows.find((row) => row.username_normalized === "same")?.id,
      otherRows.find((row) => row.username_normalized === "same")?.id,
    );
    assert.equal(service.summary(LOCAL_OWNER_ID).totalAccounts, 2);
    assert.equal(service.summary(otherOwner).totalAccounts, 2);
    assert.equal(service.imports(LOCAL_OWNER_ID).length, 1);
    assert.equal(service.imports(otherOwner).length, 1);

    const foreignLocalAccountId = String(
      localRows.find((row) => row.username_normalized === "local-only")!.id,
    );
    const foreignLocalImportId = String(localFirst.id);
    assert.throws(() => service.account(otherOwner, foreignLocalAccountId));
    assert.throws(() => service.importDetail(otherOwner, foreignLocalImportId));
    assert.throws(() =>
      service.preferences(otherOwner, foreignLocalAccountId, {
        note: "intrusion",
      }),
    );
    assert.equal(
      (
        service.account(LOCAL_OWNER_ID, foreignLocalAccountId) as Record<
          string,
          unknown
        >
      ).note,
      null,
    );

    service.commit(
      otherOwner,
      upload([], ["same"]),
      { following: "complete" },
      {},
    );
    assert.equal(
      service.proposedRemovals(LOCAL_OWNER_ID, "following", ["same"]),
      1,
    );
    assert.equal(
      service.proposedRemovals(otherOwner, "following", ["same"]),
      0,
    );
    assert.equal(
      service
        .changes(LOCAL_OWNER_ID)
        .every((change: any) => change.account_id !== undefined),
      true,
    );
    assert.equal(
      (
        service.importDetail(LOCAL_OWNER_ID, foreignLocalImportId) as Record<
          string,
          unknown
        >
      ).id,
      foreignLocalImportId,
    );

    // A complete snapshot from one owner must not alter the other owner's rows.
    service.commit(
      otherOwner,
      upload([], ["same"]),
      { following: "complete" },
      { idempotencyToken: "other-reconcile" },
    );
    assert.equal(
      (
        service.relationships(LOCAL_OWNER_ID, {
          search: "local-only",
          includeDeleted: "true",
        }).items[0] as Record<string, unknown>
      ).following_present,
      true,
    );
    assert.equal(
      (
        service.relationships(otherOwner, {
          search: "other-only",
          includeDeleted: "true",
        }).items[0] as Record<string, unknown>
      ).following_present,
      false,
    );
    assert.equal(service.summary(LOCAL_OWNER_ID).totalAccounts, 2);
    assert.equal(service.summary(otherOwner).totalAccounts, 2);
    assert.equal(
      service
        .changes(LOCAL_OWNER_ID)
        .some((change: any) => change.account_id === foreignLocalAccountId),
      true,
    );
    assert.equal(
      service
        .changes(otherOwner)
        .some((change: any) => change.account_id === foreignLocalAccountId),
      false,
    );
  });

  it("derives supplied synthetic aggregates with baseline certainty", () => {
    const following = names("f", 810);
    const followers = [...following.slice(0, 747), ...names("only", 36)];
    service.commit(
      LOCAL_OWNER_ID,
      upload(followers, following),
      { followers: "complete", following: "complete" },
      {},
    );
    assert.equal(
      (
        service.relationships(LOCAL_OWNER_ID, { search: "f809" })
          .items[0] as Record<string, unknown>
      ).followers_present,
      false,
    );
    const result = service.summary(LOCAL_OWNER_ID);
    assert.equal(result.notFollowingBack, 63);
    assert.equal(result.mutual, 747);
    assert.equal(result.followerOnly, 36);
    const items = service.relationships(LOCAL_OWNER_ID, {
      view: "not-following-back",
    }).items as unknown[];
    assert.equal(items.length, 63);
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { view: "follower-only" }).items
        .length,
      36,
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { view: "mutual" }).items.length,
      100,
    ); // default page size
    assert.equal(service.relationships(LOCAL_OWNER_ID, {}).total, 846);
  });
  it("keeps category unknown until absent side has complete baseline", () => {
    service.commit(
      LOCAL_OWNER_ID,
      upload(["alice"], ["alice", "bob"]),
      { following: "complete" },
      {},
    );
    assert.equal(service.summary(LOCAL_OWNER_ID).notFollowingBack, 0);
    assert.equal(
      (
        service.relationships(LOCAL_OWNER_ID, { view: "not-following-back" })
          .items as unknown[]
      ).length,
      0,
    );
  });
  it("partial import never removes; complete import detects removals", () => {
    service.commit(
      LOCAL_OWNER_ID,
      upload([], ["alice", "bob"]),
      { following: "complete" },
      {},
    );
    service.commit(
      LOCAL_OWNER_ID,
      upload([], ["alice"]),
      { following: "partial" },
      {},
    );
    assert.equal(
      service
        .changes(LOCAL_OWNER_ID)
        .filter((c: any) => c.kind === "no_longer_present").length,
      0,
    );
    service.commit(
      LOCAL_OWNER_ID,
      upload([], ["alice"]),
      { following: "complete" },
      {},
    );
    assert.equal(
      service
        .changes(LOCAL_OWNER_ID)
        .filter((c: any) => c.kind === "no_longer_present").length,
      1,
    );
  });
  it("canonical repeated payload and coverage is idempotent", () => {
    const p = upload([], ["alice"]);
    const first = service.commit(LOCAL_OWNER_ID, p, {}, {});
    const second = service.commit(
      LOCAL_OWNER_ID,
      p,
      { following: "partial" },
      {},
    );
    assert.deepEqual(second, { id: first.id, idempotent: true });
    assert.equal(service.imports(LOCAL_OWNER_ID).length, 1);
  });
  it("rolls back import, accounts, entries and changes on failed transaction", () => {
    const p = upload([], ["alice"]);
    // Invalid timestamp is rejected by SQLite after import/account/entry writes begin.
    p.parsed.sides.following!.entries[0].sourceTimestamp = -1;
    assert.throws(() =>
      service.commit(LOCAL_OWNER_ID, p, { following: "partial" }, {}),
    );
    assert.equal(service.imports(LOCAL_OWNER_ID).length, 0);
    assert.equal(service.changes(LOCAL_OWNER_ID).length, 0);
  });
  it("single-side refresh leaves opposite relationship untouched", () => {
    service.commit(
      LOCAL_OWNER_ID,
      upload(["alice"], ["alice"]),
      { followers: "complete", following: "complete" },
      {},
    );
    service.commit(
      LOCAL_OWNER_ID,
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
    const alice = service.relationships(LOCAL_OWNER_ID, { search: "alice" })
      .items[0] as Record<string, unknown>;
    assert.equal(alice.followers_present, true);
    assert.equal(alice.following_present, true);
  });
  it("reports unknown side state distinctly from complete absence", () => {
    service.commit(
      LOCAL_OWNER_ID,
      upload([], ["alice"]),
      { following: "complete" },
      {},
    );
    const alice = service.relationships(LOCAL_OWNER_ID, { search: "alice" })
      .items[0] as Record<string, unknown>;
    assert.equal(alice.followers_present, null);
    assert.equal(alice.followers_last_complete_import_id, null);
  });
  it("returns filtered result total for search and category pagination", () => {
    service.commit(
      LOCAL_OWNER_ID,
      upload([], ["alice", "alicia", "bob"]),
      { followers: "complete", following: "complete" },
      {},
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { search: "ali" }).total,
      2,
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { view: "not-following-back" })
        .total,
      3,
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, {
        view: "not-following-back",
        page: "2",
      }).total,
      3,
    );
  });
  it("persists manual statuses and independent partial preferences across imports", () => {
    service.commit(
      LOCAL_OWNER_ID,
      upload([], ["alice", "bob"]),
      { following: "complete" },
      {},
    );
    const alice = (
      service.relationships(LOCAL_OWNER_ID, { search: "alice" })
        .items[0] as Record<string, unknown>
    ).id as string;
    const bob = (
      service.relationships(LOCAL_OWNER_ID, { search: "bob" })
        .items[0] as Record<string, unknown>
    ).id as string;
    service.preferences(LOCAL_OWNER_ID, alice, {
      keepFollowing: true,
      ignored: true,
      note: "keep",
    });
    service.preferences(LOCAL_OWNER_ID, alice, { manualStatus: "deleted" });
    service.preferences(LOCAL_OWNER_ID, bob, { manualStatus: "inactive" });
    service.commit(
      LOCAL_OWNER_ID,
      upload([], ["bob"]),
      { following: "complete" },
      {},
    );
    assert.equal(
      (service.account(LOCAL_OWNER_ID, alice) as Record<string, unknown>)
        .manual_status,
      "deleted",
    );
    assert.equal(
      (service.account(LOCAL_OWNER_ID, bob) as Record<string, unknown>)
        .manual_status,
      "inactive",
    );
    const filtered = service.relationships(LOCAL_OWNER_ID, {
      manualStatus: "deleted",
      includeDeleted: "true",
      includeKeepFollowing: "true",
      ignored: "true",
    }).items as Array<Record<string, unknown>>;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, alice);
    service.preferences(LOCAL_OWNER_ID, alice, { manualStatus: null });
    const cleared = service.account(LOCAL_OWNER_ID, alice) as Record<
      string,
      unknown
    >;
    assert.equal(cleared.manual_status, null);
    assert.equal(cleared.keep_following, 1);
    assert.equal(cleared.ignored, 1);
    assert.equal(cleared.note, "keep");
  });
  it("excludes deleted accounts before filtering, counting, and pagination unless included", () => {
    const accounts = names("acct", 101);
    service.commit(
      LOCAL_OWNER_ID,
      upload([], accounts),
      { following: "complete" },
      {},
    );
    const deleted = service.relationships(LOCAL_OWNER_ID, { search: "acct100" })
      .items[0] as Record<string, unknown>;
    service.preferences(LOCAL_OWNER_ID, String(deleted.id), {
      manualStatus: "deleted",
    });
    assert.equal(service.relationships(LOCAL_OWNER_ID, {}).total, 100);
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { page: "2" }).items.length,
      0,
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { search: "acct100" }).total,
      0,
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { manualStatus: "deleted" }).total,
      0,
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, {
        manualStatus: "deleted",
        includeDeleted: "true",
      }).total,
      1,
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { includeDeleted: "true" }).total,
      101,
    );
  });
  it("excludes keep-following accounts by default and combines inclusion flags", () => {
    service.commit(
      LOCAL_OWNER_ID,
      upload([], ["alice", "bob", "carol"]),
      { following: "complete" },
      {},
    );
    const ids = Object.fromEntries(
      ["alice", "bob", "carol"].map((name) => [
        name,
        (
          service.relationships(LOCAL_OWNER_ID, { search: name })
            .items[0] as Record<string, unknown>
        ).id as string,
      ]),
    );
    service.preferences(LOCAL_OWNER_ID, ids.alice, { keepFollowing: true });
    service.preferences(LOCAL_OWNER_ID, ids.bob, {
      keepFollowing: true,
      manualStatus: "deleted",
    });
    assert.equal(service.relationships(LOCAL_OWNER_ID, {}).total, 1);
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { includeKeepFollowing: "true" })
        .total,
      2,
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, { includeDeleted: "true" }).total,
      1,
    );
    assert.equal(
      service.relationships(LOCAL_OWNER_ID, {
        includeDeleted: "true",
        includeKeepFollowing: "true",
      }).total,
      3,
    );
    service.preferences(LOCAL_OWNER_ID, ids.alice, { keepFollowing: false });
    assert.equal(service.relationships(LOCAL_OWNER_ID, {}).total, 2);
  });
});
