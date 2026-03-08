# DoppelSpotter — Scan Quality Review

This document captures our ongoing review of the scan pipeline: how actors work,
what data they produce, how AI analysis processes it, and any observations / tuning decisions.

---

## Actors

The app is now Google-only. `app/src/lib/apify/actors.ts` still exposes `ACTOR_REGISTRY`
for shared lookup helpers, but it contains just one supported actor.

> **Current status:** `apify/google-search-scraper` is the only supported actor.

### Actor Registry

| Actor ID | Display Name | Source Tag | Supported | Notes |
|---|---|---|---|---|
| `apify/google-search-scraper` | Google Search | `google` | ✅ **Yes** | Under active review |

### Actor Input Mappings

Defined in `app/src/lib/apify/client.ts` → `buildActorInput()`.
The Google actor input is built from the brand profile:

```
searchTerms = [brand.name, ...brand.keywords]
primaryQuery = searchTerms.join(' OR ')
```

| Actor | Input |
|---|---|
| `apify/google-search-scraper` | `{ queries: primaryQuery, maxPagesPerQuery: searchResultPages }` |

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
together inside an `organicResults` array. The initial Google scan now uses the brand's
configured `searchResultPages` value, which defaults to **3 SERP pages** (~30 organic
results total, assuming ~10 per page), so with the default we get:

```
Dataset item 1  →  SERP page 1  →  organicResults[0..9]  (results #1–10)
Dataset item 2  →  SERP page 2  →  organicResults[0..9]  (results #11–20)
Dataset item 3  →  SERP page 3  →  organicResults[0..9]  (results #21–30)
```

Three items total, not thirty. Brands configured for more or fewer pages follow the same
pattern: one dataset item per SERP page.

