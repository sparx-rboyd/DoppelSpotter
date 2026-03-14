import type { FindingSource, GoogleScannerId, ScannerId, Severity, XFindingMatchBasis } from '@/lib/types';
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
export interface VerifiedRedditCommentSnapshot {
  id: string;
  author?: string;
  body: string;
  score?: number;
  depth?: number;
}

/**
 * Stable Reddit post metadata fetched from the post's public `.json` endpoint.
 * This is used to verify Reddit candidates discovered via Google SERPs.
 */
export interface VerifiedRedditPostSnapshot {
  source: 'reddit-json';
  canonicalUrl: string;
  jsonUrl: string;
  postId: string;
  subreddit: string;
  title: string;
  selftext?: string;
  author?: string;
  permalink?: string;
  createdUtc?: number;
  score?: number;
  numComments?: number;
  linkFlairText?: string;
  isSelfPost?: boolean;
  domain?: string;
  over18?: boolean;
  matchedComment?: VerifiedRedditCommentSnapshot;
}

export interface GoogleSearchCandidate {
  resultId: string;
  url: string;
  normalizedUrl: string;
  title: string;
  displayedUrl?: string;
  description?: string;
  emphasizedKeywords?: string[];
  verifiedRedditPost?: VerifiedRedditPostSnapshot;
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

export interface ThemeNormalizationMapping {
  provisionalTheme: string;
  canonicalTheme: string;
}

export interface ThemeNormalizationOutput {
  mappings: ThemeNormalizationMapping[];
}

export interface ThemeNormalizationParseIssue {
  provisionalTheme?: string;
  canonicalTheme?: string;
  reasons: string[];
}

export interface ThemeNormalizationParseDiagnostics {
  rawMappingCount: number;
  acceptedMappingCount: number;
  missingProvisionalThemes: string[];
  issues: ThemeNormalizationParseIssue[];
}

/**
 * Compact stored debug payload for Google findings.
 */
export interface GoogleStoredFindingRawData extends Record<string, unknown> {
  kind: 'google-normalized';
  version: 3;
  normalizedUrl: string;
  result: {
    rawUrl: string;
    normalizedUrl: string;
    title: string;
    displayedUrl?: string;
    description?: string;
    emphasizedKeywords?: string[];
  };
  verifiedRedditPost?: VerifiedRedditPostSnapshot;
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
 * One Reddit post candidate returned by the dedicated Reddit actor.
 */
export interface RedditPostCandidate {
  resultId: string;
  postId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  body?: string;
  author?: string;
  subreddit: string;
  createdAt?: string;
  score?: number;
  upvoteRatio?: number;
  numComments?: number;
  flair?: string;
  over18?: boolean;
  isSelfPost?: boolean;
  spoiler?: boolean;
  locked?: boolean;
  isVideo?: boolean;
  domain?: string;
  matchedQueries: string[];
}

/**
 * Run-level Reddit context shared across chunked analysis calls.
 */
export interface RedditRunContext {
  sourceQueries: string[];
  observedSubreddits: string[];
  observedAuthors: string[];
  sampleTitles: string[];
  lookbackDate?: string;
}

/**
 * One assessed Reddit post returned by chunked AI analysis.
 */
export interface RedditChunkAnalysisItem {
  resultId: string;
  title: string;
  severity: Severity;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
}

/**
 * The structured JSON output expected from chunked Reddit analysis.
 */
export interface RedditChunkAnalysisOutput {
  items: RedditChunkAnalysisItem[];
}

/**
 * Compact stored debug payload for Reddit findings.
 */
export interface RedditStoredFindingRawData extends Record<string, unknown> {
  kind: 'reddit-normalized';
  version: 1;
  post: {
    id: string;
    url: string;
    canonicalUrl: string;
    title: string;
    body?: string;
    author?: string;
    subreddit: string;
    createdAt?: string;
    score?: number;
    upvoteRatio?: number;
    numComments?: number;
    flair?: string;
    over18?: boolean;
    isSelfPost?: boolean;
    spoiler?: boolean;
    locked?: boolean;
    isVideo?: boolean;
    domain?: string;
    matchedQueries: string[];
  };
  context: RedditRunContext;
  analysis: {
    source: 'llm' | 'fallback';
    runId: string;
    findingSource: FindingSource;
    scannerId: ScannerId;
    searchDepth: number;
    searchQuery?: string;
    searchQueries?: string[];
    displayQuery?: string;
    displayQueries?: string[];
  };
}

/**
 * One TikTok video candidate returned by the dedicated TikTok actor.
 */
export interface TikTokVideoCandidate {
  resultId: string;
  videoId: string;
  url: string;
  caption?: string;
  createdAt?: string;
  region?: string;
  author: {
    id?: string;
    uniqueId?: string;
    nickname?: string;
    signature?: string;
    verified?: boolean;
    url?: string;
  };
  hashtags: string[];
  mentions: string[];
  music?: {
    id?: string;
    title?: string | null;
    author?: string;
    ownerHandle?: string;
    isOriginalSound?: boolean;
  };
  stats: {
    playCount?: number;
    diggCount?: number;
    commentCount?: number;
    shareCount?: number;
    collectCount?: number;
  };
  matchedQueries: string[];
}

/**
 * Run-level TikTok context shared across chunked analysis calls.
 */
export interface TikTokRunContext {
  sourceQueries: string[];
  observedAuthorHandles: string[];
  observedHashtags: string[];
  sampleCaptions: string[];
  lookbackDate?: string;
}

/**
 * One assessed TikTok post returned by chunked AI analysis.
 */
export interface TikTokChunkAnalysisItem {
  resultId: string;
  title: string;
  severity: Severity;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
}

/**
 * The structured JSON output expected from chunked TikTok analysis.
 */
export interface TikTokChunkAnalysisOutput {
  items: TikTokChunkAnalysisItem[];
}

/**
 * Compact stored debug payload for TikTok findings.
 */
export interface TikTokStoredFindingRawData extends Record<string, unknown> {
  kind: 'tiktok-normalized';
  version: 1;
  video: {
    id: string;
    url: string;
    caption?: string;
    createdAt?: string;
    region?: string;
    author: TikTokVideoCandidate['author'];
    hashtags: string[];
    mentions: string[];
    music?: TikTokVideoCandidate['music'];
    stats: TikTokVideoCandidate['stats'];
    matchedQueries: string[];
  };
  context: TikTokRunContext;
  analysis: {
    source: 'llm' | 'fallback';
    runId: string;
    findingSource: FindingSource;
    scannerId: ScannerId;
    searchDepth: number;
    searchQuery?: string;
    searchQueries?: string[];
    displayQuery?: string;
    displayQueries?: string[];
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
 * One recent-domain-registration candidate returned by the CodePunch-backed actor.
 */
export interface DomainRegistrationCandidate {
  resultId: string;
  domain: string;
  url: string;
  name: string;
  tld: string;
  registrationDate?: string;
  length?: number;
  idn?: number;
  ipv4?: string;
  ipv6?: string;
  ipAsNumber?: number;
  ipAsName?: string;
  ipChecked?: string;
  enhancedAnalysis?: {
    status: string;
    model?: string;
    sourceUrl?: string;
    finalUrl?: string;
    summary?: string;
    extractedTextLength?: number;
    failureReason?: string;
    errorMessage?: string;
    contentType?: string;
  };
}

/**
 * Run-level recent-domain-registration context shared across chunked analysis calls.
 */
export interface DomainRegistrationRunContext {
  sourceQueries: string[];
  selectedDate?: string;
  dateComparison?: string;
  totalLimit?: number;
  sortField?: string;
  sortOrder?: string;
  observedTlds: string[];
  sampleDomains: string[];
  enhancedAnalysisEnabled: boolean;
  enhancedAnalysisModel?: string;
}

/**
 * One assessed domain registration returned by chunked AI analysis.
 */
export interface DomainRegistrationChunkAnalysisItem {
  resultId: string;
  title: string;
  severity: Severity;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
}

/**
 * The structured JSON output expected from chunked domain-registration analysis.
 */
export interface DomainRegistrationChunkAnalysisOutput {
  items: DomainRegistrationChunkAnalysisItem[];
}

/**
 * Compact stored debug payload for domain-registration findings.
 */
export interface DomainRegistrationStoredFindingRawData extends Record<string, unknown> {
  kind: 'domain-registration-normalized';
  version: 1;
  domainRecord: {
    domain: string;
    url: string;
    name: string;
    tld: string;
    registrationDate?: string;
    length?: number;
    idn?: number;
    ipv4?: string;
    ipv6?: string;
    ipAsNumber?: number;
    ipAsName?: string;
    ipChecked?: string;
    enhancedAnalysis?: DomainRegistrationCandidate['enhancedAnalysis'];
  };
  context: DomainRegistrationRunContext;
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
  matchBasis: XFindingMatchBasis;
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
    matchBasis?: XFindingMatchBasis;
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
 * Parse and validate the raw JSON string returned by chunked Reddit analysis.
 */
export function parseRedditChunkAnalysisOutput(
  raw: string,
  validResultIds: Set<string>,
): RedditChunkAnalysisOutput | null {
  const items = parseChunkAnalysisItems(raw, validResultIds);
  return items ? { items } : null;
}

/**
 * Parse and validate the raw JSON string returned by chunked TikTok analysis.
 */
export function parseTikTokChunkAnalysisOutput(
  raw: string,
  validResultIds: Set<string>,
): TikTokChunkAnalysisOutput | null {
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
 * Parse and validate the raw JSON string returned by chunked domain-registration analysis.
 */
export function parseDomainRegistrationChunkAnalysisOutput(
  raw: string,
  validResultIds: Set<string>,
): DomainRegistrationChunkAnalysisOutput | null {
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
  try {
    const stripped = stripJsonFences(raw);
    const parsed = JSON.parse(stripped);

    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      return null;
    }

    const validSeverities = ['high', 'medium', 'low'];
    const validMatchBases = ['none', 'handle_only', 'content_only', 'handle_and_content'];
    const seenResultIds = new Set<string>();
    const items: XChunkAnalysisItem[] = parsed.items
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
          typeof item.isFalsePositive === 'boolean' &&
          typeof item.matchBasis === 'string' &&
          validMatchBases.includes(item.matchBasis as string),
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
          matchBasis: item.matchBasis as XFindingMatchBasis,
        };
      });

    return items.length > 0 ? { items } : null;
  } catch {
    return null;
  }
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

export function parseThemeNormalizationOutput(
  raw: string,
  validProvisionalThemes: Set<string>,
): ThemeNormalizationOutput | null {
  return parseThemeNormalizationOutputWithDiagnostics(raw, validProvisionalThemes).output;
}

export function parseThemeNormalizationOutputWithDiagnostics(
  raw: string,
  validProvisionalThemes: Set<string>,
): {
  output: ThemeNormalizationOutput | null;
  diagnostics: ThemeNormalizationParseDiagnostics;
} {
  const diagnostics: ThemeNormalizationParseDiagnostics = {
    rawMappingCount: 0,
    acceptedMappingCount: 0,
    missingProvisionalThemes: [],
    issues: [],
  };

  try {
    const stripped = stripJsonFences(raw);
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed.mappings) || parsed.mappings.length === 0) {
      diagnostics.issues.push({
        reasons: ['missing_or_empty_mappings_array'],
      });
      diagnostics.missingProvisionalThemes = [...validProvisionalThemes];
      return { output: null, diagnostics };
    }

