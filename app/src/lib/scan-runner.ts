import { FieldValue, type DocumentReference } from '@google-cloud/firestore';
import { db } from './firestore';
import type { ActorRunInfo, BrandProfile, Scan } from './types';
import type { ActorConfig } from './apify/actors';
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
  targetActors: ActorConfig[];
};

export async function startScanForBrand(params: StartScanForBrandParams): Promise<StartScanForBrandResult> {
  const { getTargetActorConfigs } = await import('@/lib/apify/actors');
  const { startActorRun } = await import('@/lib/apify/client');
  const { prepareUserPreferenceHintsForScan } = await import('@/lib/analysis/user-preference-hints');
  const brandRef = db.collection('brands').doc(params.brandId);
  const scanRef = db.collection('scans').doc();
  const now = params.scheduled?.dispatchedAt ?? new Date();

  let preparedScan: PreparedScanStart | null = null;
  let scheduledSkipResult: StartScanForBrandResult | null = null;

  const scan: Omit<Scan, 'id'> = {
    brandId: params.brandId,
    userId: '',
    status: 'pending',
    actorIds: [],
    actorRunIds: [],
    actorRuns: {},
    completedRunCount: 0,
    findingCount: 0,
    addressedCount: 0,
    skippedCount: 0,
    userPreferenceHintsStatus: 'pending',
    userPreferenceHintsStartedAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
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
    const targetActors = getTargetActorConfigs(brandData);
    if (targetActors.length === 0) {
      throw new ScanStartError('At least one scan source must be enabled', 400);
    }
    scan.actorIds = Array.from(new Set(targetActors.map((actor) => actor.actorId)));
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
      targetActors,
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
  const targetSources = Array.from(new Set(readyScan.targetActors.map((actor) => actor.source)));

  const actorStartPromise = (async () => {
    const results = await Promise.all(readyScan.targetActors.map(async (actorConfig) => {
      try {
        const { runId, query, displayQuery } = await startActorRun(actorConfig, readyScan.brand, webhookUrl);
        await readyScan.scanRef.update({
          actorRunIds: FieldValue.arrayUnion(runId),
          [`actorRuns.${runId}`]: {
            scannerId: actorConfig.id,
            actorId: actorConfig.actorId,
            source: actorConfig.source,
            status: 'running',
            skippedDuplicateCount: 0,
            searchDepth: 0,
            searchQuery: query,
            displayQuery,
          } satisfies ActorRunInfo,
        });
        console.log(`[scan] Started scanner ${actorConfig.id} (${actorConfig.actorId}) → runId=${runId}`);
        return true;
      } catch (error) {
        console.error(`[scan] Failed to start scanner ${actorConfig.id}:`, error);
        return false;
      }
    }));

    const successCount = results.filter(Boolean).length;
    return { successCount };
  })();

  const preferenceHintsPromise = (async () => {
    await prepareUserPreferenceHintsForScan({
      scanRef: readyScan.scanRef,
      brandId: params.brandId,
      brandName: readyScan.brand.name,
      userId: readyScan.brand.userId,
      targetSources,
    });

    try {
      await replayDeferredSucceededCallbacks({
        scanRef: readyScan.scanRef,
        webhookUrl,
      });
    } catch (error) {
      console.error(`[scan] Failed to drain deferred succeeded runs for scan ${readyScan.scanRef.id}:`, error);
    }
  })();

  const [{ successCount }] = await Promise.all([actorStartPromise, preferenceHintsPromise]);

  if (successCount === 0) {
    await readyScan.scanRef.update({
      status: 'failed',
      errorMessage: 'All actor runs failed to start',
      completedAt: FieldValue.serverTimestamp(),
    });
    await clearBrandActiveScanIfMatches(readyScan.brandRef, readyScan.scanRef.id);
    throw new ScanStartError('Failed to start any actor runs', 500);
  }

  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(readyScan.scanRef);
    if (!freshSnap.exists) return;

    const fresh = scanFromSnapshot(freshSnap);
    if (fresh.status !== 'pending') return;

    tx.update(readyScan.scanRef, {
      status: 'running',
    });
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

async function replayDeferredSucceededCallbacks(params: {
  scanRef: DocumentReference;
  webhookUrl: string;
}) {
  const { scanRef, webhookUrl } = params;
  const scanSnap = await scanRef.get();
  if (!scanSnap.exists) return;

  const scan = scanFromSnapshot(scanSnap);
  const waitingRuns = Object.entries(scan.actorRuns ?? {})
    .filter(([, run]) => run.status === 'waiting_for_preference_hints' && typeof run.datasetId === 'string' && run.datasetId.length > 0);

  if (waitingRuns.length === 0) return;

  const webhookSecret = process.env.APIFY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('APIFY_WEBHOOK_SECRET is not set');
  }

  for (const [runId, run] of waitingRuns) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Apify-Webhook-Secret': webhookSecret,
      },
      body: JSON.stringify({
        eventType: 'ACTOR.RUN.SUCCEEDED',
        eventData: {
          actorId: run.actorId,
          actorRunId: runId,
          status: 'SUCCEEDED',
        },
        resource: {
          id: runId,
          status: 'SUCCEEDED',
          defaultDatasetId: run.datasetId,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Deferred webhook replay failed for run ${runId}: ${response.status} ${body}`);
    }
  }
}
