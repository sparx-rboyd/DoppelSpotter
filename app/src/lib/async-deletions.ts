import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { abortActorRun } from '@/lib/apify/client';
import { db } from '@/lib/firestore';
import { runWriteBatchInChunks } from '@/lib/firestore-batches';
import { isScanInProgress, scanFromSnapshot } from '@/lib/scans';
import type { AsyncDeletionState, BrandProfile, Scan, UserRecord } from '@/lib/types';

const DELETION_BATCH_LIMIT = 50;
const DELETION_LEASE_MS = 60_000;
const DEFAULT_DRAIN_BUDGET_MS = 8_000;
const ACCOUNT_DELETION_ABORT_CONCURRENCY = 5;
const ACCOUNT_DELETION_PENDING_ABORTS_PATH = 'accountDeletion.pendingRunAborts';

type DeletionPassResult = 'idle' | 'busy' | 'progress' | 'complete';
type BrandDeletionField = 'historyDeletion' | 'brandDeletion';
type ScopedDeletionField = BrandDeletionField | 'deletion' | 'accountDeletion';
type AccountDeletionState = AsyncDeletionState & { pendingRunAborts?: string[] };

function getActiveDeletionState(
  value: unknown,
): AsyncDeletionState | null {
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Partial<AsyncDeletionState>;
  if (candidate.status !== 'queued' && candidate.status !== 'running') {
    return null;
  }

  return candidate as AsyncDeletionState;
}

function getDeletionLeasePath(field: ScopedDeletionField) {
  return `${field}.leaseExpiresAt`;
}

function getDeletionStatusPath(field: ScopedDeletionField) {
  return `${field}.status`;
}

function getDeletionStartedAtPath(field: ScopedDeletionField) {
  return `${field}.startedAt`;
}

function getDeletionHeartbeatPath(field: ScopedDeletionField) {
  return `${field}.lastHeartbeatAt`;
}

export function isDeletionActive(value: unknown): value is AsyncDeletionState {
  return getActiveDeletionState(value) !== null;
}

export function isBrandHistoryDeletionActive(brand?: Pick<BrandProfile, 'historyDeletion'> | null): boolean {
  return isDeletionActive(brand?.historyDeletion);
}

export function isBrandDeletionActive(brand?: Pick<BrandProfile, 'brandDeletion'> | null): boolean {
  return isDeletionActive(brand?.brandDeletion);
}

export function isScanDeletionActive(scan?: Pick<Scan, 'deletion'> | null): boolean {
  return isDeletionActive(scan?.deletion);
}

export function isAccountDeletionActive(user?: Pick<UserRecord, 'accountDeletion'> | null): boolean {
  return isDeletionActive(user?.accountDeletion);
}

