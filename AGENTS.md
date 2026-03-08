# DoppelSpotter — Architecture & Agent Notes

This file provides a concise architectural overview for AI coding agents and contributors.
Keep it up to date when making significant structural changes.

---

## Project Overview

**DoppelSpotter** is an AI-powered brand protection web app for SMEs. The current production
pipeline monitors Google web search results for signs of brand infringement, then uses AI
analysis to classify likely threats and summarise scan outcomes.

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
├── landing-page/                 # Static marketing site
├── app/                          # Next.js 15 application
│   └── src/
│       ├── app/                  # Pages + API routes (App Router)
│       │   └── api/
│       │       ├── auth/         # login, logout, me, forgot/reset password, change-password (signup disabled — use add-user CLI)
│       │       ├── brands/       # CRUD + findings + scans per brand
│       │       ├── dashboard/    # Dashboard bootstrap, persisted selection, and analytics metrics
│       │       ├── findings/     # Cross-brand findings query
│       │       ├── internal/     # Internal service-to-service routes (scheduled scan dispatch)
│       │       ├── scan/         # Trigger scan + poll status
│       │       └── webhooks/apify/  # Apify webhook receiver → AI analysis pipeline
│       └── lib/
│           ├── apify/
│           │   ├── actors.ts     # Google Search actor definition + lookup helpers
│           │   └── client.ts     # Apify client: startActorRun, buildActorInput, fetchDatasetItems
│           ├── dashboard.ts      # Dashboard metrics helpers: terminal-scan totals + platform/theme rollups
│           ├── mailersend.ts     # MailerSend email client for transactional emails
│           ├── scan-runner.ts    # Shared manual + scheduled scan reservation and actor startup
│           ├── scan-summary-emails.ts # Branded scan-summary email composition + idempotent delivery
│           ├── scan-schedules.ts # Schedule validation, timezone-aware recurrence, next-run helpers
│           └── analysis/
│               ├── prompts.ts    # Google classification + deep-search + scan-summary prompts
│               ├── openrouter.ts # AI analysis client: chatCompletion()
│               └── types.ts      # Google analysis output interfaces + parsers
└── docs/
    ├── GCP_SETUP.md
    └── PIPELINE_SETUP.md
```

---

## Actor Registry

The app is currently Google-only. `app/src/lib/apify/actors.ts` keeps a tiny registry/lookup
layer, but the only supported actor is `apify/google-search-scraper`.

New scans always reserve the Google Search actor; there is no longer any request-time actor
override path.

---

## Scan Pipeline Flow

```
Brand add/edit pages
 └─ persist `brands.sendScanSummaryEmails` to opt the brand into post-scan summary emails
 └─ persist `brands.searchResultPages` to control how many Google SERP pages each initial/deep search run requests
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
 └─ initializes `scans.userPreferenceHintsStatus = 'pending'` before any actor webhook can race ahead
 └─ reserves the Google Search actor for the scan
 └─ uses `brands.searchResultPages` (default 3, min 1, max 10) as Google Search `maxPagesPerQuery`
 └─ starts Apify actors and scan-level user-preference-hint generation concurrently
 └─ stores runId → scan document incrementally as each actor starts, reducing the race window for early callbacks
 └─ once the scan-level preference hints are ready (or deliberately fail open), replays any deferred succeeded webhooks and then flips the scan to `running`

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

GET /api/brands/[brandId]/scans/[scanId]/export
 └─ verifies brand + scan ownership
 └─ streams a CSV export for every finding in the scan, including non-hits, notes, and addressed/bookmarked/ignored flags
 └─ uses the scan's `startedAt` as the exported "Scan date/time" column for every row

GET /api/brands/[brandId]/scans/[scanId]/export/pdf
 └─ verifies brand + scan ownership
 └─ returns a branded PDF report with logo, brand name, scan date/time, and the scan-level AI summary
 └─ includes only actionable high/medium/low findings in the main report body, grouped by severity, with any per-finding notes
 └─ excludes non-hits and ignored findings from the PDF, and renders addressed findings in a dedicated final section grouped by severity

DELETE /api/brands/[brandId]/scans/[scanId]
 └─ verifies ownership; returns 409 if scan is pending/running
 └─ batch-deletes all findings for the scan, then deletes the scan doc

