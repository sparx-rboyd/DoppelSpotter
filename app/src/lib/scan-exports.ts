import { capitalise } from './utils';
import { db } from './firestore';
import type { BrandProfile, Finding, Scan, Severity } from './types';
import { getFindingSourceLabel } from './scan-sources';

export type ExportTimestamp =
  | Date
  | { toDate(): Date }
  | { _seconds: number; _nanoseconds: number }
  | { seconds: number; nanoseconds: number };

export type ExportableFinding = Pick<
  Finding,
  | 'source'
  | 'severity'
  | 'title'
  | 'theme'
  | 'url'
  | 'llmAnalysis'
  | 'bookmarkNote'
  | 'isAddressed'
  | 'isBookmarked'
  | 'isIgnored'
  | 'isFalsePositive'
  | 'createdAt'
>;

export interface ScanExportData {
  brand: BrandProfile;
  scan: Scan;
  findings: ExportableFinding[];
}

export class ScanExportError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ScanExportError';
    this.status = status;
  }
}

const EXPORT_FINDING_FIELDS = [
  'source',
  'severity',
  'title',
  'theme',
  'url',
  'llmAnalysis',
  'bookmarkNote',
  'isAddressed',
  'isBookmarked',
  'isIgnored',
  'isFalsePositive',
  'createdAt',
] as const;

export function timestampToDate(value: ExportTimestamp): Date {
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate(): Date }).toDate();
  }
  if ('_seconds' in value) return new Date(value._seconds * 1000);
  if ('seconds' in value) return new Date(value.seconds * 1000);
  return value as Date;
}

export function formatScanDateTimeIso(value: ExportTimestamp): string {
  return timestampToDate(value).toISOString();
}

function sanitizeFilenamePart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || 'brand';
}

export function buildScanExportBaseFilename(brandName: string, startedAt: ExportTimestamp): string {
  const scanTimestamp = formatScanDateTimeIso(startedAt)
    .replace(/:/g, '-')
    .replace(/\.\d{3}Z$/, 'Z');

  return `${sanitizeFilenamePart(brandName)}-scan-${scanTimestamp}-findings`;
}

export function buildCsvFilename(brandName: string, startedAt: ExportTimestamp): string {
  return `${buildScanExportBaseFilename(brandName, startedAt)}.csv`;
}

export function buildPdfFilename(brandName: string, startedAt: ExportTimestamp): string {
  return `${buildScanExportBaseFilename(brandName, startedAt)}.pdf`;
}

export function formatSeverity(finding: Pick<Finding, 'severity' | 'isFalsePositive'>): string {
  return finding.isFalsePositive === true ? 'Non-hit' : capitalise(finding.severity);
}

export function formatFindingSource(finding: Pick<Finding, 'source'>): string {
  return getFindingSourceLabel(finding.source);
}

export function formatBoolean(value: boolean | undefined): string {
  return value === true ? 'Yes' : 'No';
}

export function getSeveritySortOrder(finding: Pick<Finding, 'severity' | 'isFalsePositive'>): number {
  if (finding.isFalsePositive === true) return 3;

  switch (finding.severity) {
    case 'high':
      return 0;
    case 'medium':
      return 1;
    case 'low':
    default:
      return 2;
  }
}

export function orderFindingsForExport(findings: ExportableFinding[]): ExportableFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const severityDelta = getSeveritySortOrder(a.finding) - getSeveritySortOrder(b.finding);
      if (severityDelta !== 0) return severityDelta;

      const createdAtDelta = timestampToDate(b.finding.createdAt).getTime() - timestampToDate(a.finding.createdAt).getTime();
      if (createdAtDelta !== 0) return createdAtDelta;

      return a.index - b.index;
    })
    .map(({ finding }) => finding);
}

export function filterActionableFindings(findings: ExportableFinding[]): ExportableFinding[] {
  return findings.filter((finding) => !finding.isFalsePositive && !finding.isIgnored && !finding.isAddressed);
}

export function filterAddressedFindings(findings: ExportableFinding[]): ExportableFinding[] {
  return findings.filter((finding) => !finding.isFalsePositive && !finding.isIgnored && finding.isAddressed === true);
}

export function groupFindingsBySeverity<T extends Pick<ExportableFinding, 'severity'>>(findings: T[]): Record<Severity, T[]> {
  return findings.reduce<Record<Severity, T[]>>(
    (acc, finding) => {
      acc[finding.severity].push(finding);
      return acc;
    },
    { high: [], medium: [], low: [] },
  );
}

export async function loadScanExportData({
  uid,
  brandId,
  scanId,
}: {
  uid: string;
  brandId: string;
  scanId: string;
}): Promise<ScanExportData> {
  const [brandDoc, scanDoc] = await Promise.all([
    db.collection('brands').doc(brandId).get(),
    db.collection('scans').doc(scanId).get(),
  ]);

  if (!brandDoc.exists) throw new ScanExportError('Brand not found', 404);
  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) throw new ScanExportError('Forbidden', 403);

  if (!scanDoc.exists) throw new ScanExportError('Scan not found', 404);
  const scan = scanDoc.data() as Scan;
  if (scan.userId !== uid || scan.brandId !== brandId) throw new ScanExportError('Scan not found', 404);

  const findingsSnapshot = await db
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid)
    .where('scanId', '==', scanId)
    .select(...EXPORT_FINDING_FIELDS)
    .orderBy('createdAt', 'desc')
    .get();

  return {
    brand,
    scan,
    findings: findingsSnapshot.docs.map((doc) => doc.data() as ExportableFinding),
  };
}
