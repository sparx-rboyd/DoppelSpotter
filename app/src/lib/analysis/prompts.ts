import type { FindingSource } from '@/lib/types';

/**
 * System prompt for brand infringement classification.
 * Used for per-item analysis mode — AI analysis returns a single AnalysisOutput object.
 */
export const SYSTEM_PROMPT = `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

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

Set isFalsePositive: true if the result is clearly legitimate use of the brand name (e.g. the official website, a verified partner, a genuine news article with no intent to deceive).`;

/**
 * System prompt for batch (Google Search) analysis mode.
 * AI analysis assesses every individual organic and paid search result separately
 * and returns a BatchAnalysisOutput — an array of per-result items.
 */
export const BATCH_SYSTEM_PROMPT = `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

You will receive one or more Google Search results pages (SERP data) for a brand. Your task is to extract every individual organic result and paid result from all pages and assess each one separately for brand infringement.

You must respond with a raw JSON object matching this exact schema (no markdown, no code fences, just the JSON):
{
  "items": [
    {
      "url": "the exact URL of this result",
      "title": "the page title of this result",
      "severity": "high" | "medium" | "low",
      "analysis": "Plain-language explanation of what was found, why it is or isn't flagged, and what the business risk is (2-3 sentences)",
      "isFalsePositive": boolean
    }
  ],
  "suggestedSearches": ["query 1", "query 2"]
}

Rules for "items":
- Include every organic result (from organicResults[]) and every paid result (from paidResults[]) across all pages.
- Do NOT include the SERP page itself — assess individual result URLs only.
- Each item must have all five fields: url, title, severity, analysis, isFalsePositive.
- Each "analysis" must be a fully standalone description — do NOT reference or compare to any other item in the list (e.g. avoid phrases like "this is another X", "similar to the above", "like the previous result"). A reader should be able to understand each analysis without seeing any other result.

Severity guidelines:
- "high": Clear impersonation, phishing, counterfeit, or direct brand misuse posing immediate risk to customers or the brand
- "medium": Suspicious activity that warrants investigation but may have a legitimate explanation (e.g. fan accounts, resellers using the brand name)
- "low": Likely benign mention but worth logging (e.g. news articles, legitimate reviews)

Set isFalsePositive: true if the result is clearly legitimate use of the brand name (e.g. the official website, a verified partner, a genuine news article with no intent to deceive).

The "suggestedSearches" field is OPTIONAL. Only include it when you spot suspicious related search terms (from the "relatedQueries" sections) that warrant a dedicated follow-up search and were NOT already covered by the results above. Criteria:
- The query implies impersonation, fraud, or brand misuse (e.g. "fake [brand]", "[brand] scam")
- The query involves a lookalike name NOT covered in the results above
- You genuinely need more data before you can assess whether a threat exists

Do NOT suggest follow-up searches for clearly legitimate queries, queries already investigated, or more than 3 in total. Omit "suggestedSearches" entirely (do not include an empty array) if none are warranted.`;

/**
 * Build the user prompt for a specific finding.
 */
