import { NextResponse, type NextRequest } from 'next/server';
import { FieldValue } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import type { BrandProfile, Finding } from '@/lib/types';

type Params = { params: Promise<{ brandId: string; findingId: string }> };

// PATCH /api/brands/[brandId]/findings/[findingId]
// Body: { isIgnored: boolean }
// Toggles the ignored state on the target finding and — when the finding has a URL —
// applies the same change to every other finding for this brand that shares the same URL.
// This ensures that ignoring/un-ignoring is URL-scoped, not just per-document.
export async function PATCH(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId, findingId } = await params;

  let body: { isIgnored: boolean };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  if (typeof body.isIgnored !== 'boolean') {
    return errorResponse('isIgnored must be a boolean');
  }

  // Verify brand ownership
  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);
  if ((brandDoc.data() as BrandProfile).userId !== uid) return errorResponse('Forbidden', 403);

  // Verify the finding belongs to this brand and user
  const findingDoc = await db.collection('findings').doc(findingId).get();
  if (!findingDoc.exists) return errorResponse('Finding not found', 404);

  const finding = findingDoc.data() as Finding;
  if (finding.brandId !== brandId || finding.userId !== uid) {
    return errorResponse('Forbidden', 403);
  }

  const updates: Record<string, unknown> = { isIgnored: body.isIgnored };
  if (body.isIgnored) {
    updates.ignoredAt = FieldValue.serverTimestamp();
  } else {
    updates.ignoredAt = FieldValue.delete();
  }

  // If this finding has a URL, apply the same change to every other finding
  // for this brand that shares the URL (URL-scoped ignore).
  const url = finding.url;
  if (url) {
    const siblingsSnap = await db
      .collection('findings')
      .where('brandId', '==', brandId)
      .where('userId', '==', uid)
      .where('url', '==', url)
      .get();

    const BATCH_LIMIT = 500;
    const allDocs = siblingsSnap.docs; // includes the target finding itself
    for (let i = 0; i < allDocs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      allDocs.slice(i, i + BATCH_LIMIT).forEach((doc) => batch.update(doc.ref, updates));
      await batch.commit();
    }

    return NextResponse.json({ data: { url, isIgnored: body.isIgnored, updatedCount: allDocs.length } });
  }

  // No URL — update only this document
  await findingDoc.ref.update(updates);
  return NextResponse.json({ data: { id: findingId, isIgnored: body.isIgnored } });
}
