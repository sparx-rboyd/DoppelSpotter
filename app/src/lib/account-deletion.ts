import { FieldValue } from '@google-cloud/firestore';
import { abortActorRun } from '@/lib/apify/client';
import { db } from '@/lib/firestore';
import { runWriteBatchInChunks, SAFE_FIRESTORE_WRITE_BATCH_LIMIT } from '@/lib/firestore-batches';
import { scanFromSnapshot } from '@/lib/scans';
import type { BrandProfile, UserRecord } from '@/lib/types';

const ACCOUNT_DELETION_BATCH_LIMIT = SAFE_FIRESTORE_WRITE_BATCH_LIMIT;

async function cancelInProgressScansForUser(userId: string): Promise<{ cancelledScanCount: number; runIds: string[] }> {
  let cancelledScanCount = 0;
  const runIds = new Set<string>();

  while (true) {
    const scansSnapshot = await db
      .collection('scans')
      .where('userId', '==', userId)
      .where('status', 'in', ['pending', 'running', 'summarising'])
      .limit(ACCOUNT_DELETION_BATCH_LIMIT)
      .get();

    if (scansSnapshot.empty) {
      return { cancelledScanCount, runIds: [...runIds] };
    }

    const scans = scansSnapshot.docs.map((doc) => scanFromSnapshot(doc));
    const brandSnapshots = await Promise.all(
      [...new Set(scans.map((scan) => scan.brandId))].map((brandId) => db.collection('brands').doc(brandId).get()),
    );
    const brandsById = new Map(
      brandSnapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => [snapshot.id, snapshot.data() as BrandProfile]),
    );

    await runWriteBatchInChunks(scans, (batch, scan) => {
      batch.update(db.collection('scans').doc(scan.id), {
        status: 'cancelled',
        completedAt: FieldValue.serverTimestamp(),
      });

      const brand = brandsById.get(scan.brandId);
      if (brand?.activeScanId === scan.id) {
        batch.update(db.collection('brands').doc(scan.brandId), {
          activeScanId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }, ACCOUNT_DELETION_BATCH_LIMIT);

    scans.forEach((scan) => {
      cancelledScanCount += 1;
      (scan.actorRunIds ?? []).forEach((runId) => runIds.add(runId));
    });
  }
}

async function abortActorRuns(runIds: string[]) {
  const abortResults = await Promise.allSettled(runIds.map((runId) => abortActorRun(runId)));
  abortResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn(`[account-delete] Failed to abort run ${runIds[index]}:`, result.reason);
    }
  });
}

async function deleteUserOwnedCollection(collectionName: 'findings' | 'scans' | 'brands', userId: string) {
  while (true) {
    const snapshot = await db
      .collection(collectionName)
      .where('userId', '==', userId)
      .limit(ACCOUNT_DELETION_BATCH_LIMIT)
      .get();

    if (snapshot.empty) {
      return;
    }

    await runWriteBatchInChunks(snapshot.docs, (batch, doc) => batch.delete(doc.ref), ACCOUNT_DELETION_BATCH_LIMIT);
  }
}

async function scrubInviteCodeUsageForUser(userId: string, email: string) {
  const normalizedEmail = email.trim().toLowerCase();

  while (true) {
    const snapshot = await db
      .collection('inviteCodes')
      .where('usedByUserId', '==', userId)
      .limit(ACCOUNT_DELETION_BATCH_LIMIT)
      .get();

    if (snapshot.empty) break;

    await runWriteBatchInChunks(snapshot.docs, (batch, doc) => {
      batch.update(doc.ref, {
        usedByUserId: FieldValue.delete(),
        usedByEmail: FieldValue.delete(),
      });
    }, ACCOUNT_DELETION_BATCH_LIMIT);
  }

  while (true) {
    const snapshot = await db
      .collection('inviteCodes')
      .where('usedByEmail', '==', normalizedEmail)
      .limit(ACCOUNT_DELETION_BATCH_LIMIT)
      .get();

    if (snapshot.empty) break;

    await runWriteBatchInChunks(snapshot.docs, (batch, doc) => {
      batch.update(doc.ref, {
        usedByEmail: FieldValue.delete(),
      });
    }, ACCOUNT_DELETION_BATCH_LIMIT);
  }
}

export async function deleteAccountAndOwnedData(userId: string): Promise<{ cancelledScanCount: number; abortedRunCount: number }> {
  const userRef = db.collection('users').doc(userId);
  const userSnapshot = await userRef.get();
  if (!userSnapshot.exists) {
    return { cancelledScanCount: 0, abortedRunCount: 0 };
  }

  const user = userSnapshot.data() as Pick<UserRecord, 'email'>;
  const { cancelledScanCount, runIds } = await cancelInProgressScansForUser(userId);

  if (runIds.length > 0) {
    await abortActorRuns(runIds);
  }

  await deleteUserOwnedCollection('findings', userId);
  await deleteUserOwnedCollection('scans', userId);
  await deleteUserOwnedCollection('brands', userId);
  await scrubInviteCodeUsageForUser(userId, user.email);
  await userRef.delete();

  return {
    cancelledScanCount,
    abortedRunCount: runIds.length,
  };
}