DELETE /api/brands/[brandId]
 └─ verifies ownership
 └─ returns 409 if any scan for the brand is still pending/running/summarising
 └─ batch-deletes all findings and scans for the brand before deleting the brand doc

GET /api/brands/[brandId]/findings?scanId=xxx
 └─ optional scanId param filters findings to a single scan (used for lazy loading in the UI)

Apify calls POST /api/webhooks/apify (on SUCCEEDED / FAILED / ABORTED)
 └─ validates X-Apify-Webhook-Secret header
 └─ on SUCCEEDED, atomically claims the actor run by transitioning it to `fetching_dataset` before any dataset fetch / AI analysis begins
 └─ if the scan's preference hints are still `pending`, the run is parked in `actorRuns.*.status = 'waiting_for_preference_hints'` and no analysis starts yet
 └─ once the scan-level preference hints are `ready` or `failed`, deferred succeeded callbacks are replayed through the same webhook route so they resume normal processing
 └─ duplicate callbacks for a run already in `fetching_dataset` / `analysing` are acknowledged and skipped before expensive work starts
 └─ fetches up to 50 items from Apify dataset
 └─ Google Search mode: normalize SERP pages into compact organic-result candidates
      └─ excludes ads from AI analysis; keeps `relatedQueries` + `peopleAlsoAsk` as run-level context
      └─ dedupes repeated URLs within the run before analysis
      └─ skips normalized URLs that already appeared in previous scans for the same brand before any LLM analysis
      └─ chunked AI classification: bounded concurrent chunk calls (deterministically merged in chunk order)
      └─ in the default `llm-final` mode, chunk calls do classification only — they do not propose deep-search queries
      └─ the webhook collects the full deduped run-level `relatedQueries` + `peopleAlsoAsk` text signals (not URLs) and passes them to the final deep-search chooser without truncating them
      └─ final deep-search selection defaults to a dedicated LLM pass that sees the full run-level intent signals and synthesizes follow-up queries directly; prompts inject the brand's allowed deep-search count and steer the model away from narrow named-site/platform/resource queries unless they are materially distinct abuse vectors
└─ before each finding-level classification pass, the webhook loads the brand's existing finding `platform` and `theme` labels so the LLM can preferentially reuse them
 └─ one Finding written per normalized URL per scan (deterministic upsert; repeated URLs merged)
└─ each LLM-classified finding may also store a short primary `platform` and `theme` label (prefer 1 word, hard max 3 words); legacy findings may not have these fields
 └─ isFalsePositive: true findings are stored but excluded from default API responses
 └─ normalized Google URLs that already appeared in previous scans for the same brand are filtered out before AI analysis, so historical repeats never reach the classifier
 └─ a separate scan-level `userPreferenceHints` summary is still passed into classification prompts as soft guidance only; it is derived from explicit user ignore / reclassification signals and must not override clear evidence
 └─ (batch mode, depth 0 only) if ranked chunk/fallback suggestions are present and the brand allows deep search → triggers deep-search runs
      └─ suggestions are reserved on the originating run so duplicate callbacks do not fan out extra searches
      └─ each deep-search run is registered on the scan document (actorRunIds, actorRuns)
      └─ each deep-search Google run uses the same `brands.searchResultPages` setting as the initial search
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
- **Prompts:** `GOOGLE_CLASSIFICATION_SYSTEM_PROMPT` + `buildGoogleChunkAnalysisPrompt()` for chunked Google classification; `buildGoogleFinalSelectionSystemPrompt()` + `buildGoogleFinalSelectionPrompt()` for the final deep-search query chooser; `SCAN_SUMMARY_SYSTEM_PROMPT` + `buildScanSummaryPrompt()` for the final scan summary
- **Scan-level summary:** after all actor runs finish, the webhook runs one final LLM pass over the scan's actionable findings and stores a concise `aiSummary` on the scan document for the brand page
- **Watch words:** optional per-brand terms passed to the prompt builder; AI analysis is instructed to note any presence or implied association and use its discretion on severity impact
- **Safe words:** optional per-brand terms passed to the prompt builder; AI analysis is instructed to treat results containing these terms with reduced caution unless there are strong warning signs elsewhere
- **Historical URL suppression:** Google runs load previously seen normalized finding URLs for the brand and filter them out before any LLM classification begins
- **User preference hints:** each scan prepares a tiny LLM-authored soft-guidance summary from explicit user-review signals before actor-run analysis begins; this is now the only historical-review context sent into classification prompts
- **Existing taxonomy hints:** prompts receive the current brand's distinct `platform` and `theme` labels so the LLM can reuse them exactly where appropriate, while still inventing a new short label when none fit
- **Google chunk output:** structured JSON `{ items: [{ resultId, title, severity, platform?, theme?, analysis, isFalsePositive }] }`
- **Debug prompt transcript:** the exact system + user prompt used for finding-level AI analysis is stored on each finding as `llmAnalysisPrompt` for `?debug=true` inspection
- **Raw AI response** string is stored on every finding as `rawLlmResponse` for debugging
- **False positives** are written to Firestore with `isFalsePositive: true`; filtered from default API responses; visible in the brand page "Non-hits" section

