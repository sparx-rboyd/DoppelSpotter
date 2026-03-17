import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { randomUUID } from 'crypto';
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
import { scheduleDashboardExecutiveSummaryTaskOrRunInline } from '@/lib/dashboard-summary-tasks';
import { runWriteBatchInChunks } from '@/lib/firestore-batches';
import type {
  BrandProfile,
  DashboardExecutiveSummaryData,
  DashboardExecutiveSummaryPattern,
  Finding,
  Scan,
  ScanExecutiveSummaryCandidate,
  ScanExecutiveSummaryCandidates,
  ScanExecutiveSummaryCandidateChunk,
  Severity,
} from '@/lib/types';

export const DASHBOARD_EXECUTIVE_SUMMARY_VERSION = 1;
export const SCAN_EXECUTIVE_SUMMARY_CANDIDATES_VERSION = 1;
const MAX_EXECUTIVE_SUMMARY_FINDINGS = 300;
const SCAN_EXECUTIVE_SUMMARY_CANDIDATE_CHUNK_SIZE = 100;
const SCAN_EXECUTIVE_SUMMARY_CANDIDATE_CHUNK_COLLECTION = 'scanExecutiveSummaryCandidateChunks';
const MAX_FINDING_TITLE_LENGTH = 120;
const MAX_FINDING_DESCRIPTION_LENGTH = 320;
const DASHBOARD_EXECUTIVE_SUMMARY_LLM_MAX_ATTEMPTS = 2;
const DASHBOARD_EXECUTIVE_SUMMARY_LEASE_MS = 5 * 60_000;

type DashboardExecutiveSummarySeverityBreakdown = NonNullable<DashboardExecutiveSummaryData['severityBreakdown']>;
type DashboardExecutiveSummaryFindingInput = {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  provisionalTheme?: string;
};

type VisibleExecutiveSummaryFinding = {
  findingId: string;
  severity: Severity;
  title: string;
  description: string;
  provisionalTheme?: string;
  createdAt?: Finding['createdAt'];
};

type CompletedScanSummarySource = Pick<
  Scan,
  'id' | 'status' | 'startedAt' | 'completedAt' | 'highCount' | 'mediumCount' | 'lowCount' | 'deletion' | 'executiveSummaryCandidates'
>;

type BuiltDashboardExecutiveSummaryResult = DashboardExecutiveSummaryData & {
  status: 'ready';
  inputFindingCount: number;
  severityBreakdown: DashboardExecutiveSummarySeverityBreakdown;
  summary: string;
  patterns: DashboardExecutiveSummaryPattern[];
  completedScanCount: number;
};

type BuiltScanExecutiveSummaryCandidatesPayload = {
  meta: ScanExecutiveSummaryCandidates;
  chunks: ScanExecutiveSummaryCandidateChunk[];
};

