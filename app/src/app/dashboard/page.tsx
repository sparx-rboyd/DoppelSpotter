'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Building2,
  Info,
  Loader2,
  PlayCircle,
  SearchCheck,
  Shield,
} from 'lucide-react';
import { AuthGuard } from '@/components/auth-guard';
import { DashboardCtaCard } from '@/components/dashboard-cta-card';
import { DashboardMetricCard } from '@/components/dashboard-metric-card';
import { DashboardStackedBarChart } from '@/components/dashboard-stacked-bar-chart';
import { Navbar } from '@/components/navbar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { SelectDropdown } from '@/components/ui/select-dropdown';
import { UNLABELLED_DASHBOARD_BREAKDOWN_BUCKET } from '@/lib/dashboard';
import { formatDate, formatScanDate } from '@/lib/utils';
import type {
  BrandSummary,
  DashboardBreakdownCategory,
  DashboardBreakdownRow,
  DashboardBootstrapData,
  DashboardMetricsData,
  DashboardPreferenceUpdateInput,
  ScanSummary,
} from '@/lib/types';

const DASHBOARD_RETURN_TO_PARAM = 'returnTo';
const DASHBOARD_RETURN_TO_VALUE = 'dashboard';

async function readDashboardResponse<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(json.error ?? 'Request failed');
  }

  return (json.data ?? null) as T;
}

function buildScanScopeLabel(scan: ScanSummary): string {
  const baseLabel = formatScanDate(scan.startedAt);
  return scan.status === 'completed'
    ? baseLabel
    : `${baseLabel} (${scan.status})`;
}

function buildDashboardDrilldownCategoryParam(category: DashboardBreakdownCategory): string {
  return category === 'nonHit' ? 'non-hit' : category;
}

