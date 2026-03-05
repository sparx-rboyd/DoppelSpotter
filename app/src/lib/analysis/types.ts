import type { Severity } from '@/lib/types';

/**
 * The structured JSON output expected from the LLM for each finding.
 */
export interface AnalysisOutput {
  severity: Severity;
  title: string;
  llmAnalysis: string;
  isFalsePositive: boolean;
  /**
   * Optional list of search queries the LLM wants to investigate further.
   * Only returned by batch-mode analysis (e.g. Google Search) at depth 0.
   * Capped at MAX_SUGGESTED_SEARCHES before acting on them.
   */
  suggestedSearches?: string[];
}

/**
 * One assessed search result item returned by the LLM in batch mode.
 * Each item corresponds to a single organic (or paid) result from the SERP.
 */
export interface PerPageFinding {
  url: string;
  title: string;
  severity: Severity;
  analysis: string;
  isFalsePositive: boolean;
}

/**
 * The structured JSON output expected from the LLM for batch-mode analysis
 * (e.g. Google Search). Instead of one consolidated finding, the LLM returns
 * an assessment for each individual search result.
 */
export interface BatchAnalysisOutput {
  items: PerPageFinding[];
  suggestedSearches?: string[];
}

/** Maximum follow-up queries the LLM may request per batch run */
export const MAX_SUGGESTED_SEARCHES = 3;

/**
 * Parse and validate the raw JSON string returned by the LLM.
 * Returns null if parsing fails or the output is malformed.
 */
export function parseAnalysisOutput(raw: string): AnalysisOutput | null {
  try {
    // Strip markdown code fences if the LLM wraps the JSON in ```json ... ``` or ``` ... ```
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(stripped);

    if (
      typeof parsed.severity !== 'string' ||
      !['high', 'medium', 'low'].includes(parsed.severity) ||
      typeof parsed.title !== 'string' ||
      typeof parsed.llmAnalysis !== 'string' ||
      typeof parsed.isFalsePositive !== 'boolean'
    ) {
      return null;
    }

    // Validate optional suggestedSearches — must be an array of non-empty strings if present
    let suggestedSearches: string[] | undefined;
    if (Array.isArray(parsed.suggestedSearches)) {
      const filtered = parsed.suggestedSearches
        .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s: string) => s.trim())
        .slice(0, MAX_SUGGESTED_SEARCHES);
      suggestedSearches = filtered.length > 0 ? filtered : undefined;
    }

    return {
      severity: parsed.severity as Severity,
      title: parsed.title,
      llmAnalysis: parsed.llmAnalysis,
      isFalsePositive: parsed.isFalsePositive,
      suggestedSearches,
    };
  } catch {
    return null;
  }
}

/**
 * Parse and validate the raw JSON string returned by the LLM in batch mode.
 * Expects an object with an "items" array of per-result assessments.
 * Returns null if parsing fails or the output is malformed.
 */
export function parseBatchAnalysisOutput(raw: string): BatchAnalysisOutput | null {
  try {
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(stripped);

    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      return null;
    }

    const validSeverities = ['high', 'medium', 'low'];
    const items: PerPageFinding[] = parsed.items
      .filter(
        (item: unknown): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null,
      )
      .filter(
        (item: Record<string, unknown>) =>
          typeof item.url === 'string' &&
          typeof item.title === 'string' &&
          typeof item.severity === 'string' &&
          validSeverities.includes(item.severity as string) &&
          typeof item.analysis === 'string' &&
          typeof item.isFalsePositive === 'boolean',
      )
      .map((item: Record<string, unknown>) => ({
        url: (item.url as string).trim(),
        title: (item.title as string).trim(),
        severity: item.severity as Severity,
        analysis: (item.analysis as string).trim(),
        isFalsePositive: item.isFalsePositive as boolean,
      }));

    if (items.length === 0) return null;

    let suggestedSearches: string[] | undefined;
    if (Array.isArray(parsed.suggestedSearches)) {
      suggestedSearches = (parsed.suggestedSearches as unknown[])
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, MAX_SUGGESTED_SEARCHES);
      if (suggestedSearches.length === 0) suggestedSearches = undefined;
    }

    return { items, suggestedSearches };
  } catch {
    return null;
  }
}
