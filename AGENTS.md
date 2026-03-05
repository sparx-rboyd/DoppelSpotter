# DoppelSpotter — Architecture & Agent Notes

This file provides a concise architectural overview for AI coding agents and contributors.
Keep it up to date when making significant structural changes.

---

## Project Overview

**DoppelSpotter** is an AI-powered brand protection web app for SMEs. It monitors the web for
brand infringement (lookalike domains, fake social accounts, clone apps, trademark squatting)
using Apify actors for scraping and AI analysis for classification.

**Stack:**
- Frontend / API: Next.js 15 (App Router), TypeScript, Tailwind CSS
- Database: Google Cloud Firestore
- Scraping: Apify platform (hosted actors)
- AI analysis: OpenRouter → `anthropic/claude-3.5-haiku` (default)
- Hosting: Google Cloud Run (app) + Cloudflare Workers (landing page)
- CI/CD: GCP Cloud Build

---

## Repository Structure

```
/
├── AGENTS.md                     # This file
├── REVIEW.md                     # Ongoing scan quality review notes
├── PITCH.md                      # Product pitch / spec
├── cloudbuild.yaml               # GCP Cloud Build CI/CD pipeline
├── wrangler.toml                 # Cloudflare Workers config (landing page)
├── actors/
│   └── whoisxml-brand-alert/     # Custom Apify Actor (published to Apify Store)
├── landing-page/                 # Static marketing site
├── app/                          # Next.js 15 application
│   └── src/
│       ├── app/                  # Pages + API routes (App Router)
│       │   └── api/
│       │       ├── auth/         # login, logout, me (signup disabled — use add-user CLI)
│       │       ├── brands/       # CRUD + findings + scans per brand
│       │       ├── findings/     # Cross-brand findings query
│       │       ├── scan/         # Trigger scan + poll status
│       │       └── webhooks/apify/  # Apify webhook receiver → AI analysis pipeline
│       └── lib/
│           ├── apify/
│           │   ├── actors.ts     # ACTOR_REGISTRY — all actor definitions + enable/disable
│           │   └── client.ts     # Apify client: startActorRun, buildActorInput, fetchDatasetItems
│           └── analysis/
│               ├── prompts.ts    # SYSTEM_PROMPT + buildAnalysisPrompt()
│               ├── openrouter.ts # AI analysis client: chatCompletion()
│               └── types.ts      # AnalysisOutput interface + parseAnalysisOutput()
└── docs/
    ├── GCP_SETUP.md
    └── PIPELINE_SETUP.md
```

---

## Actor Registry

All actors are defined in `app/src/lib/apify/actors.ts` → `ACTOR_REGISTRY`.

To enable or disable an actor, set its `enabledByDefault` flag. Actors with `enabledByDefault: true`
are automatically included in every scan via `CORE_ACTOR_IDS`.

**Current state (as of scan quality review):** Only `apify/google-search-scraper` is enabled.
See `REVIEW.md` for full actor table and rationale.

---

## Scan Pipeline Flow