### Google Analysis Shape

Google Search results arrive as page-level SERP blobs. The webhook normalizes them into compact
organic-result candidates, dedupes repeated URLs within the run, and classifies those candidates
in bounded chunks. Google findings store a compact normalized debug payload
(`kind: 'google-normalized'`) with candidate metadata, merged sightings, and SERP context instead
of the full page blobs. Normalized Google URLs that already appeared in previous scans for the
same brand are filtered out before chunking, so repeat results do not trigger new LLM calls.

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
runs are skipped entirely when `allowAiDeepSearches` is false for the brand. When enabled, both
the initial Google scan and each deep-search Google run use the brand's `searchResultPages`
setting, which defaults to 3 and is constrained to 1-10.

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

## Addressed Findings

Users can mark any real finding as addressed once they have completed the follow-up work they care about. Addressed state is URL-scoped like ignore/un-ignore, so matching findings for the same URL across scans move together.

**Behaviour:**
- Addressed findings are excluded from the default findings API response and from visible severity counts in `ScanSummary`
- They are grouped into a dedicated cross-scan "Addressed" tab on the brand page, organised by `high`, `medium`, and `low`
- Addressed findings can be un-addressed from that tab, which restores them to the normal findings lists
- Addressed and ignored are mutually exclusive for real findings: a finding must be un-ignored before it can be addressed, and un-addressed before it can be ignored
- Addressed is only available for real findings; AI-classified non-hits must be reclassified into a real category first
- On each new scan, previously addressed URLs are treated the same as ignored URLs in the AI prompts so they do not get surfaced again as new actionable findings

**API:**
- `PATCH /api/brands/[brandId]/findings/[findingId]` — body `{ isAddressed: boolean }` — toggles addressed state URL-wide for real findings
- `GET /api/brands/[brandId]/findings?addressedOnly=true` — returns addressed findings across all scans for the brand

---

## Bookmarked Findings

Users can bookmark any finding they want to follow up on, including AI-classified non-hits. Bookmark state is stored directly on the finding document with `isBookmarked` and `bookmarkedAt`.

**Behaviour:**
- Bookmarks are per finding document, not URL-scoped like ignore/un-ignore
- The brand page loads a cross-scan "Bookmarked findings" panel above the scan result sets; it is hidden when empty and collapsed by default
- The bookmark panel groups bookmarked items into `high`, `medium`, `low`, and `Non-hits`, while still showing any existing ignored/non-hit badges on the cards themselves
- Users can unbookmark findings both from their original location and from the bookmark panel
- Because bookmark state lives on the finding document, deleting a scan automatically removes any bookmarks attached to findings from that scan

**API:**
- `PATCH /api/brands/[brandId]/findings/[findingId]` — body may include `{ isBookmarked: boolean }`
- `GET /api/brands/[brandId]/findings?bookmarkedOnly=true` — returns bookmarked findings across all scans for the brand

---

## User Preference Hints

Explicit user-review actions now also feed a separate soft-guidance system for future classification.

**Signals recorded:**
- Manual ignore on a real finding → negative preference signal
- Manual reclassification to `non-hit` → negative preference signal
- Manual reclassification from `non-hit` to `high` → positive preference signal

