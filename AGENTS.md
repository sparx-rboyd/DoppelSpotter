# DoppelSpotter — Architecture & Agent Notes

This file provides a concise architectural overview for AI coding agents and contributors.
Keep it up to date when making significant structural changes.

---

## Project Overview

**DoppelSpotter** is an AI-powered brand protection web app for SMEs. The current production
pipeline monitors public web and community-discovery surfaces for signs of brand infringement,
then uses AI analysis to classify likely threats and summarise scan outcomes.

**Stack:**
- Frontend / API: Next.js 15 (App Router), TypeScript, Tailwind CSS
- Database: Google Cloud Firestore
- Scraping: Apify platform (hosted actors)
- AI analysis: OpenRouter → `deepseek/deespseek-v3.2` (default)
- Hosting: Google Cloud Run (app) + Cloudflare Workers (landing page)
- CI/CD: GCP Cloud Build

---

## Repository Structure

```
/
├── AGENTS.md                     # This file
├── REVIEW.md                     # Ongoing scan quality review notes
├── PITCH.md                      # Product pitch / spec
├── NEW_ACTOR.md                  # Spec + publication notes for the recent-domain-registrations Apify actor
├── cloudbuild.yaml               # GCP Cloud Build CI/CD pipeline
├── wrangler.toml                 # Cloudflare Workers config (landing page)
├── actors/                       # Standalone Apify actors and prototypes
│   └── recent-domain-registrations/ # CodePunch-backed recent-domain-registrations actor (published at apify.com/doppelspotter/recent-domain-registrations)
├── landing-page/                 # Static marketing site
├── app/                          # Next.js 15 application
│   └── src/
│       ├── app/                  # Pages + API routes (App Router)
│       │   └── api/
│       │       ├── auth/         # login, logout, me, forgot/reset password, change-password (signup disabled — use add-user CLI)
│       │       │                 # delete-account removes the user and all owned Firestore data
│       │       ├── brands/       # CRUD + findings + scans per brand
│       │       ├── dashboard/    # Dashboard bootstrap, persisted selection, and analytics metrics
│       │       ├── findings/     # Cross-brand findings query
│       │       ├── internal/     # Internal service-to-service routes (scheduled scan dispatch)
│       │       ├── scan/         # Trigger scan + poll status
│       │       └── webhooks/apify/  # Apify webhook receiver → AI analysis pipeline
│       ├── settings/             # Authenticated account settings page (password + account deletion)
│       └── lib/
│           ├── apify/
│           │   ├── actors.ts     # Logical scanner registry (Google + Reddit + TikTok + Discord + GitHub + X) + Apify actor lookup helpers
│           │   └── client.ts     # Apify client: source-specific actor input builders, run start helpers, dataset fetch
│           ├── account-deletion.ts # Account-wide cleanup helper: cancel active runs, delete owned data
│           ├── dashboard.ts      # Dashboard metrics helpers: terminal-scan totals + source/theme rollups from stored scan summaries
│           ├── dashboard-aggregates.ts # Scan-level dashboard breakdown backfill/rebuild helpers
│           ├── mailersend.ts     # MailerSend email client for transactional emails
│           ├── scan-runner.ts    # Shared manual + scheduled scan reservation and actor startup
│           ├── scan-sources.ts   # Shared scan-source/scanner config, Google site-operator policy, and display helpers
│           ├── scan-summary-emails.ts # Branded scan-summary email composition + idempotent delivery
│           ├── scan-schedules.ts # Schedule validation, timezone-aware recurrence, next-run helpers
│           └── analysis/
│               ├── google-scanner-policy.ts # Small prompt-policy helpers for Google specialist scans
│               ├── prompts.ts    # Google + Reddit + TikTok + Discord + GitHub + X classification, deep-search, and scan-summary prompts
│               ├── openrouter.ts # AI analysis client: chatCompletion()
│               └── types.ts      # Google + Reddit + TikTok + Discord + GitHub + X analysis output interfaces + parsers
└── docs/
    ├── GCP_SETUP.md
    └── PIPELINE_SETUP.md
```

---

## Actor Registry

The scan pipeline now has thirteen active logical scanner variants backed by seven physical Apify actors:

- `google-web` → normal web search
- `reddit-posts` → public Reddit post discovery via the dedicated Reddit search actor
- `tiktok-posts` → public TikTok video discovery via the dedicated TikTok search actor
- `google-youtube` → Google Search constrained to `site:youtube.com`
- `google-facebook` → Google Search constrained to `site:facebook.com`
- `google-instagram` → Google Search constrained to `site:instagram.com`
- `google-telegram` → Google Search constrained to `site:t.me`
- `google-apple-app-store` → Google Search constrained to `site:apps.apple.com`
- `google-play` → Google Search constrained to `site:play.google.com`
- `discord-servers` → public Discord server discovery via the Apify Discord actor
- `domain-registrations` → recent domain registration discovery via the CodePunch-backed Apify actor
- `github-repos` → public GitHub repository discovery via the Apify GitHub repo-search actor
- `x-search` → public X post discovery via the Apify tweet-search actor

The seven active Google logical scanners all reuse the same physical Apify actor
`apify/google-search-scraper`. `reddit-posts` uses
`fatihtahta/reddit-scraper-search-fast`, `tiktok-posts` uses
`apidojo/tiktok-scraper`, and `domain-registrations` uses
`doppelspotter/recent-domain-registrations`, `discord-servers` uses
`louisdeconinck/discord-server-scraper`, `github-repos` uses
`ryanclinton/github-repo-search`, and `x-search` uses `apidojo/tweet-scraper`.
`app/src/lib/apify/actors.ts` therefore keys the registry by logical scanner id rather than raw
`actorId`.

The generic web scanner automatically appends `-site:` exclusions for every specialist scanner
domain (`reddit.com`, `tiktok.com`, `youtube.com`, `facebook.com`, `instagram.com`, `t.me`,
`apps.apple.com`, `play.google.com`) even
when those specialist scans are disabled on the brand, so the main web search and its
deep-search follow-ups never surface those platform-specific results. Specialist scanners apply
platform-specific query scoping, while source identity lives on the finding itself and the only
remaining lightweight taxonomy label is `theme`.

