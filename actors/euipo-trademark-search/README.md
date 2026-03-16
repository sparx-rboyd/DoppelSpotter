# EUIPO Trademark Search

Search the official [EUIPO Trademark Search API](https://dev.euipo.europa.eu/product/trademark-search_100) for EU trademark filings matching one or more brand keywords. Built by DoppelSpotter and published at `doppelspotter/euipo-trademark-search`.

---

## Key features

- **Multi-keyword OR queries in a single run** — accepts a `keywords` array and compiles all terms into one RSQL OR group, so your entire brand vocabulary is covered in a single actor invocation: `(verbalElement=="*sparx*",verbalElement=="*sparx maths*")`.
- **Full support for multi-word brand names** — all search values are correctly quoted in RSQL so terms containing spaces work exactly as expected: `verbalElement=="*sparx maths*"`.
- **Expiry-aware token caching** — the EUIPO OAuth2 response includes an 8-hour `expires_in`. The actor caches the access token in an Apify Key-Value Store and reuses it until it is within 5 minutes of expiry, so most runs start immediately without re-authenticating.
- **Refresh-token grant** — when a token nears expiry, the actor uses the `refresh_token` returned by EUIPO to silently extend the session rather than re-sending full credentials.
- **429 rate-limit handling** — respects the EUIPO `Retry-After` header and retries automatically.
- **Optional trademark filters** — filter results by Nice class, trademark status, and mark type directly from the input schema.
- **Demo mode** — runs without credentials and outputs registration instructions rather than failing the run, so the Apify Store healthcheck works out of the box.

---

## Authentication

1. Register a free account at [dev.euipo.europa.eu](https://dev.euipo.europa.eu/)
2. Create an app to receive a **Client ID** and **Client Secret**
3. Subscribe to the **Trademark search** API plan

The actor uses the OAuth2 `client_credentials` flow and caches the resulting access token in an Apify Key-Value Store named `euipo-token-cache` so subsequent runs in the same Apify account can reuse it without round-tripping to the auth server on every invocation.

---

## Input

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string (secret) | yes | EUIPO developer portal Client ID |
| `clientSecret` | string (secret) | yes | EUIPO developer portal Client Secret |
| `keywords` | string[] | yes | Brand keywords; multi-word terms with spaces are fully supported |
| `dateFrom` | string (YYYY-MM-DD) | no | Lower bound for the trademark application date |
| `dateTo` | string (YYYY-MM-DD) | no | Upper bound for the trademark application date |
| `maxResults` | integer 1–500 | no | Default: 50 |
| `niceClass` | string | no | Comma-separated class numbers, e.g. `9,42` |
| `status` | enum | no | `REGISTERED`, `APPLICATION_PUBLISHED`, etc. |
| `markFeature` | enum | no | `WORD`, `FIGURATIVE`, etc. |
| `useSandbox` | boolean | no | Default: `false`. Use EUIPO sandbox for testing |

---

## Output

One dataset item per matching trademark application:

```json
{
  "applicationNumber": "019301286",
  "markName": "SparX Wallet",
  "applicantName": "BROXUS HOLDINGS LTD",
  "niceClasses": "9, 42",
  "filingDate": "2026-01-09",
  "registrationDate": "",
  "expiryDate": "",
  "status": "APPLICATION_PUBLISHED",
  "markType": "Word Mark",
  "markKind": "Individual",
  "markBasis": "EU Trademark",
  "representativeName": "",
  "goodsAndServicesDescription": "Class 9: ...",
  "renewalStatus": "",
  "markImageUrl": "",
  "euipoUrl": "https://euipo.europa.eu/eSearch/#basic/1+1+1+1/50+50+50+50/019301286",
  "extractedAt": "2026-03-16T12:00:00.000Z",
  "requestMetadata": {
    "keywords": ["sparx", "sparx maths"],
    "dateFrom": "2025-03-15",
    "dateTo": "2026-03-16",
    "maxResults": 50,
    "filter": "(wordMarkSpecification.verbalElement==\"*sparx*\",wordMarkSpecification.verbalElement==\"*sparx maths*\");applicationDate>=\"2025-03-15\";applicationDate<=\"2026-03-16\"",
    "page": 0,
    "useSandbox": false
  }
}
```

---

## Demo mode

If no credentials are provided, the actor runs in demo mode and emits a single diagnostic dataset item explaining how to register for EUIPO API access, rather than failing the run. This lets the Apify Store healthcheck work without secrets.