**Behaviour:**
- These signals are stored directly on finding documents as explicit metadata (`userPreferenceSignal`, `userPreferenceSignalReason`, `userPreferenceSignalAt`, and optional `userReclassifiedFrom` / `userReclassifiedTo`)
- AI auto-classified false positives do **not** create preference signals, even though they still participate in the separate exact-URL suppression path via `isIgnored`
- At scan start, the app loads explicit signal findings only, dedupes repeated URL-scoped actions, and asks the LLM for a tiny scan-level hint summary
- The resulting `scans.userPreferenceHints` payload is source-aware and intentionally tiny (global lines plus optional per-source lines)
- Classification prompts treat these hints as soft tendencies only; they must not be used as hard include/exclude rules
- No actor-run analysis begins until `scans.userPreferenceHintsStatus` is terminal (`ready` or `failed`)

---

## Finding Notes

Users can add notes to any finding, regardless of whether it is bookmarked, ignored, addressed, or AI-classified as a non-hit. Notes are stored per finding document in the existing `bookmarkNote` field for backwards compatibility.

**Behaviour:**
- Every finding card exposes a note action
- Existing notes render beneath the AI analysis and can be edited or deleted in place
- Notes are per finding document, not URL-scoped, so matching URLs across scans keep independent notes
- Unbookmarking a finding does not remove its note

**API:**
- `PATCH /api/brands/[brandId]/findings/[findingId]` — body may include `{ bookmarkNote?: string | null }`

---

## Finding Taxonomy

Findings can now carry two optional lightweight taxonomy labels: `platform` and `theme`.

**Behaviour:**
- Labels are LLM-assigned during finding classification for newly analysed findings only; existing historical findings are not backfilled automatically
- Labels are brand-scoped: the webhook loads the current brand's existing labels before classification so the LLM can prefer exact reuse where appropriate
- Both labels are intentionally short for UI/filtering purposes: prefer 1 word where natural, hard maximum 3 words
- The brand page shows these labels subtly on finding cards when present
- The brand page also supports client-side platform/theme filtering alongside the existing free-text search, and the active filters apply to whichever findings tab is currently in view (`Scans`, `Bookmarks`, `Addressed`, or `Ignored`)

**API:**
- `GET /api/brands/[brandId]/findings/taxonomy` — returns distinct brand-scoped `platforms[]` and `themes[]` for filter dropdowns

---

## Dashboard Analytics

The authenticated dashboard is now fully brand-scoped rather than a cross-brand recent-findings feed.

**Behaviour:**
- The dashboard first calls `GET /api/dashboard/bootstrap` to load the user's brands plus the persisted default brand selection
- The selected dashboard brand is stored on the user document as `users.dashboardPreferences.selectedBrandId`
- If the saved brand no longer exists or no longer belongs to the user, bootstrap falls back to the oldest remaining brand and repairs the saved preference
- Brand selection changes call `PATCH /api/dashboard/preferences` so the same default brand is restored across reloads and devices
- Dashboard analytics call `GET /api/dashboard/metrics?brandId=...&scanId=...`
- The metrics route returns all terminal scans for the selected brand (newest first) for the scan-scope dropdown
- Dashboard KPI totals come from denormalized per-scan `highCount`, `mediumCount`, `lowCount`, and `nonHitCount` fields so all-time rollups do not require hydrating every finding
- Platform and theme charts aggregate findings for the selected scope and use the same visible-count semantics as the rest of the app: actionable hits plus non-hits, excluding ignored and addressed real findings
- Missing `platform` / `theme` labels are grouped into an `Unlabelled` chart bucket
- Each chart row also tracks the newest matching scan id per severity bucket so stacked-bar segments can drill into the brand page
- Chart drill-down links navigate to the brand page with `scanResultSet`, `category`, and optional `platform` / `theme` query params so the matching scan opens with the relevant filter state applied
- Dashboard severity metric cards use the same drill-down pattern, applying the matching `category` filter and, when a specific scan is in scope, anchoring into the relevant section of that scan
- Dashboard-originated links into a brand page also carry `returnTo=dashboard`, so the brand-page back arrow returns to the dashboard instead of the brands index for that navigation path
- When a brand has no terminal scans yet, the dashboard shows a CTA to run the first scan; if the first scan is already in progress, it instead shows a progress-focused CTA linked to the brand page

