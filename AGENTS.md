# DoppelSpotter — Project Guide

AI-powered brand protection for SMEs. This repository is the submission for the **GenAI Zürich 2026 Hackathon, Apify Track**.

---

## Repository Structure

```
.
├── AGENTS.md              # This file — project overview for AI agents and developers
├── PITCH.md               # Full written pitch: problem, solution, architecture, challenge alignment
├── cloudbuild.yaml        # Cloud Build CI/CD pipeline (builds & deploys app/ to Cloud Run)
├── package.json           # Root-level scripts (deploy landing page)
├── wrangler.toml          # Cloudflare Workers config for landing page
├── landing-page/          # Static pitch/project site (deployed to Cloudflare Pages)
│   ├── index.html         # Single-page site (also contains app UI mockup)
│   ├── logo.svg           # DoppelSpotter logo
│   └── favicon.svg        # Favicon
├── app/                   # Next.js web application (deployed to GCP Cloud Run)
│   ├── Dockerfile         # Multi-stage Node 22 build for Cloud Run
│   ├── .env.local.example # Template for required environment variables
│   ├── package.json       # App dependencies
│   ├── next.config.ts     # Next.js config (standalone output)
│   ├── postcss.config.mjs # Tailwind CSS v4 PostCSS config
│   ├── public/            # Static assets (favicon.svg, logo.svg)
│   └── src/
│       ├── app/           # Next.js App Router (pages + API routes)
│       │   ├── layout.tsx
│       │   ├── page.tsx                      # Root redirect
│       │   ├── login/page.tsx                # Auth page
│       │   ├── dashboard/page.tsx            # Main findings view
│       │   ├── brands/                       # Brand management pages
│       │   └── api/                          # API routes
│       │       ├── brands/route.ts           # Brand CRUD
│       │       ├── brands/[brandId]/route.ts
│       │       ├── brands/[brandId]/findings/route.ts
│       │       ├── findings/route.ts         # Cross-brand recent findings (dashboard)
│       │       ├── scan/route.ts             # Trigger scans, poll status
│       │       └── webhooks/apify/route.ts   # Apify webhook receiver + LLM analysis pipeline
│       ├── components/    # React components
│       │   ├── ui/        # Primitives: Button, Card, Badge, Input
│       │   ├── auth-guard.tsx
│       │   ├── navbar.tsx
│       │   ├── finding-card.tsx
│       │   └── severity-badge.tsx
│       └── lib/           # Shared utilities and service clients
│           ├── types.ts                      # Core data model types
│           ├── utils.ts                      # cn(), formatDate(), etc.
│           ├── api-utils.ts                  # requireAuth(), errorResponse()
│           ├── firebase/
│           │   ├── client.ts                 # Firebase client SDK init
│           │   ├── admin.ts                  # Firebase Admin SDK (server-side)
│           │   └── auth-context.tsx          # React auth context provider
│           ├── apify/
│           │   ├── actors.ts                 # Actor registry + CORE_ACTOR_IDS
│           │   └── client.ts                 # Apify client: startActorRun(), fetchDatasetItems(), runActor()
│           └── analysis/
│               ├── openrouter.ts             # OpenRouter LLM client
│               ├── prompts.ts                # System prompt + buildAnalysisPrompt()
│               └── types.ts                  # AnalysisOutput + parseAnalysisOutput()
└── docs/                  # Hackathon reference materials + infrastructure guides (not deployed)
    ├── GCP_SETUP.md        # Step-by-step GCP/Firebase setup guide ← START HERE
    ├── CHALLENGE_BRIEF.md
    ├── CHALLENGE_FAQ.md
    └── TOOLS_PROMO_ACCESS.md
```

---

## What DoppelSpotter Does

DoppelSpotter is an autonomous AI pipeline that monitors the web for potential brand infringements on behalf of SMEs. It uses a suite of Apify Actors to scrape live data across multiple surfaces, then routes every finding through an LLM (via OpenRouter) to classify intent, score severity, and generate plain-language summaries. Users receive a ranked digest of genuine threats — not a flood of raw keyword matches.

**Monitoring surfaces (v1 core):**
- Social media (Instagram, Twitter/X, Facebook)
- Google Search results
- Newly-registered domains (via `doppelspotter/whoisxml-brand-alert` — a published Apify Actor)
- App stores (Google Play, Apple App Store)
- EUIPO trademark register (optional, disabled by default)

See `PITCH.md` for the full actor suite including v2 stretch goals.

---

## Tech Stack

| Layer | Technology |
|---|---|
| AI analysis | LLM via OpenRouter (classification, severity scoring, summarisation) |
| Web scraping & orchestration | Apify Actors + scheduled runs + webhooks |
| Frontend | Next.js 15 (App Router, TypeScript) |
| Styling | Tailwind CSS v4 (brand palette matches landing page) |
| Icons | Lucide React |
| Auth | Firebase Auth (email/password) |
| Database | Firestore |
| File storage | Cloud Storage (planned) |
| Hosting | GCP Cloud Run |
| CI/CD | Google Cloud Build (triggers on `app/**` push to `main`) |
| Pitch/landing page | Static HTML + Tailwind CSS, hosted on Cloudflare Pages |
| Alerting | Email digests (planned) |

