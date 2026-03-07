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
│       │       ├── internal/     # Internal service-to-service routes (scheduled scan dispatch)
│       │       ├── scan/         # Trigger scan + poll status
│       │       └── webhooks/apify/  # Apify webhook receiver → AI analysis pipeline
│       └── lib/
│           ├── apify/
│           │   ├── actors.ts     # ACTOR_REGISTRY — all actor definitions + enable/disable
│           │   └── client.ts     # Apify client: startActorRun, buildActorInput, fetchDatasetItems
│           ├── mailersend.ts     # MailerSend email client for transactional scan-summary emails
│           ├── scan-runner.ts    # Shared manual + scheduled scan reservation and actor startup
│           ├── scan-summary-emails.ts # Branded scan-summary email composition + idempotent delivery
│           ├── scan-schedules.ts # Schedule validation, timezone-aware recurrence, next-run helpers
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
Brand add/edit pages
 └─ persist `brands.sendScanSummaryEmails` to opt the brand into post-scan summary emails
 └─ persist `brands.scanSchedule` with `enabled`, `frequency`, `timeZone`, `startAt`, and `nextRunAt`
 └─ scheduling is anchored from the chosen local start date/time and stored timezone

POST /api/internal/scheduled-scans/dispatch
 └─ validates a Google-signed OIDC bearer token from Cloud Scheduler
 └─ checks both the token audience (dispatch URL) and the caller email against `SCHEDULE_DISPATCH_SERVICE_ACCOUNT_EMAIL`
 └─ runs from Cloud Scheduler on a fixed cadence (recommended: every minute)
 └─ queries due brands by `scanSchedule.enabled == true` and `scanSchedule.nextRunAt <= now`
 └─ reuses the shared scan runner to reserve the new scan and advance `nextRunAt` atomically
 └─ if the brand already has a pending/running/summarising scan, skips that occurrence and advances `nextRunAt` to the next future slot

POST /api/scan
 └─ verifies ownership, then delegates to the shared scan runner
 └─ checks `brands.activeScanId` inside a Firestore transaction
 └─ if the brand already has a pending/running scan, returns 409 with that scan instead of starting another
 └─ reserves the new scan by writing the scan doc + `brands.activeScanId` atomically
 └─ reads CORE_ACTOR_IDS (or actorIds from request body)
 └─ uses a fixed Google Search `maxPagesPerQuery` of 3 for the initial search pass
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
 └─ recovers stale `pending` scans that never started any actor runs
 └─ clears stale pointers automatically if the referenced scan is missing or terminal

GET /api/brands/[brandId]/scans
 └─ returns all terminal scans (completed|cancelled|failed) ordered newest-first
 └─ returns denormalized per-scan counts (high/medium/low/nonHit/ignored/skipped) plus `aiSummary` from the scan document
 └─ returns ScanSummary[] — lightweight shape used by the brand page to render per-scan result sets

DELETE /api/brands/[brandId]/scans/[scanId]
 └─ verifies ownership; returns 409 if scan is pending/running
 └─ batch-deletes all findings for the scan, then deletes the scan doc

GET /api/brands/[brandId]/findings?scanId=xxx
 └─ optional scanId param filters findings to a single scan (used for lazy loading in the UI)

