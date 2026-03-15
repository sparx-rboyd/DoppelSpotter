import { FieldValue, type DocumentReference } from '@google-cloud/firestore';
import { db } from './firestore';
import type {
  BrandProfile,
  EffectiveScanSettings,
  QueuedActorRunInfo,
  Scan,
  ScanSettingsInput,
} from './types';
import type { ActorConfig } from './apify/actors';
import { resolveBrandAnalysisSeverityDefinitions } from './analysis-severity';
import {
  buildQueuedActorRunInfo,
  hasQueuedActorLaunchWork,
} from './apify/live-run-cap';
import {
  clearScanApifyThrottleState,
  drainQueuedActorRunsIfCapacity,
  type ScanDocHandle,
} from './apify/launch-queue';
import { isBrandDeletionActive, isBrandHistoryDeletionActive } from './async-deletions';
import { getEffectiveScanSettings } from './brands';
import { DASHBOARD_SCAN_BREAKDOWNS_VERSION } from './dashboard';
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
  ownerUserId?: string;
  scheduled?: ScheduledStartOptions;
  customSettings?: ScanSettingsInput;
};

type ScheduledScanSkipReason = 'not_due' | 'active_scan' | 'deletion_in_progress';

export type StartScanForBrandResult =
  | {
      outcome: 'started';
      scanId: string;
      status: 'running';
      actorCount: number;
      scan: Scan;
    }
  | {
      outcome: 'skipped';
      reason: ScheduledScanSkipReason;
      activeScan?: Scan;
    };

type PreparedScanStart = {
  brand: BrandProfile;
  effectiveSettings: EffectiveScanSettings;
  brandRef: DocumentReference;
  scanRef: DocumentReference;
  targetActors: ActorConfig[];
};