`reddit-posts` is a post-level Reddit source. It does not use Google SERPs or the public Reddit
`/.json` endpoint. Instead it queries the dedicated Reddit search actor with one actor run per
scan, passing the brand search terms as `queries[]`, mapping the brand-page `Search depth` setting
(`1..5`) to a total post budget of `60..300` distributed across queries (`maxPosts`, minimum 10
per query), and also applying an Apify `maxTotalChargeUsd` cap from `$0.10` to `$0.50` per run.
The scan's exact `lookbackDate` is approximated to the actor's `timeframe` input and then applied
again as an exact post-filter inside the webhook before analysis. Stores one finding per Reddit
post, derives the canonical Reddit post URL as the user-visible URL, uses Reddit post `id` as the
canonical identity for per-scan upserts and historical repeat suppression. Reddit now also
supports AI-requested deep-search follow-up runs: each follow-up query starts a new Reddit actor
run capped at `maxPosts = 20`, still ignores comments, and never recurses beyond depth 1.

`tiktok-posts` is a video-level TikTok source. It no longer uses Google SERPs. Instead it queries
the dedicated TikTok search actor with one actor run per brand search term, mapping the brand-page
`Search depth` setting (`1..5`) to a total post budget of `100..500` distributed across keyword
runs (`maxItems`, minimum 10 posts per query). The scan's exact `lookbackDate` is approximated to
the actor's `dateRange` bucket and then applied again as an exact created-at filter inside the
webhook before analysis. The webhook accepts both nested TikTok author/song objects and flat raw
keys such as `channel.username` and `song.title`. Stores one finding per TikTok video, derives the
canonical TikTok post URL as the user-visible URL, uses TikTok video `id` as the canonical
identity for per-scan upserts and historical repeat suppression, and supports AI-requested
deep-search follow-up runs: each follow-up query starts a new TikTok actor run capped at
`maxItems = 50` and never recurses beyond depth 1.

`discord-servers` is a non-Google source. It does not use `site:` operators or SERP
pages. Instead it queries Discord's public server-discovery index through the Apify actor,
filters out non-joinable servers without `vanity_url_code`, derives `https://discord.gg/<code>`
as the user-visible URL, uses the Discord server `id` as the canonical identity for per-scan
upserts and historical repeat suppression, and maps the brand-page `Search depth` setting to an
Apify `maxTotalChargeUsd` cap from `$0.20` to `$0.60` per run.

`github-repos` is a repository-level source. It queries public GitHub repository search through
the Apify actor with one actor run per search term using the format
`<keyword> in:name,description pushed:>YYYY-MM-DD`. The brand-page `Search depth` setting
(`1..5`) maps to a total `maxResults` budget of `50..250` divided evenly across keyword runs
(minimum 10 results per keyword). Initial scan startup now launches at most two GitHub runs at a
time; any remaining GitHub terms are persisted on the scan document as queued work, and each
completed GitHub run drains the next queued term until the queue is empty. Stores one finding per
repository, derives `https://github.com/<fullName>` as the user-visible URL, uses repo `fullName`
(`owner/repo`) as the canonical identity for per-scan upserts and historical repeat suppression,
and does **not** support deep-search follow-up runs.

`x-search` is a tweet-level source. It uses `searchTerms` only, maps the brand-page `Search depth`
setting from `1..5` to `maxItems = 50..250`, stores one finding per tweet, uses tweet `id` as
the canonical identity for per-scan upserts and historical repeat suppression, and supports
AI-requested deep-search follow-up runs: each follow-up query starts a new X actor run capped at
`maxItems = 30` and never recurses beyond depth 1.

`domain-registrations` is a domain-level source. It queries the published
`doppelspotter/recent-domain-registrations` actor, fixes the actor date filter to UTC "one month
ago today" with `dateComparison = gte`, always enables the actor's enhanced homepage analysis,
maps the brand-page `Search depth` setting from `1..5` to `totalLimit = 100..500`, stores one
finding per domain, uses the lowercase domain name as the canonical identity for per-scan upserts
and historical repeat suppression, and does **not** support deep-search follow-up runs.

---

## Scan Pipeline Flow

