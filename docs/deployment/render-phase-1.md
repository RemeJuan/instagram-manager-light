# Render deployment plan — Phase 1

## Goal and scope

Prove that the current Nx/Next.js/NestJS application runs reliably on Render, with existing import, relationship-history, and preference behaviour intact. Keep SQLite for this initial hosted MVP. Prefer deployment configuration and small environment-aware changes over restructuring.

Out of scope: authentication, accounts, multi-tenancy, payments, PostgreSQL, and product features. Do not introduce a database abstraction or build a future multi-user architecture in this phase. Keep the existing `RELATIONSHIP_DB` path override so a future persistence change remains possible without adding speculative abstractions now.

## Deployment shape

Deploy two Render **Node web services** from this repository:

1. **Web** runs Next.js and serves the browser UI.
2. **API** runs NestJS, handles browser API requests, imports, and SQLite access.

Use the repository root as both services' Root Directory. Nx builds use root-level workspace configuration, libraries, and lockfile; setting a service root to `apps/web` or `apps/api` would hide those inputs. Add repository-root-relative build filters later only if automatic build filtering is useful; do not exclude files required by shared Nx builds.

Separate services match the current browser-to-API calls in `apps/web/lib/api.ts` and keep each build/start command explicit. A combined service would need a process supervisor and routing changes and offers little Phase 1 benefit. Since browser code calls the API directly, API must have a public HTTPS URL. A private API would require a same-origin web proxy, which is additional implementation and is not part of this minimal plan.

**Security decision:** both services are publicly reachable and Phase 1 has no authentication. CORS and Origin/Host checks are browser request controls, not protection from direct API clients. Anyone who discovers the URLs can read or mutate the shared dataset and submit imports. Use synthetic or otherwise non-sensitive data only, and explicitly accept this exposure before deployment. If that is unacceptable, do not expose the service publicly; defer launch until an access-control design is approved.

## Render service settings

Run both services in the same Render region and connect them to the same GitHub repo/branch.

| Setting         | Web                                              | API                                                |
| --------------- | ------------------------------------------------ | -------------------------------------------------- |
| Runtime         | Node                                             | Node                                               |
| Root Directory  | Repository root (unset)                          | Repository root (unset)                            |
| Build command   | `npm ci && npx nx run web:build`                 | `npm ci && npx nx run api:build`                   |
| Start command   | `npx nx run web:serve:production --port "$PORT"` | `node dist/apps/api/main.cjs`                      |
| Health check    | `/`                                              | `/summary`                                         |
| Persistent disk | None                                             | Mount at `/opt/render/project/src/data`            |
| Instances       | One                                              | One; required with the disk and in-memory previews |

Pin Node to the version in the project requirements (`Node.js 24`) with a root `.node-version` file or Render's `NODE_VERSION` setting. Keep `package-lock.json` and use `npm ci` for reproducible installation.

### Nx production server

`apps/web/project.json` has explicit development and production configurations. Production selects `web:build:production` and sets `dev: false`; development retains `dev: true` and port 3000. Nx `withNx` configures Next output in `dist/apps/web`, matching the Nx server executor's production working directory. Nx 21's server executor can default an omitted port to 4200, so pass Render's `PORT` explicitly on the production start command.

### Disk and SQLite

Attach a small Render persistent disk to the API, for example 1 GB, mounted at `/opt/render/project/src/data`. Set:

```text
RELATIONSHIP_DB=/opt/render/project/src/data/relationships.sqlite
```

This path is an example tied to Render's native Node project layout; confirm it in the running service before relying on it. Render persists only files under the mount. Keep SQLite's database and its WAL sidecar files (`-wal`, `-shm`) in the same mounted directory. `RelationshipService` already creates the database parent directory, uses WAL, and enables foreign keys. Preserve local behaviour: when `RELATIONSHIP_DB` is unset, the API uses `data/relationships.sqlite` relative to its working directory.

Render disks require a paid compatible service, are attached to only one service instance, prevent scaling that service beyond one instance, and cause brief downtime during deploys. Do not rely on the web service accessing this disk. Establish a SQLite-consistent backup procedure before putting valuable data on it; a disk is persistence, not a substitute for verified backups. Existing schema setup uses `CREATE TABLE IF NOT EXISTS`, not a migration system; Phase 1 assumes no schema upgrade is required.

### Environment variables

| Variable              | Web                                  | API                                                 | Meaning                                                                                             |
| --------------------- | ------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PORT`                | Render-provided                      | Render-provided                                     | Listener port. Keep local defaults at web 3000 and API 3001.                                        |
| `NEXT_PUBLIC_API_URL` | `https://<api-service>.onrender.com` | —                                                   | Browser API base URL; compiled into the Next bundle at build time. Set before the web build/deploy. |
| `HOSTED`              | —                                    | `true`                                              | Select hosted listener, CORS, and request-guard behaviour. Leave unset locally.                     |
| `WEB_ORIGIN`          | —                                    | `https://<web-service>.onrender.com`                | Exact allowed web origin, no trailing slash. Local default should remain `http://localhost:3000`.   |
| `RELATIONSHIP_DB`     | —                                    | `/opt/render/project/src/data/relationships.sqlite` | Hosted SQLite file path. Leave unset locally for current relative default.                          |