Apify calls POST /api/webhooks/apify (on SUCCEEDED / FAILED / ABORTED)
 └─ validates X-Apify-Webhook-Secret header
 └─ on SUCCEEDED, atomically claims the actor run by transitioning it to `fetching_dataset` before any dataset fetch / AI analysis begins
 └─ duplicate callbacks for a run already in `fetching_dataset` / `analysing` are acknowledged and skipped before expensive work starts
 └─ fetches up to 50 items from Apify dataset
 └─ per-item mode: one AI analysis call per dataset item → one Finding per item
 └─ batch mode (Google Search): normalize SERP pages into compact organic-result candidates
      └─ excludes ads from AI analysis; keeps `relatedQueries` + `peopleAlsoAsk` as run-level context
      └─ dedupes repeated URLs within the run before analysis
      └─ skips normalized URLs that already appeared in previous scans for the same brand before any LLM analysis
      └─ chunked AI classification: bounded concurrent chunk calls (deterministically merged in chunk order)
      └─ in the default `llm-final` mode, chunk calls do classification only — they do not propose deep-search queries
      └─ the webhook collects the full deduped run-level `relatedQueries` + `peopleAlsoAsk` text signals (not URLs) and passes them to the final deep-search chooser without truncating them
      └─ final deep-search selection defaults to a dedicated LLM pass that sees the full run-level intent signals and synthesizes follow-up queries directly; prompts inject the brand's allowed deep-search count and steer the model away from narrow named-site/platform/resource queries unless they are materially distinct abuse vectors
      └─ one Finding written per normalized URL per scan (deterministic upsert; repeated URLs merged)
      └─ isFalsePositive: true findings are stored but excluded from default API responses
 └─ (batch mode, depth 0 only) if ranked chunk/fallback suggestions are present and the brand allows deep search → triggers deep-search runs
      └─ suggestions are reserved on the originating run so duplicate callbacks do not fan out extra searches
      └─ each deep-search run is registered on the scan document (actorRunIds, actorRuns)
      └─ each deep-search Google run uses at least 3 SERP pages, even when the initial scan is configured for fewer
      └─ `actorRuns.*.analysedCount` increments as chunks finish so the UI can show meaningful `X / N` AI-analysis progress
      └─ `actorRuns.*.skippedDuplicateCount` tracks how many previous-scan duplicate URLs were filtered out for progress UI + scan summaries
      └─ unexpected processing errors after partial finding writes reconcile scan counts from persisted findings, mark the affected run terminal, and let the scan complete normally when useful results already exist
      └─ deep-search runs complete via the same webhook, depth 1 — no further recursion
 └─ marks actor run complete; if all runs done → marks scan complete and clears `brands.activeScanId`
      └─ completed scans pass through a short `summarising` state first
      └─ once all actor-run findings are written, the webhook loads the scan's high/medium/low findings and asks the LLM for a succinct scan-level summary focused on recurring themes and worrying trends
      └─ the final `scans.aiSummary` string is persisted on the scan document, then the scan flips to `completed` and clears `brands.activeScanId`
      └─ after the scan is durably `completed`, `sendCompletedScanSummaryEmailIfNeeded()` may send a MailerSend summary email to `users.email` when `brands.sendScanSummaryEmails == true`
      └─ email delivery is claimed on the scan document first (`scanSummaryEmailStatus == 'sending'`) so the normal webhook path and stale-summary recovery path cannot double-send
      └─ `summaryStartedAt` marks when the final summary phase began; if a scan stays in `summarising` too long, polling routes will recover it with a deterministic fallback summary so the UI does not remain stuck indefinitely
      └─ recovered `summarising` scans call the same email helper after fallback completion, so email behaviour matches the normal completion path
