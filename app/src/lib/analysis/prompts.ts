import type { FindingSource, Severity, UserPreferenceHints } from '@/lib/types';
import { MAX_FINDING_TAXONOMY_WORDS } from '@/lib/findings-taxonomy';
import type { GoogleRunContext, GoogleSearchCandidate } from './types';

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
      "platform": "Short platform label (preferably 1 word, maximum ${MAX_FINDING_TAXONOMY_WORDS} words)",
      "theme": "Short theme label (preferably 1 word, maximum ${MAX_FINDING_TAXONOMY_WORDS} words)",
      "analysis": "Plain-language explanation of what was found, why it is or isn't flagged, and what the business risk is (2-3 sentences)",
      "isFalsePositive": boolean
    }
  ]
}

Rules for "items":
- Include exactly one item for every input result candidate and reuse the exact same resultId.
- Assess only the provided result candidates. Do not add extra items and do not omit any candidate.
- Each item must have all seven fields: resultId, title, severity, platform, theme, analysis, isFalsePositive.
- Each indiviudal analysis must make sense in isolation. No referring to things like 'Another ...' or 'More examples of ...'
 - This applies to both the title and the analysis text
- Always return concise "platform" and "theme" labels. Prefer 1 word where natural, and never exceed ${MAX_FINDING_TAXONOMY_WORDS} words. Must be in title case. 
- If the user prompt includes existing platform/theme labels that fit, reuse one of them exactly.
- If none fit well, create a new short label rather than forcing a poor match.
- You MUST only create new platform labels for prominent, very-widely-used platforms (e.g. TikTok, Reddit, GitHub, X, Facebook etc.). Niche or lesser-known platforms MUST always be labelled 'Other'.
- Keep theme labels broad. It's better to have a small number of high quality theme labels than many low quality theme labels.
- You MUST not create very niche theme labels that few results would likely be linked with over time. 
- Never create theme labels like 'Unknown' or 'Unrelated' - use 'Other'.
- If historical user-review tendencies are provided, treat them only as soft guidance. Never let them override official domains, watch words, safe words, or clear evidence in the current result.

Severity guidelines:
- "high": Clear impersonation, phishing, counterfeit, or direct brand misuse posing immediate risk to customers or the brand
- "medium": Suspicious activity that warrants investigation but may have a legitimate explanation (e.g. fan accounts, resellers using the brand name)
- "low": Likely benign mention but worth logging (e.g. news articles, legitimate reviews)

Counter signals:
Treat results with less caution when ...
- Variations of the brand's name and protected keywords are used in an entirely different context to that of the brand (i.e. likely a legitimate use that wouldn't infringe the brand's trademarks)
- Where there is clearly no signal of intent to impersonate nor defraud the brand nor its customers/users

Set isFalsePositive: true if the result is clearly legitimate use of the brand name (e.g. the official website, a verified partner, a genuine news article with no intent to deceive).`;

/**
 * System prompt for the final per-scan summary.
 */
export const SCAN_SUMMARY_SYSTEM_PROMPT = `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

You will receive the actionable findings from one completed scan for a single brand.

Your task is to write a succinct executive summary of the scan results, with particular attention to recurring themes, worrying trends, and the most serious risks.
Use British English spelling and phrasing in all human-readable output fields.

You must respond with a raw JSON object matching this exact schema (no markdown, no code fences, just the JSON):
{
  "summary": "A concise 2-4 sentence summary of the scan findings"
}

Rules:
- Focus on patterns and overall risk, not a finding-by-finding list.
- Prioritise high-severity findings first, then medium, then low.
- Only describe evidence contained in the provided findings.
- Keep the tone neutral, analyst-style, and succinct.`;

/**
 * Format the exact chat messages sent to the LLM into a readable transcript
 * that can be stored on findings for later debug inspection.
 */
export function formatLlmPromptForDebug(systemPrompt: string, userPrompt: string): string {
  return [
    '[system]',
    systemPrompt,
    '',
    '[user]',
    userPrompt,
  ].join('\n');
}

export function buildGoogleFinalSelectionSystemPrompt(maxSuggestedSearches: number): string {
  return `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

You will receive metadata about a brand, an existing search term about the brand that has been executed, and suggested related searches as a result of this initial search.

Your task is to identify up to ${maxSuggestedSearches} follow-up Google searches that could be performed, that are likely to surface further evidence of potential brand misuse.

