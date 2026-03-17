import { FieldValue, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';
import { runWriteBatchInChunks } from '@/lib/firestore-batches';
import {
  dedupeFindingTaxonomyLabels,
  loadBrandFindingTaxonomy,
  normalizeFindingTaxonomyLabel,
} from '@/lib/findings-taxonomy';
import { chatCompletion } from './openrouter';
import {
  THEME_NORMALIZATION_SYSTEM_PROMPT,
  buildThemeNormalizationPrompt,
} from './prompts';
import { parseThemeNormalizationOutputWithDiagnostics } from './types';

type ScanThemeNormalizationParams = {
  scanId: string;
  brandId: string;
  userId: string;
  brandName?: string;
};

type ScanFindingSnapshot = QueryDocumentSnapshot;

export async function normalizeAndPersistScanThemes(params: ScanThemeNormalizationParams): Promise<void> {
  const pendingFindings = await loadPendingThemeFindings(params);
  if (pendingFindings.length === 0) {
    return;
  }

  const historicalThemes = (
    await loadBrandFindingTaxonomy({
      brandId: params.brandId,
      userId: params.userId,
      excludeScanId: params.scanId,
    })
  ).themes;
  const provisionalThemes = buildThemeNormalizationInputThemes(pendingFindings);
  if (provisionalThemes.length === 0) {
    return;
  }

  const brandName = params.brandName ?? await loadBrandName(params.brandId);
  const mappingByKey = await buildThemeNormalizationMap({
    scanId: params.scanId,
    brandName,
    historicalThemes,
    provisionalThemes,
  });

  await applyThemeMappingToFindings(params.scanId, pendingFindings, mappingByKey);
}

export async function promoteProvisionalThemesForScan(params: Omit<ScanThemeNormalizationParams, 'brandName'>): Promise<void> {
  const pendingFindings = await loadPendingThemeFindings(params);
  if (pendingFindings.length === 0) {
    return;
  }

  const fallbackMap = new Map<string, string>();
  for (const doc of pendingFindings) {
    const provisionalTheme = normalizeFindingTaxonomyLabel(doc.get('provisionalTheme'));
    if (!provisionalTheme) continue;
    const currentTheme = normalizeFindingTaxonomyLabel(doc.get('theme'));
    fallbackMap.set(
      normalizeThemeKey(provisionalTheme),
      currentTheme ?? provisionalTheme,
    );
  }

  await applyThemeMappingToFindings(params.scanId, pendingFindings, fallbackMap);
}

async function loadPendingThemeFindings(
  params: Omit<ScanThemeNormalizationParams, 'brandName'>,
): Promise<ScanFindingSnapshot[]> {
  const snapshot = await db
    .collection('findings')
    .where('scanId', '==', params.scanId)
    .where('brandId', '==', params.brandId)
    .where('userId', '==', params.userId)
    .select('theme', 'provisionalTheme', 'isFalsePositive', 'isIgnored', 'isAddressed')
    .get();

  return snapshot.docs.filter((doc) => typeof doc.get('provisionalTheme') === 'string' && doc.get('provisionalTheme').trim().length > 0);
}

async function loadBrandName(brandId: string): Promise<string> {
  const brandSnap = await db.collection('brands').doc(brandId).get();
  const brandName = brandSnap.exists ? brandSnap.get('name') : undefined;
  return typeof brandName === 'string' && brandName.trim().length > 0 ? brandName : 'Unknown brand';
}

function buildThemeNormalizationInputThemes(findings: ScanFindingSnapshot[]): string[] {
  return dedupeFindingTaxonomyLabels(findings.map((doc) => doc.get('provisionalTheme')));
}

async function buildThemeNormalizationMap(params: {
  scanId: string;
  brandName: string;
  historicalThemes: string[];
  provisionalThemes: string[];
}): Promise<Map<string, string>> {
  const { scanId, brandName, historicalThemes, provisionalThemes } = params;
  const fallbackMap = new Map<string, string>(
    provisionalThemes.map((theme) => [
      normalizeThemeKey(theme),
      resolveCanonicalThemeLabel(theme, historicalThemes, provisionalThemes),
    ]),
  );

  if (provisionalThemes.length === 0) {
    return fallbackMap;
  }

  if (provisionalThemes.length === 1 && historicalThemes.length === 0) {
    return fallbackMap;
  }

  try {
    const prompt = buildThemeNormalizationPrompt({
      brandName,
      historicalThemes,
      provisionalThemes,
    });
    const raw = await chatCompletion([
      { role: 'system', content: THEME_NORMALIZATION_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], { temperature: 0.1 });

    const { output: parsed, diagnostics } = parseThemeNormalizationOutputWithDiagnostics(raw, new Set(provisionalThemes));
    if (!parsed) {
      console.error(`[theme-normalization] Scan ${scanId}: parse failed — raw response (first 500 chars): ${raw.slice(0, 500)}`);
      throw new Error('Failed to parse theme normalization output');
    }
    const diagParts: string[] = [];
    if (diagnostics.rawMappingCount !== diagnostics.acceptedMappingCount) diagParts.push(`raw=${diagnostics.rawMappingCount}, accepted=${diagnostics.acceptedMappingCount}`);
    if (diagnostics.missingProvisionalThemes.length > 0) diagParts.push(`missing=${diagnostics.missingProvisionalThemes.join(',')}`);
    if (diagnostics.issues.length > 0) diagParts.push(`issues=${diagnostics.issues.join('; ')}`);
    if (diagParts.length > 0) {
      console.warn(`[theme-normalization] Scan ${scanId}: diagnostics (${diagParts.join('; ')})`);
    }

    const resolvedMap = new Map(fallbackMap);
    for (const mapping of parsed.mappings) {
      resolvedMap.set(
        normalizeThemeKey(mapping.provisionalTheme),
        resolveCanonicalThemeLabel(mapping.canonicalTheme, historicalThemes, provisionalThemes),
      );
    }
    return resolvedMap;
  } catch (error) {
    console.error(`[theme-normalization] Scan ${scanId}: failed to canonicalise provisional themes; falling back to identity map`, error);
    return fallbackMap;
  }
}

async function applyThemeMappingToFindings(
  _scanId: string,
  findings: ScanFindingSnapshot[],
  mappingByKey: Map<string, string>,
): Promise<void> {
  await runWriteBatchInChunks(findings, (batch, doc) => {
    const provisionalTheme = normalizeFindingTaxonomyLabel(doc.get('provisionalTheme'));
    if (!provisionalTheme) {
      batch.update(doc.ref, { provisionalTheme: FieldValue.delete() });
      return;
    }

    const existingTheme = normalizeFindingTaxonomyLabel(doc.get('theme'));
    const mappedTheme = mappingByKey.get(normalizeThemeKey(provisionalTheme));
    const finalTheme = mappedTheme ?? existingTheme ?? provisionalTheme;
    batch.update(doc.ref, {
      theme: finalTheme,
      provisionalTheme: FieldValue.delete(),
    });
  });
}

function resolveCanonicalThemeLabel(
  label: string,
  historicalThemes: string[],
  provisionalThemes: string[],
): string {
  const normalized = normalizeFindingTaxonomyLabel(label) ?? 'Other';

  return matchExistingThemeCase(normalized, historicalThemes)
    ?? matchExistingThemeCase(normalized, provisionalThemes)
    ?? normalized;
}

function matchExistingThemeCase(label: string, themes: string[]): string | undefined {
  const key = normalizeThemeKey(label);
  return themes.find((theme) => normalizeThemeKey(theme) === key);
}

function normalizeThemeKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

