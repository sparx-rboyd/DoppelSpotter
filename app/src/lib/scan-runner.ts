import { FieldValue, type DocumentReference } from '@google-cloud/firestore';
import { db } from './firestore';
import type { ActorRunInfo, BrandProfile, Scan } from './types';
import {
  clearBrandActiveScanIfMatches,
  isPendingScanStale,
  isScanInProgress,
  scanFromSnapshot,
} from './scans';
import { computeNextScheduledRun, isScheduledRunDue } from './scan-schedules';

export class ScanStartError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export class ActiveScanConflictError extends Error {
  constructor(public readonly scan: Scan) {
    super('Brand already has a scan in progress');
  }
}

type ScheduledStartOptions = {
  dispatchedAt?: Date;
};

type StartScanForBrandParams = {
  brandId: string;
  actorIds?: string[];
  requestHeaders: Headers;
  ownerUserId?: string;
  scheduled?: ScheduledStartOptions;
};

type ScheduledScanSkipReason = 'not_due' | 'active_scan';

export type StartScanForBrandResult =
  | {
      outcome: 'started';
      scanId: string;
      status: 'running';
      actorCount: number;
    }
  | {
      outcome: 'skipped';
      reason: ScheduledScanSkipReason;
      activeScan?: Scan;
    };

type PreparedScanStart = {
  brand: BrandProfile;
  brandRef: DocumentReference;
  scanRef: DocumentReference;
  targetActorIds: string[];
};

export async function startScanForBrand(params: StartScanForBrandParams): Promise<StartScanForBrandResult> {
  const { CORE_ACTOR_IDS, getActorConfig } = await import('@/lib/apify/actors');
  const { startActorRun } = await import('@/lib/apify/client');

  const targetActorIds = params.actorIds ?? CORE_ACTOR_IDS;
  const brandRef = db.collection('brands').doc(params.brandId);
  const scanRef = db.collection('scans').doc();
  const now = params.scheduled?.dispatchedAt ?? new Date();

  let preparedScan: PreparedScanStart | null = null;
  let scheduledSkipResult: StartScanForBrandResult | null = null;

  const scan: Omit<Scan, 'id'> = {
    brandId: params.brandId,
    userId: '',
    status: 'pending',
    actorIds: targetActorIds,
    actorRunIds: [],
    actorRuns: {},
    completedRunCount: 0,
    findingCount: 0,
    skippedCount: 0,
    startedAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
  };

  await db.runTransaction(async (tx) => {
    const brandDoc = await tx.get(brandRef);
    if (!brandDoc.exists) throw new ScanStartError('Brand not found', 404);

    const brandData = brandDoc.data() as BrandProfile;
    if (params.ownerUserId && brandData.userId !== params.ownerUserId) {
      throw new ScanStartError('Forbidden', 403);
    }

    if (params.scheduled) {
      const schedule = brandData.scanSchedule;
      if (!schedule || !isScheduledRunDue(schedule, now)) {
        preparedScan = null;
        return;
      }
    }

    const activeScanId = brandData.activeScanId;
    if (activeScanId) {
      const activeScanDoc = await tx.get(db.collection('scans').doc(activeScanId));
      if (activeScanDoc.exists) {
        const activeScan = scanFromSnapshot(activeScanDoc);
        if (isPendingScanStale(activeScan)) {
          tx.update(activeScanDoc.ref, {
            status: 'failed',
            errorMessage: 'Scan failed to start before any actor runs were created',
            completedAt: FieldValue.serverTimestamp(),
          });
          tx.update(brandRef, { activeScanId: FieldValue.delete() });
        } else if (
          activeScan.brandId === params.brandId &&
          activeScan.userId === brandData.userId &&
          isScanInProgress(activeScan.status)
        ) {
          if (params.scheduled && brandData.scanSchedule) {
            tx.update(brandRef, {
              'scanSchedule.nextRunAt': computeNextScheduledRun(brandData.scanSchedule, now),
            });
            scheduledSkipResult = {
              outcome: 'skipped',
              reason: 'active_scan',
              activeScan,
            };
            throw new ScheduledScanSkipError('active_scan', activeScan);
          }

          throw new ActiveScanConflictError(activeScan);
        }
      }

      tx.update(brandRef, { activeScanId: FieldValue.delete() });
    }

    scan.userId = brandData.userId;
    tx.set(scanRef, scan);

    const brandUpdates: Record<string, unknown> = {
      activeScanId: scanRef.id,
    };

    if (params.scheduled && brandData.scanSchedule) {
      brandUpdates['scanSchedule.nextRunAt'] = computeNextScheduledRun(brandData.scanSchedule, now);
      brandUpdates['scanSchedule.lastTriggeredAt'] = now;
      brandUpdates['scanSchedule.lastScheduledScanId'] = scanRef.id;
    }

    tx.update(brandRef, brandUpdates);
    preparedScan = {
      brand: brandData,
      brandRef,
      scanRef,
      targetActorIds,
    };
  }).catch((error: unknown) => {
    if (error instanceof ScheduledScanSkipError) {
      return;
    }
    throw error;
  });

  if (scheduledSkipResult) {
    return scheduledSkipResult;
  }

  if (!preparedScan) {
    return { outcome: 'skipped', reason: 'not_due' };
  }

  const readyScan = preparedScan as PreparedScanStart;
  const webhookUrl = `${buildAppUrl(params.requestHeaders)}/api/webhooks/apify`;
  const actorRunIds: string[] = [];
  const actorRuns: Record<string, ActorRunInfo> = {};
  let successCount = 0;

  for (const actorId of readyScan.targetActorIds) {
    const actorConfig = getActorConfig(actorId);
    if (!actorConfig) {
      console.warn(`[scan] Unknown actor ID: ${actorId} — skipping`);
      continue;
    }

    try {
      const { runId } = await startActorRun(actorConfig, readyScan.brand, webhookUrl);
      actorRunIds.push(runId);
      actorRuns[runId] = {
        actorId,
        source: actorConfig.source,
        status: 'running',
        skippedDuplicateCount: 0,
      };
      successCount++;
      console.log(`[scan] Started actor ${actorId} → runId=${runId}`);
    } catch (error) {
      console.error(`[scan] Failed to start actor ${actorId}:`, error);
    }
  }

  if (successCount === 0) {
    await readyScan.scanRef.update({
      status: 'failed',
      errorMessage: 'All actor runs failed to start',
      completedAt: FieldValue.serverTimestamp(),
    });
    await clearBrandActiveScanIfMatches(readyScan.brandRef, readyScan.scanRef.id);
    throw new ScanStartError('Failed to start any actor runs', 500);
  }

  await readyScan.scanRef.update({
    status: 'running',
    actorRunIds,
    actorRuns,
    completedRunCount: readyScan.targetActorIds.length - successCount,
  });

  return {
    outcome: 'started',
    scanId: readyScan.scanRef.id,
    status: 'running',
    actorCount: successCount,
  };
}

class ScheduledScanSkipError extends Error {
  constructor(
    public readonly reason: ScheduledScanSkipReason,
    public readonly activeScan?: Scan,
  ) {
    super('Scheduled scan skipped');
  }
}

export function buildAppUrl(headers: Headers): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, '');
  }

  const proto = headers.get('x-forwarded-proto') ?? 'http';
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}
