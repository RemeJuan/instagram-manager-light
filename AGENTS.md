# AGENTS.md

## Project

Instagram Manager Light is a local-first, open-source Instagram relationship manager. It imports Instagram account export data and helps users inspect relationship changes and differences without requiring Instagram credentials or private API access.

The project may also have a hosted SaaS version. The local/open-source application remains a first-class use case; hosted requirements must not unnecessarily compromise local operation.

## Architecture

- Nx monorepo.
- `apps/web`: Next.js 15 / React 19 frontend.
- `apps/api`: NestJS 10 API.
- Persistence currently uses `better-sqlite3`.
- Instagram export archives/files are uploaded and parsed by the API.
- Shared/domain code should live in `libs` where appropriate rather than being duplicated between apps.
- Root development command: `npm run dev`.
- Root build command: `npm run build`.
- API tests: `npm run test:api`.
- Formatting is enforced with Prettier and `npm run format:check` runs before builds.

Before changing architecture, inspect the existing implementation and documentation rather than assuming conventional Nx, Next.js, NestJS, or SQLite layouts.

## Product Principles

1. Keep the local version simple. A user should be able to clone/install the project and use it with a local SQLite database.
2. The application works from user-provided Instagram export data. Do not introduce Instagram scraping, credential collection, unofficial login automation, or private API dependencies unless explicitly requested.
3. Historical imports are valuable. Preserve enough normalized data to compare snapshots and relationship changes over time.
4. Prefer incremental evolution over speculative infrastructure.
5. Hosted features should share domain/import logic with the local version wherever practical.

## Persistence

SQLite is intentional for the local application and is acceptable for the initial hosted MVP.

- Do not replace SQLite merely because the application is being hosted.
- Keep database access sufficiently isolated that a future hosted deployment can migrate to PostgreSQL or another server database without rewriting domain logic.
- Avoid adding new SQLite-specific coupling when a straightforward database-neutral design is equally simple.
- Do not prematurely build a multi-database abstraction layer solely for a hypothetical migration.
- Database files must never be committed.
- Changes to schema or import behaviour must preserve existing user data where practical.

If the hosted product gains meaningful usage, a scheduled maintenance migration from SQLite to a production database is acceptable.

## Hosted Product Direction

The likely hosted progression is:

1. Deploy the current application with minimal behavioural changes and verify that it works reliably in a hosted environment.
2. Add authentication and user isolation.
3. Add subscriptions/payment handling if demand warrants it.
4. Migrate hosted persistence away from SQLite only when scale, reliability, concurrency, or operational requirements justify it.

Render with persistent storage is the current preferred initial hosting direction. Treat this as a current implementation choice, not a permanent platform requirement.

For the first hosting phase:

- Preserve current application behaviour.
- Use persistent storage for the SQLite database.
- Determine whether uploaded archives are transient processing inputs before making them persistent.
- Make filesystem/database paths configurable so local development remains straightforward.
- Account for Render-provided ports and runtime environment.
- Make frontend API endpoints and API CORS/origin configuration environment-driven where required.
- Verify `better-sqlite3` native dependency installation in the deployment environment.
- Add only the health checks/logging necessary to operate and diagnose the deployment.

Do not add authentication, accounts, multi-tenancy, subscriptions, PostgreSQL, or unrelated product features as part of hosting work unless the task explicitly expands scope.

## Future Authentication / Multi-tenancy

The hosted version is expected eventually to support user accounts and long-lived per-user history.

When that work is explicitly started:

- Every hosted data access path must be scoped to the authenticated user.
- Do not rely on client-provided ownership identifiers for authorization.
- Uploaded Instagram data is private user data; minimize retention of raw uploads where they are not required.
- Keep local mode usable without hosted authentication unless product requirements explicitly change.
- Design migration paths for existing hosted single-user data rather than silently discarding it.

These are future constraints, not instructions to implement auth now.

## Engineering Guidelines

- Make the smallest change that cleanly solves the current requirement.
- Preserve the Nx monorepo unless there is a demonstrated reason to restructure it.
- Prefer explicit environment configuration over environment-specific forks.
- Keep parsing, normalization, comparison, and persistence concerns separated.
- Validate uploaded data defensively; Instagram export formats may evolve.
- Do not silently discard malformed or partially supported data.
- Avoid storing derived data when it can cheaply and reliably be recalculated, unless persistence materially improves history or performance.
- Do not introduce cloud-provider-specific code into core/domain logic.
- Avoid new dependencies when the existing stack solves the problem adequately.

## Verification

For relevant changes, run the narrowest useful checks first, then broader checks before completion.

At minimum consider:

- `npm run format:check`
- `npm run test:api`
- `npm run build`

For persistence changes, explicitly verify data survives application restarts. For hosting changes, verify data survives a deployment/restart when persistent storage is expected.

## Agent Behaviour

- Read this file, the relevant source, and existing docs before proposing implementation.
- Distinguish current requirements from future direction.
- Do not implement future phases opportunistically.
- Call out assumptions when repository evidence is incomplete.
- Prefer plans that identify exact files/configuration likely to change and include verification steps.
- Do not rewrite working code merely to fit a preferred framework pattern.
- Keep changes reviewable and scoped.
