import type { Severity } from '@/lib/types';

/**
 * The structured JSON output expected from the LLM for each finding.
 */
export interface AnalysisOutput {
  severity: Severity;
  title: string;
  llmAnalysis: string;
  isFalsePositive: boolean;
}

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

    return {
      severity: parsed.severity as Severity,
      title: parsed.title,
      llmAnalysis: parsed.llmAnalysis,
      isFalsePositive: parsed.isFalsePositive,
    };
  } catch {
    return null;
  }
}