export async function markBrandHistoryDeletionQueued(brandId: string) {
  await db.collection('brands').doc(brandId).set({
    historyDeletion: {
      status: 'queued',
      requestedAt: FieldValue.serverTimestamp(),
      lastHeartbeatAt: FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function markBrandDeletionQueued(brandId: string) {
  await db.collection('brands').doc(brandId).set({
    brandDeletion: {
      status: 'queued',
      requestedAt: FieldValue.serverTimestamp(),
      lastHeartbeatAt: FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function markScanDeletionQueued(scanId: string) {
  await db.collection('scans').doc(scanId).set({
    deletion: {
      status: 'queued',
      requestedAt: FieldValue.serverTimestamp(),
      lastHeartbeatAt: FieldValue.serverTimestamp(),
    },
  }, { merge: true });
}

export async function markAccountDeletionQueued(userId: string) {
  await db.collection('users').doc(userId).set({
    accountDeletion: {
      status: 'queued',
      requestedAt: FieldValue.serverTimestamp(),
      lastHeartbeatAt: FieldValue.serverTimestamp(),
    },
  }, { merge: true });
}

async function tryAcquireDeletionLease(docPath: string, field: ScopedDeletionField): Promise<boolean> {
  const ref = db.doc(docPath);
  const leaseUntil = Timestamp.fromMillis(Date.now() + DELETION_LEASE_MS);
  let acquired = false;

  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return;

    const data = snapshot.data() as Record<string, unknown>;
    const state = getActiveDeletionState(data[field]);
    if (!state) return;

    if (state.leaseExpiresAt && state.leaseExpiresAt.toMillis() > Date.now()) {
      return;
    }

    tx.update(ref, {
      [getDeletionStatusPath(field)]: 'running',
      [getDeletionStartedAtPath(field)]: state.startedAt ?? FieldValue.serverTimestamp(),
      [getDeletionHeartbeatPath(field)]: FieldValue.serverTimestamp(),
      [getDeletionLeasePath(field)]: leaseUntil,
    });
    acquired = true;
  });

  return acquired;
}

async function releaseDeletionLease(docPath: string, field: ScopedDeletionField) {
  const ref = db.doc(docPath);
  const snapshot = await ref.get();
  if (!snapshot.exists) return;

  const data = snapshot.data() as Record<string, unknown>;
  if (!getActiveDeletionState(data[field])) return;

  await ref.update({
    [getDeletionStatusPath(field)]: 'queued',
    [getDeletionHeartbeatPath(field)]: FieldValue.serverTimestamp(),
    [getDeletionLeasePath(field)]: FieldValue.delete(),
  });
}

async function clearDeletionState(docPath: string, field: ScopedDeletionField) {
  const ref = db.doc(docPath);
  const snapshot = await ref.get();
  if (!snapshot.exists) return;

  const data = snapshot.data() as Record<string, unknown>;
  if (!getActiveDeletionState(data[field])) return;

  await ref.update({
    [field]: FieldValue.delete(),
    ...(
      field === 'historyDeletion' || field === 'brandDeletion'
        ? { updatedAt: FieldValue.serverTimestamp() }
        : {}
    ),
  });
}

function getPendingAccountRunAborts(user?: Pick<UserRecord, 'accountDeletion'> | null): string[] {
  const pendingRunAborts = (user?.accountDeletion as AccountDeletionState | undefined)?.pendingRunAborts;
  if (!Array.isArray(pendingRunAborts)) return [];

  return [...new Set(pendingRunAborts.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

async function abortActorRunsWithConcurrency(runIds: string[]) {
  const queue = [...runIds];
  const workerCount = Math.min(ACCOUNT_DELETION_ABORT_CONCURRENCY, queue.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const runId = queue.shift();
      if (!runId) return;

      try {
        await abortActorRun(runId);
      } catch (error) {
        console.warn(`[account-delete] Failed to abort run ${runId}:`, error);
      }
    }
  }));
}

export async function loadDeletingScanIdsForBrand(params: {
  brandId: string;
  userId: string;
}): Promise<string[]> {
  const { brandId, userId } = params;
  const snapshot = await db
    .collection('scans')
    .where('brandId', '==', brandId)
    .where('userId', '==', userId)
    .select('deletion')
    .get();

  return snapshot.docs
    .filter((doc) => isDeletionActive((doc.data() as Pick<Scan, 'deletion'>).deletion))
    .map((doc) => doc.id);
}

export async function processScanDeletionPass(params: {
  brandId: string;
  scanId: string;
  userId: string;
}): Promise<DeletionPassResult> {
  const { brandId, scanId, userId } = params;
  const scanPath = `scans/${scanId}`;
  const scanRef = db.collection('scans').doc(scanId);
  const acquired = await tryAcquireDeletionLease(scanPath, 'deletion');
  if (!acquired) return 'busy';

  try {
    const scanSnapshot = await scanRef.get();
    if (!scanSnapshot.exists) return 'complete';

    const scan = scanFromSnapshot(scanSnapshot);
    if (scan.brandId !== brandId || scan.userId !== userId || !isScanDeletionActive(scan)) {
      return 'idle';
    }

    const findingsSnapshot = await db
      .collection('findings')
      .where('scanId', '==', scanId)
      .where('userId', '==', userId)
      .select()
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!findingsSnapshot.empty) {
      await runWriteBatchInChunks(findingsSnapshot.docs, (batch, doc) => batch.delete(doc.ref), DELETION_BATCH_LIMIT);
      await releaseDeletionLease(scanPath, 'deletion');
      return 'progress';
    }

    await scanRef.delete();
    return 'complete';
  } catch (error) {
    await releaseDeletionLease(scanPath, 'deletion');
    throw error;
  }
}

export async function processBrandHistoryDeletionPass(params: {
  brandId: string;
  userId: string;
}): Promise<DeletionPassResult> {
  const { brandId, userId } = params;
  const brandPath = `brands/${brandId}`;
  const brandRef = db.collection('brands').doc(brandId);
  const acquired = await tryAcquireDeletionLease(brandPath, 'historyDeletion');
  if (!acquired) return 'busy';

  try {
    const brandSnapshot = await brandRef.get();
    if (!brandSnapshot.exists) return 'complete';

    const brand = brandSnapshot.data() as BrandProfile;
    if (brand.userId !== userId || !isBrandHistoryDeletionActive(brand)) {
      return 'idle';
    }

    const findingsSnapshot = await db
      .collection('findings')
      .where('brandId', '==', brandId)
      .where('userId', '==', userId)
      .select()
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!findingsSnapshot.empty) {
      await runWriteBatchInChunks(findingsSnapshot.docs, (batch, doc) => batch.delete(doc.ref), DELETION_BATCH_LIMIT);
      await releaseDeletionLease(brandPath, 'historyDeletion');
      return 'progress';
    }

    const scansSnapshot = await db
      .collection('scans')
      .where('brandId', '==', brandId)
      .where('userId', '==', userId)
      .select()
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!scansSnapshot.empty) {
      await runWriteBatchInChunks(scansSnapshot.docs, (batch, doc) => batch.delete(doc.ref), DELETION_BATCH_LIMIT);
      await releaseDeletionLease(brandPath, 'historyDeletion');
      return 'progress';
    }

    await clearDeletionState(brandPath, 'historyDeletion');
    return 'complete';
  } catch (error) {
    await releaseDeletionLease(brandPath, 'historyDeletion');
    throw error;
  }
}

export async function processBrandDeletionPass(params: {
  brandId: string;
  userId: string;
}): Promise<DeletionPassResult> {
  const { brandId, userId } = params;
  const brandPath = `brands/${brandId}`;
  const brandRef = db.collection('brands').doc(brandId);
  const acquired = await tryAcquireDeletionLease(brandPath, 'brandDeletion');
  if (!acquired) return 'busy';

  try {
    const brandSnapshot = await brandRef.get();
    if (!brandSnapshot.exists) return 'complete';

    const brand = brandSnapshot.data() as BrandProfile;
    if (brand.userId !== userId || !isBrandDeletionActive(brand)) {
      return 'idle';
    }

    const findingsSnapshot = await db
      .collection('findings')
      .where('brandId', '==', brandId)
      .where('userId', '==', userId)
      .select()
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!findingsSnapshot.empty) {
      await runWriteBatchInChunks(findingsSnapshot.docs, (batch, doc) => batch.delete(doc.ref), DELETION_BATCH_LIMIT);
      await releaseDeletionLease(brandPath, 'brandDeletion');
      return 'progress';
    }

    const scansSnapshot = await db
      .collection('scans')
      .where('brandId', '==', brandId)
      .where('userId', '==', userId)
      .select('status')
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!scansSnapshot.empty) {
      const inProgressScan = scansSnapshot.docs
        .map(scanFromSnapshot)
        .find((scan) => isScanInProgress(scan.status));

      if (inProgressScan) {
        throw new Error(`Cannot delete brand ${brandId} while scan ${inProgressScan.id} is still in progress`);
      }

      await runWriteBatchInChunks(scansSnapshot.docs, (batch, doc) => batch.delete(doc.ref), DELETION_BATCH_LIMIT);
      await releaseDeletionLease(brandPath, 'brandDeletion');
      return 'progress';
    }

    await brandRef.delete();
    return 'complete';
  } catch (error) {
    await releaseDeletionLease(brandPath, 'brandDeletion');
    throw error;
  }
}

export async function processAccountDeletionPass(params: {
  userId: string;
}): Promise<DeletionPassResult> {
  const { userId } = params;
  const userPath = `users/${userId}`;
  const userRef = db.collection('users').doc(userId);
  const acquired = await tryAcquireDeletionLease(userPath, 'accountDeletion');
  if (!acquired) return 'busy';

  try {
    const userSnapshot = await userRef.get();
    if (!userSnapshot.exists) return 'complete';

    const user = userSnapshot.data() as UserRecord;
    if (!isAccountDeletionActive(user)) {
      return 'idle';
    }

    const pendingRunAborts = getPendingAccountRunAborts(user);
    if (pendingRunAborts.length > 0) {
      await abortActorRunsWithConcurrency(pendingRunAborts);
      await userRef.update({
        [ACCOUNT_DELETION_PENDING_ABORTS_PATH]: FieldValue.delete(),
        'accountDeletion.lastHeartbeatAt': FieldValue.serverTimestamp(),
      });
      await releaseDeletionLease(userPath, 'accountDeletion');
      return 'progress';
    }

    const activeScansSnapshot = await db
      .collection('scans')
      .where('userId', '==', userId)
      .where('status', 'in', ['pending', 'running', 'summarising'])
      .select('brandId', 'actorRunIds')
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!activeScansSnapshot.empty) {
      const brandIds = [...new Set(activeScansSnapshot.docs
        .map((doc) => (doc.data() as Pick<Scan, 'brandId'>).brandId)
        .filter((brandId): brandId is string => typeof brandId === 'string' && brandId.length > 0))];
      const brandSnapshots = await Promise.all(brandIds.map((brandId) => db.collection('brands').doc(brandId).get()));
      const activeScanByBrandId = new Map(
        brandSnapshots
          .filter((snapshot) => snapshot.exists)
          .map((snapshot) => [snapshot.id, (snapshot.data() as Pick<BrandProfile, 'activeScanId'>).activeScanId]),
      );
      const runIds = new Set<string>();

      await runWriteBatchInChunks(activeScansSnapshot.docs, (batch, doc) => {
        const scan = doc.data() as Pick<Scan, 'brandId' | 'actorRunIds'>;
        batch.update(doc.ref, {
          status: 'cancelled',
          completedAt: FieldValue.serverTimestamp(),
        });

        if (activeScanByBrandId.get(scan.brandId) === doc.id) {
          batch.update(db.collection('brands').doc(scan.brandId), {
            activeScanId: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        (scan.actorRunIds ?? []).forEach((runId) => {
          if (typeof runId === 'string' && runId.length > 0) {
            runIds.add(runId);
          }
        });
      }, DELETION_BATCH_LIMIT);

      if (runIds.size > 0) {
        await userRef.update({
          [ACCOUNT_DELETION_PENDING_ABORTS_PATH]: [...runIds],
          'accountDeletion.lastHeartbeatAt': FieldValue.serverTimestamp(),
        });
      }

      await releaseDeletionLease(userPath, 'accountDeletion');
      return 'progress';
    }

    const findingsSnapshot = await db
      .collection('findings')
      .where('userId', '==', userId)
      .select()
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!findingsSnapshot.empty) {
      await runWriteBatchInChunks(findingsSnapshot.docs, (batch, doc) => batch.delete(doc.ref), DELETION_BATCH_LIMIT);
      await releaseDeletionLease(userPath, 'accountDeletion');
      return 'progress';
    }

    const scansSnapshot = await db
      .collection('scans')
      .where('userId', '==', userId)
      .select()
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!scansSnapshot.empty) {
      await runWriteBatchInChunks(scansSnapshot.docs, (batch, doc) => batch.delete(doc.ref), DELETION_BATCH_LIMIT);
      await releaseDeletionLease(userPath, 'accountDeletion');
      return 'progress';
    }

    const brandsSnapshot = await db
      .collection('brands')
      .where('userId', '==', userId)
      .select()
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!brandsSnapshot.empty) {
      await runWriteBatchInChunks(brandsSnapshot.docs, (batch, doc) => batch.delete(doc.ref), DELETION_BATCH_LIMIT);
      await releaseDeletionLease(userPath, 'accountDeletion');
      return 'progress';
    }

    const inviteCodesByUserSnapshot = await db
      .collection('inviteCodes')
      .where('usedByUserId', '==', userId)
      .limit(DELETION_BATCH_LIMIT)
      .get();

    if (!inviteCodesByUserSnapshot.empty) {
      await runWriteBatchInChunks(inviteCodesByUserSnapshot.docs, (batch, doc) => {
        batch.update(doc.ref, {
          usedByUserId: FieldValue.delete(),
          usedByEmail: FieldValue.delete(),
        });
      }, DELETION_BATCH_LIMIT);
      await releaseDeletionLease(userPath, 'accountDeletion');
      return 'progress';
    }

    const normalizedEmail = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
    if (normalizedEmail) {
      const inviteCodesByEmailSnapshot = await db
        .collection('inviteCodes')
        .where('usedByEmail', '==', normalizedEmail)
        .limit(DELETION_BATCH_LIMIT)
        .get();

      if (!inviteCodesByEmailSnapshot.empty) {
        await runWriteBatchInChunks(inviteCodesByEmailSnapshot.docs, (batch, doc) => {
          batch.update(doc.ref, {
            usedByEmail: FieldValue.delete(),
          });
        }, DELETION_BATCH_LIMIT);
        await releaseDeletionLease(userPath, 'accountDeletion');
        return 'progress';
      }
    }

    await userRef.delete();
    return 'complete';
  } catch (error) {
    await releaseDeletionLease(userPath, 'accountDeletion');
    throw error;
  }
}

