# DoppelSpotter — Scan Quality Review

This document captures our ongoing review of the scan pipeline: how actors work,
what data they produce, how the LLM processes it, and any observations / tuning decisions.

---

## Actors

All actors are defined in `app/src/lib/apify/actors.ts` as entries in `ACTOR_REGISTRY`.
Each entry has an `enabledByDefault` flag. Actors where this is `true` are automatically
included in every scan via `CORE_ACTOR_IDS`. Actors with `enabledByDefault: false` remain
in the registry (so their input mappings and configs are preserved) but are not triggered
unless explicitly requested.

> **Current status:** Only the Google Search Scraper is enabled while we review and tune
> scan quality. All others have been temporarily disabled.

### Actor Registry

| Actor ID | Display Name | Source Tag | Enabled | Notes |
|---|---|---|---|---|
| `apify/google-search-scraper` | Google Search | `google` | ✅ **Yes** | Under active review |
| `doppelspotter/whoisxml-brand-alert` | Newly-Registered Domains | `domain` | ❌ No | Custom actor in this repo; wraps WhoisXML Brand Alert API; requires `WHOISXML_API_KEY` |
| `apify/instagram-search-scraper` | Instagram | `instagram` | ❌ No | |
| `data-slayer/twitter-search` | Twitter / X | `twitter` | ❌ No | |
| `apify/facebook-search-scraper` | Facebook | `facebook` | ❌ No | |
| `apilab/google-play-scraper` | Google Play | `google-play` | ❌ No | US store only; searches by brand name |
| `dan.scraper/apple-app-store-search-scraper` | Apple App Store | `app-store` | ❌ No | US store only; searches by brand name |
| `ryanclinton/euipo-trademark-search` | EUIPO Trademark Register | `trademark` | ❌ No | Requires separate EUIPO developer credentials |
| `crawlerbros/reddit-keywords` | Reddit | `unknown` | ❌ No | v2 stretch actor |
| `apify/screenshot-url` | Screenshot (Evidence) | `unknown` | ❌ No | v2 stretch actor |
| `salman_bareesh/whois-scraper` | WHOIS Enrichment | `domain` | ❌ No | v2 stretch actor |

### How `enabledByDefault` is used

```
CORE_ACTOR_IDS = ACTOR_REGISTRY
  .filter(a => a.enabledByDefault)
  .map(a => a.actorId)
```

When `POST /api/scan` is called:
- If no `actorIds` body param is provided → `CORE_ACTOR_IDS` is used (i.e. enabled actors only).
- If `actorIds` is explicitly provided → that array is used instead, allowing manual override.

### Actor Input Mappings

Defined in `app/src/lib/apify/client.ts` → `buildActorInput()`.
Each actor receives a different payload shape built from the brand profile:

```
searchTerms = [brand.name, ...brand.keywords]
primaryQuery = searchTerms.join(' OR ')
```

| Actor | Input |
|---|---|
| `apify/google-search-scraper` | `{ queries: primaryQuery, maxPagesPerQuery: 3, resultsPerPage: 10 }` |
| `apify/instagram-search-scraper` | `{ searchQueries: searchTerms, maxResults: 20 }` |
| `data-slayer/twitter-search` | `{ searchTerms: searchTerms, maxTweets: 50 }` |
| `apify/facebook-search-scraper` | `{ queries: searchTerms, maxResults: 20 }` |
| `apilab/google-play-scraper` | `{ searchQuery: brand.name, country: 'us', limit: 20 }` |
| `dan.scraper/apple-app-store-search-scraper` | `{ queries: [brand.name], country: 'us', limit: 20 }` |
| `doppelspotter/whoisxml-brand-alert` | `{ brandKeywords: searchTerms, apiKey: WHOISXML_API_KEY, lookbackDays: 1 }` |
| `ryanclinton/euipo-trademark-search` | `{ searchTerm: brand.name, maxResults: 50 }` |

---

## Google Search Scraper (`apify/google-search-scraper`) — Deep Dive

**Apify store page:** https://apify.com/apify/google-search-scraper  
**Pricing model:** Pay-per-event — ~$1.80 per 1,000 scraped result pages  
**Maintained by:** Apify (official actor, 94k+ users, 100% run success rate)

### What it does

