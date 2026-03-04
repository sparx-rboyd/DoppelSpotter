import { Actor } from 'apify';

const WHOISXML_API_URL = 'https://brand-alert.whoisxmlapi.com/api/v2';

/**
 * DoppelSpotter — WhoisXML Brand Alert Actor
 *
 * Detects newly-registered domains containing brand keywords using the
 * WhoisXML Brand Alert API. Surfaces typosquatting, lookalike domains,
 * and potential impersonation attempts across 7,596+ TLDs.
 *
 * Input:
 *   apiKey        {string}   WhoisXML Brand Alert API key
 *   brandKeywords {string[]} Keywords to monitor (e.g. ["acme", "acmecorp"])
 *   lookbackDays  {number}   Days to look back (1–14, default 1)
 *   withTypos     {boolean}  Also return typo variants (default false)
 *
 * Output dataset items:
 *   domainName    {string}   The newly-registered domain
 *   tld           {string}   Top-level domain (e.g. ".com")
 *   registeredAt  {string}   ISO date of registration
 *   keyword       {string}   The brand keyword that matched
 *   whoisUrl      {string}   WHOIS lookup URL for the domain
 *   source        {string}   Always "whoisxml-brand-alert"
 */
await Actor.main(async () => {
  const input = await Actor.getInput();

  const {
    apiKey,
    brandKeywords = [],
    lookbackDays = 1,
    withTypos = false,
  } = input ?? {};

  if (!apiKey) {
    throw new Error('Input "apiKey" is required. Get one at https://brand-alert.whoisxmlapi.com/api');
  }
  if (!brandKeywords || brandKeywords.length === 0) {
    throw new Error('Input "brandKeywords" must be a non-empty array of strings.');
  }

  // WhoisXML Brand Alert API uses a sinceDate parameter (YYYY-MM-DD)
  const sinceDate = getSinceDate(lookbackDays);

  console.log(`Querying WhoisXML Brand Alert API for keywords: [${brandKeywords.join(', ')}]`);
  console.log(`Lookback: ${lookbackDays} day(s) since ${sinceDate}, withTypos: ${withTypos}`);
  if (brandKeywords.length > 4) {
    console.log(`Note: API limit is 4 terms — using top 4: [${brandKeywords.slice(0, 4).join(', ')}]`);
  }

  // WhoisXML Brand Alert API allows a maximum of 4 includeSearchTerms
  const searchTerms = brandKeywords.slice(0, 4);

  const requestBody = {
    apiKey,
    sinceDate,
    mode: 'purchase',
    withTypos,
    punycode: true,
    responseFormat: 'JSON',
    includeSearchTerms: searchTerms,
  };

  const response = await fetch(WHOISXML_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WhoisXML API error ${response.status}: ${text}`);
  }

  const data = await response.json();

  // The API returns { domainsList: [...] } on success
  const domains = data.domainsList ?? [];

  if (domains.length === 0) {
    console.log('No newly-registered domains found matching the brand keywords.');
    return;
  }

  console.log(`Found ${domains.length} domain(s) — writing to dataset.`);

  const items = domains.map((entry) => ({
    domainName: entry.domainName,
    tld: extractTld(entry.domainName),
    registeredAt: entry.date ?? sinceDate,
    keyword: matchedKeyword(entry.domainName, brandKeywords),
    whoisUrl: `https://www.whois.com/whois/${entry.domainName}`,
    source: 'whoisxml-brand-alert',
    rawEntry: entry,
  }));

  await Actor.pushData(items);
  console.log(`Done — ${items.length} item(s) pushed to dataset.`);
});

/** Returns a YYYY-MM-DD date string N days ago */
function getSinceDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Extracts the TLD from a domain name (e.g. "sparx.io" → ".io") */
function extractTld(domainName) {
  const parts = domainName.split('.');
  return parts.length >= 2 ? `.${parts[parts.length - 1]}` : '';
}

/** Returns the first keyword found in the domain name */
function matchedKeyword(domainName, keywords) {
  const lower = domainName.toLowerCase();
  return keywords.find((kw) => lower.includes(kw.toLowerCase())) ?? '';
}
