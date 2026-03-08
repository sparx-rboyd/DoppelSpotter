import { NextResponse, type NextRequest } from 'next/server';
import { FieldValue, type DocumentSnapshot, type QueryDocumentSnapshot } from '@google-cloud/firestore';
type FindingDocSnapshot = DocumentSnapshot | QueryDocumentSnapshot;
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import type { Finding, FindingCategory, FindingSummary } from '@/lib/types';

type Params = { params: Promise<{ brandId: string; findingId: string }> };
type CountDelta = {
  findingCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  nonHitCount: number;
  ignoredCount: number;
  addressedCount: number;
};
type FindingCountState = Pick<Finding, 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed'>;

function emptyCountDelta(): CountDelta {
  return {
    findingCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    nonHitCount: 0,
    ignoredCount: 0,
    addressedCount: 0,
  };
}

function getFindingCountState(finding: FindingCountState): CountDelta {
  if (finding.isFalsePositive) {
    return {
      ...emptyCountDelta(),
      nonHitCount: 1,
    };
  }

  if (finding.isIgnored) {
    return {
      ...emptyCountDelta(),
      findingCount: 1,
      ignoredCount: 1,
    };
  }

  if (finding.isAddressed) {
    return {
      ...emptyCountDelta(),
      findingCount: 1,
      addressedCount: 1,
    };
  }

  return {
    ...emptyCountDelta(),
    findingCount: 1,
    highCount: finding.severity === 'high' ? 1 : 0,
    mediumCount: finding.severity === 'medium' ? 1 : 0,
    lowCount: finding.severity === 'low' ? 1 : 0,
  };
}

function applyCountDelta(target: CountDelta, previousState: FindingCountState, nextState: FindingCountState) {
  const previousCounts = getFindingCountState(previousState);
  const nextCounts = getFindingCountState(nextState);
  target.findingCount += nextCounts.findingCount - previousCounts.findingCount;
  target.highCount += nextCounts.highCount - previousCounts.highCount;
  target.mediumCount += nextCounts.mediumCount - previousCounts.mediumCount;
  target.lowCount += nextCounts.lowCount - previousCounts.lowCount;
  target.nonHitCount += nextCounts.nonHitCount - previousCounts.nonHitCount;
  target.ignoredCount += nextCounts.ignoredCount - previousCounts.ignoredCount;
  target.addressedCount += nextCounts.addressedCount - previousCounts.addressedCount;
}

function buildFindingSummary(
  id: string,
  sourceFinding: Finding,
  nextState: FindingCountState,
): FindingSummary {
  return {
    id,
    scanId: sourceFinding.scanId,
    brandId: sourceFinding.brandId,
    source: sourceFinding.source,
    severity: nextState.severity,
    title: sourceFinding.title,
    theme: sourceFinding.theme,
    llmAnalysis: sourceFinding.llmAnalysis,
    url: sourceFinding.url,
    isFalsePositive: nextState.isFalsePositive,
    isIgnored: nextState.isIgnored,
    isAddressed: nextState.isAddressed,
    addressedAt: nextState.isAddressed ? sourceFinding.addressedAt : undefined,
    isBookmarked: sourceFinding.isBookmarked,
    bookmarkedAt: sourceFinding.bookmarkedAt,
    bookmarkNote: sourceFinding.bookmarkNote,
    createdAt: sourceFinding.createdAt,
  };
}

function buildReclassifiedState(
  finding: Pick<Finding, 'severity'>,
  category: FindingCategory,
): FindingCountState {
  if (category === 'non-hit') {
    return {
      severity: finding.severity,
      isFalsePositive: true,
      isIgnored: true,
      isAddressed: false,
    };
  }

  return {
    severity: category,
    isFalsePositive: false,
    isIgnored: false,
    isAddressed: false,
  };
}

function getFindingCategory(finding: Pick<Finding, 'severity' | 'isFalsePositive'>): FindingCategory {
  return finding.isFalsePositive ? 'non-hit' : finding.severity;
}

function clearUserPreferenceSignalUpdates(): Record<string, unknown> {
  return {
    userPreferenceSignal: FieldValue.delete(),
    userPreferenceSignalReason: FieldValue.delete(),
    userPreferenceSignalAt: FieldValue.delete(),
    userReclassifiedFrom: FieldValue.delete(),
    userReclassifiedTo: FieldValue.delete(),
  };
}