export async function startScanForBrand(params: StartScanForBrandParams): Promise<StartScanForBrandResult> {
  const { getTargetActorConfigs } = await import('@/lib/apify/actors');
  const { buildActorInputs } = await import('@/lib/apify/client');
  const brandRef = db.collection('brands').doc(params.brandId);
  const scanRef = db.collection('scans').doc();
  const now = params.scheduled?.dispatchedAt ?? new Date();

  let preparedScan: PreparedScanStart | null = null;
  let scheduledSkipResult: StartScanForBrandResult | null = null;

  // Pre-transaction: find the last completed scan so we can resolve 'since_last_scan' lookback date.
  // Done outside the transaction because Firestore transactions cannot contain non-transactional reads.
  let lastScanCompletedAt: Date | undefined;
  try {
    const lastScanSnapshot = await db
      .collection('scans')
      .where('brandId', '==', params.brandId)
      .where('status', '==', 'completed')
      .orderBy('completedAt', 'desc')
      .limit(1)
      .select('completedAt')
      .get();
    if (!lastScanSnapshot.empty) {
      const completedAt = lastScanSnapshot.docs[0].data().completedAt;
      lastScanCompletedAt = completedAt?.toDate?.() ?? undefined;
    }
  } catch (error) {
    console.error(`[scan] Failed to query last completed scan for brand ${params.brandId}:`, error);
  }

  const scan: Omit<Scan, 'id'> = {
    brandId: params.brandId,
    userId: '',
    status: 'pending',
    actorIds: [],
    actorRunIds: [],
    actorRuns: {},
    queuedActorRuns: [],
    launchingActorRuns: {},
    completedRunCount: 0,
    findingCount: 0,
    addressedCount: 0,
    skippedCount: 0,
    dashboardBreakdowns: {
      version: DASHBOARD_SCAN_BREAKDOWNS_VERSION,
      source: [],
      theme: [],
    },
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

    if (isBrandDeletionActive(brandData) || isBrandHistoryDeletionActive(brandData)) {
      if (params.scheduled && brandData.scanSchedule) {
        tx.update(brandRef, {
          'scanSchedule.nextRunAt': computeNextScheduledRun(brandData.scanSchedule, now),
        });
        scheduledSkipResult = {
          outcome: 'skipped',
          reason: 'deletion_in_progress',
        };
        throw new ScheduledScanSkipError('deletion_in_progress');
      }

      throw new ScanStartError('Cannot start a scan while deletion is in progress for this brand', 409);
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
    const effectiveSettings = getEffectiveScanSettings(brandData, params.customSettings, lastScanCompletedAt);
    const targetActors = getTargetActorConfigs(effectiveSettings.scanSources);
    if (targetActors.length === 0) {
      throw new ScanStartError('At least one scan source must be enabled', 400);
    }
    scan.effectiveSettings = effectiveSettings;
    scan.analysisSeverityDefinitions = resolveBrandAnalysisSeverityDefinitions(brandData.analysisSeverityDefinitions);
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
      effectiveSettings,
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
  const queuedActorRuns: QueuedActorRunInfo[] = [];
  for (const actorConfig of readyScan.targetActors) {
    try {
      const preparedInputs = buildActorInputs(
        actorConfig,
        readyScan.brand,
        readyScan.effectiveSettings,
      );
      for (const preparedInput of preparedInputs) {
        queuedActorRuns.push(buildQueuedActorRunInfo(actorConfig, preparedInput, 0));
      }
    } catch (error) {
      console.error(`[scan] Failed to prepare scanner ${actorConfig.id}:`, error);
    }
  }

  if (queuedActorRuns.length === 0) {
    await readyScan.scanRef.update({
      status: 'failed',
      errorMessage: 'Failed to prepare any actor runs',
      completedAt: FieldValue.serverTimestamp(),
    });
    await clearBrandActiveScanIfMatches(readyScan.brandRef, readyScan.scanRef.id);
    throw new ScanStartError('Failed to prepare any actor runs', 500);
  }

  await readyScan.scanRef.update({
    status: 'running',
    queuedActorRuns,
  });

  const startedScanSnap = await readyScan.scanRef.get();
  if (!startedScanSnap.exists) {
    throw new ScanStartError('Scan disappeared before startup could begin', 500);
  }
  const startedScan = scanFromSnapshot(startedScanSnap);

  return {
    outcome: 'started',
    scanId: readyScan.scanRef.id,
    status: 'running',
    actorCount: queuedActorRuns.length,
    scan: startedScan,
  };
}

export async function kickoffReservedScan(params: {
  scanId: string;
  webhookUrl: string;
}): Promise<void> {
  const { scanId, webhookUrl } = params;
  const { getTargetActorConfigs } = await import('@/lib/apify/actors');
  const { prepareUserPreferenceHintsForScan } = await import('@/lib/analysis/user-preference-hints');
  const scanRef = db.collection('scans').doc(scanId);
  const initialScanSnap = await scanRef.get();
  if (!initialScanSnap.exists) return;

  const initialScan = scanFromSnapshot(initialScanSnap);
  if (
    initialScan.status === 'cancelled'
    || initialScan.status === 'failed'
    || initialScan.status === 'completed'
    || initialScan.status === 'summarising'
  ) {
    return;
  }

  const brandRef = db.collection('brands').doc(initialScan.brandId);
  const brandSnap = await brandRef.get();
  if (!brandSnap.exists) {
    await scanRef.update({
      status: 'failed',
      errorMessage: 'Brand not found while starting scan',
      completedAt: FieldValue.serverTimestamp(),
    });
    await clearBrandActiveScanIfMatches(brandRef, scanId);
    return;
  }

  const brand = brandSnap.data() as BrandProfile;
  const targetSources = Array.from(
    new Set(
      getTargetActorConfigs(initialScan.effectiveSettings?.scanSources)
        .map((actor) => actor.source),
    ),
  );
  const scanDoc: ScanDocHandle = { id: scanId, ref: scanRef };

  const preferenceHintsPromise = (async () => {
    await prepareUserPreferenceHintsForScan({
      scanRef,
      brandId: initialScan.brandId,
      brandName: brand.name,
      userId: initialScan.userId,
      targetSources,
    });

    try {
      await replayDeferredSucceededCallbacks({
        scanRef,
        webhookUrl,
      });
    } catch (error) {
      console.error(`[scan] Failed to drain deferred succeeded runs for scan ${scanId}:`, error);
    }
  })();

  const [launchedCount] = await Promise.all([
    drainQueuedActorRunsIfCapacity(scanDoc, webhookUrl),
    preferenceHintsPromise,
  ]);

  const freshScanSnap = await scanRef.get();
  if (!freshScanSnap.exists) return;

  const freshScan = scanFromSnapshot(freshScanSnap);
  if (
    freshScan.status === 'cancelled'
    || freshScan.status === 'failed'
    || freshScan.status === 'completed'
    || freshScan.status === 'summarising'
  ) {
    return;
  }

  if ((freshScan.actorRunIds?.length ?? 0) > 0 || hasQueuedActorLaunchWork(freshScan)) {
    if (launchedCount > 0) {
      console.log(`[scan] Started ${launchedCount} initial actor run(s) for scan ${scanId}`);
    }
    return;
  }

  await clearScanApifyThrottleState(scanRef);
  await scanRef.update({
    status: 'failed',
    errorMessage: 'All actor runs failed to start',
    completedAt: FieldValue.serverTimestamp(),
  });
  await clearBrandActiveScanIfMatches(brandRef, scanId);
  console.error(`[scan] Failed to start any initial actor runs for scan ${scanId}`);
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
