# Hosted authentication and public landing — Phase 2 plan

## Goal

Add private hosted accounts and per-user relationship history without weakening the local-first application. Keep the current two-service Render deployment and SQLite initially. Give unauthenticated visitors a product landing page, not access to imported data.

This is a plan, not an implementation or a claim that the current hosted service is safe for private exports. The current Phase 1 API remains publicly readable and writable. Continue using synthetic or otherwise non-sensitive hosted data until all Phase 2 acceptance checks pass.

## Agreed product decisions

- **Public visitor:** sees a landing page only. No public relationship data or aggregate dashboard.
- **Hosted UI:** `/` becomes the public landing page; `/login` is public; `/dashboard`, `/import`, `/accounts`, `/accounts/:id`, and `/changes` require login.
- **Local UI:** local `/` remains the existing dashboard and local use does not require authentication.
- **Account creation:** invite only. No public registration.
- **Invitation delivery:** an admin creates a time-limited, single-use invitation link and shares it manually. No email provider in this phase.
- **Initial administrator:** provision through a one-time operator-controlled bootstrap action; do not ship a known default password or public admin-creation endpoint.
- **Current hosted data:** reset the existing synthetic dataset as part of the planned migration. Do not assign it to a new account. Local user databases must retain their existing history.
- **Social sign-in:** deferred. Keep credentials/session boundaries suitable for adding another authentication method later, without implementing an OAuth provider now.
- **Persistence:** keep SQLite and the API's persistent Render disk. No PostgreSQL migration in this phase.

## Proposed request and service flow

```text
Browser
  ├── public landing / login / invitation redemption
  └── same-origin /api/* requests
        ↓
Next.js web service (Render)
        └── server-side proxy to API service
              ↓
NestJS API (Render) ─── SQLite on API persistent disk
        ├── authentication and invitation endpoints
        └── every private relationship endpoint scoped to session user
```

Use the web service as the browser-facing origin for API requests. The Next.js rewrite/proxy forwards `/api/*` to the API; the browser calls relative same-origin URLs. This avoids browser cross-origin session cookies and allows a first-party `HttpOnly` cookie on the web hostname. The API remains network-reachable by the web proxy, but every relationship/import endpoint must require a valid session; a public API URL is not authorization.

The proxy must forward the required cookie and request headers, preserve API status/headers, and avoid caching private responses. The cookie must not be exposed to client JavaScript. Configure HTTPS-only cookies in production (`Secure`, `HttpOnly`, appropriate `SameSite`, narrow path) and protect state-changing requests with Origin/CSRF checks. Do not treat CORS, Host checks, or a hidden API URL as authentication.

## Data ownership and migration

Authentication without storage isolation is not sufficient. Every read, aggregate, import, reconciliation, and preference operation must use identity from a verified server-side session. Never accept a user/owner ID from a request body, query, or URL as authority.

The current schema represents one global dataset: `accounts.username_normalized` and `imports.identity` are globally unique, relationships/preferences key by account, and service queries aggregate across all rows. Add explicit ownership and tenant-scoped keys/constraints. The migration must account for:

- accounts, imports, entries, relationships, relationship changes, and preferences belonging to exactly one user;
- username uniqueness and import idempotency being scoped to a user;
- account/detail/preference lookups rejecting IDs not owned by the current session;
- preview tokens being bound to their creating user and unusable by another user;
- proposed-removal counts and complete-snapshot reconciliation operating only on the owner’s records;
- migration/version tracking and transactional upgrades, rather than relying only on `CREATE TABLE IF NOT EXISTS`.

Back up the hosted SQLite database before migration. For the hosted deployment, explicitly reset the existing synthetic dataset during the migration window; verify the target database identity/path before destructive action. For local legacy databases, preserve history by assigning rows to one stable local principal or equivalent local-only ownership scope. Local startup must remain auth-free and must not require a hosted account, invite, secret, or network connection. Test upgrades against a copy of a pre-change local database and verify records/preferences/history survive.

## Authentication and invitation behavior

- Store password hashes only, using a modern password-hashing algorithm and parameters appropriate to the selected dependency/runtime. Never store or log plaintext passwords.
- Validate username/password lengths and formats; use a generic login failure response that does not reveal whether a username exists.
- Use opaque, cryptographically random session identifiers with server-side session records, expiry, logout/revocation, and rotation after successful login. Keep secrets/configuration outside source control.
- Rate-limit login and invitation redemption; bound request sizes; record security events without credentials, session IDs, raw invitation tokens, or uploaded data.
- Store only a hash of each invitation token. Enforce expiry, one-time redemption, and safe redemption under concurrent requests. Invitation creation requires an authenticated administrator; ordinary invited users cannot create further invitations.
- Bootstrap the first administrator with a one-time operator-controlled action and remove/disable bootstrap capability once an administrator exists. Document recovery if the administrator loses access; manual operator reset is acceptable initially.
- Keep authorization policy minimal initially: regular user and administrator. Admin privilege allows invitation management, not implicit access to another user’s relationship data.

