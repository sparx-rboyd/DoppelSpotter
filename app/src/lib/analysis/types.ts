import type { FindingSource, GoogleScannerId, ScannerId, Severity } from '@/lib/types';
import { normalizeFindingTaxonomyLabel } from '@/lib/findings-taxonomy';

/**
 * A single Google result appearance captured from a SERP page.
 */
export interface GoogleSearchSighting {
  runId: string;
  source: FindingSource;
  scannerId: GoogleScannerId;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  page: number;
  position?: number;
  title: string;
  displayedUrl?: string;
  description?: string;
  emphasizedKeywords?: string[];
}

/**
 * A deduplicated Google result candidate, keyed by normalized URL.
 * Repeated appearances on different pages are merged into one candidate before
 * AI analysis so the same URL is only classified once per run.
 */
export interface GoogleSearchCandidate {
  resultId: string;
  url: string;
  normalizedUrl: string;
  title: string;
  displayedUrl?: string;
  description?: string;
  emphasizedKeywords?: string[];
  pageNumbers: number[];
  positions: number[];
  sightings: GoogleSearchSighting[];
}

/**
 * Run-level Google SERP context shared across chunked AI analysis calls.
 * These signals help with classification and deep-search suggestioning, but
 * they are not findings in their own right.
 */
export interface GoogleRunContext {
  sourceQueries: string[];
  relatedQueries: string[];
  peopleAlsoAsk: string[];
}

/**
 * One assessed Google result returned by chunked AI analysis.
 * resultId must match one of the provided input candidates exactly.
 */
export interface GoogleChunkAnalysisItem {
  resultId: string;
  title: string;
  severity: Severity;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
}

/**
 * The structured JSON output expected from chunked Google result analysis.
 */
export interface GoogleChunkAnalysisOutput {
  items: GoogleChunkAnalysisItem[];
}

/**
 * The structured JSON output expected from the final Google deep-search
 * selection pass.
 */
export interface GoogleSuggestionOutput {
  suggestedSearches?: string[];
}

/**
 * The structured JSON output expected from the final per-scan summary pass.
 */
export interface ScanSummaryOutput {
  summary: string;
}

/**
 * Compact stored debug payload for Google findings.
 */
export interface GoogleStoredFindingRawData extends Record<string, unknown> {
  kind: 'google-normalized';
  version: 2;
  normalizedUrl: string;
  result: {
    rawUrl: string;
    normalizedUrl: string;
    title: string;
    displayedUrl?: string;
    description?: string;
    emphasizedKeywords?: string[];
  };
  sightings: GoogleSearchSighting[];
  context: GoogleRunContext;
  analysis: {
    source: 'llm' | 'fallback';
    runId: string;
    findingSource: FindingSource;
    scannerId: GoogleScannerId;
    searchDepth: number;
    searchQuery?: string;
    displayQuery?: string;
  };
}

/**
 * One joinable Discord server candidate returned by the public-server scraper.
 */
export interface DiscordServerCandidate {
  resultId: string;
  serverId: string;
  inviteUrl: string;
  vanityUrlCode: string;
  name: string;
  description?: string;
  keywords: string[];
  categories: string[];
  primaryCategory?: string;
  features: string[];
  approximateMemberCount?: number;
  approximatePresenceCount?: number;
  premiumSubscriptionCount?: number;
  preferredLocale?: string;
  isPublished?: boolean;
}

/**
 * Run-level Discord context shared with chunked analysis.
 */
export interface DiscordRunContext {
  sourceQueries: string[];
  observedKeywords: string[];
  observedCategories: string[];
  observedLocales: string[];
  sampleServerNames: string[];
}

/**
 * One assessed Discord server returned by chunked AI analysis.
 */
export interface DiscordChunkAnalysisItem {
  resultId: string;
  title: string;
  severity: Severity;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
}

/**
 * The structured JSON output expected from chunked Discord analysis.
 */
export interface DiscordChunkAnalysisOutput {
  items: DiscordChunkAnalysisItem[];
}

/**
 * Compact stored debug payload for Discord findings.
 */
export interface DiscordStoredFindingRawData extends Record<string, unknown> {
  kind: 'discord-normalized';
  version: 1;
  server: {
    id: string;
    inviteUrl: string;
    vanityUrlCode: string;
    name: string;
    description?: string;
    keywords?: string[];
    categories?: string[];
    primaryCategory?: string;
    features?: string[];
    approximateMemberCount?: number;
    approximatePresenceCount?: number;
    premiumSubscriptionCount?: number;
    preferredLocale?: string;
    isPublished?: boolean;
  };
  context: DiscordRunContext;
  analysis: {
    source: 'llm' | 'fallback';
    runId: string;
    findingSource: FindingSource;
    scannerId: ScannerId;
    searchDepth: number;
    searchQuery?: string;
    displayQuery?: string;
  };
}

