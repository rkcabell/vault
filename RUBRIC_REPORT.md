# Repository Rubric Report

## A. Executive Summary
Overall score: 1.45/4.00 (fail). Blockers present; pass criteria not met (overall < 3.0 and categories below 2.5).
Primary blockers: missing repo-wide lint/format enforcement and CI, missing setup path and env templates, missing frontend error boundary and backend error middleware.
Focus next: establish tooling/CI and setup docs, then split oversized modules and enforce naming consistency.

## B. Scorecard
| Category | Score (0-4) |
| --- | --- |
| A. Cleanliness and readability | 1 |
| B. File structure | 1 |
| C. Naming conventions | 2 |
| D. Modularity | 2 |
| E. Environment and operational readiness | 1 |
| Overall (weighted) | 1.45 |

Top 3 strengths:
1. Strong request validation in the API using Zod schemas in route handlers.
2. Worker logic is partially injectable (`processOcrJob`, `processThumb`) with unit tests in `apps/api/src/tests`.
3. Web app already uses path aliases (`@/`) to reduce deep relative imports.

Top 3 weaknesses:
1. Lint/format tooling is not enforced repo-wide and CI workflows are empty.
2. Setup instructions and env templates are missing, blocking reproducible onboarding.
3. Several files exceed 300 LOC and combine multiple responsibilities.

What to do next: Implement repo-wide lint/format and CI checks, add setup/env templates, then refactor oversized modules into services and hooks.

## C. Findings (by category)

### A. Cleanliness and readability
- Severity: BLOCKER | Location: `.editorconfig` (missing); `.github/workflows/ci.yml` (empty); `apps/api/.prettierrc` | Evidence: no `.editorconfig` in repo, workflows are 0 bytes, formatting config only exists in `apps/api/.prettierrc` while web uses default linting | Impact: formatting drift and no enforcement across packages | Fix: Add root `.editorconfig`, add shared Prettier config, and add CI steps that run `npm ci`, `npm run lint`, and `npm run format:check`; verify with `Test-Path .editorconfig`, `npm run lint`, `npm run format:check`, and CI job success.
- Severity: MAJOR | Location: `apps/api/src/lib/pdf/renderPdfThumbnail.ts:3` | Evidence: `pdfjsPromise` is declared and `loadPdfJs` is commented out, but `loadPdfJs()` is called at `apps/api/src/lib/pdf/renderPdfThumbnail.ts:37` | Impact: dead code and potential runtime error that obscures PDF rendering behavior | Fix: Restore `loadPdfJs` or replace it with an inline dynamic import, and remove unused state; verify with `npm -w api run typecheck`.
- Severity: MAJOR | Location: `apps/api/src/worker/ocrWorker.ts:20`; `apps/api/src/worker/index.ts:66`; `apps/web/app/(protected)/overview/OverviewPageInner.tsx:595` | Evidence: multiple `console.log`/`console.error` in production paths | Impact: unstructured logs and noisy output that are hard to filter and may leak data | Fix: Replace console calls with structured logger usage (Fastify `app.log` or injected logger) and remove UI console logging; verify with `rg -n "console\.(log|warn|error)" apps` returning only tests/scripts.
- Severity: BLOCKER | Location: `apps/web/app/error.tsx` (missing); `apps/api/src/index.ts` (no error middleware); `apps/api/src/plugins/config.ts:31` | Evidence: no Next.js error boundary file, no `setErrorHandler` usage in API, and raw `throw new Error` | Impact: inconsistent error surfaces and untyped errors in app layers | Fix: Add Fastify error handler with typed error mapping, add `apps/web/app/error.tsx`, and replace raw throws with typed errors; verify with `rg -n "setErrorHandler" apps/api/src/index.ts`, `Test-Path apps/web/app/error.tsx`, and `rg -n "throw new Error" apps` only in tests.
- Severity: MAJOR | Location: `apps/api/src/lib/pdf/renderPdfThumbnail.ts:27` | Evidence: exported function has no docblock and there is no test under `apps/api/src/tests` for PDF thumbnail rendering | Impact: unclear contract and fragile changes for complex logic | Fix: Add a docblock describing purpose/inputs/outputs/failures and add a unit test; verify with `Test-Path apps/api/src/tests/api/lib/renderPdfThumbnail.test.ts` and `rg -n "^/\*\*" apps/api/src/lib/pdf/renderPdfThumbnail.ts`.