This matters because the webhook handler first receives page-level SERP blobs, then has to
normalize them into per-URL result candidates before AI analysis can happen efficiently.
The current pipeline now flattens only `organicResults`, dedupes repeated URLs within the run,
keeps `relatedQueries` and `peopleAlsoAsk` as run-level context, and then classifies the
deduped candidates in bounded chunks. See [AI analysis implications](#ai-analysis-implications)
for the current shape of that pipeline.

### How we call it

Defined in `app/src/lib/apify/client.ts` → `buildActorInput()`:

```typescript
// searchTerms = [brand.name, ...brand.keywords]
// primaryQuery = searchTerms.join(' OR ')
// brand-specific Google scan breadth (defaults to 3)

{ queries: primaryQuery, maxPagesPerQuery: searchResultPages }
```

**Example** — brand `Acme` with keywords `acme, acme-corp`:
```
queries: "Acme OR acme OR acme-corp"
maxPagesPerQuery: searchResultPages
```

At the default setting, this produces **3 dataset items** (one per SERP page), each
containing up to 10 organic results — ~30 organic results total per scan.

### Input parameters (relevant subset)

| Parameter | Type | Our value | Description |
|---|---|---|---|
| `queries` | string | `"brand OR kw1 OR kw2"` | Newline-separated search terms or Google URLs. We pass a single `OR`-joined string. |
| `maxPagesPerQuery` | integer | `searchResultPages` (default `3`) | Number of SERP pages to scrape per query for both the initial search pass and deep-search runs. Each page ≈ 10 organic results. |
| `resultsPerPage` | integer | _(not sent)_ | Google hard-caps SERPs at ~10 results, so we rely on page count rather than a per-brand result-count setting. |
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
| `organicResults[].description` | Snippet — key context for AI analysis |
| `organicResults[].emphasizedKeywords` | Keywords Google bolded — shows what matched our query |
| `paidResults[]` | Present in the raw actor data, but currently excluded from AI analysis to keep prompts compact |
| `relatedQueries[]` | Titles like "acme corp fake" or "acme scam" are useful brand health signals |
| `peopleAlsoAsk[]` | Can surface questions like "Is Acme Corp legitimate?" |

### AI analysis implications

The Google Search pipeline no longer sends one huge raw SERP blob to the model. Instead it:

- normalizes raw SERP pages into compact **organic-only** result candidates
- dedupes repeated URLs within the run before AI analysis
- classifies those candidates in **small chunks**, using stable `resultId`s instead of free-form URL matching
- writes / upserts **one Firestore Finding per normalized URL per scan**
- stores a compact normalized debug payload on each finding (`kind: 'google-normalized'`) with merged sightings and SERP context
- runs a **final** deep-search selection pass over deduped `relatedQueries` and `peopleAlsoAsk` to produce optional `suggestedSearches`

### Observations / tuning notes

- [x] **`resultsPerPage` is a no-op** — Google ignores it and always returns ~10 per page.
      We now omit it from the actor input and drive result count via `maxPagesPerQuery`.
- [ ] **Single `OR` query vs multiple targeted queries** — currently we pass one broad
      `"BrandName OR kw1 OR kw2"` query. This surfaces general mentions but may miss
      impersonation patterns. Consider additional queries like `"BrandName fake"`,
      `"BrandName scam"`, or `site:` restricted searches.
- [ ] **No country/language set** — defaults to US (`google.com`). For European brands
      this may miss results on `.co.uk`, `.de` etc. Consider parameterising `countryCode`.
- [x] **One finding per URL per scan** — Google results are now normalized and deduped by
      canonical URL before AI analysis. Repeated appearances across SERP pages, chunks, or
      depth-1 deep-search runs merge into the same finding for that scan.
- [x] **Chunked Google classification** — Google result candidates are classified in bounded
      chunks rather than one giant prompt, which avoids context-limit failures at higher result
      volumes.
- [x] **`relatedQueries` + `peopleAlsoAsk` drive follow-up suggestioning** — Google now uses a
      single final deep-search selection pass over deduped SERP signals to produce
      `suggestedSearches`, without coupling that logic to per-result classification.
- [x] **Paid results (`paidResults`) are excluded from AI analysis** — the raw actor still returns
      them, but they are intentionally left out of the normalized prompt payload to keep Google
      analysis focused and bounded.

---

## AI Analysis Pipeline

### Overview

AI analysis is invoked **after** each Google actor run completes. The webhook normalizes raw SERP
pages into deduped organic-result candidates, classifies them in chunks, optionally chooses
follow-up deep-search queries, and writes one finding per normalized URL.

```
POST /api/scan
  └─ starts the Google Search actor (async, non-blocking)
       └─ each run registered with a webhook → POST /api/webhooks/apify

Apify calls POST /api/webhooks/apify on SUCCEEDED / FAILED / ABORTED
  └─ validates X-Apify-Webhook-Secret header
  └─ fetches up to 50 items from the Apify dataset (MAX_ITEMS_PER_RUN = 50)
  └─ fetches all ignored URLs for the brand (isIgnored == true) → passed to AI analysis prompts
  └─ normalizes Google SERP pages into deduped organic result candidates
       ├─ classifies candidates in chunks → one AI analysis call per chunk
       ├─ upserts one Finding per normalized URL per scan
       └─ runs a final deep-search selection pass on relatedQueries + peopleAlsoAsk
  └─ marks actor run complete; once all runs done → marks scan complete
```

### When is AI analysis triggered?

- Triggered inside `analyseGoogleChunk()` and `analyseGoogleFinalSelection()` in `app/src/app/api/webhooks/apify/route.ts`
- Only on `ACTOR.RUN.SUCCEEDED` events (failed/aborted runs skip analysis)
- Items are capped at 50 per run (`MAX_ITEMS_PER_RUN`)
- For Google batch mode: raw SERP pages are normalized into compact organic-result candidates, deduped by URL, classified in chunks, and upserted one-finding-per-URL-per-scan
- A final Google deep-search selection pass inspects deduped `relatedQueries` and `peopleAlsoAsk` signals to produce optional `suggestedSearches` for depth-0 runs
- Ignored URLs for the brand are fetched from Firestore at webhook time and injected into `buildGoogleChunkAnalysisPrompt()` — AI analysis is instructed to mark any matching URL as `isFalsePositive: true`

### AI Analysis Provider & Model

| Setting | Value |
|---|---|
| Provider | [OpenRouter](https://openrouter.ai) |
| API endpoint | `https://openrouter.ai/api/v1/chat/completions` |
| Default model | `anthropic/claude-3.5-haiku` |
| Model override | `OPENROUTER_MODEL` env var |
| Temperature | `0.2` |
| Response format | `{ type: 'json_object' }` (forces valid JSON output) |

**Relevant file:** `app/src/lib/analysis/openrouter.ts`

### System Prompt (Google chunk classification)

**Defined in:** `app/src/lib/analysis/prompts.ts` → `GOOGLE_CLASSIFICATION_SYSTEM_PROMPT`

Used for the Google Search actor after normalization. Returns a `GoogleChunkAnalysisOutput` keyed by `resultId`.

```
You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

You will receive a compact list of Google organic search result candidates for a brand, plus supporting SERP context
such as related queries and People Also Ask questions.

Use British English spelling and phrasing in all human-readable output fields.

You must respond with a raw JSON object matching this exact schema (no markdown, no code fences, just the JSON):
{
  "items": [
    {
      "resultId": "the exact resultId from the input candidate",
      "title": "Short, descriptive title of the finding (max 10 words)",
      "severity": "high" | "medium" | "low",
      "analysis": "Plain-language explanation of what was found, why it is or isn't flagged, and what the business risk is (2-3 sentences)",
      "isFalsePositive": boolean
    }
  ]
}

Rules for "items":
- Include exactly one item for every input result candidate and reuse the exact same resultId.
- Assess only the provided result candidates.
- Do NOT turn related queries or People Also Ask questions into findings.
- Each "analysis" must be fully standalone — do NOT reference other items in the list.
```

### System Prompt (Google final deep-search selection)

**Defined in:** `app/src/lib/analysis/prompts.ts` → `buildGoogleFinalSelectionSystemPrompt()`

Runs after Google result classification. Returns a `GoogleSuggestionOutput` with up to the
brand's configured `maxAiDeepSearches` follow-up queries derived from `relatedQueries` and
`peopleAlsoAsk`.

### User Prompt Template (Google chunk classification)

**Defined in:** `app/src/lib/analysis/prompts.ts` → `buildGoogleChunkAnalysisPrompt()`

```
Brand being protected: "<brand.name>"
Brand keywords: <keywords>
Official domains: <officialDomains>
[Watch words: ... (only if set)]
[Safe words: ... (only if set)]
[Previously reviewed and dismissed URLs: ... (only if set)]
Monitoring surface: <source>

Supporting SERP context:
- Source queries: ...
- Related queries: ...
- People Also Ask: ...

Assess every result candidate below and return one item in the "items" array per resultId.
Use British English in any human-readable text you generate.

Result candidates (N):
<JSON.stringify(compactCandidates, null, 2)>
```

### User Prompt Template (Google final deep-search selection)

**Defined in:** `app/src/lib/analysis/prompts.ts` → `buildGoogleFinalSelectionPrompt()`

```
Brand being protected: "<brand.name>"
Brand keywords: <keywords>
[Watch words: ... (only if set)]
[Safe words: ... (only if set)]
Original search query:
- ...

Suggested related queries returned by Google for the above search:
- ...

People Also Ask queries returned by Google for the above search:
- ...

Maximum number of follow-up Google searches you may suggest:
- <brand.maxAiDeepSearches>
```

### Watch Words & Safe Words

Both are optional per-brand fields (`BrandProfile.watchWords`, `BrandProfile.safeWords`), set via the
brand create/edit form and stored in Firestore.

| Field | Prompt instruction |
|---|---|
| `watchWords` | "concerning terms the brand owner does NOT want associated with their brand — note any presence or implied association and use its discretion on severity impact" |
| `safeWords` | "terms the brand owner is comfortable being associated with — treat results containing these with reduced caution unless there are strong warning signs elsewhere" |

Both are passed to `buildGoogleChunkAnalysisPrompt()` and `buildGoogleFinalSelectionPrompt()` and are omitted from the prompt when not set.

### Expected AI Analysis Output Schema

**Defined in:** `app/src/lib/analysis/types.ts`

```typescript
interface GoogleChunkAnalysisItem {
  resultId: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  analysis: string;       // 2–3 sentence standalone explanation
  isFalsePositive: boolean;
}

interface GoogleChunkAnalysisOutput {
  items: GoogleChunkAnalysisItem[];
}

interface GoogleSuggestionOutput {
  suggestedSearches?: string[];  // capped at the brand's configured maxAiDeepSearches (1-10)
}
```

### Output Parsing

**`parseGoogleChunkAnalysisOutput()`** in `app/src/lib/analysis/types.ts` (Google chunk mode):
1. Same code-fence stripping
2. `JSON.parse()`s the result
3. Validates `items` is a non-empty array and each `resultId` matches one of the provided input candidates
4. Drops duplicate / invalid resultIds so only known candidates are accepted
5. Returns `null` if `items` is empty or entirely invalid after filtering

**`parseGoogleSuggestionOutput()`** in `app/src/lib/analysis/types.ts` (Google final selection mode):
1. Same code-fence stripping
2. `JSON.parse()`s the result
3. Filters `suggestedSearches` to unique non-empty strings
4. Caps the final set at the runtime deep-search limit passed in by the webhook

### Fallback Behaviour

If a Google chunk result cannot be matched or the analysis pipeline needs a deterministic fallback,
a fallback `Finding` is still upserted to Firestore:

```
severity:    'medium'
title:       'Unanalysed result — review manually'
description: 'AI analysis failed for this item. Raw data is preserved for manual review.'
rawData:     compact normalized Google debug payload
```

### False Positive Filtering

If AI analysis returns `isFalsePositive: true`, the Finding **is** still written to Firestore with
`isFalsePositive: true` and is also automatically set to `isIgnored: true` (with `ignoredAt` timestamp).
This means:

- The scan's `findingCount` is **not** incremented for false-positive results.
- False positives are excluded from the default findings API response and from `ScanSummary` severity counts.
- They are visible in the brand page "Non-hits" section.
- Because they carry `isIgnored: true`, their URLs are automatically included in the ignored URLs list
  passed to AI analysis on future scans — preventing repeated re-reporting.
- Users can un-ignore them if needed, which restores them to their original severity bucket.

---

## Observations & Open Questions

_(To be filled in as the review progresses.)_

- [ ] What does the raw output from `apify/google-search-scraper` actually look like?
- [ ] Are the search queries (using `OR`) producing relevant results for brand monitoring?
- [ ] How well does AI analysis classify Google Search results vs. other sources?
- [ ] Is the false positive rate too high / too low?
- [ ] Is the shared `searchResultPages` setting plus configurable `maxAiDeepSearches` budget the right trade-off?