```
Brand add/edit pages
 └─ persist `brands.sendScanSummaryEmails` to opt the brand into post-scan summary emails
 └─ persist `brands.searchResultPages` as the user-facing `Search depth` setting; Google-backed scans map it to requested SERP pages, Reddit maps it to a total post budget (`60..300`, distributed across query terms with a minimum 10 posts per query) plus an Apify spend cap (`$0.10..$0.50` per run), TikTok maps it to a total video budget (`100..500`, distributed across query terms with a minimum 10 posts per query), Domain registrations map it to requested domain volume (`100..500`), Discord maps it to an Apify spend cap (`$0.20..$0.60` per run), GitHub maps it to a per-keyword result budget from a `50..250` total (minimum 10 per keyword), and X maps it to requested tweet volume (`50..250`)
 └─ persist `brands.lookbackPeriod` as the user-facing `Lookback period` setting (`1year` | `1month` | `1week` | `since_last_scan`, default `1year`); at scan-start time this is resolved to a concrete `YYYY-MM-DD` date (with a 1-day buffer) and snapshotted as `scans.effectiveSettings.lookbackDate`; Google-backed scans append `after:YYYY-MM-DD` to the search query, Reddit maps the date to the closest actor `timeframe` bucket and the webhook then exact-filters posts by `created_utc >= lookbackDate`, TikTok maps the date to the closest actor `dateRange` bucket and the webhook then exact-filters videos by created-at time, Domain registrations use it as the `date` filter, GitHub appends `created:>YYYY-MM-DD pushed:>YYYY-MM-DD` qualifiers, X passes it as `tweetDateSince`; Discord is unaffected; the `since_last_scan` option resolves to the brand's last completed scan date, falling back to 1 year when no prior scan exists
 └─ persist `brands.allowAiDeepSearches` to allow or block AI-requested follow-up searches on supported deep-search-capable scan types
 └─ persist `brands.maxAiDeepSearches` as the user-facing deep-search breadth setting; it caps AI-requested follow-up searches from 1-5 on supported deep-search-capable scan types
 └─ persist `brands.scanSources.google|reddit|tiktok|youtube|facebook|instagram|telegram|apple_app_store|google_play|domains|discord|github|x` so each scan surface can be enabled or disabled per brand
 └─ persist optional `brands.analysisSeverityDefinitions.high|medium|low` overrides so each brand can customise the severity definitions injected into finding-classification prompts
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
 └─ refuses to start while `brands.historyDeletion` or `brands.brandDeletion` is active
 └─ checks `brands.activeScanId` inside a Firestore transaction
 └─ if the brand already has a pending/running scan, returns 409 with that scan instead of starting another
 └─ reserves the new scan by writing the scan doc + `brands.activeScanId` atomically
 └─ manual runs may include optional one-off custom scan settings (depth, deep-search toggle/breadth, scan sources) without mutating the brand defaults
 └─ snapshots the resolved per-run `scans.effectiveSettings` onto the scan so later webhook processing stays deterministic even if brand settings change mid-scan
 └─ also snapshots the resolved `scans.analysisSeverityDefinitions` so classification thresholds stay deterministic if the brand settings are edited mid-scan
 └─ initializes `scans.userPreferenceHintsStatus = 'pending'` before any actor webhook can race ahead
 └─ resolves the scan's enabled logical scanners (`google-web`, `reddit-posts`, `tiktok-posts`, `google-youtube`, `google-facebook`, `google-instagram`, `google-telegram`, `google-apple-app-store`, `google-play`, `domain-registrations`, `discord-servers`, `github-repos`, `x-search`) from `scans.effectiveSettings.scanSources`
 └─ maps `scans.effectiveSettings.searchResultPages` (default 3, min 1, max 5) to Google Search `maxPagesPerQuery`; Reddit maps the same setting to a `60..300` total post budget distributed across `queries[]` via `maxPosts` (minimum 10 per query) plus `maxTotalChargeUsd = $0.10..$0.50` per run; TikTok maps it to a `100..500` total video budget distributed across keyword runs via `maxItems` (minimum 10 per query); Domain registrations map it to `totalLimit = 100..500`; Discord maps it to `maxTotalChargeUsd = $0.20..$0.60` per run; GitHub maps it to a per-keyword `maxResults` from a `50..250` total budget (minimum 10 per keyword) but only launches two GitHub runs concurrently per scan; X maps it to `maxItems = 50..250`
 └─ applies `scans.effectiveSettings.lookbackDate` (pre-resolved YYYY-MM-DD with 1-day buffer) to time-constrain actor queries: Google appends `after:YYYY-MM-DD`, Reddit maps it to the closest actor `timeframe` bucket and then exact-filters posts in the webhook by `created_utc`, TikTok maps it to the closest actor `dateRange` bucket and then exact-filters videos in the webhook by created-at time, Domain registrations pass it as the `date` + `gte` filter, GitHub appends `created:>` + `pushed:>` qualifiers, X passes `tweetDateSince`; Discord is unaffected
 └─ starts every enabled initial scanner concurrently, alongside scan-level user-preference-hint generation
 └─ stores runId → scan document incrementally as each scanner starts, including `actorRuns.*.scannerId`, raw `searchQuery`, operator-free `displayQuery`, and optional explicit `searchQueries[]` / `displayQueries[]` arrays for batched runs
 └─ GitHub startup persists any overflow terms beyond the two-run cap as `queuedGithubRuns` / `launchingGithubRuns`, and the webhook completion path drains that queue before scan completion
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
 └─ hides scans with async `scans.deletion` state so deleted scans stay invisible across reloads while Firestore cleanup continues
 └─ returns `[]` while `brands.historyDeletion` is active
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
 └─ marks `scans.deletion = { status: 'queued', ... }`, returns 202 immediately, and drains the delete in Firestore-sized chunks
 └─ list/search/taxonomy routes hide that scan while background cleanup is still deleting findings/documents

DELETE /api/brands/[brandId]
 └─ verifies ownership
 └─ returns 409 if any scan for the brand is still pending/running/summarising
 └─ marks `brands.brandDeletion = { status: 'queued', ... }`, returns 202 immediately, and drains findings/scans/brand deletion in chunks
 └─ brand list + dashboard bootstrap hide deleting brands immediately so they do not reappear on reload

GET /api/brands/[brandId]/findings?scanId=xxx
 └─ optional scanId param filters findings to a single scan (used for lazy loading in the UI)
 └─ returns `[]` while `brands.historyDeletion` is active and filters out findings that belong to scans with `scans.deletion`

DELETE /api/brands/[brandId]/findings
 └─ verifies ownership; returns 409 if any scan for the brand is still pending/running/summarising
 └─ marks `brands.historyDeletion = { status: 'queued', ... }`, returns 202 immediately, and drains findings/scans deletion in chunks
 └─ brand detail, brand list, and dashboard surfaces treat the brand as empty while that history purge is still in progress

GET /api/brands/[brandId]/findings/search?q=...
 └─ authenticated brand-scoped text search over lightweight finding summaries used by the brand page when the search box is non-empty
 └─ accepts optional `scanId`, `category`, `source`, `theme`, `limit`, and `cursor`
 └─ applies exact Firestore filters first where available, then server-side substring matching on `title`, `url`, `llmAnalysis`, and denormalized X handles
 └─ returns flat paginated matches annotated with `displayBucket` (`hit` | `non-hit` | `ignored` | `addressed`) plus scan-level context (`scanStartedAt`, `scanStatus`)
 └─ excludes matches from scans that are currently being deleted
 └─ includes cursor pagination and a scan-budget cap so very broad queries degrade gracefully instead of freezing the browser

Apify calls POST /api/webhooks/apify (on SUCCEEDED / FAILED / ABORTED)
 └─ validates X-Apify-Webhook-Secret header
 └─ on SUCCEEDED, atomically claims the actor run by transitioning it to `fetching_dataset` before any dataset fetch / AI analysis begins
 └─ if the scan's preference hints are still `pending`, the run is parked in `actorRuns.*.status = 'waiting_for_preference_hints'` and no analysis starts yet
 └─ once the scan-level preference hints are `ready` or `failed`, deferred succeeded callbacks are replayed through the same webhook route so they resume normal processing
 └─ duplicate callbacks for a run already in `fetching_dataset` / `analysing` are acknowledged and skipped before expensive work starts
 └─ fetches source-specific capped items from Apify dataset (source-level actor limits still apply before post-normalization chunked analysis: Google via requested SERP pages, Reddit via `maxPosts` + `maxTotalChargeUsd`, TikTok via `maxItems`, Discord via `maxTotalChargeUsd` spend cap, and GitHub / X via the requested `50..250` result volume)
 └─ Google Search mode: normalize SERP pages into compact organic-result candidates
      └─ excludes ads from AI analysis; keeps `relatedQueries` + `peopleAlsoAsk` as run-level context
      └─ stores scanner-aware sighting/debug metadata so merged findings can retain which logical scan surfaces saw a URL
      └─ dedupes repeated URLs within the run before analysis
      └─ skips normalized URLs that already appeared in previous scans for the same brand before any LLM analysis
      └─ chunked AI classification: bounded concurrent chunk calls (deterministically merged in chunk order)
      └─ in the default `llm-final` mode, chunk calls do classification only — they do not propose deep-search queries
      └─ the webhook collects the full deduped run-level `relatedQueries` + `peopleAlsoAsk` text signals (not URLs) and passes them to the final deep-search chooser without truncating them
 └─ Reddit mode: normalize dedicated Reddit actor records into compact post candidates
      └─ keeps only `kind == post` records and ignores comments entirely (`scrapeComments = false`)
      └─ exact-filters candidates by `created_utc >= scans.effectiveSettings.lookbackDate` after the actor's coarse `timeframe` filter
      └─ dedupes repeated Reddit post ids within the run before analysis
      └─ skips Reddit post ids that already appeared in previous scans for the same brand before any LLM analysis
      └─ chunked AI classification: bounded concurrent chunk calls (deterministically merged in chunk order)
      └─ stores one finding per Reddit post with canonical Reddit URL, matched query list, and post-level metadata in normalized debug payloads
      └─ depth 0 runs may ask the LLM for follow-up Reddit queries; each follow-up run is capped at `maxPosts = 20`, still ignores comments, and runs at depth 1 only
 └─ TikTok mode: normalize dedicated TikTok actor records into compact video candidates
      └─ accepts both the actor's richer structured video shape and raw `aweme_id` / `author` / `statistics` variants, then canonicalises to TikTok post URLs
      └─ exact-filters candidates by created-at time after the actor's coarse `dateRange` filter
      └─ dedupes repeated TikTok video ids within the run before analysis
      └─ skips TikTok video ids that already appeared in previous scans for the same brand before any LLM analysis
      └─ chunked AI classification: bounded concurrent chunk calls (deterministically merged in chunk order)
      └─ stores one finding per TikTok video with caption, author, hashtag, music, stats, matched query list, and run-level context in normalized debug payloads
      └─ depth 0 runs may ask the LLM for follow-up TikTok queries; each follow-up run is capped at `maxItems = 50` and runs at depth 1 only
 └─ Discord server mode: normalize joinable public-server records into compact server candidates
      └─ drops items without `vanity_url_code` because they do not yield a user-actionable invite URL
      └─ derives `https://discord.gg/<vanity_url_code>` as the stored/displayed URL
      └─ dedupes repeated server ids within the run before analysis
      └─ skips Discord server ids that already appeared in previous scans for the same brand before any LLM analysis
      └─ chunked AI classification: bounded concurrent chunk calls (deterministically merged in chunk order)
      └─ does not run deep-search suggestion generation or follow-up runs
 └─ GitHub mode: normalize public repository-search records into compact repository candidates
      └─ derives `https://github.com/<fullName>` as the stored/displayed URL
      └─ dedupes repeated repository `fullName` values within the run before analysis
      └─ skips repository `fullName` values that already appeared in previous scans for the same brand before any LLM analysis
      └─ chunked AI classification: bounded concurrent chunk calls (deterministically merged in chunk order)
      └─ does not run deep-search suggestion generation or follow-up runs
 └─ X mode: normalize public tweet records into compact tweet candidates
      └─ uses the returned tweet `url` / `twitterUrl` as the user-facing link
      └─ dedupes repeated tweet ids within the run before analysis
      └─ skips tweet ids that already appeared in previous scans for the same brand before any LLM analysis
      └─ chunked AI classification: bounded concurrent chunk calls (deterministically merged in chunk order)
      └─ X chunk output also labels whether the risk comes from the account handle, the tweet content, both, or neither
      └─ handle-only X hits are written the first time an account is seen, then suppressed on later tweets from the same previously-seen real-hit account unless the new tweet text is itself infringing
      └─ X findings denormalize `xAuthorId`, `xAuthorHandle`, `xAuthorUrl`, and `xMatchBasis` for lightweight list/search/UI use
      └─ depth 0 runs may ask the LLM for follow-up X queries; each follow-up run is capped at `maxItems = 30` and runs at depth 1 only
 └─ final deep-search selection defaults to a dedicated LLM pass that sees the full run-level intent signals and synthesizes follow-up queries directly; prompts inject the brand's allowed deep-search count and scanner-specific focus, and steer the model away from narrow named-site/platform/resource queries unless they are materially distinct abuse vectors