`HOSTED=true` selects the API's hosted listener, CORS, and request-guard behaviour. It listens on `0.0.0.0` when hosted and `127.0.0.1` locally. CORS permits only the configured frontend origin, never a wildcard. Startup rejects missing or invalid hosted origin/database configuration rather than quietly using local defaults.

`apps/api/src/local-request-guard.middleware.ts` retains localhost hostname and socket-port checks in local execution. Hosted execution uses a proxy-compatible Host policy and configured mutation Origin. Check actual Render Host/proxy headers before introducing a Host allowlist. Browser cross-origin mutation controls are not authentication.

## Upload and preview lifecycle

Uploads are transient processing inputs. `FilesInterceptor` provides buffers; `parseUpload()` processes them in memory. No uploaded archive or JSON file is written to an upload directory, so no upload disk or object storage is required in Phase 1.

Preview tokens and parsed results live in `AppController`'s process-local `Map` for up to 15 minutes. A process restart/deploy loses pending previews; users must upload and preview again. This is acceptable for the proof deployment. Keep API to one instance: requests routed to another process would not see the preview token. Durable previews, shared cache, sticky sessions, or upload persistence are not Phase 1 work.

## Hosting assumptions and deployment risks

- **API binding and port:** `apps/api/src/main.ts` binds loopback locally and `0.0.0.0` in hosted mode. Set Render's `PORT` on the hosted API.
- **CORS and request guard:** Hosted mode uses the configured web origin and permits proxy Host/port values; validate behaviour against actual Render headers after deployment.
- **Browser API URL:** `NEXT_PUBLIC_API_URL` defaults to localhost. Set the production URL before building web; browser requests cannot use Render's internal hostname.
- **Native module:** `better-sqlite3` is a native dependency. Confirm it installs and loads with `npm ci` on Render's Linux runtime and pinned Node version. Preserve the required install/build dependencies.
- **Nx output:** verify `dist/apps/api/main.cjs` exists and executes. Verify the Nx production Next server serves its build output and honors `PORT`.
- **Memory:** import endpoint allows up to 20 files, each up to 25 MB; ZIP parsing, buffers, and previews consume process memory. Smoke-test realistic largest supported imports on the selected API plan. Increase service memory if needed; do not add persistent upload files as a workaround.
- **Database durability:** test both service restart and deploy. Confirm writes, SQLite database, and WAL sidecars are on disk mount. A change to service working directory must not redirect the hosted database.
- **Deploy availability:** disk-backed API deployments stop the old instance before starting its replacement, so brief API downtime is expected. Pending previews disappear on restart.
- **Logging:** rely initially on Nest/Next stdout/stderr logs. Verify startup shows service/port and database path without logging imported data; verify startup errors and request failures appear in Render logs. Do not log upload contents or personal exports.

## Implementation sequence and verification

1. **Pin runtime and verify current outputs.** Add Node 24 pin. From repo root run `npm ci`, `npx nx run api:build`, and `npx nx run web:build`. Confirm API artifact path and inspect Next build output. Run existing API tests (`npm run test:api`).
2. **Add minimal runtime configuration.** Add Nx production web serve config without fixed production port. Make API bind address, CORS origin, hosted request guard, and database path environment-aware while preserving local defaults. Update the API connection error text so it does not incorrectly say “local” in hosted mode.
3. **Add focused tests.** Retain local request-guard tests. Add hosted-mode tests for a configured web Origin and proxy Host/port behaviour. Verify invalid/unconfigured hosted settings fail clearly. Keep current in-memory SQLite tests.
4. **Validate production commands locally.** Build both targets; launch with production commands and non-default `PORT`. Confirm Next and Nest bind successfully. Exercise health paths and the browser/API flow. Check `better-sqlite3` opens a file-backed database at a temporary absolute `RELATIONSHIP_DB` path; restart API and confirm data persists.
5. **Configure Render.** Create the two Node web services, root commands and health checks in the table above. Attach disk to API only. Set hosted variables. Deploy API first, record its public HTTPS URL, set `NEXT_PUBLIC_API_URL` on web before web build, then deploy web. Optionally capture this configuration in root `render.yaml` after confirming service names and URLs; do not allow Blueprint and dashboard settings to drift.
6. **Run hosted smoke test.** Check web `/` and API `/summary`; use browser DevTools to confirm HTTPS API calls and successful CORS preflight. Upload a synthetic export, preview, commit, then verify summary/list/preferences. Restart and redeploy API; verify committed data survives. Verify pending preview loss produces an understandable expired-preview result. Review build/runtime logs and backup procedure.

**Phase 1 acceptance:** local `npm run dev` remains functional; deployed UI and existing core flows work; API uses its mounted persistent database; committed records survive restart and deploy; transient uploads/previews need not survive; single-instance and brief deploy downtime are documented; do not expose personal data unless that risk is separately accepted.

## Reference links

- [Render persistent disks](https://render.com/docs/disks)
- [Render Blueprint YAML reference](https://render.com/docs/blueprint-spec)
- [Render monorepo support](https://render.com/docs/monorepo-support)
- [Render health checks](https://render.com/docs/health-checks)
- [Render Node version configuration](https://render.com/docs/node-version)
- [Nx Next.js executors](https://nx.dev/docs/technologies/react/next/executors)
- [Nx 21 Next server executor source](https://github.com/nrwl/nx/blob/21.6.5/packages/next/src/executors/server/server.impl.ts)
