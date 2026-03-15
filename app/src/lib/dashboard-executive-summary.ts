import { FieldValue } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';
import { chatCompletion } from '@/lib/analysis/openrouter';
import {
  buildDashboardExecutiveSummaryPrompt,
  DASHBOARD_EXECUTIVE_SUMMARY_SYSTEM_PROMPT,
} from '@/lib/analysis/prompts';
import { parseDashboardExecutiveSummaryOutput } from '@/lib/analysis/types';
import {
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
  isScanDeletionActive,
} from '@/lib/async-deletions';
import type {
  BrandProfile,
  DashboardExecutiveSummaryData,
  DashboardExecutiveSummaryPattern,
  Finding,
  Scan,
  Severity,
} from '@/lib/types';

export const DASHBOARD_EXECUTIVE_SUMMARY_VERSION = 1;
const MAX_EXECUTIVE_SUMMARY_FINDINGS = 200;
const MAX_FINDING_TITLE_LENGTH = 120;
const MAX_FINDING_DESCRIPTION_LENGTH = 320;
const DASHBOARD_EXECUTIVE_SUMMARY_LLM_MAX_ATTEMPTS = 2;

type DashboardExecutiveSummarySeverityBreakdown = NonNullable<DashboardExecutiveSummaryData['severityBreakdown']>;
type DashboardExecutiveSummaryFindingInput = {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  createdAt?: Finding['createdAt'];
};

type CompletedScanSummarySource = Pick<Scan, 'id' | 'status' | 'startedAt' | 'completedAt' | 'highCount' | 'mediumCount' | 'lowCount' | 'deletion'>;
type BuiltDashboardExecutiveSummaryResult = DashboardExecutiveSummaryData & {
  status: 'ready';
  inputFindingCount: number;
  severityBreakdown: DashboardExecutiveSummarySeverityBreakdown;
  summary: string;
  patterns: DashboardExecutiveSummaryPattern[];
  completedScanCount: number;
};

function truncateSummaryInput(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sortFindingsByCreatedAtDesc<T extends { createdAt?: Finding['createdAt']; id: string }>(findings: T[]): T[] {
  return [...findings].sort((left, right) => {
    const leftMillis = left.createdAt?.toMillis?.() ?? 0;
    const rightMillis = right.createdAt?.toMillis?.() ?? 0;
    return rightMillis - leftMillis || left.id.localeCompare(right.id);
  });
}

function clampExecutiveSummaryPatterns(
  patterns: DashboardExecutiveSummaryPattern[] | undefined,
  validFindingIds: Set<string>,
): DashboardExecutiveSummaryPattern[] {
  if (!patterns?.length) return [];

  return patterns.flatMap((pattern) => {
    const name = pattern.name.trim();
    const description = pattern.description.trim();
    const findingIds = [...new Set(
      pattern.findingIds
        .filter((findingId) => validFindingIds.has(findingId))
        .map((findingId) => findingId.trim()),
    )];

    if (!name || !description || findingIds.length < 2) {
      return [];
    }

    return [{
      name,
      description,
      mentionCount: Math.max(pattern.mentionCount, findingIds.length),
      findingIds,
    }];
  }).slice(0, 6);
}

function buildFallbackExecutiveSummary(params: {
  brandName: string;
  findingCount: number;
  severityBreakdown: DashboardExecutiveSummarySeverityBreakdown;
}): string {
  const { brandName, findingCount, severityBreakdown } = params;

  if (findingCount === 0) {
    return `No actionable high, medium or low findings were available to summarise for ${brandName}.`;
  }

  const parts: string[] = [];
  if (severityBreakdown.high > 0) parts.push(`${severityBreakdown.high} high`);
  if (severityBreakdown.medium > 0) parts.push(`${severityBreakdown.medium} medium`);
  if (severityBreakdown.low > 0) parts.push(`${severityBreakdown.low} low`);

  return `This debug executive summary is based on ${findingCount} actionable finding${findingCount === 1 ? '' : 's'} across completed scans for ${brandName}, prioritising ${parts.join(', ')} findings. Repeated misuse patterns may be present, but the automated pattern extraction was unavailable for this run.`;
}

function normalizeDashboardExecutiveSummaryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return 'Executive summary generation failed';
}