└─ AI-requested deep-search eligibility and breadth are read from `scans.effectiveSettings` when present, falling back to brand defaults only for older scans; Google deep-search runs reuse the brand's page depth, Reddit deep-search runs always cap each follow-up query at `maxPosts = 20`, TikTok deep-search runs always cap each follow-up query at `maxItems = 50`, and X deep-search runs always cap each follow-up query at `maxItems = 30`
└─ before each finding-level classification pass, the webhook loads the brand's existing finding `theme` labels so the LLM can preferentially reuse them
└─ for every chunked classification source, a failed or incomplete LLM chunk is retried once; if the retry also fails, that chunk's candidates are discarded entirely rather than stored as manual-review fallbacks
 └─ each classification prompt also receives the scan's resolved high/medium/low severity definitions, falling back to the current brand defaults only for older scans that predate the snapshot
 └─ one Finding written per normalized URL per scan (deterministic upsert; repeated URLs merged)
└─ each LLM-classified finding may also store a short primary `theme` label (prefer 1 word, hard max 3 words)
 └─ isFalsePositive: true findings are stored but excluded from default API responses
 └─ normalized Google URLs that already appeared in previous scans for the same brand are filtered out before AI analysis, so historical repeats never reach the classifier
 └─ a separate scan-level `userPreferenceHints` summary is still passed into classification prompts as soft guidance only; it is derived from explicit user ignore / reclassification signals and must not override clear evidence
 └─ (batch mode, depth 0 only) if ranked chunk/fallback suggestions are present on a supported run and the brand allows deep search → triggers deep-search runs
      └─ suggestions are reserved on the originating run so duplicate callbacks do not fan out extra searches
      └─ each deep-search run inherits the parent scanner policy, is registered on the scan document (actorRunIds, actorRuns), and preserves raw vs display query text separately
      └─ each deep-search Google run uses the same `brands.searchResultPages` setting as the initial search
      └─ each deep-search Reddit run uses the same `lookbackDate` as the initial Reddit scan but hard-caps the actor input to `maxPosts = 20`
      └─ each deep-search TikTok run uses the same `lookbackDate` as the initial TikTok scan but hard-caps the actor input to `maxItems = 50`
      └─ each deep-search X run uses the same `lookbackDate` as the initial X scan but hard-caps the actor input to `maxItems = 30`
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
- **Model:** `deepseek/deepseek-v3.2` via OpenRouter (overridable via `OPENROUTER_MODEL`)
- **Prompts:** `GOOGLE_CLASSIFICATION_SYSTEM_PROMPT` + `buildGoogleChunkAnalysisPrompt()` for chunked Google classification; `REDDIT_CLASSIFICATION_SYSTEM_PROMPT` + `buildRedditChunkAnalysisPrompt()` for chunked Reddit post classification; `TIKTOK_CLASSIFICATION_SYSTEM_PROMPT` + `buildTikTokChunkAnalysisPrompt()` for chunked TikTok video classification; `DOMAIN_REGISTRATION_CLASSIFICATION_SYSTEM_PROMPT` + `buildDomainRegistrationChunkAnalysisPrompt()` for chunked recent-domain-registration classification; `DISCORD_CLASSIFICATION_SYSTEM_PROMPT` + `buildDiscordChunkAnalysisPrompt()` for chunked Discord server classification; `GITHUB_CLASSIFICATION_SYSTEM_PROMPT` + `buildGitHubChunkAnalysisPrompt()` for chunked GitHub repository classification; `X_CLASSIFICATION_SYSTEM_PROMPT` + `buildXChunkAnalysisPrompt()` for chunked X post classification; `buildGoogleFinalSelectionSystemPrompt()` + `buildGoogleFinalSelectionPrompt()` for Google deep-search selection; `buildRedditFinalSelectionSystemPrompt()` + `buildRedditFinalSelectionPrompt()` for Reddit deep-search selection; `buildTikTokFinalSelectionSystemPrompt()` + `buildTikTokFinalSelectionPrompt()` for TikTok deep-search selection; `SCAN_SUMMARY_SYSTEM_PROMPT` + `buildScanSummaryPrompt()` for the final scan summary
- **Scan-level summary:** after all actor runs finish, the webhook runs one final LLM pass over the scan's actionable findings and stores a concise `aiSummary` on the scan document for the brand page
- **Watch words:** optional per-brand terms passed to the prompt builder; AI analysis is instructed to note any presence or implied association and use its discretion on severity impact
- **Safe words:** optional per-brand terms passed to the prompt builder; AI analysis is instructed to treat results containing these terms with reduced caution unless there are strong warning signs elsewhere
- **Historical URL suppression:** Google runs load previously seen normalized finding URLs for the brand and filter them out before any LLM classification begins
- **Historical Reddit suppression:** Reddit runs load previously seen Reddit post ids for the brand and filter them out before any LLM classification begins, including legacy Google-Reddit findings where the post id can still be recovered from stored URLs/debug data
- **Historical TikTok suppression:** TikTok runs load previously seen TikTok video ids for the brand and filter them out before any LLM classification begins
- **Historical Discord suppression:** Discord runs load previously seen Discord server ids for the brand and filter them out before any LLM classification begins
- **Historical GitHub suppression:** GitHub runs load previously seen repository `fullName` values for the brand and filter them out before any LLM classification begins
- **Historical X suppression:** X runs load previously seen tweet ids for the brand and filter them out before any LLM classification begins; after classification, handle-only hits are additionally suppressed for accounts that already have a previous real X finding for the brand
- **User preference hints:** each scan prepares a tiny LLM-authored soft-guidance summary from explicit user-review signals before actor-run analysis begins; this is now the only historical-review context sent into classification prompts
- **Existing taxonomy hints:** prompts receive the current brand's distinct `theme` labels so the LLM can reuse them exactly where appropriate, while still inventing a new short label when none fit
- **Scanner-aware prompt policy:** specialist Google scans reuse the same shared prompt builders, but small scanner-policy helpers inject specialist-focus instructions instead of duplicating whole prompt families
- **Google chunk output:** structured JSON `{ items: [{ resultId, title, severity, theme?, analysis, isFalsePositive }] }`
- **Debug prompt transcript:** the exact system + user prompt used for finding-level AI analysis is stored on each finding as `llmAnalysisPrompt` for `?debug=true` inspection
- **Raw AI response** string is stored on every finding as `rawLlmResponse` for debugging
- **False positives** are written to Firestore with `isFalsePositive: true`; filtered from default API responses; visible in the brand page "Non-hits" section

