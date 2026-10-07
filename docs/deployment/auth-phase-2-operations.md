# Hosted authentication operations: initial admin and rollout

## Scope and current status

This runbook supplements [the Phase 2 plan](auth-phase-2.md); it does not establish that authentication, migration, reset, or rollout implementation is complete. Phase 1 Render settings below are historical, unauthenticated configuration. They are not safe for private exports. Keep hosted data synthetic until every Phase 2 acceptance criterion and rollout gate is verified.

Current code provides an unauthenticated, data-free API `GET /healthz` endpoint and hosted web same-origin `/api/*` rewrite. For a Phase 2 deployment override the Phase 1 settings:

- API health check: `/healthz` (not Phase 1 `/summary`).
- Web: set `NEXT_PUBLIC_HOSTED=true` and server-only `API_UPSTREAM_URL` to API HTTP(S) origin, without path or credentials. Do not set `NEXT_PUBLIC_API_URL` in hosted configuration; it exposes the API base URL to browser code and is not used by the hosted proxy.
- API: keep `HOSTED=true`, exact HTTPS `WEB_ORIGIN` with no trailing slash, and absolute `RELATIONSHIP_DB` under the persistent disk mount. Keep Render `PORT`.
- Keep API and web on coordinated versions. API and web overrides must not be treated as completed auth or data isolation; those require implementation and acceptance tests described in Phase 2 plan.

`apps/web/next.config.js` reads `API_UPSTREAM_URL` when constructing hosted rewrites. `apps/web/lib/api.ts` uses same-origin requests when `NEXT_PUBLIC_HOSTED=true`; `NEXT_PUBLIC_API_URL` remains a local/non-hosted fallback. API hosted config validates `WEB_ORIGIN` and absolute `RELATIONSHIP_DB`; `/healthz` is implemented in the API. Verify deployed settings and built web behavior rather than assuming dashboard values match this document.

## Required rollout gates — not yet done

Do not reset data or declare Phase 2 rollout complete until all gates below pass. No destructive reset script or automatic reset is implemented by this runbook.

1. **Backup:** identify and use a SQLite online-backup procedure suitable for the deployed SQLite version. Produce backup and verify its integrity and contents. Ordinary copying of a live database file is not a verified backup.
2. **Target identity:** verify the exact mounted persistent-disk target path, canonical database path, and database identity from the running deployment before any migration/reset. Do not infer identity from a configured string alone.
3. **Synthetic-only data:** verify dataset is synthetic-only using an explicit, reviewed verification procedure. If identity or data contents are uncertain, stop; do not reset.
4. **Reset approval:** obtain explicit operator approval for the exact verified target path and synthetic dataset immediately before any destructive reset. Reset procedure is not implemented here; do not improvise commands or use admin bootstrap as reset.
5. **Coordinated deployment:** schedule API and web deployment together, with an agreed maintenance window, tested compatibility/rollback decision, and operator present. Do not deploy only one side and assume Phase 2 is live.
6. **Durability:** verify committed synthetic records survive API restart and redeploy on mounted persistent storage. Verify backup restore procedure on a safe copy, not production target.
7. **Real browser/proxy smoke:** using a synthetic token only, verify cookie attributes and browser visibility, same-origin proxy request/response behavior, Origin checks, login/session and logout flows, and relevant API/web logs. Confirm no token, cookie/session ID, credentials, or imported data appear in logs. Do not use a personal export or real account token.

Record evidence, operator, timestamp, target path, and pass/fail for each gate. Any failed or unverified gate blocks destructive action and private-data use.

Initial admin creation is a manual, one-time operation. Never run it from a build, startup hook, or deploy command. It refuses an existing user set; it does not reset accounts or data.

## Bootstrap

Run from the deployed application root, with production dependencies and the esbuild CLI available and the mounted database available. The script bundles `apps/api/src/bootstrap-admin.ts` on demand to `dist/apps/api/bootstrap-admin.cjs`, then runs it; this is a manual operator command, never a build, startup hook, or deploy command. Set `HOSTED=true`, `WEB_ORIGIN` to the exact hosted HTTPS origin required by API config, and `RELATIONSHIP_DB` to the absolute path of the existing database file. Do not use a path that could be mistyped into creating another DB. Command takes username only; password comes from stdin and is never accepted as an argument or logged.

```sh
HOSTED=true WEB_ORIGIN=https://app.example.com RELATIONSHIP_DB=/var/data/relationships.sqlite \
  npm run bootstrap:admin -- operator
```

Inspect printed canonical path and type it exactly when prompted. Cancel if path differs from expected persistent volume. For interactive terminal, password input is hidden. For non-interactive use, pipe password through stdin from a protected secret mechanism; avoid shell history, command-line literals, logs, and temporary plaintext files. Password must be at least 12 characters. Successful completion prints username only. Subsequent attempt must fail as unavailable once any account exists.

The command checks hosted mode, required environment, existing file, and exact operator path confirmation before constructing `AuthService`. This guard is not a substitute for checking deployment mount and database identity yourself.

## Recovery / accidental lockout and future reset decision points

Do not delete or edit auth tables to force bootstrap. Preserve original DB first. Use a verified SQLite online backup procedure appropriate to deployed SQLite version; for example, SQLite CLI `.backup` or `better-sqlite3` backup API may be suitable. Do not copy a live database file with ordinary filesystem copy. Stop writes or use a consistent online backup procedure. Verify backup path, integrity, and contents before recovery.

If operator considers a synthetic hosted reset: first decide whether reset is necessary and authorized; then verify the online backup, exact mounted target path/database identity, and synthetic-only contents independently. Obtain explicit approval naming that exact path. Proceed only under a separately documented, reviewed manual procedure with a maintenance window and recovery plan. This runbook supplies no reset command; do not improvise destructive SQL/shell commands or run bootstrap as reset. Stop if any decision is uncertain. Never reset real user data. Automatic reset and account recovery are not implemented.
