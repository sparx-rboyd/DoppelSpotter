import type { Severity } from '@/lib/types';
import { normalizeFindingTaxonomyLabel } from '@/lib/findings-taxonomy';

/**
 * A single Google result appearance captured from a SERP page.
 */
export interface GoogleSearchSighting {
  runId: string;
  searchDepth: number;
  searchQuery?: string;
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
  platform?: string;
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
  version: 1;
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
    searchDepth: number;
    searchQuery?: string;
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
          platform: normalizeFindingTaxonomyLabel(item.platform),
          theme: normalizeFindingTaxonomyLabel(item.theme),
          analysis: (item.analysis as string).trim(),
          isFalsePositive: item.isFalsePositive as boolean,
        };
      });

    if (items.length === 0) return null;

    return {
      items,
    };
  } catch {
    return null;
  }
}

/**
 * Parse and validate the raw JSON string returned by the Google deep-search
 * selection pass. Invalid or empty results collapse to an empty suggestion set.
 */
export function parseGoogleSuggestionOutput(raw: string, maxSuggestedSearches = MAX_SUGGESTED_SEARCHES): GoogleSuggestionOutput | null {
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