### Google Analysis Shape

Google Search results arrive as page-level SERP blobs. The webhook normalizes them into compact
organic-result candidates, dedupes repeated URLs within the run, and classifies those candidates
in bounded chunks. Google findings store a compact normalized debug payload
(`kind: 'google-normalized'`) with candidate metadata, merged sightings, SERP context, and any
legacy verified Reddit snapshot instead of the full page blobs. Normalized Google URLs that
already appeared in previous scans for the same brand are filtered out before chunking, so repeat
results do not trigger new LLM calls.

### Reddit Analysis Shape

Reddit post results arrive from the dedicated Reddit search actor as post-level records. The
webhook keeps only `kind: "post"` items, exact-filters them by the resolved `lookbackDate`,
dedupes by Reddit post `id`, and classifies those candidates in bounded chunks. Reddit findings
store a compact normalized debug payload (`kind: 'reddit-normalized'`) with post metadata,
matched query terms, and run-level context rather than raw actor responses.

### TikTok Analysis Shape

TikTok video results arrive from the dedicated TikTok search actor as public video records. The
webhook normalizes both the actor's richer `title` / `channel` / `song` shape and its raw
`aweme_id` / `author` / `statistics` variant into compact video candidates, exact-filters them by
the resolved `lookbackDate`, dedupes by TikTok video `id`, and classifies those candidates in
bounded chunks. TikTok findings store a compact normalized debug payload
(`kind: 'tiktok-normalized'`) with caption, author, hashtag, music, stats, matched query terms,
and run-level context rather than raw actor responses.