function truncateSummaryInput(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sortFindingsByCreatedAtDesc<T extends { createdAt?: Finding['createdAt']; findingId: string }>(findings: T[]): T[] {
  return [...findings].sort((left, right) => {
    const leftMillis = left.createdAt?.toMillis?.() ?? 0;
    const rightMillis = right.createdAt?.toMillis?.() ?? 0;
    return rightMillis - leftMillis || left.findingId.localeCompare(right.findingId);
  });
}

function sortExecutiveSummaryCandidates(
  findings: VisibleExecutiveSummaryFinding[],
): VisibleExecutiveSummaryFinding[] {
  const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return [...findings].sort((left, right) => {
    const severityDiff = severityRank[left.severity] - severityRank[right.severity];
    if (severityDiff !== 0) return severityDiff;
    const leftMillis = left.createdAt?.toMillis?.() ?? 0;
    const rightMillis = right.createdAt?.toMillis?.() ?? 0;
    if (leftMillis !== rightMillis) return rightMillis - leftMillis;
    return left.findingId.localeCompare(right.findingId);
  });
}

function isCurrentScanExecutiveSummaryCandidates(
  candidates?: ScanExecutiveSummaryCandidates,
): candidates is ScanExecutiveSummaryCandidates {
  return candidates?.version === SCAN_EXECUTIVE_SUMMARY_CANDIDATES_VERSION
    && typeof candidates.itemCount === 'number'
    && typeof candidates.chunkCount === 'number';
}

function buildScanExecutiveSummaryChunkDocId(scanId: string, chunkIndex: number): string {
  return `${scanId}__${String(chunkIndex).padStart(3, '0')}`;
}

function getScanExecutiveSummaryChunkDocRef(scanId: string, chunkIndex: number) {
  return db
    .collection(SCAN_EXECUTIVE_SUMMARY_CANDIDATE_CHUNK_COLLECTION)
    .doc(buildScanExecutiveSummaryChunkDocId(scanId, chunkIndex));
}

function chunkExecutiveSummaryCandidates(
  scanId: string,
  brandId: string,
  userId: string,
  items: ScanExecutiveSummaryCandidate[],
): ScanExecutiveSummaryCandidateChunk[] {
  const chunks: ScanExecutiveSummaryCandidateChunk[] = [];

  for (let chunkIndex = 0; chunkIndex * SCAN_EXECUTIVE_SUMMARY_CANDIDATE_CHUNK_SIZE < items.length; chunkIndex += 1) {
    chunks.push({
      version: SCAN_EXECUTIVE_SUMMARY_CANDIDATES_VERSION,
      scanId,
      brandId,
      userId,
      chunkIndex,
      items: items.slice(
        chunkIndex * SCAN_EXECUTIVE_SUMMARY_CANDIDATE_CHUNK_SIZE,
        (chunkIndex + 1) * SCAN_EXECUTIVE_SUMMARY_CANDIDATE_CHUNK_SIZE,
      ),
    });
  }

  return chunks;
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

function isDashboardExecutiveSummaryLeaseActive(summary?: DashboardExecutiveSummaryData | null): boolean {
  if (!summary?.leaseExpiresAt) return false;

  try {
    return summary.leaseExpiresAt.toMillis() > Date.now();
  } catch {
    return false;
  }
}

async function loadVisibleFindingsForScan(params: {
  scanId: string;
  brandId: string;
  userId: string;
}): Promise<VisibleExecutiveSummaryFinding[]> {
  const findingsSnap = await db
    .collection('findings')
    .where('scanId', '==', params.scanId)
    .where('brandId', '==', params.brandId)
    .where('userId', '==', params.userId)
    .select(
      'severity',
      'title',
      'description',
      'llmAnalysis',
      'provisionalTheme',
      'isFalsePositive',
      'isIgnored',
      'isAddressed',
      'createdAt',
    )
    .get();

  return sortFindingsByCreatedAtDesc(
    findingsSnap.docs
      .map((doc) => ({
        findingId: doc.id,
        ...(doc.data() as Pick<
          Finding,
          'severity' | 'title' | 'description' | 'llmAnalysis' | 'provisionalTheme' | 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'createdAt'
        >),
      }))
      .filter((finding) => !finding.isFalsePositive && !finding.isIgnored && !finding.isAddressed)
      .map((finding) => ({
        findingId: finding.findingId,
        severity: finding.severity,
        title: finding.title,
        description: finding.description?.trim() || finding.llmAnalysis?.trim() || finding.title,
        provisionalTheme: finding.provisionalTheme?.trim() || undefined,
        createdAt: finding.createdAt,
      })),
  );
}

export async function buildScanExecutiveSummaryCandidates(params: {
  scanId: string;
  brandId: string;
  userId: string;
}): Promise<ScanExecutiveSummaryCandidates> {
  return (await buildScanExecutiveSummaryCandidatesPayload(params)).meta;
}

async function buildScanExecutiveSummaryCandidatesPayload(params: {
  scanId: string;
  brandId: string;
  userId: string;
}): Promise<BuiltScanExecutiveSummaryCandidatesPayload> {
  const visibleFindings = await loadVisibleFindingsForScan(params);
  const visibleCounts = visibleFindings.reduce(
    (acc, finding) => {
      acc[finding.severity] += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0 },
  );

  const items: ScanExecutiveSummaryCandidate[] = sortExecutiveSummaryCandidates(visibleFindings)
    .slice(0, MAX_EXECUTIVE_SUMMARY_FINDINGS)
    .map((finding) => ({
      findingId: finding.findingId,
      severity: finding.severity,
      title: truncateSummaryInput(finding.title, MAX_FINDING_TITLE_LENGTH),
      description: truncateSummaryInput(finding.description, MAX_FINDING_DESCRIPTION_LENGTH),
      ...(finding.provisionalTheme ? { provisionalTheme: finding.provisionalTheme } : {}),
      ...(finding.createdAt ? { createdAt: finding.createdAt } : {}),
    }));

  const chunks = chunkExecutiveSummaryCandidates(
    params.scanId,
    params.brandId,
    params.userId,
    items,
  );

  return {
    meta: {
      version: SCAN_EXECUTIVE_SUMMARY_CANDIDATES_VERSION,
      visibleCounts,
      itemCount: items.length,
      chunkCount: chunks.length,
    },
    chunks,
  };
}

export async function saveScanExecutiveSummaryCandidates(
  scanId: string,
  payload: BuiltScanExecutiveSummaryCandidatesPayload,
) {
  const existingChunksSnap = await db
    .collection(SCAN_EXECUTIVE_SUMMARY_CANDIDATE_CHUNK_COLLECTION)
    .where('scanId', '==', scanId)
    .select('chunkIndex')
    .get();

  const desiredChunkIds = new Set(payload.chunks.map((chunk) => buildScanExecutiveSummaryChunkDocId(scanId, chunk.chunkIndex)));
  const chunkWrites: Array<
    | { kind: 'set'; chunk: ScanExecutiveSummaryCandidateChunk }
    | { kind: 'delete'; id: string }
  > = [
    ...payload.chunks.map((chunk) => ({ kind: 'set' as const, chunk })),
    ...existingChunksSnap.docs
      .filter((doc) => !desiredChunkIds.has(doc.id))
      .map((doc) => ({ kind: 'delete' as const, id: doc.id })),
  ];

  await db.collection('scans').doc(scanId).update({
    executiveSummaryCandidates: {
      ...payload.meta,
      generatedAt: FieldValue.serverTimestamp(),
    },
  });

  await runWriteBatchInChunks(chunkWrites, (batch, write) => {
    if (write.kind === 'set') {
      batch.set(getScanExecutiveSummaryChunkDocRef(scanId, write.chunk.chunkIndex), write.chunk);
      return;
    }

    batch.delete(
      db.collection(SCAN_EXECUTIVE_SUMMARY_CANDIDATE_CHUNK_COLLECTION).doc(write.id),
    );
  });
}

export async function buildAndPersistScanExecutiveSummaryCandidates(params: {
  scanId: string;
  brandId: string;
  userId: string;
}): Promise<ScanExecutiveSummaryCandidates> {
  const payload = await buildScanExecutiveSummaryCandidatesPayload(params);
  await saveScanExecutiveSummaryCandidates(params.scanId, payload);
  return payload.meta;
}

export async function rebuildAndPersistScanExecutiveSummaryCandidatesForScanIds(params: {
  scanIds: string[];
  brandId: string;
  userId: string;
}): Promise<Map<string, ScanExecutiveSummaryCandidates>> {
  const scanIds = [...new Set(params.scanIds.filter((scanId) => scanId.trim().length > 0))];
  const results = new Map<string, ScanExecutiveSummaryCandidates>();

  await Promise.all(
    scanIds.map(async (scanId) => {
      const candidates = await buildAndPersistScanExecutiveSummaryCandidates({
        scanId,
        brandId: params.brandId,
        userId: params.userId,
      });
      results.set(scanId, candidates);
    }),
  );

  return results;
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

async function resolveScanExecutiveSummaryCandidates(params: {
  scan: CompletedScanSummarySource;
  brandId: string;
  userId: string;
}): Promise<{ candidates: ScanExecutiveSummaryCandidate[]; source: 'cache' | 'rebuilt' }> {
  if (isCurrentScanExecutiveSummaryCandidates(params.scan.executiveSummaryCandidates)) {
    const cachedCandidates = await loadScanExecutiveSummaryCandidateItems(params.scan);
    if (cachedCandidates) {
      return {
        candidates: cachedCandidates,
        source: 'cache',
      };
    }
  }

  const payload = await buildScanExecutiveSummaryCandidatesPayload({
    scanId: params.scan.id,
    brandId: params.brandId,
    userId: params.userId,
  });

  try {
    await saveScanExecutiveSummaryCandidates(params.scan.id, payload);
  } catch (error) {
    console.error(`[dashboard-executive-summary] Scan ${params.scan.id}: failed to persist rebuilt executive-summary candidates:`, error);
  }

  return { candidates: payload.chunks.flatMap((chunk) => chunk.items), source: 'rebuilt' };
}

async function loadScanExecutiveSummaryCandidateItems(
  scan: CompletedScanSummarySource,
): Promise<ScanExecutiveSummaryCandidate[] | null> {
  const meta = scan.executiveSummaryCandidates;
  if (!isCurrentScanExecutiveSummaryCandidates(meta)) {
    return null;
  }
  if (meta.chunkCount === 0 || meta.itemCount === 0) {
    return [];
  }

  const chunkDocs = await Promise.all(
    Array.from({ length: meta.chunkCount }, (_, chunkIndex) =>
      getScanExecutiveSummaryChunkDocRef(scan.id, chunkIndex).get(),
    ),
  );

  const chunks = chunkDocs
    .filter((doc): doc is typeof doc & { exists: true } => doc.exists)
    .map((doc) => doc.data() as ScanExecutiveSummaryCandidateChunk)
    .filter((chunk) => chunk.version === SCAN_EXECUTIVE_SUMMARY_CANDIDATES_VERSION)
    .sort((left, right) => left.chunkIndex - right.chunkIndex);

  if (chunks.length !== meta.chunkCount) {
    return null;
  }

  return chunks.flatMap((chunk) => chunk.items).slice(0, meta.itemCount);
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
    .select(
      'status',
      'startedAt',
      'completedAt',
      'highCount',
      'mediumCount',
      'lowCount',
      'deletion',
      'executiveSummaryCandidates',
    )
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
  const selectedHigh: DashboardExecutiveSummaryFindingInput[] = [];
  const selectedMedium: DashboardExecutiveSummaryFindingInput[] = [];
  const selectedLow: DashboardExecutiveSummaryFindingInput[] = [];

  for (const scan of completedScans) {
    if (
      selectedHigh.length >= severityTargets.high
      && selectedMedium.length >= severityTargets.medium
      && selectedLow.length >= severityTargets.low
    ) {
      break;
    }

    const { candidates } = await resolveScanExecutiveSummaryCandidates({
      scan,
      brandId,
      userId,
    });

    if (selectedHigh.length < severityTargets.high) {
      for (const item of candidates) {
        if (item.severity !== 'high') continue;
        selectedHigh.push({
          id: item.findingId,
          severity: item.severity,
          title: item.title,
          description: item.description,
          provisionalTheme: item.provisionalTheme,
        });
        if (selectedHigh.length >= severityTargets.high) break;
      }
    }

    if (selectedMedium.length < severityTargets.medium) {
      for (const item of candidates) {
        if (item.severity !== 'medium') continue;
        selectedMedium.push({
          id: item.findingId,
          severity: item.severity,
          title: item.title,
          description: item.description,
          provisionalTheme: item.provisionalTheme,
        });
        if (selectedMedium.length >= severityTargets.medium) break;
      }
    }

    if (selectedLow.length < severityTargets.low) {
      for (const item of candidates) {
        if (item.severity !== 'low') continue;
        selectedLow.push({
          id: item.findingId,
          severity: item.severity,
          title: item.title,
          description: item.description,
          provisionalTheme: item.provisionalTheme,
        });
        if (selectedLow.length >= severityTargets.low) break;
      }
    }
  }

  const selectedFindings = [...selectedHigh, ...selectedMedium, ...selectedLow];
  const severityBreakdown = {
    high: selectedHigh.length,
    medium: selectedMedium.length,
    low: selectedLow.length,
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
      ...(finding.provisionalTheme ? { provisionalTheme: finding.provisionalTheme } : {}),
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
    'dashboardExecutiveSummary.leaseToken': FieldValue.delete(),
    'dashboardExecutiveSummary.leaseExpiresAt': FieldValue.delete(),
    'dashboardExecutiveSummary.error': FieldValue.delete(),
  });
}

export async function triggerDashboardExecutiveSummaryRefresh(params: {
  brandId: string;
  userId: string;
  requestHeaders: Headers;
  logPrefix: string;
  requestedForScanId?: string;
  force?: boolean;
}) {
  const { brandId, userId, requestHeaders, logPrefix, requestedForScanId, force } = params;
  await markDashboardExecutiveSummaryPending({
    brandId,
    requestedForScanId,
  });
  await scheduleDashboardExecutiveSummaryTaskOrRunInline({
    payload: {
      kind: 'dashboard-executive-summary',
      brandId,
      userId,
      ...(force === true ? { force: true } : {}),
    },
    requestHeaders,
    logPrefix,
    runInline: () => generateAndPersistDashboardExecutiveSummary({
      brandId,
      userId,
      force,
    }),
  });
}

export async function saveDashboardExecutiveSummary(
  brandId: string,
  summaryResult: BuiltDashboardExecutiveSummaryResult,
  leaseToken?: string,
) {
  const brandRef = db.collection('brands').doc(brandId);
  const updates = {
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
    'dashboardExecutiveSummary.leaseToken': FieldValue.delete(),
    'dashboardExecutiveSummary.leaseExpiresAt': FieldValue.delete(),
    'dashboardExecutiveSummary.error': FieldValue.delete(),
    ...(typeof summaryResult.rawLlmResponse === 'string'
      ? { 'dashboardExecutiveSummary.rawLlmResponse': summaryResult.rawLlmResponse }
      : { 'dashboardExecutiveSummary.rawLlmResponse': FieldValue.delete() }),
  };

  if (!leaseToken) {
    await brandRef.update(updates);
    return;
  }

  await db.runTransaction(async (tx) => {
    const brandDoc = await tx.get(brandRef);
    if (!brandDoc.exists) return;
    const brand = brandDoc.data() as BrandProfile;
    if (brand.dashboardExecutiveSummary?.leaseToken !== leaseToken) {
      return;
    }
    tx.update(brandRef, updates);
  });
}

export async function markDashboardExecutiveSummaryFailed(params: {
  brandId: string;
  error: unknown;
  requestedForScanId?: string;
  leaseToken?: string;
}) {
  const { brandId, error, requestedForScanId, leaseToken } = params;
  const brandRef = db.collection('brands').doc(brandId);
  const updates = {
    'dashboardExecutiveSummary.version': DASHBOARD_EXECUTIVE_SUMMARY_VERSION,
    'dashboardExecutiveSummary.status': 'failed',
    ...(requestedForScanId
      ? { 'dashboardExecutiveSummary.requestedForScanId': requestedForScanId }
      : {}),
    'dashboardExecutiveSummary.completedAt': FieldValue.serverTimestamp(),
    'dashboardExecutiveSummary.leaseToken': FieldValue.delete(),
    'dashboardExecutiveSummary.leaseExpiresAt': FieldValue.delete(),
    'dashboardExecutiveSummary.error': normalizeDashboardExecutiveSummaryError(error),
  };

  if (!leaseToken) {
    await brandRef.update(updates);
    return;
  }

  await db.runTransaction(async (tx) => {
    const brandDoc = await tx.get(brandRef);
    if (!brandDoc.exists) return;
    const brand = brandDoc.data() as BrandProfile;
    if (brand.dashboardExecutiveSummary?.leaseToken !== leaseToken) {
      return;
    }
    tx.update(brandRef, updates);
  });
}

export async function generateAndPersistDashboardExecutiveSummary(params: {
  brandId: string;
  userId: string;
  force?: boolean;
}): Promise<{ outcome: 'updated' | 'skipped'; data?: DashboardExecutiveSummaryData }> {
  const { brandId, userId, force = false } = params;
  const brandRef = db.collection('brands').doc(brandId);
  const leaseToken = randomUUID();
  const claimed = await db.runTransaction(async (tx) => {
    const brandDoc = await tx.get(brandRef);
    if (!brandDoc.exists) {
      return { outcome: 'skipped' as const };
    }

    const brand = { id: brandDoc.id, ...(brandDoc.data() as Omit<BrandProfile, 'id'>) } as BrandProfile;
    if (brand.userId !== userId || isBrandDeletionActive(brand) || isBrandHistoryDeletionActive(brand)) {
      return { outcome: 'skipped' as const };
    }
    if (!force && isDashboardExecutiveSummaryLeaseActive(brand.dashboardExecutiveSummary)) {
      return { outcome: 'skipped' as const, data: brand.dashboardExecutiveSummary ?? undefined };
    }

    tx.update(brandRef, {
      'dashboardExecutiveSummary.version': DASHBOARD_EXECUTIVE_SUMMARY_VERSION,
      'dashboardExecutiveSummary.status': 'pending',
      'dashboardExecutiveSummary.startedAt': FieldValue.serverTimestamp(),
      'dashboardExecutiveSummary.completedAt': FieldValue.delete(),
      'dashboardExecutiveSummary.leaseToken': leaseToken,
      'dashboardExecutiveSummary.leaseExpiresAt': Timestamp.fromDate(new Date(Date.now() + DASHBOARD_EXECUTIVE_SUMMARY_LEASE_MS)),
      'dashboardExecutiveSummary.error': FieldValue.delete(),
    });

    return { outcome: 'claimed' as const, brand };
  });

  if (claimed.outcome === 'skipped') {
    return { outcome: 'skipped', data: claimed.data };
  }
  const brand = claimed.brand;

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

    await saveDashboardExecutiveSummary(brandId, builtResult, leaseToken);
    return { outcome: 'updated', data: builtResult };
  } catch (error) {
    await markDashboardExecutiveSummaryFailed({
      brandId,
      error,
      requestedForScanId: builtResult?.generatedFromScanId ?? brand.dashboardExecutiveSummary?.requestedForScanId,
      leaseToken,
    });
    throw error;
  }
}
