import type {
  DashboardBreakdownCategory,
  DashboardBreakdownRow,
  DashboardMetricTotals,
  Finding,
  FindingSource,
  ScanSummary,
  ScanStatus,
} from './types';
import { getFindingSourceLabel } from './scan-sources';

export const TERMINAL_DASHBOARD_SCAN_STATUSES: ScanStatus[] = ['completed', 'cancelled', 'failed'];
export const UNLABELLED_DASHBOARD_BREAKDOWN_BUCKET = 'Unlabelled';

type DashboardFindingRecord = Pick<Finding, 'scanId' | 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'theme'>;
type DashboardSourceFindingRecord = Pick<Finding, 'scanId' | 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'source'>;
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
