import { FieldValue, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';
import { runWriteBatchInChunks } from '@/lib/firestore-batches';
import {
  loadBrandFindingTaxonomy,
  normalizeFindingTaxonomyLabel,
} from '@/lib/findings-taxonomy';
import type { FindingSource, Severity } from '@/lib/types';
import { chatCompletion } from './openrouter';
import {
  THEME_NORMALIZATION_SYSTEM_PROMPT,
  buildThemeNormalizationPrompt,
} from './prompts';
import { parseThemeNormalizationOutputWithDiagnostics } from './types';

type ThemeNormalizationGroup = {
  provisionalTheme: string;
  count: number;
  sources: FindingSource[];
  severityCounts: {
    high: number;
    medium: number;
    low: number;
    nonHit: number;
  };
  exampleTitles: string[];
};

type ScanThemeNormalizationParams = {
  scanId: string;
  brandId: string;
  userId: string;
  brandName?: string;
};

type ScanFindingSnapshot = QueryDocumentSnapshot;

export async function normalizeAndPersistScanThemes(params: ScanThemeNormalizationParams): Promise<void> {
  const prefix = `[theme-normalization] Scan ${params.scanId}:`;
  console.log(`${prefix} starting — loading pending findings`);

  const pendingFindings = await loadPendingThemeFindings(params);
  if (pendingFindings.length === 0) {
    console.log(`${prefix} no pending findings — skipping`);
    return;
  }
  const actionablePendingFindings = pendingFindings.filter(isVisibleActionableThemeCandidate);
  const nonActionablePendingFindings = pendingFindings.filter((doc) => !isVisibleActionableThemeCandidate(doc));
  console.log(
    `${prefix} loaded ${pendingFindings.length} pending findings (${actionablePendingFindings.length} actionable, ${nonActionablePendingFindings.length} non-actionable)`,
  );

  const historicalThemes = (
    await loadBrandFindingTaxonomy({
      brandId: params.brandId,
      userId: params.userId,
      excludeScanId: params.scanId,
    })
  ).themes;
  const provisionalGroups = buildThemeNormalizationGroups(actionablePendingFindings);
  if (provisionalGroups.length === 0) {
    console.log(`${prefix} no actionable provisional groups after grouping`);
    if (nonActionablePendingFindings.length > 0) {
      await promotePassthroughThemesToFindings(nonActionablePendingFindings);
      console.log(`${prefix} promoted passthrough themes for ${nonActionablePendingFindings.length} non-actionable findings`);
    }
    return;
  }
  console.log(`${prefix} ${provisionalGroups.length} provisional groups, ${historicalThemes.length} historical themes`);

  const brandName = params.brandName ?? await loadBrandName(params.brandId);
  const mappingByKey = await buildThemeNormalizationMap({
    scanId: params.scanId,
    brandName,
    historicalThemes,
    provisionalGroups,
  });
  console.log(
    `${prefix} mapping resolved — ${mappingByKey.size} entries. Applying to ${actionablePendingFindings.length} actionable findings`,
  );

  await applyThemeMappingToFindings(params.scanId, actionablePendingFindings, mappingByKey);
  if (nonActionablePendingFindings.length > 0) {
    await promotePassthroughThemesToFindings(nonActionablePendingFindings);
    console.log(`${prefix} promoted passthrough themes for ${nonActionablePendingFindings.length} non-actionable findings`);
  }
  console.log(`${prefix} theme normalization complete`);
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
    .select('theme', 'provisionalTheme', 'source', 'severity', 'title', 'isFalsePositive', 'isIgnored', 'isAddressed')
    .get();

  return snapshot.docs.filter((doc) => typeof doc.get('provisionalTheme') === 'string' && doc.get('provisionalTheme').trim().length > 0);
}

async function loadBrandName(brandId: string): Promise<string> {
  const brandSnap = await db.collection('brands').doc(brandId).get();
  const brandName = brandSnap.exists ? brandSnap.get('name') : undefined;
  return typeof brandName === 'string' && brandName.trim().length > 0 ? brandName : 'Unknown brand';
}

function buildThemeNormalizationGroups(findings: ScanFindingSnapshot[]): ThemeNormalizationGroup[] {
  const groups = new Map<string, ThemeNormalizationGroup>();

  for (const doc of findings) {
    const provisionalTheme = normalizeFindingTaxonomyLabel(doc.get('provisionalTheme'));
    if (!provisionalTheme) continue;

    const key = normalizeThemeKey(provisionalTheme);
    const existing = groups.get(key);
    const source = doc.get('source') as FindingSource;
    const severity = doc.get('severity') as unknown;
    const title = typeof doc.get('title') === 'string' ? doc.get('title').trim() : '';
    const isFalsePositive = doc.get('isFalsePositive') === true;

    const group = existing ?? {
      provisionalTheme,
      count: 0,
      sources: [],
      severityCounts: { high: 0, medium: 0, low: 0, nonHit: 0 },
      exampleTitles: [],
    };

    group.count++;
    if (source && !group.sources.some((value) => value === source)) {
      group.sources.push(source);
    }

    if (isFalsePositive) {
      group.severityCounts.nonHit++;
    } else if (isSeverity(severity)) {
      group.severityCounts[severity]++;
    } else {
      group.severityCounts.nonHit++;
    }

    if (title) {
      group.exampleTitles.push(title);
    }

    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sources: dedupeFindingSources(group.sources),
      exampleTitles: pickRepresentativeExamples(group.exampleTitles, 5),
    }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.provisionalTheme.localeCompare(right.provisionalTheme, 'en', { sensitivity: 'base' });
    });
}