    const seenThemes = new Set<string>();
    diagnostics.rawMappingCount = parsed.mappings.length;
    const mappings: ThemeNormalizationMapping[] = [];

    for (const item of parsed.mappings) {
      if (typeof item !== 'object' || item === null) {
        diagnostics.issues.push({ reasons: ['mapping_not_object'] });
        continue;
      }

      const provisionalTheme = typeof item.provisionalTheme === 'string'
        ? item.provisionalTheme.trim()
        : '';
      const canonicalTheme = normalizeFindingTaxonomyLabel(item.canonicalTheme);
      const reasons: string[] = [];

      if (!provisionalTheme) {
        reasons.push('missing_provisional_theme');
      } else if (!validProvisionalThemes.has(provisionalTheme)) {
        reasons.push('unknown_provisional_theme');
      }

      if (provisionalTheme && seenThemes.has(provisionalTheme)) {
        reasons.push('duplicate_provisional_theme');
      }

      if (typeof canonicalTheme !== 'string') {
        reasons.push('invalid_canonical_theme');
      }

      if (reasons.length > 0) {
        diagnostics.issues.push({
          provisionalTheme: provisionalTheme || undefined,
          canonicalTheme: typeof item.canonicalTheme === 'string' ? item.canonicalTheme.trim() : undefined,
          reasons,
        });
        continue;
      }

      seenThemes.add(provisionalTheme);
      mappings.push({ provisionalTheme, canonicalTheme });
    }

    diagnostics.acceptedMappingCount = mappings.length;
    diagnostics.missingProvisionalThemes = [...validProvisionalThemes].filter((theme) => !seenThemes.has(theme));

    return {
      output: mappings.length > 0 ? { mappings } : null,
      diagnostics,
    };
  } catch (error) {
    diagnostics.issues.push({
      reasons: ['json_parse_failed'],
      canonicalTheme: error instanceof Error ? error.message : undefined,
    });
    diagnostics.missingProvisionalThemes = [...validProvisionalThemes];
    return { output: null, diagnostics };
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
