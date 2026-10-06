# Instagram Relationship Manager

## Status

MVP implemented: local UI/API, synthetic fixtures, JSON/ZIP parsing, SQLite reconciliation, import history, and regression tests. Optional profile verification remains deferred. The supplied Instagram export ZIP was not inspected; treat it as private personal data.

## Goal and constraints

Build a single-user, local-first relationship manager from uploaded Instagram exports. Core use must not require Instagram authentication, Python Instagram packages, Docker, remote services, or a separate database service.

Prioritize a working import-and-diff MVP. Optional profile verification is deferred and must not affect imported relationship facts.

## Architecture

```text
apps/
  web/                 Next.js UI: dashboard, imports, account lists, history
  api/                 NestJS API: upload parsing, reconciliation, queries
libs/
  contracts/           Shared DTOs and enums
  import-format/       ZIP selection, Instagram JSON parsing, normalization
  relationship-core/  Snapshot reconciliation and change classification
data/                  Ignored SQLite database and temporary uploads
fixtures/              Synthetic, version-controlled test exports only
```

Next.js calls NestJS over localhost; NestJS owns SQLite access. Use one local database file and migrations. Start both apps with one documented local development command. Bind API to localhost by default. Nx supports separate Next.js and NestJS apps and shared TypeScript libraries.

### Decisions

- **Local SQLite:** avoids service setup and keeps data on the user’s machine.
- **Explicit per-side coverage:** avoids false unfollow conclusions when importing partial data.
- **No raw-export retention by default:** store parsed entries/history, not personal ZIP content.
- **No account verification in MVP:** official tokenless arbitrary-profile verification is not reliably available; scraping is not an acceptable default.

## Data model

| Table | Fields and constraints |
|---|---|
| `accounts` | `id`, `username_normalized UNIQUE`, `display_username`, `profile_url`, `created_at` |
| `imports` | `id`, `created_at`, `source_type`, `file_sha256`, `status`, `warnings_json`; never retain raw archive by default |
| `import_sides` | `import_id`, `side` (`followers`/`following`), `coverage` (`complete`/`partial`), `observed_count`, `latest_source_timestamp`; unique `(import_id, side)` |
| `import_entries` | `import_id`, `side`, `account_id`, `source_relationship_timestamp`, `source_timestamp_kind`; unique `(import_id, side, account_id)` |
| `relationships` | `account_id`, `side`, `is_present`, `first_observed_at`, `last_observed_at`, `absence_first_detected_at`, `source_relationship_timestamp`, `source_timestamp_kind`, `last_complete_import_id`, `last_positive_import_id`; unique `(account_id, side)` |
| `relationship_changes` | `id`, `import_id`, `account_id`, `side`, `kind` (`first_seen`, `newly_present`, `no_longer_present`), `detected_at`, `previous_complete_import_id`, `evidence_coverage` |
| `account_preferences` | `account_id`, `keep_following`, `ignored`, `manual_status`, `note`, `updated_at` |
| Later: `verification_settings`, `verification_checks` | Enable flag, per-account state and timestamps, attempts, method and non-authoritative result. Must not mutate relationships. |

Keep source relationship timestamps separate from observed and detected timestamps. If timestamp semantics are unclear, label them “timestamp in export,” not an exact follow date. Label changes “first detected on import,” not exact unfollow dates.

## Import and reconciliation

1. Accept an Instagram export ZIP or standalone follower/following JSON files. Accept multiple follower files per export and combine them. Identify relationship sides from validated JSON structures, never upload filenames or archive paths; validate ZIP paths only for archive safety.
2. Followers come from `string_list_data[].value`. Following records may include `title`, profile URLs and timestamps. Preserve usable source timestamps independently of application observation dates.
3. Preview recognized files, side counts, duplicates, malformed entries, selected coverage, and proposed removals before commit. User confirms complete coverage **per side**. Default ambiguous or standalone uploads to partial. ZIP presence alone does not prove completeness. Either side can be imported independently.
4. Normalize usernames by trimming whitespace and an optional leading `@`, then case-fold for canonical comparison. Accept Instagram profile URLs and Instagram-hosted `/_u/<username>` export links only when identities agree with supplied `title`/`value`; generate canonical Instagram profile links rather than storing export routing URLs. Preserve display spelling; reject invalid, ambiguous, or untrusted URLs. Deduplicate per side and warn on conflicting metadata.
5. For a purported complete side, invalid relationship records must fail validation or require explicit user repair; do not interpret dropped/malformed entries as removals.
6. One database transaction creates import metadata and entries, upserts accounts, reconciles included sides and writes change events. Any failure rolls back all writes. An absent side is untouched.
7. Every positively observed account becomes present and updates `last_observed_at`. Only a complete snapshot can mark a previously-present account missing and create `no_longer_present`. Partial imports never infer removals. A positive observation after recorded absence creates `newly_present`; initial observation creates `first_seen`.
8. Track each side’s latest upload and latest complete snapshot separately. Display freshness per side. Example: “Following: partial update today; last complete snapshot 4 Oct.”
9. Make exact repeated content plus same coverage idempotent: no duplicate changes. Coverage selection is part of import identity; same bytes changed from partial to complete must reconcile as a new operation. Hash canonical side contents and coverage, not ZIP bytes alone. Older imports must warn or block reconciliation unless user explicitly confirms historical replay.
10. Username-only data cannot reliably identify renames. Treat old/new names as separate accounts and show uncertainty; never auto-merge or infer a rename. Retain a stable source account ID only if present and validated, for possible future identity linking.

Derived views:

- **Not following back:** following present, followers absent.
- **Follower-only:** followers present, following absent.
- **Mutual:** both present.

