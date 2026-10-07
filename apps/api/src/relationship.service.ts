import {
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import type { ParsedUpload } from "@instagram-manager/import-format";
import { getHostedConfig } from "./hosted-config";
import { migrateRelationshipDatabase } from "./relationship-migrations";

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
    migrateRelationshipDatabase(this.db);
  }

  close() {
    this.db.close();
  }

  proposedRemovals(ownerId: string, side: Side, names: string[]) {
    return this.db
      .prepare(
        `SELECT count(*) FROM relationships r
         JOIN accounts a ON a.id=r.account_id
         WHERE a.owner_id=? AND r.side=? AND r.is_present=1
           AND a.username_normalized NOT IN (SELECT value FROM json_each(?))`,
      )
      .pluck()
      .get(ownerId, side, JSON.stringify(names)) as number;
  }

  commit(
    ownerId: string,
    preview: { parsed: ParsedUpload; hash: string },
    coverage: Partial<Record<Side, "complete" | "partial">>,
    opts: { idempotencyToken?: string; confirmHistoricalReplay?: boolean },
  ) {
    const { parsed, hash } = preview;
    const sides = ["followers", "following"] as Side[];
    const selectedCoverage = Object.fromEntries(
      sides
        .filter((side) => parsed.sides[side])
        .map((side) => [side, coverage[side] ?? "partial"]),
    );
    const canonicalContent = createHash("sha256")
      .update(
        JSON.stringify({
          sides: Object.fromEntries(
            sides
              .filter((side) => parsed.sides[side])
              .map((side) => [
                side,
                parsed.sides[side]!.entries.map((entry) => [
                  entry.usernameNormalized,
                  entry.displayUsername,
                  entry.profileUrl,
                  entry.sourceTimestamp,
                  entry.sourceTimestampKind,
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
      .prepare("SELECT id FROM imports WHERE owner_id=? AND identity=?")
      .pluck()
      .get(ownerId, identity) as string | undefined;
    if (prior) return { id: prior, idempotent: true };

    const now = new Date().toISOString();
    const importId = randomUUID();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO imports(id,owner_id,created_at,source_type,file_sha256,status,warnings_json,identity)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          importId,
          ownerId,
          now,
          "instagram_export",
          hash,
          "committed",
          JSON.stringify(parsed.warnings),
          identity,
        );

      // Materialize this owner's account union before complete-side reconciliation.
      for (const side of sides) {
        const data = parsed.sides[side];
        if (!data) continue;
        for (const entry of data.entries) {
          this.ensureAccount(ownerId, entry, now);
        }
      }

      for (const side of sides) {
        const data = parsed.sides[side];
        if (!data) continue;
        const cov = coverage[side] ?? "partial";
        const latest = Math.max(
          0,
          ...data.entries.map((entry) => entry.sourceTimestamp ?? 0),
        );
        const currentMax =
          (this.db
            .prepare(
              `SELECT max(r.source_relationship_timestamp)
               FROM relationships r JOIN accounts a ON a.id=r.account_id
               WHERE a.owner_id=? AND r.side=? AND r.is_present=1`,
            )
            .pluck()
            .get(ownerId, side) as number | null) ?? 0;
        if (
          latest &&
          currentMax &&
          latest < currentMax &&
          !opts.confirmHistoricalReplay
        ) {
          throw new ConflictException(
            "Older source data requires confirmHistoricalReplay",
          );
        }

        this.db
          .prepare(
            `INSERT INTO import_sides(import_id,owner_id,side,coverage,observed_count,latest_source_timestamp,files_json)
             VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            importId,
            ownerId,
            side,
            cov,
            data.entries.length,
            latest || null,
            JSON.stringify(data.files),
          );

        const selectRel = this.db.prepare(
          `SELECT * FROM relationships WHERE account_id=? AND side=?
           AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=relationships.account_id AND a.owner_id=?)`,
        );
        for (const entry of data.entries) {
          const id = this.ensureAccount(ownerId, entry, now);
          this.db
            .prepare(
              `INSERT INTO import_entries(import_id,side,account_id,owner_id,source_relationship_timestamp,source_timestamp_kind)
               SELECT ?,?,?,?, ?,? WHERE EXISTS (SELECT 1 FROM imports WHERE id=? AND owner_id=? )
                 AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND owner_id=?)`,
            )
            .run(
              importId,
              side,
              id,
              ownerId,
              entry.sourceTimestamp,
              entry.sourceTimestampKind,
              importId,
              ownerId,
              id,
              ownerId,
            );
          const old = selectRel.get(id, side, ownerId) as
            | { is_present: number; last_complete_import_id: string | null }
            | undefined;
          const kind = !old
            ? "first_seen"
            : old.is_present
              ? null
              : "newly_present";
          this.db
            .prepare(
              `INSERT INTO relationships(account_id,owner_id,side,is_present,first_observed_at,last_observed_at,absence_first_detected_at,source_relationship_timestamp,source_timestamp_kind,last_complete_import_id,last_positive_import_id)
               VALUES(?,?,?,1,?,?,NULL,?,?,?,?)
               ON CONFLICT(account_id,side) DO UPDATE SET
                 is_present=1,last_observed_at=excluded.last_observed_at,
                 absence_first_detected_at=NULL,
                 source_relationship_timestamp=excluded.source_relationship_timestamp,
                 source_timestamp_kind=excluded.source_timestamp_kind,
                 last_positive_import_id=excluded.last_positive_import_id,
                 last_complete_import_id=CASE WHEN ?='complete' THEN excluded.last_complete_import_id ELSE relationships.last_complete_import_id END
               WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id=relationships.account_id AND a.owner_id=?)`,
            )
            .run(
              id,
              ownerId,
              side,
              now,
              now,
              entry.sourceTimestamp,
              entry.sourceTimestampKind,
              cov === "complete" ? importId : null,
              importId,
              cov,
              ownerId,
            );
          if (kind) {
            this.change(
              ownerId,
              importId,
              id,
              side,
              kind,
              now,
              old?.last_complete_import_id ?? null,
              cov,
            );
          }
        }

        if (cov === "complete") {
          const known = this.db
            .prepare("SELECT id FROM accounts WHERE owner_id=?")
            .pluck()
            .all(ownerId) as string[];
          for (const accountId of known) {
            const present = this.db
              .prepare(
                `SELECT is_present,last_positive_import_id,last_complete_import_id
                 FROM relationships WHERE account_id=? AND side=?
                   AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=relationships.account_id AND a.owner_id=?)`,
              )
              .get(accountId, side, ownerId) as
              | {
                  is_present: number;
                  last_positive_import_id: string | null;
                  last_complete_import_id: string | null;
                }
              | undefined;
            const included = Boolean(
              this.db
                .prepare(
                  `SELECT 1 FROM import_entries e JOIN imports i ON i.id=e.import_id
                   WHERE e.import_id=? AND e.side=? AND e.account_id=? AND i.owner_id=?`,
                )
                .get(importId, side, accountId, ownerId),
            );
            if (!present) {
              this.db
                .prepare(
                  `INSERT INTO relationships(account_id,owner_id,side,is_present,absence_first_detected_at,last_complete_import_id)
                   SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM accounts WHERE id=? AND owner_id=?)`,
                )
                .run(
                  accountId,
                  ownerId,
                  side,
                  0,
                  now,
                  importId,
                  accountId,
                  ownerId,
                );
            } else if (present.is_present && !included) {
              this.db
                .prepare(
                  `UPDATE relationships SET is_present=0,absence_first_detected_at=?,last_complete_import_id=?
                   WHERE account_id=? AND side=? AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=relationships.account_id AND a.owner_id=?)`,
                )
                .run(now, importId, accountId, side, ownerId);
              this.change(
                ownerId,
                importId,
                accountId,
                side,
                "no_longer_present",
                now,
                present.last_complete_import_id,
                cov,
              );
            } else {
              this.db
                .prepare(
                  `UPDATE relationships SET last_complete_import_id=?
                   WHERE account_id=? AND side=? AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=relationships.account_id AND a.owner_id=?)`,
                )
                .run(importId, accountId, side, ownerId);
            }
          }
        }
      }
      return { id: importId, idempotent: false };
    });
    return tx();
  }

  private ensureAccount(
    ownerId: string,
    entry: ParsedUpload["sides"][Side]["entries"][number],
    now: string,
  ): string {
    let id = this.db
      .prepare(
        "SELECT id FROM accounts WHERE owner_id=? AND username_normalized=?",
      )
      .pluck()
      .get(ownerId, entry.usernameNormalized) as string | undefined;
    if (!id) {
      id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO accounts(id,owner_id,username_normalized,display_username,profile_url,created_at)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(
          id,
          ownerId,
          entry.usernameNormalized,
          entry.displayUsername,
          entry.profileUrl,
          now,
        );
    }
    return id;
  }

  private change(
    ownerId: string,
    importId: string,
    accountId: string,
    side: string,
    kind: string,
    detectedAt: string,
    previousCompleteImportId: string | null,
    coverage: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO relationship_changes(id,import_id,account_id,owner_id,side,kind,detected_at,previous_complete_import_id,evidence_coverage)
         SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM imports WHERE id=? AND owner_id=?)
           AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND owner_id=?)`,
      )
      .run(
        randomUUID(),
        importId,
        accountId,
        ownerId,
        side,
        kind,
        detectedAt,
        previousCompleteImportId,
        coverage,
        importId,
        ownerId,
        accountId,
        ownerId,
      );
  }

  imports(ownerId: string) {
    return this.db
      .prepare(
        `SELECT i.*, (
           SELECT json_group_array(json_object(
             'side',s.side,'coverage',s.coverage,'observed_count',s.observed_count,
             'latest_source_timestamp',s.latest_source_timestamp,'files',json(s.files_json),
             'latest_complete_at',(
               SELECT max(ci.created_at) FROM import_sides cs
               JOIN imports ci ON ci.id=cs.import_id
               WHERE ci.owner_id=? AND cs.side=s.side AND cs.coverage='complete'
             )
           )) FROM import_sides s WHERE s.import_id=i.id
         ) sides_json FROM imports i WHERE i.owner_id=? ORDER BY i.created_at DESC`,
      )
      .all(ownerId, ownerId)
      .map((row) => {
        const item = row as Record<string, unknown>;
        return { ...item, sides: JSON.parse(String(item.sides_json ?? "[]")) };
      });
  }

  importDetail(ownerId: string, id: string) {
    const row = this.db
      .prepare("SELECT * FROM imports WHERE id=? AND owner_id=?")
      .get(id, ownerId) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundException();
    return {
      ...row,
      sides: this.db
        .prepare(
          "SELECT s.* FROM import_sides s JOIN imports i ON i.id=s.import_id WHERE s.import_id=? AND i.owner_id=?",
        )
        .all(id, ownerId),
      entries: this.db
        .prepare(
          `SELECT e.*,a.username_normalized,a.display_username FROM import_entries e
           JOIN imports i ON i.id=e.import_id JOIN accounts a ON a.id=e.account_id
           WHERE e.import_id=? AND i.owner_id=? AND a.owner_id=?`,
        )
        .all(id, ownerId, ownerId),
    };
  }

  changes(ownerId: string) {
    return this.db
      .prepare(
        `SELECT c.*,a.username_normalized,a.display_username FROM relationship_changes c
         JOIN accounts a ON a.id=c.account_id JOIN imports i ON i.id=c.import_id
         WHERE a.owner_id=? AND i.owner_id=? ORDER BY c.detected_at DESC`,
      )
      .all(ownerId, ownerId);
  }

  relationships(ownerId: string, q: Record<string, string>) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 100;
    const search = `%${q.search ?? ""}%`;
    let where = "a.owner_id=?";
    if (q.includeDeleted !== "true")
      where += " AND coalesce(p.manual_status,'')!='deleted'";
    if (q.includeKeepFollowing !== "true")
      where += " AND coalesce(p.keep_following,0)=0";
    if (q.ignored !== "true") where += " AND coalesce(p.ignored,0)=0";
    if (q.manualStatus) where += " AND p.manual_status=?";
    const base = ` FROM accounts a
      LEFT JOIN relationships r ON r.account_id=a.id
      LEFT JOIN account_preferences p ON p.account_id=a.id
      WHERE ${where} AND (a.username_normalized LIKE ? OR a.display_username LIKE ?)
      GROUP BY a.id`;
    const params: (string | number)[] = [ownerId];
    if (q.manualStatus) params.push(q.manualStatus);
    params.push(search, search);
    const havingFor = (followers: string, following: string) =>
      q.view === "mutual"
        ? ` HAVING ${followers}=1 AND ${following}=1`
        : q.view === "not-following-back"
          ? ` HAVING ${following}=1 AND followers_last_complete_import_id IS NOT NULL AND coalesce(${followers},0)=0`
          : q.view === "follower-only"
            ? ` HAVING ${followers}=1 AND following_last_complete_import_id IS NOT NULL AND coalesce(${following},0)=0`
            : "";
    const projection = `SELECT a.*,p.keep_following,p.ignored,p.manual_status,p.note,
      max(CASE WHEN r.side='followers' THEN r.is_present END) followers_present,
      max(CASE WHEN r.side='following' THEN r.is_present END) following_present,
      max(CASE WHEN r.side='followers' THEN r.last_observed_at END) followers_last_observed,
      max(CASE WHEN r.side='following' THEN r.last_observed_at END) following_last_observed,
      max(CASE WHEN r.side='followers' THEN r.last_complete_import_id END) followers_last_complete_import_id,
      max(CASE WHEN r.side='following' THEN r.last_complete_import_id END) following_last_complete_import_id`;
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

  summary(ownerId: string) {
    const count = this.db
      .prepare("SELECT count(*) FROM accounts WHERE owner_id=?")
      .pluck()
      .get(ownerId) as number;
    const category = (sql: string) =>
      this.db.prepare(sql).pluck().get(ownerId) as number;
    return {
      totalAccounts: count,
      notFollowingBack: category(
        `SELECT count(*) FROM relationships f
         JOIN relationships r ON r.account_id=f.account_id AND r.side='followers' AND r.is_present=0
         JOIN accounts a ON a.id=f.account_id
         WHERE a.owner_id=? AND f.side='following' AND f.is_present=1 AND r.last_complete_import_id IS NOT NULL`,
      ),
      followerOnly: category(
        `SELECT count(*) FROM relationships f
         JOIN relationships r ON r.account_id=f.account_id AND r.side='following' AND r.is_present=0
         JOIN accounts a ON a.id=f.account_id
         WHERE a.owner_id=? AND f.side='followers' AND f.is_present=1 AND r.last_complete_import_id IS NOT NULL`,
      ),
      mutual: category(
        `SELECT count(*) FROM relationships f
         JOIN relationships r ON r.account_id=f.account_id AND r.side='followers' AND r.is_present=1
         JOIN accounts a ON a.id=f.account_id
         WHERE a.owner_id=? AND f.side='following' AND f.is_present=1`,
      ),
      freshness: this.db
        .prepare(
          `SELECT s.side,max(i.created_at) latestUpload,
             max(CASE WHEN s.coverage='complete' THEN i.created_at END) latestComplete
           FROM import_sides s JOIN imports i ON i.id=s.import_id
           WHERE i.owner_id=? GROUP BY s.side`,
        )
        .all(ownerId),
    };
  }

  account(ownerId: string, id: string) {
    const account = this.db
      .prepare(
        `SELECT a.*,p.* FROM accounts a LEFT JOIN account_preferences p ON p.account_id=a.id
         WHERE a.id=? AND a.owner_id=?`,
      )
      .get(id, ownerId) as Record<string, unknown> | undefined;
    if (!account) throw new NotFoundException();
    const relations = this.db
      .prepare(
        `SELECT r.* FROM relationships r JOIN accounts a ON a.id=r.account_id
         WHERE r.account_id=? AND a.owner_id=?`,
      )
      .all(id, ownerId) as Array<Record<string, unknown>>;
    const sides: Record<string, Record<string, unknown>> = {};
    for (const side of ["followers", "following"]) {
      const row = relations.find((relation) => relation.side === side);
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
          `SELECT c.* FROM relationship_changes c JOIN accounts a ON a.id=c.account_id
           JOIN imports i ON i.id=c.import_id
           WHERE c.account_id=? AND a.owner_id=? AND i.owner_id=? ORDER BY c.detected_at DESC`,
        )
        .all(id, ownerId, ownerId),
    };
  }

  preferences(ownerId: string, id: string, body: Record<string, unknown>) {
    if (
      !this.db
        .prepare("SELECT 1 FROM accounts WHERE id=? AND owner_id=?")
        .get(id, ownerId)
    ) {
      throw new NotFoundException();
    }
    const existing = this.db
      .prepare(
        `SELECT p.keep_following,p.ignored,p.manual_status,p.note
         FROM account_preferences p JOIN accounts a ON a.id=p.account_id
         WHERE p.account_id=? AND a.owner_id=?`,
      )
      .get(id, ownerId) as
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
        `INSERT INTO account_preferences(account_id,owner_id,keep_following,ignored,manual_status,note,updated_at)
         SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM accounts WHERE id=? AND owner_id=?)
         ON CONFLICT(account_id) DO UPDATE SET owner_id=excluded.owner_id,keep_following=excluded.keep_following,
           ignored=excluded.ignored,manual_status=excluded.manual_status,note=excluded.note,
           updated_at=excluded.updated_at`,
      )
      .run(
        id,
        ownerId,
        body.keepFollowing === undefined
          ? (existing?.keep_following ?? 0)
          : body.keepFollowing
            ? 1
            : 0,
        body.ignored === undefined
          ? (existing?.ignored ?? 0)
          : body.ignored
            ? 1
            : 0,
        body.manualStatus === undefined
          ? (existing?.manual_status ?? null)
          : body.manualStatus,
        body.note === undefined ? (existing?.note ?? null) : body.note,
        now,
        id,
        ownerId,
      );
    return this.account(ownerId, id);
  }
}
