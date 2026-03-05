# DoppelSpotter

**AI-powered brand protection for businesses that can't afford to look the other way.**

---

## The Problem

When someone misuses your brand online — a lookalike domain diverting your customers, a fake social account eroding trust, a clone app trading on your name — it directly costs you sales, reputation, and competitive advantage.

Yet most SMEs have no systematic way to detect this. Enterprise brand protection tools exist, but they're priced for corporations with dedicated legal teams. Smaller brands are left to Google themselves and hope for the best.

## The Solution

DoppelSpotter is a web app that continuously monitors the web for potential infringements against your brand — and uses AI to separate genuine threats from noise.

**How it works:**

1. **Set up your brand profile** — enter your brand/product name(s), related keywords, and official domain(s)
2. **A suite of Apify actors scans the web** — social media platforms, Google search results, newly-registered domains, app stores, and trademark registers are monitored on a scheduled basis
3. **AI analyses every finding** — AI analysis classifies each result by severity and likelihood of genuine infringement, filtering out false positives (e.g. a news article mentioning your brand vs. a fake account impersonating it)
4. **You receive a digest** — a daily or weekly summary of findings, ranked by severity, with plain-language explanations of each potential infringement

## Why This Matters

- **Customers are being diverted** — over [2.3 million typosquatting domains](https://korlabs.io/documents/1/tma2024-shielding-brands.pdf) have been registered to mimic popular brands, sending would-be customers to competitors, scam sites, or ad-farm pages instead of the real business
- **Domain disputes are at record levels** — WIPO handled [6,168 domain name disputes](https://www.wipo.int/export/sites/www/amc/en/docs/2024_domainnamereport.pdf) in 2024 across 133 countries, with retail (37%) and finance (13%) the most targeted sectors
- **Clone apps trade on your reputation** — nearly [97,000 apps were delisted from Google Play](https://pixalate.com/blog/february-2025-delisted-mobile-apps-report) in February 2025 alone, with [93% of fraudulent apps](https://www.appknox.com/resources/white-papers/fake-app-detection-guide) bypassing traditional store security
- **Every day you're not monitoring, someone else may be profiting from your brand** — and most SMEs only find out when a customer complains

## Core AI Value

DoppelSpotter goes beyond keyword matching. The AI:

- **Classifies intent** — distinguishes a fan page from an impersonation, a product review from a counterfeit listing
- **Scores severity** — prioritises findings so brand owners act on what matters most
- **Explains in plain language** — every finding comes with a human-readable summary of what was found, why it's flagged, and what the risk is

This is the gap a rules-based system cannot fill: understanding *context* at scale.

## Technical Architecture

| Layer | Technology |
|---|---|
| **AI analysis** | AI analysis via OpenRouter (classification, severity scoring, summarisation) |
| **Orchestration** | Apify scheduling + webhooks |
| **Frontend** | Web app |
| **Alerting** | Email digests (daily/weekly) |

### Actor Suite — Core (v1)

| Surface | Actor | Notes |
|---|---|---|
| **Social media** | `apify/instagram-search-scraper`, `data-slayer/twitter-search`, `sociavault/tiktok-keyword-search-scraper`, `apify/facebook-search-scraper` | Official Apify actors for Instagram and Facebook; keyword search across all four platforms |
| **Web / Google Search** | `apify/google-search-scraper` | Surfaces websites misusing brand names in titles, URLs, and descriptions |
| **Newly-registered domains** | `doppelspotter/whoisxml-brand-alert` *(published Actor)* | Wraps the [WhoisXML Brand Alert API](https://brand-alert.whoisxmlapi.com/api) (BYOK); detects domains containing brand keywords registered in the past 24 hours across 7,596+ TLDs |
| **App stores** | `apilab/google-play-scraper`, `dan.scraper/apple-app-store-search-scraper` | Detects clone or impersonator apps on Google Play and Apple App Store |
| **Trademark register** | `ryanclinton/euipo-trademark-search` | Monitors new EUIPO filings containing brand keywords; optional, disabled by default (requires free EUIPO developer credentials) |

### Actor Suite — Stretch (v2)

| Surface | Actor | Value |
|---|---|---|
| **Reddit** | `crawlerbros/reddit-keywords` | Surfaces customer-reported fakes and scam discussions before the brand is aware |
| **Website screenshot** | `apify/screenshot-url` | Timestamped visual evidence of infringing pages — preserves content before it disappears |
| **Web content extraction** | `apify/website-content-crawler` | Scrapes suspicious URLs and feeds content to the LLM: *"does this site appear to impersonate brand X?"* |
| **WHOIS enrichment** | `salman_bareesh/whois-scraper` | Enriches flagged domains with registrant details, registration date, and registrar — enabling AI-generated risk assessments |

## Challenge Alignment (Apify Track)

DoppelSpotter addresses two of the three challenge pathways:

| Pathway | How DoppelSpotter Addresses It |
|---|---|
| **Path 1 — AI Agent** | An autonomous pipeline that scrapes live web data, analyses findings with an LLM, and delivers ranked, plain-language infringement alerts — no human in the loop |
| **Path 3 — Build an Apify Actor** | The WhoisXML Brand Alert wrapper is published to the Apify Store as a standalone, reusable Actor (`doppelspotter/whoisxml-brand-alert`) — usable independently by any developer building brand protection or domain monitoring tools |

| Success Metric | How DoppelSpotter Addresses It |
|---|---|
| **Solves a real business problem with web data** | Brand infringement is a concrete, costly problem — and live web data is the only way to detect it |
| **Works end-to-end** | Brand profile in, ranked infringement digest out — a complete pipeline from scraping to AI analysis to user notification |
| **Quality and depth of Apify integration** | Seven actors spanning five monitoring surfaces form the backbone of the product, with a published Actor contributing back to the Apify ecosystem |

## Target User

**SMEs and startups** — businesses with a brand worth protecting but without the budget for enterprise IP monitoring tools or in-house legal teams. DoppelSpotter democratises brand protection by making it accessible and affordable.

## Differentiators

1. **Cost** — existing tools are enterprise-priced; DoppelSpotter is built for smaller brands
2. **AI depth** — contextual, LLM-powered analysis that understands the difference between legitimate mentions and genuine infringement — not just keyword alerts

---

*DoppelSpotter uses AI to spot your brand's doppelgangers across the web — before they cost you customers or credibility.*