### B. File structure
- Severity: MAJOR | Location: `apps/api/src`; `apps/web/app`; `packages/db/src`; `apps/web/tests` (empty) | Evidence: packages use different layouts (API uses `src/tests`, web uses `app/components/lib`, db has no tests), and `apps/web/tests` has no files | Impact: inconsistent navigation and unclear conventions across packages | Fix: Define a standard layout per package type and align directories (e.g., move web non-Next code under `apps/web/src`, add tests folders where applicable); verify with a documented layout section in `README.md` and `Test-Path apps/web/src`.
- Severity: MAJOR | Location: `apps/api/src/routes/media.ts:3`; `apps/api/src/routes/media.ts:106`; `apps/web/app/(protected)/overview/OverviewPageInner.tsx` | Evidence: routes import queue and S3 SDKs and use `app.prisma`, and the overview page performs data fetching and mutation directly in the UI component | Impact: mixed concerns reduce testability and make modules harder to reason about | Fix: Extract media service/repository modules in API and move list/mutation logic into dedicated hooks in web; verify with `rg -n "new Queue|PutObjectCommand|app\.prisma" apps/api/src/routes/media.ts` returning none and `rg -n "fetch\(\"/api/media" apps/web/app/(protected)/overview/OverviewPageInner.tsx` moving into hooks.
- Severity: MAJOR | Location: `apps/api/src/tests/api/worker/ocrWorker.test.ts:6`; `apps/api/src/tests/api/worker/thumbWorker.test.ts:8` | Evidence: deep relative imports (`../../../`) and no path alias defined in `apps/api/tsconfig.json` | Impact: brittle refactors and low discoverability | Fix: Add `baseUrl` and `paths` to `apps/api/tsconfig.json` and update imports to `@/` paths; verify with `rg -n "\.\.\/\.\.\/\.\.\/" apps/api/src` returning none.
- Severity: MAJOR | Location: `apps/web/components/ui` | Evidence: folder contains 11 files and no `index.ts` or `README.md` | Impact: low discoverability and scattered imports | Fix: Add a barrel file or README; verify with `Test-Path apps/web/components/ui/index.ts` or `Test-Path apps/web/components/ui/README.md`.

### C. Naming conventions
- Severity: MAJOR | Location: `apps/web/components/ui/Dropdown-Menu.tsx`; `apps/web/components/ui/Scroll-Area.tsx`; `apps/web/components/ui/logout_button.tsx`; `apps/web/lib/api.client.ts` | Evidence: mixed PascalCase-with-dashes, snake_case, and dot-naming in files | Impact: inconsistent naming harms searchability and predictability | Fix: Rename component files to PascalCase (`DropdownMenu.tsx`, `ScrollArea.tsx`, `LogoutButton.tsx`) and non-components to kebab-case (`api-client.ts`), updating imports; verify with `rg -n "Dropdown-Menu|Scroll-Area|logout_button|api\.client" apps/web` returning none.
- Severity: MINOR | Location: `apps/api/src/index.ts:59`; `apps/api/src/worker/thumbWorker.ts:150` | Evidence: boolean variables `shuttingDown` and `exists` lack is/has/should prefixes | Impact: boolean intent is less clear during reviews | Fix: Rename to `isShuttingDown` and `sourceExists`; verify with `rg -n "\bshuttingDown\b" apps/api/src` and `rg -n "const exists = await waitUntilSourceExists" apps/api/src/worker/thumbWorker.ts` returning none.
- Severity: MAJOR | Location: `apps/api/src/routes/media.ts:110`; `apps/api/src/routes/media.ts:361` | Evidence: mixed vocabulary (`thumbState`, `thumbnailKey`, `computeThumbKey`) with no glossary in `README.md` | Impact: inconsistent domain language and onboarding confusion | Fix: Choose a single term (e.g., "thumbnail") and rename fields/functions, then add a glossary section in docs; verify with `rg -n "thumb" apps/api/src` showing only the chosen term and `rg -n "Glossary" README.md`.