/**
 * One GitHub repository candidate returned by the GitHub repo search actor.
 */
export interface GitHubRepoCandidate {
  resultId: string;
  fullName: string;
  url: string;
  name: string;
  owner: string;
  description?: string;
  stars?: number;
  forks?: number;
  language?: string;
  updatedAt?: string;
}

/**
 * Run-level GitHub context shared across chunked analysis calls.
 */
export interface GitHubRunContext {
  sourceQueries: string[];
  observedLanguages: string[];
  sampleRepoNames: string[];
  sampleOwners: string[];
}

/**
 * One assessed GitHub repository returned by chunked AI analysis.
 */
export interface GitHubChunkAnalysisItem {
  resultId: string;
  title: string;
  severity: Severity;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
}

/**
 * The structured JSON output expected from chunked GitHub analysis.
 */
export interface GitHubChunkAnalysisOutput {
  items: GitHubChunkAnalysisItem[];
}

/**
 * Compact stored debug payload for GitHub findings.
 */
export interface GitHubStoredFindingRawData extends Record<string, unknown> {
  kind: 'github-normalized';
  version: 1;
  repo: {
    fullName: string;
    url: string;
    name: string;
    owner: string;
    description?: string;
    stars?: number;
    forks?: number;
    language?: string;
    updatedAt?: string;
  };
  context: GitHubRunContext;
  analysis: {
    source: 'llm' | 'fallback';
    runId: string;
    findingSource: FindingSource;
    scannerId: ScannerId;
    searchDepth: number;
    searchQuery?: string;
    displayQuery?: string;
  };
}

/**
 * One tweet/post candidate returned by the X tweet scraper.
 */
export interface XTweetCandidate {
  resultId: string;
  tweetId: string;
  url: string;
  twitterUrl?: string;
  text: string;
  createdAt?: string;
  lang?: string;
  retweetCount?: number;
  replyCount?: number;
  likeCount?: number;
  quoteCount?: number;
  bookmarkCount?: number;
  isReply?: boolean;
  isRetweet?: boolean;
  isQuote?: boolean;
  quoteId?: string;
  author: {
    id?: string;
    userName?: string;
    name?: string;
    url?: string;
    twitterUrl?: string;
    isVerified?: boolean;
    isBlueVerified?: boolean;
    verifiedType?: string;
    followers?: number;
    following?: number;
  };
}

/**
 * Run-level X context shared across chunked analysis calls.
 */
export interface XRunContext {
  sourceQueries: string[];
  observedLanguages: string[];
  observedAuthors: string[];
  sampleTweetTexts: string[];
}

/**
 * One assessed X tweet returned by chunked AI analysis.
 */
export interface XChunkAnalysisItem {
  resultId: string;
  title: string;
  severity: Severity;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
}

/**
 * The structured JSON output expected from chunked X analysis.
 */
export interface XChunkAnalysisOutput {
  items: XChunkAnalysisItem[];
}

/**
 * Compact stored debug payload for X findings.
 */
export interface XStoredFindingRawData extends Record<string, unknown> {
  kind: 'x-normalized';
  version: 1;
  tweet: {
    id: string;
    url: string;
    twitterUrl?: string;
    text: string;
    createdAt?: string;
    lang?: string;
    retweetCount?: number;
    replyCount?: number;
    likeCount?: number;
    quoteCount?: number;
    bookmarkCount?: number;
    isReply?: boolean;
    isRetweet?: boolean;
    isQuote?: boolean;
    quoteId?: string;
    author: {
      id?: string;
      userName?: string;
      name?: string;
      url?: string;
      twitterUrl?: string;
      isVerified?: boolean;
      isBlueVerified?: boolean;
      verifiedType?: string;
      followers?: number;
      following?: number;
    };
  };
  context: XRunContext;
  analysis: {
    source: 'llm' | 'fallback';
    runId: string;
    findingSource: FindingSource;
    scannerId: ScannerId;
    searchDepth: number;
    searchQuery?: string;
    displayQuery?: string;
  };
}

/** Maximum follow-up deep-search queries AI analysis may request per Google batch run */
export const MAX_SUGGESTED_SEARCHES = 5;

