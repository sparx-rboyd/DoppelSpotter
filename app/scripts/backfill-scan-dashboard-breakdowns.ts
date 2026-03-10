/**
 * Backfill script: compute and persist scan-level dashboard source/theme breakdowns
 * for existing scan documents.
 *
 * Usage (from the app/ directory):
 *   npm run backfill-scan-dashboard-breakdowns
 *   npm run backfill-scan-dashboard-breakdowns -- --force
 *
 * Safe to run multiple times. By default it only updates scans missing the current
 * dashboard breakdown shape/version. Pass --force to rebuild all scans.
 *
 * Reads env vars from .env.local (same file used by `next dev`).
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Scan } from '../src/lib/types';

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

const force = process.argv.includes('--force');
const GROUP_BATCH_SIZE = 100;

async function main() {
  const [
    { rebuildAndPersistDashboardBreakdownsForScanIds },
    { DASHBOARD_SCAN_BREAKDOWNS_VERSION },
    { db },
  ] = await Promise.all([
    import('../src/lib/dashboard-aggregates'),
    import('../src/lib/dashboard'),
    import('../src/lib/firestore'),
  ]);

  console.log(`Fetching scans…${force ? ' (--force: will rebuild all)' : ''}`);

  const scansSnap = await db
    .collection('scans')
    .select('brandId', 'userId', 'dashboardBreakdowns')
    .get();

  const candidates = force
    ? scansSnap.docs
    : scansSnap.docs.filter((doc) => {
        const scan = doc.data() as Pick<Scan, 'dashboardBreakdowns'>;
        return scan.dashboardBreakdowns?.version !== DASHBOARD_SCAN_BREAKDOWNS_VERSION
          || !Array.isArray(scan.dashboardBreakdowns?.source)
          || !Array.isArray(scan.dashboardBreakdowns?.theme);
      });

  if (candidates.length === 0) {
    console.log('All scans already have current dashboard breakdowns. Nothing to do.');
    return;
  }

  console.log(`Rebuilding dashboard breakdowns for ${candidates.length} scan(s)…`);

  const groups = new Map<string, { brandId: string; userId: string; scanIds: string[] }>();
  for (const doc of candidates) {
    const scan = doc.data() as Pick<Scan, 'brandId' | 'userId'>;
    if (!scan.brandId || !scan.userId) continue;

    const groupKey = `${scan.brandId}::${scan.userId}`;
    const current = groups.get(groupKey) ?? { brandId: scan.brandId, userId: scan.userId, scanIds: [] };
    current.scanIds.push(doc.id);
    groups.set(groupKey, current);
  }

  let processed = 0;
  for (const group of groups.values()) {
    for (let index = 0; index < group.scanIds.length; index += GROUP_BATCH_SIZE) {
      const scanIds = group.scanIds.slice(index, index + GROUP_BATCH_SIZE);
      await rebuildAndPersistDashboardBreakdownsForScanIds({
        brandId: group.brandId,
        userId: group.userId,
        scanIds,
      });
      processed += scanIds.length;
      console.log(`  Rebuilt ${processed} / ${candidates.length}`);
    }
  }

  console.log(`Done. Updated ${processed} scan(s).`);
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
