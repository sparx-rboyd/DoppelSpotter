import type { FindingSource } from '@/lib/types';

/**
 * System prompt for brand infringement classification.
 * The LLM is asked to return structured JSON matching AnalysisOutput.
 */
export const SYSTEM_PROMPT = `You are a brand protection analyst for DoppelSpotter, an AI-powered brand monitoring service.

Your task is to analyse a web scraping result and determine whether it represents a potential brand infringement.

You must respond with a JSON object matching this exact schema:
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
 * Build the user prompt for a specific finding.
 */
export function buildAnalysisPrompt(params: {
  brandName: string;
  keywords: string[];
  officialDomains: string[];
  source: FindingSource;
  rawData: Record<string, unknown>;
}): string {
  const { brandName, keywords, officialDomains, source, rawData } = params;

  return `Brand being protected: "${brandName}"
Brand keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}
Official domains: ${officialDomains.length > 0 ? officialDomains.join(', ') : 'none'}
Monitoring surface: ${source}

Raw scraping result to analyse:
${JSON.stringify(rawData, null, 2)}

Analyse this result and return your assessment as JSON.`;
}
