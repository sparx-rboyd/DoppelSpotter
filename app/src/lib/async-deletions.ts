import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';
import { runWriteBatchInChunks } from '@/lib/firestore-batches';
import { isScanInProgress, scanFromSnapshot } from '@/lib/scans';
import type { AsyncDeletionState, BrandProfile, Scan } from '@/lib/types';

const DELETION_BATCH_LIMIT = 200;
const DELETION_LEASE_MS = 60_000;
const DEFAULT_DRAIN_BUDGET_MS = 8_000;

type DeletionPassResult = 'idle' | 'busy' | 'progress' | 'complete';
type BrandDeletionField = 'historyDeletion' | 'brandDeletion';
type ScopedDeletionField = BrandDeletionField | 'deletion';

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
    ...(field !== 'deletion' ? { updatedAt: FieldValue.serverTimestamp() } : {}),
  });
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
