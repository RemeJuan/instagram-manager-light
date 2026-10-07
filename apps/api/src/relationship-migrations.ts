import Database from "better-sqlite3";

/** Stable owner assigned to rows created before tenant ownership existed. */
export const LOCAL_OWNER_ID = "local";

const SCHEMA_VERSION = 2;
const FUTURE_VERSION_ERROR =
  "Database schema version is newer than this application supports";

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      username_normalized TEXT NOT NULL,
      display_username TEXT NOT NULL,
      profile_url TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(id, owner_id),
      UNIQUE(owner_id, username_normalized)
    );
    CREATE TABLE imports (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_type TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      identity TEXT NOT NULL,
      UNIQUE(id, owner_id),
      UNIQUE(owner_id, identity)
    );
    CREATE TABLE import_sides (
      import_id TEXT NOT NULL, owner_id TEXT NOT NULL, side TEXT NOT NULL,
      coverage TEXT NOT NULL, observed_count INTEGER NOT NULL,
      latest_source_timestamp INTEGER, files_json TEXT NOT NULL,
      FOREIGN KEY(import_id, owner_id) REFERENCES imports(id, owner_id),
      PRIMARY KEY(import_id, side)
    );
    CREATE TABLE import_entries (
      import_id TEXT NOT NULL, account_id TEXT NOT NULL, owner_id TEXT NOT NULL, side TEXT NOT NULL,
      source_relationship_timestamp INTEGER CHECK(source_relationship_timestamp IS NULL OR source_relationship_timestamp >= 0),
      source_timestamp_kind TEXT,
      FOREIGN KEY(import_id, owner_id) REFERENCES imports(id, owner_id),
      FOREIGN KEY(account_id, owner_id) REFERENCES accounts(id, owner_id),
      PRIMARY KEY(import_id, side, account_id)
    );
    CREATE TABLE relationships (
      account_id TEXT NOT NULL, owner_id TEXT NOT NULL, side TEXT NOT NULL,
      is_present INTEGER NOT NULL, first_observed_at TEXT,
      last_observed_at TEXT, absence_first_detected_at TEXT,
      source_relationship_timestamp INTEGER, source_timestamp_kind TEXT,
      last_complete_import_id TEXT, last_positive_import_id TEXT,
      FOREIGN KEY(account_id, owner_id) REFERENCES accounts(id, owner_id),
      FOREIGN KEY(last_complete_import_id, owner_id) REFERENCES imports(id, owner_id),
      FOREIGN KEY(last_positive_import_id, owner_id) REFERENCES imports(id, owner_id),
      PRIMARY KEY(account_id, side)
    );
    CREATE TABLE relationship_changes (
      id TEXT PRIMARY KEY, import_id TEXT NOT NULL, account_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      side TEXT NOT NULL, kind TEXT NOT NULL, detected_at TEXT NOT NULL,
      previous_complete_import_id TEXT, evidence_coverage TEXT NOT NULL,
      FOREIGN KEY(import_id, owner_id) REFERENCES imports(id, owner_id),
      FOREIGN KEY(account_id, owner_id) REFERENCES accounts(id, owner_id),
      FOREIGN KEY(previous_complete_import_id, owner_id) REFERENCES imports(id, owner_id)
    );
    CREATE TABLE account_preferences (
      account_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      keep_following INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0, manual_status TEXT, note TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(account_id, owner_id) REFERENCES accounts(id, owner_id)
    );
    CREATE INDEX imports_owner_created_at ON imports(owner_id, created_at);
    CREATE INDEX accounts_owner_id ON accounts(owner_id, id);
    CREATE INDEX import_sides_import_id ON import_sides(import_id);
    CREATE INDEX import_entries_account_id ON import_entries(account_id);
    CREATE INDEX relationship_changes_account_id ON relationship_changes(account_id);
    CREATE INDEX relationship_changes_import_id ON relationship_changes(import_id);
  `);
}

/** Upgrade legacy global tables atomically while preserving all IDs and child rows. */
export function migrateRelationshipDatabase(db: Database.Database): void {
  const current = Number(db.pragma("user_version", { simple: true }));
  if (current > SCHEMA_VERSION) throw new Error(FUTURE_VERSION_ERROR);
  if (current === SCHEMA_VERSION) return;

  // SQLite cannot disable FK enforcement inside a transaction. Disable it only
  // for the table replacement, then restore it even if migration fails.
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      const hasLegacy =
        tableExists(db, "accounts") || tableExists(db, "imports");
      if (!hasLegacy) {
        createSchema(db);
      } else {
        db.exec(`
          ALTER TABLE accounts RENAME TO accounts_legacy;
          ALTER TABLE imports RENAME TO imports_legacy;
          ALTER TABLE import_sides RENAME TO import_sides_legacy;
          ALTER TABLE import_entries RENAME TO import_entries_legacy;
          ALTER TABLE relationships RENAME TO relationships_legacy;
          ALTER TABLE relationship_changes RENAME TO relationship_changes_legacy;
          ALTER TABLE account_preferences RENAME TO account_preferences_legacy;
          DROP INDEX IF EXISTS imports_owner_created_at;
          DROP INDEX IF EXISTS accounts_owner_id;
          DROP INDEX IF EXISTS import_sides_import_id;
          DROP INDEX IF EXISTS import_entries_account_id;
          DROP INDEX IF EXISTS relationship_changes_account_id;
          DROP INDEX IF EXISTS relationship_changes_import_id;
        `);
        createSchema(db);
        db.exec(`
          INSERT INTO accounts(id,owner_id,username_normalized,display_username,profile_url,created_at)
            SELECT id, ${current === 0 ? `'${LOCAL_OWNER_ID}'` : "owner_id"}, username_normalized,display_username,profile_url,created_at FROM accounts_legacy;
          INSERT INTO imports(id,owner_id,created_at,source_type,file_sha256,status,warnings_json,identity)
            SELECT id, ${current === 0 ? `'${LOCAL_OWNER_ID}'` : "owner_id"}, created_at,source_type,file_sha256,status,warnings_json,identity FROM imports_legacy;
        `);
        const ownership =
          current === 0 ? `'${LOCAL_OWNER_ID}'` : "coalesce(a.owner_id,'')";
        db.exec(`
          INSERT INTO import_sides(import_id,owner_id,side,coverage,observed_count,latest_source_timestamp,files_json)
            SELECT s.import_id,${current === 0 ? `'${LOCAL_OWNER_ID}'` : "i.owner_id"},s.side,s.coverage,s.observed_count,s.latest_source_timestamp,s.files_json
            FROM import_sides_legacy s LEFT JOIN imports_legacy i ON i.id=s.import_id;
          INSERT INTO import_entries(import_id,account_id,owner_id,side,source_relationship_timestamp,source_timestamp_kind)
            SELECT e.import_id,e.account_id,${ownership},e.side,e.source_relationship_timestamp,e.source_timestamp_kind
            FROM import_entries_legacy e LEFT JOIN accounts_legacy a ON a.id=e.account_id;
          INSERT INTO relationships(account_id,owner_id,side,is_present,first_observed_at,last_observed_at,absence_first_detected_at,source_relationship_timestamp,source_timestamp_kind,last_complete_import_id,last_positive_import_id)
            SELECT r.account_id,${ownership},r.side,r.is_present,r.first_observed_at,r.last_observed_at,r.absence_first_detected_at,r.source_relationship_timestamp,r.source_timestamp_kind,r.last_complete_import_id,r.last_positive_import_id
            FROM relationships_legacy r LEFT JOIN accounts_legacy a ON a.id=r.account_id;
          INSERT INTO relationship_changes(id,import_id,account_id,owner_id,side,kind,detected_at,previous_complete_import_id,evidence_coverage)
            SELECT c.id,c.import_id,c.account_id,${ownership},c.side,c.kind,c.detected_at,c.previous_complete_import_id,c.evidence_coverage
            FROM relationship_changes_legacy c LEFT JOIN accounts_legacy a ON a.id=c.account_id;
          INSERT INTO account_preferences(account_id,owner_id,keep_following,ignored,manual_status,note,updated_at)
            SELECT p.account_id,${ownership},p.keep_following,p.ignored,p.manual_status,p.note,p.updated_at
            FROM account_preferences_legacy p LEFT JOIN accounts_legacy a ON a.id=p.account_id;
        `);
        db.exec(
          `DROP TABLE relationship_changes_legacy; DROP TABLE account_preferences_legacy; DROP TABLE relationships_legacy; DROP TABLE import_entries_legacy; DROP TABLE import_sides_legacy; DROP TABLE imports_legacy; DROP TABLE accounts_legacy;`,
        );
      }
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length) {
        throw new Error("Relationship migration left foreign-key violations");
      }
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