function isVisibleActionableThemeCandidate(doc: ScanFindingSnapshot): boolean {
  return doc.get('isFalsePositive') !== true
    && doc.get('isIgnored') !== true
    && doc.get('isAddressed') !== true;
}

async function buildThemeNormalizationMap(params: {
  scanId: string;
  brandName: string;
  historicalThemes: string[];
  provisionalGroups: ThemeNormalizationGroup[];
}): Promise<Map<string, string>> {
  const { scanId, brandName, historicalThemes, provisionalGroups } = params;
  const provisionalThemes = provisionalGroups.map((group) => group.provisionalTheme);
  const fallbackMap = new Map<string, string>(
    provisionalThemes.map((theme) => [
      normalizeThemeKey(theme),
      resolveCanonicalThemeLabel(theme, historicalThemes, provisionalThemes),
    ]),
  );

  if (provisionalGroups.length === 0) {
    return fallbackMap;
  }

  if (provisionalGroups.length === 1 && historicalThemes.length === 0) {
    return fallbackMap;
  }

  try {
    const prompt = buildThemeNormalizationPrompt({
      brandName,
      historicalThemes,
      provisionalGroups,
    });
    console.log(`[theme-normalization] Scan ${scanId}: calling LLM — prompt length ${prompt.length} chars, ${provisionalGroups.length} groups`);
    const raw = await chatCompletion([
      { role: 'system', content: THEME_NORMALIZATION_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], { temperature: 0.1 });
    console.log(`[theme-normalization] Scan ${scanId}: LLM returned ${raw.length} chars`);

    const { output: parsed, diagnostics } = parseThemeNormalizationOutputWithDiagnostics(raw, new Set(provisionalThemes));
    if (!parsed) {
      console.error(`[theme-normalization] Scan ${scanId}: parse failed — raw response (first 500 chars): ${raw.slice(0, 500)}`);
      throw new Error('Failed to parse theme normalization output');
    }
    const diagParts: string[] = [];
    if (diagnostics.rawMappingCount !== diagnostics.acceptedMappingCount) diagParts.push(`raw=${diagnostics.rawMappingCount}, accepted=${diagnostics.acceptedMappingCount}`);
    if (diagnostics.missingProvisionalThemes.length > 0) diagParts.push(`missing=${diagnostics.missingProvisionalThemes.join(',')}`);
    if (diagnostics.issues.length > 0) diagParts.push(`issues=${diagnostics.issues.join('; ')}`);
    console.log(`[theme-normalization] Scan ${scanId}: parsed ${parsed.mappings.length} mappings${diagParts.length > 0 ? ` (${diagParts.join('; ')})` : ''}`);

    const resolvedMap = new Map(fallbackMap);
    for (const mapping of parsed.mappings) {
      resolvedMap.set(
        normalizeThemeKey(mapping.provisionalTheme),
        resolveCanonicalThemeLabel(mapping.canonicalTheme, historicalThemes, provisionalThemes),
      );
    }

    const distinctCanonical = new Set([...resolvedMap.values()]);
    console.log(`[theme-normalization] Scan ${scanId}: ${provisionalGroups.length} provisional themes → ${distinctCanonical.size} distinct canonical themes`);
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

async function promotePassthroughThemesToFindings(findings: ScanFindingSnapshot[]): Promise<void> {
  await runWriteBatchInChunks(findings, (batch, doc) => {
    const provisionalTheme = normalizeFindingTaxonomyLabel(doc.get('provisionalTheme'));
    if (!provisionalTheme) {
      batch.update(doc.ref, { provisionalTheme: FieldValue.delete() });
      return;
    }

    const existingTheme = normalizeFindingTaxonomyLabel(doc.get('theme'));
    batch.update(doc.ref, {
      theme: existingTheme ?? provisionalTheme,
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

function isSeverity(value: unknown): value is Severity {
  return value === 'high' || value === 'medium' || value === 'low';
}

function normalizeThemeKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function pickRepresentativeExamples(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.slice(0, limit);
}

function dedupeFindingSources(values: FindingSource[]): FindingSource[] {
  const seen = new Set<FindingSource>();
  const deduped: FindingSource[] = [];

  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

