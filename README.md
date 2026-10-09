# Instagram Relationship Manager

Local-first Instagram relationship manager. Next.js web application and NestJS API share TypeScript workspace libraries; API persists relationship history in SQLite.

## Requirements

- Node.js 24
- npm 11

## Setup and development

```sh
npm install
npm run dev
```

`npm run dev` serves the local, authentication-free workspace at `http://localhost:3000`; the API binds to loopback at `http://127.0.0.1:3001`. For a local production-mode run, use `npm run start:release`. It rebuilds both apps in local mode, starts the API from `dist/apps/api/main.cjs`, waits for its health check, then serves the web app at port 3000. This local command requires no account or login. `npm run start:prod` remains an alias for `npm run start:release`. Both local commands use the SQLite path in `RELATIONSHIP_DB` when set, or default to `data/relationships.sqlite` (ignored by git); set `RELATIONSHIP_DB` to override the path. Use `npm run build` to build both applications without starting them.

For optional access from a trusted local network, supply this machine's RFC1918 IPv4 address explicitly:

```sh
LOCAL_LAN_IP=192.168.68.120 npm run dev:lan
LOCAL_LAN_IP=192.168.68.120 npm run start:lan:release
```

Then open `http://192.168.68.120:3000` on the other device, replacing the example address with this machine's current LAN IP. LAN mode binds the web server to all interfaces; API stays bound to loopback and web proxies API requests locally. This unauthenticated app may expose private exports and relationship data to devices on the LAN. Use only on a trusted network; do not configure internet port forwarding. Default `dev` and `start:release` remain local-only.

Hosted deployment uses separate hosted settings and build configuration. The API requires `HOSTED=true`, an exact `WEB_ORIGIN`, and an absolute `RELATIONSHIP_DB`; the hosted web build requires `NEXT_PUBLIC_HOSTED=true` and `API_UPSTREAM_URL`. Do not use the local release command to start a hosted deployment. See the [Render Phase 1 deployment plan](docs/deployment/render-phase-1.md) for deployment configuration.

Import previews accept supported Instagram-export JSON files or ZIP exports. For deterministic, synthetic-only JSON test data, run `node fixtures/generate.mjs`; generated files are written under `fixtures/instagram-export/`. Do not use private exports as fixtures.

## Export your Instagram relationships

1. In Instagram, open **Accounts Centre → Your information and permissions → Export your information → Create export**.
2. Select your Instagram profile, choose **Export to device**, then choose specific information.
3. Select **Followers and following** (or the closest matching category), **All time** if available, and **JSON** format.
4. Start the export. When ready, download it and upload the ZIP or supported JSON files on the app's Import page.

Instagram's option labels may vary. See [Meta's official export instructions](https://www.facebook.com/help/instagram/181231772500920) if you cannot find a setting. This app does not connect to Instagram. When you upload an export, its contents are sent to the configured API for processing; locally that API runs on your device. Do not upload private exports to an unauthenticated public deployment.

For hosted account and authentication operations, see the [authentication operations guide](docs/deployment/auth-phase-2-operations.md).

## Workspace

- `apps/web`: Next.js application
- `apps/api`: NestJS application
- `libs/contracts`: shared TypeScript contracts
- `libs/import-format`: Instagram export JSON/ZIP parsing
- `libs/relationship-core`: future relationship reconciliation library

API tests run with `npx nx test api`.

## Formatting

Prettier 3.8.3 formats source files in `apps/`, `libs/`, and `fixtures/generate.mjs`.
Run `npm run format` to apply formatting and `npm run format:check` to verify it.
The production build runs the formatting check before building.
