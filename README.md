# DoppelSpotter

AI-powered brand protection for SMEs, built for the GenAI Zurich 2026 Hackathon (Apify Track).

DoppelSpotter monitors the open web, communities, code platforms, domain registrations, and app stores for signs of brand abuse. It then uses generative AI to classify likely threats, suppress noise, surface patterns, and turn the output into searchable findings, dashboards, reports, and email summaries.

[Published Apify Actor](https://apify.com/doppelspotter/recent-domain-registrations) | [Pitch Page Source](landing-page/index.html) | [App Source](app/) | [Actor Source](actors/recent-domain-registrations/)

## What This Repo Contains

This repository contains four closely related pieces of work:

1. The hackathon submission story and supporting materials.
2. The pitch page used to explain the product and challenge fit.
3. The main Next.js application that runs the brand-protection workflow.
4. A published Apify actor for recent domain registrations that can be used both inside and outside the app.

## Hackathon Submission

DoppelSpotter was built for the GenAI Zurich 2026 Hackathon, in the Apify track.

The project deliberately covers both sides of the challenge:

- `Path 1: AI Agent` - an end-to-end autonomous workflow that gathers live web data, classifies findings with an LLM, and produces ranked, reviewable outputs.
- `Path 3: Build an Actor` - a reusable, published Apify actor for recent domain registrations, available in the Apify Store.

Why this is a strong hackathon submission:

- It solves a real business problem: SMEs are exposed to impersonation, phishing, cloned apps, fake communities, and counterfeit promotion, but rarely have enterprise-grade monitoring.
- It uses live web data rather than a static or synthetic demo.
- It uses Apify as core infrastructure, not as a decorative integration.
- It uses generative AI both in the product experience and in the build process.
- It ships both a working application and a standalone reusable actor.

## At A Glance

- `13 logical scan surfaces` across web, social, communities, code, domains, and app stores.
- `5 underlying Apify actors` powering the monitoring pipeline.
- `AI triage` for severity scoring, theme labelling, false-positive suppression, scan summaries, and deep-search follow-ups.
- `User review workflow` with ignore, address, bookmark, notes, search, and filtering.
- `Operational outputs` including dashboard analytics, CSV export, PDF reports, and optional scan-summary emails.
- `Published actor` for recent domain registrations with optional AI homepage analysis.

## The Product

DoppelSpotter is designed for a simple user journey:

1. Create a brand profile with a name, keywords, and official domains.
2. Choose which scan sources are enabled, how deep to search, how far back to look, and whether AI deep search is allowed.
3. Run scans manually or schedule them to recur automatically.
4. Let Apify actors gather live results from the selected surfaces.
5. Let the app normalize, deduplicate, and classify those results with an LLM.
6. Review findings in the dashboard and brand pages, then ignore, address, bookmark, or annotate them.
7. Export evidence as PDF or CSV, or receive a summary email when the scan finishes.

### Supported Scan Surfaces

| Surface | Logical scanners | Backing actor |
| --- | --- | --- |
| Web and specialist Google scans | Web, Reddit, TikTok, YouTube, Facebook, Instagram, Telegram, Apple App Store, Google Play | `apify/google-search-scraper` |
| Recent domain registrations | Domain registrations | `doppelspotter/recent-domain-registrations` |
| Public communities | Discord servers | `louisdeconinck/discord-server-scraper` |
| Code platforms | GitHub repos | `ryanclinton/github-repo-search` |
| Social posts | X | `apidojo/tweet-scraper` |

### Why The Breadth Matters

Brand abuse does not stay in one channel. A single campaign can span lookalike domains, fake social accounts, cloned app listings, Discord communities, leaked code repositories, and promotional posts. DoppelSpotter is intentionally multi-surface so the product story is stronger than "Google alerts with AI on top."

## Pitch Page

The pitch page lives in `landing-page/` and is deployed separately from the app.

It is designed to communicate the hackathon submission quickly to judges, partners, or anyone landing on the repository. The page focuses on:

- the business problem
- the product solution
- the technical architecture
- the Apify actor suite
- the role of generative and agentic AI
- explicit alignment with the GenAI Zurich Apify challenge

### Pitch Page Tech

- Static HTML in `landing-page/index.html`
- Tailwind CSS via CDN
- Lucide icons
- Cloudflare asset deployment configured in `wrangler.toml`

### Pitch Page Purpose

The pitch page is not just marketing collateral. It is the fast, visual explanation of:

- what DoppelSpotter does
- why the problem matters
- why Apify is central to the solution
- how AI is used in the product
- why the submission is credible as a hackathon project

## The App

The main app lives in `app/`.

It is a Next.js 15 application that combines a web UI with API routes for auth, brand management, scan orchestration, analytics, exports, scheduled scanning, and Apify webhook handling.

### App Stack

| Layer | Technology |
| --- | --- |
| Frontend and API | Next.js 15, React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Database | Google Cloud Firestore |
| Scraping and orchestration | Apify actors and Apify webhooks |
| AI analysis | OpenRouter, defaulting to `deepseek/deepseek-v3.2` |
| Email delivery | MailerSend |
| App hosting | Google Cloud Run |
| App CI/CD | Google Cloud Build |

### Core App Capabilities

- Invite-based signup and authenticated user accounts.
- Email verification, password reset, password change, and account deletion flows.
- Brand profiles with keywords, official domains, watch words, and safe words.
- Per-brand scan-source toggles across all supported monitoring surfaces.
- Search depth, lookback period, AI deep-search controls, and recurring schedules.
- Concurrent actor-run startup with webhook-driven completion handling.
- AI classification into `high`, `medium`, `low`, and `non-hit`.
- Theme labelling for lightweight taxonomy and filtering.
- User review actions including ignore, address, bookmark, and per-finding notes.
- Searchable scan history plus cross-scan bookmarked, addressed, and ignored views.
- Brand-scoped dashboard analytics with drill-down charts.
- CSV export and branded PDF export for completed scans.
- Optional scan-summary emails after completion.

### How The App Pipeline Works

1. A user creates or updates a brand profile.
2. The app resolves the enabled scan surfaces and effective scan settings.
3. It starts all relevant Apify actor runs concurrently.
4. Apify sends webhook callbacks when runs complete.
5. The app fetches each dataset, normalizes results per source, and deduplicates them.
6. The AI layer classifies findings, assigns severity, and optionally assigns a short theme label.
7. For supported Google-backed, Reddit, TikTok, and X scans, the AI can trigger follow-up deep-search runs.
8. Once all runs finish, the app writes a scan-level AI summary and final counts.
9. Findings become available in the brand page, dashboard, exports, and optional email summaries.

### Review Workflow

The app is not only about detection. It is also about making results manageable over time.

- `Ignore` removes false positives from normal views and helps suppress similar results in future scans.
- `Addressed` moves dealt-with threats out of the active queue while retaining history.
- `Bookmark` keeps important findings easy to revisit.
- `Notes` let users track next steps or case context on individual findings.
- `Theme filters`, `source filters`, and `server-backed search` make large result sets usable.

### Deep Search

Deep search is supported for Google-backed scan surfaces plus the first-class Reddit, TikTok, and X scan types.

After the initial scan, the app can use the run-level context to synthesize more targeted follow-up searches. This is intended to uncover adjacent abuse vectors without requiring the user to manually craft every secondary query.

## The Published Actor

The custom actor lives in `actors/recent-domain-registrations/`.

Published listing:

- [doppelspotter/recent-domain-registrations](https://apify.com/doppelspotter/recent-domain-registrations)

### What The Actor Does

The actor searches the CodePunch GTLD Domain Name Activity Feed v2 for newly added domains matching one or more keywords.

It supports:

- keyword search
- date filtering with comparison operators
- optional TLD filtering
- automatic pagination
- one dataset item per matching domain
- optional AI-enhanced homepage analysis for each matching domain

### Why The Actor Matters

This actor is important for two reasons:

1. It is a useful standalone building block for anyone doing domain-watch or brand-protection work.
2. It proves that DoppelSpotter contributes something reusable back to the Apify ecosystem, instead of only consuming existing actors.

### Actor Inputs

The actor accepts:

- `apiKey` and `apiSecret` for CodePunch
- `date` and `dateComparison`
- `keywords`
- optional `tlds`
- optional `enhancedAnalysisEnabled`
- optional `openRouterApiKey`
- optional `openRouterModel`
- optional sorting fields
- optional `totalLimit`

### Actor Outputs

Each dataset item contains the upstream domain-registration fields plus:

- `requestMetadata`
- `responseMetadata`
- `enhancedAnalysis`

When enhanced analysis is enabled, the actor fetches the top-level homepage, extracts visible text, and sends batches to OpenRouter for short summaries. In standalone actor runs, the default analysis model is `deepseek/deepseek-v3.2` unless overridden.

### How The App Uses The Actor

Inside DoppelSpotter itself, the actor is used as one scan surface within the broader pipeline:

- the app passes brand terms as keywords
- the app uses the scan's resolved lookback date with `dateComparison: gte`
- enhanced analysis is enabled automatically
- result volume scales with the brand's configured search depth
- the output is normalized into domain findings alongside the app's other scan surfaces

## End-To-End Architecture

The system is intentionally modular:

1. `landing-page/` explains the product and hackathon story.
2. `app/` handles authentication, brand configuration, scan orchestration, review workflows, analytics, and exports.
3. `actors/recent-domain-registrations/` provides a reusable source-specific actor.
4. Apify actors gather live data.
5. Firestore stores users, brands, scans, and findings.
6. OpenRouter powers finding classification and scan summaries.
7. Cloud Run hosts the app, while Cloudflare serves the pitch page.

## Repository Layout

```text
.
├── AGENTS.md
├── README.md
├── cloudbuild.yaml
├── package.json
├── wrangler.toml
├── landing-page/
│   ├── index.html
│   └── ...
├── app/
│   ├── Dockerfile
│   ├── package.json
│   ├── scripts/
│   └── src/
└── actors/
    └── recent-domain-registrations/
        ├── README.md
        ├── package.json
        ├── src/main.mjs
        └── .actor/
```

## Local Development

### Prerequisites

- Node.js `22+` for the app
- Node.js `20+` or newer for the actor codebase
- A Firestore project
- An Apify API token
- An OpenRouter API key
- CodePunch credentials for domain-registration scanning
- MailerSend credentials if you want email flows

### Install Root Dependencies

The repository root is mainly for the pitch page deployment and convenience scripts:

```bash
npm install
```

### Run The App

```bash
cd app
npm install
npm run dev
```

Useful scripts in `app/`:

```bash
npm run build
npm run start
npm run lint
npm run type-check
npm run add-user -- --email user@example.com --password secret123
npm run add-invite-code
npm run backfill-scan-counts
```

### Work On The Pitch Page

The pitch page source is in `landing-page/index.html`.

Deploy it from the repository root with:

```bash
npm run deploy
```

### Work On The Actor

```bash
cd actors/recent-domain-registrations
npm install
npm start
```

Or from the repository root:

```bash
npm run actor:recent-domain-registrations:run
```

The actor reads Apify actor input at runtime, so local execution is easiest when you already have an Apify-compatible local input setup or when testing it through the Apify platform.

### Local Webhook Note

For true end-to-end scan testing, Apify needs to call back into the app's webhook endpoint. That means `APP_URL` must be publicly reachable during local development.

## Environment Variables For The App

| Variable | Required | Purpose |
| --- | --- | --- |
| `APIFY_API_TOKEN` | Yes | Starts and manages Apify actor runs. |
| `APIFY_WEBHOOK_SECRET` | Yes | Validates incoming Apify webhook callbacks. |
| `OPENROUTER_API_KEY` | Yes | Used for finding classification, scan summaries, and domain actor integration inside the app. |
| `OPENROUTER_MODEL` | No | Overrides the default app model (`deepseek/deepseek-v3.2`). |
| `CODEPUNCH_API_KEY` | Yes for domain scans | Used when the app starts the recent-domain-registrations actor. |
| `CODEPUNCH_API_SECRET` | Yes for domain scans | Used when the app starts the recent-domain-registrations actor. |
| `MAILERSEND_API_TOKEN` | Optional | Enables transactional emails such as verification, reset, and scan summaries. |
| `AUTH_JWT_SECRET` | Yes | Signs auth cookies and password-reset / verification tokens. |
| `SCHEDULE_DISPATCH_SERVICE_ACCOUNT_EMAIL` | Optional unless using scheduled scans in production | Restricts the scheduled-scan dispatch endpoint to the expected Google service account. |
| `GCP_PROJECT_ID` | Yes | Firestore project ID. |
| `FIRESTORE_DATABASE_ID` | No | Firestore database ID, defaults to `(default)`. |
| `APP_URL` | Yes | Public base URL used for callbacks and links. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Local dev only | Path to a Google service account JSON file for Firestore access. |

## Deployment Model

### App Deployment

- The app is built from `app/Dockerfile`.
- `cloudbuild.yaml` builds the image, pushes it to Artifact Registry, and deploys it to Cloud Run.
- Runtime environment variables are expected to be managed on the Cloud Run service.
- The Cloud Build trigger is scoped so `app/**` changes deploy the app without being triggered by landing-page-only edits.

### Pitch Page Deployment

- The pitch page is deployed separately from the repository root.
- `wrangler.toml` points Cloudflare at the `landing-page/` assets directory.

## Why The Pieces Belong Together

This repository works best when read as a complete submission rather than three unrelated folders.

- The `landing-page/` tells the story.
- The `app/` proves the full workflow exists and is usable.
- The published actor proves reusable technical depth beyond the core app.

Together they show a credible hackathon project with product thinking, user workflow design, live data integrations, and a reusable artifact published back to the ecosystem.

## Further Reading

- Root architecture notes: `AGENTS.md`
- Pitch page source: `landing-page/index.html`
- Actor documentation: `actors/recent-domain-registrations/README.md`
