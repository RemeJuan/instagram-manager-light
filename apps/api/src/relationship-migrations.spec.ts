import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_OWNER_ID,
  migrateRelationshipDatabase,
} from "./relationship-migrations";

function legacyDatabase(path = ":memory:"): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts(id TEXT PRIMARY KEY, username_normalized TEXT NOT NULL UNIQUE, display_username TEXT NOT NULL, profile_url TEXT, created_at TEXT NOT NULL);
    CREATE TABLE imports(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, source_type TEXT NOT NULL, file_sha256 TEXT NOT NULL, status TEXT NOT NULL, warnings_json TEXT NOT NULL, identity TEXT NOT NULL UNIQUE);
    CREATE TABLE import_sides(import_id TEXT NOT NULL REFERENCES imports(id), side TEXT NOT NULL, coverage TEXT NOT NULL, observed_count INTEGER NOT NULL, latest_source_timestamp INTEGER, files_json TEXT NOT NULL, PRIMARY KEY(import_id,side));
    CREATE TABLE import_entries(import_id TEXT NOT NULL REFERENCES imports(id), side TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), source_relationship_timestamp INTEGER CHECK(source_relationship_timestamp IS NULL OR source_relationship_timestamp >= 0), source_timestamp_kind TEXT, PRIMARY KEY(import_id,side,account_id));
    CREATE TABLE relationships(account_id TEXT NOT NULL REFERENCES accounts(id), side TEXT NOT NULL, is_present INTEGER NOT NULL, first_observed_at TEXT, last_observed_at TEXT, absence_first_detected_at TEXT, source_relationship_timestamp INTEGER, source_timestamp_kind TEXT, last_complete_import_id TEXT, last_positive_import_id TEXT, PRIMARY KEY(account_id,side));
    CREATE TABLE relationship_changes(id TEXT PRIMARY KEY, import_id TEXT NOT NULL, account_id TEXT NOT NULL, side TEXT NOT NULL, kind TEXT NOT NULL, detected_at TEXT NOT NULL, previous_complete_import_id TEXT, evidence_coverage TEXT NOT NULL);
    CREATE TABLE account_preferences(account_id TEXT PRIMARY KEY REFERENCES accounts(id), keep_following INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0, manual_status TEXT, note TEXT, updated_at TEXT NOT NULL);
    INSERT INTO accounts VALUES('account-1','alice','Alice',NULL,'2020-01-01');
    INSERT INTO imports VALUES('import-1','2020-01-02','instagram_export','hash','committed','[]','identity-1');
    INSERT INTO import_sides VALUES('import-1','following','complete',1,NULL,'[]');
    INSERT INTO import_entries VALUES('import-1','following','account-1',NULL,NULL);
    INSERT INTO relationships VALUES('account-1','following',1,'2020-01-02','2020-01-02',NULL,NULL,NULL,'import-1','import-1');
    INSERT INTO relationship_changes VALUES('change-1','import-1','account-1','following','first_seen','2020-01-02',NULL,'complete');
    INSERT INTO account_preferences VALUES('account-1',1,0,'active','note','2020-01-03');
  `);
  return db;
}

describe("relationship migrations", () => {
  it("preserves legacy rows and IDs, assigns local owner, and survives rerun", () => {
    const db = legacyDatabase();
    migrateRelationshipDatabase(db);
    assert.equal(db.pragma("user_version", { simple: true }), 2);
    assert.deepEqual(db.prepare("SELECT id,owner_id FROM accounts").get(), {
      id: "account-1",
      owner_id: LOCAL_OWNER_ID,
    });
    assert.deepEqual(db.prepare("SELECT id,owner_id FROM imports").get(), {
      id: "import-1",
      owner_id: LOCAL_OWNER_ID,
    });
    for (const [table, id] of [
      ["import_sides", "import-1"],
      ["import_entries", "import-1"],
      ["relationships", "account-1"],
      ["relationship_changes", "change-1"],
      ["account_preferences", "account-1"],
    ]) {
      assert.ok(
        db.prepare(`SELECT 1 FROM ${table}`).get(),
        `${table} retained (${id})`,
      );
    }
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    migrateRelationshipDatabase(db);
    assert.equal(db.prepare("SELECT count(*) FROM accounts").pluck().get(), 1);
    db.close();
  });

  it("rolls back schema and data on failed migration", () => {
    const db = legacyDatabase();
    db.exec("DROP TABLE import_sides");
    assert.throws(() => migrateRelationshipDatabase(db), /import_sides/);
    assert.equal(db.pragma("user_version", { simple: true }), 0);
    assert.equal(
      db.prepare("SELECT username_normalized FROM accounts").pluck().get(),
      "alice",
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) FROM sqlite_master WHERE name='accounts_legacy'",
        )
        .pluck()
        .get(),
      0,
    );
    db.close();
  });

  it("rolls back a legacy migration containing an orphaned change", () => {
    const db = legacyDatabase();
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO relationship_changes VALUES('orphan-change','missing-import','missing-account','following','first_seen','2020-02-01',NULL,'complete')",
    ).run();
    db.pragma("foreign_keys = ON");

    assert.throws(
      () => migrateRelationshipDatabase(db),
      /foreign-key violations/,
    );
    assert.equal(db.pragma("user_version", { simple: true }), 0);
    assert.equal(db.prepare("SELECT count(*) FROM accounts").pluck().get(), 1);
    assert.equal(
      db.prepare("SELECT count(*) FROM relationship_changes").pluck().get(),
      2,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) FROM sqlite_master WHERE name='accounts_legacy'",
        )
        .pluck()
        .get(),
      0,
    );
    db.close();
  });

  it("upgrades a file-backed legacy database and retains rows after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "relationship-migration-"));
    const path = join(directory, "legacy.sqlite");
    try {
      const beforeRestart = legacyDatabase(path);
      migrateRelationshipDatabase(beforeRestart);
      beforeRestart.close();

      const afterRestart = new Database(path);
      afterRestart.pragma("foreign_keys = ON");
      migrateRelationshipDatabase(afterRestart);
      assert.equal(afterRestart.pragma("user_version", { simple: true }), 2);
      assert.deepEqual(
        afterRestart.prepare("SELECT id,owner_id FROM accounts").get(),
        { id: "account-1", owner_id: LOCAL_OWNER_ID },
      );
      assert.deepEqual(
        afterRestart.prepare("SELECT id,owner_id FROM imports").get(),
        { id: "import-1", owner_id: LOCAL_OWNER_ID },
      );
      assert.deepEqual(afterRestart.pragma("foreign_key_check"), []);
      afterRestart.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects crossed-owner child references at the database boundary", () => {
    const db = legacyDatabase();
    migrateRelationshipDatabase(db);
    db.prepare(
      `INSERT INTO accounts(id,owner_id,username_normalized,display_username,created_at)
       VALUES('account-2','other','alice','Alice','2020-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO imports(id,owner_id,created_at,source_type,file_sha256,status,warnings_json,identity)
       VALUES('import-2','other','2020-01-02','export','hash','committed','[]','identity-2')`,
    ).run();

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO import_entries(import_id,account_id,owner_id,side)
           VALUES('import-1','account-2','local','following')`,
          )
          .run(),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO relationships(account_id,owner_id,side,is_present,last_complete_import_id)
           VALUES('account-1','local','followers',1,'import-2')`,
          )
          .run(),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO relationship_changes(id,import_id,account_id,owner_id,side,kind,detected_at,evidence_coverage)
           VALUES('crossed','import-1','account-2','local','following','first_seen','2020','complete')`,
          )
          .run(),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO import_sides(import_id,owner_id,side,coverage,observed_count,files_json)
           VALUES('import-1','other','followers','complete',0,'[]')`,
          )
          .run(),
      /FOREIGN KEY/,
    );
    db.close();
  });

  it("rejects a database schema version newer than supported", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 3");
    assert.throws(
      () => migrateRelationshipDatabase(db),
      /newer than this application supports/,
    );
    assert.equal(db.pragma("user_version", { simple: true }), 3);
    db.close();
  });
});