### D. Modularity
- Severity: MAJOR | Location: `apps/api/src/routes/media.ts:3`; `apps/api/src/routes/media.ts:106` | Evidence: routes directly instantiate queues and use S3/Prisma clients | Impact: layers are not recognizable and dependencies flow outward | Fix: Move queue/storage/data logic into service and repository layers and keep routes thin; verify with `rg -n "new Queue|PutObjectCommand|app\.prisma" apps/api/src/routes/media.ts` returning none.
- Severity: MAJOR | Location: `apps/api/src/routes/media.ts` (615 LOC); `apps/web/app/(protected)/overview/OverviewPageInner.tsx` (628 LOC) | Evidence: module sizes exceed 300 LOC | Impact: low cohesion and harder testing | Fix: Split each file into smaller modules and hooks to keep files under 300 LOC; verify with `Get-Content apps/api/src/routes/media.ts | Measure-Object -Line` and `Get-Content apps/web/app/(protected)/overview/OverviewPageInner.tsx | Measure-Object -Line` returning <= 300.
- Severity: MAJOR | Location: `apps/api/src/worker/ocrWorker.ts:36`; `apps/api/src/worker/thumbWorker.ts:86` | Evidence: duplicated `waitUntilSourceExists` implementations | Impact: copy/paste drift and inconsistent behavior | Fix: Extract a shared helper (e.g., `apps/api/src/lib/s3/waitUntilObjectExists.ts`) and import it from both workers; verify with `rg -n "waitUntilSourceExists" apps/api/src/worker` showing a single definition.
- Severity: MAJOR | Location: `apps/api/src/routes/media.ts`; `apps/api/src/tests/api/worker/ocrWorker.test.ts` | Evidence: side effects are not abstracted behind interfaces and tests monkeypatch real clients | Impact: unit tests are brittle and hard to isolate | Fix: Define interfaces for S3/DB/queue and inject mocks in tests instead of monkeypatching; verify with `npm run test:api` running without network/DB access.

### E. Environment and operational readiness
- Severity: BLOCKER | Location: `README.md`; `docs/runbook/local-dev.md` (empty); `.env.example` (missing) | Evidence: no canonical setup commands and no env template in repo root or apps | Impact: onboarding is not reproducible | Fix: Add a setup section to `README.md` with exact commands and create `.env.example` files for root and packages; verify with `rg -n "Setup" README.md` and `Test-Path .env.example`.
- Severity: BLOCKER | Location: `package.json`; `.github/workflows/ci.yml` (empty) | Evidence: root scripts lack `dev`, `test`, `typecheck`, and `format`, and CI workflows are empty | Impact: no consistent automation for build quality | Fix: Add workspace scripts (`dev`, `test`, `typecheck`, `format`, `format:check`) and CI to run install/lint/typecheck/test/build; verify with `npm run dev`, `npm run test`, `npm run typecheck`, `npm run format:check`, and CI job success.
- Severity: MAJOR | Location: `infra/docker/docker-compose.yml`; `apps/web/lib/auth.ts:4`; `apps/web/next.config.mjs:8` | Evidence: local credentials are hardcoded and defaults use fixed URLs without documented envs; no secret scanning config in repo | Impact: unsafe defaults and missed secrets hygiene | Fix: Move credentials/URLs to env vars with `.env.example`, add secret scanning config (e.g., `.gitleaks.toml`), and document required vars; verify with `rg -n "vault|localhost|127\.0\.0\.1" infra/docker/docker-compose.yml apps/web/lib/auth.ts apps/web/next.config.mjs` only showing env lookups and `Test-Path .gitleaks.toml`.
- Severity: MAJOR | Location: `infra/docker/docker-compose.yml` | Evidence: services have no healthchecks and ports are undocumented in README | Impact: unreliable local infra startup and unclear port mapping | Fix: Add healthchecks and document ports in README; verify with `rg -n "healthcheck" infra/docker/docker-compose.yml` and `rg -n "Ports" README.md`.

