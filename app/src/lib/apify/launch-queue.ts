import { randomUUID } from 'node:crypto';
import { FieldValue, type DocumentReference } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';
import type { ActorRunInfo, QueuedActorRunInfo, Scan } from '@/lib/types';
import { getActorConfigByScannerId } from './actors';
import { startPreparedActorRun } from './client';
import {
  buildActorRunInfoFromQueuedRun,
  buildPreparedActorInputFromQueuedRun,
  getApifyMaxLiveRunsPerScan,
  getLiveActorRunCount,
} from './live-run-cap';

export type ScanDocHandle = {
  id: string;
  ref: DocumentReference;
};

const APIFY_THROTTLE_ACTIVE_LAUNCH_IDS_FIELD = 'apifyThrottle.activeLaunchIds';

export async function markScanApifyThrottleLaunchState(params: {
  scanRef: DocumentReference;
  launchId: string;
  active: boolean;
}): Promise<void> {
  const { scanRef, launchId, active } = params;
  await scanRef.update({
    [APIFY_THROTTLE_ACTIVE_LAUNCH_IDS_FIELD]: active
      ? FieldValue.arrayUnion(launchId)
      : FieldValue.arrayRemove(launchId),
  });
}

export async function clearScanApifyThrottleState(scanRef: DocumentReference): Promise<void> {
  await scanRef.update({
    [APIFY_THROTTLE_ACTIVE_LAUNCH_IDS_FIELD]: [],
  });
}

export async function reserveQueuedActorRunsForLaunch(
  scanRef: DocumentReference,
): Promise<Array<{ reservationId: string; queuedRun: QueuedActorRunInfo }>> {
  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(scanRef);
    if (!freshSnap.exists) return [];

    const fresh = freshSnap.data() as Scan;
    if (fresh.status === 'cancelled' || fresh.status === 'failed' || fresh.status === 'completed') {
      return [];
    }

    const queuedRuns = fresh.queuedActorRuns ?? [];
    if (queuedRuns.length === 0) {
      return [];
    }

    const availableSlots = getApifyMaxLiveRunsPerScan() - getLiveActorRunCount(fresh);
    if (availableSlots <= 0) {
      return [];
    }

    const selectedRuns = queuedRuns.slice(0, availableSlots);
    if (selectedRuns.length === 0) {
      return [];
    }

    const reservations = selectedRuns.map((queuedRun) => ({
      reservationId: randomUUID(),
      queuedRun,
    }));
    const updates: Record<string, unknown> = {
      queuedActorRuns: queuedRuns.slice(selectedRuns.length),
    };
    for (const reservation of reservations) {
      updates[`launchingActorRuns.${reservation.reservationId}`] = reservation.queuedRun;
    }

    tx.update(scanRef, updates);
    return reservations;
  });
}

export async function settleQueuedActorLaunchReservation(
  scanRef: DocumentReference,
  reservationId: string,
  result?: {
    runId: string;
    info: ActorRunInfo;
  },
) {
  const updates: Record<string, unknown> = {
    [`launchingActorRuns.${reservationId}`]: FieldValue.delete(),
  };

  if (result) {
    updates.actorRunIds = FieldValue.arrayUnion(result.runId);
    updates[`actorRuns.${result.runId}`] = result.info;
  }

  await scanRef.update(updates);
}

export async function launchQueuedActorRunsIfCapacity(params: {
  scanDoc: ScanDocHandle;
  effectiveSettings: NonNullable<Scan['effectiveSettings']>;
  webhookUrl: string;
}): Promise<number> {
  const { scanDoc, effectiveSettings, webhookUrl } = params;
  let launchedCount = 0;

  while (true) {
    const reservations = await reserveQueuedActorRunsForLaunch(scanDoc.ref);
    if (reservations.length === 0) {
      return launchedCount;
    }

    for (const reservation of reservations) {
      try {
        const startedRun = await startPreparedActorRun(
          getActorConfigByScannerId(reservation.queuedRun.scannerId),
          buildPreparedActorInputFromQueuedRun(reservation.queuedRun),
          effectiveSettings,
          webhookUrl,
          {
            onBackoffStart: async () => {
              await markScanApifyThrottleLaunchState({
                scanRef: scanDoc.ref,
                launchId: reservation.queuedRun.launchId,
                active: true,
              });
            },
            onBackoffEnd: async () => {
              await markScanApifyThrottleLaunchState({
                scanRef: scanDoc.ref,
                launchId: reservation.queuedRun.launchId,
                active: false,
              });
            },
          },
        );
        await settleQueuedActorLaunchReservation(scanDoc.ref, reservation.reservationId, {
          runId: startedRun.runId,
          info: buildActorRunInfoFromQueuedRun(reservation.queuedRun, startedRun),
        });
        launchedCount += 1;
      } catch (error) {
        console.error(`[apify] Failed to start queued actor run "${reservation.queuedRun.displayQuery}":`, error);
        await settleQueuedActorLaunchReservation(scanDoc.ref, reservation.reservationId);
      }
    }
  }
}

export async function drainQueuedActorRunsIfCapacity(
  scanDoc: ScanDocHandle,
  webhookUrl: string,
): Promise<number> {
  const freshScanSnap = await scanDoc.ref.get();
  if (!freshScanSnap.exists) {
    return 0;
  }

  const freshScan = freshScanSnap.data() as Scan;
  if (!freshScan.effectiveSettings) {
    console.warn(`[apify] Cannot launch queued actor runs for scan ${scanDoc.id} because effectiveSettings are missing`);
    return 0;
  }

  return launchQueuedActorRunsIfCapacity({
    scanDoc,
    effectiveSettings: freshScan.effectiveSettings,
    webhookUrl,
  });
}
