import type { FindingSource } from '@/lib/types';
import type { GoogleRunContext, GoogleSearchCandidate } from './types';

/**
 * System prompt for brand infringement classification.
 * Used for per-item analysis mode — AI analysis returns a single AnalysisOutput object.
 */
export const SYSTEM_PROMPT = `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

Your task is to analyse a web scraping result and determine whether it represents a potential brand infringement.
Use British English spelling and phrasing in all human-readable output fields.

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
 * System prompt for chunked Google Search classification.
 * AI analysis assesses only the provided normalized organic result candidates and
 * returns one structured assessment per resultId.
 */
export const GOOGLE_CLASSIFICATION_SYSTEM_PROMPT = `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

You will receive a compact list of Google organic search result candidates for a brand, plus supporting SERP context such as related queries and People Also Ask questions.

Your task is to assess ONLY the provided result candidates for potential brand infringement.
Do not invent extra results. Do not assess ads. Do not turn related queries or People Also Ask questions into findings.
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
  ],
  "suggestedSearches": ["query 1", "query 2"]
}

Rules for "items":
- Include exactly one item for every input result candidate and reuse the exact same resultId.
- Assess only the provided result candidates. Do not add extra items and do not omit any candidate.
- Each item must have all five fields: resultId, title, severity, analysis, isFalsePositive.
- Each "analysis" must be a fully standalone description — do NOT reference or compare to any other item in the list (e.g. avoid phrases like "this is another X", "similar to the above", "like the previous result"). A reader should be able to understand each analysis without seeing any other result.

Rules for "suggestedSearches":
- "suggestedSearches" is optional. Omit it entirely if no follow-up searches are warranted.
- Suggest at most 3 follow-up Google queries.
- Ground every suggested query in the suspicious result candidates and supporting context you were given for this chunk.
- Use suggestions to expand likely impersonation, fraud, cheating/solver abuse, lookalike branding, or customer-confusion patterns that merit another Google search.
- Do NOT suggest the original source query again or obvious paraphrases of it.
- Do NOT suggest clearly legitimate or generic navigational queries.
- Prefer concise Google-ready queries, not full sentences.

Severity guidelines:
- "high": Clear impersonation, phishing, counterfeit, or direct brand misuse posing immediate risk to customers or the brand
- "medium": Suspicious activity that warrants investigation but may have a legitimate explanation (e.g. fan accounts, resellers using the brand name)
- "low": Likely benign mention but worth logging (e.g. news articles, legitimate reviews)

Set isFalsePositive: true if the result is clearly legitimate use of the brand name (e.g. the official website, a verified partner, a genuine news article with no intent to deceive).`;

/**
 * System prompt for run-level Google deep-search suggestioning.
 * This fallback pass sees SERP context plus notable candidate assessments and any
 * chunk-proposed queries, so it can recover when chunk-level suggestions are too strict.
 */
export const GOOGLE_SUGGESTION_SYSTEM_PROMPT = `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

You will receive:
- run-level Google SERP context such as related queries and People Also Ask questions
- a shortlist of notable result assessments from the current scan
- any follow-up queries already suggested by chunk-level analysis

Your task is to decide which follow-up Google searches, if any, should be run next to investigate likely brand misuse.

You must respond with a raw JSON object matching this exact schema (no markdown, no code fences, just the JSON):
{
  "suggestedSearches": ["query 1", "query 2"]
}

Rules:
- "suggestedSearches" is optional. Omit it entirely if no follow-up queries are warranted.
- Suggest at most 3 follow-up Google queries.
- Use the SERP context and notable result assessments together. If current results are mostly benign but the SERP intent signals are suspicious, you may still suggest follow-up queries.
- Prefer queries that could uncover impersonation, fraud, cheating/solver abuse, lookalike branding, customer confusion, or adjacent abusive behaviour.
- You may refine or replace chunk-proposed queries if you can produce stronger, more targeted ones.
- Do NOT suggest the original source query again or obvious paraphrases of it.
- Do NOT suggest clearly legitimate or generic navigational queries.
- Prefer concise Google-ready queries, not full sentences.`;

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

Analyse this result and return your assessment as JSON. Use British English in any human-readable text you generate. Do not include "suggestedSearches" — this is a single-item analysis.`;
}

/**
 * Build the user prompt for a chunk of normalized Google result candidates.
 */