```

---

## AI Analysis

- **File:** `app/src/lib/analysis/`
- **When:** After each Apify actor run completes, inside the webhook handler
- **Model:** `anthropic/claude-3.5-haiku` via OpenRouter (overridable via `OPENROUTER_MODEL`)
- **Prompts:** `SYSTEM_PROMPT` + `buildAnalysisPrompt()` for per-item mode; `GOOGLE_CLASSIFICATION_SYSTEM_PROMPT` + `buildGoogleChunkAnalysisPrompt()` for chunked Google classification; `buildGoogleFinalSelectionSystemPrompt()` + `buildGoogleFinalSelectionPrompt()` for the final deep-search query chooser
- **Scan-level summary:** after all actor runs finish, the webhook runs one final LLM pass over the scan's actionable findings and stores a concise `aiSummary` on the scan document for the brand page
- **Watch words:** optional per-brand terms passed to the prompt builder; AI analysis is instructed to note any presence or implied association and use its discretion on severity impact
- **Safe words:** optional per-brand terms passed to the prompt builder; AI analysis is instructed to treat results containing these terms with reduced caution unless there are strong warning signs elsewhere
- **Per-item output:** structured JSON `{ severity, title, llmAnalysis, isFalsePositive }`
- **Google chunk output:** structured JSON `{ items: [{ resultId, title, severity, analysis, isFalsePositive }] }`
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
Normalized Google URLs that already appeared in previous scans for the same brand are filtered out
before chunking, so repeat results do not trigger new LLM calls.

See `REVIEW.md` for full prompt text and AI analysis pipeline details.

### Deep search (`suggestedSearches`)

When the Google Search actor runs at depth 0 (initial scan), the webhook collects the full
deduped run-level `relatedQueries` and `peopleAlsoAsk` text signals from every SERP page.
Chunked Google classification assesses candidates only; it does not propose deep-search queries.
The final deep-search chooser then sees that run-level intent context directly and synthesizes up
to the brand's configured `maxAiDeepSearches` follow-up Google queries (1-10). Deep-search
prompts treat that configured count as a hard cap rather than a target, and steer the model
towards broader theme-led queries instead of narrow named websites, platforms, resources, books,
or tools unless a named target is itself the key abuse vector. Deep search is only enabled when
the brand's `allowAiDeepSearches` setting is true.

The webhook handler calls `startDeepSearchRun()` for each suggested query, registers the new
Apify run IDs on the scan document, and processes results via the same webhook pipeline at
depth 1. Deep-search runs never produce further follow-ups (hard loop guard: `searchDepth === 0`
check before triggering). Suggested queries are reserved on the originating run before any new
Apify runs are started, so duplicate webhook callbacks do not fan out duplicate deep-search runs.
`markActorRunComplete` always reads `actorRunIds.length` from a fresh Firestore snapshot inside
its transaction, so dynamically-added runs are counted correctly for scan completion. Deep-search
runs are skipped entirely when `allowAiDeepSearches` is false for the brand. When enabled, every
deep-search Google run uses a fixed 2-page SERP budget, while the initial Google scan always uses
a fixed 3-page SERP budget.

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

## Bookmarked Findings

Users can bookmark any finding they want to follow up on, including AI-classified non-hits. Bookmark state is stored directly on the finding document with `isBookmarked`, `bookmarkedAt`, and optional `bookmarkNote`.

**Behaviour:**
- Bookmarks are per finding document, not URL-scoped like ignore/un-ignore
- Bookmark notes are optional and can be added, edited, or deleted after bookmarking
- The brand page loads a cross-scan "Bookmarked findings" panel above the scan result sets; it is hidden when empty and collapsed by default
- The bookmark panel groups bookmarked items into `high`, `medium`, `low`, and `Non-hits`, while still showing any existing ignored/non-hit badges on the cards themselves
- Users can unbookmark findings both from their original location and from the bookmark panel
- Because bookmark state lives on the finding document, deleting a scan automatically removes any bookmarks attached to findings from that scan

**API:**
- `PATCH /api/brands/[brandId]/findings/[findingId]` — body may include `{ isBookmarked: boolean, bookmarkNote?: string | null }`
- `GET /api/brands/[brandId]/findings?bookmarkedOnly=true` — returns bookmarked findings across all scans for the brand

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `APIFY_API_TOKEN` | Apify platform token |
| `APIFY_WEBHOOK_SECRET` | Shared secret for webhook validation |
| `WHOISXML_API_KEY` | WhoisXML Brand Alert API key (custom actor) |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OPENROUTER_MODEL` | AI analysis model override (default: `anthropic/claude-3.5-haiku`) |
| `MAILERSEND_API_TOKEN` | MailerSend API token used to send branded scan-summary emails |
| `AUTH_JWT_SECRET` | JWT signing secret (7-day tokens) |
| `SCHEDULE_DISPATCH_SERVICE_ACCOUNT_EMAIL` | Email of the dedicated Cloud Scheduler service account allowed to call the internal scheduled-scan dispatch route |
| `GCP_PROJECT_ID` | Google Cloud project ID |
| `FIRESTORE_DATABASE_ID` | Firestore DB (default: `(default)`) |
| `APP_URL` | Public base URL — used to construct webhook callback URLs |
| `GOOGLE_APPLICATION_CREDENTIALS` | Local dev only: path to GCP service account JSON |

---

## Firestore Collections

