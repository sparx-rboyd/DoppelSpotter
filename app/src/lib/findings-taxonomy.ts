import { db } from '@/lib/firestore';

export const MAX_FINDING_TAXONOMY_WORDS = 3;
const OTHER_FINDING_TAXONOMY_KEY = 'other';

export interface FindingTaxonomyOptions {
  themes: string[];
}

function normalizeFindingTaxonomyKey(label: string) {
  return label.toLowerCase();
}

function compareFindingTaxonomyLabels(a: string, b: string) {
  const aKey = normalizeFindingTaxonomyKey(a);
  const bKey = normalizeFindingTaxonomyKey(b);
  const aIsOther = aKey === OTHER_FINDING_TAXONOMY_KEY;
  const bIsOther = bKey === OTHER_FINDING_TAXONOMY_KEY;

  if (aIsOther !== bIsOther) {
    return aIsOther ? 1 : -1;
  }

  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}

export function normalizeFindingTaxonomyLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;

  if (normalized.split(' ').length > MAX_FINDING_TAXONOMY_WORDS) {
    return undefined;
  }

  return normalized;
}

export function dedupeFindingTaxonomyLabels(values: Iterable<unknown>): string[] {
  const deduped = new Map<string, string>();

  for (const value of values) {
    const normalized = normalizeFindingTaxonomyLabel(value);
    if (!normalized) continue;

    const key = normalizeFindingTaxonomyKey(normalized);
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }

  return Array.from(deduped.values()).sort(compareFindingTaxonomyLabels);
}

export async function loadBrandFindingTaxonomy(params: {
  brandId: string;
  userId: string;
  excludeScanId?: string;
  excludeScanIds?: Iterable<string>;
  includeAllFindingStates?: boolean;
}): Promise<FindingTaxonomyOptions> {
  const {
    brandId,
    userId,
    excludeScanId,
    excludeScanIds,
    includeAllFindingStates = false,
  } = params;
  const excludedScanIds = new Set(excludeScanIds);

  const snapshot = await db
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', userId)
    .select('scanId', 'theme', 'isFalsePositive', 'isIgnored', 'isAddressed')
    .get();
  const docs = snapshot.docs.filter((doc) => (
    doc.get('scanId') !== excludeScanId
    && !excludedScanIds.has(doc.get('scanId'))
    && (
      includeAllFindingStates
      || (
        doc.get('isFalsePositive') !== true
        && doc.get('isIgnored') !== true
        && doc.get('isAddressed') !== true
      )
    )
  ));

  return {
    themes: dedupeFindingTaxonomyLabels(docs.map((doc) => doc.get('theme'))),
  };
}