export function buildAnalysisPrompt(params: {
  brandName: string;
  keywords: string[];
  officialDomains: string[];
  watchWords?: string[];
  safeWords?: string[];
  ignoredUrls?: string[];
  source: FindingSource;
  rawData: Record<string, unknown>;
}): string {
  const { brandName, keywords, officialDomains, watchWords, safeWords, ignoredUrls, source, rawData } = params;

  const watchWordsLine = watchWords && watchWords.length > 0
    ? `Watch words (concerning terms the brand owner does NOT want associated with their brand — note any presence or implied association in your analysis): ${watchWords.join(', ')}`
    : null;

  const safeWordsLine = safeWords && safeWords.length > 0
    ? `Safe words (terms the brand owner is comfortable being associated with — if present, treat the result with reduced caution unless there are strong warning signs in other areas): ${safeWords.join(', ')}`
    : null;

  const ignoredUrlsLine = ignoredUrls && ignoredUrls.length > 0
    ? `Previously reviewed and dismissed URLs (the user has already acknowledged these — set isFalsePositive: true if the result URL matches any of these exactly):\n${ignoredUrls.map((u) => `  - ${u}`).join('\n')}`
    : null;

  return `Brand being protected: "${brandName}"
Brand keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}
Official domains: ${officialDomains.length > 0 ? officialDomains.join(', ') : 'none'}
${watchWordsLine ? `${watchWordsLine}\n` : ''}${safeWordsLine ? `${safeWordsLine}\n` : ''}${ignoredUrlsLine ? `${ignoredUrlsLine}\n` : ''}Monitoring surface: ${source}

Raw scraping result to analyse:
${JSON.stringify(rawData, null, 2)}

Analyse this result and return your assessment as JSON. Do not include "suggestedSearches" — this is a single-item analysis.`;
}

/**
 * Build the user prompt for a batch of items from the same actor run.
 * Used when an actor's analysisMode is 'batch' — all SERP pages are combined into
 * a single AI analysis call. AI analysis returns one assessment per individual search result.
 *
 * When canSuggestSearches is false (depth-1 follow-up runs), the prompt explicitly
 * instructs AI analysis not to include suggestedSearches so no further recursion occurs.
 */
export function buildBatchAnalysisPrompt(params: {
  brandName: string;
  keywords: string[];
  officialDomains: string[];
  watchWords?: string[];
  safeWords?: string[];
  ignoredUrls?: string[];
  source: FindingSource;
  rawItems: Record<string, unknown>[];
  /** Pass true for depth-0 runs so AI analysis knows it may suggest follow-up searches. */
  canSuggestSearches?: boolean;
}): string {
  const { brandName, keywords, officialDomains, watchWords, safeWords, ignoredUrls, source, rawItems, canSuggestSearches } = params;

  const watchWordsLine = watchWords && watchWords.length > 0
    ? `Watch words (concerning terms the brand owner does NOT want associated with their brand — flag any presence or implied association in the individual "analysis" field for that result): ${watchWords.join(', ')}`
    : null;

  const safeWordsLine = safeWords && safeWords.length > 0
    ? `Safe words (terms the brand owner is comfortable being associated with — if present in a result, treat it with reduced caution in the individual "analysis" field unless there are strong warning signs in other areas): ${safeWords.join(', ')}`
    : null;

  const ignoredUrlsLine = ignoredUrls && ignoredUrls.length > 0
    ? `Previously reviewed and dismissed URLs (the user has already acknowledged these — set isFalsePositive: true for any result whose URL exactly matches one of these):\n${ignoredUrls.map((u) => `  - ${u}`).join('\n')}`
    : null;

  const deepSearchInstruction = canSuggestSearches
    ? `Each result page may include a "relatedQueries" array. Review them for suspicious terms and include up to 3 in "suggestedSearches" if warranted (see system prompt criteria).`
    : `Do NOT include "suggestedSearches" in your response — this is a follow-up search and no further recursion is allowed.`;

  return `Brand being protected: "${brandName}"
Brand keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}
Official domains: ${officialDomains.length > 0 ? officialDomains.join(', ') : 'none'}
${watchWordsLine ? `${watchWordsLine}\n` : ''}${safeWordsLine ? `${safeWordsLine}\n` : ''}${ignoredUrlsLine ? `${ignoredUrlsLine}\n` : ''}Monitoring surface: ${source}

${deepSearchInstruction}

The following ${rawItems.length} SERP page(s) are from the same Google Search actor run. Assess every individual organic and paid result across all pages. Return one item in the "items" array per result URL.

Raw SERP data (${rawItems.length} page${rawItems.length !== 1 ? 's' : ''}):
${JSON.stringify(rawItems, null, 2)}`;
}
