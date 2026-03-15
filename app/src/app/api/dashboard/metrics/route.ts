import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import {
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
  isScanDeletionActive,
} from '@/lib/async-deletions';
import {
  buildDashboardBreakdownRows,
  buildDashboardMetricTotalsFromScans,
  buildDashboardSourceTimeline,
  buildDashboardSourceBreakdownRows,
  buildDashboardThemeTimeline,
  hasCurrentDashboardBreakdowns,
  TERMINAL_DASHBOARD_SCAN_STATUSES,
} from '@/lib/dashboard';
import { rebuildAndPersistDashboardBreakdownsForScanIds } from '@/lib/dashboard-aggregates';
import { isScanInProgress, scanFromSnapshot } from '@/lib/scans';
import type {
  BrandProfile,
  DashboardActiveScanSummary,
  DashboardMetricsData,
  Scan,
  ScanSummary,
} from '@/lib/types';

export async function GET(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const brandId = request.nextUrl.searchParams.get('brandId');
  const scanId = request.nextUrl.searchParams.get('scanId');

  if (!brandId) {
    return errorResponse('brandId is required');
  }

  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);

  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(brand)) {
    return errorResponse('Brand not found', 404);
  }
  const historyDeletionInProgress = isBrandHistoryDeletionActive(brand);

  const scansSnap = await db
    .collection('scans')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid)
    .orderBy('startedAt', 'desc')
    .select(
      'status',
      'startedAt',
      'completedAt',
      'highCount',
      'mediumCount',
      'lowCount',
      'nonHitCount',
      'ignoredCount',
      'addressedCount',
      'skippedCount',
      'aiSummary',
      'dashboardBreakdowns',
    )
    .get();

  const allScans = scansSnap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<Scan, 'id'>),
  }));

  const terminalDashboardScans: Scan[] = (historyDeletionInProgress ? [] : allScans)
    .filter((scan) => !isScanDeletionActive(scan))
    .filter((scan) => TERMINAL_DASHBOARD_SCAN_STATUSES.includes(scan.status));

  const terminalScans: ScanSummary[] = terminalDashboardScans.map((scan) => ({
    id: scan.id,
    status: scan.status,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    highCount: scan.highCount ?? 0,
    mediumCount: scan.mediumCount ?? 0,
    lowCount: scan.lowCount ?? 0,
    nonHitCount: scan.nonHitCount ?? 0,
    ignoredCount: scan.ignoredCount ?? 0,
    addressedCount: scan.addressedCount ?? 0,
    skippedCount: scan.skippedCount ?? 0,
    aiSummary: scan.aiSummary,
  }));
  const scanOrderById = new Map(terminalScans.map((scan, index) => [scan.id, index]));

  let selectedScanId: string | null = null;
  let selectedScanSummaries = terminalScans;
  let selectedDashboardScans = terminalDashboardScans;

  if (scanId) {
    const selectedScan = terminalScans.find((scan) => scan.id === scanId);
    if (selectedScan) {
      selectedScanId = selectedScan.id;
      selectedScanSummaries = [selectedScan];
      selectedDashboardScans = terminalDashboardScans.filter((scan) => scan.id === selectedScan.id);
    }
  }

  const dashboardScansToEnsure = selectedScanId ? selectedDashboardScans : terminalDashboardScans;
  const missingDashboardScanIds = dashboardScansToEnsure
    .filter((scan) => !hasCurrentDashboardBreakdowns(scan))
    .map((scan) => scan.id);

  if (missingDashboardScanIds.length > 0) {
    const rebuiltBreakdowns = await rebuildAndPersistDashboardBreakdownsForScanIds({
      brandId,
      userId: uid,
      scanIds: missingDashboardScanIds,
    });

    for (const scan of terminalDashboardScans) {
      const dashboardBreakdowns = rebuiltBreakdowns.get(scan.id);
      if (dashboardBreakdowns) {
        scan.dashboardBreakdowns = dashboardBreakdowns;
      }
    }
  }

  let activeScan: DashboardActiveScanSummary | null = null;
  if (brand.activeScanId) {
    const activeScanDoc = await db.collection('scans').doc(brand.activeScanId).get();
    if (activeScanDoc.exists) {
      const scan = scanFromSnapshot(activeScanDoc);
      if (scan.brandId === brandId && scan.userId === uid && isScanInProgress(scan.status)) {
        activeScan = {
          id: scan.id,
          status: scan.status,
          startedAt: scan.startedAt,
        };
      }
    }
  }

  const data: DashboardMetricsData = {
    brandId,
    selectedScanId,
    selectedBrandScanCount: terminalScans.length,
    ...(allScans[0]?.startedAt ? { selectedBrandLastScanStartedAt: allScans[0].startedAt } : {}),
    selectedBrandIsScanInProgress: activeScan !== null,
    hasTerminalScans: terminalScans.length > 0,
    activeScan,
    scanOptions: terminalScans,
    totals: buildDashboardMetricTotalsFromScans(selectedScanSummaries),
    sourceBreakdown: buildDashboardSourceBreakdownRows(selectedDashboardScans, scanOrderById),
    themeBreakdown: buildDashboardBreakdownRows(selectedDashboardScans, scanOrderById),
    sourceTimeline: selectedScanId ? null : buildDashboardSourceTimeline(terminalDashboardScans),
    themeTimeline: selectedScanId ? null : buildDashboardThemeTimeline(terminalDashboardScans),
    dashboardExecutiveSummary: historyDeletionInProgress || selectedScanId
      ? null
      : brand.dashboardExecutiveSummary ?? null,
  };

  return NextResponse.json({ data });
}
