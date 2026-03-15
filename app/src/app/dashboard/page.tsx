'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePageTitle } from '@/lib/use-page-title';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Building2,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Expand,
  Info,
  Loader2,
  PlayCircle,
  SearchCheck,
  Shield,
  Sparkles,
  X,
} from 'lucide-react';
import { AuthGuard } from '@/components/auth-guard';
import { DashboardCtaCard } from '@/components/dashboard-cta-card';
import { DashboardLineChart } from '@/components/dashboard-line-chart';
import { DashboardMetricCard } from '@/components/dashboard-metric-card';
import { DashboardSeriesFilter } from '@/components/dashboard-series-filter';
import { DashboardStackedBarChart } from '@/components/dashboard-stacked-bar-chart';
import { Navbar } from '@/components/navbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { SelectDropdown } from '@/components/ui/select-dropdown';
import { UNLABELLED_DASHBOARD_BREAKDOWN_BUCKET } from '@/lib/dashboard';
import { cn } from '@/lib/utils';
import { formatDate, formatScanDate } from '@/lib/utils';
import type {
  DashboardBreakdownCategory,
  DashboardBootstrapBrand,
  DashboardBreakdownRow,
  DashboardBootstrapData,
  DashboardExecutiveSummaryData,
  DashboardMetricsData,
  DashboardPreferenceUpdateInput,
  ScanSummary,
} from '@/lib/types';

const DASHBOARD_RETURN_TO_PARAM = 'returnTo';
const DASHBOARD_RETURN_TO_VALUE = 'dashboard';
const EXECUTIVE_SUMMARY_THEME_VIEW_PARAM = 'view';
const EXECUTIVE_SUMMARY_THEME_VIEW_VALUE = 'executive-summary-theme';
const EXECUTIVE_SUMMARY_FINDING_ID_QUERY_PARAM = 'findingId';
const EXECUTIVE_SUMMARY_THEME_TITLE_QUERY_PARAM = 'themeTitle';
const DEFAULT_THEME_TIMELINE_SELECTION_COUNT = 15;
const EXECUTIVE_SUMMARY_POLL_INTERVAL_MS = 5_000;

type ExpandedDashboardChartId =
  | 'source-breakdown'
  | 'theme-breakdown'
  | 'source-timeline'
  | 'theme-timeline';

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

function formatCompactDashboardDateTime(date: Parameters<typeof formatDate>[0]): string {
  if (!date) return '—';
  try {
    const resolvedDate = typeof (date as { toDate?: unknown }).toDate === 'function'
      ? (date as { toDate(): Date }).toDate()
      : '_seconds' in (date as { _seconds?: number })
        ? new Date((date as { _seconds: number })._seconds * 1000)
        : 'seconds' in (date as { seconds?: number })
          ? new Date((date as { seconds: number }).seconds * 1000)
          : date as Date;

    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(resolvedDate).replace(',', '');
  } catch {
    return '—';
  }
}

