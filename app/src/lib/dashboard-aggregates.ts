import { db } from './firestore';
import { runWriteBatchInChunks } from './firestore-batches';
import { buildDashboardScanBreakdowns } from './dashboard';
import type { DashboardScanBreakdowns, Finding } from './types';

type DashboardAggregateFindingRecord = Pick<
  Finding,
  'scanId' | 'brandId' | 'userId' | 'source' | 'theme' | 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed'
>;

type RebuildDashboardBreakdownsParams = {
  brandId: string;
  userId: string;
  scanIds: string[];
};

const SCAN_ID_QUERY_CHUNK_SIZE = 10;

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export async function rebuildAndPersistDashboardBreakdownsForScanIds(
  params: RebuildDashboardBreakdownsParams,
): Promise<Map<string, DashboardScanBreakdowns>> {
  const requestedScanIds = [...new Set(params.scanIds.filter((scanId) => scanId.trim().length > 0))];
  const breakdownsByScanId = new Map<string, DashboardScanBreakdowns>();

  if (requestedScanIds.length === 0) {
    return breakdownsByScanId;
  }

  const findingsByScanId = new Map<string, DashboardAggregateFindingRecord[]>();
  for (const scanId of requestedScanIds) {
    findingsByScanId.set(scanId, []);
  }

  for (const scanIdChunk of chunkValues(requestedScanIds, SCAN_ID_QUERY_CHUNK_SIZE)) {
    const findingsSnap = await db
      .collection('findings')
      .where('scanId', 'in', scanIdChunk)
      .select('scanId', 'brandId', 'userId', 'source', 'theme', 'severity', 'isFalsePositive', 'isIgnored', 'isAddressed')
      .get();

    for (const doc of findingsSnap.docs) {
      const finding = doc.data() as DashboardAggregateFindingRecord;
      if (finding.brandId !== params.brandId || finding.userId !== params.userId) {
        continue;
      }

      const scanFindings = findingsByScanId.get(finding.scanId);
      if (scanFindings) {
        scanFindings.push(finding);
      }
    }
  }

  for (const [scanId, findings] of findingsByScanId.entries()) {
    breakdownsByScanId.set(scanId, buildDashboardScanBreakdowns(findings));
  }

  await runWriteBatchInChunks(requestedScanIds, (batch, scanId) => {
    batch.update(db.collection('scans').doc(scanId), {
      dashboardBreakdowns: breakdownsByScanId.get(scanId) ?? buildDashboardScanBreakdowns([]),
    });
  });

  return breakdownsByScanId;
}