export default function DashboardPage() {
  const router = useRouter();
  const [brands, setBrands] = useState<BrandSummary[]>([]);
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [selectedScanId, setSelectedScanId] = useState('');
  const [metrics, setMetrics] = useState<DashboardMetricsData | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [bootstrapError, setBootstrapError] = useState('');
  const [metricsError, setMetricsError] = useState('');
  const [preferenceError, setPreferenceError] = useState('');

  const selectedBrand = useMemo(
    () => brands.find((brand) => brand.id === selectedBrandId) ?? null,
    [brands, selectedBrandId],
  );

  const brandOptions = useMemo(
    () => brands.map((brand) => ({ value: brand.id, label: brand.name })),
    [brands],
  );

  const scanOptions = useMemo(() => {
    const scopedScans = metrics?.scanOptions ?? [];
    return [
      { value: '', label: 'All scans' },
      ...scopedScans.map((scan) => ({
        value: scan.id,
        label: buildScanScopeLabel(scan),
      })),
    ];
  }, [metrics?.scanOptions]);

  const selectedScanSummary = useMemo(
    () => metrics?.scanOptions.find((scan) => scan.id === selectedScanId) ?? null,
    [metrics?.scanOptions, selectedScanId],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrap() {
      setBootstrapLoading(true);
      setBootstrapError('');

      try {
        const data = await readDashboardResponse<DashboardBootstrapData>('/api/dashboard/bootstrap', {
          credentials: 'same-origin',
        });
        if (cancelled) return;
        setBrands(data.brands ?? []);
        setSelectedBrandId(data.selectedBrandId);
      } catch (err) {
        if (cancelled) return;
        setBootstrapError(err instanceof Error ? err.message : 'Failed to load dashboard');
      } finally {
        if (!cancelled) {
          setBootstrapLoading(false);
        }
      }
    }

    void loadBootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!selectedBrandId) {
      setMetrics(null);
      setSelectedScanId('');
      return () => {
        cancelled = true;
      };
    }

    async function loadMetrics() {
      const resolvedBrandId = selectedBrandId;
      if (!resolvedBrandId) return;

      setMetricsLoading(true);
      setMetricsError('');

      const params = new URLSearchParams({ brandId: resolvedBrandId });
      if (selectedScanId) {
        params.set('scanId', selectedScanId);
      }

      try {
        const data = await readDashboardResponse<DashboardMetricsData>(`/api/dashboard/metrics?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (cancelled) return;

        setMetrics(data);
        setSelectedScanId(data.selectedScanId ?? '');
      } catch (err) {
        if (cancelled) return;
        setMetrics(null);
        setMetricsError(err instanceof Error ? err.message : 'Failed to load dashboard metrics');
      } finally {
        if (!cancelled) {
          setMetricsLoading(false);
        }
      }
    }

    void loadMetrics();
    return () => {
      cancelled = true;
    };
  }, [selectedBrandId, selectedScanId]);

  async function persistSelectedBrandPreference(nextBrandId: string) {
    try {
      setPreferenceError('');
      await readDashboardResponse<DashboardPreferenceUpdateInput>('/api/dashboard/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ selectedBrandId: nextBrandId }),
      });
    } catch (err) {
      setPreferenceError(err instanceof Error ? err.message : 'Failed to save dashboard preference');
    }
  }

  function handleBrandChange(nextBrandId: string) {
    setSelectedBrandId(nextBrandId);
    setSelectedScanId('');
    setMetrics(null);
    void persistSelectedBrandPreference(nextBrandId);
  }

  const selectedBrandHref = selectedBrand
    ? `/brands/${selectedBrand.id}?${new URLSearchParams({
      [DASHBOARD_RETURN_TO_PARAM]: DASHBOARD_RETURN_TO_VALUE,
    }).toString()}`
    : '/brands';
  const activeScopeLabel = selectedScanSummary
    ? `Focused on the scan from ${formatScanDate(selectedScanSummary.startedAt)}.`
    : selectedBrand
      ? `Covering all completed scans for ${selectedBrand.name}.`
      : 'Covering all completed scans.';

  function navigateToChartDrilldown(
    dimension: 'platform' | 'theme',
    category: DashboardBreakdownCategory,
    row: DashboardBreakdownRow,
  ) {
    if (!selectedBrand) return;

    const targetScanId = metrics?.selectedScanId ?? row.drilldownScanIds?.[category];
    const params = new URLSearchParams({
      category: buildDashboardDrilldownCategoryParam(category),
      [DASHBOARD_RETURN_TO_PARAM]: DASHBOARD_RETURN_TO_VALUE,
    });

    if (targetScanId) {
      params.set('scanResultSet', targetScanId);
    }

    if (row.label !== UNLABELLED_DASHBOARD_BREAKDOWN_BUCKET) {
      params.set(dimension, row.label);
    }

    const hash = targetScanId ? `#scan-result-set-${targetScanId}` : '';
    router.push(`/brands/${selectedBrand.id}?${params.toString()}${hash}`);
  }

  function navigateToMetricCardDrilldown(category: DashboardBreakdownCategory) {
    if (!selectedBrand) return;

    const params = new URLSearchParams({
      category: buildDashboardDrilldownCategoryParam(category),
      [DASHBOARD_RETURN_TO_PARAM]: DASHBOARD_RETURN_TO_VALUE,
    });

    if (metrics?.selectedScanId) {
      params.set('scanResultSet', metrics.selectedScanId);
    }

    const hash = metrics?.selectedScanId ? `#scan-result-set-${metrics.selectedScanId}` : '';
    router.push(`/brands/${selectedBrand.id}?${params.toString()}${hash}`);
  }

  return (
    <AuthGuard>
      <Navbar />

      <main className="min-h-screen bg-gray-50 pt-16">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          </div>

          {bootstrapLoading && (
            <div className="flex justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            </div>
          )}

          {!bootstrapLoading && bootstrapError && (
            <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              {bootstrapError}
            </p>
          )}

          {!bootstrapLoading && !bootstrapError && brands.length === 0 && (
            <DashboardCtaCard
              eyebrow="Get started"
              title="Create your first brand to get started"
              description="Add the brand you want DoppelSpotter to monitor, then run scans to build up analytics, themes, and platform insights."
              href="/brands/new"
              actionLabel="Create your first brand"
              icon={Shield}
            />
          )}

          {!bootstrapLoading && !bootstrapError && brands.length > 0 && selectedBrand && (
            <div className="space-y-6">
              <Card className="overflow-hidden border-brand-100">
                <div className="border-b border-brand-100 bg-brand-50/70 px-5 py-4">
                  <div className="w-full max-w-md">
                      <SelectDropdown
                        id="dashboard-brand-selector"
                        label={<span className="font-medium text-brand-700">Focused brand</span>}
                        ariaLabel="Select a brand to scope the dashboard"
                        value={selectedBrand.id}
                        options={brandOptions}
                        onChange={handleBrandChange}
                        searchable={brands.length > 8}
                        searchPlaceholder="Search brands"
                        buttonIcon={<Building2 className="h-4 w-4 text-brand-600" />}
                      />
                  </div>
                </div>
                <CardContent className="flex flex-wrap gap-2 p-5">
                  <Badge variant="brand">
                    {selectedBrand.scanCount} scan{selectedBrand.scanCount !== 1 ? 's' : ''}
                  </Badge>
                  <Badge variant="default">
                    {selectedBrand.findingCount} finding{selectedBrand.findingCount !== 1 ? 's' : ''}
                  </Badge>
                  <Badge variant="default">
                    {selectedBrand.nonHitCount} non-finding{selectedBrand.nonHitCount !== 1 ? 's' : ''}
                  </Badge>
                  {selectedBrand.lastScanStartedAt && (
                    <Badge variant="default">
                      Last scan {formatDate(selectedBrand.lastScanStartedAt)}
                    </Badge>
                  )}
                  {selectedBrand.isScanInProgress && (
                    <Badge variant="brand">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Scan in progress
                    </Badge>
                  )}
                </CardContent>
              </Card>

              {preferenceError && (
                <p className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  {preferenceError}
                </p>
              )}

              {metricsError && (
                <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                  {metricsError}
                </p>
              )}

              {metricsLoading && !metrics && (
                <div className="flex justify-center py-16">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
                </div>
              )}

              {!metricsLoading && metrics && !metrics.hasTerminalScans && (
                metrics.activeScan ? (
                  <DashboardCtaCard
                    eyebrow="First scan in progress"
                    title="Your first scan is underway"
                    description={`We started scanning ${selectedBrand.name} on ${formatDate(metrics.activeScan.startedAt)}. Open the brand page to follow progress and review results as soon as they land.`}
                    href={selectedBrandHref}
                    actionLabel="View scan progress"
                    icon={Loader2}
                    iconClassName="animate-spin"
                  />
                ) : (
                  <DashboardCtaCard
                    eyebrow="Ready to scan"
                    title="Run your first scan to get started"
                    description={`Kick off the first scan for ${selectedBrand.name} to populate the dashboard with severity totals, platform breakdowns, and theme insights.`}
                    href={selectedBrandHref}
                    actionLabel="Open brand and run scan"
                    icon={PlayCircle}
                  />
                )
              )}

              {metrics && metrics.hasTerminalScans && (
                <section className="space-y-6">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold text-gray-900">Threat analytics</h2>
                        {metricsLoading && (
                          <Badge variant="brand">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Refreshing
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-gray-500">{activeScopeLabel}</p>
                    </div>
                    <div className="w-full max-w-md">
                      <SelectDropdown
                        id="dashboard-scan-selector"
                        label="Scan scope"
                        ariaLabel="Select which scan to display in dashboard analytics"
                        value={selectedScanId}
                        options={scanOptions}
                        onChange={setSelectedScanId}
                        buttonIcon={<BarChart3 className="h-4 w-4 text-brand-600" />}
                        matchTriggerWidth={false}
                        panelClassName="min-w-[18rem] max-w-[calc(100vw-1.5rem)]"
                        dividerAfterValue=""
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <DashboardMetricCard
                      label="High severity"
                      value={metrics.totals.high}
                      description="Urgent issues that need rapid review."
                      icon={AlertCircle}
                      tone="danger"
                      onClick={() => navigateToMetricCardDrilldown('high')}
                    />
                    <DashboardMetricCard
                      label="Medium severity"
                      value={metrics.totals.medium}
                      description="Suspicious activity worth investigating."
                      icon={AlertTriangle}
                      tone="warning"
                      onClick={() => navigateToMetricCardDrilldown('medium')}
                    />
                    <DashboardMetricCard
                      label="Low severity"
                      value={metrics.totals.low}
                      description="Lower-risk results still worth monitoring."
                      icon={Info}
                      tone="success"
                      onClick={() => navigateToMetricCardDrilldown('low')}
                    />
                    <DashboardMetricCard
                      label="Non-hits"
                      value={metrics.totals.nonHit}
                      description="Results classified as benign or irrelevant."
                      icon={SearchCheck}
                      tone="neutral"
                      onClick={() => navigateToMetricCardDrilldown('nonHit')}
                    />
                  </div>

                  <div className="grid gap-6 xl:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <h3 className="text-base font-semibold text-gray-900">Findings by platform</h3>
                        <p className="mt-1 text-sm text-gray-500">
                          Compare where findings are appearing across platforms.
                        </p>
                      </CardHeader>
                      <CardContent>
                        <DashboardStackedBarChart
                          data={metrics.platformBreakdown}
                          emptyMessage="No platform-labelled findings are available in this scope yet."
                          onSegmentClick={(category, row) => navigateToChartDrilldown('platform', category, row)}
                        />
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <h3 className="text-base font-semibold text-gray-900">Findings by theme</h3>
                        <p className="mt-1 text-sm text-gray-500">
                          See which themes recur most often.
                        </p>
                      </CardHeader>
                      <CardContent>
                        <DashboardStackedBarChart
                          data={metrics.themeBreakdown}
                          emptyMessage="No theme-labelled findings are available in this scope yet."
                          onSegmentClick={(category, row) => navigateToChartDrilldown('theme', category, row)}
                        />
                      </CardContent>
                    </Card>
                  </div>

                  <div className="flex items-center justify-between rounded-2xl border border-gray-200 bg-white px-5 py-4">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900">Need the raw findings?</h3>
                      <p className="mt-1 text-sm text-gray-500">
                        Open the brand page to review scan results, live progress, and finding details.
                      </p>
                    </div>
                    <Link
                      href={selectedBrandHref}
                      className="inline-flex items-center justify-center rounded-full border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      Open brand
                    </Link>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
