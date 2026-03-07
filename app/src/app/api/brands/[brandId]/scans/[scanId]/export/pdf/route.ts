import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import { buildScanExportPdfBuffer } from '@/lib/scan-export-pdf';
import {
  buildPdfFilename,
  loadScanExportData,
  type ScanExportError,
} from '@/lib/scan-exports';

type Params = { params: Promise<{ brandId: string; scanId: string }> };

export const runtime = 'nodejs';

// GET /api/brands/[brandId]/scans/[scanId]/export/pdf
// Downloads a branded PDF report for the scan's actionable and addressed findings.
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId, scanId } = await params;

  try {
    const exportData = await loadScanExportData({ uid, brandId, scanId });
    const pdf = await buildScanExportPdfBuffer(exportData);
    const filename = buildPdfFilename(exportData.brand.name, exportData.scan.startedAt);

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (caughtError) {
    const exportError = caughtError as ScanExportError;
    if (exportError?.name === 'ScanExportError') {
      return errorResponse(exportError.message, exportError.status);
    }
    throw caughtError;
  }
}
