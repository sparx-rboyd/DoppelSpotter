import { FieldValue } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';
import { chatCompletion } from '@/lib/analysis/openrouter';
import { SCAN_SUMMARY_SYSTEM_PROMPT, buildScanSummaryPrompt } from '@/lib/analysis/prompts';
import { parseScanSummaryOutput } from '@/lib/analysis/types';
import { buildCountOnlyScanAiSummary } from '@/lib/scans';
import type { BrandProfile, Finding, Scan, ScanSummaryPhase } from '@/lib/types';

type ScanSummaryFindingInput = Pick<Finding, 'severity' | 'title' | 'source'>;

const SCAN_SUMMARY_MAX_FINDINGS = 500;

export type BuiltScanAiSummaryResult = {
  summary: string;
  rawLlmResponse?: string;
};

const SCAN_SUMMARY_LLM_MAX_ATTEMPTS = 2;

function formatScanSeverityBreakdown(counts: { high: number; medium: number; low: number }): string {
  const parts: string[] = [];
  if (counts.high > 0) parts.push(`${counts.high} high`);
  if (counts.medium > 0) parts.push(`${counts.medium} medium`);
  if (counts.low > 0) parts.push(`${counts.low} low`);

  if (parts.length === 0) return 'no actionable findings';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts[0]}, ${parts[1]} and ${parts[2]}`;
}

function buildFallbackScanAiSummary(findings: ScanSummaryFindingInput[]): string {
  const counts = findings.reduce(
    (acc, finding) => {
      if (finding.severity === 'high') acc.high++;
      else if (finding.severity === 'medium') acc.medium++;
      else acc.low++;
      return acc;
    },
    { high: 0, medium: 0, low: 0 },
  );

  const total = findings.length;
  const sentences = [
    `This scan surfaced ${total} actionable finding${total === 1 ? '' : 's'}: ${formatScanSeverityBreakdown(counts)}.`,
  ];

  if (counts.high > 0) {
    sentences.push('The highest-risk items suggest potentially damaging brand misuse and should be prioritised for review.');
  } else if (counts.medium > 0) {
    sentences.push('The main concerns are suspicious associations that warrant manual review even though the evidence is less definitive.');
  } else {
    sentences.push('The findings appear lower-risk overall, but they still indicate ongoing third-party use of the brand that is worth monitoring.');
  }

  if (counts.high + counts.medium >= 2) {
    sentences.push('The pattern does not appear isolated, which may point to broader or repeated misuse themes rather than a single one-off mention.');
  }

  return sentences.join(' ');
}

function truncateSummaryInput(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sortFindingsForSummary(findings: ScanSummaryFindingInput[]): ScanSummaryFindingInput[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...findings].sort((left, right) => {
    const severityDiff = rank[left.severity] - rank[right.severity];
    if (severityDiff !== 0) return severityDiff;
    return left.title.localeCompare(right.title);
  });
}

export async function buildScanAiSummary(scan: Scan): Promise<BuiltScanAiSummaryResult> {
  const prefix = `[scan-summary] Scan ${scan.id}:`;
  console.log(`${prefix} starting — loading findings`);

  const findingsSnap = await db
    .collection('findings')
    .where('scanId', '==', scan.id)
    .where('brandId', '==', scan.brandId)
    .where('userId', '==', scan.userId)
    .select('severity', 'title', 'source', 'isFalsePositive')
    .get();

  const findings = sortFindingsForSummary(
    findingsSnap.docs
      .map((doc) => doc.data() as ScanSummaryFindingInput & { isFalsePositive?: boolean })
      .filter((finding) => finding.isFalsePositive !== true)
      .map((finding) => ({
        severity: finding.severity,
        title: finding.title,
        source: finding.source,
      })),
  );
  console.log(`${prefix} ${findingsSnap.size} total docs, ${findings.length} actionable findings`);

  if (findings.length === 0) {
    console.log(`${prefix} no actionable findings — using count-only summary`);
    return { summary: buildCountOnlyScanAiSummary(scan) };
  }

  const brandDoc = await db.collection('brands').doc(scan.brandId).get();
  const brandName = brandDoc.exists ? (brandDoc.data() as BrandProfile).name : 'Unknown brand';
  const counts = findings.reduce(
    (acc, finding) => {
      if (finding.severity === 'high') acc.high++;
      else if (finding.severity === 'medium') acc.medium++;
      else acc.low++;
      return acc;
    },
    { high: 0, medium: 0, low: 0 },
  );

  const cappedFindings = findings.slice(0, SCAN_SUMMARY_MAX_FINDINGS);
  const lowTruncated = counts.low - cappedFindings.filter((f) => f.severity === 'low').length;

  const prompt = buildScanSummaryPrompt({
    brandName,
    counts,
    findings: cappedFindings.map((finding) => ({
      severity: finding.severity,
      source: finding.source,
      title: truncateSummaryInput(finding.title, 120),
    })),
    ...(lowTruncated > 0 ? { lowTruncated } : {}),
  });
  console.log(`${prefix} prompt built — ${cappedFindings.length}/${findings.length} findings sent, prompt ${prompt.length} chars, ${counts.high}h/${counts.medium}m/${counts.low}l, lowTruncated=${lowTruncated}`);

  let rawLlmResponse: string | undefined;
  let finalError: unknown;
  for (let attempt = 1; attempt <= SCAN_SUMMARY_LLM_MAX_ATTEMPTS; attempt++) {
    let attemptRawLlmResponse: string | undefined;
    try {
      console.log(`${prefix} calling LLM (attempt ${attempt}/${SCAN_SUMMARY_LLM_MAX_ATTEMPTS})`);
      attemptRawLlmResponse = await chatCompletion([
        { role: 'system', content: SCAN_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ], { temperature: 1.2 });
      rawLlmResponse = attemptRawLlmResponse;
      console.log(`${prefix} LLM returned ${attemptRawLlmResponse.length} chars (attempt ${attempt})`);

      const parsed = parseScanSummaryOutput(attemptRawLlmResponse);
      if (!parsed) {
        throw new Error(`Failed to parse scan summary output: ${attemptRawLlmResponse.slice(0, 200)}`);
      }

      console.log(`${prefix} scan summary generated successfully`);
      return {
        summary: parsed.summary,
        rawLlmResponse,
      };
    } catch (err) {
      if (typeof attemptRawLlmResponse === 'string') {
        rawLlmResponse = attemptRawLlmResponse;
      }
      finalError = err;
      if (attempt < SCAN_SUMMARY_LLM_MAX_ATTEMPTS) {
        console.warn(
          `[scan-summary] Scan summary generation failed for scan ${scan.id} (attempt ${attempt}/${SCAN_SUMMARY_LLM_MAX_ATTEMPTS}); retrying once:`,
          err,
        );
        continue;
      }
    }
  }

  console.error(`[scan-summary] Scan summary generation failed for scan ${scan.id}:`, finalError);
  console.log(`${prefix} using fallback count-based summary`);
  return {
    summary: buildFallbackScanAiSummary(findings),
    ...(typeof rawLlmResponse === 'string' ? { rawLlmResponse } : {}),
  };
}

export async function saveScanAiSummary(scanId: string, summaryResult: BuiltScanAiSummaryResult) {
  await db.collection('scans').doc(scanId).update({
    aiSummary: summaryResult.summary,
    ...(typeof summaryResult.rawLlmResponse === 'string'
      ? { scanSummaryRawLlmResponse: summaryResult.rawLlmResponse }
      : { scanSummaryRawLlmResponse: FieldValue.delete() }),
  });
}

export async function saveScanAiSummaryProgress(params: {
  scanId: string;
  summaryResult: BuiltScanAiSummaryResult;
  summaryPhase?: ScanSummaryPhase;
}) {
  const { scanId, summaryResult, summaryPhase } = params;

  await db.collection('scans').doc(scanId).update({
    aiSummary: summaryResult.summary,
    ...(summaryPhase ? { summaryPhase } : {}),
    ...(typeof summaryResult.rawLlmResponse === 'string'
      ? { scanSummaryRawLlmResponse: summaryResult.rawLlmResponse }
      : { scanSummaryRawLlmResponse: FieldValue.delete() }),
  });
}