function formatDebugRawResponse(raw?: string) {
  if (!raw) {
    return '(not available — this run may have used a fallback summary or failed before the raw response was captured)';
  }

  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function DashboardPage() {
  usePageTitle('Dashboard');
  const router = useRouter();
  const searchParams = useSearchParams();
  const showDebug = searchParams.get('debug') === 'true';
  const [brands, setBrands] = useState<DashboardBootstrapBrand[]>([]);
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [selectedScanId, setSelectedScanId] = useState('');
  const [metrics, setMetrics] = useState<DashboardMetricsData | null>(null);
  const [executiveSummary, setExecutiveSummary] = useState<DashboardExecutiveSummaryData | null>(null);
  const [executiveSummaryLoading, setExecutiveSummaryLoading] = useState(false);
  const [executiveSummaryError, setExecutiveSummaryError] = useState('');
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [bootstrapError, setBootstrapError] = useState('');
  const [metricsError, setMetricsError] = useState('');
  const [preferenceError, setPreferenceError] = useState('');
  const [expandedChartId, setExpandedChartId] = useState<ExpandedDashboardChartId | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [executiveSummaryThemesExpanded, setExecutiveSummaryThemesExpanded] = useState(false);
  const [selectedSourceTimelineSeriesKeys, setSelectedSourceTimelineSeriesKeys] = useState<string[]>([]);
  const [selectedThemeTimelineSeriesKeys, setSelectedThemeTimelineSeriesKeys] = useState<string[]>([]);

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
  const sourceTimelineOptions = useMemo(
    () => metrics?.sourceTimeline?.series ?? [],
    [metrics?.sourceTimeline?.series],
  );
  const themeTimelineOptions = useMemo(
    () => metrics?.themeTimeline?.series ?? [],
    [metrics?.themeTimeline?.series],
  );

  const loadMetrics = useCallback(async (options?: { silent?: boolean }) => {
    const resolvedBrandId = selectedBrandId;
    if (!resolvedBrandId) return;

    if (!options?.silent) {
      setMetricsLoading(true);
      setMetricsError('');
    }

    const params = new URLSearchParams({ brandId: resolvedBrandId });
    if (selectedScanId) {
      params.set('scanId', selectedScanId);
    }

    try {
      const data = await readDashboardResponse<DashboardMetricsData>(`/api/dashboard/metrics?${params.toString()}`, {
        credentials: 'same-origin',
      });
      setMetrics(data);
      setSelectedScanId(data.selectedScanId ?? '');
    } catch (err) {
      if (!options?.silent) {
        setMetrics(null);
      }
      setMetricsError(err instanceof Error ? err.message : 'Failed to load dashboard metrics');
    } finally {
      if (!options?.silent) {
        setMetricsLoading(false);
      }
    }
  }, [selectedBrandId, selectedScanId]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!metrics?.brandId) return;

    setSelectedSourceTimelineSeriesKeys(sourceTimelineOptions.map((series) => series.key));
    setSelectedThemeTimelineSeriesKeys(
      themeTimelineOptions
        .slice(0, DEFAULT_THEME_TIMELINE_SELECTION_COUNT)
        .map((series) => series.key),
    );
  }, [metrics?.brandId, sourceTimelineOptions, themeTimelineOptions]);

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
    if (!selectedBrandId) {
      setMetrics(null);
      setSelectedScanId('');
      return;
    }

    void loadMetrics();
  }, [loadMetrics, selectedBrandId]);

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
  const isAllScansScope = !selectedScanId;
  const executiveSummaryPatterns = executiveSummary?.patterns ?? [];
  const isExecutiveSummaryPending = executiveSummary?.status === 'pending';
  const isExecutiveSummaryFailed = executiveSummary?.status === 'failed';
  const hasExecutiveSummaryContent = Boolean(executiveSummary?.summary);
  const shouldShowExecutiveSummaryContent = hasExecutiveSummaryContent && !isExecutiveSummaryPending;
  const shouldShowExecutiveSummarySection = (
    isAllScansScope
    && Boolean(metrics?.hasTerminalScans)
    && (isExecutiveSummaryPending || hasExecutiveSummaryContent)
  );

  useEffect(() => {
    setExecutiveSummaryError('');
    setExecutiveSummaryLoading(false);
    setExecutiveSummaryThemesExpanded(false);
  }, [selectedBrandId, selectedScanId]);

  useEffect(() => {
    if (!isAllScansScope) {
      setExecutiveSummary(null);
      setExecutiveSummaryThemesExpanded(false);
      return;
    }

    setExecutiveSummary(metrics?.dashboardExecutiveSummary ?? null);
  }, [isAllScansScope, metrics]);

  useEffect(() => {
    if (!isAllScansScope || executiveSummary?.status !== 'pending') {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void loadMetrics({ silent: true });
    }, EXECUTIVE_SUMMARY_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [executiveSummary?.status, isAllScansScope, loadMetrics]);

  useEffect(() => {
    if (sourceTimelineOptions.length === 0) {
      setSelectedSourceTimelineSeriesKeys([]);
      return;
    }

    const availableKeys = new Set(sourceTimelineOptions.map((series) => series.key));
    setSelectedSourceTimelineSeriesKeys((current) => current.filter((key) => availableKeys.has(key)));
  }, [sourceTimelineOptions]);

  useEffect(() => {
    if (themeTimelineOptions.length === 0) {
      setSelectedThemeTimelineSeriesKeys([]);
      return;
    }

    const availableKeys = new Set(themeTimelineOptions.map((series) => series.key));
    setSelectedThemeTimelineSeriesKeys((current) => current.filter((key) => availableKeys.has(key)));
  }, [themeTimelineOptions]);

  useEffect(() => {
    if (!expandedChartId) return undefined;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setExpandedChartId(null);
      }
    }

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleEscape);
    };
  }, [expandedChartId]);

  const navigateToChartDrilldown = useCallback((
    dimension: 'theme' | 'source',
    category: DashboardBreakdownCategory,
    row: DashboardBreakdownRow,
  ) => {
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
      if (dimension === 'source') {
        if (row.filterValue) {
          params.set('source', row.filterValue);
        }
      } else {
        params.set('theme', row.filterValue ?? row.label);
      }
    }

    const hash = targetScanId ? `#scan-result-set-${targetScanId}` : '';
    router.push(`/brands/${selectedBrand.id}?${params.toString()}${hash}`);
  }, [metrics?.selectedScanId, router, selectedBrand]);

  const expandedChartMeta = useMemo(() => {
    if (!metrics) return null;

    const chartMap: Record<ExpandedDashboardChartId, {
      title: string;
      description: string;
      controls?: React.ReactNode;
      content: React.ReactNode;
    }> = {
      'source-breakdown': {
        title: 'Findings by scan type',
        description: 'Compare where actionable findings are appearing across scan types.',
        content: (
          <DashboardStackedBarChart
            data={metrics.sourceBreakdown}
            emptyMessage="No actionable scan-type findings are available in this scope yet."
            hiddenCategories={['nonHit']}
            onSegmentClick={(category, row) => navigateToChartDrilldown('source', category, row)}
            expanded
          />
        ),
      },
      'theme-breakdown': {
        title: 'Findings by theme',
        description: 'See which themes recur most often among actionable findings.',
        content: (
          <DashboardStackedBarChart
            data={metrics.themeBreakdown}
            emptyMessage="No actionable theme-labelled findings are available in this scope yet."
            hiddenCategories={['nonHit']}
            onSegmentClick={(category, row) => navigateToChartDrilldown('theme', category, row)}
            expanded
          />
        ),
      },
      'source-timeline': {
        title: 'Findings by scan type over time',
        description: 'Cumulative findings at all severity levels over time, by scan type.',
        controls: (
          <DashboardSeriesFilter
            buttonLabelSingular="scan type"
            buttonLabelPlural="scan types"
            options={sourceTimelineOptions}
            selectedKeys={selectedSourceTimelineSeriesKeys}
            onChange={setSelectedSourceTimelineSeriesKeys}
          />
        ),
        content: (
          <DashboardLineChart
            data={metrics.sourceTimeline}
            emptyMessage="No actionable scan-type findings are available across these scans yet."
            expanded
            visibleSeriesKeys={selectedSourceTimelineSeriesKeys}
            selectionEmptyMessage="Select at least one scan type to display."
          />
        ),
      },
      'theme-timeline': {
        title: 'Findings by theme over time',
        description: 'Cumulative findings at all severity levels over time, by theme.',
        controls: (
          <DashboardSeriesFilter
            buttonLabelSingular="theme"
            buttonLabelPlural="themes"
            options={themeTimelineOptions}
            selectedKeys={selectedThemeTimelineSeriesKeys}
            onChange={setSelectedThemeTimelineSeriesKeys}
          />
        ),
        content: (
          <DashboardLineChart
            data={metrics.themeTimeline}
            emptyMessage="No actionable theme-labelled findings are available across these scans yet."
            expanded
            visibleSeriesKeys={selectedThemeTimelineSeriesKeys}
            selectionEmptyMessage="Select at least one theme to display."
          />
        ),
      },
    };

    return expandedChartId ? chartMap[expandedChartId] : null;
  }, [
    expandedChartId,
    metrics,
    navigateToChartDrilldown,
    selectedSourceTimelineSeriesKeys,
    selectedThemeTimelineSeriesKeys,
    sourceTimelineOptions,
    themeTimelineOptions,
  ]);

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

  function buildExecutiveSummaryPatternHref(pattern: NonNullable<DashboardExecutiveSummaryData['patterns']>[number]) {
    if (!selectedBrand) return null;

    const params = new URLSearchParams({
      [EXECUTIVE_SUMMARY_THEME_VIEW_PARAM]: EXECUTIVE_SUMMARY_THEME_VIEW_VALUE,
      [DASHBOARD_RETURN_TO_PARAM]: DASHBOARD_RETURN_TO_VALUE,
    });
    params.set(EXECUTIVE_SUMMARY_THEME_TITLE_QUERY_PARAM, pattern.name);
    for (const findingId of pattern.findingIds) {
      params.append(EXECUTIVE_SUMMARY_FINDING_ID_QUERY_PARAM, findingId);
    }

    return `/brands/${selectedBrand.id}?${params.toString()}`;
  }

  async function generateExecutiveSummary() {
    if (!selectedBrandId || !showDebug || !isAllScansScope) return;

    setExecutiveSummaryLoading(true);
    setExecutiveSummaryError('');
    try {
      const params = new URLSearchParams({
        brandId: selectedBrandId,
        debug: 'true',
      });
      const data = await readDashboardResponse<DashboardExecutiveSummaryData>(`/api/dashboard/executive-summary?${params.toString()}`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      setExecutiveSummary(data ?? null);
    } catch (err) {
      setExecutiveSummary(null);
      setExecutiveSummaryError(err instanceof Error ? err.message : 'Failed to generate executive summary');
    } finally {
      setExecutiveSummaryLoading(false);
    }
  }

  function renderChartHeader(
    title: string,
    description: string,
    chartId: ExpandedDashboardChartId,
  ) {
    return (
      <CardHeader className="border-b border-brand-100 bg-brand-50/80">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">{title}</h3>
            <p className="mt-1 text-sm text-gray-500">{description}</p>
          </div>
          <button
            type="button"
            aria-label={`Expand ${title}`}
            onClick={() => setExpandedChartId(chartId)}
            className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:h-10 lg:w-10"
          >
            <Expand className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
    );
  }

  return (
    <AuthGuard>
      <Navbar />

      <main className="min-h-screen bg-gray-50 pt-16 lg:pt-[4.5rem]">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8 lg:py-10 xl:max-w-[88rem]">
          <div className="mb-8 lg:mb-8">
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
              description="Add the brands you want DoppelSpotter to monitor, then run scans to surface your first actionable findings."
              href="/brands/new"
              actionLabel="Create your first brand"
              icon={Shield}
            />
          )}

          {!bootstrapLoading && !bootstrapError && brands.length > 0 && selectedBrand && (
            <div className="space-y-6 lg:space-y-8">
              <Card className="overflow-hidden border-brand-100">
                <div className="border-b border-brand-100 bg-brand-50/70 px-5 py-4 lg:px-6 lg:py-5">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-brand-700">Focused brand</span>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                      <div className="w-full max-w-md flex-none">
                        <SelectDropdown
                          id="dashboard-brand-selector"
                          ariaLabel="Select a brand to scope the dashboard"
                          value={selectedBrand.id}
                          options={brandOptions}
                          onChange={handleBrandChange}
                          searchable={brands.length > 8}
                          searchPlaceholder="Search brands"
                          buttonIcon={<Building2 className="h-4 w-4 text-brand-600" />}
                        />
                      </div>
                      <Link
                        href={selectedBrandHref}
                        className="inline-flex items-center gap-1.5 self-start whitespace-nowrap text-sm font-medium text-brand-700 transition hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:self-auto"
                      >
                        Go to brand page
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </div>
                  </div>
                </div>
                <CardContent className="flex flex-wrap gap-1.5 p-3 sm:gap-2 sm:p-4 lg:px-6 lg:py-4">
                  {metrics && (
                    <Badge variant="brand" className="px-2 py-0.5 text-[11px] sm:px-2.5 sm:py-1 sm:text-xs">
                      {metrics.selectedBrandScanCount} scan{metrics.selectedBrandScanCount !== 1 ? 's' : ''}
                    </Badge>
                  )}
                  {metrics?.selectedBrandLastScanStartedAt && (
                    <Badge variant="default" className="px-2 py-0.5 text-[11px] sm:px-2.5 sm:py-1 sm:text-xs">
                      <span className="sm:hidden">Last {formatCompactDashboardDateTime(metrics.selectedBrandLastScanStartedAt)}</span>
                      <span className="hidden sm:inline">Last scan {formatDate(metrics.selectedBrandLastScanStartedAt)}</span>
                    </Badge>
                  )}
                  {selectedBrand.scanSchedule?.enabled && selectedBrand.scanSchedule.nextRunAt && (
                    <Badge variant="default" className="px-2 py-0.5 text-[11px] sm:px-2.5 sm:py-1 sm:text-xs">
                      <span className="sm:hidden">Next {formatCompactDashboardDateTime(selectedBrand.scanSchedule.nextRunAt)}</span>
                      <span className="hidden sm:inline">Next scan {formatDate(selectedBrand.scanSchedule.nextRunAt)}</span>
                    </Badge>
                  )}
                  {metrics?.selectedBrandIsScanInProgress && (
                    <Badge variant="brand" className="px-2 py-0.5 text-[11px] sm:px-2.5 sm:py-1 sm:text-xs">
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
                selectedBrand.isHistoryDeletionInProgress ? null : metrics.activeScan ? (
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
                    description={`Kick off the first scan for ${selectedBrand.name} to surface your first actionable findings.`}
                    href={selectedBrandHref}
                    actionLabel="Open brand and run scan"
                    icon={PlayCircle}
                  />
                )
              )}

              {metrics && metrics.hasTerminalScans && (
                <section className="space-y-6 lg:space-y-8">
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

                  {shouldShowExecutiveSummarySection && (
                    <Card className={cn(
                      'overflow-hidden border-brand-100 bg-white',
                      showDebug && 'border-dashed border-brand-200 bg-brand-50/40',
                    )}>
                      <CardHeader className="border-b border-brand-100 bg-brand-50/80">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <Sparkles className="h-4 w-4 text-brand-700" />
                              <h3 className="text-base font-semibold text-gray-900">Executive summary</h3>
                            </div>
                          </div>
                          {showDebug && (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => void generateExecutiveSummary()}
                              disabled={!isAllScansScope || executiveSummaryLoading}
                            >
                              {executiveSummaryLoading ? (
                                <>
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  Generating...
                                </>
                              ) : (
                                <>
                                  <Sparkles className="h-4 w-4" />
                                  {hasExecutiveSummaryContent ? 'Force regenerate' : 'Generate executive summary'}
                                </>
                              )}
                            </Button>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {showDebug && executiveSummaryError && (
                          <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                            {executiveSummaryError}
                          </p>
                        )}
                        <div className="space-y-4">
                            {isExecutiveSummaryPending && !hasExecutiveSummaryContent && (
                              <div className="rounded-2xl border border-brand-100 bg-white p-5">
                                <div className="flex items-start gap-3">
                                  <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-brand-700" />
                                  <div>
                                    <h4 className="text-sm font-semibold text-gray-900">Generating executive summary</h4>
                                    <p className="mt-1 text-sm text-gray-700">This may take a few minutes</p>
                                    <p className="mt-2 text-sm text-gray-500">
                                      Executive summaries are regenerated automatically after every completed scan.
                                    </p>
                                  </div>
                                </div>
                              </div>
                            )}

                            {isExecutiveSummaryPending && hasExecutiveSummaryContent && (
                              <div className="rounded-2xl border border-brand-100 bg-white p-5">
                                <div className="flex items-start gap-3">
                                  <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-brand-700" />
                                  <div>
                                    <h4 className="text-sm font-semibold text-gray-900">Generating executive summary with AI</h4>
                                    <p className="mt-1 text-sm text-gray-700">This may take a few minutes.</p>
                                    <p className="mt-2 text-sm text-gray-500">
                                      Executive summaries are regenerated automatically after every completed scan.
                                    </p>
                                  </div>
                                </div>
                              </div>
                            )}

                            {isExecutiveSummaryFailed && (
                              <div className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                <p className="font-medium">Executive summary generation failed.</p>
                                {executiveSummary?.error && (
                                  <p className="mt-1">{executiveSummary.error}</p>
                                )}
                                {hasExecutiveSummaryContent && (
                                  <p className="mt-1 text-amber-700/80">
                                    Showing the last successful executive summary below.
                                  </p>
                                )}
                              </div>
                            )}

                            {shouldShowExecutiveSummaryContent ? (
                              <>
                                <div className="rounded-2xl border border-brand-100 bg-white p-5">
                                  <p className="text-sm leading-6 text-gray-700">
                                    {executiveSummary?.summary}
                                  </p>
                                </div>

                                {executiveSummaryPatterns.length > 0 ? (
                                  <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                                    <button
                                      type="button"
                                      onClick={() => setExecutiveSummaryThemesExpanded((current) => !current)}
                                      className="flex w-full items-center justify-between gap-3 bg-brand-50/60 px-4 py-3 text-left transition hover:bg-brand-50"
                                    >
                                      <div className="flex items-center gap-2">
                                        {executiveSummaryThemesExpanded ? (
                                          <ChevronDown className="h-4 w-4 text-gray-500" />
                                        ) : (
                                          <ChevronRight className="h-4 w-4 text-gray-500" />
                                        )}
                                        <span className="text-sm font-semibold text-brand-700">
                                          {executiveSummaryPatterns.length} key theme{executiveSummaryPatterns.length !== 1 ? 's' : ''} identified
                                        </span>
                                      </div>
                                      <span className="text-xs font-medium text-gray-500">
                                        {executiveSummaryThemesExpanded ? 'Hide' : 'Show'}
                                      </span>
                                    </button>

                                    {executiveSummaryThemesExpanded && (
                                      <div className="grid gap-3 border-t border-gray-200 p-4 md:grid-cols-2 xl:grid-cols-3">
                                        {executiveSummaryPatterns.map((pattern) => (
                                          <div
                                            key={`${pattern.name}-${pattern.findingIds.join('-')}`}
                                            className="flex h-full min-h-[15rem] flex-col rounded-2xl border border-brand-100 bg-brand-50/35 p-4 shadow-sm"
                                          >
                                            <div className="min-w-0 flex flex-1 flex-col">
                                              <div className="flex items-start gap-2">
                                                <Crosshair className="h-4 w-4 flex-none text-brand-700" />
                                                <div className="min-w-0 flex-1">
                                                  <h4 className="text-sm font-semibold leading-5 text-gray-900">
                                                    {pattern.name}
                                                  </h4>
                                                  <Badge
                                                    variant="default"
                                                    className="mt-2.5 rounded-full border-none bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-gray-600"
                                                  >
                                                    {pattern.mentionCount} mention{pattern.mentionCount !== 1 ? 's' : ''}
                                                  </Badge>
                                                </div>
                                              </div>
                                              <div className="mt-3 flex-1 overflow-y-auto pr-1">
                                                <p className="text-sm leading-6 text-gray-700">
                                                  {pattern.description}
                                                </p>
                                              </div>
                                              <div className="mt-4">
                                                <Link
                                                  href={buildExecutiveSummaryPatternHref(pattern) ?? '#'}
                                                  className={cn(
                                                    'inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 transition hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                                                    !selectedBrand && 'pointer-events-none',
                                                  )}
                                                >
                                                  View mentions
                                                  <ArrowRight className="h-4 w-4" />
                                                </Link>
                                              </div>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
                                    No repeated threat patterns were confidently extracted from this input set.
                                  </div>
                                )}
                              </>
                            ) : !isExecutiveSummaryPending ? (
                              <div className="rounded-2xl border border-gray-200 bg-white p-5 text-sm text-gray-600">
                                No executive summary has been generated yet.
                              </div>
                            ) : null}

                            {showDebug && executiveSummary && !isExecutiveSummaryPending && (
                              <details className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-900">
                                  Raw LLM response
                                </summary>
                                <pre className="max-h-80 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words border-t border-gray-200 p-4 font-mono text-xs leading-relaxed text-gray-700">
                                  {formatDebugRawResponse(executiveSummary.rawLlmResponse)}
                                </pre>
                              </details>
                            )}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  <div className="grid gap-4 md:grid-cols-2 lg:gap-5 xl:grid-cols-4">
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
                      label="Non-findings"
                      value={metrics.totals.nonHit}
                      description="Results classified as benign or irrelevant."
                      icon={SearchCheck}
                      tone="neutral"
                      onClick={() => navigateToMetricCardDrilldown('nonHit')}
                    />
                  </div>

                  <div className="grid gap-6 lg:gap-7 xl:grid-cols-2">
                    <Card className="min-w-0 overflow-hidden">
                      {renderChartHeader(
                        'Findings by scan type',
                        'Compare where actionable findings are appearing across scan types.',
                        'source-breakdown',
                      )}
                      <CardContent className="min-w-0 overflow-hidden">
                        <DashboardStackedBarChart
                          data={metrics.sourceBreakdown}
                          emptyMessage="No actionable scan-type findings are available in this scope yet."
                          hiddenCategories={['nonHit']}
                          onSegmentClick={(category, row) => navigateToChartDrilldown('source', category, row)}
                        />
                      </CardContent>
                    </Card>

                    <Card className="min-w-0 overflow-hidden">
                      {renderChartHeader(
                        'Findings by theme',
                        'See which themes recur most often among actionable findings.',
                        'theme-breakdown',
                      )}
                      <CardContent className="min-w-0 overflow-hidden">
                        <DashboardStackedBarChart
                          data={metrics.themeBreakdown}
                          emptyMessage="No actionable theme-labelled findings are available in this scope yet."
                          hiddenCategories={['nonHit']}
                          onSegmentClick={(category, row) => navigateToChartDrilldown('theme', category, row)}
                        />
                      </CardContent>
                    </Card>
                  </div>

                  {isAllScansScope && (
                    <div className="grid gap-6 xl:grid-cols-2">
                      <Card className="min-w-0 overflow-hidden">
                        {renderChartHeader(
                          'Findings by scan type over time',
                          'Cumulative findings at all severity levels over time, by scan type.',
                          'source-timeline',
                        )}
                        <CardContent className="min-w-0 space-y-4 overflow-hidden">
                          <div className="flex justify-end">
                            <DashboardSeriesFilter
                              buttonLabelSingular="scan type"
                              buttonLabelPlural="scan types"
                              options={sourceTimelineOptions}
                              selectedKeys={selectedSourceTimelineSeriesKeys}
                              onChange={setSelectedSourceTimelineSeriesKeys}
                            />
                          </div>
                          <DashboardLineChart
                            data={metrics.sourceTimeline}
                            emptyMessage="No actionable scan-type findings are available across these scans yet."
                            visibleSeriesKeys={selectedSourceTimelineSeriesKeys}
                            selectionEmptyMessage="Select at least one scan type to display."
                          />
                        </CardContent>
                      </Card>

                      <Card className="min-w-0 overflow-hidden">
                        {renderChartHeader(
                          'Findings by theme over time',
                          'Cumulative findings at all severity levels over time, by theme.',
                          'theme-timeline',
                        )}
                        <CardContent className="min-w-0 space-y-4 overflow-hidden">
                          <div className="flex justify-end">
                            <DashboardSeriesFilter
                              buttonLabelSingular="theme"
                              buttonLabelPlural="themes"
                              options={themeTimelineOptions}
                              selectedKeys={selectedThemeTimelineSeriesKeys}
                              onChange={setSelectedThemeTimelineSeriesKeys}
                            />
                          </div>
                          <DashboardLineChart
                            data={metrics.themeTimeline}
                            emptyMessage="No actionable theme-labelled findings are available across these scans yet."
                            visibleSeriesKeys={selectedThemeTimelineSeriesKeys}
                            selectionEmptyMessage="Select at least one theme to display."
                          />
                        </CardContent>
                      </Card>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </main>

      {isMounted && expandedChartMeta && createPortal(
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/70 p-4 sm:p-6"
          onClick={() => setExpandedChartId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-chart-modal-title"
            aria-describedby="dashboard-chart-modal-description"
            className="flex h-[min(92vh,980px)] w-full max-w-[min(96vw,1440px)] flex-col overflow-hidden rounded-3xl border border-brand-100 bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-brand-100 bg-brand-50/90 px-6 py-5">
              <div>
                <h2 id="dashboard-chart-modal-title" className="text-xl font-semibold text-gray-900">
                  {expandedChartMeta.title}
                </h2>
                <p id="dashboard-chart-modal-description" className="mt-1 text-sm text-gray-600">
                  {expandedChartMeta.description}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setExpandedChartId(null)}
                className="h-10 w-10 rounded-full border border-brand-100 bg-white/90 p-0 text-brand-700 hover:bg-white"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close expanded chart</span>
              </Button>
            </div>
            <div className={cn('flex-1 min-h-0 overflow-auto p-4 sm:p-6 lg:p-7')}>
              {expandedChartMeta.controls ? (
                <div className="mb-4 flex justify-end">
                  {expandedChartMeta.controls}
                </div>
              ) : null}
              {expandedChartMeta.content}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </AuthGuard>
  );
}