**API:**
- `GET /api/dashboard/bootstrap` — returns brand selector options plus the resolved selected brand id
- `PATCH /api/dashboard/preferences` — persists `{ selectedBrandId }` on the authenticated user document
- `GET /api/dashboard/metrics?brandId=...&scanId=...` — returns scan selector options, KPI totals, active-scan state, and platform/theme stacked-bar datasets

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `APIFY_API_TOKEN` | Apify platform token |
| `APIFY_WEBHOOK_SECRET` | Shared secret for webhook validation |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OPENROUTER_MODEL` | AI analysis model override (default: `anthropic/claude-3.5-haiku`) |
| `MAILERSEND_API_TOKEN` | MailerSend API token used to send branded transactional emails |
| `AUTH_JWT_SECRET` | JWT signing secret used for 7-day auth cookies and 1-hour password-reset links |
| `SCHEDULE_DISPATCH_SERVICE_ACCOUNT_EMAIL` | Email of the dedicated Cloud Scheduler service account allowed to call the internal scheduled-scan dispatch route |
| `GCP_PROJECT_ID` | Google Cloud project ID |
| `FIRESTORE_DATABASE_ID` | Firestore DB (default: `(default)`) |
| `APP_URL` | Public base URL — used to construct webhook callback URLs |
| `GOOGLE_APPLICATION_CREDENTIALS` | Local dev only: path to GCP service account JSON |

---

## Firestore Collections

| Collection | Key Fields |
|---|---|
| `users` | id, email, passwordHash, **sessionVersion?**, **passwordChangedAt?**, **dashboardPreferences?** (`selectedBrandId?`), createdAt |
| `brands` | id, userId, name, keywords[], officialDomains[], **sendScanSummaryEmails?**, **searchResultPages?**, **allowAiDeepSearches?**, **maxAiDeepSearches?**, **activeScanId?**, watchWords[]?, safeWords[]?, **scanSchedule?** (`enabled`, `frequency`, `timeZone`, `startAt`, `nextRunAt`, `lastTriggeredAt?`, `lastScheduledScanId?`), createdAt, updatedAt |
| `scans` | id, brandId, userId, status (`pending`\|`running`\|`summarising`\|`completed`\|`failed`\|`cancelled`), actorIds[], actorRuns{} (`status`, `datasetId?`, `itemCount?`, `analysedCount?`, `skippedDuplicateCount?`, `searchDepth?`, `searchQuery?`), completedRunCount, findingCount, **highCount, mediumCount, lowCount, nonHitCount, ignoredCount, addressedCount, skippedCount, userPreferenceHintsStatus?, userPreferenceHints?, userPreferenceHintsError?, userPreferenceHintsStartedAt?, userPreferenceHintsCompletedAt?, aiSummary?, summaryStartedAt?**, **scanSummaryEmailStatus?**, **scanSummaryEmailAttemptedAt?**, **scanSummaryEmailSentAt?**, **scanSummaryEmailMessageId?**, **scanSummaryEmailError?** (denormalized completion + notification metadata), startedAt, completedAt |
| `findings` | id, scanId, brandId, userId, source, actorId, severity, title, **platform?**, **theme?**, description, llmAnalysis, url?, rawData, llmAnalysisPrompt?, isFalsePositive?, isIgnored?, ignoredAt?, **userPreferenceSignal?**, **userPreferenceSignalReason?**, **userPreferenceSignalAt?**, **userReclassifiedFrom?**, **userReclassifiedTo?**, **isAddressed?**, **addressedAt?**, **isBookmarked?**, **bookmarkedAt?**, **bookmarkNote?** (per-finding user note), rawLlmResponse?, createdAt |

---

## User Management

Signup via the web UI and API is **disabled** during development. Use the CLI to create accounts:

```bash
# Run from the app/ directory
npm run add-user -- --email user@example.com --password secret123
```

Script: `app/scripts/add-user.ts`. Reads `.env.local` automatically (same file used by `next dev`).

Authenticated users can open the top-right user menu to change their password. The password-change flow:

- lives at `GET /account/password` behind the authenticated navbar user menu
- posts to `POST /api/auth/change-password` with the current password and replacement password
- verifies the current password before storing a new bcrypt hash
- increments `users.sessionVersion`, stamps `users.passwordChangedAt`, and reissues the current browser's JWT
- causes older cookies with a stale `sessionVersion` to be rejected by both `requireAuth()`-protected API routes and `GET /api/auth/me`
- broadcasts an auth-sync event across tabs so other open tabs refresh their session state promptly after sign-in, sign-out, or password changes

Unauthenticated users can also reset a forgotten password. The reset flow:

- starts from the `Forgotten your password?` link on the login screen
- uses `POST /api/auth/forgot-password` to accept an email address and always return a generic success message to avoid account enumeration
- if a matching account exists, sends a MailerSend password-reset email with the same branded shell used by the scan-summary email
- includes a JWT-based reset link to `GET /reset-password?token=...`
- signs reset tokens with a password-reset-specific secret derived from `AUTH_JWT_SECRET`, so they cannot be reused as auth cookies
- expires each reset token after 1 hour
- posts the new password to `POST /api/auth/reset-password`
- verifies the token signature, expiry, account email, and `users.sessionVersion` before changing the password
- increments `users.sessionVersion` and stamps `users.passwordChangedAt`, invalidating older sessions after a successful reset

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
- **Eager cross-scan addressed fetch** — the brand page separately loads `GET /api/brands/[brandId]/findings?addressedOnly=true` on mount so addressed findings are available in their dedicated tab without loading individual scan accordions
- **Dedicated taxonomy bootstrap** — the brand page loads `GET /api/brands/[brandId]/findings/taxonomy` on mount (and after scan-history changes) so the platform/theme filter dropdowns can populate without hydrating every scan bucket first
- **Lightweight list payloads** — the findings list endpoints (`GET /api/brands/[brandId]/findings` and `GET /api/findings`) return a compact `FindingSummary` shape via Firestore `.select(...)`, excluding `rawData`, `llmAnalysisPrompt`, `rawLlmResponse`, and other fields not needed for normal rendering. This avoids repeatedly shipping the full SERP batch payload on every finding card.
- **Dedicated scan export paths** — `GET /api/brands/[brandId]/scans/[scanId]/export` performs a single scan-scoped findings query and returns a CSV attachment containing hits, non-hits, notes, and review-state flags, while `GET /api/brands/[brandId]/scans/[scanId]/export/pdf` returns a branded PDF report containing the scan AI summary, actionable high/medium/low findings, notes, and a dedicated addressed-findings section. Neither path forces the UI to eagerly load every findings bucket first.
- **Dashboard bootstrap + metrics split** — the main dashboard uses `GET /api/dashboard/bootstrap` for brand selection state and `GET /api/dashboard/metrics` for brand/scan-scoped analytics, instead of reusing the lightweight recent-findings feed.
- **All-time dashboard totals** — dashboard KPI cards use terminal scan denormalized counts, while stacked platform/theme charts aggregate selected findings with a minimal Firestore `.select(...)` projection.
- **Recent activity feed remains lightweight** — `GET /api/findings` still pages through the newest findings until it has filled the requested limit, instead of always fetching a fixed `limit * 4` window and filtering in memory. This keeps that cross-brand recent-activity query close to the number of cards rendered.
- **Debug details fetched on demand** — `FindingCard` fetches `GET /api/brands/[brandId]/findings/[findingId]` only when a debug section is opened (`?debug=true`). Normal list views never load raw actor data or raw AI responses.
- **No redundant brand ownership checks on per-scan findings** — the `GET /api/brands/[brandId]/findings` route relies solely on `userId == uid` in the Firestore query for authorization (no extra brand doc read per request). The PATCH (ignore/un-ignore) route similarly skips the brand doc read, verifying ownership via the finding document itself.

---

## Key Docs

- [`docs/GCP_SETUP.md`](docs/GCP_SETUP.md) — GCP / Firestore / Cloud Run setup
- [`docs/PIPELINE_SETUP.md`](docs/PIPELINE_SETUP.md) — Apify, OpenRouter, ngrok, env vars
- [`REVIEW.md`](REVIEW.md) — Ongoing scan quality review: actor details and AI analysis prompts
