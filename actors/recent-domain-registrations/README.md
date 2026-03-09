# Recent Domain Registrations

Search recent domain registrations from the CodePunch GTLD Domain Name Activity Feed v2 using keyword, date, and TLD filters.

This actor is useful when you want to monitor newly registered domains that may reference a brand, product name, campaign, or watch word. It queries the CodePunch `/added` feed, paginates through results automatically, and returns one dataset item per matching domain.

You will need an active CodePunch subscription and valid API credentials to use this actor. [More information](https://codepunch.com/dnfeed/v2/).

## What this actor does

- Searches recent domain registrations from the CodePunch `added` feed
- Supports one or more keywords in a single run
- Lets you filter by date comparison and optional TLDs
- Auto-paginates until all matches are retrieved or your selected limit is reached
- Outputs one Apify dataset item per matching domain

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
6. Optionally choose sort field and sort order.
7. Set a total limit for the maximum number of results to return.

## Input fields

| Field | Required | What it means |
| --- | --- | --- |
| `CodePunch API key` | Yes | Your CodePunch API key. |
| `CodePunch API secret` | Yes | Your CodePunch API secret. |
| `Date` | Yes | The reference date used for the search. |
| `Date comparison` | Yes | How the selected date should be applied to the query. |
| `Keywords` | Yes | One or more terms to search for in recent registrations. |
| `TLDs` | No | Optional list of top-level domains to include. |
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
  }
}
```

## Authentication and token handling

The actor uses your CodePunch API key and secret to obtain an access token, then reuses cached tokens when possible to reduce unnecessary authentication requests.

If a cached token is rejected by CodePunch, the actor automatically requests a fresh token and retries the query.

## Notes

- The actor always requests JSON output from CodePunch.
- The actor always uses CodePunch data mode `data`.
- The date you select in the form is converted to the format required by CodePunch before the request is made.
- Results depend on your CodePunch subscription and API access.