```
POST /api/scan
 └─ verifies ownership + checks `brands.activeScanId` inside a Firestore transaction
 └─ if the brand already has a pending/running scan, returns 409 with that scan instead of starting another
 └─ reserves the new scan by writing the scan doc + `brands.activeScanId` atomically
 └─ reads CORE_ACTOR_IDS (or actorIds from request body)
 └─ derives Google Search `maxPagesPerQuery` from `brands.googleResultsLimit` (10-100, step 10; default 10)
 └─ calls startActorRun() for each actor → registers Apify webhook
 └─ stores runId → scan document in Firestore

DELETE /api/scan?scanId=xxx
 └─ verifies ownership; returns 409 if scan is not pending/running
 └─ marks scan status → 'cancelled' in Firestore immediately
 └─ clears `brands.activeScanId` if it still points at this scan
 └─ best-effort calls abortActorRun() for every actorRunId (silently ignores already-terminal runs)
 └─ webhook handler skips callbacks for cancelled scans; markActorRunComplete is a no-op if scan is cancelled

GET /api/brands/[brandId]/active-scan
 └─ verifies ownership
 └─ resolves `brands.activeScanId` to the current pending/running scan, if any
 └─ clears stale pointers automatically if the referenced scan is missing or terminal

GET /api/brands/[brandId]/scans
 └─ returns all terminal scans (completed|cancelled|failed) ordered newest-first
 └─ computes per-scan severity counts (high/medium/low/nonHit) from findings in memory
 └─ returns ScanSummary[] — lightweight shape used by the brand page to render per-scan result sets

DELETE /api/brands/[brandId]/scans/[scanId]
 └─ verifies ownership; returns 409 if scan is pending/running
 └─ batch-deletes all findings for the scan, then deletes the scan doc

GET /api/brands/[brandId]/findings?scanId=xxx
 └─ optional scanId param filters findings to a single scan (used for lazy loading in the UI)

Apify calls POST /api/webhooks/apify (on SUCCEEDED / FAILED / ABORTED)
 └─ validates X-Apify-Webhook-Secret header
 └─ fetches up to 50 items from Apify dataset
 └─ per-item mode: one AI analysis call per dataset item → one Finding per item
 └─ batch mode (Google Search): normalize SERP pages into compact organic-result candidates
      └─ excludes ads from AI analysis; keeps `relatedQueries` + `peopleAlsoAsk` as run-level context
      └─ dedupes repeated URLs within the run before analysis
      └─ chunked AI classification: one call per bounded candidate chunk
      └─ each chunk may return grounded `suggestedSearches` based on its suspicious results + SERP context
      └─ webhook combines, dedupes, and ranks chunk suggestions
      └─ aggregate suggestion fallback reviews SERP intent signals + notable candidate outcomes when chunk suggestions are weak or absent
      └─ one Finding written per normalized URL per scan (deterministic upsert; repeated URLs merged)
      └─ isFalsePositive: true findings are stored but excluded from default API responses
 └─ (batch mode, depth 0 only) if ranked chunk/fallback suggestions are present and the brand allows deep search → triggers deep-search runs
      └─ suggestions are reserved on the originating run so duplicate callbacks do not fan out extra searches
      └─ each deep-search run is registered on the scan document (actorRunIds, actorRuns)
      └─ each deep-search Google run uses at least 3 SERP pages, even when the initial scan is configured for fewer
      └─ detailed debug logging records normalization, chunk outcomes, suggestion ranking, reservations, and deep-search launches
      └─ deep-search runs complete via the same webhook, depth 1 — no further recursion
 └─ marks actor run complete; if all runs done → marks scan complete and clears `brands.activeScanId`
```

---

## AI Analysis

- **File:** `app/src/lib/analysis/`
- **When:** After each Apify actor run completes, inside the webhook handler
- **Model:** `anthropic/claude-3.5-haiku` via OpenRouter (overridable via `OPENROUTER_MODEL`)
- **Prompts:** `SYSTEM_PROMPT` + `buildAnalysisPrompt()` for per-item mode; `GOOGLE_CLASSIFICATION_SYSTEM_PROMPT` + `buildGoogleChunkAnalysisPrompt()` for chunked Google classification and grounded deep-search suggestioning; `GOOGLE_SUGGESTION_SYSTEM_PROMPT` + `buildGoogleSuggestionPrompt()` for aggregate Google deep-search fallback suggestioning
- **Watch words:** optional per-brand terms passed to the prompt builder; AI analysis is instructed to note any presence or implied association and use its discretion on severity impact
- **Safe words:** optional per-brand terms passed to the prompt builder; AI analysis is instructed to treat results containing these terms with reduced caution unless there are strong warning signs elsewhere
- **Per-item output:** structured JSON `{ severity, title, llmAnalysis, isFalsePositive }`
- **Google chunk output:** structured JSON `{ items: [{ resultId, title, severity, analysis, isFalsePositive }], suggestedSearches? }`
- **Raw AI response** string is stored on every finding as `rawLlmResponse` for debugging
- **False positives** are written to Firestore with `isFalsePositive: true`; filtered from default API responses; visible in the brand page "Non-hits" section

### Analysis modes (`ActorConfig.analysisMode`)

Each actor in the registry declares how its dataset items should be sent to AI analysis:

| Mode | Behaviour |
|---|---|
| `'per-item'` (default) | One AI analysis call per dataset item → one Finding per item |
| `'batch'` | Run-level normalization/chunking before AI analysis → one Finding per normalized URL |

`'batch'` is used for actors whose items are pages/slices of the same query (e.g. Google Search
SERP pages), so the webhook can normalize and dedupe repeated URLs before AI analysis. Google
findings now store a compact normalized debug payload (`kind: 'google-normalized'`) with
candidate metadata, merged sightings, and SERP context instead of the full page blobs.

See `REVIEW.md` for full prompt text and AI analysis pipeline details.

### Deep search (`suggestedSearches`)

When the Google Search actor runs at depth 0 (initial scan), each chunked Google classification
call may return a `suggestedSearches` array — up to 3 grounded follow-up queries based on the
suspicious result candidates in that chunk plus its supporting `relatedQueries` / `peopleAlsoAsk`
signals. The webhook combines, dedupes, and ranks those chunk-level suggestions, then runs an
aggregate suggestion fallback over the run-level SERP intent signals plus the most notable
candidate outcomes when it needs extra coverage. This is only enabled when the brand's
`allowAiDeepSearches` setting is true.

The webhook handler calls `startDeepSearchRun()` for each suggested query, registers the new
Apify run IDs on the scan document, and processes results via the same webhook pipeline at
depth 1. Deep-search runs never produce further follow-ups (hard loop guard: `searchDepth === 0`
check before triggering). Suggested queries are reserved on the originating run before any new
Apify runs are started, so duplicate webhook callbacks do not fan out duplicate deep-search runs.
`markActorRunComplete` always reads `actorRunIds.length` from a fresh Firestore snapshot inside
its transaction, so dynamically-added runs are counted correctly for scan completion. Deep-search
runs are skipped entirely when `allowAiDeepSearches` is false for the brand. When enabled, each
deep-search Google run uses at least 3 SERP pages so low initial result limits do not starve
follow-up coverage.

`ActorRunInfo` carries `searchDepth` (0 or 1) and `searchQuery` (the literal query string for
depth-1 runs). The brand page progress indicator shows a "Deep search" badge and surfaces the
query being investigated when a depth-1 run is active.

---

## Ignored Findings

Users can manually dismiss (ignore) any non-false-positive finding at the individual card level. Ignored findings are stored in Firestore with `isIgnored: true` and `ignoredAt: Timestamp`.

**Behaviour:**
- Ignored findings are excluded from the default findings API response and from severity counts in `ScanSummary`
- They are surfaced in a collapsible "Ignored" sub-section within each scan's expanded view
- A brand-level "Ignored URLs" panel shows all ignored findings across all scans, accessible from a summary banner
- Findings can be un-ignored from either location, restoring them to their original severity bucket
- On each new scan, the webhook handler fetches all ignored URLs for the brand (Firestore query on `isIgnored == true`) and passes them to the AI analysis prompt — AI analysis is instructed to mark these as `isFalsePositive: true` if they appear in the new result set, preventing repeated re-reporting

