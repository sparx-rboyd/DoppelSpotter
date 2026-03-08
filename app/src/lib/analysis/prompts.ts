import type { FindingSource, Severity, UserPreferenceHints } from '@/lib/types';
import { MAX_FINDING_TAXONOMY_WORDS } from '@/lib/findings-taxonomy';
import type { GoogleScannerConfig, ScannerConfig } from '@/lib/scan-sources';
import {
  buildGoogleClassificationSurfaceLine,
  buildGoogleDeepSearchSystemPolicy,
  buildGoogleDeepSearchUserPolicy,
} from './google-scanner-policy';
import type {
  DiscordRunContext,
  DiscordServerCandidate,
  GoogleRunContext,
  GoogleSearchCandidate,
} from './types';

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
      "theme": "Short theme label (preferably 1 word, maximum ${MAX_FINDING_TAXONOMY_WORDS} words)",
      "analysis": "Plain-language explanation of what was found, why it is or isn't flagged, and what the business risk is (2-3 sentences)",
      "isFalsePositive": boolean
    }
  ]
}

Rules for "items":
- Include exactly one item for every input result candidate and reuse the exact same resultId.
- Assess only the provided result candidates. Do not add extra items and do not omit any candidate.
- Each item must have all six fields: resultId, title, severity, theme, analysis, isFalsePositive.
- Each indiviudal analysis must make sense in isolation. No referring to things like 'Another ...' or 'More examples of ...'
 - This applies to both the title and the analysis text
- Always return a concise "theme" label. Prefer 1 word where natural, and never exceed ${MAX_FINDING_TAXONOMY_WORDS} words. Must be in title case.
- If the user prompt includes existing theme labels that fit, reuse one of them exactly.
- If none fit well, create a new short label rather than forcing a poor match.
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
 * System prompt for chunked Discord server classification.
 */
export const DISCORD_CLASSIFICATION_SYSTEM_PROMPT = `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

You will receive a compact list of public Discord server candidates for a brand, plus supporting discovery context such as observed categories, keywords, locales, and the search terms used.

Your task is to assess ONLY the provided Discord server candidates for potential brand infringement or suspicious brand misuse.
Do not invent extra servers. Do not assess private Discord activity, messages, or behaviour that is not evidenced by the provided metadata.
Use British English spelling and phrasing in all human-readable output fields.

You must respond with a raw JSON object matching this exact schema (no markdown, no code fences, just the JSON):
{
  "items": [
    {
      "resultId": "the exact resultId from the input candidate",
      "title": "Short, descriptive title of the finding (max 10 words)",
      "severity": "high" | "medium" | "low",
      "theme": "Short theme label (preferably 1 word, maximum ${MAX_FINDING_TAXONOMY_WORDS} words)",
      "analysis": "Plain-language explanation of what was found, why it is or isn't flagged, and what the business risk is (2-3 sentences)",
      "isFalsePositive": boolean
    }
  ]
}

Rules for "items":
- Include exactly one item for every input server candidate and reuse the exact same resultId.
- Assess only the provided server candidates. Do not add extra items and do not omit any candidate.
- Each item must have all six fields: resultId, title, severity, theme, analysis, isFalsePositive.
- Each individual analysis must make sense in isolation. No referring to things like 'Another ...' or 'More examples of ...'
- This applies to both the title and the analysis text.
- Always return a concise "theme" label. Prefer 1 word where natural, and never exceed ${MAX_FINDING_TAXONOMY_WORDS} words. Must be in title case.
- If the user prompt includes existing theme labels that fit, reuse one of them exactly.
- If none fit well, create a new short label rather than forcing a poor match.
- Keep theme labels broad. It's better to have a small number of high quality theme labels than many low quality theme labels.
- Never create theme labels like 'Unknown' or 'Unrelated' - use 'Other'.
- If historical user-review tendencies are provided, treat them only as soft guidance. Never let them override official domains, watch words, safe words, or clear evidence in the current server metadata.

Severity guidelines:
- "high": Clear impersonation, scam support, fake official community claims, or direct brand misuse posing immediate risk to customers or the brand
- "medium": Suspicious branding, unofficial communities, resale/promo activity, or risky associations that warrant investigation but may have a legitimate explanation
- "low": Likely benign mention or discussion community worth logging, but with limited evidence of harmful intent

Counter signals:
Treat servers with less caution when ...
- The metadata strongly suggests a legitimate fan, hobby, or discussion community rather than an official impersonation attempt
- The server clearly does not claim to represent the brand nor entice users into harmful activity

Set isFalsePositive: true if the server is clearly legitimate use of the brand name, such as an official community, an obviously benign discussion group, or a community with no sign of deception.`;

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

