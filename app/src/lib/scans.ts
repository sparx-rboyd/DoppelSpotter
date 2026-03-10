import { FieldValue, type DocumentReference, type DocumentSnapshot, type QueryDocumentSnapshot, type Transaction } from '@google-cloud/firestore';
import { db } from './firestore';
import { rebuildAndPersistDashboardBreakdownsForScanIds } from './dashboard-aggregates';
import type { BrandProfile, Scan, ScanStatus } from './types';

type ScanSnapshot = DocumentSnapshot | QueryDocumentSnapshot;
const STUCK_SUMMARISING_TIMEOUT_MS = 90_000;
const STUCK_PENDING_TIMEOUT_MS = 120_000;

export function isScanInProgress(status: ScanStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'summarising';
}

export function scanFromSnapshot(snapshot: ScanSnapshot): Scan {
  return {
    id: snapshot.id,
    ...(snapshot.data() as Omit<Scan, 'id'>),
  };
}

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

function buildEmptyScanAiSummary(scan: Pick<Scan, 'nonHitCount' | 'skippedCount'>): string {
  const sentences = ['No actionable high, medium or low findings were detected in this scan.'];

  if ((scan.nonHitCount ?? 0) > 0) {
    sentences.push(
      `${scan.nonHitCount} result${scan.nonHitCount === 1 ? ' was' : 's were'} classified as non-findings.`,
    );
  }
  if ((scan.skippedCount ?? 0) > 0) {
    sentences.push(
      `${scan.skippedCount} duplicate result${scan.skippedCount === 1 ? ' was' : 's were'} skipped because they had already appeared in earlier scans.`,
    );
  }

  return sentences.join(' ');
}

export function buildCountOnlyScanAiSummary(
  scan: Pick<Scan, 'highCount' | 'mediumCount' | 'lowCount' | 'nonHitCount' | 'skippedCount'>,
): string {
  const counts = {
    high: scan.highCount ?? 0,
    medium: scan.mediumCount ?? 0,
    low: scan.lowCount ?? 0,
  };
  const actionableCount = counts.high + counts.medium + counts.low;
  if (actionableCount === 0) {
    return buildEmptyScanAiSummary(scan);
  }

  const sentences = [
    `This scan surfaced ${actionableCount} actionable finding${actionableCount === 1 ? '' : 's'}: ${formatScanSeverityBreakdown(counts)}.`,
  ];

  if (counts.high > 0) {
    sentences.push('The highest-risk items suggest potentially damaging brand misuse and should be prioritised for review.');
  } else if (counts.medium > 0) {
    sentences.push('The main concerns are suspicious associations that warrant manual review even though the evidence is less definitive.');
  } else {
    sentences.push('The findings appear lower-risk overall, but they still indicate ongoing third-party use of the brand that is worth monitoring.');
  }

  return sentences.join(' ');
}

function isSummarisingScanStale(scan: Pick<Scan, 'summaryStartedAt'>): boolean {
  if (!scan.summaryStartedAt) return true;

  try {
    return Date.now() - scan.summaryStartedAt.toMillis() >= STUCK_SUMMARISING_TIMEOUT_MS;
  } catch {
    return true;
  }
}

export function isPendingScanStale(scan: Pick<Scan, 'startedAt' | 'status' | 'actorRunIds'>): boolean {
  if (scan.status !== 'pending') return false;
  if ((scan.actorRunIds?.length ?? 0) > 0) return false;

  try {
    return Date.now() - scan.startedAt.toMillis() >= STUCK_PENDING_TIMEOUT_MS;
  } catch {
    return false;
  }
}

/**
 * Clear a brand's active scan pointer only if it still references the supplied scan.
 * This avoids wiping out a newer scan that may have started after the original one ended.
 */