See `REVIEW.md` for full prompt text and AI analysis pipeline details.

### Discord Analysis Shape

Discord server results arrive as public community-discovery records. The webhook normalizes them
into compact joinable-server candidates, drops records without `vanity_url_code`, dedupes by
Discord server `id`, and classifies those candidates in bounded chunks. Discord findings store a
compact normalized debug payload (`kind: 'discord-normalized'`) with server metadata, run-level
context, and the derived invite URL rather than the full raw actor response.

### GitHub Analysis Shape

GitHub repo results arrive as public repository-search records. The webhook normalizes them into
compact repository candidates, dedupes by repo `fullName`, and classifies those candidates in
bounded chunks. GitHub findings store a compact normalized debug payload
(`kind: 'github-normalized'`) with repository metadata and run-level query context rather than
the full raw actor response.

### X Analysis Shape

X results arrive as public tweet records. The webhook normalizes them into compact tweet
candidates, dedupes by tweet `id`, and classifies those candidates in bounded chunks. X findings
store a compact normalized debug payload (`kind: 'x-normalized'`) with tweet metadata, author
metadata, run-level query context, and the stored `xMatchBasis` rather than the full raw actor
response. The stored finding document also denormalizes `xAuthorId`, `xAuthorHandle`, and
`xAuthorUrl` so the UI can show handles under the title and include them in lightweight search.

### Deep search (`suggestedSearches`)

When any logical Google scanner runs at depth 0 (initial scan), the webhook collects the full
deduped run-level `relatedQueries` and `peopleAlsoAsk` text signals from every SERP page.
Chunked Google classification assesses candidates only; it does not propose deep-search queries.
The final deep-search chooser then sees that run-level intent context directly and synthesizes up
to the brand's configured `maxAiDeepSearches` follow-up queries (1-5). Google prompts treat that
configured count as a hard cap rather than a target, and steer the model towards broader
theme-led queries instead of narrow named websites, platforms, resources, books, or tools unless
a named target is itself the key abuse vector. Specialist scanners additionally receive
platform-specific focus guidance, while query execution still applies the actual `site:` /
`-site:` operators outside the user-visible UI.

When `reddit-posts` runs at depth 0, the webhook can also ask a dedicated Reddit deep-search
chooser for up to the brand's configured `maxAiDeepSearches` follow-up Reddit queries using the
run's observed subreddits, authors, and sample post titles as context. Each suggested Reddit
query starts a separate follow-up Reddit actor run capped at `maxPosts = 20`, still with
`scrapeComments = false`, and those follow-up runs stop at depth 1.

When `tiktok-posts` runs at depth 0, the webhook can also ask a dedicated TikTok deep-search
chooser for up to the brand's configured `maxAiDeepSearches` follow-up TikTok queries using the
run's observed author handles, hashtags, and sample captions as context. Each suggested TikTok
query starts a separate follow-up TikTok actor run capped at `maxItems = 50`, and those
follow-up runs stop at depth 1.

When `x-search` runs at depth 0, the webhook can also ask a dedicated X deep-search chooser for up
to the brand's configured `maxAiDeepSearches` follow-up X queries using the run's observed author
handles, languages, and sample tweet text as context. Each suggested X query starts a separate
follow-up X actor run capped at `maxItems = 30`, and those follow-up runs stop at depth 1.

`discord-servers` does not support deep search. Even when the brand-level deep-search toggle is
enabled, Discord runs stay initial-scan-only and never reserve or execute follow-up searches.

`domain-registrations` does not support deep search. Even when the brand-level deep-search toggle
is enabled, domain-registration runs stay initial-scan-only and never reserve or execute
follow-up searches.

`github-repos` also does not support deep search. Even when the brand-level deep-search toggle is
enabled, GitHub runs stay initial-scan-only and never reserve or execute follow-up searches.

Deep search is only enabled for supported Google-backed, Reddit, TikTok, and X scan types when the
brand's `allowAiDeepSearches` setting is true.

The webhook handler calls `startDeepSearchRun()` for each supported suggested query, registers
the new Apify run IDs on the scan document, and processes results via the same webhook pipeline at
depth 1. Deep-search runs never produce further follow-ups (hard loop guard:
`searchDepth === 0` check before triggering). Suggested queries are reserved on the originating
run before any new Apify runs are started, so duplicate webhook callbacks do not fan out
duplicate deep-search runs.
`markActorRunComplete` always reads `actorRunIds.length` from a fresh Firestore snapshot inside
its transaction, so dynamically-added runs are counted correctly for scan completion. Deep-search
runs are skipped entirely when `allowAiDeepSearches` is false for the brand. When enabled, both
the initial Google scan and each deep-search Google run use the brand's `searchResultPages`
setting, while TikTok initial runs map the same depth to a `100..500` total video budget and each
deep-search TikTok run stays fixed at `maxItems = 50`, and X initial runs map the same depth to a
`50..250` total tweet budget while each deep-search X run stays fixed at `maxItems = 30`.