---

## Deployment

### App (Web Application)

The `app/` directory is a Next.js 15 application deployed to **GCP Cloud Run** via **Cloud Build**.

**Local development:**
```bash
cd app
cp .env.local.example .env.local   # Fill in your values — see docs/GCP_SETUP.md
npm install
npm run dev
# → http://localhost:3000
```

**CI/CD (automatic):**
Any push to `main` that changes files under `app/**` triggers Cloud Build, which:
1. Builds the Docker image from `app/Dockerfile` (Node 22, multi-stage)
2. Pushes to Artifact Registry (`europe-west6-docker.pkg.dev`)
3. Deploys to Cloud Run (`doppelspotter-app` service, `europe-west6`)

The Cloud Build trigger uses an **included files filter of `app/**`**, so changes to `landing-page/`, `docs/`, `AGENTS.md`, etc. do NOT trigger a build.

**GCP setup:** See `docs/GCP_SETUP.md` for complete step-by-step instructions including Firebase, Firestore, Artifact Registry, Cloud Build, and Secret Manager configuration.

**Scan pipeline setup:** See `docs/PIPELINE_SETUP.md` for API key acquisition (Apify, OpenRouter, WhoisXML) and ngrok tunnel configuration for local webhook testing.

### Landing Page

The `landing-page/` directory is deployed as a static site to **Cloudflare Pages** at `pitch.doppelspotter.com`.

```bash
npm run deploy   # runs wrangler deploy from project root
```

---

## Environment Variables

All required environment variables are documented in `app/.env.local.example`. Key variables:

| Variable | Where set | Purpose |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_*` | `.env.local` / Secret Manager | Firebase client SDK config (public) |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Secret Manager → Cloud Run | Firebase Admin SDK (server-side auth + Firestore) |
| `APIFY_API_TOKEN` | Secret Manager → Cloud Run | Apify actor execution |
| `APIFY_WEBHOOK_SECRET` | Secret Manager → Cloud Run | Validates Apify webhook callbacks |
| `WHOISXML_API_KEY` | Secret Manager → Cloud Run | WhoisXML Brand Alert actor |
| `OPENROUTER_API_KEY` | Secret Manager → Cloud Run | LLM analysis |
| `OPENROUTER_MODEL` | `.env.local` / Cloud Run | LLM model selection (default: `anthropic/claude-3.5-haiku`) |
| `APP_URL` | `.env.local` / Cloud Run | Public base URL — used to construct Apify webhook callback URLs (use ngrok for local dev) |

In production, secrets are stored in **GCP Secret Manager** and injected into Cloud Run at deploy time by `cloudbuild.yaml`.

See `docs/PIPELINE_SETUP.md` for a step-by-step guide to obtaining API keys and configuring local webhook testing with ngrok.

---

## Data Model (Firestore)

```
users/{userId}                    ← Managed by Firebase Auth (no Firestore doc needed)
brands/{brandId}                  ← BrandProfile: name, keywords, officialDomains
scans/{scanId}                    ← Scan: brandId, status, actorIds, actorRunIds, actorRuns, completedRunCount, findingCount
findings/{findingId}              ← Finding: source, severity, title, llmAnalysis, rawData
```

All documents include a `userId` field for security rule enforcement. Firestore security rules ensure users can only access their own data. See `docs/GCP_SETUP.md` for the rules snippet.

---

## Hackathon Context

- **Event:** GenAI Zürich 2026 — [genaizurich.devpost.com](https://genaizurich.devpost.com)
- **Track:** Apify (Industry-agnostic)
- **Challenge paths addressed:** Path 1 (AI Agent) + Path 3 (Build an Apify Actor)
- **Online build phase:** 2–18 March 2026
- **On-site phase:** 1–2 April 2026, Volkshaus Zürich

**Submission requirements (online phase, due 18 March 12:00):**
- Prototype (this repo, public)
- Optional: 1-min demo video, team photo
- Via Devpost

**Submission requirements (final, due 2 April 13:00):**
- Final prototype (this repo)
- Project landing page (`pitch.doppelspotter.com`)
- Slides + video + team photo
- Via Devpost

---

## Key Sponsor Credits

| Sponsor | Credit |
|---|---|
| **Apify** | $100 free platform credits — promo code `GENAIHACKER` at [console.apify.com/billing/subscription](https://console.apify.com/billing/subscription) |
| **OpenRouter** | LLM access via Apify's OpenRouter Actor proxy |
| **Lovable** | 100 credits (code sent via email 2 March) |
| **Hugging Face** | 1 month free PRO — join [huggingface.co/genai-zurich](https://huggingface.co/genai-zurich) |