## D. Required Fix List (ranked)
1. Owner: repo-wide | Affected paths: `.editorconfig`, `prettier.config.cjs` (or `.prettierrc`), `apps/api/eslint.config.js`, `apps/web/package.json`, `.github/workflows/ci.yml` | Acceptance criteria: `npm run lint` and `npm run format:check` succeed locally and CI runs lint/format/typecheck/test/build.
2. Owner: repo-wide | Affected paths: `README.md`, `docs/runbook/local-dev.md`, `.env.example`, `apps/api/.env.example`, `apps/web/.env.example` | Acceptance criteria: setup section exists with exact commands, env templates exist, and `Test-Path .env.example` returns true.
3. Owner: backend | Affected paths: `apps/api/src/index.ts`, `apps/api/src/lib/errors.ts`, `apps/api/src/plugins/config.ts` | Acceptance criteria: `rg -n "setErrorHandler" apps/api/src/index.ts` finds a handler and `rg -n "throw new Error" apps/api/src` returns only tests.
4. Owner: frontend | Affected paths: `apps/web/app/error.tsx`, `apps/web/app/(protected)/overview/OverviewPageInner.tsx`, `apps/web/hooks` | Acceptance criteria: `Test-Path apps/web/app/error.tsx` is true and overview logic is split into hooks/components with file length <= 300 LOC.
5. Owner: backend | Affected paths: `apps/api/src/routes/media.ts`, `apps/api/src/services/*`, `apps/api/src/repositories/*` | Acceptance criteria: `rg -n "new Queue|PutObjectCommand|app\.prisma" apps/api/src/routes/media.ts` returns none and service modules are used.
6. Owner: backend | Affected paths: `apps/api/tsconfig.json`, `apps/api/src/tests/**` | Acceptance criteria: `rg -n "\.\.\/\.\.\/\.\.\/" apps/api/src` returns none and tests compile.
7. Owner: shared | Affected paths: `apps/web/components/ui/*`, `apps/web/lib/*`, `README.md` | Acceptance criteria: `rg -n "Dropdown-Menu|Scroll-Area|logout_button|api\.client" apps/web` returns none and README has a Glossary section.

## E. Repo Map (tree + commentary)
```
.
|-- .github/
|   |-- README.md
|   `-- workflows/
|       |-- api-integration.yml
|       |-- ci.yml
|       |-- docker-publish.yml
|       `-- e2e.yml
|-- .vscode/
|   `-- settings.json
|-- apps/
|   |-- api/
|   |   |-- src/
|   |   |   |-- index.ts
|   |   |   |-- lib/
|   |   |   |   |-- pdf/
|   |   |   |   |   |-- extractPdfText.ts
|   |   |   |   |   |-- renderPdfThumbnail.ts
|   |   |   |   |   `-- shouldFallbackToOcr.ts
|   |   |   |   |-- s3/
|   |   |   |   |   `-- getObjectBuffer.ts
|   |   |   |   `-- text/
|   |   |   |       `-- processTextJob.ts
|   |   |   |-- plugins/
|   |   |   |   |-- config.ts
|   |   |   |   |-- jwt.ts
|   |   |   |   |-- prisma.ts
|   |   |   |   |-- rateLimit.ts
|   |   |   |   |-- redis.ts
|   |   |   |   |-- s3.ts
|   |   |   |   `-- s3Client.ts
|   |   |   |-- queues/
|   |   |   |   `-- enqueueThumbnail.ts
|   |   |   |-- routes/
|   |   |   |   |-- auth.ts
|   |   |   |   |-- health.ts
|   |   |   |   |-- media.ts
|   |   |   |   `-- profile.ts
|   |   |   |-- tests/
|   |   |   |   `-- api/
|   |   |   |       |-- lib/
|   |   |   |       |   |-- extractPdfText.test.ts
|   |   |   |       |   |-- getObjectBuffer.test.ts
|   |   |   |       |   `-- processTextJob.test.ts
|   |   |   |       `-- worker/
|   |   |   |           |-- ocrWorker.test.ts
|   |   |   |           `-- thumbWorker.test.ts
|   |   |   |-- utils/
|   |   |   |   `-- authGuard.ts
|   |   |   `-- worker/
|   |   |       |-- index.ts
|   |   |       |-- ocrWorker.ts
|   |   |       `-- thumbWorker.ts
|   |   |-- .env
|   |   |-- .prettierrc
|   |   |-- eslint.config.js
|   |   |-- package.json
|   |   `-- tsconfig.json
|   `-- web/
|       |-- .next/
|       |-- app/
|       |   |-- (protected)/
|       |   |   |-- albums/
|       |   |   |-- entities/
|       |   |   |-- media/
|       |   |   |-- overview/
|       |   |   |-- profile/
|       |   |   |-- reminders/
|       |   |   |-- tags/
|       |   |   |-- upload/
|       |   |   `-- layout.tsx
|       |   |-- (public)/
|       |   |   |-- auth/
|       |   |   |-- shared/
|       |   |   `-- layout.tsx
|       |   |-- api/
|       |   |   |-- auth/
|       |   |   `-- media/
|       |   |-- thumbnails/
|       |   |   `-- fallback/
|       |   |-- layout.tsx
|       |   |-- not-found.tsx
|       |   `-- page.tsx
|       |-- components/
|       |   |-- common/
|       |   |-- contexts/
|       |   |-- explorer/
|       |   |-- media/
|       |   |-- ui/
|       |   |-- providers.tsx
|       |   `-- theme-toggle.tsx
|       |-- hooks/
|       |   `-- media/
|       |-- lib/
|       |   |-- api.client.ts
|       |   |-- api.server.ts
|       |   |-- auth.ts
|       |   |-- media/
|       |   |-- useQuery.ts
|       |   `-- utils.ts
|       |-- node_modules/
|       |-- styles/
|       |   `-- globals.css
|       |-- tests/
|       |-- middleware.ts
|       |-- next.config.mjs
|       |-- package.json
|       `-- tsconfig.json
|-- docs/
|   |-- adr/
|   |-- api/
|   |-- runbook/
|   `-- security/
|-- infra/
|   |-- docker/
|   |-- k6/
|   `-- meilisearch/
|-- packages/
|   `-- db/
|       |-- src/
|       |   `-- index.ts
|       |-- package.json
|       `-- tsconfig.json
|-- scripts/
|   `-- smoke-enqueue-thumb.ts
|-- tools/
|   `-- Make.ps1
|-- workers/
|   |-- node-jobs/
|   `-- py-ocr/
|-- node_modules/
|-- test-results/
|-- .env
|-- package.json
`-- README.md
```