Distinguish “absent from latest complete snapshot” from “never observed,” particularly before both sides have complete baselines. Counts and derived classifications must show partial/stale state prominently.

## API

| Endpoint | Purpose |
|---|---|
| `POST /imports/preview` | Bounded ZIP/JSON upload; return parsed counts, warnings and proposed changes. |
| `POST /imports` | Commit preview with per-side completeness confirmation and idempotency token. |
| `GET /imports`, `GET /imports/:id` | Import history and detail. |
| `GET /changes` | Detected relationship changes. |
| `GET /relationships?view=&search=&sort=&order=&ignored=&manualStatus=&page=` | Paginated account list with per-side freshness. |
| `GET /accounts/:id` | Account detail and timeline. |
| `PATCH /accounts/:id/preferences` | Persist keep-following, ignore, manual status and note. |
| Later: `GET/PATCH /verification/settings`, `GET /verification/checks`, `POST /verification/checks/:accountId` | Optional isolated verification controls and results. |

Validate DTOs and query parameters. Bound upload size, file count and request duration; do not log usernames or uploaded payloads.

## UI screens

- **Dashboard:** category counts, changes and freshness/coverage for each side.
- **Import:** upload, preview, coverage confirmation, validation warnings and commit result.
- **Accounts:** search, filters, sorting, Instagram profile link and accessible copy-username icon.
- **Changes:** import comparison with explicit detection-date language.
- **Account detail:** source timestamp (if available), observation history, persistent keep-following/ignore/manual-status controls.

Preferences alter display/triage only, never imported relationship facts. Hide ignored accounts by default but provide a “show ignored” option.

## Upload safety

Set compressed size, expanded total size, entry count, JSON size and parse-time limits. Inspect entries without extracting ZIP paths into the workspace. Reject traversal and absolute paths, symlinks, encrypted/nested archives, unexpected file types, suspicious duplicate paths and decompression bombs. Validate content, not filename alone. Return actionable errors for missing sides, malformed JSON, invalid entries and conflicting duplicates. Avoid logging upload contents or personal usernames.

## Sample data and privacy

Create synthetic, version-controlled fixtures reflecting supplied aggregates: 810 following, 783 followers, 63 not following back, 747 mutuals and 36 follower-only. Include split followers, supported JSON shapes, timestamps, partial updates, duplicate imports, rename ambiguity and malformed ZIP/JSON.

Keep personal exports, the supplied ZIP, real JSON, SQLite database, temporary uploads and logs containing personal data out of version control. Use the real ZIP only in a private local parser check after reviewing its structure. Add ignore rules before running import tests.

## Phased implementation

### Phase 1 — MVP: workspace, parser, SQLite, import and diff

- Scaffold Nx workspace with Next.js, NestJS and shared libs.
- Add SQLite migrations and transactional import path.
- Implement ZIP/JSON parser and preview/confirm flow.
- Implement complete/partial reconciliation and derived categories.
- Build minimal dashboard, import and account-list screens.

### Phase 2 — Usability and history

- Add import/change history, freshness indicators, search/filter/sort.
- Add profile links, copy-username icon, persistent flags and account detail.
- Add safe handling for historical imports and idempotent replay.

### Phase 3 — Hardening

- Add archive limits, path safety, rollback tests and hostile archive fixtures.
- Validate ordering, malformed rows, duplicate metadata, independent side updates and unknown timestamp semantics.
- Confirm privacy-safe logs and ignored data paths.

### Phase 4 — Optional verification, only after feasibility review

Meta’s documented Business Discovery requires an authenticated eligible professional account and covers professional-account data, not arbitrary personal accounts. A tokenless public-profile request has no reliable availability contract; automated scraping creates policy and reliability concerns. Default to **verification off and not shipped as a bulk scraper**.

If a compliant method is approved later, add an optional, slow, restart-safe SQLite-backed check process. States: `unchecked`, `reachable_by_method`, `inconclusive`, `check_error`, `unsupported`. Record last-check time; use conservative exponential backoff; stop/back off on throttling. A failure or API miss remains inconclusive and must never establish deletion, abandonment or unfollow. Keep verification records separate from imported relationships. Blocking decision for this phase only: is professional-account authentication acceptable? MVP has no blocking decision; partial-by-default and explicit complete confirmation are recommended.

## Acceptance criteria

### MVP

- Fresh local setup starts UI and API without credentials, Instagram login, Docker or external services.
- ZIP containing multiple follower files and standalone follower/following files import correctly; either side can be refreshed alone.
- Synthetic fixture gives 810 following, 783 followers, 63 not following back, 36 follower-only and 747 mutuals.
- Missing entries in partial imports produce zero unfollow detections; omissions in complete snapshots are detected.
- Importing identical canonical content with same coverage twice creates no duplicate change events.
- Malformed import fails without changing database state.
- Each side displays latest upload and latest complete-snapshot freshness separately.
- Export timestamps and detection dates have distinct labels; UI never claims detection date is exact follow/unfollow date.

### Usability and hardening

- Search/filter/sort, profile navigation and username copy work; keep-following, ignore and manual status persist across restart and imports.
- Case variants normalize to one account while display username remains available.
- Invalid records cannot silently manufacture complete-snapshot removals.
- ZIP traversal, decompression bombs, encrypted archives and limits are rejected safely; no archive path is extracted to an arbitrary location.
- Failure at any stage rolls back import metadata, entries, relationships and changes atomically.
- Username changes without stable IDs are not auto-merged.
- Tests cover a single-side refresh retaining opposite-side state and displaying its staleness.

### Optional verification

- Disabled by default and impossible to confuse with imported relationship state.
- Every result includes state and last-check time; errors never mark a profile deleted or alter relationship lists.
- Slow pacing, conservative retries, throttling backoff and explicit on/off control verified.