function buildIgnoreSignalUpdates(isIgnored: boolean): Record<string, unknown> {
  if (!isIgnored) {
    return clearUserPreferenceSignalUpdates();
  }

  return {
    userPreferenceSignal: 'negative',
    userPreferenceSignalReason: 'ignored',
    userPreferenceSignalAt: FieldValue.serverTimestamp(),
    userReclassifiedFrom: FieldValue.delete(),
    userReclassifiedTo: FieldValue.delete(),
  };
}

function buildReclassificationSignalUpdates(
  finding: Pick<Finding, 'severity' | 'isFalsePositive'>,
  category: FindingCategory,
): Record<string, unknown> {
  const previousCategory = getFindingCategory(finding);

  if (category === 'non-hit') {
    return {
      userPreferenceSignal: 'negative',
      userPreferenceSignalReason: 'reclassified_to_non_hit',
      userPreferenceSignalAt: FieldValue.serverTimestamp(),
      userReclassifiedFrom: previousCategory,
      userReclassifiedTo: 'non-hit',
    };
  }

  if (category === 'high' && previousCategory === 'non-hit') {
    return {
      userPreferenceSignal: 'positive',
      userPreferenceSignalReason: 'reclassified_non_hit_to_high',
      userPreferenceSignalAt: FieldValue.serverTimestamp(),
      userReclassifiedFrom: 'non-hit',
      userReclassifiedTo: 'high',
    };
  }

  return clearUserPreferenceSignalUpdates();
}

async function loadUrlScopedFindingDocs(
  brandId: string,
  uid: string,
  url?: string,
  fallbackDoc?: FindingDocSnapshot,
) {
  if (!url || !fallbackDoc) {
    return fallbackDoc ? [fallbackDoc] : [];
  }

  return (
    await db
      .collection('findings')
      .where('brandId', '==', brandId)
      .where('userId', '==', uid)
      .where('url', '==', url)
      .get()
  ).docs;
}