async function loadVisibleFindingsForScan(params: {
  scanId: string;
  brandId: string;
  userId: string;
}): Promise<DashboardExecutiveSummaryFindingInput[]> {
  const findingsSnap = await db
    .collection('findings')
    .where('scanId', '==', params.scanId)
    .where('brandId', '==', params.brandId)
    .where('userId', '==', params.userId)
    .select('severity', 'title', 'description', 'llmAnalysis', 'isFalsePositive', 'isIgnored', 'isAddressed', 'createdAt')
    .get();

  return sortFindingsByCreatedAtDesc(
    findingsSnap.docs
      .map((doc) => ({
        id: doc.id,
        ...(doc.data() as Pick<Finding, 'severity' | 'title' | 'description' | 'llmAnalysis' | 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'createdAt'>),
      }))
      .filter((finding) => !finding.isFalsePositive && !finding.isIgnored && !finding.isAddressed)
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        description: finding.description?.trim() || finding.llmAnalysis?.trim() || finding.title,
        createdAt: finding.createdAt,
      })),
  );
}

function getSelectedSeverityTargets(scans: CompletedScanSummarySource[]) {
  const totals = scans.reduce(
    (acc, scan) => ({
      high: acc.high + (scan.highCount ?? 0),
      medium: acc.medium + (scan.mediumCount ?? 0),
      low: acc.low + (scan.lowCount ?? 0),
    }),
    { high: 0, medium: 0, low: 0 },
  );

  let remaining = MAX_EXECUTIVE_SUMMARY_FINDINGS;
  const high = Math.min(totals.high, remaining);
  remaining -= high;
  const medium = Math.min(totals.medium, remaining);
  remaining -= medium;
  const low = Math.min(totals.low, remaining);

  return { high, medium, low };
}

async function collectFindingsForSeverity(params: {
  severity: Severity;
  limit: number;
  scans: CompletedScanSummarySource[];
  brandId: string;
  userId: string;
  findingsByScanId: Map<string, DashboardExecutiveSummaryFindingInput[]>;
}): Promise<DashboardExecutiveSummaryFindingInput[]> {
  if (params.limit <= 0) return [];

  const selected: DashboardExecutiveSummaryFindingInput[] = [];

  for (const scan of params.scans) {
    if (selected.length >= params.limit) break;
    if ((scan[`${params.severity}Count` as const] ?? 0) <= 0) continue;

    let scanFindings = params.findingsByScanId.get(scan.id);
    if (!scanFindings) {
      scanFindings = await loadVisibleFindingsForScan({
        scanId: scan.id,
        brandId: params.brandId,
        userId: params.userId,
      });
      params.findingsByScanId.set(scan.id, scanFindings);
    }

    const matchingSeverityFindings = scanFindings.filter((finding) => finding.severity === params.severity);
    if (matchingSeverityFindings.length === 0) continue;

    selected.push(...matchingSeverityFindings.slice(0, params.limit - selected.length));
  }

  return selected;
}