export async function clearBrandActiveScanIfMatches(
  brandRef: DocumentReference,
  scanId: string,
  tx?: Transaction,
  brand?: BrandProfile,
) {
  if (tx) {
    const loadedBrand = brand ?? await (async () => {
      const brandSnap = await tx.get(brandRef);
      if (!brandSnap.exists) return null;
      return brandSnap.data() as BrandProfile;
    })();
    if (!loadedBrand) return;

    if (loadedBrand.activeScanId === scanId) {
      tx.update(brandRef, { activeScanId: FieldValue.delete() });
    }
    return;
  }

  await db.runTransaction(async (innerTx) => {
    const brandSnap = await innerTx.get(brandRef);
    if (!brandSnap.exists) return;

    const brand = brandSnap.data() as BrandProfile;
    if (brand.activeScanId === scanId) {
      innerTx.update(brandRef, { activeScanId: FieldValue.delete() });
    }
  });
}

/**
 * Recover a scan that has been stuck in the `summarising` phase for too long.
 * This uses a deterministic count-based fallback summary so the UI does not remain
 * wedged if the final LLM-based summary step fails after actor processing finished.
 */
export async function recoverStuckSummarisingScan(scanRef: DocumentReference): Promise<boolean> {
  let recoveredScanId: string | null = null;
  let recoveredBrandId: string | null = null;
  let recoveredUserId: string | null = null;

  const recovered = await db.runTransaction(async (tx) => {
    const scanSnap = await tx.get(scanRef);
    if (!scanSnap.exists) return false;

    const scan = scanFromSnapshot(scanSnap);
    if (scan.status !== 'summarising' || !isSummarisingScanStale(scan)) {
      return false;
    }

    const totalRunCount = scan.actorRunIds?.length ?? 0;
    const completedRunCount = scan.completedRunCount ?? 0;
    if (totalRunCount > 0 && completedRunCount < totalRunCount) {
      return false;
    }

    const brandRef = db.collection('brands').doc(scan.brandId);
    const brandSnap = await tx.get(brandRef);
    const brand = brandSnap.exists ? (brandSnap.data() as BrandProfile) : undefined;

    tx.update(scanRef, {
      status: 'completed',
      aiSummary: scan.aiSummary ?? buildCountOnlyScanAiSummary(scan),
      completedAt: scan.completedAt ?? FieldValue.serverTimestamp(),
      summaryStartedAt: FieldValue.delete(),
      ...(scan.errorMessage ? { errorMessage: FieldValue.delete() } : {}),
    });

    await clearBrandActiveScanIfMatches(brandRef, scan.id, tx, brand);
    recoveredScanId = scan.id;
    recoveredBrandId = scan.brandId;
    recoveredUserId = scan.userId;
    return true;
  });

  if (recovered && recoveredScanId && recoveredBrandId && recoveredUserId) {
    try {
      await rebuildAndPersistDashboardBreakdownsForScanIds({
        brandId: recoveredBrandId,
        userId: recoveredUserId,
        scanIds: [recoveredScanId],
      });
    } catch (error) {
      console.error(`[scan] Failed to rebuild dashboard breakdowns for recovered scan ${recoveredScanId}:`, error);
    }
  }

  return recovered;
}

/**
 * Recover a scan that never made it past the initial pending reservation stage.
 * This protects scheduled and manual scans from getting stuck behind an orphaned
 * `activeScanId` if the request dies after reserving the scan but before actor
 * runs are started.
 */
export async function recoverStuckPendingScan(scanRef: DocumentReference): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const scanSnap = await tx.get(scanRef);
    if (!scanSnap.exists) return false;

    const scan = scanFromSnapshot(scanSnap);
    if (!isPendingScanStale(scan)) {
      return false;
    }

    const brandRef = db.collection('brands').doc(scan.brandId);
    const brandSnap = await tx.get(brandRef);
    const brand = brandSnap.exists ? (brandSnap.data() as BrandProfile) : undefined;

    tx.update(scanRef, {
      status: 'failed',
      errorMessage: 'Scan failed to start before any actor runs were created',
      completedAt: FieldValue.serverTimestamp(),
    });

    await clearBrandActiveScanIfMatches(brandRef, scan.id, tx, brand);
    return true;
  });
}
