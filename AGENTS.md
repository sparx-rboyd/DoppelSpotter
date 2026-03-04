# DoppelSpotter — Architecture & Agent Notes

This file provides a concise architectural overview for AI coding agents and contributors.
Keep it up to date when making significant structural changes.

---

## Project Overview

**DoppelSpotter** is an AI-powered brand protection web app for SMEs. It monitors the web for
brand infringement (lookalike domains, fake social accounts, clone apps, trademark squatting)
using Apify actors for scraping and an LLM for classification.

**Stack:**
- Frontend / API: Next.js 15 (App Router), TypeScript, Tailwind CSS
- Database: Google Cloud Firestore
- Scraping: Apify platform (hosted actors)
- LLM: OpenRouter → `anthropic/claude-3.5-haiku` (default)
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
│       │       ├── brands/       # CRUD + findings per brand
│       │       ├── findings/     # Cross-brand findings query
│       │       ├── scan/         # Trigger scan + poll status
│       │       └── webhooks/apify/  # Apify webhook receiver → LLM pipeline
│       └── lib/
│           ├── apify/
│           │   ├── actors.ts     # ACTOR_REGISTRY — all actor definitions + enable/disable
│           │   └── client.ts     # Apify client: startActorRun, buildActorInput, fetchDatasetItems
│           └── analysis/
│               ├── prompts.ts    # SYSTEM_PROMPT + buildAnalysisPrompt()
│               ├── openrouter.ts # LLM client: chatCompletion()
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
  └─ reads CORE_ACTOR_IDS (or actorIds from request body)
  └─ calls startActorRun() for each actor → registers Apify webhook
       └─ stores runId → scan document in Firestore

Apify calls POST /api/webhooks/apify (on SUCCEEDED / FAILED / ABORTED)
  └─ validates X-Apify-Webhook-Secret header
  └─ fetches up to 50 items from Apify dataset
  └─ for each item: calls LLM → writes Finding to Firestore (all items, including false positives)
       └─ isFalsePositive: true findings are stored but excluded from default API responses
  └─ marks actor run complete; if all runs done → marks scan complete
```

---

## LLM Analysis

- **File:** `app/src/lib/analysis/`
- **When:** Once per dataset item, sequentially, inside the webhook handler
- **Model:** `anthropic/claude-3.5-haiku` via OpenRouter (overridable via `OPENROUTER_MODEL`)
- **Prompts:** `SYSTEM_PROMPT` and `buildAnalysisPrompt()` in `prompts.ts`
- **Output:** structured JSON `{ severity, title, llmAnalysis, isFalsePositive }`
- **Raw LLM response** string is stored on every finding as `rawLlmResponse` for debugging
- **False positives** are written to Firestore with `isFalsePositive: true`; filtered from default API responses; visible in the brand page "Non-hits" section

See `REVIEW.md` for full prompt text and LLM pipeline details.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `APIFY_API_TOKEN` | Apify platform token |
| `APIFY_WEBHOOK_SECRET` | Shared secret for webhook validation |
| `WHOISXML_API_KEY` | WhoisXML Brand Alert API key (custom actor) |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OPENROUTER_MODEL` | LLM model override (default: `anthropic/claude-3.5-haiku`) |
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
| `brands` | id, userId, name, keywords[], officialDomains[], createdAt, updatedAt |
| `scans` | id, brandId, userId, status, actorIds[], actorRuns{}, completedRunCount, findingCount, startedAt, completedAt |
| `findings` | id, scanId, brandId, userId, source, actorId, severity, title, description, llmAnalysis, url?, rawData, isFalsePositive?, rawLlmResponse?, createdAt |

---

## User Management

Signup via the web UI and API is **disabled** during development. Use the CLI to create accounts:

```bash
# Run from the app/ directory
npm run add-user -- --email user@example.com --password secret123
```

Script: `app/scripts/add-user.ts`. Reads `.env.local` automatically (same file used by `next dev`).

---

## Key Docs

- [`docs/GCP_SETUP.md`](docs/GCP_SETUP.md) — GCP / Firestore / Cloud Run setup
- [`docs/PIPELINE_SETUP.md`](docs/PIPELINE_SETUP.md) — Apify, OpenRouter, ngrok, env vars
- [`REVIEW.md`](REVIEW.md) — Ongoing scan quality review: actor details and LLM prompts