| Collection | Key Fields |
|---|---|
| `users` | id, email, passwordHash, createdAt |
| `brands` | id, userId, name, keywords[], officialDomains[], **sendScanSummaryEmails?**, **allowAiDeepSearches?**, **maxAiDeepSearches?**, **activeScanId?**, watchWords[]?, safeWords[]?, **scanSchedule?** (`enabled`, `frequency`, `timeZone`, `startAt`, `nextRunAt`, `lastTriggeredAt?`, `lastScheduledScanId?`), createdAt, updatedAt |
| `scans` | id, brandId, userId, status (`pending`\|`running`\|`summarising`\|`completed`\|`failed`\|`cancelled`), actorIds[], actorRuns{} (`itemCount?`, `analysedCount?`, `skippedDuplicateCount?`, `searchDepth?`, `searchQuery?`), completedRunCount, findingCount, **highCount, mediumCount, lowCount, nonHitCount, ignoredCount, skippedCount, aiSummary?, summaryStartedAt?**, **scanSummaryEmailStatus?**, **scanSummaryEmailAttemptedAt?**, **scanSummaryEmailSentAt?**, **scanSummaryEmailMessageId?**, **scanSummaryEmailError?** (denormalized completion + notification metadata), startedAt, completedAt |
| `findings` | id, scanId, brandId, userId, source, actorId, severity, title, description, llmAnalysis, url?, rawData, isFalsePositive?, isIgnored?, ignoredAt?, **isBookmarked?**, **bookmarkedAt?**, **bookmarkNote?**, rawLlmResponse?, createdAt |

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

- **Brand list scan summaries** — `GET /api/brands` returns a compact `BrandSummary` shape (`id`, `name`, `scanCount`, `findingCount`, `nonHitCount`, `isScanInProgress`, `lastScanStartedAt?`, `createdAt`). The list route aggregates counts from terminal scan documents using the same denormalized per-scan fields that power the brand detail page totals, and also exposes whether any scan is currently pending/running/summarising plus the latest scan start time for list-card status text, without querying findings.
- **Denormalized counts on scan documents** — `highCount`, `mediumCount`, `lowCount`, `nonHitCount`, `ignoredCount` are written by the webhook at scan-completion time and kept in sync by the PATCH handler on every ignore/un-ignore. The scans list endpoint (`GET /api/brands/[brandId]/scans`) reads these directly — no findings query needed.
- **Lazy-loaded findings** — the brand page fetches findings for a scan in 3 separate stages, each only triggered on demand:
  1. **Hits** — fetched when the scan row is first expanded
  2. **Non-hits** — fetched when the user first opens the "Non-hits" sub-section
  3. **Ignored** — fetched when the user first opens the "Ignored" sub-section
- **Eager cross-scan bookmark fetch** — the brand page separately loads `GET /api/brands/[brandId]/findings?bookmarkedOnly=true` on mount so the bookmark follow-up panel is immediately available without expanding individual scans
- **Lightweight list payloads** — the findings list endpoints (`GET /api/brands/[brandId]/findings` and `GET /api/findings`) return a compact `FindingSummary` shape via Firestore `.select(...)`, excluding `rawData`, `rawLlmResponse`, and other fields not needed for normal rendering. This avoids repeatedly shipping the full SERP batch payload on every finding card.
- **Incremental dashboard fetch** — `GET /api/findings` pages through the newest findings until it has filled the requested limit, instead of always fetching a fixed `limit * 4` window and filtering in memory. This keeps dashboard reads closer to the actual number of cards rendered.
- **Debug details fetched on demand** — `FindingCard` fetches `GET /api/brands/[brandId]/findings/[findingId]` only when a debug section is opened (`?debug=true`). Normal list views never load raw actor data or raw AI responses.
- **No redundant brand ownership checks on per-scan findings** — the `GET /api/brands/[brandId]/findings` route relies solely on `userId == uid` in the Firestore query for authorization (no extra brand doc read per request). The PATCH (ignore/un-ignore) route similarly skips the brand doc read, verifying ownership via the finding document itself.

---

## Key Docs

- [`docs/GCP_SETUP.md`](docs/GCP_SETUP.md) — GCP / Firestore / Cloud Run setup
- [`docs/PIPELINE_SETUP.md`](docs/PIPELINE_SETUP.md) — Apify, OpenRouter, ngrok, env vars
- [`REVIEW.md`](REVIEW.md) — Ongoing scan quality review: actor details and AI analysis prompts
