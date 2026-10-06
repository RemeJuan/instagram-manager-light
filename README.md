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

The command serves the Next.js app at `http://localhost:3000` and API at `http://127.0.0.1:3001`. API binds to loopback only. SQLite database defaults to `data/relationships.sqlite` (ignored by git); set `RELATIONSHIP_DB` to override its path. Use `npm run build` to build both applications for production. Start the production API with `node dist/apps/api/main.js` from workspace root.

Import previews accept supported Instagram-export JSON files or ZIP exports. For deterministic, synthetic-only JSON test data, run `node fixtures/generate.mjs`; generated files are written under `fixtures/instagram-export/`. Do not use private exports as fixtures.

## Export your Instagram relationships

1. In Instagram, open **Accounts Centre → Your information and permissions → Export your information → Create export**.
2. Select your Instagram profile, choose **Export to device**, then choose specific information.
3. Select **Followers and following** (or the closest matching category), **All time** if available, and **JSON** format.
4. Start the export. When ready, download it and upload the ZIP or supported JSON files on the app's Import page.

Instagram's option labels may vary. See [Meta's official export instructions](https://www.facebook.com/help/instagram/181231772500920) if you cannot find a setting. Your export stays on your device; this app does not connect to Instagram.

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