// GET /api/brands/[brandId]/findings/[findingId]
// Returns the full finding payload, including raw debug fields.
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
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
//   isAddressed?: boolean;
//   isBookmarked?: boolean;
//   bookmarkNote?: string | null; // generic per-finding note (legacy field name)
//   reclassifiedCategory?: 'high' | 'medium' | 'low' | 'non-hit';
// }
// Ignoring, addressing, and category reclassification are URL-scoped, but bookmark
// state and notes are stored on the individual finding document only.
export async function PATCH(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId, findingId } = await params;

  let body: {
    isIgnored?: boolean;
    isAddressed?: boolean;
    isBookmarked?: boolean;
    bookmarkNote?: string | null;
    reclassifiedCategory?: FindingCategory;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const hasIgnoreUpdate = Object.prototype.hasOwnProperty.call(body, 'isIgnored');
  const hasAddressedUpdate = Object.prototype.hasOwnProperty.call(body, 'isAddressed');
  const hasBookmarkUpdate = Object.prototype.hasOwnProperty.call(body, 'isBookmarked');
  const hasBookmarkNoteUpdate = Object.prototype.hasOwnProperty.call(body, 'bookmarkNote');
  const hasReclassificationUpdate = Object.prototype.hasOwnProperty.call(body, 'reclassifiedCategory');

  if (!hasIgnoreUpdate && !hasAddressedUpdate && !hasBookmarkUpdate && !hasBookmarkNoteUpdate && !hasReclassificationUpdate) {
    return errorResponse('No supported fields provided');
  }

  if (hasIgnoreUpdate && typeof body.isIgnored !== 'boolean') {
    return errorResponse('isIgnored must be a boolean');
  }
  if (hasAddressedUpdate && typeof body.isAddressed !== 'boolean') {
    return errorResponse('isAddressed must be a boolean');
  }
  if (hasBookmarkUpdate && typeof body.isBookmarked !== 'boolean') {
    return errorResponse('isBookmarked must be a boolean');
  }
  if (hasBookmarkNoteUpdate && body.bookmarkNote !== null && typeof body.bookmarkNote !== 'string') {
    return errorResponse('bookmarkNote must be a string or null');
  }
  if (
    hasReclassificationUpdate
    && body.reclassifiedCategory !== 'low'
    && body.reclassifiedCategory !== 'medium'
    && body.reclassifiedCategory !== 'high'
    && body.reclassifiedCategory !== 'non-hit'
  ) {
    return errorResponse('reclassifiedCategory must be one of: high, medium, low, non-hit');
  }
  if (hasIgnoreUpdate && hasAddressedUpdate) {
    return errorResponse('isIgnored and isAddressed cannot be combined');
  }
  if (hasReclassificationUpdate && (hasIgnoreUpdate || hasAddressedUpdate || hasBookmarkUpdate || hasBookmarkNoteUpdate)) {
    return errorResponse('reclassifiedCategory cannot be combined with other updates');
  }

  // Verify the finding belongs to this brand and user.
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

  if (hasBookmarkUpdate) {
    bookmarkUpdates.isBookmarked = body.isBookmarked === true;
    if (body.isBookmarked) {
      if (finding.isBookmarked !== true) {
        bookmarkUpdates.bookmarkedAt = FieldValue.serverTimestamp();
      }
    } else {
      bookmarkUpdates.bookmarkedAt = FieldValue.delete();
    }
  }

  if (hasBookmarkNoteUpdate) {
    bookmarkUpdates.bookmarkNote = normalizedBookmarkNote
      ? normalizedBookmarkNote
      : FieldValue.delete();
  }

  let affectedFindings: FindingSummary[] = [];
  const affectedScanDeltas: Record<string, CountDelta> = {};

  if (hasReclassificationUpdate) {
    const reclassifiedCategory = body.reclassifiedCategory as FindingCategory;
    const affectedDocs = await loadUrlScopedFindingDocs(brandId, uid, finding.url, findingDoc);

    const BATCH_LIMIT = 500;
    for (let i = 0; i < affectedDocs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      affectedDocs.slice(i, i + BATCH_LIMIT).forEach((doc) => {
        const sourceFinding = doc.data() as Finding;
        const nextState = buildReclassifiedState(sourceFinding, reclassifiedCategory);
        batch.update(doc.ref, {
          severity: nextState.severity,
          isFalsePositive: nextState.isFalsePositive,
          isIgnored: nextState.isIgnored,
          ignoredAt: nextState.isIgnored ? FieldValue.serverTimestamp() : FieldValue.delete(),
          isAddressed: false,
          addressedAt: FieldValue.delete(),
          ...buildReclassificationSignalUpdates(sourceFinding, reclassifiedCategory),
        });
      });
      await batch.commit();
    }

    affectedFindings = affectedDocs.map((doc) => {
      const sourceFinding = doc.data() as Finding;
      const nextState = buildReclassifiedState(sourceFinding, reclassifiedCategory);
      const scanDelta = affectedScanDeltas[sourceFinding.scanId] ?? emptyCountDelta();
      applyCountDelta(scanDelta, sourceFinding, nextState);
      affectedScanDeltas[sourceFinding.scanId] = scanDelta;
      return buildFindingSummary(doc.id, sourceFinding, nextState);
    });

    await Promise.all(
      Object.entries(affectedScanDeltas)
        .filter(([, delta]) => Object.values(delta).some((value) => value !== 0))
        .map(([scanId, delta]) =>
          db.collection('scans').doc(scanId).update({
            findingCount: FieldValue.increment(delta.findingCount),
            highCount: FieldValue.increment(delta.highCount),
            mediumCount: FieldValue.increment(delta.mediumCount),
            lowCount: FieldValue.increment(delta.lowCount),
            nonHitCount: FieldValue.increment(delta.nonHitCount),
            ignoredCount: FieldValue.increment(delta.ignoredCount),
            addressedCount: FieldValue.increment(delta.addressedCount),
          }),
        ),
    );
  }

  if (hasAddressedUpdate) {
    if (finding.isFalsePositive) {
      return errorResponse('Only real findings can be marked as addressed', 409);
    }

    const addressAffectedDocs = (await loadUrlScopedFindingDocs(brandId, uid, finding.url, findingDoc))
      .filter((doc) => {
        const sourceFinding = doc.data() as Finding;
        return sourceFinding.isFalsePositive !== true;
      });

    if (body.isAddressed && addressAffectedDocs.some((doc) => (doc.data() as Finding).isIgnored === true)) {
      return errorResponse('Ignored findings must be un-ignored before they can be marked as addressed', 409);
    }

    const addressUpdates: Record<string, unknown> = {
      isAddressed: body.isAddressed === true,
      addressedAt: body.isAddressed ? FieldValue.serverTimestamp() : FieldValue.delete(),
    };

    const BATCH_LIMIT = 500;
    for (let i = 0; i < addressAffectedDocs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      addressAffectedDocs.slice(i, i + BATCH_LIMIT).forEach((doc) => batch.update(doc.ref, addressUpdates));
      await batch.commit();
    }

    affectedFindings = addressAffectedDocs.map((doc) => {
      const sourceFinding = doc.data() as Finding;
      const nextState: FindingCountState = {
        severity: sourceFinding.severity,
        isFalsePositive: false,
        isIgnored: false,
        isAddressed: body.isAddressed === true,
      };
      const scanDelta = affectedScanDeltas[sourceFinding.scanId] ?? emptyCountDelta();
      applyCountDelta(scanDelta, sourceFinding, nextState);
      affectedScanDeltas[sourceFinding.scanId] = scanDelta;
      return buildFindingSummary(doc.id, sourceFinding, nextState);
    });

    await Promise.all(
      Object.entries(affectedScanDeltas)
        .filter(([, delta]) => Object.values(delta).some((value) => value !== 0))
        .map(([scanId, delta]) =>
          db.collection('scans').doc(scanId).update({
            findingCount: FieldValue.increment(delta.findingCount),
            highCount: FieldValue.increment(delta.highCount),
            mediumCount: FieldValue.increment(delta.mediumCount),
            lowCount: FieldValue.increment(delta.lowCount),
            nonHitCount: FieldValue.increment(delta.nonHitCount),
            ignoredCount: FieldValue.increment(delta.ignoredCount),
            addressedCount: FieldValue.increment(delta.addressedCount),
          }),
        ),
    );
  }

  if (hasIgnoreUpdate) {
    if (finding.isFalsePositive) {
      return errorResponse('Only real findings can be ignored', 409);
    }

    const ignoreUpdates: Record<string, unknown> = {
      isIgnored: body.isIgnored === true,
      ...buildIgnoreSignalUpdates(body.isIgnored === true),
    };
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

      if (
        body.isIgnored
        && siblingsSnap.docs.some((doc) => {
          const sibling = doc.data() as Finding;
          return sibling.isFalsePositive !== true && sibling.isAddressed === true;
        })
      ) {
        return errorResponse('Addressed findings must be un-addressed before they can be ignored', 409);
      }

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
      // No URL — update only this document.
      if (body.isIgnored && finding.isAddressed) {
        return errorResponse('Addressed findings must be un-addressed before they can be ignored', 409);
      }

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

  const finalBookmarkNote = hasBookmarkNoteUpdate
    ? normalizedBookmarkNote
    : finding.bookmarkNote ?? null;
  const updatedTriggerFinding = affectedFindings.find((affectedFinding) => affectedFinding.id === findingId);

  return NextResponse.json({
    data: {
      id: findingId,
      url: finding.url,
      isIgnored: hasReclassificationUpdate
        ? (updatedTriggerFinding?.isIgnored ?? (finding.isIgnored === true))
        : hasIgnoreUpdate
          ? body.isIgnored === true
          : finding.isIgnored === true,
      isFalsePositive: hasReclassificationUpdate
        ? (updatedTriggerFinding?.isFalsePositive ?? (finding.isFalsePositive === true))
        : finding.isFalsePositive === true,
      severity: hasReclassificationUpdate
        ? (updatedTriggerFinding?.severity ?? finding.severity)
        : finding.severity,
      isAddressed: hasReclassificationUpdate
        ? (updatedTriggerFinding?.isAddressed ?? (finding.isAddressed === true))
        : hasAddressedUpdate
          ? body.isAddressed === true
          : finding.isAddressed === true,
      isBookmarked: hasBookmarkUpdate ? body.isBookmarked === true : finding.isBookmarked === true,
      bookmarkNote: finalBookmarkNote,
      affectedFindings,
      affectedScanDeltas,
    },
  });
}