Commentary:
- `.github/`: GitHub metadata and workflows (currently placeholder/empty workflows).
- `.vscode/`: Editor settings.
- `apps/`: Application packages (`api` backend and `web` frontend).
- `docs/`: ADRs, security docs, and runbooks (local-dev doc is empty).
- `infra/`: Local infrastructure and load-test assets (Docker, k6, Meilisearch).
- `packages/`: Shared code (`db` Prisma client).
- `scripts/`: One-off scripts and smoke tests.
- `tools/`: Developer tooling scripts.
- `workers/`: Background worker services (Node and Python).
- `node_modules/`, `apps/web/node_modules/`, `apps/web/.next/`, `test-results/`: Local artifacts that should remain untracked.

## F. Examples (before/after snippets)

Example 1 - Structured logging in workers
Before:
```ts
console.log(`[worker] ocr job start mediaId=${mediaId} forceOcr=${Boolean(forceOcr)}`);
```
After:
```ts
logger.info({ mediaId, forceOcr: Boolean(forceOcr) }, "worker.ocr.start");
```

Example 2 - Typed error instead of raw Error
Before:
```ts
if (!parsed.success) {
  app.log.error(parsed.error.format(), "Invalid environment configuration");
  throw new Error("Invalid environment configuration");
}
```
After:
```ts
if (!parsed.success) {
  app.log.error(parsed.error.format(), "Invalid environment configuration");
  throw new AppError("CONFIG_INVALID", "Invalid environment configuration");
}
```

Example 3 - Replace deep relative imports with aliases
Before:
```ts
import { processOcrJob } from "../../../worker/ocrWorker.js";
```
After:
```ts
import { processOcrJob } from "@/worker/ocrWorker.js";
```

Example 4 - Docblock for a public function
Before:
```ts
export async function renderPdfThumbnail(args: { pdf: Uint8Array | Buffer }): Promise<Buffer> {
```
After:
```ts
/**
 * Render the first page of a PDF to a PNG buffer.
 * Inputs: pdf bytes, target width/limits.
 * Output: PNG buffer.
 * Throws: PdfRenderError on parse or render failure.
 */
export async function renderPdfThumbnail(args: { pdf: Uint8Array | Buffer }): Promise<Buffer> {
```

Example 5 - Boolean naming clarity
Before:
```ts
let shuttingDown = false;
```
After:
```ts
let isShuttingDown = false;
```

Example 6 - Component file naming consistency
Before:
```ts
import { DropdownMenu } from "@/components/ui/Dropdown-Menu";
```
After:
```ts
import { DropdownMenu } from "@/components/ui/DropdownMenu";
```

Next Commit Plan: Add repo-wide EditorConfig, shared Prettier/ESLint configs, and CI lint/format/typecheck/test/build jobs. Add a setup section with exact commands and create `.env.example` files for root, api, and web. Introduce typed errors with a Fastify error handler and a Next.js `app/error.tsx` boundary. Split the media route and overview page into services/hooks and keep files under 300 LOC. Standardize naming and domain vocabulary, add a glossary, and add a `components/ui` barrel.
