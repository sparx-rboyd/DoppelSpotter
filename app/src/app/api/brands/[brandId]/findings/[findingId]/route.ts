import { NextResponse, type NextRequest } from 'next/server';
import { FieldValue } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import type { Finding } from '@/lib/types';

type Params = { params: Promise<{ brandId: string; findingId: string }> };

// GET /api/brands/[brandId]/findings/[findingId]
// Returns the full finding payload, including raw debug fields.
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId, findingId } = await params;
  void request;

  const findingDoc = await db.collection('findings').doc(findingId).get();
  if (!findingDoc.exists) return errorResponse('Finding not found', 404);

  const finding = findingDoc.data() as Omit<Finding, 'id'>;
  if (finding.brandId !== brandId || finding.userId !== uid) {
    return errorResponse('Forbidden', 403);
  }

  return NextResponse.json({
    data: {
      id: findingDoc.id,
      ...finding,
    },
  });
}

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

    // Update denormalized severity counts on each affected scan document.
    // Only non-false-positive findings that actually change state affect counts.
    const changingFindings = allDocs
      .map((d) => d.data() as Finding)
      .filter((f) => !f.isFalsePositive && (body.isIgnored ? !f.isIgnored : f.isIgnored === true));

    if (changingFindings.length > 0) {
      const byScanId = new Map<string, { high: number; medium: number; low: number }>();
      for (const f of changingFindings) {
        const entry = byScanId.get(f.scanId) ?? { high: 0, medium: 0, low: 0 };
        if (f.severity === 'high') entry.high++;
        else if (f.severity === 'medium') entry.medium++;
        else if (f.severity === 'low') entry.low++;
        byScanId.set(f.scanId, entry);
      }
      const multiplier = body.isIgnored ? 1 : -1;
      await Promise.all(
        Array.from(byScanId.entries()).map(([scanId, c]) =>
          db.collection('scans').doc(scanId).update({
            highCount: FieldValue.increment(-multiplier * c.high),
            mediumCount: FieldValue.increment(-multiplier * c.medium),
            lowCount: FieldValue.increment(-multiplier * c.low),
            ignoredCount: FieldValue.increment(multiplier * (c.high + c.medium + c.low)),
          }),
        ),
      );
    }

    return NextResponse.json({ data: { url, isIgnored: body.isIgnored, updatedCount: allDocs.length } });
  }

  // No URL — update only this document
  await findingDoc.ref.update(updates);

  // Update the scan's denormalized counts if this is a non-false-positive finding
  // that actually changes state.
  if (!finding.isFalsePositive && (body.isIgnored ? !finding.isIgnored : finding.isIgnored === true)) {
    const multiplier = body.isIgnored ? 1 : -1;
    const sevField =
      finding.severity === 'high' ? 'highCount' :
      finding.severity === 'medium' ? 'mediumCount' : 'lowCount';
    await db.collection('scans').doc(finding.scanId).update({
      [sevField]: FieldValue.increment(-multiplier),
      ignoredCount: FieldValue.increment(multiplier),
    });
  }

  return NextResponse.json({ data: { id: findingId, isIgnored: body.isIgnored } });
}