export function buildGoogleFinalSelectionSystemPrompt(
  maxSuggestedSearches: number,
  scanner: GoogleScannerConfig,
): string {
  const scannerPolicy = buildGoogleDeepSearchSystemPolicy(scanner);

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
${scannerPolicy ? `${scannerPolicy}\n` : ''}

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

export function buildDiscordFinalSelectionSystemPrompt(
  maxSuggestedSearches: number,
  scanner: ScannerConfig,
): string {
  return `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

You will receive metadata about a brand, the Discord server search terms already used, and patterns observed in the public Discord servers returned so far.

Your task is to identify up to ${maxSuggestedSearches} follow-up Discord server discovery keyword searches that are likely to surface further evidence of potential brand misuse.

You must respond with a raw JSON object matching this exact schema (no markdown, no code fences, just the JSON):
{
  "suggestedSearches": ["query 1", "query 2"]
}

Rules:
- "suggestedSearches" is optional. Omit it entirely if no follow-up searches are warranted.
- Suggest at most ${maxSuggestedSearches} follow-up Discord server search keywords or short phrases.
- Quality over quantity: return fewer than ${maxSuggestedSearches} queries when only a small number of genuinely useful follow-ups are warranted.
- Prefer coverage across distinct abuse themes rather than near-duplicate query variants.
- Do NOT suggest the original search terms again or obvious paraphrases of them.
- Do NOT suggest clearly legitimate or generic navigational searches.
- Prefer short Discord-ready keywords or short phrases, not full sentences.
- Keep every suggestion grounded in the provided evidence and metadata.
- This pass is specifically for ${scanner.displayName}.`;
}

/**
 * Build the user prompt for a chunk of normalized Google result candidates.
 */
export function buildGoogleChunkAnalysisPrompt(params: {
  scanner: GoogleScannerConfig;
  brandName: string;
  keywords: string[];
  officialDomains: string[];
  watchWords?: string[];
  safeWords?: string[];
  userPreferenceHints?: UserPreferenceHints;
  existingThemes?: string[];
  source: FindingSource;
  candidates: GoogleSearchCandidate[];
  runContext: GoogleRunContext;
}): string {
  const {
    scanner,
    brandName,
    keywords,
    officialDomains,
    watchWords,
    safeWords,
    userPreferenceHints,
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
  const existingThemesLine = `Existing theme labels for this brand (reuse one exactly if it fits; otherwise create a new short label): ${existingThemes && existingThemes.length > 0 ? existingThemes.join(', ') : 'none'}`;
  const monitoringSurfaceLine = buildGoogleClassificationSurfaceLine(scanner);

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
${watchWordsLine ? `${watchWordsLine}\n` : ''}${safeWordsLine ? `${safeWordsLine}\n` : ''}${userPreferenceHintsSection ? `${userPreferenceHintsSection}\n` : ''}${existingThemesLine}
${monitoringSurfaceLine}

Supporting SERP context (for extra caution only — do NOT assess these as findings):
- Source queries: ${runContext.sourceQueries.length > 0 ? runContext.sourceQueries.join(' | ') : 'none'}
- Related queries: ${runContext.relatedQueries.length > 0 ? runContext.relatedQueries.join(' | ') : 'none'}
- People Also Ask: ${runContext.peopleAlsoAsk.length > 0 ? runContext.peopleAlsoAsk.join(' | ') : 'none'}

Assess every result candidate below and return one item in the "items" array per resultId.
Use British English in any human-readable text you generate.
Keep the theme label short: prefer 1 word where natural, never more than ${MAX_FINDING_TAXONOMY_WORDS} words.

Result candidates (${compactCandidates.length}):
${JSON.stringify(compactCandidates, null, 2)}`;
}

export function buildDiscordChunkAnalysisPrompt(params: {
  brandName: string;
  keywords: string[];
  officialDomains: string[];
  watchWords?: string[];
  safeWords?: string[];
  userPreferenceHints?: UserPreferenceHints;
  existingThemes?: string[];
  source: FindingSource;
  candidates: DiscordServerCandidate[];
  runContext: DiscordRunContext;
}): string {
  const {
    brandName,
    keywords,
    officialDomains,
    watchWords,
    safeWords,
    userPreferenceHints,
    existingThemes,
    source,
    candidates,
    runContext,
  } = params;

  const watchWordsLine = watchWords && watchWords.length > 0
    ? `Watch words (concerning terms the brand owner does NOT want associated with their brand — flag any presence or implied association in the individual "analysis" field for that server): ${watchWords.join(', ')}`
    : null;

  const safeWordsLine = safeWords && safeWords.length > 0
    ? `Safe words (terms the brand owner is comfortable being associated with — if present in a server, treat it with reduced caution in the individual "analysis" field unless there are strong warning signs elsewhere): ${safeWords.join(', ')}`
    : null;

  const userPreferenceHintsSection = buildUserPreferenceHintsSection(source, userPreferenceHints);
  const existingThemesLine = `Existing theme labels for this brand (reuse one exactly if it fits; otherwise create a new short label): ${existingThemes && existingThemes.length > 0 ? existingThemes.join(', ') : 'none'}`;
  const compactCandidates = candidates.map((candidate) => ({
    resultId: candidate.resultId,
    serverId: candidate.serverId,
    inviteUrl: candidate.inviteUrl,
    vanityUrlCode: candidate.vanityUrlCode,
    name: candidate.name,
    description: candidate.description,
    keywords: candidate.keywords,
    categories: candidate.categories,
    primaryCategory: candidate.primaryCategory,
    features: candidate.features,
    approximateMemberCount: candidate.approximateMemberCount,
    approximatePresenceCount: candidate.approximatePresenceCount,
    preferredLocale: candidate.preferredLocale,
    isPublished: candidate.isPublished,
    premiumSubscriptionCount: candidate.premiumSubscriptionCount,
  }));

  return `Brand being protected: "${brandName}"
Brand keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}
Official domains: ${officialDomains.length > 0 ? officialDomains.join(', ') : 'none'}
${watchWordsLine ? `${watchWordsLine}\n` : ''}${safeWordsLine ? `${safeWordsLine}\n` : ''}${userPreferenceHintsSection ? `${userPreferenceHintsSection}\n` : ''}${existingThemesLine}
Monitoring surface: Discord servers

Supporting Discord discovery context:
- Search terms used: ${runContext.sourceQueries.length > 0 ? runContext.sourceQueries.join(' | ') : 'none'}
- Observed server keywords: ${runContext.observedKeywords.length > 0 ? runContext.observedKeywords.join(' | ') : 'none'}
- Observed categories: ${runContext.observedCategories.length > 0 ? runContext.observedCategories.join(' | ') : 'none'}
- Observed locales: ${runContext.observedLocales.length > 0 ? runContext.observedLocales.join(' | ') : 'none'}

Assess every server candidate below and return one item in the "items" array per resultId.
Use British English in any human-readable text you generate.
Keep the theme label short: prefer 1 word where natural, never more than ${MAX_FINDING_TAXONOMY_WORDS} words.

Discord server candidates (${compactCandidates.length}):
${JSON.stringify(compactCandidates, null, 2)}`;
}

/**
 * Build the user prompt for the final Google deep-search selection pass.
 */
export function buildGoogleFinalSelectionPrompt(params: {
  scanner: GoogleScannerConfig;
  brandName: string;
  keywords: string[];
  watchWords?: string[];
  safeWords?: string[];
  runContext: GoogleRunContext;
  maxSuggestedSearches: number;
}): string {
  const {
    scanner,
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
  const scannerPolicy = buildGoogleDeepSearchUserPolicy(scanner);

  return `Brand being protected: "${brandName}"

Brand keywords (keywords that the brand owner wants to monitor and protect; you can use slices or combinations of these in your suggested queries as you see appropriate): ${keywords.length > 0 ? keywords.join(', ') : 'none'}

${watchWordsLine ? `${watchWordsLine}\n\n` : ''}${safeWordsLine ? `${safeWordsLine}\n\n` : ''}${scannerPolicy ? `${scannerPolicy}\n\n` : ''}Original search query:
${runContext.sourceQueries.length > 0 ? runContext.sourceQueries.map((query) => `- ${query}`).join('\n') : '- none'}

Suggested related queries returned by Google for the above search:
${runContext.relatedQueries.length > 0 ? runContext.relatedQueries.map((query) => `- ${query}`).join('\n') : '- none'}

People Also Ask queries returned by Google for the above search:
${runContext.peopleAlsoAsk.length > 0 ? runContext.peopleAlsoAsk.map((question) => `- ${question}`).join('\n') : '- none'}

Maximum number of follow-up Google searches you may suggest:
- ${maxSuggestedSearches}`;
}

export function buildDiscordFinalSelectionPrompt(params: {
  brandName: string;
  keywords: string[];
  watchWords?: string[];
  safeWords?: string[];
  runContext: DiscordRunContext;
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
    ? `Safe words (terms the brand owner is comfortable being associated with; use these to avoid over-focusing on clearly benign communities): ${safeWords.join(', ')}`
    : null;

  return `Brand being protected: "${brandName}"

Brand keywords (keywords that the brand owner wants to monitor and protect; you can use slices or combinations of these in your suggested queries as you see appropriate): ${keywords.length > 0 ? keywords.join(', ') : 'none'}

${watchWordsLine ? `${watchWordsLine}\n\n` : ''}${safeWordsLine ? `${safeWordsLine}\n\n` : ''}Original Discord server search terms:
${runContext.sourceQueries.length > 0 ? runContext.sourceQueries.map((query) => `- ${query}`).join('\n') : '- none'}

Observed server names:
${runContext.sampleServerNames.length > 0 ? runContext.sampleServerNames.map((name) => `- ${name}`).join('\n') : '- none'}

Observed Discord server keywords:
${runContext.observedKeywords.length > 0 ? runContext.observedKeywords.map((value) => `- ${value}`).join('\n') : '- none'}

Observed Discord categories:
${runContext.observedCategories.length > 0 ? runContext.observedCategories.map((value) => `- ${value}`).join('\n') : '- none'}

Observed locales:
${runContext.observedLocales.length > 0 ? runContext.observedLocales.map((value) => `- ${value}`).join('\n') : '- none'}

Maximum number of follow-up Discord server searches you may suggest:
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
