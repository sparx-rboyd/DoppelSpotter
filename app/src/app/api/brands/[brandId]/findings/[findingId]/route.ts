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
// Body: {
//   isIgnored?: boolean;
//   isBookmarked?: boolean;
//   bookmarkNote?: string | null;
// }
// Ignoring is URL-scoped, but bookmark state and bookmark notes are stored on the
// individual finding document only.
export async function PATCH(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId, findingId } = await params;

  let body: {
    isIgnored?: boolean;
    isBookmarked?: boolean;
    bookmarkNote?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const hasIgnoreUpdate = Object.prototype.hasOwnProperty.call(body, 'isIgnored');
  const hasBookmarkUpdate = Object.prototype.hasOwnProperty.call(body, 'isBookmarked');
  const hasBookmarkNoteUpdate = Object.prototype.hasOwnProperty.call(body, 'bookmarkNote');

  if (!hasIgnoreUpdate && !hasBookmarkUpdate && !hasBookmarkNoteUpdate) {
    return errorResponse('No supported fields provided');
  }

  if (hasIgnoreUpdate && typeof body.isIgnored !== 'boolean') {
    return errorResponse('isIgnored must be a boolean');
  }
  if (hasBookmarkUpdate && typeof body.isBookmarked !== 'boolean') {
    return errorResponse('isBookmarked must be a boolean');
  }
  if (hasBookmarkNoteUpdate && body.bookmarkNote !== null && typeof body.bookmarkNote !== 'string') {
    return errorResponse('bookmarkNote must be a string or null');
  }

  // Verify the finding belongs to this brand and user
  const findingDoc = await db.collection('findings').doc(findingId).get();
  if (!findingDoc.exists) return errorResponse('Finding not found', 404);

  const finding = findingDoc.data() as Finding;
  if (finding.brandId !== brandId || finding.userId !== uid) {
    return errorResponse('Forbidden', 403);
  }

  const normalizedBookmarkNote =
    typeof body.bookmarkNote === 'string' ? body.bookmarkNote.trim() : null;
  if (normalizedBookmarkNote && normalizedBookmarkNote.length > 2000) {
    return errorResponse('bookmarkNote must be 2000 characters or fewer');
  }

  const bookmarkUpdates: Record<string, unknown> = {};
  const nextIsBookmarked = hasBookmarkUpdate ? body.isBookmarked === true : finding.isBookmarked === true;

  if (hasBookmarkNoteUpdate && normalizedBookmarkNote && !nextIsBookmarked) {
    return errorResponse('Cannot add a bookmark note to an unbookmarked finding');
  }

  if (hasBookmarkUpdate) {
    bookmarkUpdates.isBookmarked = body.isBookmarked === true;
    if (body.isBookmarked) {
      if (finding.isBookmarked !== true) {
        bookmarkUpdates.bookmarkedAt = FieldValue.serverTimestamp();
      }
    } else {
      bookmarkUpdates.bookmarkedAt = FieldValue.delete();
      bookmarkUpdates.bookmarkNote = FieldValue.delete();
    }
  }

  if (hasBookmarkNoteUpdate && nextIsBookmarked) {
    bookmarkUpdates.bookmarkNote = normalizedBookmarkNote
      ? normalizedBookmarkNote
      : FieldValue.delete();
  }

  if (hasIgnoreUpdate) {
    const ignoreUpdates: Record<string, unknown> = { isIgnored: body.isIgnored === true };
    if (body.isIgnored) {
      ignoreUpdates.ignoredAt = FieldValue.serverTimestamp();
    } else {
      ignoreUpdates.ignoredAt = FieldValue.delete();
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
        allDocs.slice(i, i + BATCH_LIMIT).forEach((doc) => batch.update(doc.ref, ignoreUpdates));
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
    } else {
      // No URL — update only this document
      await findingDoc.ref.update(ignoreUpdates);

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
    }
  }

  if (Object.keys(bookmarkUpdates).length > 0) {
    await findingDoc.ref.update(bookmarkUpdates);
  }

  const finalBookmarkNote = hasBookmarkUpdate && body.isBookmarked === false
    ? null
    : hasBookmarkNoteUpdate
      ? normalizedBookmarkNote
      : finding.bookmarkNote ?? null;

  return NextResponse.json({
    data: {
      id: findingId,
      url: finding.url,
      isIgnored: hasIgnoreUpdate ? body.isIgnored === true : finding.isIgnored === true,
      isBookmarked: hasBookmarkUpdate ? body.isBookmarked === true : finding.isBookmarked === true,
      bookmarkNote: finalBookmarkNote,
    },
  });
}
