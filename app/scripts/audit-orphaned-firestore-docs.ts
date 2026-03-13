/**
 * Firestore audit script: detect orphaned scan and finding documents.
 *
 * Usage (from the app/ directory):
 *   npm run audit-orphaned-firestore-docs
 *   npm run audit-orphaned-firestore-docs -- --sample-limit 20
 *
 * The script is read-only. It reports:
 * - scans whose referenced brand or user document is missing
 * - scans whose brand exists but belongs to a different user
 * - findings whose referenced scan, brand, or user document is missing
 * - findings whose scan/brand ownership metadata no longer lines up
 *
 * Reads env vars from .env.local (same file used by `next dev`).
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DocumentData, QueryDocumentSnapshot } from '@google-cloud/firestore';

const envLocalPath = resolve(process.cwd(), '.env.local');
if (existsSync(envLocalPath)) {
  const lines = readFileSync(envLocalPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseNumberArg(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;

  const raw = process.argv[index + 1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const sampleLimit = parseNumberArg('--sample-limit', 10);

type MinimalUser = {
  id: string;
};

type MinimalBrand = {
  id: string;
  userId?: string;
};

type MinimalScan = {
  id: string;
  brandId?: string;
  userId?: string;
};

type MinimalFinding = {
  id: string;
  brandId?: string;
  scanId?: string;
  userId?: string;
};

type ScanIssueType =
  | 'missing_brand'
  | 'missing_user'
  | 'brand_user_mismatch'
  | 'missing_brand_id'
  | 'missing_user_id';

type FindingIssueType =
  | 'missing_scan'
  | 'missing_brand'
  | 'missing_user'
  | 'scan_brand_mismatch'
  | 'scan_user_mismatch'
  | 'brand_user_mismatch'
  | 'missing_scan_id'
  | 'missing_brand_id'
  | 'missing_user_id';

type ScanIssue = {
  scanId: string;
  type: ScanIssueType;
  brandId?: string;
  userId?: string;
  brandUserId?: string;
};

type FindingIssue = {
  findingId: string;
  type: FindingIssueType;
  scanId?: string;
  brandId?: string;
  userId?: string;
  scanBrandId?: string;
  scanUserId?: string;
  brandUserId?: string;
};

function toRecord<T>(docs: QueryDocumentSnapshot<DocumentData>[], mapper: (doc: QueryDocumentSnapshot<DocumentData>) => T & { id: string }) {
  return new Map<string, T & { id: string }>(docs.map((doc) => {
    const value = mapper(doc);
    return [value.id, value];
  }));
}

function groupCount<T extends { type: string }>(issues: T[]) {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function printIssueSection<T extends { type: string }>(
  label: string,
  issues: T[],
  renderIssue: (issue: T) => string,
) {
  console.log(`\n${label}: ${issues.length}`);

  if (issues.length === 0) {
    console.log('  none');
    return;
  }

  for (const [type, count] of groupCount(issues)) {
    console.log(`  - ${type}: ${count}`);
  }

  console.log(`  Sample (${Math.min(sampleLimit, issues.length)}):`);
  for (const issue of issues.slice(0, sampleLimit)) {
    console.log(`    ${renderIssue(issue)}`);
  }
}

async function main() {
  const { db } = await import('../src/lib/firestore');

  console.log(`Loading Firestore references (sample limit: ${sampleLimit})…`);

  const [usersSnap, brandsSnap, scansSnap, findingsSnap] = await Promise.all([
    db.collection('users').select('createdAt').get(),
    db.collection('brands').select('userId').get(),
    db.collection('scans').select('brandId', 'userId').get(),
    db.collection('findings').select('brandId', 'scanId', 'userId').get(),
  ]);

  console.log(`Users: ${usersSnap.size}`);
  console.log(`Brands: ${brandsSnap.size}`);
  console.log(`Scans: ${scansSnap.size}`);
  console.log(`Findings: ${findingsSnap.size}`);

  const usersById = toRecord<MinimalUser>(usersSnap.docs, (doc) => ({ id: doc.id }));
  const brandsById = toRecord<MinimalBrand>(brandsSnap.docs, (doc) => {
    const data = doc.data() as { userId?: string };
    return { id: doc.id, userId: data.userId };
  });
  const scansById = toRecord<MinimalScan>(scansSnap.docs, (doc) => {
    const data = doc.data() as { brandId?: string; userId?: string };
    return { id: doc.id, brandId: data.brandId, userId: data.userId };
  });

  const scanIssues: ScanIssue[] = [];
  for (const scan of scansById.values()) {
    const brand = scan.brandId ? brandsById.get(scan.brandId) : undefined;
    const user = scan.userId ? usersById.get(scan.userId) : undefined;

    if (!scan.brandId) {
      scanIssues.push({ scanId: scan.id, type: 'missing_brand_id', userId: scan.userId });
    } else if (!brand) {
      scanIssues.push({ scanId: scan.id, type: 'missing_brand', brandId: scan.brandId, userId: scan.userId });
    }

    if (!scan.userId) {
      scanIssues.push({ scanId: scan.id, type: 'missing_user_id', brandId: scan.brandId });
    } else if (!user) {
      scanIssues.push({ scanId: scan.id, type: 'missing_user', brandId: scan.brandId, userId: scan.userId });
    }

    if (brand?.userId && scan.userId && brand.userId !== scan.userId) {
      scanIssues.push({
        scanId: scan.id,
        type: 'brand_user_mismatch',
        brandId: scan.brandId,
        userId: scan.userId,
        brandUserId: brand.userId,
      });
    }
  }

  const findingIssues: FindingIssue[] = [];
  for (const findingDoc of findingsSnap.docs) {
    const finding = { id: findingDoc.id, ...(findingDoc.data() as Omit<MinimalFinding, 'id'>) };
    const brand = finding.brandId ? brandsById.get(finding.brandId) : undefined;
    const scan = finding.scanId ? scansById.get(finding.scanId) : undefined;
    const user = finding.userId ? usersById.get(finding.userId) : undefined;

    if (!finding.scanId) {
      findingIssues.push({
        findingId: finding.id,
        type: 'missing_scan_id',
        brandId: finding.brandId,
        userId: finding.userId,
      });
    } else if (!scan) {
      findingIssues.push({
        findingId: finding.id,
        type: 'missing_scan',
        scanId: finding.scanId,
        brandId: finding.brandId,
        userId: finding.userId,
      });
    }

    if (!finding.brandId) {
      findingIssues.push({
        findingId: finding.id,
        type: 'missing_brand_id',
        scanId: finding.scanId,
        userId: finding.userId,
      });
    } else if (!brand) {
      findingIssues.push({
        findingId: finding.id,
        type: 'missing_brand',
        scanId: finding.scanId,
        brandId: finding.brandId,
        userId: finding.userId,
      });
    }

    if (!finding.userId) {
      findingIssues.push({
        findingId: finding.id,
        type: 'missing_user_id',
        scanId: finding.scanId,
        brandId: finding.brandId,
      });
    } else if (!user) {
      findingIssues.push({
        findingId: finding.id,
        type: 'missing_user',
        scanId: finding.scanId,
        brandId: finding.brandId,
        userId: finding.userId,
      });
    }

    if (scan?.brandId && finding.brandId && scan.brandId !== finding.brandId) {
      findingIssues.push({
        findingId: finding.id,
        type: 'scan_brand_mismatch',
        scanId: finding.scanId,
        brandId: finding.brandId,
        userId: finding.userId,
        scanBrandId: scan.brandId,
      });
    }

    if (scan?.userId && finding.userId && scan.userId !== finding.userId) {
      findingIssues.push({
        findingId: finding.id,
        type: 'scan_user_mismatch',
        scanId: finding.scanId,
        brandId: finding.brandId,
        userId: finding.userId,
        scanUserId: scan.userId,
      });
    }

    if (brand?.userId && finding.userId && brand.userId !== finding.userId) {
      findingIssues.push({
        findingId: finding.id,
        type: 'brand_user_mismatch',
        scanId: finding.scanId,
        brandId: finding.brandId,
        userId: finding.userId,
        brandUserId: brand.userId,
      });
    }
  }

  const orphanedScans = scanIssues.filter((issue) =>
    issue.type === 'missing_brand'
    || issue.type === 'missing_user'
    || issue.type === 'missing_brand_id'
    || issue.type === 'missing_user_id',
  );
  const orphanedFindings = findingIssues.filter((issue) =>
    issue.type === 'missing_scan'
    || issue.type === 'missing_brand'
    || issue.type === 'missing_user'
    || issue.type === 'missing_scan_id'
    || issue.type === 'missing_brand_id'
    || issue.type === 'missing_user_id',
  );

  console.log('\nSummary');
  console.log('-------');
  console.log(`Orphaned scans: ${orphanedScans.length}`);
  console.log(`Orphaned findings: ${orphanedFindings.length}`);
  console.log(`Scan integrity issues (including mismatches): ${scanIssues.length}`);
  console.log(`Finding integrity issues (including mismatches): ${findingIssues.length}`);

  printIssueSection('Scan issues', scanIssues, (issue) =>
    `scan=${issue.scanId} type=${issue.type} brandId=${issue.brandId ?? '-'} userId=${issue.userId ?? '-'} brandUserId=${issue.brandUserId ?? '-'}`,
  );
  printIssueSection('Finding issues', findingIssues, (issue) =>
    `finding=${issue.findingId} type=${issue.type} scanId=${issue.scanId ?? '-'} brandId=${issue.brandId ?? '-'} userId=${issue.userId ?? '-'} scanBrandId=${issue.scanBrandId ?? '-'} scanUserId=${issue.scanUserId ?? '-'} brandUserId=${issue.brandUserId ?? '-'}`,
  );

  if (scanIssues.length === 0 && findingIssues.length === 0) {
    console.log('\nNo orphaned or inconsistent scan/finding documents detected.');
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