async function drainDeletion(
  runPass: () => Promise<DeletionPassResult>,
  budgetMs: number,
) {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    const result = await runPass();
    if (result !== 'progress') {
      return result;
    }
  }

  return 'progress' as const;
}

export async function drainScanDeletion(params: {
  brandId: string;
  scanId: string;
  userId: string;
  budgetMs?: number;
}) {
  const { budgetMs = DEFAULT_DRAIN_BUDGET_MS, ...rest } = params;
  return drainDeletion(() => processScanDeletionPass(rest), budgetMs);
}

export async function drainBrandHistoryDeletion(params: {
  brandId: string;
  userId: string;
  budgetMs?: number;
}) {
  const { budgetMs = DEFAULT_DRAIN_BUDGET_MS, ...rest } = params;
  return drainDeletion(() => processBrandHistoryDeletionPass(rest), budgetMs);
}

export async function drainBrandDeletion(params: {
  brandId: string;
  userId: string;
  budgetMs?: number;
}) {
  const { budgetMs = DEFAULT_DRAIN_BUDGET_MS, ...rest } = params;
  return drainDeletion(() => processBrandDeletionPass(rest), budgetMs);
}

export async function drainAccountDeletion(params: {
  userId: string;
  budgetMs?: number;
}) {
  const { budgetMs = DEFAULT_DRAIN_BUDGET_MS, ...rest } = params;
  return drainDeletion(() => processAccountDeletionPass(rest), budgetMs);
}