export async function buildDashboardExecutiveSummary(params: {
  brandId: string;
  userId: string;
}): Promise<BuiltDashboardExecutiveSummaryResult> {
  const { brandId, userId } = params;

  const brandDoc = await db.collection('brands').doc(brandId).get();
  const brandName = brandDoc.exists ? (brandDoc.data() as BrandProfile).name : 'Unknown brand';

  const scansSnap = await db
    .collection('scans')
    .where('brandId', '==', brandId)
    .where('userId', '==', userId)
    .orderBy('startedAt', 'desc')
    .select('status', 'startedAt', 'completedAt', 'highCount', 'mediumCount', 'lowCount', 'deletion')
    .get();

  const completedScans = scansSnap.docs
    .map((doc) => ({
      id: doc.id,
      ...(doc.data() as Omit<CompletedScanSummarySource, 'id'>),
    }))
    .filter((scan) => scan.status === 'completed')
    .filter((scan) => !isScanDeletionActive(scan));
  const latestCompletedScan = completedScans[0];

  const severityTargets = getSelectedSeverityTargets(completedScans);
  const findingsByScanId = new Map<string, DashboardExecutiveSummaryFindingInput[]>();

  const [highFindings, mediumFindings, lowFindings] = await Promise.all([
    collectFindingsForSeverity({
      severity: 'high',
      limit: severityTargets.high,
      scans: completedScans,
      brandId,
      userId,
      findingsByScanId,
    }),
    collectFindingsForSeverity({
      severity: 'medium',
      limit: severityTargets.medium,
      scans: completedScans,
      brandId,
      userId,
      findingsByScanId,
    }),
    collectFindingsForSeverity({
      severity: 'low',
      limit: severityTargets.low,
      scans: completedScans,
      brandId,
      userId,
      findingsByScanId,
    }),
  ]);

  const selectedFindings = [...highFindings, ...mediumFindings, ...lowFindings];
  const severityBreakdown = {
    high: highFindings.length,
    medium: mediumFindings.length,
    low: lowFindings.length,
  };

  if (selectedFindings.length === 0) {
    return {
      version: DASHBOARD_EXECUTIVE_SUMMARY_VERSION,
      status: 'ready',
      brandId,
      inputFindingCount: 0,
      severityBreakdown,
      summary: buildFallbackExecutiveSummary({
        brandName,
        findingCount: 0,
        severityBreakdown,
      }),
      patterns: [],
      generatedFromScanId: latestCompletedScan?.id,
      requestedForScanId: latestCompletedScan?.id,
      latestCompletedAt: latestCompletedScan?.completedAt ?? latestCompletedScan?.startedAt,
      completedScanCount: completedScans.length,
    };
  }

  const prompt = buildDashboardExecutiveSummaryPrompt({
    brandName,
    severityBreakdown,
    findings: selectedFindings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      title: truncateSummaryInput(finding.title, MAX_FINDING_TITLE_LENGTH),
      description: truncateSummaryInput(finding.description, MAX_FINDING_DESCRIPTION_LENGTH),
    })),
  });

  let rawLlmResponse: string | undefined;
  let finalError: unknown;
  for (let attempt = 1; attempt <= DASHBOARD_EXECUTIVE_SUMMARY_LLM_MAX_ATTEMPTS; attempt++) {
    let attemptRawLlmResponse: string | undefined;
    try {
      attemptRawLlmResponse = await chatCompletion([
        { role: 'system', content: DASHBOARD_EXECUTIVE_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ], { temperature: 0.8 });
      rawLlmResponse = attemptRawLlmResponse;

      const parsed = parseDashboardExecutiveSummaryOutput(attemptRawLlmResponse);
      if (!parsed) {
        throw new Error(`Failed to parse dashboard executive summary output: ${attemptRawLlmResponse.slice(0, 200)}`);
      }

      return {
        version: DASHBOARD_EXECUTIVE_SUMMARY_VERSION,
        status: 'ready',
        brandId,
        inputFindingCount: selectedFindings.length,
        severityBreakdown,
        summary: parsed.summary,
        patterns: clampExecutiveSummaryPatterns(parsed.patterns, new Set(selectedFindings.map((finding) => finding.id))),
        generatedFromScanId: latestCompletedScan?.id,
        requestedForScanId: latestCompletedScan?.id,
        latestCompletedAt: latestCompletedScan?.completedAt ?? latestCompletedScan?.startedAt,
        completedScanCount: completedScans.length,
        rawLlmResponse,
      };
    } catch (error) {
      if (typeof attemptRawLlmResponse === 'string') {
        rawLlmResponse = attemptRawLlmResponse;
      }
      finalError = error;
      if (attempt < DASHBOARD_EXECUTIVE_SUMMARY_LLM_MAX_ATTEMPTS) {
        console.warn(
          `[dashboard-executive-summary] Summary generation failed for brand ${brandId} (attempt ${attempt}/${DASHBOARD_EXECUTIVE_SUMMARY_LLM_MAX_ATTEMPTS}); retrying once:`,
          error,
        );
        continue;
      }
    }
  }

  console.error(`[dashboard-executive-summary] Summary generation failed for brand ${brandId}:`, finalError);
  return {
    version: DASHBOARD_EXECUTIVE_SUMMARY_VERSION,
    status: 'ready',
    brandId,
    inputFindingCount: selectedFindings.length,
    severityBreakdown,
    summary: buildFallbackExecutiveSummary({
      brandName,
      findingCount: selectedFindings.length,
      severityBreakdown,
    }),
    patterns: [],
    generatedFromScanId: latestCompletedScan?.id,
    requestedForScanId: latestCompletedScan?.id,
    latestCompletedAt: latestCompletedScan?.completedAt ?? latestCompletedScan?.startedAt,
    completedScanCount: completedScans.length,
    ...(typeof rawLlmResponse === 'string' ? { rawLlmResponse } : {}),
  };
}

export async function markDashboardExecutiveSummaryPending(params: {
  brandId: string;
  requestedForScanId?: string;
}) {
  const { brandId, requestedForScanId } = params;
  await db.collection('brands').doc(brandId).update({
    'dashboardExecutiveSummary.version': DASHBOARD_EXECUTIVE_SUMMARY_VERSION,
    'dashboardExecutiveSummary.status': 'pending',
    ...(requestedForScanId
      ? { 'dashboardExecutiveSummary.requestedForScanId': requestedForScanId }
      : {}),
    'dashboardExecutiveSummary.startedAt': FieldValue.serverTimestamp(),
    'dashboardExecutiveSummary.completedAt': FieldValue.delete(),
    'dashboardExecutiveSummary.error': FieldValue.delete(),
  });
}