Scrapes Google Search Engine Results Pages (SERPs). For each search query it
navigates up to N pages of Google results and returns the full structured content of
each page, including organic results, paid ads, related queries, People Also Ask boxes,
and optionally an AI Mode / AI Overview summary.

**Important — how the dataset is structured:** When you do a Google search you see
a list of individual results (links, titles, snippets). You might expect the actor to
push one dataset item per result — so 30 results → 30 items. It doesn't work that way.

Instead, the actor pushes **one dataset item per _page_ of Google results**. Each item
is a single large JSON object that contains _all_ the results from that page bundled
together inside an `organicResults` array. So with our current settings
(`maxPagesPerQuery: 3`, ~10 results per page) we get:

```
Dataset item 1  →  SERP page 1  →  organicResults[0..9]  (results #1–10)
Dataset item 2  →  SERP page 2  →  organicResults[0..9]  (results #11–20)
Dataset item 3  →  SERP page 3  →  organicResults[0..9]  (results #21–30)
```

Three items total, not thirty.

This matters because the webhook handler calls the LLM once per dataset item. So the
LLM receives the _entire first page of Google results_ as a single blob of JSON and
must produce a single `Finding` from it. It's being asked to synthesise up to 10
organic results, any paid ads, related queries, and People Also Ask boxes all in one
go — rather than evaluating each link individually. See [LLM implications](#llm-implications)
for why this is likely hurting quality.

### How we call it

Defined in `app/src/lib/apify/client.ts` → `buildActorInput()`:

```typescript
// searchTerms = [brand.name, ...brand.keywords]
// primaryQuery = searchTerms.join(' OR ')

{ queries: primaryQuery, maxPagesPerQuery: 3, resultsPerPage: 10 }
```

**Example** — brand `Acme` with keywords `acme, acme-corp`:
```
queries: "Acme OR acme OR acme-corp"
maxPagesPerQuery: 3
resultsPerPage: 10   ← effectively ignored by Google (see note below)
```

This produces **3 dataset items** (one per SERP page), each containing up to 10
organic results — ~30 organic results total per scan.

### Input parameters (relevant subset)

| Parameter | Type | Our value | Description |
|---|---|---|---|
| `queries` | string | `"brand OR kw1 OR kw2"` | Newline-separated search terms or Google URLs. We pass a single `OR`-joined string. |
| `maxPagesPerQuery` | integer | `3` | Number of SERP pages to scrape per query. Each page ≈ 10 organic results. |
| `resultsPerPage` | integer | `10` | ⚠️ **Ignored by Google** — Google now hard-caps pages at 10 results. Use `maxPagesPerQuery` to get more results. |
| `countryCode` | string | _(unset — defaults to US)_ | Google domain / country for the search. |
| `languageCode` | string | _(unset)_ | UI language (affects results on international queries). |
| `mobileResults` | boolean | _(unset — defaults to false)_ | Desktop results returned by default. |
| `includeUnfilteredResults` | boolean | _(unset — defaults to false)_ | If true, includes lower-quality results Google normally filters out. |
| `forceExactMatch` | boolean | _(unset)_ | Wraps the query in quotes for exact-phrase search. Not useful for `OR` queries. |
| `quickDateRange` | string | _(unset)_ | Restrict by recency, e.g. `d7` = last 7 days. |
| `saveHtmlToKeyValueStore` | boolean | _(unset — defaults to false)_ | Stores raw HTML snapshots — useful for debugging. |

### Output dataset schema

Each dataset item (one per SERP page scraped) has this structure:

```json
{
  "searchQuery": {
    "term": "Acme OR acme OR acme-corp",
    "url": "https://www.google.com/search?q=Acme+OR+acme+OR+acme-corp&num=10",
    "device": "DESKTOP",
    "page": 1,
    "type": "SEARCH",
    "domain": "google.com",
    "countryCode": "US",
    "languageCode": null,
    "locationUule": null,
    "resultsPerPage": "10"
  },
  "resultsTotal": null,
  "organicResults": [
    {
      "title": "Result title",
      "url": "https://example.com/page",
      "displayedUrl": "https://example.com › page",
      "description": "Snippet text from the page...",
      "emphasizedKeywords": ["Acme"],
      "siteLinks": [],
      "productInfo": {},
      "type": "organic",
      "position": 1
    }
    // ... up to ~10 entries
  ],
  "paidResults": [
    {
      "title": "...",
      "url": "...",
      "displayedUrl": "...",
      "description": "...",
      "type": "paid",
      "adPosition": 1
    }
  ],
  "paidProducts": [],
  "relatedQueries": [
    { "title": "acme corp scam", "url": "https://www.google.com/search?q=acme+corp+scam" }
    // ...
  ],
  "peopleAlsoAsk": [],
  "aiModeResult": {
    "text": "AI-generated summary if aiMode is enabled...",
    "sources": []
  },
  "query": "Acme OR acme OR acme-corp",
  "url": "https://www.google.com/search?q=Acme+OR+acme+OR+acme-corp&num=10"
}
```

**Key fields for brand monitoring:**

| Field | Notes |
|---|---|
| `organicResults[].url` | The actual URL of each result — primary signal for impersonation detection |
| `organicResults[].title` | Page title — often reveals intent |
| `organicResults[].description` | Snippet — key context for the LLM |
| `organicResults[].emphasizedKeywords` | Keywords Google bolded — shows what matched our query |
| `paidResults[]` | Competitors bidding on our brand name via Google Ads |
| `relatedQueries[]` | Titles like "acme corp fake" or "acme scam" are useful brand health signals |
| `peopleAlsoAsk[]` | Can surface questions like "Is Acme Corp legitimate?" |

### LLM implications

**The LLM receives one full SERP page as `rawData`.** This means:

- A single LLM call sees up to 10 organic results, related queries, PAA, and paid
  ads simultaneously — it's classifying the entire page, not individual results.
- The `rawData` payload sent to the LLM is large. For 3 pages, we make 3 LLM calls.
- The LLM prompt's `source` field is set to `"google"` for all calls from this actor.
- The LLM is asked to return one `Finding` per page — it must synthesise across
  all results on the page and identify the most significant concern (if any).

This is a potential quality issue: if page 1 contains 9 benign results and 1 suspicious
one, the LLM may or may not flag it. Consider whether the actor should be restructured
to push **one item per organic result** instead of one item per page.

### Observations / tuning notes

- [ ] **`resultsPerPage` is a no-op** — Google ignores it and always returns ~10 per page.
      We should remove it from the input to avoid confusion.
- [ ] **Single `OR` query vs multiple targeted queries** — currently we pass one broad
      `"BrandName OR kw1 OR kw2"` query. This surfaces general mentions but may miss
      impersonation patterns. Consider additional queries like `"BrandName fake"`,
      `"BrandName scam"`, or `site:` restricted searches.
- [ ] **No country/language set** — defaults to US (`google.com`). For European brands
      this may miss results on `.co.uk`, `.de` etc. Consider parameterising `countryCode`.
- [ ] **One finding per page** — the current architecture means the LLM classifies whole
      SERP pages. Restructuring the scraper output to emit one item per organic result
      would give the LLM a cleaner, narrower scope and likely improve quality.
- [ ] **`relatedQueries` are valuable signals** — titles like "brand scam" or "brand fake"
      in `relatedQueries` can indicate reputation attacks even when organic results look
      clean. These are currently included in the raw blob sent to the LLM, but the LLM
      prompt doesn't specifically direct attention to them.
- [ ] **Paid results (`paidResults`)** — competitors bidding on the brand name is a
      legitimate brand protection concern. The current prompt doesn't specifically surface
      this as a finding type.

---

## LLM Analysis Pipeline

### Overview

The LLM is invoked **after** each Apify actor run completes, once per dataset item.
It classifies each raw scraping result as a genuine finding or a false positive,
assigns a severity, and writes a short human-readable summary.

```
POST /api/scan
  └─ starts N Apify actor runs (async, non-blocking)
       └─ each run registered with a webhook → POST /api/webhooks/apify

Apify calls POST /api/webhooks/apify on SUCCEEDED / FAILED / ABORTED
  └─ validates X-Apify-Webhook-Secret header
  └─ fetches up to 50 items from the Apify dataset (MAX_ITEMS_PER_RUN = 50)
  └─ for each item → analyseItem() → LLM call → write Finding to Firestore
  └─ marks actor run complete; once all runs done → marks scan complete
```

### When is the LLM triggered?

- Triggered inside `analyseItem()` in `app/src/app/api/webhooks/apify/route.ts`
- Once per dataset item, sequentially (not in parallel — to avoid OpenRouter rate limits)
- Only on `ACTOR.RUN.SUCCEEDED` events (failed/aborted runs skip analysis)
- Items are capped at 50 per run (`MAX_ITEMS_PER_RUN`)

### LLM Provider & Model

| Setting | Value |
|---|---|
| Provider | [OpenRouter](https://openrouter.ai) |
| API endpoint | `https://openrouter.ai/api/v1/chat/completions` |
| Default model | `anthropic/claude-3.5-haiku` |
| Model override | `OPENROUTER_MODEL` env var |
| Temperature | `0.2` |
| Response format | `{ type: 'json_object' }` (forces valid JSON output) |

**Relevant file:** `app/src/lib/analysis/openrouter.ts`

### System Prompt

**Defined in:** `app/src/lib/analysis/prompts.ts` → `SYSTEM_PROMPT` (line 7)

```
You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

Your task is to analyse a web scraping result and determine whether it represents a potential brand infringement.

You must respond with a raw JSON object matching this exact schema (no markdown, no code fences, just the JSON):
{
  "severity": "high" | "medium" | "low",
  "title": "Short, descriptive title of the finding (max 10 words)",
  "llmAnalysis": "Plain-language explanation of what was found, why it's flagged, and what the business risk is (2-4 sentences)",
  "isFalsePositive": boolean
}

Severity guidelines:
- "high": Clear impersonation, phishing, counterfeit, or direct brand misuse that poses immediate risk to customers or the brand
- "medium": Suspicious activity that warrants investigation but may have a legitimate explanation (e.g. fan accounts, resellers using brand name)
- "low": Likely benign mention but worth logging (e.g. news articles, legitimate reviews)

Set isFalsePositive: true if the result is clearly legitimate use of the brand name (e.g. the official website, a verified partner, a genuine news article with no intent to deceive).
```

### User Prompt Template

**Defined in:** `app/src/lib/analysis/prompts.ts` → `buildAnalysisPrompt()` (line 29)

```
Brand being protected: "<brand.name>"
Brand keywords: <keywords joined with ", ">
Official domains: <officialDomains joined with ", ">
Monitoring surface: <source>

Raw scraping result to analyse:
<JSON.stringify(rawData, null, 2)>

Analyse this result and return your assessment as JSON.
```

The `source` field is the actor's `FindingSource` tag (e.g. `google`, `domain`, `instagram`).
The `rawData` is the full unmodified item from the Apify dataset.

### Expected LLM Output Schema

**Defined in:** `app/src/lib/analysis/types.ts` → `AnalysisOutput`

```typescript
interface AnalysisOutput {
  severity: 'high' | 'medium' | 'low';
  title: string;          // max 10 words
  llmAnalysis: string;    // 2–4 sentence plain-language explanation
  isFalsePositive: boolean;
}
```

### Output Parsing

`parseAnalysisOutput()` in `app/src/lib/analysis/types.ts`:
1. Strips markdown code fences (in case the model wraps JSON in ` ```json ``` `)
2. `JSON.parse()`s the result
3. Validates all four fields are present and correctly typed
4. Returns `null` on any failure

### Fallback Behaviour

If the LLM call or parse fails for an item, a fallback `Finding` is still written to Firestore:

```
severity:    'medium'
title:       'Unanalysed result — review manually'
description: 'LLM analysis failed for this item. Raw data is preserved for manual review.'
rawData:     (full item preserved)
```

### False Positive Filtering

If the LLM returns `isFalsePositive: true`, the item is **not** written to Firestore as a Finding.
The scan's `findingCount` is only incremented for non-false-positive results.

---

## Observations & Open Questions

_(To be filled in as the review progresses.)_

- [ ] What does the raw output from `apify/google-search-scraper` actually look like?
- [ ] Are the search queries (using `OR`) producing relevant results for brand monitoring?
- [ ] How well does the LLM classify Google Search results vs. other sources?
- [ ] Is the false positive rate too high / too low?
- [ ] Are `maxPagesPerQuery: 3, resultsPerPage: 10` (30 results total) the right limits?
