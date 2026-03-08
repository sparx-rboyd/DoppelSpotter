import type { WriteBatch } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';

// Keep a margin below Firestore's nominal 500-write ceiling so heavily indexed
// documents do not overflow a single commit request.
export const SAFE_FIRESTORE_WRITE_BATCH_LIMIT = 200;

export async function runWriteBatchInChunks<T>(
  items: readonly T[],
  applyWrite: (batch: WriteBatch, item: T) => void,
  batchLimit = SAFE_FIRESTORE_WRITE_BATCH_LIMIT,
): Promise<void> {
  if (batchLimit < 1) {
    throw new Error('batchLimit must be at least 1');
  }

  for (let index = 0; index < items.length; index += batchLimit) {
    const batch = db.batch();
    items.slice(index, index + batchLimit).forEach((item) => applyWrite(batch, item));
    await batch.commit();
  }
}