You will synthesise up to ${maxSuggestedSearches} entirely new queries based on the context that you're provided with, that you feel will help to surface the maximum number of potential threats to the brand.

You must respond with a raw JSON object matching this exact schema (no markdown, no code fences, just the JSON):
{
  "suggestedSearches": ["query 1", "query 2"]
}

Rules:
- "suggestedSearches" is optional. Omit it entirely if no follow-up queries are warranted.
- Suggest at most ${maxSuggestedSearches} follow-up Google queries
- Quality over quantity: return fewer than ${maxSuggestedSearches} queries when only a small number of genuinely useful follow-up searches are warranted.
- Prefer coverage across distinct brand misuse themes. Avoid spending multiple searches on near-duplicate variants of the same utheme when one broader query would cover them.
- Avoid focusing searches on specific websites, apps, platforms, resources, books, or tools etc. Instead, consolidate them into a broader query.
- Any newly synthesized query must stay grounded in the context that you're provided with.
- Do NOT suggest the original source query again or obvious paraphrases of it.
- Do NOT suggest clearly legitimate or generic navigational queries.
- Prefer concise Google-ready queries, not full sentences.
- Make use of Google search operators in your queries where you feel it would enhance the quality/depth of relevant search results.

For example: 

| Operator | Succinct Description | Example |
| :---- | :---- | :---- |
| **\`" "\` (Quotes)** | Forces an exact, word-for-word match of the enclosed phrase. | \`"climate change effects"\` |
| **\`-\` (Minus)** | Excludes specific words, phrases, or sites from the search results. | \`apple -fruit\` |
| **\`OR\` / \`|\`** | Returns results containing either one of the search terms (must be capitalized). | \`olympics 2024 OR 2028\` |
| **\`*\` (Asterisk)** | Acts as a wildcard to fill in missing words or phrases in a query. | \`the * of the rings\` |
| **\`( )\` (Parentheses)** | Groups search terms and operators to control the logical execution order. | \`(ipad OR iphone) -case\` |
| **\`intext:\`** | Returns pages containing the specified word in the body text of the page. | \`intext:algorithm\` |
| **\`allintext:\`** | Returns pages containing *all* specified words in the body text. | \`allintext:how to tie a tie\` |
| **\`#\`** | Searches for a specific hashtag across social platforms and websites. | \`#throwbackthursday\` |

`;
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
  userPreferenceHints?: UserPreferenceHints;
  existingPlatforms?: string[];
  existingThemes?: string[];
  source: FindingSource;
  candidates: GoogleSearchCandidate[];
  runContext: GoogleRunContext;
}): string {
  const {
    brandName,
    keywords,
    officialDomains,
    watchWords,
    safeWords,
    userPreferenceHints,
    existingPlatforms,
    existingThemes,
    source,
    candidates,
    runContext,
  } = params;

  const watchWordsLine = watchWords && watchWords.length > 0
    ? `Watch words (concerning terms the brand owner does NOT want associated with their brand — flag any presence or implied association in the individual "analysis" field for that result): ${watchWords.join(', ')}`
    : null;

  const safeWordsLine = safeWords && safeWords.length > 0
    ? `Safe words (terms the brand owner is comfortable being associated with — if present in a result, treat it with reduced caution in the individual "analysis" field unless there are strong warning signs in other areas): ${safeWords.join(', ')}`
    : null;

  const userPreferenceHintsSection = buildUserPreferenceHintsSection(source, userPreferenceHints);
  const existingPlatformsLine = `Existing platform labels for this brand (reuse one exactly if it fits; otherwise create a new short label): ${existingPlatforms && existingPlatforms.length > 0 ? existingPlatforms.join(', ') : 'none'}`;
  const existingThemesLine = `Existing theme labels for this brand (reuse one exactly if it fits; otherwise create a new short label): ${existingThemes && existingThemes.length > 0 ? existingThemes.join(', ') : 'none'}`;

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

  return `Brand being protected: "${brandName}"
Brand keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}
Official domains: ${officialDomains.length > 0 ? officialDomains.join(', ') : 'none'}
${watchWordsLine ? `${watchWordsLine}\n` : ''}${safeWordsLine ? `${safeWordsLine}\n` : ''}${userPreferenceHintsSection ? `${userPreferenceHintsSection}\n` : ''}${existingPlatformsLine}
${existingThemesLine}
Monitoring surface: ${source}

Supporting SERP context (for extra caution only — do NOT assess these as findings):
- Source queries: ${runContext.sourceQueries.length > 0 ? runContext.sourceQueries.join(' | ') : 'none'}
- Related queries: ${runContext.relatedQueries.length > 0 ? runContext.relatedQueries.join(' | ') : 'none'}
- People Also Ask: ${runContext.peopleAlsoAsk.length > 0 ? runContext.peopleAlsoAsk.join(' | ') : 'none'}

Assess every result candidate below and return one item in the "items" array per resultId.
Use British English in any human-readable text you generate.
Keep both taxonomy labels short: prefer 1 word where natural, never more than ${MAX_FINDING_TAXONOMY_WORDS} words.

Result candidates (${compactCandidates.length}):
${JSON.stringify(compactCandidates, null, 2)}`;
}

