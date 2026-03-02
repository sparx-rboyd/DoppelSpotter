# DoppelSpotter — Project Guide

AI-powered brand protection for SMEs. This repository is the submission for the **GenAI Zürich 2026 Hackathon, Apify Track**.

---

## Repository Structure

```
.
├── AGENTS.md              # This file — project overview for AI agents and developers
├── PITCH.md               # Full written pitch: problem, solution, architecture, challenge alignment
├── package.json           # Root-level scripts (deploy)
├── landing-page/          # Static pitch/project site (deployed to Cloudflare Pages)
│   ├── index.html         # Single-page site
│   ├── logo.svg           # DoppelSpotter logo
│   └── favicon.svg        # Favicon
└── docs/                  # Hackathon reference materials (not deployed)
    ├── CHALLENGE_BRIEF.md  # Apify track challenge brief
    ├── CHALLENGE_FAQ.md    # Hackathon FAQ (format, dates, judging criteria)
    └── TOOLS_PROMO_ACCESS.md # Sponsor tool credits (Apify, Lovable, Hugging Face, etc.)
```

---

## What DoppelSpotter Does

DoppelSpotter is an autonomous AI pipeline that monitors the web for potential brand infringements on behalf of SMEs. It uses a suite of Apify Actors to scrape live data across multiple surfaces, then routes every finding through an LLM (via OpenRouter) to classify intent, score severity, and generate plain-language summaries. Users receive a ranked digest of genuine threats — not a flood of raw keyword matches.

**Monitoring surfaces (v1 core):**
- Social media (Instagram, Twitter/X, Facebook, TikTok)
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
| Frontend | Web app (TBD) |
| Pitch/landing page | Static HTML + Tailwind CSS, hosted on Cloudflare Pages |
| Alerting | Email digests (daily/weekly) |

---

## Conventions

- Any user-facing text should always be written in British English

---

## Deployment

### Landing Page

The `landing-page/` directory is deployed as a static site to **Cloudflare Pages** at `pitch.doppelspotter.com`.

**To deploy:**
```bash
npm run deploy
```

This runs `wrangler deploy`, which reads `wrangler.toml` at the root and publishes the `landing-page/` directory as a Cloudflare Worker with static assets. Requires:
- `wrangler` installed globally (`npm install -g wrangler`)
- A one-time `wrangler login` to authenticate with Cloudflare

The Worker is named `doppelspotter-pitch` and is configured in `wrangler.toml`. The custom domain `pitch.doppelspotter.com` is configured separately in the Cloudflare dashboard.

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