export async function saveDashboardExecutiveSummary(
  brandId: string,
  summaryResult: BuiltDashboardExecutiveSummaryResult,
) {
  await db.collection('brands').doc(brandId).update({
    'dashboardExecutiveSummary.version': DASHBOARD_EXECUTIVE_SUMMARY_VERSION,
    'dashboardExecutiveSummary.status': 'ready',
    'dashboardExecutiveSummary.brandId': summaryResult.brandId,
    'dashboardExecutiveSummary.inputFindingCount': summaryResult.inputFindingCount,
    'dashboardExecutiveSummary.severityBreakdown': summaryResult.severityBreakdown,
    'dashboardExecutiveSummary.summary': summaryResult.summary,
    'dashboardExecutiveSummary.patterns': summaryResult.patterns,
    'dashboardExecutiveSummary.generatedFromScanId': summaryResult.generatedFromScanId ?? FieldValue.delete(),
    'dashboardExecutiveSummary.requestedForScanId': summaryResult.requestedForScanId ?? FieldValue.delete(),
    'dashboardExecutiveSummary.latestCompletedAt': summaryResult.latestCompletedAt ?? FieldValue.delete(),
    'dashboardExecutiveSummary.completedScanCount': summaryResult.completedScanCount,
    'dashboardExecutiveSummary.completedAt': FieldValue.serverTimestamp(),
    'dashboardExecutiveSummary.error': FieldValue.delete(),
    ...(typeof summaryResult.rawLlmResponse === 'string'
      ? { 'dashboardExecutiveSummary.rawLlmResponse': summaryResult.rawLlmResponse }
      : { 'dashboardExecutiveSummary.rawLlmResponse': FieldValue.delete() }),
  });
}

export async function markDashboardExecutiveSummaryFailed(params: {
  brandId: string;
  error: unknown;
  requestedForScanId?: string;
}) {
  const { brandId, error, requestedForScanId } = params;
  await db.collection('brands').doc(brandId).update({
    'dashboardExecutiveSummary.version': DASHBOARD_EXECUTIVE_SUMMARY_VERSION,
    'dashboardExecutiveSummary.status': 'failed',
    ...(requestedForScanId
      ? { 'dashboardExecutiveSummary.requestedForScanId': requestedForScanId }
      : {}),
    'dashboardExecutiveSummary.completedAt': FieldValue.serverTimestamp(),
    'dashboardExecutiveSummary.error': normalizeDashboardExecutiveSummaryError(error),
  });
}

export async function generateAndPersistDashboardExecutiveSummary(params: {
  brandId: string;
  userId: string;
  force?: boolean;
}): Promise<{ outcome: 'updated' | 'skipped'; data?: DashboardExecutiveSummaryData }> {
  const { brandId, userId, force = false } = params;
  const brandRef = db.collection('brands').doc(brandId);
  const brandDoc = await brandRef.get();
  if (!brandDoc.exists) {
    return { outcome: 'skipped' };
  }

  const brand = { id: brandDoc.id, ...(brandDoc.data() as Omit<BrandProfile, 'id'>) } as BrandProfile;
  if (brand.userId !== userId || isBrandDeletionActive(brand) || isBrandHistoryDeletionActive(brand)) {
    return { outcome: 'skipped' };
  }

  let builtResult: BuiltDashboardExecutiveSummaryResult | undefined;
  try {
    builtResult = await buildDashboardExecutiveSummary({ brandId, userId });
    const existing = brand.dashboardExecutiveSummary;
    const isAlreadyCurrent = !force
      && existing?.status === 'ready'
      && existing.generatedFromScanId === builtResult.generatedFromScanId
      && (existing.completedScanCount ?? 0) === builtResult.completedScanCount;

    if (isAlreadyCurrent) {
      return { outcome: 'skipped', data: existing };
    }

    await saveDashboardExecutiveSummary(brandId, builtResult);
    return { outcome: 'updated', data: builtResult };
  } catch (error) {
    await markDashboardExecutiveSummaryFailed({
      brandId,
      error,
      requestedForScanId: builtResult?.generatedFromScanId ?? brand.dashboardExecutiveSummary?.requestedForScanId,
    });
    throw error;
  }
}
