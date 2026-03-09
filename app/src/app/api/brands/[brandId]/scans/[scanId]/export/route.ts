import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import {
  buildCsvFilename,
  filterNonHitFindingsFromExport,
  formatBoolean,
  formatFindingSource,
  formatScanDateTimeIso,
  formatSeverity,
  loadScanExportData,
  orderFindingsForExport,
  type ExportableFinding,
  type ScanExportError,
} from '@/lib/scan-exports';

type Params = { params: Promise<{ brandId: string; scanId: string }> };

const CSV_COLUMNS = [
  'Scan date/time',
  'Scan type',
  'Severity',
  'Theme',
  'Title',
  'URL',
  'AI analysis',
  'Notes',
  'Is addressed',
  'Is bookmarked',
  'Is ignored',
] as const;

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `"${normalized.replace(/"/g, '""')}"`;
}

function serializeCsvRow(values: string[]): string {
  return values.map(escapeCsvCell).join(',');
}

// GET /api/brands/[brandId]/scans/[scanId]/export
// Downloads a CSV export of the scan's findings, excluding AI-classified non-hits.
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId, scanId } = await params;

  try {
    const { brand, scan, findings } = await loadScanExportData({ uid, brandId, scanId });
    const scanDateTime = formatScanDateTimeIso(scan.startedAt);
    const orderedFindings = orderFindingsForExport(filterNonHitFindingsFromExport(findings));

    const rows = orderedFindings.map((finding: ExportableFinding) => serializeCsvRow([
      scanDateTime,
      formatFindingSource(finding),
      formatSeverity(finding),
      finding.theme ?? '',
      finding.title,
      finding.url ?? '',
      finding.llmAnalysis,
      finding.bookmarkNote ?? '',
      formatBoolean(finding.isAddressed),
      formatBoolean(finding.isBookmarked),
      formatBoolean(finding.isIgnored),
    ]));

    const csv = `\uFEFF${serializeCsvRow([...CSV_COLUMNS])}\r\n${rows.join('\r\n')}`;
    const filename = buildCsvFilename(brand.name, scan.startedAt);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const exportError = error as ScanExportError;
    if (exportError?.name === 'ScanExportError') {
      return errorResponse(exportError.message, exportError.status);
    }
    throw error;
  }
}