Implementation choice to validate before coding: prefer a server-side opaque session stored in SQLite over a self-contained browser bearer token. It makes revocation and logout straightforward and avoids placing durable bearer credentials in JavaScript. Keep session/invitation tables and auth endpoints isolated enough to support future social-auth identity records without changing relationship ownership semantics.

## UI and routing

- Hosted `/`: public product introduction with clear login entry point; do not call private summary endpoints.
- Hosted `/login`: username/password form, generic errors, and safe redirect back to the intended private path after login.
- Hosted `/invite/<token>` (or equivalent): invitation redemption and credential setup; token must not be logged or retained in analytics/referrers.
- Hosted `/dashboard`: existing overview after authentication.
- Hosted `/import`, `/accounts`, `/accounts/:id`, `/changes`: require authentication on initial and client-side navigation. Preserve direct links and return destinations.
- Hosted admin area: create invitation links and display safe expiry/status information; reveal raw token/link only once at creation.
- Local mode: current routes and dashboard behavior remain available without login. Do not accidentally expose local data through a hosted-mode bypass or infer authentication from request failure/network errors.

Protect routes at both UI and API layers. UI redirects improve navigation but are not security controls. A missing/expired session must receive an API `401`; a valid user requesting another user’s resource must not receive that resource (use a consistent not-found or forbidden policy).

## Deployment and rollout

1. Add a versioned database migration and test it on a copy of local legacy data. Produce and verify a SQLite-consistent backup of the hosted database.
2. Implement and test user scoping, preview ownership, auth, invitations, and public health handling in local/test environments.
3. Verify unauthenticated requests cannot read or mutate any relationship/import endpoint. Confirm public routes return no imported data.
4. During a scheduled hosted migration, verify the mounted database path, reset only the agreed synthetic hosted dataset, apply migrations, and provision the initial admin through the one-time operator action.
5. Deploy API auth and migration support. Change Render API health check from private `/summary` to a data-free `/healthz` endpoint. Keep health checks unauthenticated and expose no counts, usernames, or import details there.
6. Configure hosted web with a server-side API upstream URL (not a browser-exposed API URL), deploy the same-origin `/api/*` proxy, then deploy the public landing/login/private dashboard routes.
7. Create an invitation, redeem once, verify a second redemption fails, log in/out, and verify session expiry/revocation. Run two-user isolation tests before uploading any personal export.
8. Recheck persistence after API restart/redeploy and inspect logs for accidental credential, session, invite, or export-data disclosure.

The API health endpoint must not leak private state. Continue to use one API instance while SQLite and process-local upload previews remain in place. Preview data remains transient on restart, but preview ownership must be enforced while the process is live.

## Acceptance criteria

- Local setup, auth-free dashboard, import, history, and preferences remain functional.
- Existing local database upgrades without losing imports, relationships, changes, or preferences.
- Hosted public routes reveal no user data; every data endpoint rejects anonymous access.
- Two accounts have fully isolated lists, counts, histories, imports, preferences, idempotency, reconciliation, and preview tokens—including attempts using another user’s record IDs or preview token.
- Invite-only creation, one-use/expiry behavior, admin authorization, password hashing, login throttling, session rotation/expiry/revocation, and CSRF/origin checks have automated tests.
- Hosted UI sends API calls through the same web origin; session cookie is HTTPS-only, `HttpOnly`, and not readable in browser JavaScript.
- The hosted migration targets only the existing synthetic database, and SQLite data remains durable across API restart/redeploy.
- No private export is used for fixtures or deployed smoke tests. Keep synthetic data for verification.

## Out of scope

Public signup, email delivery, password reset emails, social/OAuth login, multi-factor authentication, roles beyond user/admin, public/demo relationship dashboards, billing, PostgreSQL, and changing the local app to require accounts.

## Related plan

Phase 1 deployment settings and current service shape: [Render Phase 1](render-phase-1.md). Phase 1 explicitly excludes authentication and is not safe for private hosted exports until this plan is implemented and its acceptance criteria pass.