`ActorRunInfo` now carries `scannerId`, `searchDepth`, raw `searchQuery`, operator-free
`displayQuery`, and optional explicit `searchQueries[]` / `displayQueries[]` arrays for batched
runs. The brand page progress indicator groups active work by source (`Web search`,
`Reddit`, `TikTok`, `YouTube`, `Facebook`, `Instagram`, `Telegram channels`, `Apple App Store`,
`Google Play`, `Discord servers`, `GitHub repos`, `X`),
lets the user switch between those source-specific progress bars, and only ever surfaces
`displayQuery` so internal Google `site:` / `-site:` operators are never shown to users.

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

Findings can now carry one optional lightweight taxonomy label: `theme`.

**Behaviour:**
- Labels are LLM-assigned during finding classification for newly analysed findings only; existing historical findings are not backfilled automatically
- Labels are brand-scoped: the webhook loads the current brand's existing labels before classification so the LLM can prefer exact reuse where appropriate
- Labels are intentionally short for UI/filtering purposes: prefer 1 word where natural, hard maximum 3 words
- The brand page shows these labels subtly on finding cards when present
- The brand page also supports client-side theme filtering alongside the existing free-text search, source filter, and severity filter, and the active filters apply to whichever findings tab is currently in view (`Scans`, `Bookmarks`, `Addressed`, or `Ignored`)

**API:**
- `GET /api/brands/[brandId]/findings/taxonomy` — returns distinct brand-scoped `themes[]` for filter dropdowns

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
- Brands with `brandDeletion` are hidden from the dashboard brand picker; brands with `historyDeletion` remain selectable but report zero terminal scans/counts until deletion completes
- Dashboard KPI totals come from denormalized per-scan `highCount`, `mediumCount`, `lowCount`, and `nonHitCount` fields so all-time rollups do not require hydrating every finding
- Each scan also stores `dashboardBreakdowns = { version, source[], theme[] }`, a compact per-scan summary used by the dashboard charts so `GET /api/dashboard/metrics` does not need to load raw findings during normal reads
- The scan-type and theme charts aggregate those stored scan-level summaries for the selected scope and use the same visible-count semantics as the rest of the app: actionable hits plus non-hits, excluding ignored and addressed real findings
- Scan completion writes the latest dashboard breakdowns, finding PATCH mutations rebuild the affected scans' breakdowns after ignore/address/reclassify actions, and the metrics route can lazily backfill older scans that predate the field
- Missing `theme` labels are grouped into an `Unlabelled` chart bucket
- Each chart row also tracks the newest matching scan id per severity bucket so stacked-bar segments can drill into the brand page
- Scan-type chart drill-down links navigate to the brand page with `scanResultSet`, `category`, and optional `source` query params so the matching scan opens with the relevant scan-type filter state applied
- Theme chart drill-down links navigate to the brand page with `scanResultSet`, `category`, and optional `theme` query params so the matching scan opens with the relevant filter state applied
- Dashboard severity metric cards use the same drill-down pattern, applying the matching `category` filter and, when a specific scan is in scope, anchoring into the relevant section of that scan
- Dashboard-originated links into a brand page also carry `returnTo=dashboard`, so the brand-page back arrow returns to the dashboard instead of the brands index for that navigation path
- When a brand has no terminal scans yet, the dashboard shows a CTA to run the first scan; if the first scan is already in progress, it instead shows a progress-focused CTA linked to the brand page

**API:**
- `GET /api/dashboard/bootstrap` — returns brand selector options plus the resolved selected brand id
- `PATCH /api/dashboard/preferences` — persists `{ selectedBrandId }` on the authenticated user document
- `GET /api/dashboard/metrics?brandId=...&scanId=...` — returns scan selector options, KPI totals, active-scan state, and the scan-type/theme stacked-bar datasets

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `APIFY_API_TOKEN` | Apify platform token |
| `APIFY_WEBHOOK_SECRET` | Shared secret for webhook validation |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `CODEPUNCH_API_KEY` | CodePunch API key used by the recent-domain-registrations actor |
| `CODEPUNCH_API_SECRET` | CodePunch API secret used by the recent-domain-registrations actor |
| `OPENROUTER_MODEL` | AI analysis model override (default: `deepseek/deepseek-v3.2`) |
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
| `users` | id, email, passwordHash, **sessionVersion?**, **lastSeenAt?**, **passwordChangedAt?**, **dashboardPreferences?** (`selectedBrandId?`), **emailVerified?**, **emailVerificationVersion?**, **emailVerifiedAt?**, createdAt |
| `inviteCodes` | id (`sha256(code)`), codeHash, createdAt, **usedAt?**, **usedByEmail?**, **usedByUserId?** |
| `authRateLimits` | id (`<scope>:<sha256(client-identifier)>`), scope, keyHash, attemptCount, windowStartedAt, lastAttemptAt |
| `brands` | id, userId, name, keywords[], officialDomains[], **sendScanSummaryEmails?**, **searchResultPages?**, **lookbackPeriod?** (`1year`\|`1month`\|`1week`\|`since_last_scan`, default `1year`), **allowAiDeepSearches?**, **maxAiDeepSearches?**, **scanSources?** (`google`, `reddit`, `tiktok`, `youtube`, `facebook`, `instagram`, `telegram`, `apple_app_store`, `google_play`, `domains`, `discord`, `github`, `x`), **activeScanId?**, watchWords[]?, safeWords[]?, **scanSchedule?** (`enabled`, `frequency`, `timeZone`, `startAt`, `nextRunAt`, `lastTriggeredAt?`, `lastScheduledScanId?`), **historyDeletion?**, **brandDeletion?** (`status`, `requestedAt`, `startedAt?`, `lastHeartbeatAt?`, `leaseExpiresAt?`), **lookbackNudgeDismissed?**, createdAt, updatedAt |
| `scans` | id, brandId, userId, status (`pending`\|`running`\|`summarising`\|`completed`\|`failed`\|`cancelled`), **deletion?** (`status`, `requestedAt`, `startedAt?`, `lastHeartbeatAt?`, `leaseExpiresAt?`), actorIds[], actorRuns{} (`scannerId`, `source`, `status`, `datasetId?`, `itemCount?`, `analysedCount?`, `skippedDuplicateCount?`, `searchDepth?`, `searchQuery?`, `displayQuery?`, `deepSearchSuggestionsProcessed?`, `suggestedSearches?`), completedRunCount, findingCount, **highCount, mediumCount, lowCount, nonHitCount, ignoredCount, addressedCount, skippedCount, dashboardBreakdowns?** (`version`, `source[]`, `theme[]` compact dashboard chart summaries), **userPreferenceHintsStatus?, userPreferenceHints?, userPreferenceHintsError?, userPreferenceHintsStartedAt?, userPreferenceHintsCompletedAt?, aiSummary?, summaryStartedAt?**, **scanSummaryEmailStatus?**, **scanSummaryEmailAttemptedAt?**, **scanSummaryEmailSentAt?**, **scanSummaryEmailMessageId?**, **scanSummaryEmailError?** (denormalized completion + notification metadata), startedAt, completedAt |
| `findings` | id, scanId, brandId, userId, source (`google`\|`reddit`\|`tiktok`\|`youtube`\|`facebook`\|`instagram`\|`telegram`\|`apple_app_store`\|`google_play`\|`domains`\|`discord`\|`github`\|`x`\|`unknown`), actorId, severity, title, **theme?**, description, llmAnalysis, url?, **xAuthorId?**, **xAuthorHandle?**, **xAuthorUrl?**, **xMatchBasis?** (`none`\|`handle_only`\|`content_only`\|`handle_and_content`), rawData, llmAnalysisPrompt?, isFalsePositive?, isIgnored?, ignoredAt?, **userPreferenceSignal?**, **userPreferenceSignalReason?**, **userPreferenceSignalAt?**, **userReclassifiedFrom?**, **userReclassifiedTo?**, **isAddressed?**, **addressedAt?**, **isBookmarked?**, **bookmarkedAt?**, **bookmarkNote?** (per-finding user note), rawLlmResponse?, createdAt |