**API:**
- `PATCH /api/brands/[brandId]/findings/[findingId]` — body `{ isIgnored: boolean }` — toggles ignored state
- `GET /api/brands/[brandId]/findings?ignoredOnly=true` — returns all ignored findings (cross-scan if no `scanId`)
- `GET /api/brands/[brandId]/findings?scanId=xxx&ignoredOnly=true` — ignored findings for a specific scan

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `APIFY_API_TOKEN` | Apify platform token |
| `APIFY_WEBHOOK_SECRET` | Shared secret for webhook validation |
| `WHOISXML_API_KEY` | WhoisXML Brand Alert API key (custom actor) |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OPENROUTER_MODEL` | AI analysis model override (default: `anthropic/claude-3.5-haiku`) |
| `AUTH_JWT_SECRET` | JWT signing secret (7-day tokens) |
| `GCP_PROJECT_ID` | Google Cloud project ID |
| `FIRESTORE_DATABASE_ID` | Firestore DB (default: `(default)`) |
| `APP_URL` | Public base URL — used to construct webhook callback URLs |
| `GOOGLE_APPLICATION_CREDENTIALS` | Local dev only: path to GCP service account JSON |

---

## Firestore Collections

| Collection | Key Fields |
|---|---|
| `users` | id, email, passwordHash, createdAt |
| `brands` | id, userId, name, keywords[], officialDomains[], **googleResultsLimit?**, **allowAiDeepSearches?**, **activeScanId?**, watchWords[]?, safeWords[]?, createdAt, updatedAt |
| `scans` | id, brandId, userId, status (`pending`\|`running`\|`completed`\|`failed`\|`cancelled`), actorIds[], actorRuns{}, completedRunCount, findingCount, **highCount, mediumCount, lowCount, nonHitCount, ignoredCount** (denormalized — written by webhook, updated on ignore/un-ignore), startedAt, completedAt |
| `findings` | id, scanId, brandId, userId, source, actorId, severity, title, description, llmAnalysis, url?, rawData, isFalsePositive?, isIgnored?, ignoredAt?, rawLlmResponse?, createdAt |

---

## User Management

Signup via the web UI and API is **disabled** during development. Use the CLI to create accounts:

```bash
# Run from the app/ directory
npm run add-user -- --email user@example.com --password secret123
```

Script: `app/scripts/add-user.ts`. Reads `.env.local` automatically (same file used by `next dev`).

To backfill denormalized severity counts onto existing scan documents (needed after adding the count fields for the first time, or to recompute from findings after manual data changes):

```bash
# Run from the app/ directory
npm run backfill-scan-counts           # only updates scans missing count fields
npm run backfill-scan-counts -- --force  # recomputes all scans from findings
```

Script: `app/scripts/backfill-scan-counts.ts`.

---

## Findings API — Performance Design

The findings API is optimised to minimise Firestore reads and HTTP round-trips on the brand page:

- **Lightweight brand list payloads** — `GET /api/brands` returns a compact `BrandSummary` shape (`id`, `name`, `keywordCount`, `officialDomainCount`, `createdAt`) rather than full `BrandProfile` documents. The brands list page only renders these summary fields.
- **Denormalized counts on scan documents** — `highCount`, `mediumCount`, `lowCount`, `nonHitCount`, `ignoredCount` are written by the webhook at scan-completion time and kept in sync by the PATCH handler on every ignore/un-ignore. The scans list endpoint (`GET /api/brands/[brandId]/scans`) reads these directly — no findings query needed.
- **Lazy-loaded findings** — the brand page fetches findings for a scan in 3 separate stages, each only triggered on demand:
  1. **Hits** — fetched when the scan row is first expanded
  2. **Non-hits** — fetched when the user first opens the "Non-hits" sub-section
  3. **Ignored** — fetched when the user first opens the "Ignored" sub-section
- **Lightweight list payloads** — the findings list endpoints (`GET /api/brands/[brandId]/findings` and `GET /api/findings`) return a compact `FindingSummary` shape via Firestore `.select(...)`, excluding `rawData`, `rawLlmResponse`, and other fields not needed for normal rendering. This avoids repeatedly shipping the full SERP batch payload on every finding card.
- **Incremental dashboard fetch** — `GET /api/findings` pages through the newest findings until it has filled the requested limit, instead of always fetching a fixed `limit * 4` window and filtering in memory. This keeps dashboard reads closer to the actual number of cards rendered.
- **Debug details fetched on demand** — `FindingCard` fetches `GET /api/brands/[brandId]/findings/[findingId]` only when a debug section is opened (`?debug=true`). Normal list views never load raw actor data or raw AI responses.
- **No redundant brand ownership checks on per-scan findings** — the `GET /api/brands/[brandId]/findings` route relies solely on `userId == uid` in the Firestore query for authorization (no extra brand doc read per request). The PATCH (ignore/un-ignore) route similarly skips the brand doc read, verifying ownership via the finding document itself.

---

## Key Docs

- [`docs/GCP_SETUP.md`](docs/GCP_SETUP.md) — GCP / Firestore / Cloud Run setup
- [`docs/PIPELINE_SETUP.md`](docs/PIPELINE_SETUP.md) — Apify, OpenRouter, ngrok, env vars
- [`REVIEW.md`](REVIEW.md) — Ongoing scan quality review: actor details and AI analysis prompts
