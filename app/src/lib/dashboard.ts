import type {
  DashboardBreakdownCategory,
  DashboardBreakdownRow,
  DashboardMetricTotals,
  DashboardScanBreakdowns,
  DashboardStoredBreakdownEntry,
  DashboardTimeline,
  DashboardTimelinePoint,
  DashboardTimelineSeries,
  Finding,
  FindingSource,
  Scan,
  ScanSummary,
  ScanStatus,
} from './types';
import { getFindingSourceLabel, SCAN_SOURCE_ORDER } from './scan-sources';

export const TERMINAL_DASHBOARD_SCAN_STATUSES: ScanStatus[] = ['completed', 'cancelled', 'failed'];
export const UNLABELLED_DASHBOARD_BREAKDOWN_BUCKET = 'Unlabelled';
export const DASHBOARD_SCAN_BREAKDOWNS_VERSION = 1;

const DASHBOARD_SOURCE_TIMELINE_COLORS: Record<Exclude<FindingSource, 'unknown'>, string> = {
  google: '#0284c7',
  reddit: '#ea580c',
  tiktok: '#db2777',
  youtube: '#dc2626',
  facebook: '#2563eb',
  instagram: '#c026d3',
  telegram: '#0f766e',
  apple_app_store: '#4f46e5',
  google_play: '#65a30d',
  domains: '#7c3aed',
  discord: '#0891b2',
  github: '#475569',
  euipo: '#9333ea',
  x: '#0f172a',
};

const DASHBOARD_THEME_TIMELINE_COLORS = [
  '#0284c7',
  '#0f766e',
  '#ea580c',
  '#4f46e5',
  '#db2777',
  '#65a30d',
  '#7c3aed',
  '#0891b2',
  '#c2410c',
  '#be123c',
  '#2563eb',
  '#0d9488',
  '#7c2d12',
  '#6d28d9',
  '#1d4ed8',
  '#b45309',
  '#4338ca',
  '#be185d',
  '#166534',
  '#0f766e',
] as const;

type DashboardAggregateFindingRecord = Pick<Finding, 'source' | 'theme' | 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed'>;
type DashboardCountSource = Pick<ScanSummary, 'highCount' | 'mediumCount' | 'lowCount' | 'nonHitCount'>;
type DashboardBreakdownScanSource = Pick<Scan, 'id' | 'dashboardBreakdowns'>;
type DashboardTimelineScanSource = Pick<Scan, 'id' | 'startedAt' | 'dashboardBreakdowns'>;

export function emptyDashboardMetricTotals(): DashboardMetricTotals {
  return {
    high: 0,
    medium: 0,
    low: 0,
    nonHit: 0,
  };
}

function emptyDashboardStoredBreakdownEntry(key: string): DashboardStoredBreakdownEntry {
  return {
    key,
    ...emptyDashboardMetricTotals(),
  };
}

function getDashboardActionableTotal(row: Pick<DashboardMetricTotals, 'high' | 'medium' | 'low'>): number {
  return row.high + row.medium + row.low;
}

function getStoredEntryTotal(entry: DashboardStoredBreakdownEntry): number {
  return entry.high + entry.medium + entry.low + entry.nonHit;
}

function getSortedDashboardTimelinePoints(scans: Array<Pick<Scan, 'id' | 'startedAt'>>): DashboardTimelinePoint[] {
  return [...scans]
    .sort((left, right) => (
      left.startedAt.toMillis() - right.startedAt.toMillis()
      || left.id.localeCompare(right.id)
    ))
    .map((scan) => ({
      scanId: scan.id,
      startedAt: scan.startedAt,
      values: {},
    }));
}

function buildDashboardTimelineSeriesKey(prefix: string, index: number): string {
  return `${prefix}_${String(index + 1).padStart(2, '0')}`;
}

function buildCumulativeDashboardTimelinePoints(
  points: DashboardTimelinePoint[],
  seriesKeys: readonly string[],
): DashboardTimelinePoint[] {
  const runningTotals = new Map<string, number>();

  return points.map((point) => {
    const nextValues: Record<string, number> = {};

    for (const key of seriesKeys) {
      const runningTotal = (runningTotals.get(key) ?? 0) + (point.values[key] ?? 0);
      runningTotals.set(key, runningTotal);
      nextValues[key] = runningTotal;
    }

    return {
      ...point,
      values: nextValues,
    };
  });
}

function isKnownFindingSource(value: string): value is FindingSource {
  return value === 'unknown' || SCAN_SOURCE_ORDER.includes(value as Exclude<FindingSource, 'unknown'>);
}

function getDashboardSourceLabel(sourceKey: string): string {
  return isKnownFindingSource(sourceKey) ? getFindingSourceLabel(sourceKey) : sourceKey;
}