---

## User Management

Signup is available through the web UI and `POST /api/auth/signup`, but it now requires a valid **single-use invite code**. Registration attempts are rate-limited per client identifier on the server to make invite-code brute forcing materially harder.

To provision internal accounts directly, use the CLI:

```bash
# Run from the app/ directory
npm run add-user -- --email user@example.com --password secret123
```

Script: `app/scripts/add-user.ts`. Reads `.env.local` automatically (same file used by `next dev`).

To provision invite codes for limited rollout access:

```bash
# Run from the app/ directory
npm run add-invite-code
npm run add-invite-code -- --count 5
```

Script: `app/scripts/add-invite-code.ts`. Invite codes are 10-character lowercase alphanumeric values, stored hashed in Firestore, and burned on first successful signup.

New signups must also verify their email address before they can sign in. The verification flow:

- stores `users.emailVerified = false` plus a monotonic `users.emailVerificationVersion`
- signs verification JWTs with both `sessionVersion` and `emailVerificationVersion`
- treats resend requests as rotation events by incrementing `emailVerificationVersion`, so only the newest unredeemed link remains valid
- redeems verification links inside a Firestore transaction that checks email, `sessionVersion`, `emailVerificationVersion`, and `emailVerified == false`
- marks the account verified and bumps `emailVerificationVersion` on success, making the redeemed link one-time use
- does not authenticate the browser during verification; the user must sign in normally after their email is confirmed

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
- **Dedicated taxonomy bootstrap** — the brand page loads `GET /api/brands/[brandId]/findings/taxonomy` on mount (and after scan-history changes) so the theme filter dropdown can populate without hydrating every scan bucket first
- **Dedicated server-backed text search** — when the brand-page search box is non-empty, the UI now calls `GET /api/brands/[brandId]/findings/search` instead of hydrating every scan bucket into the browser. The route pages through lightweight `FindingSummary` projections server-side, applies substring matching on `title`, `url`, `llmAnalysis`, and denormalized X handles, honours the active severity/source/theme filters, and returns flat paginated results with bucket metadata for a dedicated search-results mode.
- **Lightweight list payloads** — the findings list endpoints (`GET /api/brands/[brandId]/findings` and `GET /api/findings`) return a compact `FindingSummary` shape via Firestore `.select(...)`, excluding `rawData`, `llmAnalysisPrompt`, `rawLlmResponse`, and other fields not needed for normal rendering. This avoids repeatedly shipping the full SERP batch payload on every finding card.
- **Dedicated scan export paths** — `GET /api/brands/[brandId]/scans/[scanId]/export` performs a single scan-scoped findings query and returns a CSV attachment containing hits, non-hits, notes, and review-state flags, while `GET /api/brands/[brandId]/scans/[scanId]/export/pdf` returns a branded PDF report containing the scan AI summary, actionable high/medium/low findings, notes, and a dedicated addressed-findings section. Neither path forces the UI to eagerly load every findings bucket first.
- **Dashboard bootstrap + metrics split** — the main dashboard uses `GET /api/dashboard/bootstrap` for brand selection state and `GET /api/dashboard/metrics` for brand/scan-scoped analytics, instead of reusing the lightweight recent-findings feed.
- **All-time dashboard totals** — dashboard KPI cards use terminal scan denormalized counts, while the stacked scan-type and theme charts aggregate selected findings with a minimal Firestore `.select(...)` projection.
- **Recent activity feed remains lightweight** — `GET /api/findings` still pages through the newest findings until it has filled the requested limit, instead of always fetching a fixed `limit * 4` window and filtering in memory. This keeps that cross-brand recent-activity query close to the number of cards rendered.
- **Debug details fetched on demand** — `FindingCard` fetches `GET /api/brands/[brandId]/findings/[findingId]` only when a debug section is opened (`?debug=true`). Normal list views never load raw actor data or raw AI responses.
- **No redundant brand ownership checks on per-scan findings** — the `GET /api/brands/[brandId]/findings` route relies solely on `userId == uid` in the Firestore query for authorization (no extra brand doc read per request). The PATCH (ignore/un-ignore) route similarly skips the brand doc read, verifying ownership via the finding document itself.

---

## Key Docs

- [`docs/GCP_SETUP.md`](docs/GCP_SETUP.md) — GCP / Firestore / Cloud Run setup
- [`docs/PIPELINE_SETUP.md`](docs/PIPELINE_SETUP.md) — Apify, OpenRouter, ngrok, env vars
- [`REVIEW.md`](REVIEW.md) — Ongoing scan quality review: actor details and AI analysis prompts