/**
 * Parse and validate the raw JSON string returned by chunked Google analysis.
 * Expects an object with an "items" array of per-result assessments whose
 * resultIds exactly match the provided candidate IDs.
 * Returns null if parsing fails or the output is malformed.
 */
export function parseGoogleChunkAnalysisOutput(
  raw: string,
  validResultIds: Set<string>,
): GoogleChunkAnalysisOutput | null {
  const items = parseChunkAnalysisItems(raw, validResultIds);
  return items ? { items } : null;
}

/**
 * Parse and validate the raw JSON string returned by chunked Discord analysis.
 */
export function parseDiscordChunkAnalysisOutput(
  raw: string,
  validResultIds: Set<string>,
): DiscordChunkAnalysisOutput | null {
  const items = parseChunkAnalysisItems(raw, validResultIds);
  return items ? { items } : null;
}

/**
 * Parse and validate the raw JSON string returned by chunked GitHub analysis.
 */
export function parseGitHubChunkAnalysisOutput(
  raw: string,
  validResultIds: Set<string>,
): GitHubChunkAnalysisOutput | null {
  const items = parseChunkAnalysisItems(raw, validResultIds);
  return items ? { items } : null;
}

/**
 * Parse and validate the raw JSON string returned by chunked X analysis.
 */
export function parseXChunkAnalysisOutput(
  raw: string,
  validResultIds: Set<string>,
): XChunkAnalysisOutput | null {
  const items = parseChunkAnalysisItems(raw, validResultIds);
  return items ? { items } : null;
}

/**
 * Parse and validate the raw JSON string returned by the Google deep-search
 * selection pass. Invalid or empty results collapse to an empty suggestion set.
 */
export function parseGoogleSuggestionOutput(raw: string, maxSuggestedSearches = MAX_SUGGESTED_SEARCHES): GoogleSuggestionOutput | null {
  return parseSuggestedSearchOutput(raw, maxSuggestedSearches);
}

export function parseSuggestedSearchOutput(raw: string, maxSuggestedSearches = MAX_SUGGESTED_SEARCHES): GoogleSuggestionOutput | null {
  try {
    const stripped = stripJsonFences(raw);
    const parsed = JSON.parse(stripped);

    return {
      suggestedSearches: normalizeSuggestedSearches(parsed.suggestedSearches, maxSuggestedSearches),
    };
  } catch {
    return null;
  }
}

/**
 * Parse and validate the raw JSON string returned by the scan-summary pass.
 */
export function parseScanSummaryOutput(raw: string): ScanSummaryOutput | null {
  try {
    const stripped = stripJsonFences(raw);
    const parsed = JSON.parse(stripped);
    if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
      return null;
    }

    return {
      summary: parsed.summary.trim(),
    };
  } catch {
    return null;
  }
}

function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function parseChunkAnalysisItems(
  raw: string,
  validResultIds: Set<string>,
): GoogleChunkAnalysisItem[] | null {
  try {
    const stripped = stripJsonFences(raw);
    const parsed = JSON.parse(stripped);

    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      return null;
    }

    const validSeverities = ['high', 'medium', 'low'];
    const seenResultIds = new Set<string>();
    const items: GoogleChunkAnalysisItem[] = parsed.items
      .filter(
        (item: unknown): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null,
      )
      .filter(
        (item: Record<string, unknown>) =>
          typeof item.resultId === 'string' &&
          validResultIds.has((item.resultId as string).trim()) &&
          !seenResultIds.has((item.resultId as string).trim()) &&
          typeof item.title === 'string' &&
          typeof item.severity === 'string' &&
          validSeverities.includes(item.severity as string) &&
          typeof item.analysis === 'string' &&
          typeof item.isFalsePositive === 'boolean',
      )
      .map((item: Record<string, unknown>) => {
        const resultId = (item.resultId as string).trim();
        seenResultIds.add(resultId);
        return {
          resultId,
          title: (item.title as string).trim(),
          severity: item.severity as Severity,
          theme: normalizeFindingTaxonomyLabel(item.theme),
          analysis: (item.analysis as string).trim(),
          isFalsePositive: item.isFalsePositive as boolean,
        };
      });

    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

function normalizeSuggestedSearches(value: unknown, maxSuggestedSearches: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const suggestedSearches = value
    .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim())
    .filter((s) => {
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxSuggestedSearches);

  return suggestedSearches.length > 0 ? suggestedSearches : undefined;
}
