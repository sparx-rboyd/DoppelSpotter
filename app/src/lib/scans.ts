import { FieldValue, type DocumentReference, type DocumentSnapshot, type QueryDocumentSnapshot, type Transaction } from '@google-cloud/firestore';
import { db } from './firestore';
import type { BrandProfile, Scan, ScanStatus } from './types';

type ScanSnapshot = DocumentSnapshot | QueryDocumentSnapshot;

export function isScanInProgress(status: ScanStatus): boolean {
  return status === 'pending' || status === 'running';
}

export function scanFromSnapshot(snapshot: ScanSnapshot): Scan {
  return {
    id: snapshot.id,
    ...(snapshot.data() as Omit<Scan, 'id'>),
  };
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
