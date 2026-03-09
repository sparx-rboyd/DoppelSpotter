# Recent Domain Registrations

Search recent domain registrations from the CodePunch GTLD Domain Name Activity Feed v2 using keyword, date, and TLD filters, and request enhanced AI analyses of the top level web page for each domain.

This actor is useful when you want to monitor newly registered domains that may reference a brand, product name, campaign, or watch word. It queries the CodePunch `/added` feed, paginates through results automatically, and returns one dataset item per matching domain.

You will need an active CodePunch subscription and valid API credentials to use this actor. [More information](https://codepunch.com/dnfeed/v2/).

## What this actor does

- Searches recent domain registrations from the CodePunch `added` feed
- Supports one or more keywords in a single run
- Lets you filter by date comparison and optional TLDs
- Auto-paginates until all matches are retrieved or your selected limit is reached
- Outputs one Apify dataset item per matching domain
- Optionally fetches homepage content from each matching domain and asks the LLM of your choice to summarise what appears there

## Typical use cases

- Brand protection and domain-watch workflows
- Monitoring newly registered typo domains
- Tracking suspicious registrations around launches or campaigns
- Investigating domains containing product, company, or watch-word terms

## How to use it

1. Enter your CodePunch API key and API secret.
2. Pick the reference date.
3. Choose how that date should be applied:
   - `Equal to`
   - `Less than`
   - `Greater than`
   - `Less than or equal to`
   - `Greater than or equal to`
4. Add one or more keywords.
5. Optionally restrict the search to specific TLDs such as `com`, `net`, or `shop`.
6. Optionally enable `Enhanced analysis` to summarise what appears on each matching domain's homepage.
7. If enabled, provide your OpenRouter API key and, optionally, a model name.
  - You will need a funded OpenRouter account to make API calls to most models. [More information](https://openrouter.ai/).
  - This Actor has been tested with - and works well with - [DeepSeek 3.2 (deepseek/deepseek-v3.2)](https://openrouter.ai/deepseek/deepseek-v3.2).
8. Optionally choose sort field and sort order.
9. Set a total limit for the maximum number of results to return.

## Input fields

| Field | Required | What it means |
| --- | --- | --- |
| `CodePunch API key` | Yes | Your CodePunch API key. |
| `CodePunch API secret` | Yes | Your CodePunch API secret. |
| `Date` | Yes | The reference date used for the search. |
| `Date comparison` | Yes | How the selected date should be applied to the query. |
| `Keywords` | Yes | One or more terms to search for in recent registrations. |
| `TLDs` | No | Optional list of top-level domains to include. |
| `Enhanced analysis` | No | If enabled, the actor fetches the homepage content for each matching domain and asks an LLM to summarise it. |
| `OpenRouter API key` | No | Required only when Enhanced analysis is enabled. |
| `OpenRouter model` | No | Optional model name for Enhanced analysis. Default: `deepseek/deepseek-v3.2`. |
| `Sort field` | No | Sort by `Date`, `Domain`, or `Top-level domain`. |
| `Sort order` | No | Sort ascending or descending. |
| `Total limit` | No | Maximum number of matching domains to return. Default: `100`. |

## Keyword matching

Keywords are passed to CodePunch using its keyword syntax.

- If you enter `brandname`, the actor will search as `%brandname%`
- If you enter a value that already includes `%`, it will be used as provided
- Multiple keywords are combined into a single request

This makes it easy to search for broad substring matches without manually formatting every term.

## Output

The actor stores results in the default dataset.

Each dataset item represents one matching domain returned by CodePunch and preserves the upstream fields, including:

- `domain`
- `name`
- `tld`
- `date`
- `length`
- `idn`
- `ipv4`
- `ipv6`
- `ipasnumber`
- `ipasname`
- `ipchecked`

Each item also includes:

- `requestMetadata`: the filters used for the run
- `responseMetadata`: useful paging and upstream response context
- `enhancedAnalysis`: optional homepage summary or a friendly message if AI analysis could not be completed

### Example output item

```json
{
  "name": "storysparx",
  "idn": 0,
  "length": 10,
  "ipv4": null,
  "ipv6": null,
  "ipasnumber": null,
  "ipasname": null,
  "ipchecked": null,
  "tld": "app",
  "domain": "storysparx.app",
  "date": "2026-01-27",
  "requestMetadata": {
    "selectedDate": "2026-03-01",
    "codePunchDate": "20260301",
    "dateComparison": "gte",
    "keywords": ["%sparx%", "%storysparx%"],
    "tlds": ["com", "app", "store"],
    "totalLimit": 250,
    "sortField": "date",
    "sortOrder": "asc"
  },
  "responseMetadata": {
    "keyword": "%sparx%|%storysparx%",
    "datamode": "data",
    "source": "added domains",
    "requestedStart": 0,
    "requestedLimit": 250,
    "upstreamStart": 0,
    "upstreamLimit": 250,
    "totalRecords": 75,
    "upstreamDate": "2026-03-01",
    "upstreamTlds": "com,app,store",
    "sortField": "date",
    "sortOrder": "asc"
  },
  "enhancedAnalysis": {
    "status": "completed",
    "model": "deepseek/deepseek-v3.2",
    "sourceUrl": "https://storysparx.app/",
    "finalUrl": "https://storysparx.app/",
    "summary": "The homepage appears to present a branded website or landing page related to StorySparx. It contains real website copy rather than a parked-domain placeholder.",
    "extractedTextLength": 1842
  }
}
```

## Authentication and token handling

The actor uses your CodePunch API key and secret to obtain an access token, then reuses cached tokens when possible to reduce unnecessary authentication requests.

If a cached token is rejected by CodePunch, the actor automatically requests a fresh token and retries the query.

## Enhanced analysis

When `Enhanced analysis` is enabled, the actor:

1. Fetches the top-level homepage for each matching domain
2. Extracts visible text from the HTML
3. Sends domains to OpenRouter in batches of 10
4. Stores a short summary for each domain in `enhancedAnalysis`

If a homepage cannot be fetched, or if an AI analysis batch fails, the actor does not fail the run. Instead, the individual item receives a friendly fallback message in `enhancedAnalysis`.

## Notes

- The actor always requests JSON output from CodePunch.
- The actor always uses CodePunch data mode `data`.
- The date you select in the form is converted to the format required by CodePunch before the request is made.
- Enhanced analysis fetches only the top-level homepage content for each domain, not a full crawl.
- Results depend on your CodePunch subscription and API access.
