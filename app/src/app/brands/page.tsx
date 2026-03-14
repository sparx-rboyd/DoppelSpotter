'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePageTitle } from '@/lib/use-page-title';
import Link from 'next/link';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronRight, ListOrdered, Plus, Shield } from 'lucide-react';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SelectDropdown, type SelectDropdownOption } from '@/components/ui/select-dropdown';
import { formatScheduledRunAtShort } from '@/lib/scan-schedules';
import type { BrandSummary } from '@/lib/types';
import { cn, formatDate, formatInteger } from '@/lib/utils';

type BrandSortField = 'last_scan_date' | 'date_created' | 'alphabetical';
type SortDirection = 'asc' | 'desc';

const BRAND_SORT_OPTIONS: SelectDropdownOption[] = [
  { value: 'last_scan_date', label: 'Last scan date' },
  { value: 'date_created', label: 'Date created' },
  { value: 'alphabetical', label: 'Alphabetically' },
];

function getComparableDateMs(
  value: BrandSummary['lastScanStartedAt'] | BrandSummary['createdAt'] | Date | string | number | undefined,
): number | null {
  if (!value) return null;

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    const parsed = (value as { toDate(): Date }).toDate().getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  if ('_seconds' in value && typeof value._seconds === 'number') {
    return value._seconds * 1000;
  }

  if ('seconds' in value && typeof value.seconds === 'number') {
    return value.seconds * 1000;
  }

  return null;
}

function compareOptionalDates(
  a: BrandSummary['lastScanStartedAt'] | BrandSummary['createdAt'] | undefined,
  b: BrandSummary['lastScanStartedAt'] | BrandSummary['createdAt'] | undefined,
  direction: SortDirection,
): number {
  const aMs = getComparableDateMs(a);
  const bMs = getComparableDateMs(b);

  if (aMs === null && bMs === null) return 0;
  if (aMs === null) return 1;
  if (bMs === null) return -1;

  const difference = aMs - bMs;
  return direction === 'asc' ? difference : -difference;
}

function sortBrands(brands: BrandSummary[], field: BrandSortField, direction: SortDirection): BrandSummary[] {
  return [...brands].sort((a, b) => {
    if (field === 'alphabetical') {
      const nameComparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (nameComparison !== 0) {
        return direction === 'asc' ? nameComparison : -nameComparison;
      }
    }

    if (field === 'date_created') {
      const createdAtComparison = compareOptionalDates(a.createdAt, b.createdAt, direction);
      if (createdAtComparison !== 0) {
        return createdAtComparison;
      }
    }

    if (field === 'last_scan_date') {
      const lastScanComparison = compareOptionalDates(a.lastScanStartedAt, b.lastScanStartedAt, direction);
      if (lastScanComparison !== 0) {
        return lastScanComparison;
      }
    }

    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function getScanStatusLabel(brand: BrandSummary): string {
  if (brand.isScanInProgress) return 'Scan in progress';

  const lastScanLabel = brand.lastScanStartedAt
    ? `Last scan: ${formatDate(brand.lastScanStartedAt)}`
    : 'No scans performed yet';

  if (!brand.scanSchedule?.enabled) return lastScanLabel;

  return `${lastScanLabel} · Next scan: ${formatScheduledRunAtShort(
    brand.scanSchedule.nextRunAt,
    brand.scanSchedule.timeZone,
  )}`;
}

export default function BrandsPage() {
  usePageTitle('Brands');
  const [brands, setBrands] = useState<BrandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortField, setSortField] = useState<BrandSortField>('last_scan_date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  useEffect(() => {
    async function fetchBrands() {
      setError('');
      setLoading(true);
      try {
        const res = await fetch('/api/brands', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Failed to load brands');
        const json = await res.json();
        setBrands(json.data ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    fetchBrands();
  }, []);

  const sortedBrands = useMemo(
    () => sortBrands(brands, sortField, sortDirection),
    [brands, sortDirection, sortField],
  );

  return (
    <AuthGuard>
      <Navbar />
      <main className="min-h-screen bg-gray-50 pt-16 lg:pt-[4.5rem]">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8 lg:py-10 xl:max-w-[88rem]">
          <div className="mb-8 flex items-center justify-between lg:mb-8">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Brands</h1>
              <p className="text-sm text-gray-500 mt-0.5">Manage the brands you&apos;re monitoring</p>
            </div>
            <Link href="/brands/new">
              <Button size="sm">
                <Plus className="w-4 h-4" />
                Add Brand
              </Button>
            </Link>
          </div>

          {loading && (
            <div className="flex justify-center py-16">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
              {error}
            </p>
          )}

          {!loading && !error && brands.length === 0 && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
                <div className="w-12 h-12 bg-brand-50 rounded-xl flex items-center justify-center">
                  <Shield className="w-6 h-6 text-brand-600" />
                </div>
                <div className="text-center">
                  <h3 className="font-semibold text-gray-900 mb-1">No brands yet</h3>
                  <p className="text-sm text-gray-500">Add your first brand to start monitoring the web for infringements.</p>
                </div>
                <Link href="/brands/new">
                  <Button>
                    <Plus className="w-4 h-4" />
                    Add your first brand
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {!loading && brands.length > 0 && (
            <div className="flex flex-col gap-4 lg:gap-5">
              <div className="flex justify-end">
                <div className="flex max-w-full items-center justify-end gap-2">
                  <div className="w-56 max-w-[calc(100vw-6rem)] sm:min-w-56 sm:max-w-none">
                    <SelectDropdown
                      id="brands-sort-field"
                      ariaLabel="Sort brands by"
                      value={sortField}
                      options={BRAND_SORT_OPTIONS}
                      onChange={(value) => setSortField(value as BrandSortField)}
                      buttonIcon={<ListOrdered className="h-4 w-4 text-brand-600" />}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))}
                    aria-label={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
                    title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                    className={cn(
                      'inline-flex h-[38px] w-[38px] items-center justify-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 lg:h-[46px] lg:w-[46px]',
                      'bg-white border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900',
                    )}
                  >
                    {sortDirection === 'asc' ? (
                      <ArrowUpNarrowWide className="h-4 w-4" />
                    ) : (
                      <ArrowDownWideNarrow className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              {sortedBrands.map((brand) => (
                <Link key={brand.id} href={`/brands/${brand.id}`}>
                  <Card className="hover:border-brand-300 transition cursor-pointer">
                    <CardContent className="flex items-center gap-4 py-4 lg:gap-5 lg:py-5">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 lg:h-11 lg:w-11 lg:rounded-xl">
                        <Shield className="h-5 w-5 text-brand-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 truncate">{brand.name}</h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {formatInteger(brand.scanCount)} scan{brand.scanCount !== 1 ? 's' : ''} · {formatInteger(brand.findingCount)} finding{brand.findingCount !== 1 ? 's' : ''} detected · {formatInteger(brand.nonHitCount)} non-hit{brand.nonHitCount !== 1 ? 's' : ''}
                        </p>
                        <p className={`text-xs mt-1 ${brand.isScanInProgress ? 'text-brand-600 font-medium' : 'text-gray-400'}`}>
                          {getScanStatusLabel(brand)}
                        </p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