export function buildGoogleChunkAnalysisPrompt(params: {
  brandName: string;
  keywords: string[];
  officialDomains: string[];
  watchWords?: string[];
  safeWords?: string[];
  ignoredUrls?: string[];
  source: FindingSource;
  candidates: GoogleSearchCandidate[];
  runContext: GoogleRunContext;
  canSuggestSearches: boolean;
}): string {
  const { brandName, keywords, officialDomains, watchWords, safeWords, ignoredUrls, source, candidates, runContext, canSuggestSearches } = params;

  const watchWordsLine = watchWords && watchWords.length > 0
    ? `Watch words (concerning terms the brand owner does NOT want associated with their brand — flag any presence or implied association in the individual "analysis" field for that result): ${watchWords.join(', ')}`
    : null;

  const safeWordsLine = safeWords && safeWords.length > 0
    ? `Safe words (terms the brand owner is comfortable being associated with — if present in a result, treat it with reduced caution in the individual "analysis" field unless there are strong warning signs in other areas): ${safeWords.join(', ')}`
    : null;

  const ignoredUrlsLine = ignoredUrls && ignoredUrls.length > 0
    ? `Previously reviewed and dismissed URLs (the user has already acknowledged these — set isFalsePositive: true for any result whose URL exactly matches one of these):\n${ignoredUrls.map((u) => `  - ${u}`).join('\n')}`
    : null;

  const compactCandidates = candidates.map((candidate) => ({
    resultId: candidate.resultId,
    url: candidate.url,
    title: candidate.title,
    displayedUrl: candidate.displayedUrl,
    description: candidate.description,
    emphasizedKeywords: candidate.emphasizedKeywords ?? [],
    pageNumbers: candidate.pageNumbers,
    positions: candidate.positions,
    appearanceCount: candidate.sightings.length,
  }));

  const suggestionInstruction = canSuggestSearches
    ? 'If this chunk reveals worthwhile next-step searches, include up to 3 grounded follow-up queries in "suggestedSearches".'
    : 'Do NOT include "suggestedSearches" in your response for this run.';

  return `Brand being protected: "${brandName}"
Brand keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}
Official domains: ${officialDomains.length > 0 ? officialDomains.join(', ') : 'none'}
${watchWordsLine ? `${watchWordsLine}\n` : ''}${safeWordsLine ? `${safeWordsLine}\n` : ''}${ignoredUrlsLine ? `${ignoredUrlsLine}\n` : ''}Monitoring surface: ${source}

Supporting SERP context (for extra caution only — do NOT assess these as findings):
- Source queries: ${runContext.sourceQueries.length > 0 ? runContext.sourceQueries.join(' | ') : 'none'}
- Related queries: ${runContext.relatedQueries.length > 0 ? runContext.relatedQueries.join(' | ') : 'none'}
- People Also Ask: ${runContext.peopleAlsoAsk.length > 0 ? runContext.peopleAlsoAsk.join(' | ') : 'none'}

Assess every result candidate below and return one item in the "items" array per resultId.
Use British English in any human-readable text you generate.
${suggestionInstruction}

Result candidates (${compactCandidates.length}):
${JSON.stringify(compactCandidates, null, 2)}`;
}

/**
 * Build the user prompt for the aggregate Google suggestion fallback pass.
 */
export function buildGoogleSuggestionPrompt(params: {
  brandName: string;
  keywords: string[];
  officialDomains: string[];
  watchWords?: string[];
  safeWords?: string[];
  source: FindingSource;
  runContext: GoogleRunContext;
  notableCandidates: Array<Record<string, unknown>>;
  chunkSuggestedSearches?: string[];
}): string {
  const {
    brandName,
    keywords,
    officialDomains,
    watchWords,
    safeWords,
    source,
    runContext,
    notableCandidates,
    chunkSuggestedSearches,
  } = params;

  const watchWordsLine = watchWords && watchWords.length > 0
    ? `Watch words (concerning terms the brand owner does NOT want associated with their brand): ${watchWords.join(', ')}`
    : null;

  const safeWordsLine = safeWords && safeWords.length > 0
    ? `Safe words (terms the brand owner is comfortable being associated with): ${safeWords.join(', ')}`
    : null;

  return `Brand being protected: "${brandName}"
Brand keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}
Official domains: ${officialDomains.length > 0 ? officialDomains.join(', ') : 'none'}
${watchWordsLine ? `${watchWordsLine}\n` : ''}${safeWordsLine ? `${safeWordsLine}\n` : ''}Monitoring surface: ${source}

Current source queries:
${runContext.sourceQueries.length > 0 ? runContext.sourceQueries.map((query) => `- ${query}`).join('\n') : '- none'}

Related queries:
${runContext.relatedQueries.length > 0 ? runContext.relatedQueries.map((query) => `- ${query}`).join('\n') : '- none'}

People Also Ask:
${runContext.peopleAlsoAsk.length > 0 ? runContext.peopleAlsoAsk.map((question) => `- ${question}`).join('\n') : '- none'}

Chunk-proposed follow-up queries:
${chunkSuggestedSearches && chunkSuggestedSearches.length > 0 ? chunkSuggestedSearches.map((query) => `- ${query}`).join('\n') : '- none'}

Notable assessed candidates from this run:
${JSON.stringify(notableCandidates, null, 2)}

Return up to 3 follow-up Google search queries only if they would materially help investigate suspicious brand misuse.`;
}