function sortStoredSourceEntries(left: DashboardStoredBreakdownEntry, right: DashboardStoredBreakdownEntry): number {
  const leftIndex = SCAN_SOURCE_ORDER.indexOf(left.key as Exclude<FindingSource, 'unknown'>);
  const rightIndex = SCAN_SOURCE_ORDER.indexOf(right.key as Exclude<FindingSource, 'unknown'>);
  const leftOrder = left.key === 'unknown' || leftIndex === -1 ? Number.POSITIVE_INFINITY : leftIndex;
  const rightOrder = right.key === 'unknown' || rightIndex === -1 ? Number.POSITIVE_INFINITY : rightIndex;
  return leftOrder - rightOrder || left.key.localeCompare(right.key);
}

function sortStoredThemeEntries(left: DashboardStoredBreakdownEntry, right: DashboardStoredBreakdownEntry): number {
  return getDashboardActionableTotal(right) - getDashboardActionableTotal(left)
    || getStoredEntryTotal(right) - getStoredEntryTotal(left)
    || left.key.localeCompare(right.key);
}

function incrementStoredBreakdownEntry(
  entry: DashboardStoredBreakdownEntry,
  category: DashboardBreakdownCategory,
): void {
  entry[category] += 1;
}

function addStoredEntryToBreakdownRow(
  row: DashboardBreakdownRow,
  entry: DashboardStoredBreakdownEntry,
  scanId: string,
  scanOrderById?: ReadonlyMap<string, number>,
): void {
  const categories: DashboardBreakdownCategory[] = ['high', 'medium', 'low', 'nonHit'];
  for (const category of categories) {
    const count = entry[category];
    if (count <= 0) continue;

    row[category] += count;
    const currentDrilldownScanId = row.drilldownScanIds?.[category];
    const nextScanOrder = scanOrderById?.get(scanId) ?? Number.POSITIVE_INFINITY;
    const currentScanOrder = currentDrilldownScanId
      ? (scanOrderById?.get(currentDrilldownScanId) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;

    if (!currentDrilldownScanId || nextScanOrder < currentScanOrder) {
      row.drilldownScanIds = {
        ...row.drilldownScanIds,
        [category]: scanId,
      };
    }
  }

  row.total += getStoredEntryTotal(entry);
}

export function getDashboardFindingCategory(
  finding: Pick<Finding, 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed'>,
): DashboardBreakdownCategory | null {
  if (finding.isFalsePositive) {
    return 'nonHit';
  }

  if (finding.isIgnored || finding.isAddressed) {
    return null;
  }

  return finding.severity;
}

export function hasCurrentDashboardBreakdowns(scan: Pick<Scan, 'dashboardBreakdowns'>): boolean {
  return scan.dashboardBreakdowns?.version === DASHBOARD_SCAN_BREAKDOWNS_VERSION
    && Array.isArray(scan.dashboardBreakdowns.source)
    && Array.isArray(scan.dashboardBreakdowns.theme);
}

export function buildDashboardScanBreakdowns(
  findings: DashboardAggregateFindingRecord[],
): DashboardScanBreakdowns {
  const source = new Map<string, DashboardStoredBreakdownEntry>();
  const theme = new Map<string, DashboardStoredBreakdownEntry>();

  for (const finding of findings) {
    const category = getDashboardFindingCategory(finding);
    if (!category) continue;

    const sourceKey = finding.source;
    const sourceEntry = source.get(sourceKey) ?? emptyDashboardStoredBreakdownEntry(sourceKey);
    incrementStoredBreakdownEntry(sourceEntry, category);
    source.set(sourceKey, sourceEntry);

    const themeKey = finding.theme?.trim() ? finding.theme.trim() : UNLABELLED_DASHBOARD_BREAKDOWN_BUCKET;
    const themeEntry = theme.get(themeKey) ?? emptyDashboardStoredBreakdownEntry(themeKey);
    incrementStoredBreakdownEntry(themeEntry, category);
    theme.set(themeKey, themeEntry);
  }

  return {
    version: DASHBOARD_SCAN_BREAKDOWNS_VERSION,
    source: [...source.values()].sort(sortStoredSourceEntries),
    theme: [...theme.values()].sort(sortStoredThemeEntries),
  };
}

export function buildDashboardMetricTotalsFromScans(scans: DashboardCountSource[]): DashboardMetricTotals {
  return scans.reduce<DashboardMetricTotals>((totals, scan) => ({
    high: totals.high + scan.highCount,
    medium: totals.medium + scan.mediumCount,
    low: totals.low + scan.lowCount,
    nonHit: totals.nonHit + scan.nonHitCount,
  }), emptyDashboardMetricTotals());
}

export function buildDashboardBreakdownRows(
  scans: DashboardBreakdownScanSource[],
  scanOrderById?: ReadonlyMap<string, number>,
): DashboardBreakdownRow[] {
  const rows = new Map<string, DashboardBreakdownRow>();

  for (const scan of scans) {
    const themeEntries = scan.dashboardBreakdowns?.theme ?? [];
    for (const entry of themeEntries) {
      const existing = rows.get(entry.key) ?? {
        label: entry.key,
        filterValue: entry.key,
        ...emptyDashboardMetricTotals(),
        total: 0,
        drilldownScanIds: {},
      };

      addStoredEntryToBreakdownRow(existing, entry, scan.id, scanOrderById);
      rows.set(entry.key, existing);
    }
  }

  return [...rows.values()].sort((left, right) => (
    getDashboardActionableTotal(right) - getDashboardActionableTotal(left)
    || right.total - left.total
    || left.label.localeCompare(right.label)
  ));
}

export function buildDashboardSourceBreakdownRows(
  scans: DashboardBreakdownScanSource[],
  scanOrderById?: ReadonlyMap<string, number>,
): DashboardBreakdownRow[] {
  const rows = new Map<string, DashboardBreakdownRow>();

  for (const scan of scans) {
    const sourceEntries = scan.dashboardBreakdowns?.source ?? [];
    for (const entry of sourceEntries) {
      const existing = rows.get(entry.key) ?? {
        label: getDashboardSourceLabel(entry.key),
        filterValue: entry.key,
        ...emptyDashboardMetricTotals(),
        total: 0,
        drilldownScanIds: {},
      };

      addStoredEntryToBreakdownRow(existing, entry, scan.id, scanOrderById);
      rows.set(entry.key, existing);
    }
  }

  return [...rows.values()].sort((left, right) => (
    getDashboardActionableTotal(right) - getDashboardActionableTotal(left)
    || right.total - left.total
    || left.label.localeCompare(right.label)
  ));
}

export function buildDashboardSourceTimeline(scans: DashboardTimelineScanSource[]): DashboardTimeline | null {
  const points = getSortedDashboardTimelinePoints(scans);
  const pointByScanId = new Map(points.map((point) => [point.scanId, point]));
  const totalsBySource = new Map<Exclude<FindingSource, 'unknown'>, number>();

  for (const scan of scans) {
    const point = pointByScanId.get(scan.id);
    if (!point) continue;

    for (const entry of scan.dashboardBreakdowns?.source ?? []) {
      if (!SCAN_SOURCE_ORDER.includes(entry.key as Exclude<FindingSource, 'unknown'>)) {
        continue;
      }

      const actionableCount = entry.high + entry.medium + entry.low;
      if (actionableCount <= 0) continue;

      const source = entry.key as Exclude<FindingSource, 'unknown'>;
      point.values[source] = actionableCount;
      totalsBySource.set(source, (totalsBySource.get(source) ?? 0) + actionableCount);
    }
  }

  const series: DashboardTimelineSeries[] = SCAN_SOURCE_ORDER
    .map((source) => ({
      key: source,
      label: getFindingSourceLabel(source),
      color: DASHBOARD_SOURCE_TIMELINE_COLORS[source],
      total: totalsBySource.get(source) ?? 0,
    }))
    .filter((entry) => entry.total > 0);

  return series.length > 0
    ? { series, points: buildCumulativeDashboardTimelinePoints(points, series.map((entry) => entry.key)) }
    : null;
}

export function buildDashboardThemeTimeline(scans: DashboardTimelineScanSource[]): DashboardTimeline | null {
  const points = getSortedDashboardTimelinePoints(scans);
  const pointByScanId = new Map(points.map((point) => [point.scanId, point]));
  const totalsByTheme = new Map<string, number>();
  const countsByScanId = new Map<string, Map<string, number>>();

  for (const scan of scans) {
    for (const entry of scan.dashboardBreakdowns?.theme ?? []) {
      const actionableCount = entry.high + entry.medium + entry.low;
      if (actionableCount <= 0) continue;

      const scanCounts = countsByScanId.get(scan.id) ?? new Map<string, number>();
      scanCounts.set(entry.key, actionableCount);
      countsByScanId.set(scan.id, scanCounts);
      totalsByTheme.set(entry.key, (totalsByTheme.get(entry.key) ?? 0) + actionableCount);
    }
  }

  const rankedThemes = [...totalsByTheme.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  if (rankedThemes.length === 0) {
    return null;
  }

  const series: DashboardTimelineSeries[] = rankedThemes.map(([label, total], index) => ({
    key: buildDashboardTimelineSeriesKey('theme', index),
    label,
    color: DASHBOARD_THEME_TIMELINE_COLORS[index % DASHBOARD_THEME_TIMELINE_COLORS.length],
    total,
  }));

  const seriesKeyByTheme = new Map(series.map((entry) => [entry.label, entry.key]));

  for (const [scanId, themeCounts] of countsByScanId.entries()) {
    const point = pointByScanId.get(scanId);
    if (!point) continue;

    for (const [themeLabel, count] of themeCounts.entries()) {
      const seriesKey = seriesKeyByTheme.get(themeLabel);
      if (seriesKey) {
        point.values[seriesKey] = count;
      }
    }
  }

  return {
    series,
    points: buildCumulativeDashboardTimelinePoints(points, series.map((entry) => entry.key)),
  };
}
