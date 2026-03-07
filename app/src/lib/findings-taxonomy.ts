import { db } from '@/lib/firestore';

export const MAX_FINDING_TAXONOMY_WORDS = 3;

export interface FindingTaxonomyOptions {
  platforms: string[];
  themes: string[];
}

function normalizeFindingTaxonomyKey(label: string) {
  return label.toLowerCase();
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

  return Array.from(deduped.values()).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

export async function loadBrandFindingTaxonomy(params: {
  brandId: string;
  userId: string;
}): Promise<FindingTaxonomyOptions> {
  const { brandId, userId } = params;

  const snapshot = await db
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', userId)
    .select('platform', 'theme')
    .get();

  return {
    platforms: dedupeFindingTaxonomyLabels(snapshot.docs.map((doc) => doc.get('platform'))),
    themes: dedupeFindingTaxonomyLabels(snapshot.docs.map((doc) => doc.get('theme'))),
  };
}