/**
 * Build the user prompt for the final Google deep-search selection pass.
 */
export function buildGoogleFinalSelectionPrompt(params: {
  brandName: string;
  keywords: string[];
  watchWords?: string[];
  safeWords?: string[];
  runContext: GoogleRunContext;
  maxSuggestedSearches: number;
}): string {
  const {
    brandName,
    keywords,
    watchWords,
    safeWords,
    runContext,
    maxSuggestedSearches,
  } = params;

  const watchWordsLine = watchWords && watchWords.length > 0
    ? `Watch words (concerning terms the brand owner does NOT want associated with their brand; you can use slices or combinations of these in your suggested queries as you see appropriate): ${watchWords.join(', ')}`
    : null;

  const safeWordsLine = safeWords && safeWords.length > 0
    ? `Safe words (terms the brand owner is comfortable being associated with; you can use these as negative keyword in your suggestion queries as you see appropriate): ${safeWords.join(', ')}`
    : null;

  return `Brand being protected: "${brandName}"

Brand keywords (keywords that the brand owner wants to monitor and protect; you can use slices or combinations of these in your suggested queries as you see appropriate): ${keywords.length > 0 ? keywords.join(', ') : 'none'}

${watchWordsLine ? `${watchWordsLine}\n\n` : ''}${safeWordsLine ? `${safeWordsLine}\n\n` : ''}Original search query:
${runContext.sourceQueries.length > 0 ? runContext.sourceQueries.map((query) => `- ${query}`).join('\n') : '- none'}

Suggested related queries returned by Google for the above search:
${runContext.relatedQueries.length > 0 ? runContext.relatedQueries.map((query) => `- ${query}`).join('\n') : '- none'}

People Also Ask queries returned by Google for the above search:
${runContext.peopleAlsoAsk.length > 0 ? runContext.peopleAlsoAsk.map((question) => `- ${question}`).join('\n') : '- none'}

Maximum number of follow-up Google searches you may suggest:
- ${maxSuggestedSearches}`;
}

/**
 * Build the user prompt for the final scan-summary pass.
 */
export function buildScanSummaryPrompt(params: {
  brandName: string;
  counts: {
    high: number;
    medium: number;
    low: number;
  };
  findings: Array<{
    severity: Severity;
    source: FindingSource;
    title: string;
    llmAnalysis: string;
    url?: string;
  }>;
}): string {
  const { brandName, counts, findings } = params;

  return `Brand being protected: "${brandName}"

Actionable finding counts:
- High: ${counts.high}
- Medium: ${counts.medium}
- Low: ${counts.low}

Actionable findings for this scan (${findings.length}):
${JSON.stringify(findings, null, 2)}

Write a concise overall summary of this scan (max 600 characters). 

Highlight recurring themes, repeated abuse patterns, or notably worrying trends if present.

Take care not to over-emphasise risk - especially when only medium and/or low risk findings are presented.`;
}

function buildUserPreferenceHintsSection(
  source: FindingSource,
  userPreferenceHints?: UserPreferenceHints,
): string | null {
  if (!userPreferenceHints) return null;

  const lines = uniqueStrings([
    ...(userPreferenceHints.sourceLines?.[source] ?? []),
    ...userPreferenceHints.globalLines,
  ]).slice(0, 3);

  if (lines.length === 0) {
    return null;
  }

  return `Historical user-review tendencies (soft hints only — use these as gentle guidance, not hard include/exclude rules, and do not override clear evidence):\n${lines.map((line) => `  - ${line}`).join('\n')}`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}
