import type {
  DashboardBreakdownCategory,
  DashboardBreakdownRow,
  DashboardMetricTotals,
  DashboardTimeline,
  DashboardTimelinePoint,
  DashboardTimelineSeries,
  Finding,
  FindingSource,
  ScanSummary,
  ScanStatus,
} from './types';
import { getFindingSourceLabel, SCAN_SOURCE_ORDER } from './scan-sources';

export const TERMINAL_DASHBOARD_SCAN_STATUSES: ScanStatus[] = ['completed', 'cancelled', 'failed'];
export const UNLABELLED_DASHBOARD_BREAKDOWN_BUCKET = 'Unlabelled';

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

type DashboardFindingRecord = Pick<Finding, 'scanId' | 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'theme'>;
type DashboardSourceFindingRecord = Pick<Finding, 'scanId' | 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'source'>;
type DashboardTimelineFindingRecord = Pick<Finding, 'scanId' | 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'source' | 'theme'>;
type DashboardCountSource = Pick<ScanSummary, 'highCount' | 'mediumCount' | 'lowCount' | 'nonHitCount'>;

export function emptyDashboardMetricTotals(): DashboardMetricTotals {
  return {
    high: 0,
    medium: 0,
    low: 0,
    nonHit: 0,
  };
}

function getDashboardActionableTotal(row: Pick<DashboardMetricTotals, 'high' | 'medium' | 'low'>): number {
  return row.high + row.medium + row.low;
}

function getDashboardActionableCategory(
  finding: DashboardFindingRecord,
): Exclude<DashboardBreakdownCategory, 'nonHit'> | null {
  const category = getDashboardFindingCategory(finding);
  return category && category !== 'nonHit' ? category : null;
}

function getSortedDashboardTimelinePoints(scans: ScanSummary[]): DashboardTimelinePoint[] {
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

export function getDashboardFindingCategory(finding: DashboardFindingRecord): DashboardBreakdownCategory | null {
  if (finding.isFalsePositive) {
    return 'nonHit';
  }

  if (finding.isIgnored || finding.isAddressed) {
    return null;
  }

  return finding.severity;
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
  findings: DashboardFindingRecord[],
  scanOrderById?: ReadonlyMap<string, number>,
): DashboardBreakdownRow[] {
  const rows = new Map<string, DashboardBreakdownRow>();

  for (const finding of findings) {
    const category = getDashboardFindingCategory(finding);
    if (!category) continue;

    const label = finding.theme?.trim() ? finding.theme.trim() : UNLABELLED_DASHBOARD_BREAKDOWN_BUCKET;
    const existing = rows.get(label) ?? {
      label,
      filterValue: label,
      ...emptyDashboardMetricTotals(),
      total: 0,
      drilldownScanIds: {},
    };

    existing[category] += 1;
    existing.total += 1;

    const currentDrilldownScanId = existing.drilldownScanIds?.[category];
    const nextScanOrder = scanOrderById?.get(finding.scanId) ?? Number.POSITIVE_INFINITY;
    const currentScanOrder = currentDrilldownScanId
      ? (scanOrderById?.get(currentDrilldownScanId) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;

    if (!currentDrilldownScanId || nextScanOrder < currentScanOrder) {
      existing.drilldownScanIds = {
        ...existing.drilldownScanIds,
        [category]: finding.scanId,
      };
    }

    rows.set(label, existing);
  }

  return [...rows.values()].sort((left, right) => (
    getDashboardActionableTotal(right) - getDashboardActionableTotal(left)
    || right.total - left.total
    || left.label.localeCompare(right.label)
  ));
}

export function buildDashboardSourceBreakdownRows(
  findings: DashboardSourceFindingRecord[],
  scanOrderById?: ReadonlyMap<string, number>,
): DashboardBreakdownRow[] {
  const rows = new Map<FindingSource, DashboardBreakdownRow>();

  for (const finding of findings) {
    const category = getDashboardFindingCategory(finding);
    if (!category) continue;

    const existing = rows.get(finding.source) ?? {
      label: getFindingSourceLabel(finding.source),
      filterValue: finding.source,
      ...emptyDashboardMetricTotals(),
      total: 0,
      drilldownScanIds: {},
    };

    existing[category] += 1;
    existing.total += 1;

    const currentDrilldownScanId = existing.drilldownScanIds?.[category];
    const nextScanOrder = scanOrderById?.get(finding.scanId) ?? Number.POSITIVE_INFINITY;
    const currentScanOrder = currentDrilldownScanId
      ? (scanOrderById?.get(currentDrilldownScanId) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;

    if (!currentDrilldownScanId || nextScanOrder < currentScanOrder) {
      existing.drilldownScanIds = {
        ...existing.drilldownScanIds,
        [category]: finding.scanId,
      };
    }

    rows.set(finding.source, existing);
  }

  return [...rows.values()].sort((left, right) => (
    getDashboardActionableTotal(right) - getDashboardActionableTotal(left)
    || right.total - left.total
    || left.label.localeCompare(right.label)
  ));
}

export function buildDashboardSourceTimeline(
  scans: ScanSummary[],
  findings: DashboardTimelineFindingRecord[],
): DashboardTimeline | null {
  const points = getSortedDashboardTimelinePoints(scans);
  const pointByScanId = new Map(points.map((point) => [point.scanId, point]));
  const totalsBySource = new Map<Exclude<FindingSource, 'unknown'>, number>();

  for (const finding of findings) {
    if (finding.source === 'unknown') continue;
    if (!getDashboardActionableCategory(finding)) continue;

    const point = pointByScanId.get(finding.scanId);
    if (!point) continue;

    point.values[finding.source] = (point.values[finding.source] ?? 0) + 1;
    totalsBySource.set(finding.source, (totalsBySource.get(finding.source) ?? 0) + 1);
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

export function buildDashboardThemeTimeline(
  scans: ScanSummary[],
  findings: DashboardTimelineFindingRecord[],
): DashboardTimeline | null {
  const points = getSortedDashboardTimelinePoints(scans);
  const pointByScanId = new Map(points.map((point) => [point.scanId, point]));
  const totalsByTheme = new Map<string, number>();
  const countsByScanId = new Map<string, Map<string, number>>();

  for (const finding of findings) {
    if (!getDashboardActionableCategory(finding)) continue;

    const point = pointByScanId.get(finding.scanId);
    if (!point) continue;

    const themeLabel = finding.theme?.trim() ? finding.theme.trim() : UNLABELLED_DASHBOARD_BREAKDOWN_BUCKET;
    const scanCounts = countsByScanId.get(finding.scanId) ?? new Map<string, number>();
    scanCounts.set(themeLabel, (scanCounts.get(themeLabel) ?? 0) + 1);
    countsByScanId.set(finding.scanId, scanCounts);
    totalsByTheme.set(themeLabel, (totalsByTheme.get(themeLabel) ?? 0) + 1);
  }

  const rankedThemes = [...totalsByTheme.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  if (rankedThemes.length === 0) {
    return null;
  }

  const includedThemeLabels = new Set(rankedThemes.map(([label]) => label));

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
      if (seriesKey && includedThemeLabels.has(themeLabel)) {
        point.values[seriesKey] = count;
      }
    }
  }

  return {
    series,
    points: buildCumulativeDashboardTimelinePoints(points, series.map((entry) => entry.key)),
  };
}
