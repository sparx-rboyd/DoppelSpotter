import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import {
  drainBrandDeletion,
  drainBrandHistoryDeletion,
  drainScanDeletion,
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
  TERMINAL_DASHBOARD_SCAN_STATUSES,
} from '@/lib/dashboard';
import { isScanInProgress, scanFromSnapshot } from '@/lib/scans';
import type {
  BrandProfile,
  DashboardActiveScanSummary,
  DashboardMetricsData,
  Finding,
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
    void drainBrandDeletion({ brandId, userId: uid }).catch(() => {
      // Non-critical
    });
    return errorResponse('Brand not found', 404);
  }
  if (isBrandHistoryDeletionActive(brand)) {
    void drainBrandHistoryDeletion({ brandId, userId: uid }).catch(() => {
      // Non-critical
    });
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
    )
    .get();

  const allScans = scansSnap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<Scan, 'id'>),
  }));
  const deletingScan = allScans.find((scan) => isScanDeletionActive(scan));
  if (deletingScan) {
    void drainScanDeletion({ brandId, scanId: deletingScan.id, userId: uid }).catch(() => {
      // Non-critical
    });
  }

  const terminalScans: ScanSummary[] = (historyDeletionInProgress ? [] : allScans)
    .filter((scan) => !isScanDeletionActive(scan))
    .filter((scan) => TERMINAL_DASHBOARD_SCAN_STATUSES.includes(scan.status))
    .map((scan) => ({
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
  let selectedScans = terminalScans;

  if (scanId) {
    const selectedScan = terminalScans.find((scan) => scan.id === scanId);
    if (selectedScan) {
      selectedScanId = selectedScan.id;
      selectedScans = [selectedScan];
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

  const terminalScanIds = new Set(terminalScans.map((scan) => scan.id));
  let findingsForBreakdown: Array<Pick<Finding, 'scanId' | 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'source' | 'theme'>> = [];

  if (!historyDeletionInProgress && selectedScans.length > 0) {
    let findingsQuery = db
      .collection('findings')
      .where('brandId', '==', brandId)
      .where('userId', '==', uid);

    if (selectedScanId) {
      findingsQuery = findingsQuery.where('scanId', '==', selectedScanId);
    }

    const findingsSnap = await findingsQuery
      .select('scanId', 'severity', 'isFalsePositive', 'isIgnored', 'isAddressed', 'source', 'theme')
      .get();

    findingsForBreakdown = findingsSnap.docs
      .map((doc) => doc.data() as Pick<Finding, 'scanId' | 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'source' | 'theme'>)
      .filter((finding) => selectedScanId ? true : terminalScanIds.has(finding.scanId));
  }

  const data: DashboardMetricsData = {
    brandId,
    selectedScanId,
    hasTerminalScans: terminalScans.length > 0,
    activeScan,
    scanOptions: terminalScans,
    totals: buildDashboardMetricTotalsFromScans(selectedScans),
    sourceBreakdown: buildDashboardSourceBreakdownRows(findingsForBreakdown, scanOrderById),
    themeBreakdown: buildDashboardBreakdownRows(findingsForBreakdown, scanOrderById),
    sourceTimeline: selectedScanId ? null : buildDashboardSourceTimeline(terminalScans, findingsForBreakdown),
    themeTimeline: selectedScanId ? null : buildDashboardThemeTimeline(terminalScans, findingsForBreakdown),
  };

  return NextResponse.json({ data });
}
