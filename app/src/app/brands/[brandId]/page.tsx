'use client';

import type { ReactNode } from 'react';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePageTitle } from '@/lib/use-page-title';
import Image from 'next/image';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Play, AlertCircle, AlertTriangle, Info, Shield, Search, Loader2,
  ChevronDown, ChevronRight, Settings, Trash2, X, EyeOff, Bookmark, Link2, Check, RotateCcw,
  ArrowUp,
  Sparkles, Crosshair, MessageSquare,
} from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
import { BrandScanSourceFields } from '@/components/brand-scan-source-fields';
import { BrandScanTuningFields } from '@/components/brand-scan-tuning-fields';
import { ScanSourceIcon } from '@/components/scan-source-icon';
import { MultiSelectDropdown } from '@/components/ui/select-dropdown';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Toast } from '@/components/ui/toast';
import { Input } from '@/components/ui/input';
import { InfoTooltip, Tooltip } from '@/components/ui/tooltip';
import { getEffectiveScanSettings, hasEnabledBrandScanSource } from '@/lib/brands';
import {
  formatScanScheduleFrequency,
  formatScheduledRunAt,
} from '@/lib/scan-schedules';
import {
  getFindingSourceLabel,
  SCAN_SOURCE_ORDER,
  sortScanSourcesByLabel,
  supportsSourceDeepSearch,
} from '@/lib/scan-sources';
import { cn, formatInteger, formatScanDate } from '@/lib/utils';
import type {
  ActorRunInfo,
  BrandProfile,
  EffectiveScanSettings,
  FindingCategory,
  FindingSource,
  FindingSummary,
  Scan,
  ScanSettingsInput,
  ScanSummary,
} from '@/lib/types';

const POLL_INTERVAL_MS = 5_000;
const ACTIVE_SCAN_IDLE_POLL_INTERVAL_MS = 20_000;
const ACTIVE_SCAN_DELETE_TOOLTIP =
  "Scan history can't be changed while a scan is running because current results are compared against previous findings.";
const RUN_SCAN_DELETION_TOOLTIP =
  'Scans are still being deleted. You will be able to run a new scan when this is complete. This may take several minutes.';
const SCAN_ACTION_BUTTON_CLASS_NAME =
  'inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition hover:bg-gray-50 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60 lg:h-9 lg:w-9';
const SCAN_RESULT_SET_HASH_PREFIX = 'scan-result-set-';
const OTHER_FINDING_TAXONOMY_KEY = 'other';
const DRILLDOWN_CATEGORY_QUERY_PARAM = 'category';
const DRILLDOWN_THEME_QUERY_PARAM = 'theme';
const DRILLDOWN_SOURCE_QUERY_PARAM = 'source';
const RETURN_TO_QUERY_PARAM = 'returnTo';
const RETURN_TO_DASHBOARD_VALUE = 'dashboard';
const EXECUTIVE_SUMMARY_THEME_VIEW_PARAM = 'view';
const EXECUTIVE_SUMMARY_THEME_VIEW_VALUE = 'executive-summary-theme';
const EXECUTIVE_SUMMARY_FINDING_ID_QUERY_PARAM = 'findingId';
const EXECUTIVE_SUMMARY_THEME_TITLE_QUERY_PARAM = 'themeTitle';
const FINDING_SEARCH_MIN_QUERY_LENGTH = 2;
const FINDING_SEARCH_DEBOUNCE_MS = 250;
const FINDING_SEARCH_RESULTS_PAGE_SIZE = 50;
const BACK_TO_TOP_VISIBILITY_OFFSET_PX = 640;

function hasActiveHistoryDeletion(brand?: Pick<BrandProfile, 'historyDeletion'> | null) {
  const status = brand?.historyDeletion?.status;
  return status === 'queued' || status === 'running';
}

type BookmarkUpdate = {
  isBookmarked?: boolean;
};

type FindingSourceFilter = Exclude<FindingSource, 'unknown'>;
type FindingSearchDisplayBucket = 'hit' | 'non-hit' | 'ignored' | 'addressed';
type CrossScanTab = 'bookmarks' | 'ignored' | 'addressed';
type FindingSearchResult = FindingSummary & {
  displayBucket: FindingSearchDisplayBucket;
  scanStartedAt?: FindingSummary['createdAt'];
  scanStatus?: Scan['status'];
};

type ScanSummaryPreview = {
  summary: string;
  rawLlmResponse?: string;
};

type ScanDebugData = Pick<Scan, 'id' | 'aiSummary' | 'scanSummaryRawLlmResponse'> & {
  regeneratedSummaryPreview?: ScanSummaryPreview | null;
};

// ---------------------------------------------------------------------------
// localStorage helpers — persist active scan ID across page reloads
// ---------------------------------------------------------------------------

function scanStorageKey(brandId: string) {
  return `doppelspotter:scan:${brandId}`;
}

function setStoredScanId(brandId: string, scanId: string) {
  try {
    localStorage.setItem(scanStorageKey(brandId), scanId);
  } catch {
    // localStorage unavailable — degrade gracefully
  }
}

function clearStoredScanId(brandId: string) {
  try {
    localStorage.removeItem(scanStorageKey(brandId));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Severity badge helpers
// ---------------------------------------------------------------------------

const SEVERITY_BADGE_CLASSES = {
  high: '!border-red-300 !bg-red-200 !text-red-900',
  medium: '!border-amber-300 !bg-amber-200 !text-amber-900',
  low: '!border-green-300 !bg-green-200 !text-green-900',
} as const;

const SEVERITY_COUNT_TEXT_CLASSES = {
  high: 'text-red-900',
  medium: 'text-amber-900',
  low: 'text-green-900',
} as const;

function SeverityPills({ high, medium, low }: { high: number; medium: number; low: number }) {
  if (high === 0 && medium === 0 && low === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {high > 0 && (
        <Badge variant="danger" className="gap-1 px-2 py-0.5 text-[11px]">
          <AlertCircle className="w-3 h-3" />
          {formatInteger(high)} High
        </Badge>
      )}
      {medium > 0 && (
        <Badge variant="warning" className="gap-1 px-2 py-0.5 text-[11px]">
          <AlertTriangle className="w-3 h-3" />
          {formatInteger(medium)} Medium
        </Badge>
      )}
      {low > 0 && (
        <Badge variant="success" className="gap-1 px-2 py-0.5 text-[11px]">
          <Info className="w-3 h-3" />
          {formatInteger(low)} Low
        </Badge>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Severity group — collapsible section within a scan result set
// ---------------------------------------------------------------------------

const SEVERITY_GROUP_CONFIG = {
  high:   { variant: 'danger'  as const, label: 'High',   icon: AlertCircle,   headerBg: 'bg-red-50',   headerBorder: 'border-red-100',   hoverBg: 'hover:bg-red-100' },
  medium: { variant: 'warning' as const, label: 'Medium', icon: AlertTriangle, headerBg: 'bg-amber-50', headerBorder: 'border-amber-100', hoverBg: 'hover:bg-amber-100' },
  low:    { variant: 'success' as const, label: 'Low',    icon: Info,          headerBg: 'bg-green-50', headerBorder: 'border-green-100', hoverBg: 'hover:bg-green-100' },
};

function SeverityGroup({
  severity,
  findings,
  selectedFindingIds,
  onSelectionChange,
  onIgnoreToggle,
  onAddressToggle,
  onReclassify,
  onBookmarkUpdate,
  onNoteUpdate,
  forceExpanded = false,
  highlightQuery,
  autoExpandToken,
  sectionAnchorId,
}: {
  severity: 'high' | 'medium' | 'low';
  findings: FindingSummary[];
  selectedFindingIds?: Set<string>;
  onSelectionChange?: (finding: FindingSummary, selected: boolean) => void;
  onIgnoreToggle?: (finding: FindingSummary, isIgnored: boolean) => Promise<void>;
  onAddressToggle?: (finding: FindingSummary, isAddressed: boolean) => Promise<void>;
  onReclassify?: (finding: FindingSummary, category: FindingCategory) => Promise<void>;
  onBookmarkUpdate?: (finding: FindingSummary, updates: BookmarkUpdate) => Promise<void>;
  onNoteUpdate?: (finding: FindingSummary, note: string | null) => Promise<void>;
  forceExpanded?: boolean;
  highlightQuery?: string;
  autoExpandToken?: string | null;
  sectionAnchorId?: string;
}) {
  const [isExpanded, setIsExpanded] = useState(severity === 'high');
  const [ignoringAll, setIgnoringAll] = useState(false);

  const { variant, label, icon: Icon, headerBg, headerBorder, hoverBg } = SEVERITY_GROUP_CONFIG[severity];
  const expanded = forceExpanded || isExpanded;

  useEffect(() => {
    if (!autoExpandToken) return;
    setIsExpanded(true);
  }, [autoExpandToken]);

  async function handleIgnoreAll(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onIgnoreToggle || ignoringAll) return;
    setIgnoringAll(true);
    try {
      for (const finding of findings) {
        await onIgnoreToggle(finding, true);
      }
    } finally {
      setIgnoringAll(false);
    }
  }

  return (
    <div
      id={sectionAnchorId}
      className="scroll-mt-28 overflow-hidden sm:rounded-xl sm:border sm:border-gray-200 sm:bg-white lg:rounded-2xl"
    >
      <div className={cn("flex items-center transition sm:border-b", headerBg, headerBorder, !forceExpanded && hoverBg, "rounded-lg sm:rounded-none")}>
        <button
          type="button"
          onClick={() => {
            if (forceExpanded) return;
            setIsExpanded((v) => !v);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left sm:px-4 sm:py-3 lg:px-5 lg:py-4"
          aria-expanded={expanded}
        >
          {!forceExpanded && (expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />)}
          <Badge variant={variant} className={SEVERITY_BADGE_CLASSES[severity]}>
            <Icon className="w-3.5 h-3.5" />
            {label}
          </Badge>
          <span className={cn('text-xs', SEVERITY_COUNT_TEXT_CLASSES[severity])}>
            {formatInteger(findings.length)} finding{findings.length !== 1 ? 's' : ''}
          </span>
        </button>
        {onIgnoreToggle && (
          <button
            type="button"
            onClick={handleIgnoreAll}
            disabled={ignoringAll}
            className="mr-2 inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-gray-300 bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 transition hover:bg-gray-300 disabled:opacity-50 sm:mr-3 lg:mr-4 lg:px-3 lg:py-1"
          >
            {ignoringAll
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <EyeOff className="w-3 h-3" />}
            Ignore all
          </button>
        )}
      </div>
      {expanded && (
        <div className="space-y-3 pt-2 sm:space-y-4 sm:border-t sm:border-gray-100 sm:p-4 lg:space-y-5 lg:p-5">
          {findings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              isSelected={selectedFindingIds?.has(finding.id) === true}
              highlightQuery={highlightQuery}
              onSelectionChange={onSelectionChange}
              onIgnoreToggle={onIgnoreToggle}
              onAddressToggle={onAddressToggle}
              onReclassify={onReclassify}
              onBookmarkUpdate={onBookmarkUpdate}
              onNoteUpdate={onNoteUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScanSummaryPanel({ summary, label = 'AI summary' }: { summary: string; label?: string }) {
  return (
    <div className="rounded-xl border border-brand-100 border-l-2 border-l-brand-500 bg-brand-50/70 px-4 py-4 lg:px-5 lg:py-5">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-500" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-700/80">
            {label}
          </p>
          <p className="mt-1 text-sm leading-6 text-gray-700 lg:text-[15px] lg:leading-7">
            {summary}
          </p>
        </div>
      </div>
    </div>
  );
}

function ScanDebugExpandableSection({
  icon: Icon,
  label,
  onOpen,
  loading = false,
  error,
  children,
}: {
  icon: React.ElementType;
  label: string;
  onOpen?: () => void;
  loading?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      onOpen?.();
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 bg-gray-50 px-3 py-2 text-left transition hover:bg-gray-100"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
        )}
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
        <span className="text-xs font-medium text-gray-600">{label}</span>
      </button>
      {open && loading && (
        <div className="flex items-center gap-2 border-t border-gray-200 bg-white p-3 text-xs text-gray-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading debug data...
        </div>
      )}
      {open && !loading && error && (
        <div className="border-t border-gray-200 bg-white p-3 text-xs text-red-600">
          {error}
        </div>
      )}
      {open && !loading && !error && (
        <pre className="max-h-80 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words border-t border-gray-200 bg-white p-3 font-mono text-xs leading-relaxed text-gray-700">
          {children}
        </pre>
      )}
    </div>
  );
}

function normalizeFindingsSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function formatDebugRawResponse(raw?: string) {
  if (!raw) {
    return '(not available — this scan may have used a non-LLM fallback, predate raw-response capture, or have failed before the response was stored)';
  }

  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function normalizeFindingsTaxonomyValue(value?: string) {
  return value?.toLowerCase().replace(/\s+/g, ' ').trim() ?? '';
}

function parseFindingCategoryFilter(value?: string | null): FindingCategory | null {
  const normalized = value?.toLowerCase().replace(/\s+/g, '').trim();
  if (!normalized) return null;
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized;
  if (normalized === 'non-hit' || normalized === 'nonhit' || normalized === 'nonhits') return 'non-hit';
  return null;
}

function parseFindingCategoryFilters(values: string[]) {
  const seen = new Set<FindingCategory>();
  const parsedValues: FindingCategory[] = [];

  for (const value of values) {
    const parsedValue = parseFindingCategoryFilter(value);
    if (!parsedValue || seen.has(parsedValue)) continue;
    seen.add(parsedValue);
    parsedValues.push(parsedValue);
  }

  return parsedValues;
}

function compareFindingTaxonomyLabels(a: string, b: string) {
  const aIsOther = normalizeFindingsTaxonomyValue(a) === OTHER_FINDING_TAXONOMY_KEY;
  const bIsOther = normalizeFindingsTaxonomyValue(b) === OTHER_FINDING_TAXONOMY_KEY;

  if (aIsOther !== bIsOther) {
    return aIsOther ? 1 : -1;
  }

  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}

function collectDistinctFindingTaxonomyLabels(values: Array<string | undefined>) {
  const byKey = new Map<string, string>();

  for (const value of values) {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;

    const key = normalizeFindingsTaxonomyValue(normalized);
    if (!key || !byKey.has(key)) {
      byKey.set(key, normalized);
    }
  }

  return Array.from(byKey.values()).sort(compareFindingTaxonomyLabels);
}

function getScanResultSetAnchorId(scanId: string) {
  return `${SCAN_RESULT_SET_HASH_PREFIX}${scanId}`;
}

function getScanCategorySectionAnchorId(scanId: string, category: FindingCategory) {
  return `${getScanResultSetAnchorId(scanId)}-${category}`;
}

function extractScanResultSetId(value: string) {
  const normalizedValue = value.replace(/^[#?]/, '');
  if (!normalizedValue.startsWith(SCAN_RESULT_SET_HASH_PREFIX)) {
    return null;
  }

  const scanId = normalizedValue
    .slice(SCAN_RESULT_SET_HASH_PREFIX.length)
    .split(/[&#]/, 1)[0]
    ?.trim();
  return scanId || null;
}

function getScanResultSetIdFromHash(hash: string) {
  return extractScanResultSetId(hash);
}

function getScanResultSetIdFromUrl(url: string) {
  try {
    const parsedUrl = new URL(url, 'http://localhost');
    return (
      getScanResultSetIdFromHash(parsedUrl.hash)
      ?? extractScanResultSetId(parsedUrl.search)
      ?? parsedUrl.searchParams.get('scanResultSet')?.trim()
      ?? null
    );
  } catch {
    return getScanResultSetIdFromHash(url) ?? extractScanResultSetId(url);
  }
}

function parseDownloadFilename(headerValue: string | null) {
  if (!headerValue) return null;

  const utf8Match = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const basicMatch = headerValue.match(/filename="?([^";]+)"?/i);
  return basicMatch?.[1] ?? null;
}

function parseFindingSourceFilter(value?: string | null): FindingSourceFilter | null {
  return value && SCAN_SOURCE_ORDER.includes(value as FindingSourceFilter)
    ? value as FindingSourceFilter
    : null;
}

function parseFindingSourceFilters(values: string[]) {
  const seen = new Set<FindingSourceFilter>();
  const parsedValues: FindingSourceFilter[] = [];

  for (const value of values) {
    const parsedValue = parseFindingSourceFilter(value);
    if (!parsedValue || seen.has(parsedValue)) continue;
    seen.add(parsedValue);
    parsedValues.push(parsedValue);
  }

  return parsedValues;
}

function parseFindingThemeFilters(values: string[]) {
  const seen = new Set<string>();
  const parsedValues: string[] = [];

  for (const value of values) {
    const trimmedValue = value.replace(/\s+/g, ' ').trim();
    const normalizedValue = normalizeFindingsTaxonomyValue(trimmedValue);
    if (!normalizedValue || seen.has(normalizedValue)) continue;
    seen.add(normalizedValue);
    parsedValues.push(trimmedValue);
  }

  return parsedValues;
}

function replaceMultiValueQueryParam(params: URLSearchParams, key: string, values: string[]) {
  params.delete(key);

  for (const value of values) {
    const trimmedValue = value.trim();
    if (!trimmedValue) continue;
    params.append(key, trimmedValue);
  }
}

function scrollToScanResultSet(scanId: string, attempt = 0) {
  if (typeof window === 'undefined') return;

  const element = document.getElementById(getScanResultSetAnchorId(scanId));
  if (!element) {
    if (attempt < 8) {
      window.setTimeout(() => scrollToScanResultSet(scanId, attempt + 1), 100);
    }
    return;
  }

  window.requestAnimationFrame(() => {
    const top = window.scrollY + element.getBoundingClientRect().top - 96;
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });

    if (attempt < 4) {
      window.setTimeout(() => scrollToScanResultSet(scanId, attempt + 1), 120);
    }
  });
}

function scrollToScanCategorySection(scanId: string, category: FindingCategory, attempt = 0) {
  if (typeof window === 'undefined') return;

  const element = document.getElementById(getScanCategorySectionAnchorId(scanId, category));
  if (!element) {
    if (attempt < 8) {
      window.setTimeout(() => scrollToScanCategorySection(scanId, category, attempt + 1), 100);
    }
    return;
  }

  window.requestAnimationFrame(() => {
    const top = window.scrollY + element.getBoundingClientRect().top - 108;
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });

    if (attempt < 4) {
      window.setTimeout(() => scrollToScanCategorySection(scanId, category, attempt + 1), 120);
    }
  });
}

function BulkActionButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  emphasis = 'default',
}: {
  icon: typeof Crosshair;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  emphasis?: 'default' | 'muted';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
        emphasis === 'muted'
          ? 'bg-transparent text-slate-600 hover:bg-slate-200/50 hover:text-slate-900'
          : 'bg-white text-slate-700 shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-900',
      )}
    >
      <Icon className={cn("h-4 w-4", emphasis === 'muted' ? "text-slate-400" : "text-slate-500")} />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function BrandDetailPageContent() {
  const { brandId } = useParams<{ brandId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const showDebug = searchParams.get('debug') === 'true';
  const forceThrottlePanel = showDebug && searchParams.get('force_throttle_panel') === 'true';
  const returnToDashboard = searchParams.get(RETURN_TO_QUERY_PARAM) === RETURN_TO_DASHBOARD_VALUE;
  const executiveSummaryMentionFindingIds = useMemo(() => {
    const seen = new Set<string>();
    const findingIds: string[] = [];
    for (const value of searchParams.getAll(EXECUTIVE_SUMMARY_FINDING_ID_QUERY_PARAM)) {
      const trimmedValue = value.trim();
      if (!trimmedValue || seen.has(trimmedValue)) continue;
      seen.add(trimmedValue);
      findingIds.push(trimmedValue);
    }
    return findingIds;
  }, [searchParams]);
  const executiveSummaryThemeTitle = searchParams.get(EXECUTIVE_SUMMARY_THEME_TITLE_QUERY_PARAM)?.trim() ?? '';
  const isExecutiveSummaryMentionsMode = (
    searchParams.get(EXECUTIVE_SUMMARY_THEME_VIEW_PARAM) === EXECUTIVE_SUMMARY_THEME_VIEW_VALUE
    && executiveSummaryMentionFindingIds.length > 0
  );
  const backHref = returnToDashboard
    ? '/dashboard'
    : '/brands';
  const initialFindingCategories = parseFindingCategoryFilters(searchParams.getAll(DRILLDOWN_CATEGORY_QUERY_PARAM));
  const initialFindingSources = parseFindingSourceFilters(searchParams.getAll(DRILLDOWN_SOURCE_QUERY_PARAM));
  const initialFindingThemes = parseFindingThemeFilters(searchParams.getAll(DRILLDOWN_THEME_QUERY_PARAM));

  const [brand, setBrand] = useState<BrandProfile | null>(null);
  usePageTitle(brand?.name ?? '');
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [scanDebugById, setScanDebugById] = useState<Record<string, ScanDebugData | null>>({});
  const [scanDebugLoadingIds, setScanDebugLoadingIds] = useState<string[]>([]);
  const [scanDebugErrors, setScanDebugErrors] = useState<Record<string, string>>({});
  const [scanSummaryRegeneratingIds, setScanSummaryRegeneratingIds] = useState<string[]>([]);
  const [scanSummarySavingIds, setScanSummarySavingIds] = useState<string[]>([]);
  const [scanSummaryActionErrors, setScanSummaryActionErrors] = useState<Record<string, string>>({});
  const [debugSummaryToastMessage, setDebugSummaryToastMessage] = useState('');
  const [expandedScanIds, setExpandedScanIds] = useState<string[]>([]);
  const [anchorTargetScanId, setAnchorTargetScanId] = useState<string | null>(() => (
    typeof window === 'undefined' ? null : getScanResultSetIdFromUrl(window.location.href)
  ));
  const [scanFindings, setScanFindings] = useState<Record<string, FindingSummary[]>>({});
  const [scanNonHits, setScanNonHits] = useState<Record<string, FindingSummary[]>>({});
  const [scanIgnored, setScanIgnored] = useState<Record<string, FindingSummary[]>>({});
  const [loadingScanIds, setLoadingScanIds] = useState<string[]>([]);
  const [showNonHitsByScanId, setShowNonHitsByScanId] = useState<Record<string, boolean>>({});
  const [showIgnoredByScanId, setShowIgnoredByScanId] = useState<Record<string, boolean>>({});
  const [allBookmarkedFindings, setAllBookmarkedFindings] = useState<FindingSummary[]>([]);
  const [bookmarkedFindingsTruncated, setBookmarkedFindingsTruncated] = useState(false);
  const [bookmarkedFindingsTotalCount, setBookmarkedFindingsTotalCount] = useState<number | null>(null);
  const [allAddressedFindings, setAllAddressedFindings] = useState<FindingSummary[]>([]);
  const [addressedFindingsTruncated, setAddressedFindingsTruncated] = useState(false);
  const [activeTab, setActiveTab] = useState<'scans' | 'bookmarks' | 'ignored' | 'addressed'>('scans');
  const [allIgnoredFindings, setAllIgnoredFindings] = useState<FindingSummary[]>([]);
  const [ignoredFindingsTruncated, setIgnoredFindingsTruncated] = useState(false);
  const [crossScanTabNextCursor, setCrossScanTabNextCursor] = useState<Record<CrossScanTab, string | null>>({
    bookmarks: null,
    addressed: null,
    ignored: null,
  });
  const [crossScanTabLoading, setCrossScanTabLoading] = useState<Record<CrossScanTab, boolean>>({
    bookmarks: false,
    addressed: false,
    ignored: false,
  });
  const [crossScanTabLoadingMore, setCrossScanTabLoadingMore] = useState<Record<CrossScanTab, boolean>>({
    bookmarks: false,
    addressed: false,
    ignored: false,
  });
  const [crossScanTabErrors, setCrossScanTabErrors] = useState<Record<CrossScanTab, string>>({
    bookmarks: '',
    addressed: '',
    ignored: '',
  });
  const [filteredCrossScanTabBadgeCounts, setFilteredCrossScanTabBadgeCounts] = useState<Record<CrossScanTab, number | null>>({
    bookmarks: null,
    addressed: null,
    ignored: null,
  });
  const [findingsSearchQuery, setFindingsSearchQuery] = useState('');
  const [debouncedFindingsSearchQuery, setDebouncedFindingsSearchQuery] = useState('');
  const [serverSearchLoading, setServerSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<FindingSearchResult[]>([]);
  const [searchResultsTotalCount, setSearchResultsTotalCount] = useState<number | null>(null);
  const [searchResultsNextCursor, setSearchResultsNextCursor] = useState<string | null>(null);
  const [searchResultsError, setSearchResultsError] = useState('');
  const [searchResultsTruncated, setSearchResultsTruncated] = useState(false);
  const [loadingMoreSearchResults, setLoadingMoreSearchResults] = useState(false);
  const [findingTaxonomyOptions, setFindingTaxonomyOptions] = useState<{ themes: string[] }>({
    themes: [],
  });
  const [hasLoadedFindingTaxonomyOptions, setHasLoadedFindingTaxonomyOptions] = useState(false);
  const [selectedFindingCategories, setSelectedFindingCategories] = useState<FindingCategory[]>(initialFindingCategories);
  const [selectedFindingSources, setSelectedFindingSources] = useState<FindingSourceFilter[]>(initialFindingSources);
  const [selectedFindingThemes, setSelectedFindingThemes] = useState<string[]>(initialFindingThemes);
  const [selectedFindingIds, setSelectedFindingIds] = useState<string[]>([]);
  const [isBulkActionPanelExpanded, setIsBulkActionPanelExpanded] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [isBulkReclassifyDialogOpen, setIsBulkReclassifyDialogOpen] = useState(false);
  const [selectedBulkReclassificationCategory, setSelectedBulkReclassificationCategory] = useState<FindingCategory | null>(null);
  const [showBackToTopLink, setShowBackToTopLink] = useState(false);
  const [confirmDeleteScanId, setConfirmDeleteScanId] = useState<string | null>(null);
  const [deletingScanId, setDeletingScanId] = useState<string | null>(null);
  const [exportingCsvScanId, setExportingCsvScanId] = useState<string | null>(null);
  const [exportingPdfScanId, setExportingPdfScanId] = useState<string | null>(null);
  const [copiedScanLinkId, setCopiedScanLinkId] = useState<string | null>(null);
  const [isMobileSearchFiltersOpen, setIsMobileSearchFiltersOpen] = useState(() => (
    initialFindingCategories.length > 0 || initialFindingSources.length > 0 || initialFindingThemes.length > 0
  ));

  const [isLookbackNudgeOpen, setIsLookbackNudgeOpen] = useState(false);
  const [lookbackNudgeLoading, setLookbackNudgeLoading] = useState(false);
  const [lookbackNudgeSuccessMessage, setLookbackNudgeSuccessMessage] = useState('');

  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [activeScan, setActiveScan] = useState<Scan | null>(null);
  const [optimisticActiveScanSettings, setOptimisticActiveScanSettings] = useState<EffectiveScanSettings | null>(null);
  const [liveScanFindings, setLiveScanFindings] = useState<FindingSummary[]>([]);
  const [liveScanNonHits, setLiveScanNonHits] = useState<FindingSummary[]>([]);
  const [showLiveScanNonHits, setShowLiveScanNonHits] = useState(false);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [isRunScanMenuOpen, setIsRunScanMenuOpen] = useState(false);
  const [isCustomScanDialogOpen, setIsCustomScanDialogOpen] = useState(false);
  const [customScanSettings, setCustomScanSettings] = useState<EffectiveScanSettings>(() => getEffectiveScanSettings());
  const [customScanError, setCustomScanError] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deletionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const copiedScanLinkResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lookbackNudgeSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressScanKeyRef = useRef<string | null>(null);
  const selectedProgressScanKeyRef = useRef<string | null>(null);
  const pendingScanFindingsLoadsRef = useRef<Record<string, Promise<void>>>({});
  const pendingScanNonHitsLoadsRef = useRef<Record<string, Promise<void>>>({});
  const pendingScanIgnoredLoadsRef = useRef<Record<string, Promise<void>>>({});
  const crossScanTabRequestIdRef = useRef<Record<CrossScanTab, number>>({
    bookmarks: 0,
    addressed: 0,
    ignored: 0,
  });
  const crossScanTabLoadedQueryKeyRef = useRef<Record<CrossScanTab, string | null>>({
    bookmarks: null,
    addressed: null,
    ignored: null,
  });
  const filteredCrossScanTabBadgeCountRequestIdRef = useRef(0);
  const findingSearchAbortControllerRef = useRef<AbortController | null>(null);
  const findingSearchRequestIdRef = useRef(0);
  const runScanMenuRef = useRef<HTMLDivElement | null>(null);
  const [selectedScanProgressSource, setSelectedScanProgressSource] = useState<FindingSource>('google');
  const [displayedScanProgressPctBySource, setDisplayedScanProgressPctBySource] = useState<Partial<Record<FindingSource, number>>>({});
  const normalizedFindingsSearchInput = normalizeFindingsSearchText(findingsSearchQuery);
  const normalizedFindingsSearchQuery = normalizeFindingsSearchText(debouncedFindingsSearchQuery);
  const selectedFindingCategorySet = useMemo(
    () => new Set(selectedFindingCategories),
    [selectedFindingCategories],
  );
  const selectedFindingSourceSet = useMemo(
    () => new Set<FindingSource>(selectedFindingSources),
    [selectedFindingSources],
  );
  const normalizedSelectedFindingThemes = useMemo(
    () => selectedFindingThemes.map((theme) => normalizeFindingsTaxonomyValue(theme)),
    [selectedFindingThemes],
  );
  const normalizedSelectedFindingThemeSet = useMemo(
    () => new Set(normalizedSelectedFindingThemes.filter(Boolean)),
    [normalizedSelectedFindingThemes],
  );
  const singleSelectedFindingCategory = selectedFindingCategories.length === 1
    ? selectedFindingCategories[0]
    : null;
  const isFindingsSearchActive = normalizedFindingsSearchInput.length > 0;
  const shouldUseLocalTabFindingSearch = activeTab !== 'scans' && isFindingsSearchActive && !isExecutiveSummaryMentionsMode;
  const hasActiveFindingCategoryFilter = selectedFindingCategories.length > 0;
  const hasActiveFindingSourceFilter = selectedFindingSources.length > 0;
  const hasActiveFindingThemeFilter = normalizedSelectedFindingThemeSet.size > 0;
  const hasActiveNonSearchFindingFilters =
    hasActiveFindingCategoryFilter
    || hasActiveFindingSourceFilter
    || hasActiveFindingThemeFilter;
  const isFilterOnlyScansMode = !isFindingsSearchActive && hasActiveNonSearchFindingFilters;
  const shouldUseServerFindingSearch =
    activeTab === 'scans' && (isExecutiveSummaryMentionsMode || isFindingsSearchActive || hasActiveNonSearchFindingFilters);
  const canRunServerFindingSearch =
    isExecutiveSummaryMentionsMode
    || (
    normalizedFindingsSearchQuery.length >= FINDING_SEARCH_MIN_QUERY_LENGTH
    || isFilterOnlyScansMode
  );
  const isAnyFindingFilterActive =
    !isExecutiveSummaryMentionsMode && (
      isFindingsSearchActive
      || hasActiveFindingCategoryFilter
      || hasActiveFindingSourceFilter
      || hasActiveFindingThemeFilter
    );
  const activeFindingControlCount = [
    isFindingsSearchActive,
    hasActiveFindingThemeFilter,
    hasActiveFindingCategoryFilter,
    hasActiveFindingSourceFilter,
  ].filter(Boolean).length;
  const activeHighlightQuery = shouldUseServerFindingSearch
    ? (canRunServerFindingSearch ? debouncedFindingsSearchQuery : undefined)
    : (shouldUseLocalTabFindingSearch ? debouncedFindingsSearchQuery : undefined);
  const findingsSearchLoading = serverSearchLoading;

  useEffect(() => {
    if (!isAnyFindingFilterActive) return;
    setConfirmDeleteScanId(null);
  }, [isAnyFindingFilterActive]);

  useEffect(() => {
    if (!isAnyFindingFilterActive) return;
    setIsMobileSearchFiltersOpen(true);
  }, [isAnyFindingFilterActive]);

  useEffect(() => {
    let frameId: number | null = null;

    function updateBackToTopVisibility() {
      frameId = null;
      setShowBackToTopLink(window.scrollY > BACK_TO_TOP_VISIBILITY_OFFSET_PX);
    }

    function handleScroll() {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(updateBackToTopVisibility);
    }

    updateBackToTopVisibility();
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  useEffect(() => {
    if (!isRunScanMenuOpen) return undefined;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (runScanMenuRef.current?.contains(target)) return;
      setIsRunScanMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsRunScanMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isRunScanMenuOpen]);

  useEffect(() => {
    if (!isBulkReclassifyDialogOpen) return undefined;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !bulkActionLoading) {
        setIsBulkReclassifyDialogOpen(false);
        setSelectedBulkReclassificationCategory(null);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [bulkActionLoading, isBulkReclassifyDialogOpen]);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function stopDeletionPolling() {
    if (deletionPollRef.current) {
      clearInterval(deletionPollRef.current);
      deletionPollRef.current = null;
    }
  }

  function updateDrilldownUrl(updates: {
    categories?: FindingCategory[];
    sources?: FindingSourceFilter[];
    themes?: string[];
    hash?: string | null;
  }) {
    const params = new URLSearchParams(searchParams.toString());

    if (updates.categories !== undefined) {
      replaceMultiValueQueryParam(params, DRILLDOWN_CATEGORY_QUERY_PARAM, updates.categories);
    }

    if (updates.sources !== undefined) {
      replaceMultiValueQueryParam(params, DRILLDOWN_SOURCE_QUERY_PARAM, updates.sources);
    }

    if (updates.themes !== undefined) {
      replaceMultiValueQueryParam(params, DRILLDOWN_THEME_QUERY_PARAM, updates.themes);
    }

    const queryString = params.toString();
    const hash = updates.hash !== undefined
      ? updates.hash
      : (typeof window !== 'undefined' ? window.location.hash : '');
    router.replace(`${pathname}${queryString ? `?${queryString}` : ''}${hash}`, { scroll: false });
  }

  function handleFindingCategoryFilterChange(nextValues: string[]) {
    const nextCategories = parseFindingCategoryFilters(nextValues);
    setSelectedFindingCategories(nextCategories);
    updateDrilldownUrl({ categories: nextCategories });
  }

  function handleFindingSourceFilterChange(nextValues: string[]) {
    const nextSources = parseFindingSourceFilters(nextValues);
    setSelectedFindingSources(nextSources);
    updateDrilldownUrl({ sources: nextSources });
  }

  function handleFindingThemeFilterChange(nextValues: string[]) {
    const nextThemes = parseFindingThemeFilters(nextValues);
    setSelectedFindingThemes(nextThemes);
    updateDrilldownUrl({ themes: nextThemes });
  }

  function resetFindingsSearchAndFilters() {
    setFindingsSearchQuery('');
    setDebouncedFindingsSearchQuery('');
    setSearchResults([]);
    setSearchResultsTotalCount(null);
    setSearchResultsNextCursor(null);
    setSearchResultsError('');
    setSearchResultsTruncated(false);
    setSelectedFindingCategories([]);
    setSelectedFindingSources([]);
    setSelectedFindingThemes([]);
    updateDrilldownUrl({
      categories: [],
      sources: [],
      themes: [],
    });
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedFindingsSearchQuery(findingsSearchQuery);
    }, FINDING_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [findingsSearchQuery]);

  const appendActiveFindingFilterParams = useCallback((params: URLSearchParams) => {
    if (isExecutiveSummaryMentionsMode) {
      return;
    }
    for (const category of selectedFindingCategories) {
      params.append('category', category);
    }
    for (const source of selectedFindingSources) {
      params.append('source', source);
    }
    for (const theme of selectedFindingThemes) {
      const trimmedTheme = theme.trim();
      if (!trimmedTheme) continue;
      params.append('theme', trimmedTheme);
    }
  }, [isExecutiveSummaryMentionsMode, selectedFindingCategories, selectedFindingSources, selectedFindingThemes]);

  const fetchServerSearchResults = useCallback(async (options?: { append?: boolean; cursor?: string | null; signal?: AbortSignal }) => {
    const params = new URLSearchParams({
      limit: `${FINDING_SEARCH_RESULTS_PAGE_SIZE}`,
      tab: activeTab,
    });

    if (!isExecutiveSummaryMentionsMode) {
      params.set('q', debouncedFindingsSearchQuery.trim());
    } else {
      for (const findingId of executiveSummaryMentionFindingIds) {
        params.append(EXECUTIVE_SUMMARY_FINDING_ID_QUERY_PARAM, findingId);
      }
    }

    if (!options?.append) {
      params.set('includeCount', '1');
    }
    if (options?.cursor) {
      params.set('cursor', options.cursor);
    }
    appendActiveFindingFilterParams(params);

    const res = await fetch(`/api/brands/${brandId}/findings/search?${params.toString()}`, {
      credentials: 'same-origin',
      signal: options?.signal,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? 'Failed to search findings');
    }

    const json = await res.json().catch(() => ({}));
    const responseData = (json.data ?? {}) as {
      results?: FindingSearchResult[];
      nextCursor?: string | null;
      hasMore?: boolean;
      truncated?: boolean;
      totalCount?: number;
    };
    const nextResults = Array.isArray(responseData.results) ? responseData.results : [];

    setSearchResults((prev) => {
      if (!options?.append) {
        return nextResults;
      }

      const seen = new Set(prev.map((result) => result.id));
      const appended = nextResults.filter((result) => !seen.has(result.id));
      return appended.length > 0 ? [...prev, ...appended] : prev;
    });
    if (!options?.append) {
      setSearchResultsTotalCount(typeof responseData.totalCount === 'number' ? responseData.totalCount : null);
    }
    setSearchResultsNextCursor(responseData.hasMore ? (responseData.nextCursor ?? null) : null);
    setSearchResultsTruncated(responseData.truncated === true);
    setSearchResultsError('');
  }, [
    activeTab,
    appendActiveFindingFilterParams,
    brandId,
    debouncedFindingsSearchQuery,
    executiveSummaryMentionFindingIds,
    isExecutiveSummaryMentionsMode,
  ]);

  async function loadMoreSearchResults() {
    if (!searchResultsNextCursor || loadingMoreSearchResults) return;

    setLoadingMoreSearchResults(true);
    try {
      await fetchServerSearchResults({ append: true, cursor: searchResultsNextCursor });
    } catch (err) {
      setSearchResultsError(err instanceof Error ? err.message : 'Failed to load more search results');
    } finally {
      setLoadingMoreSearchResults(false);
    }
  }

  async function loadMoreCrossScanTabFindings(tab: CrossScanTab) {
    if (!crossScanTabNextCursor[tab] || crossScanTabLoadingMore[tab]) return;
    await loadCrossScanTabFindings(tab, { append: true });
  }

  // ---------------------------------------------------------------------------
  // Fetch scans list and auto-expand + pre-load the most recent scan
  // ---------------------------------------------------------------------------

  async function fetchScans(options?: { autoExpandScanId?: string; skipAutoExpand?: boolean }) {
    try {
      const res = await fetch(`/api/brands/${brandId}/scans`, { credentials: 'same-origin' });
      if (!res.ok) return [];
      const json = await res.json();
      const newScans: ScanSummary[] = json.data ?? [];
      setScans(newScans);

      const targetId = options?.autoExpandScanId ?? anchorTargetScanId ?? newScans[0]?.id;
      if (!options?.skipAutoExpand && targetId) {
        setExpandedScanIds((prev) => (prev.includes(targetId) ? prev : [targetId, ...prev]));
        loadScanFindings(targetId);
      }
      return newScans;
    } catch {
      // Non-critical
      return [];
    }
  }

  async function ensureScanDebugData(scanId: string) {
    if (Object.prototype.hasOwnProperty.call(scanDebugById, scanId) || scanDebugLoadingIds.includes(scanId)) return;

    setScanDebugLoadingIds((prev) => [...prev, scanId]);
    setScanDebugErrors((prev) => ({ ...prev, [scanId]: '' }));
    try {
      const res = await fetch(`/api/brands/${brandId}/scans/${scanId}?debug=true`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Failed to load debug data');
      const json = await res.json();
      setScanDebugById((prev) => ({
        ...prev,
        [scanId]: {
          ...((json.data as ScanDebugData | null) ?? { id: scanId }),
          regeneratedSummaryPreview: prev[scanId]?.regeneratedSummaryPreview ?? null,
        },
      }));
    } catch (err) {
      setScanDebugErrors((prev) => ({
        ...prev,
        [scanId]: err instanceof Error ? err.message : 'Failed to load debug data',
      }));
    } finally {
      setScanDebugLoadingIds((prev) => prev.filter((id) => id !== scanId));
    }
  }

  async function regenerateScanSummary(scanId: string) {
    setScanSummaryRegeneratingIds((prev) => [...prev, scanId]);
    setScanSummaryActionErrors((prev) => ({ ...prev, [scanId]: '' }));

    try {
      const res = await fetch(`/api/brands/${brandId}/scans/${scanId}?debug=true`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'Failed to regenerate scan summary');
      }

      const json = await res.json().catch(() => ({}));
      const data = (json.data ?? {}) as {
        regeneratedSummary?: string;
        regeneratedScanSummaryRawLlmResponse?: string;
      };
      const fallbackSummary = scans.find((candidate) => candidate.id === scanId)?.aiSummary;

      setScanDebugById((prev) => ({
        ...prev,
        [scanId]: {
          id: scanId,
          aiSummary: prev[scanId]?.aiSummary ?? fallbackSummary,
          scanSummaryRawLlmResponse: prev[scanId]?.scanSummaryRawLlmResponse,
          regeneratedSummaryPreview: {
            summary: data.regeneratedSummary ?? '',
            rawLlmResponse: data.regeneratedScanSummaryRawLlmResponse,
          },
        },
      }));
    } catch (err) {
      setScanSummaryActionErrors((prev) => ({
        ...prev,
        [scanId]: err instanceof Error ? err.message : 'Failed to regenerate scan summary',
      }));
    } finally {
      setScanSummaryRegeneratingIds((prev) => prev.filter((id) => id !== scanId));
    }
  }

  function discardRegeneratedScanSummaryPreview(scanId: string) {
    setScanSummaryActionErrors((prev) => ({ ...prev, [scanId]: '' }));
    setScanDebugById((prev) => {
      const existing = prev[scanId];
      if (!existing) return prev;
      return {
        ...prev,
        [scanId]: {
          ...existing,
          regeneratedSummaryPreview: null,
        },
      };
    });
  }

  async function saveRegeneratedScanSummary(scanId: string) {
    const preview = scanDebugById[scanId]?.regeneratedSummaryPreview;
    if (!preview?.summary) return;

    setScanSummarySavingIds((prev) => [...prev, scanId]);
    setScanSummaryActionErrors((prev) => ({ ...prev, [scanId]: '' }));

    try {
      const res = await fetch(`/api/brands/${brandId}/scans/${scanId}?debug=true`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          summary: preview.summary,
          rawLlmResponse: preview.rawLlmResponse,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'Failed to save regenerated scan summary');
      }

      const json = await res.json().catch(() => ({}));
      const data = (json.data ?? {}) as Pick<Scan, 'aiSummary' | 'scanSummaryRawLlmResponse'>;
      const nextSummary = data.aiSummary ?? preview.summary;
      const nextRaw = data.scanSummaryRawLlmResponse ?? preview.rawLlmResponse;

      setScans((prev) => prev.map((scan) => (
        scan.id === scanId
          ? {
              ...scan,
              aiSummary: nextSummary,
            }
          : scan
      )));
      setScanDebugById((prev) => ({
        ...prev,
        [scanId]: {
          id: scanId,
          aiSummary: nextSummary,
          scanSummaryRawLlmResponse: nextRaw,
          regeneratedSummaryPreview: null,
        },
      }));
      setDebugSummaryToastMessage('Regenerated scan summary saved.');
    } catch (err) {
      setScanSummaryActionErrors((prev) => ({
        ...prev,
        [scanId]: err instanceof Error ? err.message : 'Failed to save regenerated scan summary',
      }));
    } finally {
      setScanSummarySavingIds((prev) => prev.filter((id) => id !== scanId));
    }
  }

  async function refreshBrandProfile() {
    const brandRes = await fetch(`/api/brands/${brandId}`, { credentials: 'same-origin' });
    if (brandRes.status === 403 || brandRes.status === 404) {
      router.replace('/brands');
      return null as unknown as BrandProfile;
    }
    if (!brandRes.ok) throw new Error('Brand not found');
    const brandJson = await brandRes.json();
    setBrand(brandJson.data);
    return brandJson.data as BrandProfile;
  }

  async function loadScanFindings(scanId: string) {
    // Only loads hits — non-hits and ignored are lazy-loaded when those sections are first opened.
    if (scanFindings[scanId] !== undefined) return;

    const pendingLoad = pendingScanFindingsLoadsRef.current[scanId];
    if (pendingLoad) return pendingLoad;

    const requestPromise = (async () => {
      setLoadingScanIds((prev) => (prev.includes(scanId) ? prev : [...prev, scanId]));
      try {
        const res = await fetch(`/api/brands/${brandId}/findings?scanId=${scanId}`, { credentials: 'same-origin' });
        if (res.ok) {
          const json = await res.json();
          setScanFindings((prev) => ({ ...prev, [scanId]: json.data ?? [] }));
        }
      } catch {
        // Non-critical
      } finally {
        delete pendingScanFindingsLoadsRef.current[scanId];
        setLoadingScanIds((prev) => prev.filter((id) => id !== scanId));
      }
    })();

    pendingScanFindingsLoadsRef.current[scanId] = requestPromise;
    return requestPromise;
  }

  async function loadScanNonHits(scanId: string) {
    if (scanNonHits[scanId] !== undefined) return;

    const pendingLoad = pendingScanNonHitsLoadsRef.current[scanId];
    if (pendingLoad) return pendingLoad;

    const requestPromise = (async () => {
      try {
        const res = await fetch(`/api/brands/${brandId}/findings?scanId=${scanId}&nonHitsOnly=true`, { credentials: 'same-origin' });
        if (res.ok) {
          const json = await res.json();
          setScanNonHits((prev) => ({ ...prev, [scanId]: json.data ?? [] }));
        }
      } catch {
        // Non-critical
      } finally {
        delete pendingScanNonHitsLoadsRef.current[scanId];
      }
    })();

    pendingScanNonHitsLoadsRef.current[scanId] = requestPromise;
    return requestPromise;
  }

  async function loadScanIgnored(scanId: string) {
    if (scanIgnored[scanId] !== undefined) return;

    const pendingLoad = pendingScanIgnoredLoadsRef.current[scanId];
    if (pendingLoad) return pendingLoad;

    const requestPromise = (async () => {
      try {
        const res = await fetch(`/api/brands/${brandId}/findings?scanId=${scanId}&ignoredOnly=true`, { credentials: 'same-origin' });
        if (res.ok) {
          const json = await res.json();
          setScanIgnored((prev) => ({ ...prev, [scanId]: json.data ?? [] }));
        }
      } catch {
        // Non-critical
      } finally {
        delete pendingScanIgnoredLoadsRef.current[scanId];
      }
    })();

    pendingScanIgnoredLoadsRef.current[scanId] = requestPromise;
    return requestPromise;
  }

  const buildCrossScanTabQueryKey = useCallback(() => JSON.stringify({
    q: debouncedFindingsSearchQuery.trim(),
    categories: selectedFindingCategories,
    sources: selectedFindingSources,
    themes: selectedFindingThemes.map((theme) => theme.trim()),
  }), [
    debouncedFindingsSearchQuery,
    selectedFindingCategories,
    selectedFindingSources,
    selectedFindingThemes,
  ]);

  const getCrossScanTabFindings = useCallback((tab: CrossScanTab) => {
    if (tab === 'bookmarks') return allBookmarkedFindings;
    if (tab === 'addressed') return allAddressedFindings;
    return allIgnoredFindings;
  }, [allAddressedFindings, allBookmarkedFindings, allIgnoredFindings]);

  function setCrossScanTabFindings(tab: CrossScanTab, findings: FindingSummary[]) {
    if (tab === 'bookmarks') {
      setAllBookmarkedFindings(findings);
      return;
    }
    if (tab === 'addressed') {
      setAllAddressedFindings(findings);
      return;
    }
    setAllIgnoredFindings(findings);
  }

  function setCrossScanTabTruncated(tab: CrossScanTab, truncated: boolean) {
    if (tab === 'bookmarks') {
      setBookmarkedFindingsTruncated(truncated);
      return;
    }
    if (tab === 'addressed') {
      setAddressedFindingsTruncated(truncated);
      return;
    }
    setIgnoredFindingsTruncated(truncated);
  }

  const loadCrossScanTabFindings = useCallback(async (
    tab: CrossScanTab,
    options?: { append?: boolean },
  ) => {
    const append = options?.append === true;
    const queryKey = buildCrossScanTabQueryKey();
    const currentCursor = crossScanTabNextCursor[tab];

    if (append && !currentCursor) return;

    const requestId = crossScanTabRequestIdRef.current[tab] + 1;
    crossScanTabRequestIdRef.current[tab] = requestId;
    crossScanTabLoadedQueryKeyRef.current[tab] = queryKey;

    setCrossScanTabErrors((prev) => ({ ...prev, [tab]: '' }));
    if (append) {
      setCrossScanTabLoadingMore((prev) => ({ ...prev, [tab]: true }));
    } else {
      setCrossScanTabLoading((prev) => ({ ...prev, [tab]: true }));
    }

    try {
      const params = new URLSearchParams({
        limit: `${FINDING_SEARCH_RESULTS_PAGE_SIZE}`,
      });
      if (tab === 'bookmarks') {
        params.set('bookmarkedOnly', 'true');
      } else if (tab === 'addressed') {
        params.set('addressedOnly', 'true');
      } else {
        params.set('ignoredOnly', 'true');
      }
      if (append && currentCursor) {
        params.set('cursor', currentCursor);
      }
      if (debouncedFindingsSearchQuery.trim()) {
        params.set('q', debouncedFindingsSearchQuery.trim());
      }
      appendActiveFindingFilterParams(params);
      if (
        tab === 'bookmarks'
        && !append
        && !debouncedFindingsSearchQuery.trim()
        && selectedFindingCategories.length === 0
        && selectedFindingSources.length === 0
        && selectedFindingThemes.length === 0
      ) {
        params.set('includeCount', 'true');
      }

      const res = await fetch(`/api/brands/${brandId}/findings?${params.toString()}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'Failed to load findings');
      }

      const json = await res.json().catch(() => ({}));
      if (crossScanTabRequestIdRef.current[tab] !== requestId) {
        return;
      }

      const nextFindings = (Array.isArray(json.data) ? json.data : []) as FindingSummary[];
      setCrossScanTabFindings(
        tab,
        append
          ? (() => {
              const seen = new Set(getCrossScanTabFindings(tab).map((finding) => finding.id));
              const appended = nextFindings.filter((finding) => !seen.has(finding.id));
              return appended.length > 0 ? [...getCrossScanTabFindings(tab), ...appended] : getCrossScanTabFindings(tab);
            })()
          : nextFindings,
      );
      setCrossScanTabNextCursor((prev) => ({
        ...prev,
        [tab]: json.hasMore ? (json.nextCursor ?? null) : null,
      }));
      setCrossScanTabTruncated(tab, json.truncated === true);
      if (tab === 'bookmarks' && typeof json.totalCount === 'number') {
        setBookmarkedFindingsTotalCount(json.totalCount);
      }
    } catch (err) {
      if (crossScanTabRequestIdRef.current[tab] !== requestId) {
        return;
      }
      setCrossScanTabErrors((prev) => ({
        ...prev,
        [tab]: err instanceof Error ? err.message : 'Failed to load findings',
      }));
      if (!append) {
        crossScanTabLoadedQueryKeyRef.current[tab] = null;
        setCrossScanTabFindings(tab, []);
        setCrossScanTabNextCursor((prev) => ({ ...prev, [tab]: null }));
        setCrossScanTabTruncated(tab, false);
      }
    } finally {
      if (crossScanTabRequestIdRef.current[tab] !== requestId) {
        return;
      }
      if (append) {
        setCrossScanTabLoadingMore((prev) => ({ ...prev, [tab]: false }));
      } else {
        setCrossScanTabLoading((prev) => ({ ...prev, [tab]: false }));
      }
    }
  }, [
    appendActiveFindingFilterParams,
    brandId,
    buildCrossScanTabQueryKey,
    crossScanTabNextCursor,
    debouncedFindingsSearchQuery,
    getCrossScanTabFindings,
    selectedFindingCategories.length,
    selectedFindingSources.length,
    selectedFindingThemes.length,
  ]);

  const refreshBookmarkedFindingsCount = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        bookmarkedOnly: 'true',
        includeCount: 'true',
        limit: '1',
      });
      const res = await fetch(`/api/brands/${brandId}/findings?${params.toString()}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const json = await res.json().catch(() => ({}));
      if (typeof json.totalCount === 'number') {
        setBookmarkedFindingsTotalCount(json.totalCount);
      }
    } catch {
      // Non-critical
    }
  }, [brandId]);

  const refreshFilteredCrossScanTabBadgeCounts = useCallback(async () => {
    const requestId = filteredCrossScanTabBadgeCountRequestIdRef.current + 1;
    filteredCrossScanTabBadgeCountRequestIdRef.current = requestId;

    const buildParams = (tab: CrossScanTab) => {
      const params = new URLSearchParams({
        includeCount: 'true',
        limit: '1',
      });
      if (tab === 'bookmarks') {
        params.set('bookmarkedOnly', 'true');
      } else if (tab === 'addressed') {
        params.set('addressedOnly', 'true');
      } else {
        params.set('ignoredOnly', 'true');
      }
      if (debouncedFindingsSearchQuery.trim()) {
        params.set('q', debouncedFindingsSearchQuery.trim());
      }
      appendActiveFindingFilterParams(params);
      return params;
    };

    try {
      const [bookmarksRes, addressedRes, ignoredRes] = await Promise.all([
        fetch(`/api/brands/${brandId}/findings?${buildParams('bookmarks').toString()}`, { credentials: 'same-origin' }),
        fetch(`/api/brands/${brandId}/findings?${buildParams('addressed').toString()}`, { credentials: 'same-origin' }),
        fetch(`/api/brands/${brandId}/findings?${buildParams('ignored').toString()}`, { credentials: 'same-origin' }),
      ]);

      const [bookmarksJson, addressedJson, ignoredJson] = await Promise.all([
        bookmarksRes.ok ? bookmarksRes.json().catch(() => ({})) : Promise.resolve({}),
        addressedRes.ok ? addressedRes.json().catch(() => ({})) : Promise.resolve({}),
        ignoredRes.ok ? ignoredRes.json().catch(() => ({})) : Promise.resolve({}),
      ]);

      if (filteredCrossScanTabBadgeCountRequestIdRef.current !== requestId) {
        return;
      }

      setFilteredCrossScanTabBadgeCounts({
        bookmarks: typeof bookmarksJson.totalCount === 'number' ? bookmarksJson.totalCount : 0,
        addressed: typeof addressedJson.totalCount === 'number' ? addressedJson.totalCount : 0,
        ignored: typeof ignoredJson.totalCount === 'number' ? ignoredJson.totalCount : 0,
      });
    } catch {
      if (filteredCrossScanTabBadgeCountRequestIdRef.current !== requestId) {
        return;
      }
    }
  }, [
    appendActiveFindingFilterParams,
    brandId,
    debouncedFindingsSearchQuery,
  ]);

  const loadFindingTaxonomyOptions = useCallback(async (options?: { excludeScanId?: string | null }) => {
    try {
      const params = new URLSearchParams();
      if (options?.excludeScanId) {
        params.set('excludeScanId', options.excludeScanId);
      }
      const queryString = params.toString();
      const res = await fetch(
        `/api/brands/${brandId}/findings/taxonomy${queryString ? `?${queryString}` : ''}`,
        { credentials: 'same-origin' },
      );
      if (res.ok) {
        const json = await res.json();
        setFindingTaxonomyOptions({
          themes: json.data?.themes ?? [],
        });
      }
    } catch {
      // Non-critical
    } finally {
      setHasLoadedFindingTaxonomyOptions(true);
    }
  }, [brandId]);

  useEffect(() => {
    void loadFindingTaxonomyOptions({
      excludeScanId: activeScanId,
    });
  }, [activeScanId, loadFindingTaxonomyOptions]);

  async function fetchLiveFindings(scanId: string) {
    try {
      const res = await fetch(`/api/brands/${brandId}/findings?scanId=${scanId}`, { credentials: 'same-origin' });
      if (res.ok) {
        const json = await res.json();
        setLiveScanFindings(json.data ?? []);
      }
    } catch {
      // Non-critical — polling will retry
    }
  }

  async function fetchLiveNonHits(scanId: string) {
    try {
      const res = await fetch(`/api/brands/${brandId}/findings?scanId=${scanId}&nonHitsOnly=true`, { credentials: 'same-origin' });
      if (res.ok) {
        const json = await res.json();
        setLiveScanNonHits(json.data ?? []);
      }
    } catch {
      // Non-critical — polling will retry
    }
  }

  async function fetchLiveScanBuckets(scanId: string) {
    await Promise.all([
      fetchLiveFindings(scanId),
      fetchLiveNonHits(scanId),
    ]);
  }

  function updateFindingList(
    findings: FindingSummary[],
    findingId: string,
    updater: (finding: FindingSummary) => FindingSummary,
  ) {
    let changed = false;
    const next = findings.map((finding) => {
      if (finding.id !== findingId) return finding;
      changed = true;
      return updater(finding);
    });
    return changed ? next : findings;
  }

  function updateFindingMap(
    record: Record<string, FindingSummary[]>,
    findingId: string,
    updater: (finding: FindingSummary) => FindingSummary,
  ) {
    let changed = false;
    const next: Record<string, FindingSummary[]> = {};
    for (const [key, findings] of Object.entries(record)) {
      const updated = updateFindingList(findings, findingId, updater);
      next[key] = updated;
      if (updated !== findings) changed = true;
    }
    return changed ? next : record;
  }

  function getFindingDisplayBucket(finding: Pick<FindingSummary, 'isFalsePositive' | 'isIgnored' | 'isAddressed'>) {
    if (finding.isFalsePositive === true) return 'non-hit' as const;
    if (finding.isIgnored === true) return 'ignored' as const;
    if (finding.isAddressed === true) return 'addressed' as const;
    return 'hit' as const;
  }

  function matchesSearchTabScope(
    finding: Pick<FindingSummary, 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'isBookmarked'>,
    tab: 'scans' | 'bookmarks' | 'ignored' | 'addressed',
  ) {
    if (tab === 'bookmarks') {
      return finding.isBookmarked === true;
    }

    const displayBucket = getFindingDisplayBucket(finding);
    if (tab === 'scans') {
      return displayBucket === 'hit' || displayBucket === 'non-hit';
    }
    if (tab === 'ignored') {
      return displayBucket === 'ignored';
    }
    return displayBucket === 'addressed';
  }

  function buildFindingSearchText(finding: FindingSummary) {
    const xHandleSearchText = finding.xAuthorHandle
      ? `${finding.xAuthorHandle} @${finding.xAuthorHandle}`
      : '';

    return normalizeFindingsSearchText(`${finding.title} ${finding.url ?? ''} ${finding.llmAnalysis} ${xHandleSearchText}`);
  }

  function buildSearchResult(
    finding: FindingSummary,
    previous?: FindingSearchResult,
  ): FindingSearchResult {
    return {
      ...finding,
      displayBucket: getFindingDisplayBucket(finding),
      ...(previous?.scanStartedAt ? { scanStartedAt: previous.scanStartedAt } : {}),
      ...(previous?.scanStatus ? { scanStatus: previous.scanStatus } : {}),
    };
  }

  function updateVisibleSearchResults(
    matcher: (result: FindingSearchResult) => boolean,
    updater: (result: FindingSearchResult) => FindingSummary,
  ) {
    setSearchResults((prev) => {
      let changed = false;
      const next: FindingSearchResult[] = [];
      for (const result of prev) {
        if (!matcher(result)) {
          next.push(result);
          continue;
        }

        changed = true;
        const updatedFinding = updater(result);
        if (!matchesSearchTabScope(updatedFinding, activeTab)) {
          continue;
        }

        next.push(buildSearchResult(updatedFinding, result));
      }

      return changed ? next : prev;
    });
  }

  function removeFindingsFromList(findings: FindingSummary[], findingIds: Set<string>) {
    const next = findings.filter((finding) => !findingIds.has(finding.id));
    return next.length === findings.length ? findings : next;
  }

  function upsertFindingsIntoList(findings: FindingSummary[], additions: FindingSummary[]) {
    if (additions.length === 0) return findings;
    const additionIds = new Set(additions.map((finding) => finding.id));
    return [...additions, ...findings.filter((finding) => !additionIds.has(finding.id))];
  }

  function attachToActiveScan(scan: Scan, options?: { collapseExpandedScans?: boolean }) {
    setScanning(true);
    setCancelling(false);
    setError('');
    setOptimisticActiveScanSettings(null);
    if (options?.collapseExpandedScans) {
      setExpandedScanIds([]);
    }
    setActiveScanId(scan.id);
    setActiveScan(scan);
    setLiveScanFindings([]);
    setLiveScanNonHits([]);
    setShowLiveScanNonHits(false);
    setStoredScanId(brandId, scan.id);
    startPolling(scan.id);
    void fetchLiveScanBuckets(scan.id);
  }

  async function restoreActiveScan(): Promise<boolean> {
    try {
      const res = await fetch(`/api/brands/${brandId}/active-scan`, { credentials: 'same-origin' });
      if (!res.ok) {
        clearStoredScanId(brandId);
        return false;
      }

      const json = await res.json();
      const scan = (json.data ?? null) as Scan | null;
      if (scan && (scan.status === 'pending' || scan.status === 'running' || scan.status === 'summarising')) {
        void refreshBrandProfile().catch(() => {
          // Non-critical
        });
        attachToActiveScan(scan);
        return true;
      } else {
        clearStoredScanId(brandId);
        return false;
      }
    } catch {
      // Non-critical
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Finding actions — bookmark, note, ignore, address, and reclassify
  // ---------------------------------------------------------------------------

  function handleFindingSelectionChange(finding: FindingSummary, selected: boolean) {
    setSelectedFindingIds((prev) => {
      if (selected) {
        return prev.includes(finding.id) ? prev : [...prev, finding.id];
      }
      return prev.filter((findingId) => findingId !== finding.id);
    });
  }

  function clearSelectedFindings() {
    setSelectedFindingIds([]);
    setIsBulkReclassifyDialogOpen(false);
    setSelectedBulkReclassificationCategory(null);
  }

  function isIgnoreCompatible(finding: FindingSummary) {
    return !finding.isFalsePositive && !finding.isIgnored && !finding.isAddressed;
  }

  function isAddressCompatible(finding: FindingSummary) {
    return !finding.isFalsePositive && !finding.isIgnored && !finding.isAddressed;
  }

  function isBookmarkCompatible(finding: FindingSummary) {
    return finding.isBookmarked !== true;
  }

  function isUnignoreCompatible(finding: FindingSummary) {
    return finding.isIgnored === true && !finding.isFalsePositive;
  }

  function isUnaddressCompatible(finding: FindingSummary) {
    return finding.isAddressed === true;
  }

  function isUnbookmarkCompatible(finding: FindingSummary) {
    return finding.isBookmarked === true;
  }

  function isReclassifyCompatible(finding: FindingSummary) {
    return finding.isAddressed !== true;
  }

  async function runBulkFindingAction(findings: FindingSummary[], action: (finding: FindingSummary) => Promise<void>) {
    if (findings.length === 0 || bulkActionLoading) return;

    setBulkActionLoading(true);
    setError('');
    try {
      for (const finding of findings) {
        await action(finding);
      }
      clearSelectedFindings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update selected findings');
    } finally {
      setBulkActionLoading(false);
    }
  }

  function applyFindingMetadataUpdate(
    triggerFinding: FindingSummary,
    responseData: {
      isBookmarked?: boolean;
      bookmarkNote?: string | null;
    },
  ) {
    const wasBookmarked = triggerFinding.isBookmarked === true;
    const isBookmarked = responseData.isBookmarked ?? triggerFinding.isBookmarked ?? false;
    const bookmarkNote = responseData.bookmarkNote ?? null;

    const applyMetadataUpdate = (finding: FindingSummary): FindingSummary => ({
      ...finding,
      isBookmarked,
      bookmarkedAt: isBookmarked ? finding.bookmarkedAt : undefined,
      bookmarkNote: bookmarkNote ?? undefined,
    });

    setScanFindings((prev) => updateFindingMap(prev, triggerFinding.id, applyMetadataUpdate));
    setScanNonHits((prev) => updateFindingMap(prev, triggerFinding.id, applyMetadataUpdate));
    setScanIgnored((prev) => updateFindingMap(prev, triggerFinding.id, applyMetadataUpdate));
    setLiveScanFindings((prev) => updateFindingList(prev, triggerFinding.id, applyMetadataUpdate));
    setLiveScanNonHits((prev) => updateFindingList(prev, triggerFinding.id, applyMetadataUpdate));
    setAllAddressedFindings((prev) => updateFindingList(prev, triggerFinding.id, applyMetadataUpdate));
    setAllIgnoredFindings((prev) => updateFindingList(prev, triggerFinding.id, applyMetadataUpdate));
    setAllBookmarkedFindings((prev) => {
      if (!isBookmarked) {
        return prev.filter((finding) => finding.id !== triggerFinding.id);
      }

      const existing = prev.find((finding) => finding.id === triggerFinding.id);
      const updatedFinding = applyMetadataUpdate(existing ?? triggerFinding);
      if (!existing) {
        return [updatedFinding, ...prev];
      }

      return prev.map((finding) => (finding.id === triggerFinding.id ? updatedFinding : finding));
    });
    if (wasBookmarked !== isBookmarked) {
      setBookmarkedFindingsTotalCount((prev) => {
        if (prev === null) return prev;
        return isBookmarked ? prev + 1 : Math.max(0, prev - 1);
      });
    }
    updateVisibleSearchResults(
      (result) => result.id === triggerFinding.id,
      (result) => applyMetadataUpdate(result),
    );
  }

  async function updateFindingMetadata(
    triggerFinding: FindingSummary,
    updates: {
      isBookmarked?: boolean;
      bookmarkNote?: string | null;
    },
    failureMessage: string,
  ) {
    const res = await fetch(`/api/brands/${brandId}/findings/${triggerFinding.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? failureMessage);
    }

    const json = await res.json().catch(() => ({}));
    const responseData = (json.data ?? {}) as {
      isBookmarked?: boolean;
      bookmarkNote?: string | null;
    };
    applyFindingMetadataUpdate(triggerFinding, responseData);
  }

  async function handleBookmarkUpdate(triggerFinding: FindingSummary, updates: BookmarkUpdate) {
    await updateFindingMetadata(triggerFinding, updates, 'Failed to update bookmark');
  }

  async function handleFindingNoteUpdate(triggerFinding: FindingSummary, note: string | null) {
    await updateFindingMetadata(triggerFinding, { bookmarkNote: note }, 'Failed to update note');
  }

  async function handleIgnoreToggle(triggerFinding: FindingSummary, isIgnored: boolean) {
    const res = await fetch(`/api/brands/${brandId}/findings/${triggerFinding.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ isIgnored }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? 'Failed to update finding');
    }

    const url = triggerFinding.url;

    if (url) {
      // URL-scoped update: apply the new ignored state to every finding in every loaded
      // scan cache that shares this URL.

      // Pre-compute which real (non-false-positive) findings will move between sections,
      // grouped by scan. We read from the current closure values before any setState calls.
      const movingFromHits: Record<string, FindingSummary[]> = {};
      const movingFromIgnored: Record<string, FindingSummary[]> = {};

      if (isIgnored) {
        for (const [sId, findings] of Object.entries(scanFindings)) {
          const matches = findings.filter((f) => f.url === url);
          if (matches.length > 0) movingFromHits[sId] = matches.map((f) => ({ ...f, isIgnored: true }));
        }
      } else {
        for (const [sId, findings] of Object.entries(scanIgnored)) {
          const matches = findings.filter((f) => f.url === url);
          if (matches.length > 0) movingFromIgnored[sId] = matches.map((f) => ({ ...f, isIgnored: false }));
        }
      }

      // Always update non-hits in place (they stay in their section regardless)
      setScanNonHits((prev) => {
        const updated: Record<string, FindingSummary[]> = {};
        for (const [sId, findings] of Object.entries(prev)) {
          updated[sId] = findings.map((f) => f.url === url ? { ...f, isIgnored } : f);
        }
        return updated;
      });

      if (isIgnored) {
        setScanFindings((prev) => {
          const updated = { ...prev };
          for (const sId of Object.keys(movingFromHits)) {
            updated[sId] = prev[sId].filter((f) => f.url !== url);
          }
          return updated;
        });
        setScanIgnored((prev) => {
          const updated = { ...prev };
          for (const [sId, moved] of Object.entries(movingFromHits)) {
            // Only update if already loaded — if undefined, leave it so lazy-load fetches the full list
            if (prev[sId] === undefined) continue;
            updated[sId] = [...moved, ...prev[sId].filter((f) => f.url !== url)];
          }
          return updated;
        });
        setAllIgnoredFindings((prev) => {
          const kept = prev.filter((f) => f.url !== url);
          const added = Object.values(movingFromHits).flat();
          return [...added, ...kept];
        });
        setScans((prev) =>
          prev.map((scan) => {
            const moved = movingFromHits[scan.id];
            if (!moved?.length) return scan;
            let dHigh = 0, dMed = 0, dLow = 0;
            for (const f of moved) {
              if (f.severity === 'high') dHigh++;
              else if (f.severity === 'medium') dMed++;
              else if (f.severity === 'low') dLow++;
            }
            return {
              ...scan,
              highCount: Math.max(0, scan.highCount - dHigh),
              mediumCount: Math.max(0, scan.mediumCount - dMed),
              lowCount: Math.max(0, scan.lowCount - dLow),
              ignoredCount: (scan.ignoredCount ?? 0) + moved.length,
            };
          }),
        );
      } else {
        setScanIgnored((prev) => {
          const updated = { ...prev };
          for (const sId of Object.keys(movingFromIgnored)) {
            // Only update if already loaded
            if (prev[sId] === undefined) continue;
            updated[sId] = prev[sId].filter((f) => f.url !== url);
          }
          return updated;
        });
        // Only restore to scanFindings for scans that are already loaded
        setScanFindings((prev) => {
          const updated = { ...prev };
          for (const [sId, moved] of Object.entries(movingFromIgnored)) {
            if (prev[sId] === undefined) continue;
            updated[sId] = [...moved, ...prev[sId]];
          }
          return updated;
        });
        setAllIgnoredFindings((prev) => prev.filter((f) => f.url !== url));
        setScans((prev) =>
          prev.map((scan) => {
            const moved = movingFromIgnored[scan.id];
            if (!moved?.length) return scan;
            let dHigh = 0, dMed = 0, dLow = 0;
            for (const f of moved) {
              if (f.severity === 'high') dHigh++;
              else if (f.severity === 'medium') dMed++;
              else if (f.severity === 'low') dLow++;
            }
            return {
              ...scan,
              highCount: scan.highCount + dHigh,
              mediumCount: scan.mediumCount + dMed,
              lowCount: scan.lowCount + dLow,
              ignoredCount: Math.max(0, (scan.ignoredCount ?? 0) - moved.length),
            };
          }),
        );
      }

      updateVisibleSearchResults(
        (result) => result.url === url,
        (result) => ({ ...result, isIgnored }),
      );
      return;
    }

    // ── No URL: single-document fallback ──────────────────────────────────────
    // Locate the finding from whichever cache holds it. Non-hits stay in their
    // section; real findings move between hits ↔ ignored.
    const findingId = triggerFinding.id;
    let targetFinding: FindingSummary | undefined;
    let targetScanId: string | undefined;
    let isNonHit = false;

    for (const [sId, findings] of Object.entries(scanNonHits)) {
      const f = findings.find((f) => f.id === findingId);
      if (f) { targetFinding = f; targetScanId = sId; isNonHit = true; break; }
    }
    if (!targetFinding) {
      for (const [sId, findings] of Object.entries(scanFindings)) {
        const f = findings.find((f) => f.id === findingId);
        if (f) { targetFinding = f; targetScanId = sId; break; }
      }
    }
    if (!targetFinding) {
      for (const [sId, findings] of Object.entries(scanIgnored)) {
        const f = findings.find((f) => f.id === findingId);
        if (f) { targetFinding = f; targetScanId = sId; break; }
      }
    }
    if (!targetFinding) {
      targetFinding = allIgnoredFindings.find((f) => f.id === findingId);
      if (targetFinding) targetScanId = targetFinding.scanId;
    }
    if (!targetFinding || !targetScanId) return;

    const updatedFinding: FindingSummary = { ...targetFinding, isIgnored };

    if (isNonHit) {
      setScanNonHits((prev) => {
        if (prev[targetScanId!] === undefined) return prev;
        return {
          ...prev,
          [targetScanId!]: prev[targetScanId!].map((f) => f.id === findingId ? updatedFinding : f),
        };
      });
      return;
    }

    if (isIgnored) {
      setScanFindings((prev) => {
        if (prev[targetScanId!] === undefined) return prev;
        return { ...prev, [targetScanId!]: prev[targetScanId!].filter((f) => f.id !== findingId) };
      });
      setScanIgnored((prev) => {
        // Only update if already loaded — if undefined, leave it so lazy-load fetches the full list
        if (prev[targetScanId!] === undefined) return prev;
        return { ...prev, [targetScanId!]: [updatedFinding, ...prev[targetScanId!]] };
      });
      setAllIgnoredFindings((prev) => [updatedFinding, ...prev.filter((f) => f.id !== findingId)]);
    } else {
      setScanIgnored((prev) => {
        if (prev[targetScanId!] === undefined) return prev;
        return { ...prev, [targetScanId!]: prev[targetScanId!].filter((f) => f.id !== findingId) };
      });
      setScanFindings((prev) => {
        if (prev[targetScanId!] === undefined) return prev;
        return { ...prev, [targetScanId!]: [updatedFinding, ...prev[targetScanId!]] };
      });
      setAllIgnoredFindings((prev) => prev.filter((f) => f.id !== findingId));
    }

    const sev = targetFinding.severity;
    setScans((prev) =>
      prev.map((scan) => {
        if (scan.id !== targetScanId) return scan;
        if (isIgnored) {
          return {
            ...scan,
            highCount: sev === 'high' ? Math.max(0, scan.highCount - 1) : scan.highCount,
            mediumCount: sev === 'medium' ? Math.max(0, scan.mediumCount - 1) : scan.mediumCount,
            lowCount: sev === 'low' ? Math.max(0, scan.lowCount - 1) : scan.lowCount,
            ignoredCount: (scan.ignoredCount ?? 0) + 1,
          };
        } else {
          return {
            ...scan,
            highCount: sev === 'high' ? scan.highCount + 1 : scan.highCount,
            mediumCount: sev === 'medium' ? scan.mediumCount + 1 : scan.mediumCount,
            lowCount: sev === 'low' ? scan.lowCount + 1 : scan.lowCount,
            ignoredCount: Math.max(0, (scan.ignoredCount ?? 0) - 1),
          };
        }
      }),
    );
    updateVisibleSearchResults(
      (result) => result.id === findingId,
      (result) => ({ ...result, isIgnored }),
    );
  }

  async function handleAddressedToggle(triggerFinding: FindingSummary, isAddressed: boolean) {
    const res = await fetch(`/api/brands/${brandId}/findings/${triggerFinding.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ isAddressed }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? 'Failed to update finding');
    }

    const json = await res.json().catch(() => ({}));
    const responseData = (json.data ?? {}) as {
      affectedFindings?: FindingSummary[];
      affectedScanDeltas?: Record<string, {
        findingCount: number;
        highCount: number;
        mediumCount: number;
        lowCount: number;
        nonHitCount: number;
        ignoredCount: number;
        addressedCount: number;
      }>;
    };
    const fallbackFinding: FindingSummary = {
      ...triggerFinding,
      isIgnored: false,
      isAddressed,
    };
    const affectedFindings = Array.isArray(responseData.affectedFindings) && responseData.affectedFindings.length > 0
      ? responseData.affectedFindings
      : [fallbackFinding];
    const affectedIds = new Set(affectedFindings.map((finding) => finding.id));
    const affectedFindingsById = new Map(affectedFindings.map((finding) => [finding.id, finding]));
    const nextHitsByScanId = affectedFindings.reduce<Record<string, FindingSummary[]>>((acc, finding) => {
      if (getFindingDisplayBucket(finding) !== 'hit') return acc;
      if (!acc[finding.scanId]) acc[finding.scanId] = [];
      acc[finding.scanId].push(finding);
      return acc;
    }, {});
    const nextAddressedFindings = affectedFindings.filter((finding) => getFindingDisplayBucket(finding) === 'addressed');
    const nextLiveHits = affectedFindings.filter((finding) => getFindingDisplayBucket(finding) === 'hit');

    setScanFindings((prev) => {
      let changed = false;
      const next: Record<string, FindingSummary[]> = {};
      for (const [scanId, findings] of Object.entries(prev)) {
        let updated = removeFindingsFromList(findings, affectedIds);
        const additions = nextHitsByScanId[scanId] ?? [];
        if (additions.length > 0) {
          updated = upsertFindingsIntoList(updated, additions);
        }
        next[scanId] = updated;
        if (updated !== findings) changed = true;
      }
      return changed ? next : prev;
    });

    setLiveScanFindings((prev) => upsertFindingsIntoList(removeFindingsFromList(prev, affectedIds), nextLiveHits));
    setLiveScanNonHits((prev) => removeFindingsFromList(prev, affectedIds));
    setAllAddressedFindings((prev) => {
      const next = removeFindingsFromList(prev, affectedIds);
      return nextAddressedFindings.length > 0 ? upsertFindingsIntoList(next, nextAddressedFindings) : next;
    });
    setAllBookmarkedFindings((prev) => prev.map((finding) => affectedFindingsById.get(finding.id) ?? finding));
    setAllIgnoredFindings((prev) => removeFindingsFromList(prev, affectedIds));
    updateVisibleSearchResults(
      (result) => affectedFindingsById.has(result.id),
      (result) => affectedFindingsById.get(result.id) ?? result,
    );
    setScans((prev) =>
      prev.map((scan) => {
        const delta = responseData.affectedScanDeltas?.[scan.id];
        if (!delta) return scan;

        return {
          ...scan,
          highCount: Math.max(0, scan.highCount + delta.highCount),
          mediumCount: Math.max(0, scan.mediumCount + delta.mediumCount),
          lowCount: Math.max(0, scan.lowCount + delta.lowCount),
          nonHitCount: Math.max(0, scan.nonHitCount + delta.nonHitCount),
          ignoredCount: Math.max(0, (scan.ignoredCount ?? 0) + delta.ignoredCount),
          addressedCount: Math.max(0, (scan.addressedCount ?? 0) + delta.addressedCount),
        };
      }),
    );
  }

  async function handleReclassifyFinding(triggerFinding: FindingSummary, category: FindingCategory) {
    const res = await fetch(`/api/brands/${brandId}/findings/${triggerFinding.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ reclassifiedCategory: category }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? 'Failed to reclassify finding');
    }

    const json = await res.json().catch(() => ({}));
    const responseData = (json.data ?? {}) as {
      affectedFindings?: FindingSummary[];
      affectedScanDeltas?: Record<string, {
        findingCount: number;
        highCount: number;
        mediumCount: number;
        lowCount: number;
        nonHitCount: number;
        ignoredCount: number;
        addressedCount: number;
      }>;
    };
    const fallbackFinding: FindingSummary = {
      ...triggerFinding,
      severity: category === 'non-hit' ? triggerFinding.severity : category,
      isFalsePositive: category === 'non-hit',
      isIgnored: category === 'non-hit',
      isAddressed: false,
    };
    const affectedFindings = Array.isArray(responseData.affectedFindings) && responseData.affectedFindings.length > 0
      ? responseData.affectedFindings
      : [fallbackFinding];
    const affectedIds = new Set(affectedFindings.map((finding) => finding.id));
    const affectedFindingsByScanId = affectedFindings.reduce<Record<string, FindingSummary[]>>((acc, finding) => {
      if (!acc[finding.scanId]) acc[finding.scanId] = [];
      acc[finding.scanId].push(finding);
      return acc;
    }, {});
    const affectedCountsByScanId = affectedFindings.reduce<Record<string, number>>((acc, finding) => {
      acc[finding.scanId] = (acc[finding.scanId] ?? 0) + 1;
      return acc;
    }, {});
    const affectedFindingsById = new Map(affectedFindings.map((finding) => [finding.id, finding]));
    const nextHitsByScanId: Record<string, FindingSummary[]> = {};
    const nextNonHitsByScanId: Record<string, FindingSummary[]> = {};
    const nextIgnoredByScanId: Record<string, FindingSummary[]> = {};
    const nextAddressedFindings: FindingSummary[] = [];
    for (const [scanId, findings] of Object.entries(affectedFindingsByScanId)) {
      nextHitsByScanId[scanId] = findings.filter((finding) => getFindingDisplayBucket(finding) === 'hit');
      nextNonHitsByScanId[scanId] = findings.filter((finding) => getFindingDisplayBucket(finding) === 'non-hit');
      nextIgnoredByScanId[scanId] = findings.filter((finding) => getFindingDisplayBucket(finding) === 'ignored');
      nextAddressedFindings.push(...findings.filter((finding) => getFindingDisplayBucket(finding) === 'addressed'));
    }
    const nextLiveHits = affectedFindings.filter((finding) => getFindingDisplayBucket(finding) === 'hit');
    const nextLiveNonHits = affectedFindings.filter((finding) => getFindingDisplayBucket(finding) === 'non-hit');

    setScanFindings((prev) => {
      let changed = false;
      const next: Record<string, FindingSummary[]> = {};
      for (const [scanId, findings] of Object.entries(prev)) {
        let updated = removeFindingsFromList(findings, affectedIds);
        const additions = nextHitsByScanId[scanId] ?? [];
        if (additions.length > 0) {
          updated = upsertFindingsIntoList(updated, additions);
        }
        next[scanId] = updated;
        if (updated !== findings) changed = true;
      }
      return changed ? next : prev;
    });

    setScanNonHits((prev) => {
      let changed = false;
      const next: Record<string, FindingSummary[]> = {};
      for (const [scanId, findings] of Object.entries(prev)) {
        let updated = removeFindingsFromList(findings, affectedIds);
        const additions = nextNonHitsByScanId[scanId] ?? [];
        if (additions.length > 0) {
          updated = upsertFindingsIntoList(updated, additions);
        }
        next[scanId] = updated;
        if (updated !== findings) changed = true;
      }
      return changed ? next : prev;
    });

    setScanIgnored((prev) => {
      let changed = false;
      const next: Record<string, FindingSummary[]> = {};
      for (const [scanId, findings] of Object.entries(prev)) {
        let updated = removeFindingsFromList(findings, affectedIds);
        const additions = nextIgnoredByScanId[scanId] ?? [];
        if (additions.length > 0) {
          updated = upsertFindingsIntoList(updated, additions);
        }
        next[scanId] = updated;
        if (updated !== findings) changed = true;
      }
      return changed ? next : prev;
    });

    setLiveScanFindings((prev) => upsertFindingsIntoList(removeFindingsFromList(prev, affectedIds), nextLiveHits));
    setLiveScanNonHits((prev) => upsertFindingsIntoList(removeFindingsFromList(prev, affectedIds), nextLiveNonHits));
    setAllIgnoredFindings((prev) => {
      const next = removeFindingsFromList(prev, affectedIds);
      const additions = affectedFindings.filter((finding) => getFindingDisplayBucket(finding) === 'ignored');
      return additions.length > 0 ? upsertFindingsIntoList(next, additions) : next;
    });
    setAllAddressedFindings((prev) => {
      const next = removeFindingsFromList(prev, affectedIds);
      return nextAddressedFindings.length > 0 ? upsertFindingsIntoList(next, nextAddressedFindings) : next;
    });
    setAllBookmarkedFindings((prev) => prev.map((finding) => affectedFindingsById.get(finding.id) ?? finding));
    updateVisibleSearchResults(
      (result) => affectedFindingsById.has(result.id),
      (result) => affectedFindingsById.get(result.id) ?? result,
    );
    setScans((prev) =>
      prev.map((scan) => {
        const delta = responseData.affectedScanDeltas?.[scan.id];
        if (!delta) {
          const affectedCount = affectedCountsByScanId[scan.id] ?? 0;
          if (affectedCount === 0) return scan;
          return scan;
        }

        return {
          ...scan,
          highCount: Math.max(0, scan.highCount + delta.highCount),
          mediumCount: Math.max(0, scan.mediumCount + delta.mediumCount),
          lowCount: Math.max(0, scan.lowCount + delta.lowCount),
          nonHitCount: Math.max(0, scan.nonHitCount + delta.nonHitCount),
          ignoredCount: Math.max(0, (scan.ignoredCount ?? 0) + delta.ignoredCount),
          addressedCount: Math.max(0, (scan.addressedCount ?? 0) + delta.addressedCount),
        };
      }),
    );
  }

  function openBulkReclassifyDialog() {
    if (bulkReclassifyCompatibleFindings.length === 0 || bulkActionLoading) return;
    setSelectedBulkReclassificationCategory(null);
    setIsBulkReclassifyDialogOpen(true);
  }

  async function confirmBulkReclassification() {
    if (!selectedBulkReclassificationCategory) return;
    const compatibleFindings = bulkReclassifyCompatibleFindings.filter((finding) => {
      if (selectedBulkReclassificationCategory === 'non-hit') {
        return finding.isFalsePositive !== true;
      }
      return finding.isFalsePositive === true || finding.severity !== selectedBulkReclassificationCategory;
    });

    setIsBulkReclassifyDialogOpen(false);
    await runBulkFindingAction(
      compatibleFindings,
      async (finding) => handleReclassifyFinding(finding, selectedBulkReclassificationCategory),
    );
  }

  // ---------------------------------------------------------------------------
  // On mount: fetch brand + scans; restore in-flight scan if present
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function fetchData() {
      setError('');
      setLoading(true);

      void loadFindingTaxonomyOptions();
      void refreshBookmarkedFindingsCount();

      try {
        const brandProfile = await refreshBrandProfile();
        if (!brandProfile) return; // redirecting to /brands

        // Fetch scans list without auto-expanding until we know whether an
        // in-flight scan should own the active UI slot.
        const loadedScans = await fetchScans({ skipAutoExpand: true });

        // Resume any globally active scan for this brand, even if it was started in another tab
        // or environment that shares the same Firestore data.
        const restoredActiveScan = await restoreActiveScan();
        const initialHashScanId = typeof window === 'undefined'
          ? null
          : getScanResultSetIdFromUrl(window.location.href);
        const hasValidInitialHashScan = initialHashScanId
          ? loadedScans.some((scan) => scan.id === initialHashScanId)
          : false;

        if (!restoredActiveScan && !hasValidInitialHashScan && loadedScans[0]?.id) {
          setExpandedScanIds([loadedScans[0].id]);
          loadScanFindings(loadedScans[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
    return () => stopPolling();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, loadFindingTaxonomyOptions, refreshBookmarkedFindingsCount]);

  useEffect(() => {
    if (!isAnyFindingFilterActive) {
      filteredCrossScanTabBadgeCountRequestIdRef.current += 1;
      setFilteredCrossScanTabBadgeCounts({
        bookmarks: null,
        addressed: null,
        ignored: null,
      });
      return;
    }

    void refreshFilteredCrossScanTabBadgeCounts();
  }, [isAnyFindingFilterActive, refreshFilteredCrossScanTabBadgeCounts]);

  // Poll the brand profile while a history deletion is in progress so the
  // Run scan button re-enables automatically when Cloud Tasks finishes the job.
  const isDeletionInProgress = hasActiveHistoryDeletion(brand);
  useEffect(() => {
    if (!isDeletionInProgress) {
      stopDeletionPolling();
      return;
    }
    if (deletionPollRef.current) return; // already polling
    deletionPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/brands/${brandId}`, { credentials: 'same-origin' });
        if (!res.ok) return;
        const json = await res.json();
        const updatedBrand = json.data as BrandProfile;
        setBrand(updatedBrand);
        if (!hasActiveHistoryDeletion(updatedBrand)) {
          stopDeletionPolling();
          // Refresh scans list now that deletion is complete
          void fetchScans();
        }
      } catch {
        // Transient failure — keep polling
      }
    }, 3000);
    return () => stopDeletionPolling();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDeletionInProgress, brandId]);

  useEffect(() => {
    function syncAnchorTargetFromHash() {
      const nextScanId = getScanResultSetIdFromUrl(window.location.href);
      setAnchorTargetScanId(nextScanId);

      if (nextScanId) {
        setActiveTab('scans');
        setConfirmClear(false);
        setConfirmDeleteScanId(null);
      }
    }

    syncAnchorTargetFromHash();
    window.addEventListener('hashchange', syncAnchorTargetFromHash);

    return () => window.removeEventListener('hashchange', syncAnchorTargetFromHash);
  }, []);

  useEffect(() => {
    if (!anchorTargetScanId) return;
    if (!scans.some((scan) => scan.id === anchorTargetScanId)) return;

    setExpandedScanIds([anchorTargetScanId]);
    void loadScanFindings(anchorTargetScanId);
    scrollToScanResultSet(anchorTargetScanId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorTargetScanId, scans]);

  useEffect(() => {
    if (!anchorTargetScanId || singleSelectedFindingCategory !== 'non-hit') return;
    if (!scans.some((scan) => scan.id === anchorTargetScanId)) return;

    void loadScanNonHits(anchorTargetScanId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorTargetScanId, scans, singleSelectedFindingCategory]);

  useEffect(() => {
    if (!anchorTargetScanId || !singleSelectedFindingCategory) return;
    if (!scans.some((scan) => scan.id === anchorTargetScanId)) return;

    scrollToScanCategorySection(anchorTargetScanId, singleSelectedFindingCategory);
  }, [anchorTargetScanId, scanFindings, scanNonHits, scans, singleSelectedFindingCategory]);

  useEffect(() => {
    if (loading || scanning) return;

    const idlePoll = setInterval(() => {
      void restoreActiveScan();
    }, ACTIVE_SCAN_IDLE_POLL_INTERVAL_MS);

    return () => clearInterval(idlePoll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, loading, scanning]);

  useEffect(() => {
    if (isExecutiveSummaryMentionsMode && activeTab !== 'scans') {
      setActiveTab('scans');
    }
  }, [activeTab, isExecutiveSummaryMentionsMode]);

  useEffect(() => {
    if (!shouldUseServerFindingSearch) {
      findingSearchAbortControllerRef.current?.abort();
      findingSearchAbortControllerRef.current = null;
      setServerSearchLoading(false);
      setLoadingMoreSearchResults(false);
      if (activeTab === 'scans' || !isFindingsSearchActive) {
        setSearchResults([]);
        setSearchResultsTotalCount(null);
        setSearchResultsNextCursor(null);
        setSearchResultsError('');
        setSearchResultsTruncated(false);
      }
      return;
    }

    if (!canRunServerFindingSearch) {
      findingSearchAbortControllerRef.current?.abort();
      findingSearchAbortControllerRef.current = null;
      setServerSearchLoading(false);
      setLoadingMoreSearchResults(false);
      setSearchResults([]);
      setSearchResultsTotalCount(null);
      setSearchResultsNextCursor(null);
      setSearchResultsError('');
      setSearchResultsTruncated(false);
      return;
    }

    const requestId = ++findingSearchRequestIdRef.current;
    findingSearchAbortControllerRef.current?.abort();
    const controller = new AbortController();
    findingSearchAbortControllerRef.current = controller;
    setServerSearchLoading(true);
    setLoadingMoreSearchResults(false);
    setSearchResultsError('');

    void fetchServerSearchResults({ signal: controller.signal }).catch((err) => {
      if (controller.signal.aborted || requestId !== findingSearchRequestIdRef.current) {
        return;
      }

      setSearchResults([]);
      setSearchResultsTotalCount(null);
      setSearchResultsNextCursor(null);
      setSearchResultsTruncated(false);
      setSearchResultsError(err instanceof Error ? err.message : 'Failed to search findings');
    }).finally(() => {
      if (!controller.signal.aborted && requestId === findingSearchRequestIdRef.current) {
        setServerSearchLoading(false);
      }
    });

    return () => {
      controller.abort();
    };
  }, [
    activeTab,
    canRunServerFindingSearch,
    fetchServerSearchResults,
    isFindingsSearchActive,
    shouldUseServerFindingSearch,
  ]);

  useEffect(() => {
    if (activeTab === 'scans') {
      return;
    }

    const queryKey = buildCrossScanTabQueryKey();
    if (crossScanTabLoadedQueryKeyRef.current[activeTab] === queryKey) {
      return;
    }

    setCrossScanTabNextCursor((prev) => ({ ...prev, [activeTab]: null }));
    setCrossScanTabErrors((prev) => ({ ...prev, [activeTab]: '' }));
    setCrossScanTabTruncated(activeTab, false);
    void loadCrossScanTabFindings(activeTab);
  }, [
    activeTab,
    buildCrossScanTabQueryKey,
    debouncedFindingsSearchQuery,
    getCrossScanTabFindings,
    loadCrossScanTabFindings,
    selectedFindingCategories,
    selectedFindingSources,
    selectedFindingThemes,
  ]);

  const availableFindingThemes = useMemo(() => {
    if (hasLoadedFindingTaxonomyOptions) {
      return collectDistinctFindingTaxonomyLabels(findingTaxonomyOptions.themes);
    }

    return collectDistinctFindingTaxonomyLabels([
      ...allBookmarkedFindings.map((finding) => finding.theme),
      ...allAddressedFindings.map((finding) => finding.theme),
      ...allIgnoredFindings.map((finding) => finding.theme),
      ...liveScanFindings.map((finding) => finding.theme),
      ...liveScanNonHits.map((finding) => finding.theme),
      ...Object.values(scanFindings).flat().map((finding) => finding.theme),
      ...Object.values(scanNonHits).flat().map((finding) => finding.theme),
      ...Object.values(scanIgnored).flat().map((finding) => finding.theme),
    ]);
  }, [
    hasLoadedFindingTaxonomyOptions,
    findingTaxonomyOptions.themes,
    allBookmarkedFindings,
    allAddressedFindings,
    allIgnoredFindings,
    liveScanFindings,
    liveScanNonHits,
    scanFindings,
    scanNonHits,
    scanIgnored,
  ]);

  const selectedFindingIdSet = useMemo(() => new Set(selectedFindingIds), [selectedFindingIds]);
  const selectableFindingMap = useMemo(() => {
    const next = new Map<string, FindingSummary>();
    for (const finding of [
      ...searchResults,
      ...allBookmarkedFindings,
      ...allAddressedFindings,
      ...allIgnoredFindings,
      ...liveScanFindings,
      ...liveScanNonHits,
      ...Object.values(scanFindings).flat(),
      ...Object.values(scanNonHits).flat(),
      ...Object.values(scanIgnored).flat(),
    ]) {
      next.set(finding.id, finding);
    }
    return next;
  }, [
    allAddressedFindings,
    allBookmarkedFindings,
    allIgnoredFindings,
    liveScanFindings,
    liveScanNonHits,
    scanFindings,
    scanIgnored,
    scanNonHits,
    searchResults,
  ]);
  const selectedFindings = useMemo(
    () => selectedFindingIds
      .map((findingId) => selectableFindingMap.get(findingId))
      .filter((finding): finding is FindingSummary => Boolean(finding)),
    [selectedFindingIds, selectableFindingMap],
  );
  const bulkIgnoreCompatibleFindings = selectedFindings.filter(isIgnoreCompatible);
  const bulkAddressCompatibleFindings = selectedFindings.filter(isAddressCompatible);
  const bulkBookmarkCompatibleFindings = selectedFindings.filter(isBookmarkCompatible);
  const bulkUnignoreCompatibleFindings = selectedFindings.filter(isUnignoreCompatible);
  const bulkUnaddressCompatibleFindings = selectedFindings.filter(isUnaddressCompatible);
  const bulkUnbookmarkCompatibleFindings = selectedFindings.filter(isUnbookmarkCompatible);
  const bulkReclassifyCompatibleFindings = selectedFindings.filter(isReclassifyCompatible);

  useEffect(() => {
    if (!hasLoadedFindingTaxonomyOptions) return;
    if (availableFindingThemes.length === 0) return;
    const availableThemeKeySet = new Set(
      availableFindingThemes.map((theme) => normalizeFindingsTaxonomyValue(theme)),
    );
    setSelectedFindingThemes((previousThemes) => {
      const nextThemes = previousThemes.filter((theme) => (
        availableThemeKeySet.has(normalizeFindingsTaxonomyValue(theme))
      ));
      return nextThemes.length === previousThemes.length ? previousThemes : nextThemes;
    });
  }, [availableFindingThemes, hasLoadedFindingTaxonomyOptions]);

  useEffect(() => {
    setSelectedFindingIds((prev) => {
      const next = prev.filter((findingId) => selectableFindingMap.has(findingId));
      return next.length === prev.length ? prev : next;
    });
  }, [selectableFindingMap]);

  useEffect(() => {
    if (selectedFindings.length > 0) return;
    setIsBulkActionPanelExpanded(false);
    setIsBulkReclassifyDialogOpen(false);
    setSelectedBulkReclassificationCategory(null);
  }, [selectedFindings.length]);

  useEffect(() => {
    return () => {
      findingSearchAbortControllerRef.current?.abort();
      if (copiedScanLinkResetTimeoutRef.current) {
        clearTimeout(copiedScanLinkResetTimeoutRef.current);
      }
      if (lookbackNudgeSuccessTimeoutRef.current) {
        clearTimeout(lookbackNudgeSuccessTimeoutRef.current);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Scan toggling
  // ---------------------------------------------------------------------------

  function toggleScanExpand(scanId: string) {
    setAnchorTargetScanId(null);
    const isCurrentlyExpanded = expandedScanIds.includes(scanId);
    setExpandedScanIds((prev) =>
      isCurrentlyExpanded ? prev.filter((id) => id !== scanId) : [...prev, scanId],
    );
    if (!isCurrentlyExpanded) {
      loadScanFindings(scanId);
    }
  }

  function switchFindingsTab(tab: 'scans' | 'bookmarks' | 'ignored' | 'addressed') {
    if (tab !== 'scans') {
      setAnchorTargetScanId(null);
    }
    setActiveTab(tab);
    if (tab !== 'scans') {
      setConfirmClear(false);
      setConfirmDeleteScanId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Lookback period nudge
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (loading) return;
    if (!brand) return;
    if (brand.lookbackNudgeDismissed) return;
    if ((brand.lookbackPeriod ?? '1year') !== '1year') return;
    if (scans.length < 3) return;
    setIsLookbackNudgeOpen(true);
  }, [loading, brand, scans.length]);

  useEffect(() => {
    if (!isLookbackNudgeOpen) return undefined;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !lookbackNudgeLoading) {
        setIsLookbackNudgeOpen(false);
        setBrand((prev) => prev ? { ...prev, lookbackNudgeDismissed: true } : prev);
        void fetch(`/api/brands/${brandId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ lookbackNudgeDismissed: true }),
        }).catch(() => { /* non-critical */ });
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [brandId, lookbackNudgeLoading, isLookbackNudgeOpen]);

  async function handleLookbackNudgeAccept() {
    if (!brand || lookbackNudgeLoading) return;
    setLookbackNudgeLoading(true);
    setIsLookbackNudgeOpen(false);
    setBrand((prev) => prev ? { ...prev, lookbackPeriod: 'since_last_scan', lookbackNudgeDismissed: true } : prev);
    try {
      await fetch(`/api/brands/${brandId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ lookbackPeriod: 'since_last_scan', lookbackNudgeDismissed: true }),
      });
      if (lookbackNudgeSuccessTimeoutRef.current) {
        clearTimeout(lookbackNudgeSuccessTimeoutRef.current);
      }
      setLookbackNudgeSuccessMessage('The lookback period for this brand has been updated to \u2018Since last scan\u2019.');
      lookbackNudgeSuccessTimeoutRef.current = setTimeout(() => {
        setLookbackNudgeSuccessMessage('');
      }, 6000);
    } catch {
      setError('Failed to update lookback period. Please update it in Brand Settings.');
    } finally {
      setLookbackNudgeLoading(false);
    }
  }

  function handleLookbackNudgeDismiss() {
    if (lookbackNudgeLoading) return;
    setIsLookbackNudgeOpen(false);
    setBrand((prev) => prev ? { ...prev, lookbackNudgeDismissed: true } : prev);
    void fetch(`/api/brands/${brandId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ lookbackNudgeDismissed: true }),
    }).catch(() => { /* non-critical */ });
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  function startPolling(scanId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const pollRes = await fetch(`/api/scan?scanId=${scanId}`, { credentials: 'same-origin' });
        if (!pollRes.ok) return;

        const pollJson = await pollRes.json();
        const scan = pollJson.data as Scan;
        setActiveScan(scan);

        if (scan.status === 'completed') {
          stopPolling();
          clearStoredScanId(brandId);
          // Fetch the final findings so they appear in the live section right before
          // the transition — this catches results from batch-mode scans that complete
          // in one go and are otherwise too brief to catch via polling.
          await fetchLiveScanBuckets(scanId);
          // Fetch the scan list before transitioning so that:
          //   (a) the completed scan row and its loading state are ready to render
          //       the moment the live section disappears, and
          //   (b) totalFindings is populated before the completion banner renders.
          await fetchScans({ autoExpandScanId: scanId });
          // Transition: live section disappears; the scan row (already expanded
          // with a loading spinner from loadScanFindings) becomes visible.
          await refreshBrandProfile().catch(() => {
            // Non-critical
          });
          void loadFindingTaxonomyOptions();
          setScanning(false);
          setCancelling(false);
          setOptimisticActiveScanSettings(null);
          setActiveScanId(null);
          setActiveScan(null);
          setLiveScanFindings([]);
          setLiveScanNonHits([]);
          setShowLiveScanNonHits(false);
          // (scan complete — findings visible in the scan list row)
        } else if (scan.status === 'failed') {
          stopPolling();
          clearStoredScanId(brandId);
          setScanning(false);
          setCancelling(false);
          setOptimisticActiveScanSettings(null);
          setActiveScanId(null);
          setLiveScanFindings([]);
          setLiveScanNonHits([]);
          setShowLiveScanNonHits(false);
          setError(scan.errorMessage ?? 'Scan failed');
          setActiveScan(null);
          await refreshBrandProfile().catch(() => {
            // Non-critical
          });
          await fetchScans();
        } else if (scan.status === 'cancelled') {
          stopPolling();
          clearStoredScanId(brandId);
          setScanning(false);
          setCancelling(false);
          setOptimisticActiveScanSettings(null);
          setActiveScanId(null);
          setLiveScanFindings([]);
          setLiveScanNonHits([]);
          setShowLiveScanNonHits(false);
          setActiveScan(null);
          await refreshBrandProfile().catch(() => {
            // Non-critical
          });
          await fetchScans();
        } else {
          // Scan still running — refresh live findings
          await fetchLiveScanBuckets(scanId);
        }
      } catch {
        // Transient poll failure — keep trying
      }
    }, POLL_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Trigger scan
  // ---------------------------------------------------------------------------

  function openCustomScanDialog() {
    setIsRunScanMenuOpen(false);
    setCustomScanSettings(getEffectiveScanSettings(brand));
    setCustomScanError('');
    setIsCustomScanDialogOpen(true);
  }

  function closeCustomScanDialog() {
    if (scanning) return;
    setIsCustomScanDialogOpen(false);
    setCustomScanError('');
  }

  async function triggerScan(customSettings?: ScanSettingsInput) {
    const nextEffectiveSettings = getEffectiveScanSettings(brand, customSettings);
    setScanning(true);
    setError('');
    setCustomScanError('');
    setIsRunScanMenuOpen(false);
    setActiveScanId(null);
    setActiveScan(null);
    setOptimisticActiveScanSettings(nextEffectiveSettings);
    setLiveScanFindings([]);
    setLiveScanNonHits([]);
    setShowLiveScanNonHits(false);

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ brandId, ...(customSettings ? { customSettings } : {}) }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const existingScan = json.data?.activeScan as Scan | undefined;
        if (res.status === 409 && existingScan) {
          setOptimisticActiveScanSettings(null);
          attachToActiveScan(existingScan);
          return;
        }
        throw new Error(json.error ?? 'Failed to start scan');
      }

      const json = await res.json();
      const scan = json.data.scan as Scan | undefined;
      const scanId: string = json.data.scanId;
      setIsCustomScanDialogOpen(false);
      if (scan) {
        attachToActiveScan(scan, { collapseExpandedScans: true });
      } else {
        setExpandedScanIds([]);
        setActiveScanId(scanId);
        setStoredScanId(brandId, scanId);
        startPolling(scanId);
      }
    } catch (err) {
      setScanning(false);
      setOptimisticActiveScanSettings(null);
      const message = err instanceof Error ? err.message : 'Scan failed';
      setError(message);
      if (customSettings) {
        setCustomScanError(message);
      }
    }
  }

  async function triggerCustomScan() {
    if (!hasEnabledBrandScanSource(customScanSettings.scanSources)) {
      setCustomScanError('At least one scan type must be enabled.');
      return;
    }

    await triggerScan(customScanSettings);
  }

  // ---------------------------------------------------------------------------
  // Cancel scan
  // ---------------------------------------------------------------------------

  async function cancelScan() {
    if (!activeScanId) return;
    setCancelling(true);
    setError('');
    try {
      const res = await fetch(`/api/scan?scanId=${activeScanId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'Failed to cancel scan');
      }
      // Polling will pick up the 'cancelled' status and clean up state
    } catch (err) {
      setCancelling(false);
      setError(err instanceof Error ? err.message : 'Failed to cancel scan');
    }
  }

  // ---------------------------------------------------------------------------
  // Delete a single scan
  // ---------------------------------------------------------------------------

  async function deleteScan(scanId: string) {
    setDeletingScanId(scanId);
    setError('');
    try {
      const res = await fetch(`/api/brands/${brandId}/scans/${scanId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'Failed to delete scan');
      }
      // Evict from caches and UI
      setScanFindings((prev) => { const n = { ...prev }; delete n[scanId]; return n; });
      setScanNonHits((prev) => { const n = { ...prev }; delete n[scanId]; return n; });
      setAllBookmarkedFindings((prev) => prev.filter((finding) => finding.scanId !== scanId));
      setScanIgnored((prev) => {
        const removed = prev[scanId] ?? [];
        const n = { ...prev };
        delete n[scanId];
        // Remove findings from this scan from the cross-scan ignored list too
        if (removed.length > 0) {
          const removedIds = new Set(removed.map((f) => f.id));
          setAllIgnoredFindings((all) => all.filter((f) => !removedIds.has(f.id)));
        }
        return n;
      });
      setAllAddressedFindings((prev) => prev.filter((finding) => finding.scanId !== scanId));
      setExpandedScanIds((prev) => prev.filter((id) => id !== scanId));
      setScans((prev) => prev.filter((s) => s.id !== scanId));
      void loadFindingTaxonomyOptions();
      void refreshBookmarkedFindingsCount();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete scan');
    } finally {
      setDeletingScanId(null);
      setConfirmDeleteScanId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Clear all history
  // ---------------------------------------------------------------------------

  async function clearHistory() {
    setClearing(true);
    setError('');
    try {
      const res = await fetch(`/api/brands/${brandId}/findings`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'Failed to clear history');
      }
      setScans([]);
      setScanFindings({});
      setScanNonHits({});
      setScanIgnored({});
      setAllBookmarkedFindings([]);
      setBookmarkedFindingsTotalCount(0);
      setAllAddressedFindings([]);
      setAllIgnoredFindings([]);
      setCrossScanTabNextCursor({
        bookmarks: null,
        addressed: null,
        ignored: null,
      });
      setCrossScanTabErrors({
        bookmarks: '',
        addressed: '',
        ignored: '',
      });
      setBookmarkedFindingsTruncated(false);
      setAddressedFindingsTruncated(false);
      setIgnoredFindingsTruncated(false);
      setFindingTaxonomyOptions({ themes: [] });
      setExpandedScanIds([]);
      setScanning(false);
      setCancelling(false);
      setOptimisticActiveScanSettings(null);
      setActiveScanId(null);
      setActiveScan(null);
      setLiveScanFindings([]);
      setLiveScanNonHits([]);
      setShowLiveScanNonHits(false);
      clearStoredScanId(brandId);
      await refreshBrandProfile().catch(() => {
        // Non-critical
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear history');
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  async function copyScanDeepLink(scanId: string) {
    if (typeof window === 'undefined' || !navigator.clipboard) {
      setError('Clipboard access is not available in this browser.');
      return;
    }

    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('debug');
      url.hash = getScanResultSetAnchorId(scanId);
      await navigator.clipboard.writeText(url.toString());

      if (copiedScanLinkResetTimeoutRef.current) {
        clearTimeout(copiedScanLinkResetTimeoutRef.current);
      }

      setCopiedScanLinkId(scanId);
      copiedScanLinkResetTimeoutRef.current = setTimeout(() => {
        setCopiedScanLinkId(null);
        copiedScanLinkResetTimeoutRef.current = null;
      }, 2_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy deep link');
    }
  }

  async function downloadScanExport(scan: ScanSummary, format: 'csv' | 'pdf') {
    if (typeof window === 'undefined') return;

    const setExportingScanId = format === 'csv' ? setExportingCsvScanId : setExportingPdfScanId;
    const endpoint = format === 'csv'
      ? `/api/brands/${brandId}/scans/${scan.id}/export`
      : `/api/brands/${brandId}/scans/${scan.id}/export/pdf`;
    const errorMessage = format === 'csv'
      ? 'Failed to export scan findings as CSV'
      : 'Failed to export scan findings as PDF';

    setExportingScanId(scan.id);
    setError('');

    try {
      const res = await fetch(endpoint, {
        credentials: 'same-origin',
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? errorMessage);
      }

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const filename = parseDownloadFilename(res.headers.get('content-disposition')) ?? `scan-${scan.id}-findings.${format}`;
      const link = document.createElement('a');

      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : errorMessage);
    } finally {
      setExportingScanId((current) => (current === scan.id ? null : current));
    }
  }

  async function exportScanFindings(scan: ScanSummary) {
    await downloadScanExport(scan, 'csv');
  }

  async function exportScanPdf(scan: ScanSummary) {
    await downloadScanExport(scan, 'pdf');
  }

  // ---------------------------------------------------------------------------
  // Progress bar helpers
  // ---------------------------------------------------------------------------

  const startedRuns = useMemo(
    () => (activeScan?.actorRuns ? Object.values(activeScan.actorRuns) : []),
    [activeScan?.actorRuns],
  );
  const launchingQueuedRuns = useMemo(
    () => (activeScan?.launchingActorRuns
      ? Object.values(activeScan.launchingActorRuns).map((run) => ({
        ...run,
        status: 'pending' as const,
        skippedDuplicateCount: 0,
      } satisfies ActorRunInfo))
      : []),
    [activeScan?.launchingActorRuns],
  );
  const queuedActorRuns = useMemo(
    () => (activeScan?.queuedActorRuns
      ? activeScan.queuedActorRuns.map((run) => ({
        ...run,
        status: 'pending' as const,
        skippedDuplicateCount: 0,
      } satisfies ActorRunInfo))
      : []),
    [activeScan?.queuedActorRuns],
  );
  const allRuns = useMemo(
    () => [...startedRuns, ...launchingQueuedRuns, ...queuedActorRuns],
    [launchingQueuedRuns, queuedActorRuns, startedRuns],
  );
  const defaultScanSettings = getEffectiveScanSettings(brand);
  const activeScanSettings = activeScan
    ? getEffectiveScanSettings(brand, activeScan.effectiveSettings)
    : (optimisticActiveScanSettings ?? defaultScanSettings);
  const isAiDeepSearchEnabled = activeScanSettings.allowAiDeepSearches;
  const isSummarisingFindings = activeScan?.status === 'summarising';
  const normalizedScanSources = activeScanSettings.scanSources;
  const progressSources = sortScanSourcesByLabel(
    SCAN_SOURCE_ORDER.filter(
      (source) => normalizedScanSources[source] || allRuns.some((run) => run.source === source),
    ),
  );
  const progressSourcesWithFallback: FindingSource[] = useMemo(
    () => (progressSources.length > 0 ? progressSources : ['google']),
    [progressSources],
  );
  const runsBySource = useMemo(
    () => new Map(
      progressSourcesWithFallback.map((source) => [
        source,
        allRuns.filter((run) => run.source === source),
      ]),
    ),
    [allRuns, progressSourcesWithFallback],
  );

  function getRunsForSource(source: FindingSource): ActorRunInfo[] {
    return runsBySource.get(source) ?? [];
  }

  function getInFlightRunsForSource(source: FindingSource): ActorRunInfo[] {
    return getRunsForSource(source).filter(
      (run) => run.status === 'pending'
        || run.status === 'running'
        || run.status === 'waiting_for_preference_hints'
        || run.status === 'fetching_dataset'
        || run.status === 'analysing',
    );
  }

  function getRunQueryCount(run?: ActorRunInfo): number {
    if (!run) return 0;
    if (Array.isArray(run.displayQueries) && run.displayQueries.length > 0) {
      return run.displayQueries.length;
    }
    if (Array.isArray(run.searchQueries) && run.searchQueries.length > 0) {
      return run.searchQueries.length;
    }
    return run.searchQuery ? 1 : 0;
  }

  function getActiveRunForSource(source: FindingSource): ActorRunInfo | undefined {
    const runs = getRunsForSource(source);
    const inFlightRuns = getInFlightRunsForSource(source);
    return inFlightRuns.find((run) => (run.searchDepth ?? 0) > 0) ?? inFlightRuns[0] ?? runs[0];
  }

  function getRunAnalysisCounts(run?: ActorRunInfo): { completed: number; total: number } | null {
    if (!run || run.status !== 'analysing') return null;
    const total = run.itemCount ?? 0;
    if (total <= 0) return null;
    const completed = Math.max(0, Math.min(total, run.analysedCount ?? 0));
    return { completed, total };
  }

  function withAnalysisCounts(inProgressLabel: string, finalisingLabel: string, run?: ActorRunInfo): string {
    const counts = getRunAnalysisCounts(run);
    if (!counts) return inProgressLabel;
    if (counts.completed >= counts.total) {
      return finalisingLabel;
    }
    return inProgressLabel;
  }

  function getIdentifiedDeepSearchCount(source: FindingSource): number {
    const runs = getRunsForSource(source);
    const deepSearchRuns = runs.filter((run) => (run.searchDepth ?? 0) > 0);
    return Math.max(
      deepSearchRuns.reduce((sum, run) => sum + Math.max(1, getRunQueryCount(run)), 0),
      runs.reduce((max, run) => Math.max(max, (run.searchDepth ?? 0) === 0 ? run.suggestedSearches?.length ?? 0 : 0), 0),
    );
  }

  function getScanStatusLabel(source: FindingSource): ReactNode {
    if (activeScan?.status === 'summarising') {
      return activeScan.summaryPhase === 'theming_findings'
        ? 'Theming findings'
        : 'Generating summary';
    }
    if (activeScan?.status === 'completed') {
      return 'Finalising results';
    }
    const sourceState = getProgressSourceState(source);
    if (sourceState === 'complete') {
      return 'Scan complete';
    }
    if (sourceState === 'failed') {
      return source === 'google' ? 'Web search failed' : `${getFindingSourceLabel(source)} scan failed`;
    }
    const activeRun = getActiveRunForSource(source);
    if (!activeRun) return 'Starting scan';

    const inFlightRuns = getInFlightRunsForSource(source);
    const runStatus = activeRun.status;
    const isDeepSearchActive = inFlightRuns.some((run) => (run.searchDepth ?? 0) > 0);
    const sourceLabel = getFindingSourceLabel(source);

    if (isDeepSearchActive) {
      return runStatus === 'waiting_for_preference_hints'
        ? 'Preparing analysis context'
        : 'Investigating related queries';
    }

    switch (runStatus) {
      case 'waiting_for_preference_hints': return 'Preparing analysis context';
      case 'fetching_dataset':
        if (source === 'google') return 'Fetching search results';
        if (source === 'domains') return 'Fetching recent domain registrations';
        if (source === 'discord') return 'Fetching Discord server results';
        if (source === 'github') return 'Fetching GitHub repositories';
        if (source === 'euipo') return 'Fetching EUIPO trademark results';
        if (source === 'x') return 'Fetching X posts';
        if (source === 'apple_app_store') return 'Fetching Apple App Store results';
        if (source === 'google_play') return 'Fetching Google Play results';
        return `Fetching ${sourceLabel} results`;
      case 'analysing':
        if (source === 'google') {
          return withAnalysisCounts('Analysing search results', 'Analysing search results', activeRun);
        }
        if (source === 'domains') {
          return withAnalysisCounts('Analysing recent domain registrations', 'Analysing recent domain registrations', activeRun);
        }
        if (source === 'discord') {
          return withAnalysisCounts('Analysing Discord server results', 'Analysing Discord server results', activeRun);
        }
        if (source === 'github') {
          return withAnalysisCounts('Analysing GitHub repositories', 'Analysing GitHub repositories', activeRun);
        }
        if (source === 'euipo') {
          return withAnalysisCounts('Analysing EUIPO trademark filings', 'Analysing EUIPO trademark filings', activeRun);
        }
        if (source === 'x') {
          return withAnalysisCounts('Analysing X posts', 'Analysing X posts', activeRun);
        }
        if (source === 'apple_app_store') {
          return withAnalysisCounts('Analysing Apple App Store results', 'Analysing Apple App Store results', activeRun);
        }
        if (source === 'google_play') {
          return withAnalysisCounts('Analysing Google Play results', 'Analysing Google Play results', activeRun);
        }
        return withAnalysisCounts(`Analysing ${sourceLabel} results`, `Analysing ${sourceLabel} results`, activeRun);
      default:
        return source === 'google' ? 'Waiting for web search to complete' : `Waiting for ${sourceLabel} scan to complete`;
    }
  }

  function getSkippedDuplicateSubtext(source: FindingSource): string | null {
    const skippedDuplicateCount = getRunsForSource(source).reduce((sum, run) => sum + (run.skippedDuplicateCount ?? 0), 0);
    if (skippedDuplicateCount <= 0) return null;
    if (skippedDuplicateCount === 1) {
      return '1 result is being skipped because it duplicates previous findings.';
    }
    return `${formatInteger(skippedDuplicateCount)} results are being skipped because they duplicate other findings in this scan, or historical findings.`;
  }

  function getRunProgressFraction(run: ActorRunInfo): number {
    switch (run.status) {
      case 'succeeded':
      case 'failed':
        return 1;
      case 'analysing': {
        const total = run.itemCount ?? 0;
        if (total <= 0) return 0.58;
        const ratio = Math.max(0, Math.min(1, (run.analysedCount ?? 0) / total));
        return 0.58 + 0.32 * ratio;
      }
      case 'fetching_dataset':
        return 0.34;
      case 'waiting_for_preference_hints':
        return 0.22;
      case 'running':
      case 'pending':
      default:
        return 0.12;
    }
  }

  function getRawScanProgressPct(source: FindingSource): number {
    if (!scanning) return 0;
    if (!activeScan) return 8;
    const runs = getRunsForSource(source);
    if (runs.length === 0) return 0;
    const sourceState = getProgressSourceState(source);
    if (sourceState === 'complete' || sourceState === 'failed') return 100;
    if (activeScan.status === 'summarising' || activeScan.status === 'completed') return 100;

    const totalFraction =
      runs.reduce((sum, run) => sum + getRunProgressFraction(run), 0) / runs.length;
    const activeRun = getActiveRunForSource(source);
    const identifiedDeepSearchCount = getIdentifiedDeepSearchCount(source);
    const canSourceDeepSearch = source !== 'unknown' && isAiDeepSearchEnabled && supportsSourceDeepSearch(source);

    if (canSourceDeepSearch && identifiedDeepSearchCount === 0) {
      const initialRun = runs.find((run) => (run.searchDepth ?? 0) === 0) ?? activeRun;
      const initialFraction = initialRun ? getRunProgressFraction(initialRun) : totalFraction;
      return Math.round(8 + 70 * initialFraction);
    }

    return Math.round(8 + 86 * totalFraction);
  }

  const progressScanKey = activeScanId ?? activeScan?.id ?? null;
  const rawScanProgressPctBySource = Object.fromEntries(
    progressSourcesWithFallback.map((source) => [source, getRawScanProgressPct(source)]),
  ) as Record<FindingSource, number>;
  const progressSourceSignature = progressSourcesWithFallback
    .map((source) => `${source}:${rawScanProgressPctBySource[source] ?? 0}`)
    .join('|');
  const progressSourcesSignature = progressSourcesWithFallback.join('|');

  useEffect(() => {
    const progressSourceEntries = progressSourceSignature
      .split('|')
      .filter(Boolean)
      .map((entry) => {
        const [source, rawProgressPct] = entry.split(':');
        return [source as FindingSource, Number(rawProgressPct)] as const;
      });

    if (!progressScanKey) {
      progressScanKeyRef.current = null;
      setDisplayedScanProgressPctBySource({});
      return;
    }

    if (progressScanKeyRef.current !== progressScanKey) {
      progressScanKeyRef.current = progressScanKey;
      setDisplayedScanProgressPctBySource(Object.fromEntries(progressSourceEntries));
      return;
    }

    setDisplayedScanProgressPctBySource((prev) => {
      const next: Partial<Record<FindingSource, number>> = { ...prev };
      for (const [source, progressPct] of progressSourceEntries) {
        next[source] = Math.max(prev[source] ?? 0, progressPct);
      }
      return next;
    });
  }, [progressScanKey, progressSourceSignature]);

  useEffect(() => {
    if (!progressScanKey) {
      selectedProgressScanKeyRef.current = null;
      return;
    }

    const firstProgressSource = progressSourcesWithFallback[0];
    if (!firstProgressSource) {
      return;
    }

    const scanChanged = selectedProgressScanKeyRef.current !== progressScanKey;
    selectedProgressScanKeyRef.current = progressScanKey;

    setSelectedScanProgressSource((current) => (
      scanChanged || !progressSourcesWithFallback.includes(current)
        ? firstProgressSource
        : current
    ));
  }, [progressScanKey, progressSourcesSignature, progressSourcesWithFallback]);

  const activeProgressSource = progressSourcesWithFallback.includes(selectedScanProgressSource)
    ? selectedScanProgressSource
    : progressSourcesWithFallback[0];
  const activeProgressPct = displayedScanProgressPctBySource[activeProgressSource] ?? rawScanProgressPctBySource[activeProgressSource] ?? 0;
  const activeProgressSourceState = getProgressSourceState(activeProgressSource);
  const activeApifyThrottleLaunchCount = activeScan?.apifyThrottle?.activeLaunchIds?.length ?? 0;
  const showApifyThrottlePanel = scanning && (forceThrottlePanel || activeApifyThrottleLaunchCount > 0);

  function getDisplayedProgressPctForSource(source: FindingSource): number {
    return displayedScanProgressPctBySource[source] ?? rawScanProgressPctBySource[source] ?? 0;
  }

  function getProgressSourceState(source: FindingSource): 'not_started' | 'in_progress' | 'complete' | 'failed' {
    const runs = getRunsForSource(source);
    if (runs.length === 0) {
      return 'not_started';
    }
    if (activeScan?.status === 'summarising' || activeScan?.status === 'completed') {
      return 'complete';
    }
    if (getInFlightRunsForSource(source).length > 0) {
      return 'in_progress';
    }
    if (runs.some((run) => run.status === 'succeeded')) {
      return 'complete';
    }
    if (runs.every((run) => run.status === 'failed')) {
      return 'failed';
    }
    return 'in_progress';
  }

  function getProgressSourceButtonClasses(
    source: FindingSource,
    selected: boolean,
  ): { wrapper: string; icon: string } {
    const status = getProgressSourceState(source);
    const baseWrapper = selected
      ? 'ring-2 ring-brand-200 ring-offset-1'
      : 'ring-1 ring-transparent';

    if (status === 'complete') {
      return {
        wrapper: cn('border-emerald-200 bg-emerald-50 text-emerald-700', baseWrapper),
        icon: 'text-emerald-600',
      };
    }

    if (status === 'failed') {
      return {
        wrapper: cn('border-red-200 bg-red-50 text-red-700', baseWrapper),
        icon: 'text-red-600',
      };
    }

    if (status === 'in_progress') {
      return {
        wrapper: cn('border-brand-200 bg-brand-50 text-brand-700', baseWrapper),
        icon: 'text-brand-600',
      };
    }

    return {
      wrapper: cn('border-gray-200 bg-gray-50 text-gray-500', baseWrapper),
      icon: 'text-gray-400',
    };
  }

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------

  const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
  function sortBySeverity(items: FindingSummary[]) {
    return [...items].sort(
      (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
    );
  }

  function matchesFindingFilters(finding: FindingSummary) {
    const matchesLocalSearch = !shouldUseLocalTabFindingSearch
      || buildFindingSearchText(finding).includes(normalizedFindingsSearchInput);
    const matchesCategory = selectedFindingCategorySet.size === 0 || selectedFindingCategories.some((category) => (
      category === 'non-hit'
        ? finding.isFalsePositive === true
        : finding.isFalsePositive !== true && finding.severity === category
    ));
    const matchesSource = selectedFindingSourceSet.size === 0 || selectedFindingSourceSet.has(finding.source);
    const matchesTheme = !hasActiveFindingThemeFilter
      || normalizedSelectedFindingThemeSet.has(normalizeFindingsTaxonomyValue(finding.theme));

    return matchesLocalSearch && matchesCategory && matchesSource && matchesTheme;
  }

  function filterFindings(findings?: FindingSummary[]) {
    if (!findings) return findings;
    return (hasActiveNonSearchFindingFilters || shouldUseLocalTabFindingSearch)
      ? findings.filter(matchesFindingFilters)
      : findings;
  }

  const totalFindings = scans.reduce((sum, s) => sum + s.highCount + s.mediumCount + s.lowCount, 0);
  const totalNonHits = scans.reduce((sum, s) => sum + s.nonHitCount, 0);
  const totalAddressed = scans.reduce((sum, s) => sum + (s.addressedCount ?? 0), 0);
  const totalIgnored = scans.reduce((sum, s) => sum + (s.ignoredCount ?? 0), 0);
  const totalSkipped = scans.reduce((sum, s) => sum + (s.skippedCount ?? 0), 0);
  const totalResultsCount = totalFindings + totalNonHits + totalAddressed + totalIgnored + totalSkipped;
  const historyDeletionInProgress = hasActiveHistoryDeletion(brand);
  const requiresClearHistoryConfirmation = totalResultsCount > 0;
  const isAwaitingClearHistoryConfirmation = confirmClear && requiresClearHistoryConfirmation;
  const activeFindingsFilterLabel = isFindingsSearchActive && (hasActiveFindingSourceFilter || hasActiveFindingThemeFilter || hasActiveFindingCategoryFilter)
    ? 'search and filters'
    : isFindingsSearchActive
      ? 'search'
      : 'filters';
  const executiveSummaryMentionsHeading = executiveSummaryThemeTitle
    ? `Mentions for '${executiveSummaryThemeTitle}'`
    : 'Linked mentions';
  const findingThemeOptions = availableFindingThemes.map((theme) => ({ value: theme, label: theme }));
  const findingCategoryOptions = [
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
    { value: 'non-hit', label: 'Non-findings' },
  ];
  const findingSourceOptions = [
    ...sortScanSourcesByLabel(SCAN_SOURCE_ORDER).map((source) => ({
      value: source,
      label: getFindingSourceLabel(source),
    })),
  ];
  const visibleBookmarkedFindings = filterFindings(allBookmarkedFindings) ?? [];
  const bookmarkedHits = visibleBookmarkedFindings.filter((finding) => !finding.isFalsePositive);
  const bookmarkedNonHits = sortBySeverity(visibleBookmarkedFindings.filter((finding) => finding.isFalsePositive));
  const visibleBookmarkedCount = visibleBookmarkedFindings.length;
  const visibleAddressedFindings = filterFindings(allAddressedFindings) ?? [];
  const visibleAddressedCount = visibleAddressedFindings.length;
  const visibleIgnoredFindings = filterFindings(allIgnoredFindings) ?? [];
  const visibleIgnoredCount = visibleIgnoredFindings.length;
  const activeCrossScanTab = activeTab === 'scans' ? null : activeTab;
  const activeCrossScanTabLoading = activeCrossScanTab ? crossScanTabLoading[activeCrossScanTab] : false;
  const activeCrossScanTabLoadingMore = activeCrossScanTab ? crossScanTabLoadingMore[activeCrossScanTab] : false;
  const activeCrossScanTabError = activeCrossScanTab ? crossScanTabErrors[activeCrossScanTab] : '';
  const activeCrossScanTabNextCursor = activeCrossScanTab ? crossScanTabNextCursor[activeCrossScanTab] : null;
  const activeCrossScanTabTruncated = activeCrossScanTab
    ? (activeCrossScanTab === 'bookmarks'
      ? bookmarkedFindingsTruncated
      : activeCrossScanTab === 'addressed'
        ? addressedFindingsTruncated
        : ignoredFindingsTruncated)
    : false;
  const bookmarksTabBadgeCount = isAnyFindingFilterActive
    ? (filteredCrossScanTabBadgeCounts.bookmarks ?? visibleBookmarkedCount)
    : (bookmarkedFindingsTotalCount ?? visibleBookmarkedCount);
  const addressedTabBadgeCount = isAnyFindingFilterActive
    ? (filteredCrossScanTabBadgeCounts.addressed ?? visibleAddressedCount)
    : totalAddressed;
  const ignoredTabBadgeCount = isAnyFindingFilterActive
    ? (filteredCrossScanTabBadgeCounts.ignored ?? visibleIgnoredCount)
    : totalIgnored;
  const visibleLiveScanFindings = filterFindings(liveScanFindings) ?? [];
  const visibleLiveScanNonHits = sortBySeverity(filterFindings(liveScanNonHits) ?? []);
  const isSearchResultsMode = shouldUseServerFindingSearch;
  const isSearchQueryTooShort = isSearchResultsMode && !isExecutiveSummaryMentionsMode && !canRunServerFindingSearch;
  const searchResultsCountLabel = `${formatInteger(searchResults.length)} result${searchResults.length !== 1 ? 's' : ''}`;
  const searchResultsStatusText = searchResultsTotalCount !== null && searchResultsTotalCount > searchResults.length
    ? `Showing ${formatInteger(searchResults.length)} of ${formatInteger(searchResultsTotalCount)} results that match the current ${activeFindingsFilterLabel}.`
    : `Showing ${searchResultsCountLabel} that match the current ${activeFindingsFilterLabel}.`;
  const scansToRender = isAnyFindingFilterActive
    ? scans.filter((scan) => {
        const hits = filterFindings(scanFindings[scan.id]) ?? [];
        const nonHits = filterFindings(scanNonHits[scan.id]) ?? [];
        const ignored = filterFindings(scanIgnored[scan.id]) ?? [];
        return hits.length > 0 || nonHits.length > 0 || ignored.length > 0;
      })
    : anchorTargetScanId
      ? scans
      : scans;
  const hasVisibleScanMatches = (
    visibleLiveScanFindings.length > 0
    || visibleLiveScanNonHits.length > 0
    || scansToRender.length > 0
  );
  const clearHistoryDisabledReason = scanning ? ACTIVE_SCAN_DELETE_TOOLTIP : null;
  const runScanDisabledReason = historyDeletionInProgress ? RUN_SCAN_DELETION_TOOLTIP : null;
  const showClearHistoryAction = activeTab === 'scans' && scans.length > 0 && !isAwaitingClearHistoryConfirmation && !isExecutiveSummaryMentionsMode;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AuthGuard>
      <Navbar activeHref={isExecutiveSummaryMentionsMode && returnToDashboard ? '/dashboard' : undefined} />
      <main id="brand-detail-top" className="min-h-screen bg-gray-50 pt-16 lg:pt-[4.5rem]">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8 lg:py-10 xl:max-w-[88rem]">

          {/* Back link */}
          <div className="mb-4 flex items-start justify-between gap-3 sm:mb-7 lg:mb-8">
            <div className="min-w-0">
              <Link href={backHref} className="inline-flex items-center gap-1.5 text-brand-600 transition hover:text-brand-700">
                <ArrowLeft className="w-5 h-5" />
                <span className="text-sm font-medium">
                  {isExecutiveSummaryMentionsMode ? 'Back to dashboard' : 'Back'}
                </span>
              </Link>
              {brand && (
                <h1 className="mt-2 min-w-0 truncate text-2xl font-bold text-gray-900">{brand.name}</h1>
              )}
            </div>
            {brand && !isExecutiveSummaryMentionsMode && (
              <Link href={`/brands/${brandId}/edit`} className="flex-shrink-0">
                <Button variant="secondary" size="sm">
                  <Settings className="w-4 h-4" />
                  <span className="hidden sm:inline">Brand Settings</span>
                </Button>
              </Link>
            )}
          </div>

          {loading && (
            <div className="flex justify-center py-16">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3 mb-6">
              {error}
            </p>
          )}

          {brand && !loading && (
            <>
              {brand.scanSchedule?.enabled && !isExecutiveSummaryMentionsMode && (
                <div className="mb-4 rounded-lg bg-brand-100/70 px-3 py-2 sm:px-4 sm:py-3 lg:mb-6 lg:px-5 lg:py-3.5">
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-xs font-medium uppercase tracking-[0.08em] text-gray-500">Scheduled scans</span>
                        <Badge variant="brand">{formatScanScheduleFrequency(brand.scanSchedule.frequency)}</Badge>
                      </div>
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 text-xs text-gray-400 sm:justify-end">
                      <span className="min-w-0 truncate text-gray-400">
                        {`Next due ${formatScheduledRunAt(brand.scanSchedule.nextRunAt, brand.scanSchedule.timeZone)}`}
                      </span>
                      <InfoTooltip content="Scheduled scans will run within 10 minutes of the scheduled start time." />
                    </div>
                  </div>
                </div>
              )}

              <section className="mb-8 lg:mb-10">
                <div className="rounded-t-2xl bg-brand-600 px-4 py-4 sm:px-5 sm:py-6 lg:px-7 lg:py-7">
                  <div className="flex flex-col gap-4 sm:gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-7">
                    <div className="min-w-0 space-y-4 lg:space-y-5">
                      <h2 className="text-xl font-semibold text-white sm:text-2xl">
                        {isExecutiveSummaryMentionsMode ? 'Mentions' : 'Findings'}
                      </h2>
                      <div className="hidden flex-wrap items-center gap-2.5 sm:flex lg:gap-3">
                        {isExecutiveSummaryMentionsMode ? (
                          <>
                            <span className="inline-flex items-center rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/95 ring-1 ring-white/10">
                              {executiveSummaryMentionsHeading}
                            </span>
                            <span className="inline-flex items-center rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/95 ring-1 ring-white/10">
                              {searchResultsTotalCount !== null
                                ? `${formatInteger(searchResultsTotalCount)} finding${searchResultsTotalCount !== 1 ? 's' : ''}`
                                : 'Loading mentions'}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="inline-flex items-center rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/95 ring-1 ring-white/10">
                              {scans.length === 0
                                ? 'No scans yet'
                                : `${formatInteger(scans.length)} scan${scans.length !== 1 ? 's' : ''}`}
                            </span>
                            {scans.length > 0 && (
                              <span className="inline-flex items-center rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/95 ring-1 ring-white/10">
                                {formatInteger(totalFindings)} finding{totalFindings !== 1 ? 's' : ''} detected
                              </span>
                            )}
                            {totalNonHits > 0 && (
                              <span className="inline-flex items-center rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/95 ring-1 ring-white/10">
                                {formatInteger(totalNonHits)} non-hit{totalNonHits !== 1 ? 's' : ''}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {!isExecutiveSummaryMentionsMode && (
                      <div className="flex flex-wrap items-center gap-1.5 lg:gap-2">
                      {showClearHistoryAction && (
                        clearHistoryDisabledReason ? (
                          <Tooltip content={clearHistoryDisabledReason} align="end">
                            <button
                              type="button"
                              aria-disabled="true"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/50 opacity-70 cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Clear history
                            </button>
                          </Tooltip>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (requiresClearHistoryConfirmation) {
                                setConfirmClear(true);
                                return;
                              }

                              void clearHistory();
                            }}
                            className="border border-white/15 text-white/90 hover:border-white/25 hover:bg-white/10 hover:text-white"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Clear history
                          </Button>
                        )
                      )}
                      <div ref={runScanMenuRef} className="relative">
                        {runScanDisabledReason ? (
                          <Tooltip content={runScanDisabledReason} align="end">
                            <button
                              type="button"
                              aria-disabled="true"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 opacity-70 cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                            >
                              <Play className="w-4 h-4" />
                              Run scan
                              <ChevronDown className="h-4 w-4" />
                            </button>
                          </Tooltip>
                        ) : (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setIsRunScanMenuOpen((current) => !current)}
                            loading={scanning}
                            disabled={scanning || clearing || historyDeletionInProgress || isAwaitingClearHistoryConfirmation}
                            aria-haspopup="menu"
                            aria-expanded={isRunScanMenuOpen}
                            className="border-white/15 bg-white !text-brand-700 hover:border-white/30 hover:bg-brand-50 disabled:hover:bg-white"
                          >
                            <Play className="w-4 h-4" />
                            Run scan
                            <ChevronDown className="h-4 w-4" />
                          </Button>
                        )}
                        {isRunScanMenuOpen && (
                          <div
                            role="menu"
                            className="absolute right-0 z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                void triggerScan();
                              }}
                              className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-gray-50"
                            >
                              <Play className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-600" />
                              <span className="min-w-0">
                                <span className="block text-sm font-medium text-gray-900">Scan defaults</span>
                                <span className="mt-1 block text-xs leading-5 text-gray-500">
                                  Uses the defaults you&apos;ve set in Brand Settings.
                                </span>
                              </span>
                            </button>
                            <div className="border-t border-gray-100" />
                            <button
                              type="button"
                              role="menuitem"
                              onClick={openCustomScanDialog}
                              className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-gray-50"
                            >
                              <Settings className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-600" />
                              <span className="min-w-0">
                                <span className="block text-sm font-medium text-gray-900">Custom scan</span>
                                <span className="mt-1 block text-xs leading-5 text-gray-500">
                                  Choose custom scan settings for this scan only.
                                </span>
                              </span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    )}
                  </div>
                  {!isExecutiveSummaryMentionsMode && (
                    <div className="mt-5 sm:mt-6">
                      <div className="sm:hidden">
                        <button
                          type="button"
                          onClick={() => setIsMobileSearchFiltersOpen((current) => !current)}
                          className="flex w-full items-center justify-between rounded-xl border border-white/15 bg-white/8 px-3 py-2.5 text-left text-sm font-medium text-white/90 transition hover:bg-white/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                          aria-expanded={isMobileSearchFiltersOpen}
                          aria-controls="mobile-search-filter-panel"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <Search className="h-4 w-4 flex-none" />
                            <span>Search &amp; filter</span>
                            {activeFindingControlCount > 0 && (
                              <span className="inline-flex items-center rounded-full bg-white/14 px-2 py-0.5 text-[11px] font-semibold text-white/90 ring-1 ring-white/10">
                                {activeFindingControlCount} active
                              </span>
                            )}
                          </span>
                          <ChevronDown
                            className={cn(
                              'h-4 w-4 flex-none transition-transform',
                              isMobileSearchFiltersOpen && 'rotate-180',
                            )}
                          />
                        </button>
                      </div>
                      <div
                        id="mobile-search-filter-panel"
                        className={cn(
                          'mt-3 sm:mt-0',
                          isMobileSearchFiltersOpen ? 'block' : 'hidden',
                          'sm:block',
                        )}
                      >
                      <div className="flex flex-col gap-2.5 sm:mt-5 sm:gap-3 lg:flex-row lg:items-center lg:gap-4">
                        <div className="relative max-w-lg flex-1">
                          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                          <Input
                            value={findingsSearchQuery}
                            onChange={(e) => setFindingsSearchQuery(e.target.value)}
                            placeholder="Search finding titles, URLs, and analyses"
                            aria-label="Search findings"
                            className="border-white/20 bg-white pl-9 pr-10 placeholder:text-gray-400 lg:py-3"
                            style={isFindingsSearchActive ? { color: '#6b7280' } : undefined}
                          />
                          {isFindingsSearchActive && (
                            <button
                              type="button"
                              onClick={() => setFindingsSearchQuery('')}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 transition"
                              aria-label="Clear findings search"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-2.5 sm:flex sm:flex-row sm:gap-3 lg:flex-shrink-0 lg:gap-3.5">
                          <MultiSelectDropdown
                            id="findings-theme-filter"
                            ariaLabel="Filter findings by theme"
                            selectedValues={selectedFindingThemes}
                            options={findingThemeOptions}
                            onChange={handleFindingThemeFilterChange}
                            defaultLabel="All themes"
                            selectionLabelSingular="theme"
                            selectionLabelPlural="themes"
                            triggerClassName={cn(
                              'min-w-[10rem] border-white/20 lg:py-3',
                              hasActiveFindingThemeFilter && 'border-brand-200 bg-brand-50',
                            )}
                            triggerStyle={{ color: '#6b7280' }}
                            matchTriggerWidth={false}
                            panelClassName="min-w-[16rem] max-w-[calc(100vw-1.5rem)]"
                            showActiveIndicator={hasActiveFindingThemeFilter}
                          />
                          <MultiSelectDropdown
                            id="findings-severity-filter"
                            ariaLabel="Filter findings by severity"
                            selectedValues={selectedFindingCategories}
                            options={findingCategoryOptions}
                            onChange={handleFindingCategoryFilterChange}
                            defaultLabel="All severities"
                            selectionLabelSingular="severity"
                            selectionLabelPlural="severities"
                            triggerClassName={cn(
                              'min-w-[10rem] border-white/20 lg:py-3',
                              hasActiveFindingCategoryFilter && 'border-brand-200 bg-brand-50',
                            )}
                            triggerStyle={{ color: '#6b7280' }}
                            matchTriggerWidth={false}
                            panelClassName="min-w-[14rem] max-w-[calc(100vw-1.5rem)]"
                            showActiveIndicator={hasActiveFindingCategoryFilter}
                          />
                          <MultiSelectDropdown
                            id="findings-source-filter"
                            ariaLabel="Filter findings by scan type"
                            selectedValues={selectedFindingSources}
                            options={findingSourceOptions}
                            onChange={handleFindingSourceFilterChange}
                            defaultLabel="All scan types"
                            selectionLabelSingular="scan type"
                            selectionLabelPlural="scan types"
                            triggerClassName={cn(
                              'min-w-[10rem] border-white/20 lg:py-3',
                              hasActiveFindingSourceFilter && 'border-brand-200 bg-brand-50',
                            )}
                            triggerStyle={{ color: '#6b7280' }}
                            matchTriggerWidth={false}
                            panelClassName="min-w-[14rem] max-w-[calc(100vw-1.5rem)]"
                            showActiveIndicator={hasActiveFindingSourceFilter}
                          />
                          {isAnyFindingFilterActive && (
                            <button
                              type="button"
                              onClick={resetFindingsSearchAndFilters}
                              className="flex w-full items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/8 px-3 py-2 text-xs font-medium text-white/85 transition hover:bg-white/12 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:inline-flex sm:w-auto lg:px-4 lg:py-2.5"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Reset
                            </button>
                          )}
                        </div>
                      </div>
                      {isAnyFindingFilterActive && (
                        <div className="mt-3 flex items-center gap-2 text-xs text-white/80">
                          {((isSearchResultsMode && findingsSearchLoading && !isSearchQueryTooShort)
                            || (!isSearchResultsMode && activeCrossScanTabLoading)) && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" />
                            )}
                          <p>
                            {isSearchResultsMode
                              ? (
                                isSearchQueryTooShort
                                  ? `Type at least ${FINDING_SEARCH_MIN_QUERY_LENGTH} characters to search findings.`
                                  : findingsSearchLoading
                                        ? 'Searching findings across all result sets...'
                                    : searchResultsError
                                      ? searchResultsError
                                      : searchResultsStatusText
                              )
                              : (
                                    activeCrossScanTabLoading
                                      ? `Refreshing ${activeTab} that match the current ${activeFindingsFilterLabel}...`
                                      : `Showing only findings in this tab that match the current ${activeFindingsFilterLabel}.`
                              )}
                          </p>
                        </div>
                      )}
                      </div>
                    </div>
                  )}
                </div>

                {activeTab === 'scans' && isAwaitingClearHistoryConfirmation && !isExecutiveSummaryMentionsMode && (
                  <div className="border-x border-b border-red-100 bg-red-50 px-4 py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-red-800">
                        <span className="font-semibold">
                          Permanently delete all {formatInteger(totalResultsCount)} result{totalResultsCount !== 1 ? 's' : ''} and scan history?
                        </span>{' '}
                        This cannot be undone.
                      </p>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Button variant="secondary" size="sm" onClick={() => setConfirmClear(false)} disabled={clearing}>
                          Cancel
                        </Button>
                        <Button variant="danger" size="sm" onClick={clearHistory} loading={clearing} disabled={clearing}>
                          <Trash2 className="w-3.5 h-3.5" />
                          Clear all
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                <div className="overflow-hidden rounded-b-2xl border border-gray-200 border-t-0 bg-white">
                  {!isExecutiveSummaryMentionsMode && (
                    <div className="border-b border-gray-200 px-4 sm:px-6 lg:px-7">
                    <div className="flex items-end gap-4 overflow-x-auto sm:gap-7 lg:gap-8">
                      <button
                        type="button"
                        onClick={() => switchFindingsTab('scans')}
                        className={cn(
                          "inline-flex items-center gap-2 whitespace-nowrap border-b-2 py-4 text-sm font-medium transition-colors",
                          activeTab === 'scans'
                            ? "border-brand-600 text-brand-700"
                            : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700",
                        )}
                      >
                        Scans
                      </button>
                      <button
                        type="button"
                        onClick={() => switchFindingsTab('bookmarks')}
                        className={cn(
                          "inline-flex items-center gap-2 whitespace-nowrap border-b-2 py-4 text-sm font-medium transition-colors",
                          activeTab === 'bookmarks'
                            ? "border-brand-600 text-brand-700"
                            : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700",
                        )}
                      >
                        Bookmarks
                        {bookmarksTabBadgeCount > 0 && (
                          <Badge variant="default" className="rounded-full border-none bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-gray-600">
                            {formatInteger(bookmarksTabBadgeCount)}
                          </Badge>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => switchFindingsTab('addressed')}
                        className={cn(
                          "inline-flex items-center gap-2 whitespace-nowrap border-b-2 py-4 text-sm font-medium transition-colors",
                          activeTab === 'addressed'
                            ? "border-brand-600 text-brand-700"
                            : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700",
                        )}
                      >
                        Addressed
                        {addressedTabBadgeCount > 0 && (
                          <Badge variant="default" className="rounded-full border-none bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-gray-600">
                            {formatInteger(addressedTabBadgeCount)}
                          </Badge>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => switchFindingsTab('ignored')}
                        className={cn(
                          "inline-flex items-center gap-2 whitespace-nowrap border-b-2 py-4 text-sm font-medium transition-colors",
                          activeTab === 'ignored'
                            ? "border-brand-600 text-brand-700"
                            : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700",
                        )}
                      >
                        Ignored
                        {ignoredTabBadgeCount > 0 && (
                          <Badge variant="default" className="rounded-full border-none bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-gray-600">
                            {formatInteger(ignoredTabBadgeCount)}
                          </Badge>
                        )}
                      </button>
                    </div>
                    </div>
                  )}

                  <div className="bg-gray-50 px-2 py-4 sm:px-6 sm:py-6 lg:px-7 lg:py-8">
                    {isSearchResultsMode ? (
                      <div className="space-y-4 lg:space-y-5">
                        {isSearchQueryTooShort ? (
                          <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                              <Search className="w-5 h-5 text-brand-600" />
                            </div>
                            <p className="text-sm text-gray-500">
                              Type at least {FINDING_SEARCH_MIN_QUERY_LENGTH} characters to search findings.
                            </p>
                          </div>
                        ) : findingsSearchLoading && searchResults.length === 0 ? (
                          <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <Loader2 className="w-5 h-5 animate-spin text-brand-600" />
                            <p className="text-sm text-gray-500">
                              {isExecutiveSummaryMentionsMode ? 'Loading mentions…' : 'Searching findings…'}
                            </p>
                          </div>
                        ) : searchResultsError ? (
                          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
                            {searchResultsError}
                          </div>
                        ) : searchResults.length === 0 ? (
                          <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                              <Search className="w-5 h-5 text-brand-600" />
                            </div>
                            <p className="text-sm text-gray-500">
                              {isExecutiveSummaryMentionsMode
                                ? `No associated findings are available for ${executiveSummaryThemeTitle || 'this theme'}.`
                                : `No findings match the current ${activeFindingsFilterLabel}.`}
                            </p>
                          </div>
                        ) : (
                          <>
                            <div className="space-y-4 lg:space-y-5">
                              {searchResults.map((result) => (
                                <div key={result.id} className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 lg:space-y-4 lg:p-5">
                                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                                    {result.isFalsePositive ? (
                                      <Badge variant="default" className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-600">
                                        Non-finding
                                      </Badge>
                                    ) : (
                                      <Badge
                                        variant={
                                          result.severity === 'high'
                                            ? 'danger'
                                            : result.severity === 'medium'
                                              ? 'warning'
                                              : 'success'
                                        }
                                        className="gap-1 px-2 py-0.5 text-[11px]"
                                      >
                                        {result.severity === 'high' ? (
                                          <AlertCircle className="w-3 h-3" />
                                        ) : result.severity === 'medium' ? (
                                          <AlertTriangle className="w-3 h-3" />
                                        ) : (
                                          <Info className="w-3 h-3" />
                                        )}
                                        {result.severity === 'high'
                                          ? 'High'
                                          : result.severity === 'medium'
                                            ? 'Medium'
                                            : 'Low'}
                                      </Badge>
                                    )}
                                    <span>· {formatScanDate(result.scanStartedAt ?? result.createdAt)}</span>
                                    {result.scanStatus && result.scanStatus !== 'completed' && (
                                      <span>· {result.scanStatus}</span>
                                    )}
                                  </div>

                                  <FindingCard
                                    finding={result}
                                    className="last:border-b last:border-gray-200 sm:last:border sm:last:border-gray-200"
                                    isSelected={selectedFindingIdSet.has(result.id)}
                                    highlightQuery={activeHighlightQuery}
                                    onSelectionChange={handleFindingSelectionChange}
                                    onIgnoreToggle={result.displayBucket === 'ignored' || result.displayBucket === 'hit' ? handleIgnoreToggle : undefined}
                                    onAddressToggle={result.displayBucket !== 'non-hit' && result.displayBucket !== 'ignored' ? handleAddressedToggle : undefined}
                                    onReclassify={handleReclassifyFinding}
                                    onBookmarkUpdate={handleBookmarkUpdate}
                                    onNoteUpdate={handleFindingNoteUpdate}
                                  />
                                </div>
                              ))}
                            </div>

                            {!isExecutiveSummaryMentionsMode && (searchResultsNextCursor || searchResultsTruncated) && (
                              <div className="flex flex-col items-center gap-3 pt-2">
                                {searchResultsNextCursor && (
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => void loadMoreSearchResults()}
                                    loading={loadingMoreSearchResults}
                                    disabled={loadingMoreSearchResults}
                                  >
                                    Load more
                                  </Button>
                                )}
                                {searchResultsTruncated && (
                                  <p className="text-center text-xs text-amber-700">
                                    Search results were capped to keep the request responsive. Narrow the query to search more findings.
                                  </p>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ) : (
                      <>
                    {activeTab === 'bookmarks' && (
                      <>
                        {activeCrossScanTabLoading && visibleBookmarkedCount === 0 ? (
                          <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <Loader2 className="w-5 h-5 animate-spin text-brand-600" />
                            <p className="text-sm text-gray-500">Loading bookmarked findings…</p>
                          </div>
                        ) : activeCrossScanTabError && visibleBookmarkedCount === 0 ? (
                          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
                            {activeCrossScanTabError}
                          </div>
                        ) : visibleBookmarkedCount === 0 ? (
                          <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                              <Bookmark className="w-5 h-5 text-brand-600" />
                            </div>
                            <p className="text-sm text-gray-500">
                              {isAnyFindingFilterActive ? `No bookmarked findings match the current ${activeFindingsFilterLabel}.` : 'No bookmarked findings yet.'}
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-6 lg:space-y-8">
                            {(['high', 'medium', 'low'] as const)
                              .filter((sev) => bookmarkedHits.some((finding) => finding.severity === sev))
                              .map((sev) => (
                                <SeverityGroup
                                  key={`bookmarked-${sev}`}
                                  severity={sev}
                                  findings={bookmarkedHits.filter((finding) => finding.severity === sev)}
                                  selectedFindingIds={selectedFindingIdSet}
                                  onSelectionChange={handleFindingSelectionChange}
                                  onAddressToggle={handleAddressedToggle}
                                  onReclassify={handleReclassifyFinding}
                                  onBookmarkUpdate={handleBookmarkUpdate}
                                  onNoteUpdate={handleFindingNoteUpdate}
                                  forceExpanded={true}
                                  highlightQuery={activeHighlightQuery}
                                />
                              ))}

                            {bookmarkedNonHits.length > 0 && (
                              <div className="overflow-hidden sm:rounded-xl sm:border sm:border-gray-200 sm:bg-white lg:rounded-2xl">
                                <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2.5 sm:rounded-none sm:border-b sm:border-gray-100 sm:px-4 sm:py-3 lg:px-5 lg:py-4">
                                  <Bookmark className="w-3.5 h-3.5 text-gray-400" />
                                  <span className="text-sm font-medium text-gray-500">
                                    Non-findings
                                    <span className="ml-1.5 text-xs font-normal text-gray-400">
                                      ({bookmarkedNonHits.length})
                                    </span>
                                  </span>
                                  <span className="hidden sm:inline text-xs text-gray-400">· bookmarked despite AI classifying them as false positives · reclassify to any category</span>
                                </div>
                                <div className="space-y-3 pt-2 sm:space-y-4 sm:border-t sm:border-gray-100 sm:p-4 lg:space-y-5 lg:p-5">
                                  {bookmarkedNonHits.map((finding) => (
                                    <FindingCard
                                      key={finding.id}
                                      finding={finding}
                                      isSelected={selectedFindingIdSet.has(finding.id)}
                                      highlightQuery={activeHighlightQuery}
                                      onSelectionChange={handleFindingSelectionChange}
                                      onReclassify={handleReclassifyFinding}
                                      onBookmarkUpdate={handleBookmarkUpdate}
                                      onNoteUpdate={handleFindingNoteUpdate}
                                    />
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {activeCrossScanTabError && visibleBookmarkedCount > 0 && (
                          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
                            {activeCrossScanTabError}
                          </div>
                        )}
                        {(activeCrossScanTabNextCursor || activeCrossScanTabTruncated) && (
                          <div className="flex flex-col items-center gap-3 pt-2">
                            {activeCrossScanTabNextCursor && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void loadMoreCrossScanTabFindings('bookmarks')}
                                loading={activeCrossScanTabLoadingMore}
                                disabled={activeCrossScanTabLoadingMore}
                              >
                                Load more
                              </Button>
                            )}
                            {activeCrossScanTabTruncated && (
                              <p className="text-center text-xs text-amber-700">
                                Results were capped to keep this tab responsive. Narrow the current search or filters to explore further.
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}

                    {activeTab === 'addressed' && (
                      <>
                        {activeCrossScanTabLoading && visibleAddressedCount === 0 ? (
                          <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <Loader2 className="w-5 h-5 animate-spin text-brand-600" />
                            <p className="text-sm text-gray-500">Loading addressed findings…</p>
                          </div>
                        ) : activeCrossScanTabError && visibleAddressedCount === 0 ? (
                          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
                            {activeCrossScanTabError}
                          </div>
                        ) : visibleAddressedCount === 0 ? (
                          <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                              <Check className="w-5 h-5 text-brand-600" />
                            </div>
                            <p className="text-sm text-gray-500">
                              {isAnyFindingFilterActive ? `No addressed findings match the current ${activeFindingsFilterLabel}.` : 'No addressed findings yet.'}
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-6 lg:space-y-8">
                            {(['high', 'medium', 'low'] as const)
                              .filter((sev) => visibleAddressedFindings.some((finding) => finding.severity === sev))
                              .map((sev) => (
                                <SeverityGroup
                                  key={`addressed-${sev}`}
                                  severity={sev}
                                  findings={visibleAddressedFindings.filter((finding) => finding.severity === sev)}
                                  selectedFindingIds={selectedFindingIdSet}
                                  onSelectionChange={handleFindingSelectionChange}
                                  onAddressToggle={handleAddressedToggle}
                                  onBookmarkUpdate={handleBookmarkUpdate}
                                  onNoteUpdate={handleFindingNoteUpdate}
                                  forceExpanded={true}
                                  highlightQuery={activeHighlightQuery}
                                />
                              ))}
                          </div>
                        )}
                        {activeCrossScanTabError && visibleAddressedCount > 0 && (
                          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
                            {activeCrossScanTabError}
                          </div>
                        )}
                        {(activeCrossScanTabNextCursor || activeCrossScanTabTruncated) && (
                          <div className="flex flex-col items-center gap-3 pt-2">
                            {activeCrossScanTabNextCursor && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void loadMoreCrossScanTabFindings('addressed')}
                                loading={activeCrossScanTabLoadingMore}
                                disabled={activeCrossScanTabLoadingMore}
                              >
                                Load more
                              </Button>
                            )}
                            {activeCrossScanTabTruncated && (
                              <p className="text-center text-xs text-amber-700">
                                Results were capped to keep this tab responsive. Narrow the current search or filters to explore further.
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}

                    {activeTab === 'ignored' && (
                      <>
                        {activeCrossScanTabLoading && visibleIgnoredCount === 0 ? (
                          <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <Loader2 className="w-5 h-5 animate-spin text-brand-600" />
                            <p className="text-sm text-gray-500">Loading ignored findings…</p>
                          </div>
                        ) : activeCrossScanTabError && visibleIgnoredCount === 0 ? (
                          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
                            {activeCrossScanTabError}
                          </div>
                        ) : visibleIgnoredCount === 0 ? (
                          <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                              <EyeOff className="w-5 h-5 text-brand-600" />
                            </div>
                            <p className="text-sm text-gray-500">
                              {isAnyFindingFilterActive ? `No ignored findings match the current ${activeFindingsFilterLabel}.` : 'No ignored findings yet.'}
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-4 lg:space-y-5">
                            {visibleIgnoredFindings.map((finding) => (
                              <FindingCard
                                key={finding.id}
                                finding={finding}
                                isSelected={selectedFindingIdSet.has(finding.id)}
                                highlightQuery={activeHighlightQuery}
                                onSelectionChange={handleFindingSelectionChange}
                                onIgnoreToggle={handleIgnoreToggle}
                                onReclassify={handleReclassifyFinding}
                                onBookmarkUpdate={handleBookmarkUpdate}
                                onNoteUpdate={handleFindingNoteUpdate}
                              />
                            ))}
                          </div>
                        )}
                        {activeCrossScanTabError && visibleIgnoredCount > 0 && (
                          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
                            {activeCrossScanTabError}
                          </div>
                        )}
                        {(activeCrossScanTabNextCursor || activeCrossScanTabTruncated) && (
                          <div className="flex flex-col items-center gap-3 pt-2">
                            {activeCrossScanTabNextCursor && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void loadMoreCrossScanTabFindings('ignored')}
                                loading={activeCrossScanTabLoadingMore}
                                disabled={activeCrossScanTabLoadingMore}
                              >
                                Load more
                              </Button>
                            )}
                            {activeCrossScanTabTruncated && (
                              <p className="text-center text-xs text-amber-700">
                                Results were capped to keep this tab responsive. Narrow the current search or filters to explore further.
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}

                    {activeTab === 'scans' && (
                      <div className="space-y-4 lg:space-y-5">
                        {scanning && (
                          (() => {
                            const showLiveNonHitsSection = isAnyFindingFilterActive
                              ? visibleLiveScanNonHits.length > 0
                              : showLiveScanNonHits;

                            return (
                              <div className="overflow-hidden rounded-xl border border-brand-200 bg-white lg:rounded-2xl">
                                <div className="bg-brand-50/40 px-3 py-3 sm:px-6 sm:py-4 lg:px-7 lg:py-5">
                                  <div className="flex items-start justify-between gap-4 lg:gap-6">
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center justify-between gap-3 text-left">
                                        <div className="flex min-w-0 items-center gap-3">
                                          <Loader2 className="w-4 h-4 text-brand-600 animate-spin flex-shrink-0" />
                                          <span className="text-sm font-semibold text-brand-700 flex-shrink-0">
                                            Scan in progress
                                          </span>
                                        </div>
                                        {!cancelling && (
                                          <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={cancelScan}
                                            className="flex-shrink-0 whitespace-nowrap hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                                          >
                                            <X className="w-3.5 h-3.5" />
                                            Cancel
                                          </Button>
                                        )}
                                      </div>
                                      {showApifyThrottlePanel && (
                                        <div className="mt-2 rounded-xl border border-brand-100 bg-brand-50/80 px-4 py-3 text-sm text-brand-700">
                                          <div className="flex items-start gap-3">
                                            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-600" />
                                            <p>
                                              Lots of users are performing scans right now, so this scan may take a little longer than usual.
                                            </p>
                                          </div>
                                        </div>
                                      )}
                                      <div className="mt-4 pl-0 sm:pl-7 lg:mt-5">
                                        <div className="mb-5 flex flex-wrap items-center gap-2.5 lg:mb-6">
                                          {progressSourcesWithFallback.map((source) => {
                                            const buttonClasses = getProgressSourceButtonClasses(
                                              source,
                                              source === activeProgressSource,
                                            );

                                            return (
                                              <Tooltip key={source} content={getFindingSourceLabel(source)}>
                                                <button
                                                  type="button"
                                                  onClick={() => setSelectedScanProgressSource(source)}
                                                  className={cn(
                                                    'inline-flex w-10 flex-col items-center justify-center gap-1.5 rounded-lg border px-1.5 py-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
                                                    buttonClasses.wrapper,
                                                  )}
                                                  aria-label={`View ${getFindingSourceLabel(source)} scan progress`}
                                                  aria-pressed={source === activeProgressSource}
                                                >
                                                  <ScanSourceIcon source={source} className={buttonClasses.icon} />
                                                  <span className="h-0.5 w-full overflow-hidden rounded-full bg-current/15">
                                                    <span
                                                      className="block h-full rounded-full bg-current transition-all duration-500"
                                                      style={{ width: `${getDisplayedProgressPctForSource(source)}%` }}
                                                    />
                                                  </span>
                                                </button>
                                              </Tooltip>
                                            );
                                          })}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2.5">
                                          <span
                                            className={cn(
                                              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                                              activeProgressSourceState === 'complete'
                                                ? 'bg-emerald-100 text-emerald-700'
                                                : activeProgressSourceState === 'failed'
                                                  ? 'bg-red-100 text-red-700'
                                                  : 'bg-brand-100 text-brand-700',
                                            )}
                                          >
                                            <ScanSourceIcon source={activeProgressSource} className="h-3.5 w-3.5" />
                                            {getFindingSourceLabel(activeProgressSource)}
                                          </span>
                                          <span
                                            className={cn(
                                              'text-sm font-medium',
                                              activeProgressSourceState === 'complete'
                                                ? 'text-emerald-700'
                                                : activeProgressSourceState === 'failed'
                                                  ? 'text-red-700'
                                                  : 'text-brand-700',
                                            )}
                                          >
                                            {cancelling ? 'Cancelling scan' : getScanStatusLabel(activeProgressSource)}
                                          </span>
                                        </div>
                                        <div
                                          className={cn(
                                            'mt-3 h-1.5 overflow-hidden rounded-full',
                                            activeProgressSourceState === 'complete'
                                              ? 'bg-emerald-100'
                                              : activeProgressSourceState === 'failed'
                                                ? 'bg-red-100'
                                                : 'bg-brand-100',
                                          )}
                                        >
                                          <div
                                            className={cn(
                                              'h-full rounded-full transition-all duration-500',
                                              activeProgressSourceState === 'complete'
                                                ? 'bg-emerald-600'
                                                : activeProgressSourceState === 'failed'
                                                  ? 'bg-red-600'
                                                  : 'bg-brand-600',
                                            )}
                                            style={{ width: `${activeProgressPct}%` }}
                                          />
                                        </div>
                                        {!cancelling && !isSummarisingFindings && getSkippedDuplicateSubtext(activeProgressSource) && (
                                          <p className="mt-2 text-xs text-brand-700/80">
                                            {getSkippedDuplicateSubtext(activeProgressSource)}
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <div className="border-t border-brand-100 bg-brand-50/30 px-2 py-3 sm:px-6 sm:py-5 lg:px-7 lg:py-6">
                                  <div className="space-y-4 lg:space-y-5">
                                    {activeScan?.aiSummary && !isAnyFindingFilterActive && (
                                      <ScanSummaryPanel summary={activeScan.aiSummary} />
                                    )}
                                    {visibleLiveScanFindings.length === 0 && visibleLiveScanNonHits.length === 0 ? (
                                      <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        <span className="text-sm">
                                          {isAnyFindingFilterActive ? `No findings match the current ${activeFindingsFilterLabel} yet…` : 'Waiting for first results…'}
                                        </span>
                                      </div>
                                    ) : (
                                      <div className="space-y-4 lg:space-y-5">
                                      {visibleLiveScanFindings.length === 0 ? (
                                        !isAnyFindingFilterActive && (
                                          <div className="flex flex-col items-center justify-center gap-2 py-6">
                                            <Shield className="w-5 h-5 text-brand-300" />
                                            <p className="text-sm text-gray-400">
                                              Only non-findings detected so far ...
                                            </p>
                                          </div>
                                        )
                                      ) : (
                                        <div className="space-y-3 lg:space-y-5">
                                          {(['high', 'medium', 'low'] as const)
                                            .filter((sev) => visibleLiveScanFindings.some((f) => f.severity === sev))
                                            .map((sev) => (
                                              <SeverityGroup
                                                key={`live-${sev}`}
                                                severity={sev}
                                                findings={visibleLiveScanFindings.filter((f) => f.severity === sev)}
                                                selectedFindingIds={selectedFindingIdSet}
                                                onSelectionChange={handleFindingSelectionChange}
                                                onReclassify={handleReclassifyFinding}
                                                onBookmarkUpdate={handleBookmarkUpdate}
                                                onNoteUpdate={handleFindingNoteUpdate}
                                                forceExpanded={isAnyFindingFilterActive}
                                                highlightQuery={activeHighlightQuery}
                                                autoExpandToken={
                                                  anchorTargetScanId === activeScan?.id && singleSelectedFindingCategory === sev
                                                    ? `live-${sev}`
                                                    : null
                                                }
                                                sectionAnchorId={
                                                  activeScan?.id ? getScanCategorySectionAnchorId(activeScan.id, sev) : undefined
                                                }
                                              />
                                            ))}
                                        </div>
                                      )}

                                      {visibleLiveScanNonHits.length > 0 && (
                                        <div
                                          id={activeScan?.id ? getScanCategorySectionAnchorId(activeScan.id, 'non-hit') : undefined}
                                          className="scroll-mt-28 overflow-hidden sm:rounded-xl sm:border sm:border-gray-200 sm:bg-white lg:rounded-2xl"
                                        >
                                          <button
                                            type="button"
                                            onClick={() => {
                                              if (isAnyFindingFilterActive) return;
                                              setShowLiveScanNonHits((prev) => !prev);
                                            }}
                                            className={cn(
                                              "flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left transition sm:rounded-none sm:px-4 sm:py-3 lg:px-5 lg:py-4",
                                              showLiveNonHitsSection ? "sm:border-b border-gray-100 bg-gray-50" : "hover:bg-gray-50",
                                            )}
                                          >
                                            {!isAnyFindingFilterActive && (showLiveNonHitsSection
                                              ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                              : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />)}
                                            <span className="text-sm font-medium text-gray-500">
                                              Non-findings
                                              <span className="ml-1.5 text-xs font-normal text-gray-400">
                                                ({visibleLiveScanNonHits.length})
                                              </span>
                                            </span>
                                            <span className="hidden sm:inline text-xs text-gray-400">· classified as false positives by AI · reclassify to any category</span>
                                          </button>
                                          {showLiveNonHitsSection && (
                                            <div className="space-y-3 pt-2 sm:space-y-4 sm:border-t sm:border-gray-100 sm:p-4 lg:space-y-5 lg:p-5">
                                              {visibleLiveScanNonHits.map((finding) => (
                                                <FindingCard
                                                  key={finding.id}
                                                  finding={finding}
                                                  isSelected={selectedFindingIdSet.has(finding.id)}
                                                  highlightQuery={activeHighlightQuery}
                                                  onSelectionChange={handleFindingSelectionChange}
                                                  onReclassify={handleReclassifyFinding}
                                                  onBookmarkUpdate={handleBookmarkUpdate}
                                                  onNoteUpdate={handleFindingNoteUpdate}
                                                />
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })()
                        )}

                        {isAnyFindingFilterActive && findingsSearchLoading ? (
                          <div className="flex items-center justify-center gap-2 py-12 text-gray-400">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span className="text-sm">Filtering across all findings…</span>
                          </div>
                        ) : isAnyFindingFilterActive && !hasVisibleScanMatches ? (
                          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                              <Search className="w-5 h-5 text-brand-600" />
                            </div>
                            <p className="text-sm text-gray-500">No findings match the current {activeFindingsFilterLabel}.</p>
                          </div>
                        ) : !isAnyFindingFilterActive && scansToRender.length === 0 && !scanning ? (
                          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                              <Shield className="w-5 h-5 text-brand-600" />
                            </div>
                            <p className="text-sm text-gray-500">No findings yet. Run a scan to start monitoring.</p>
                          </div>
                        ) : (
                          scansToRender.map((scan) => {
                            const hits = filterFindings(scanFindings[scan.id]);
                            const nonHits = filterFindings(scanNonHits[scan.id]);
                            const ignored = filterFindings(scanIgnored[scan.id]);
                            const matchingHitCount = hits?.length ?? 0;
                            const matchingNonHitCount = nonHits?.length ?? 0;
                            const matchingIgnoredCount = ignored?.length ?? 0;
                            const isExpanded = isAnyFindingFilterActive
                              ? matchingHitCount + matchingNonHitCount + matchingIgnoredCount > 0
                              : anchorTargetScanId
                                ? anchorTargetScanId === scan.id
                                : expandedScanIds.includes(scan.id);
                            const isLoading = loadingScanIds.includes(scan.id);
                            const showNonHits = isAnyFindingFilterActive
                              ? matchingNonHitCount > 0
                              : showNonHitsByScanId[scan.id] ?? false;
                            const showIgnored = isAnyFindingFilterActive
                              ? matchingIgnoredCount > 0
                              : showIgnoredByScanId[scan.id] ?? false;
                            const scanResultsCount =
                              scan.highCount
                              + scan.mediumCount
                              + scan.lowCount
                              + scan.nonHitCount
                              + (scan.addressedCount ?? 0)
                              + (scan.ignoredCount ?? 0)
                              + (scan.skippedCount ?? 0);
                            const requiresDeleteScanConfirmation = scanResultsCount > 0;
                            const showScanLevelActions = !isAnyFindingFilterActive;
                            const isConfirmingDelete = showScanLevelActions && confirmDeleteScanId === scan.id;
                            const isDeleting = deletingScanId === scan.id;
                            const hasFindings = isAnyFindingFilterActive
                              ? matchingHitCount > 0
                              : scan.highCount + scan.mediumCount + scan.lowCount > 0;
                            const displayedHighCount = isAnyFindingFilterActive
                              ? hits?.filter((f) => f.severity === 'high').length ?? 0
                              : scan.highCount;
                            const displayedMediumCount = isAnyFindingFilterActive
                              ? hits?.filter((f) => f.severity === 'medium').length ?? 0
                              : scan.mediumCount;
                            const displayedLowCount = isAnyFindingFilterActive
                              ? hits?.filter((f) => f.severity === 'low').length ?? 0
                              : scan.lowCount;
                            const displayedNonHitCount = isAnyFindingFilterActive
                              ? matchingNonHitCount
                              : scan.nonHitCount;
                            const displayedAddressedCount = isAnyFindingFilterActive
                              ? 0
                              : (scan.addressedCount ?? 0);
                            const displayedIgnoredCount = isAnyFindingFilterActive
                              ? matchingIgnoredCount
                              : (scan.ignoredCount ?? 0);
                            const orderedScanSources = sortScanSourcesByLabel(scan.sources ?? []);
                            const deleteDisabledReason = scanning
                              ? ACTIVE_SCAN_DELETE_TOOLTIP
                              : null;

                            return (
                              <div
                                key={scan.id}
                                id={getScanResultSetAnchorId(scan.id)}
                                className="scroll-mt-24 overflow-hidden rounded-xl border border-gray-200 bg-white lg:rounded-2xl"
                              >
                                {isConfirmingDelete ? (
                                  <div className="flex flex-col gap-3 bg-red-50 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4 lg:px-7 lg:py-5">
                                    <p className="text-sm text-red-800">
                                      <span className="font-semibold">
                                        Delete this scan and its {formatInteger(scanResultsCount)} result{scanResultsCount !== 1 ? 's' : ''}?
                                      </span>{' '}
                                      This cannot be undone.
                                    </p>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => setConfirmDeleteScanId(null)}
                                        disabled={isDeleting}
                                      >
                                        Cancel
                                      </Button>
                                      <Button
                                        variant="danger"
                                        size="sm"
                                        onClick={() => deleteScan(scan.id)}
                                        loading={isDeleting}
                                        disabled={isDeleting}
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                        Delete
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="group flex flex-col gap-2 px-3 py-3.5 transition hover:bg-gray-50 sm:flex-row sm:items-start sm:gap-3 sm:px-6 sm:py-4 lg:gap-4 lg:px-7 lg:py-5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (isAnyFindingFilterActive) return;
                                        toggleScanExpand(scan.id);
                                      }}
                                      className="flex min-w-0 flex-1 items-start gap-2 text-left sm:gap-4 lg:gap-5"
                                      aria-expanded={isExpanded}
                                    >
                                      {!isAnyFindingFilterActive && (isExpanded
                                        ? <ChevronDown className="mt-0.5 w-4 h-4 text-gray-400 flex-shrink-0" />
                                        : <ChevronRight className="mt-0.5 w-4 h-4 text-gray-400 flex-shrink-0" />)}
                                      <span className="flex min-w-0 flex-1 flex-col gap-2.5 lg:gap-3">
                                        <span className="flex flex-wrap items-center gap-2">
                                          <span className="text-sm font-semibold text-gray-500">
                                            {formatScanDate(scan.startedAt)}
                                          </span>
                                          {orderedScanSources.length > 0 && (
                                              <span className="hidden sm:flex flex-wrap items-center gap-2 text-gray-300">
                                                <span
                                                  aria-hidden="true"
                                                  className="h-3.5 w-px rounded-full bg-gray-200"
                                                />
                                                <span
                                                  className="flex flex-wrap items-center gap-1.5"
                                                  aria-label={`Scan types: ${orderedScanSources.map((source) => getFindingSourceLabel(source)).join(', ')}`}
                                                >
                                                  {orderedScanSources.map((source) => (
                                                    <span
                                                      key={source}
                                                      title={getFindingSourceLabel(source)}
                                                      className="inline-flex items-center"
                                                    >
                                                      <ScanSourceIcon source={source} className="h-[14px] w-[14px]" />
                                                    </span>
                                                  ))}
                                                </span>
                                              </span>
                                          )}
                                        </span>
                                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                          {hasFindings ? (
                                            <SeverityPills
                                              high={displayedHighCount}
                                              medium={displayedMediumCount}
                                              low={displayedLowCount}
                                            />
                                          ) : (
                                            <span className="text-xs text-gray-400">No findings</span>
                                          )}
                                          {displayedNonHitCount > 0 && (
                                            <span className="hidden sm:inline text-xs text-gray-400">
                                              · {formatInteger(displayedNonHitCount)} non-hit{displayedNonHitCount !== 1 ? 's' : ''}
                                            </span>
                                          )}
                                          {displayedAddressedCount > 0 && (
                                            <span className="hidden sm:inline text-xs text-gray-400">
                                              · {formatInteger(displayedAddressedCount)} addressed
                                            </span>
                                          )}
                                          {displayedIgnoredCount > 0 && (
                                            <span className="hidden sm:inline text-xs text-gray-400">
                                              · {formatInteger(displayedIgnoredCount)} ignored
                                            </span>
                                          )}
                                          {(scan.skippedCount ?? 0) > 0 && (
                                            <span className="hidden sm:inline-flex items-center gap-1 text-xs text-gray-400">
                                              · {formatInteger(scan.skippedCount ?? 0)} skipped
                                              <InfoTooltip
                                                content="Findings that appeared in other searches in this scan, or historical findings."
                                                iconClassName="text-gray-300 hover:text-gray-400"
                                              />
                                            </span>
                                          )}
                                          {scan.status === 'cancelled' && (
                                            <span className="text-xs italic text-gray-400">· cancelled</span>
                                          )}
                                          {scan.status === 'failed' && (
                                            <span className="text-xs italic text-red-400">· failed</span>
                                          )}
                                        </span>
                                      </span>
                                    </button>

                                    {/* Action buttons — own row on mobile, inline at sm+ */}
                                    {(showScanLevelActions || showDebug) && (
                                      <div className="mt-2 flex flex-shrink-0 items-center gap-1.5 pl-6 sm:mt-0 sm:gap-1.5 sm:pl-0 lg:gap-2">
                                        {showScanLevelActions && (
                                          <>
                                            <Tooltip
                                              content="Download scan results as CSV"
                                              align="end"
                                              triggerClassName="flex-shrink-0"
                                            >
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  void exportScanFindings(scan);
                                                }}
                                                disabled={exportingCsvScanId !== null && exportingCsvScanId !== scan.id}
                                                aria-label="Download scan results as CSV"
                                                className={SCAN_ACTION_BUTTON_CLASS_NAME}
                                              >
                                                {exportingCsvScanId === scan.id ? (
                                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                ) : (
                                                  <Image
                                                    src="/csv.svg"
                                                    alt=""
                                                    aria-hidden="true"
                                                    width={14}
                                                    height={14}
                                                    className="h-3.5 w-3.5"
                                                    unoptimized
                                                  />
                                                )}
                                              </button>
                                            </Tooltip>

                                            <Tooltip
                                              content="Download PDF scan report"
                                              align="end"
                                              triggerClassName="flex-shrink-0"
                                            >
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  void exportScanPdf(scan);
                                                }}
                                                disabled={exportingPdfScanId !== null && exportingPdfScanId !== scan.id}
                                                aria-label="Download PDF scan report"
                                                className={SCAN_ACTION_BUTTON_CLASS_NAME}
                                              >
                                                {exportingPdfScanId === scan.id ? (
                                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                ) : (
                                                  <Image
                                                    src="/pdf.svg"
                                                    alt=""
                                                    aria-hidden="true"
                                                    width={14}
                                                    height={14}
                                                    className="h-3.5 w-3.5"
                                                    unoptimized
                                                  />
                                                )}
                                              </button>
                                            </Tooltip>
                                          </>
                                        )}

                                        {showDebug && (
                                          <Tooltip
                                            content={copiedScanLinkId === scan.id ? 'Copied' : 'Copy deep link'}
                                            align="end"
                                            triggerClassName="flex-shrink-0"
                                          >
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                void copyScanDeepLink(scan.id);
                                              }}
                                              className={cn(
                                            'flex-shrink-0 rounded-md p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:p-2',
                                                copiedScanLinkId === scan.id && 'text-brand-600',
                                              )}
                                              aria-label="Copy deep link to scan result set"
                                            >
                                              {copiedScanLinkId === scan.id
                                                ? <Check className="w-3.5 h-3.5" />
                                                : <Link2 className="w-3.5 h-3.5" />}
                                            </button>
                                          </Tooltip>
                                        )}

                                        {showScanLevelActions && (
                                          deleteDisabledReason ? (
                                            <Tooltip content={deleteDisabledReason} align="end" triggerClassName="flex-shrink-0">
                                              <button
                                                type="button"
                                                aria-disabled="true"
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                }}
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-300 opacity-50 cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:h-9 lg:w-9"
                                              >
                                                <Trash2 className="w-3.5 h-3.5" />
                                              </button>
                                            </Tooltip>
                                          ) : (
                                            <Tooltip content="Delete scan" align="end" triggerClassName="flex-shrink-0">
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  if (requiresDeleteScanConfirmation) {
                                                    setConfirmDeleteScanId(scan.id);
                                                    setConfirmClear(false);
                                                    return;
                                                  }

                                                  void deleteScan(scan.id);
                                                  setConfirmClear(false);
                                                }}
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:h-9 lg:w-9"
                                                aria-label="Delete scan"
                                              >
                                                <Trash2 className="w-3.5 h-3.5" />
                                              </button>
                                            </Tooltip>
                                          )
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}

                                {isExpanded && (
                                  <div className="border-t border-gray-100 bg-gray-50 px-2 py-3 sm:px-6 sm:py-5 lg:px-7 lg:py-6">
                                    {isLoading ? (
                                      <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        <span className="text-sm">Loading results…</span>
                                      </div>
                                    ) : (
                                      <>
                                        {(scan.aiSummary || showDebug) && !isAnyFindingFilterActive && (
                                          <div className="mb-4 space-y-1.5 lg:mb-5 lg:space-y-2">
                                            {scan.aiSummary ? (
                                              <ScanSummaryPanel summary={scan.aiSummary} />
                                            ) : (
                                              <div className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-4 text-sm text-gray-500 lg:px-5 lg:py-5">
                                                No stored AI summary is currently saved for this scan.
                                              </div>
                                            )}
                                            {showDebug && (
                                              <>
                                                <div className="flex flex-wrap items-center gap-2">
                                                  <Button
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    onClick={() => void regenerateScanSummary(scan.id)}
                                                    loading={scanSummaryRegeneratingIds.includes(scan.id)}
                                                    disabled={scanSummarySavingIds.includes(scan.id)}
                                                  >
                                                    Regenerate summary
                                                  </Button>
                                                  <Button
                                                    type="button"
                                                    size="sm"
                                                    onClick={() => void saveRegeneratedScanSummary(scan.id)}
                                                    loading={scanSummarySavingIds.includes(scan.id)}
                                                    disabled={!scanDebugById[scan.id]?.regeneratedSummaryPreview?.summary || scanSummaryRegeneratingIds.includes(scan.id)}
                                                  >
                                                    Save regenerated summary
                                                  </Button>
                                                  {scanDebugById[scan.id]?.regeneratedSummaryPreview && (
                                                    <Button
                                                      type="button"
                                                      variant="ghost"
                                                      size="sm"
                                                      onClick={() => discardRegeneratedScanSummaryPreview(scan.id)}
                                                      disabled={scanSummaryRegeneratingIds.includes(scan.id) || scanSummarySavingIds.includes(scan.id)}
                                                    >
                                                      Discard preview
                                                    </Button>
                                                  )}
                                                </div>
                                                {scanSummaryActionErrors[scan.id] && (
                                                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                                                    {scanSummaryActionErrors[scan.id]}
                                                  </div>
                                                )}
                                                {scanDebugById[scan.id]?.regeneratedSummaryPreview?.summary && (
                                                  <ScanSummaryPanel
                                                    summary={scanDebugById[scan.id]?.regeneratedSummaryPreview?.summary ?? ''}
                                                    label="Regenerated preview"
                                                  />
                                                )}
                                                <ScanDebugExpandableSection
                                                  icon={MessageSquare}
                                                  label="Raw AI response"
                                                  onOpen={() => void ensureScanDebugData(scan.id)}
                                                  loading={scanDebugLoadingIds.includes(scan.id)}
                                                  error={scanDebugErrors[scan.id]}
                                                >
                                                  {formatDebugRawResponse(scanDebugById[scan.id]?.scanSummaryRawLlmResponse)}
                                                </ScanDebugExpandableSection>
                                                {scanDebugById[scan.id]?.regeneratedSummaryPreview && (
                                                  <ScanDebugExpandableSection
                                                    icon={RotateCcw}
                                                    label="Regenerated raw AI response"
                                                  >
                                                    {formatDebugRawResponse(scanDebugById[scan.id]?.regeneratedSummaryPreview?.rawLlmResponse)}
                                                  </ScanDebugExpandableSection>
                                                )}
                                              </>
                                            )}
                                          </div>
                                        )}

                                        {!hits || hits.length === 0 ? (
                                          !isAnyFindingFilterActive && (
                                            <div className="flex flex-col items-center justify-center gap-2 py-8">
                                              <Shield className="w-5 h-5 text-brand-300" />
                                              <p className="text-sm text-gray-400">
                                                {scan.skippedCount > 0
                                                  ? 'No new findings detected in this scan.'
                                                  : 'No findings detected in this scan.'}
                                              </p>
                                            </div>
                                          )
                                        ) : (
                                          <div className="space-y-3 lg:space-y-5">
                                            {(['high', 'medium', 'low'] as const)
                                              .filter((sev) => hits.some((f) => f.severity === sev))
                                              .map((sev) => (
                                                <SeverityGroup
                                                  key={`${scan.id}-${sev}`}
                                                  severity={sev}
                                                  findings={hits.filter((f) => f.severity === sev)}
                                                  selectedFindingIds={selectedFindingIdSet}
                                                  onSelectionChange={handleFindingSelectionChange}
                                                  onIgnoreToggle={handleIgnoreToggle}
                                                  onAddressToggle={handleAddressedToggle}
                                                  onReclassify={handleReclassifyFinding}
                                                  onBookmarkUpdate={handleBookmarkUpdate}
                                                  onNoteUpdate={handleFindingNoteUpdate}
                                                  forceExpanded={isAnyFindingFilterActive}
                                                  highlightQuery={activeHighlightQuery}
                                                  autoExpandToken={
                                                    anchorTargetScanId === scan.id && singleSelectedFindingCategory === sev
                                                      ? `${scan.id}-${sev}`
                                                      : null
                                                  }
                                                  sectionAnchorId={getScanCategorySectionAnchorId(scan.id, sev)}
                                                />
                                              ))}
                                          </div>
                                        )}

                                        {displayedNonHitCount > 0 && (
                                          <div
                                            id={getScanCategorySectionAnchorId(scan.id, 'non-hit')}
                                            className="mt-4 scroll-mt-28 overflow-hidden sm:mt-4 sm:rounded-xl sm:border sm:border-gray-200 sm:bg-white lg:mt-5 lg:rounded-2xl"
                                          >
                                            <button
                                              type="button"
                                              onClick={() => {
                                                if (isAnyFindingFilterActive) return;
                                                const next = !showNonHitsByScanId[scan.id];
                                                setShowNonHitsByScanId((prev) => ({ ...prev, [scan.id]: next }));
                                                if (next) loadScanNonHits(scan.id);
                                              }}
                                              className={cn(
                                                "flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left transition sm:rounded-none sm:px-4 sm:py-3 lg:px-5 lg:py-4",
                                                showNonHits ? "sm:border-b border-gray-100 bg-gray-50" : "hover:bg-gray-50",
                                              )}
                                            >
                                              {!isAnyFindingFilterActive && (showNonHits
                                                ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                                : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />)}
                                              <span className="text-sm font-medium text-gray-500">
                                                Non-findings
                                                <span className="ml-1.5 text-xs font-normal text-gray-400">
                                                  ({nonHits ? nonHits.length : displayedNonHitCount})
                                                </span>
                                              </span>
                                              <span className="hidden sm:inline text-xs text-gray-400">· classified as false positives by AI · reclassify to any category</span>
                                            </button>
                                            {showNonHits && (
                                              <div className="space-y-3 pt-2 sm:space-y-4 sm:border-t sm:border-gray-100 sm:p-4 lg:space-y-5 lg:p-5">
                                                {!nonHits ? (
                                                  <div className="flex items-center justify-center gap-2 py-4 text-gray-400">
                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                    <span className="text-sm">Loading…</span>
                                                  </div>
                                                ) : (
                                                  sortBySeverity(nonHits).map((finding) => (
                                                    <FindingCard
                                                      key={finding.id}
                                                      finding={finding}
                                                      isSelected={selectedFindingIdSet.has(finding.id)}
                                                      highlightQuery={activeHighlightQuery}
                                                      onSelectionChange={handleFindingSelectionChange}
                                                      onReclassify={handleReclassifyFinding}
                                                      onBookmarkUpdate={handleBookmarkUpdate}
                                                      onNoteUpdate={handleFindingNoteUpdate}
                                                    />
                                                  ))
                                                )}
                                              </div>
                                            )}
                                          </div>
                                        )}

                                        {displayedIgnoredCount > 0 && (
                                          <div className="mt-5 overflow-hidden rounded-xl border border-gray-200 bg-white lg:rounded-2xl">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                if (isAnyFindingFilterActive) return;
                                                const next = !showIgnoredByScanId[scan.id];
                                                setShowIgnoredByScanId((prev) => ({ ...prev, [scan.id]: next }));
                                                if (next) loadScanIgnored(scan.id);
                                              }}
                                              className={cn(
                                                "flex w-full items-center gap-2 px-4 py-3 text-left transition lg:px-5 lg:py-4",
                                                showIgnored ? "border-b border-gray-100 bg-gray-50" : "hover:bg-gray-50",
                                              )}
                                            >
                                              {!isAnyFindingFilterActive && (showIgnored
                                                ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                                : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />)}
                                              <EyeOff className="w-3.5 h-3.5 text-gray-400" />
                                              <span className="text-sm font-medium text-gray-500">
                                                Ignored
                                                <span className="ml-1.5 text-xs font-normal text-gray-400">
                                                  ({ignored ? ignored.length : displayedIgnoredCount})
                                                </span>
                                              </span>
                                              <span className="text-xs text-gray-400">· manually dismissed</span>
                                            </button>
                                            {showIgnored && (
                                              <div className="space-y-4 border-t border-gray-100 p-4 lg:space-y-5 lg:p-5">
                                                {!ignored ? (
                                                  <div className="flex items-center justify-center gap-2 py-4 text-gray-400">
                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                    <span className="text-sm">Loading…</span>
                                                  </div>
                                                ) : (
                                                  ignored.map((finding) => (
                                                    <FindingCard
                                                      key={finding.id}
                                                      finding={finding}
                                                      isSelected={selectedFindingIdSet.has(finding.id)}
                                                      highlightQuery={activeHighlightQuery}
                                                      onSelectionChange={handleFindingSelectionChange}
                                                      onIgnoreToggle={handleIgnoreToggle}
                                                      onReclassify={handleReclassifyFinding}
                                                      onBookmarkUpdate={handleBookmarkUpdate}
                                                      onNoteUpdate={handleFindingNoteUpdate}
                                                    />
                                                  ))
                                                )}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                      </>
                    )}
                  </div>
                </div>
              </section>
            </>
          )}
        </div>

        {showBackToTopLink && selectedFindings.length === 0 && (
          <a
            href="#brand-detail-top"
            onClick={(event) => {
              event.preventDefault();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="fixed bottom-5 right-4 z-30 inline-flex items-center gap-1.5 rounded-full border border-gray-200/90 bg-white/95 px-3 py-1.5 text-xs font-medium text-gray-500 shadow-sm backdrop-blur transition hover:border-gray-300 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:bottom-6 sm:right-6"
          >
            <ArrowUp className="h-3.5 w-3.5" />
            Back to top
          </a>
        )}

        {selectedFindings.length > 0 && (
          <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4 pointer-events-none">
            <div className="pointer-events-auto w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-200/50 bg-white shadow-[0_20px_60px_-15px_rgba(0,0,0,0.1),0_0_0_1px_rgba(0,0,0,0.02)] backdrop-blur-xl ring-1 ring-slate-900/5">
              <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-500 text-white shadow-sm">
                      <span className="text-xs font-bold">{formatInteger(selectedFindings.length)}</span>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        Finding{selectedFindings.length !== 1 ? 's' : ''} selected
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Bulk actions only apply to compatible findings.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 self-start sm:self-center">
                    <button
                      type="button"
                      onClick={() => setIsBulkActionPanelExpanded((current) => !current)}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 sm:hidden"
                      aria-expanded={isBulkActionPanelExpanded}
                      aria-controls="bulk-action-panel-content"
                    >
                      {isBulkActionPanelExpanded ? 'Hide actions' : 'Show actions'}
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 transition-transform',
                          isBulkActionPanelExpanded ? 'rotate-180' : 'rotate-0',
                        )}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={clearSelectedFindings}
                      disabled={bulkActionLoading}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <X className="h-4 w-4" />
                      Clear selection
                    </button>
                  </div>
                </div>

                <div
                  id="bulk-action-panel-content"
                  className={cn(
                    'gap-4 lg:grid-cols-2',
                    isBulkActionPanelExpanded ? 'grid' : 'hidden sm:grid',
                  )}
                >
                  <div className="rounded-xl bg-slate-50 p-4 border border-slate-200/60">
                    <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      Apply actions
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <BulkActionButton
                        icon={Crosshair}
                        label="Reclassify"
                        onClick={openBulkReclassifyDialog}
                        disabled={bulkActionLoading || bulkReclassifyCompatibleFindings.length === 0}
                      />
                      <BulkActionButton
                        icon={EyeOff}
                        label="Ignore"
                        onClick={() => void runBulkFindingAction(bulkIgnoreCompatibleFindings, async (finding) => handleIgnoreToggle(finding, true))}
                        disabled={bulkActionLoading || bulkIgnoreCompatibleFindings.length === 0}
                      />
                      <BulkActionButton
                        icon={Check}
                        label="Mark as addressed"
                        onClick={() => void runBulkFindingAction(bulkAddressCompatibleFindings, async (finding) => handleAddressedToggle(finding, true))}
                        disabled={bulkActionLoading || bulkAddressCompatibleFindings.length === 0}
                      />
                      <BulkActionButton
                        icon={Bookmark}
                        label="Bookmark"
                        onClick={() => void runBulkFindingAction(bulkBookmarkCompatibleFindings, async (finding) => handleBookmarkUpdate(finding, { isBookmarked: true }))}
                        disabled={bulkActionLoading || bulkBookmarkCompatibleFindings.length === 0}
                      />
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4 border border-slate-200/60">
                    <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      Reverse actions
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <BulkActionButton
                        icon={EyeOff}
                        label="Un-ignore"
                        onClick={() => void runBulkFindingAction(bulkUnignoreCompatibleFindings, async (finding) => handleIgnoreToggle(finding, false))}
                        disabled={bulkActionLoading || bulkUnignoreCompatibleFindings.length === 0}
                        emphasis="muted"
                      />
                      <BulkActionButton
                        icon={X}
                        label="Mark as not addressed"
                        onClick={() => void runBulkFindingAction(bulkUnaddressCompatibleFindings, async (finding) => handleAddressedToggle(finding, false))}
                        disabled={bulkActionLoading || bulkUnaddressCompatibleFindings.length === 0}
                        emphasis="muted"
                      />
                      <BulkActionButton
                        icon={Bookmark}
                        label="Un-bookmark"
                        onClick={() => void runBulkFindingAction(bulkUnbookmarkCompatibleFindings, async (finding) => handleBookmarkUpdate(finding, { isBookmarked: false }))}
                        disabled={bulkActionLoading || bulkUnbookmarkCompatibleFindings.length === 0}
                        emphasis="muted"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {isBulkReclassifyDialogOpen && createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-950/60 px-4 py-4"
            onClick={() => {
              if (!bulkActionLoading) {
                setIsBulkReclassifyDialogOpen(false);
                setSelectedBulkReclassificationCategory(null);
              }
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="bulk-reclassify-title"
              aria-describedby="bulk-reclassify-description"
              className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-100">
                  <Crosshair className="h-5 w-5 text-brand-700" />
                </div>
                <div className="min-w-0">
                  <h2 id="bulk-reclassify-title" className="text-lg font-semibold text-gray-900">
                    Reclassify selected findings
                  </h2>
                  <p id="bulk-reclassify-description" className="mt-2 text-sm leading-6 text-gray-600">
                    Only selected findings that can be reclassified will be updated.
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {([
                  { category: 'high' as const, label: 'High', description: 'Move compatible selections into the high findings section.', tone: 'text-red-600' },
                  { category: 'medium' as const, label: 'Medium', description: 'Move compatible selections into the medium findings section.', tone: 'text-amber-600' },
                  { category: 'low' as const, label: 'Low', description: 'Move compatible selections into the low findings section.', tone: 'text-emerald-600' },
                  { category: 'non-hit' as const, label: 'Non-finding', description: 'Move compatible selections into the non-findings section.', tone: 'text-gray-600' },
                ]).map((option) => {
                  const isSelected = selectedBulkReclassificationCategory === option.category;

                  return (
                    <button
                      key={option.category}
                      type="button"
                      onClick={() => setSelectedBulkReclassificationCategory(option.category)}
                      className={cn(
                        'rounded-xl border px-4 py-3 text-left transition',
                        isSelected
                          ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50',
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className={cn('text-sm font-semibold', option.tone)}>
                          {option.label}
                        </span>
                        {isSelected && <Check className="w-4 h-4 text-brand-600" />}
                      </div>
                      <p className="mt-2 text-xs text-gray-500">
                        {option.description}
                      </p>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setIsBulkReclassifyDialogOpen(false);
                    setSelectedBulkReclassificationCategory(null);
                  }}
                  disabled={bulkActionLoading}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void confirmBulkReclassification()}
                  disabled={!selectedBulkReclassificationCategory || bulkActionLoading}
                  loading={bulkActionLoading}
                >
                  Save category
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

        {lookbackNudgeSuccessMessage && (
          <Toast
            message={lookbackNudgeSuccessMessage}
            onClose={() => setLookbackNudgeSuccessMessage('')}
          />
        )}

        {debugSummaryToastMessage && (
          <Toast
            message={debugSummaryToastMessage}
            onClose={() => setDebugSummaryToastMessage('')}
          />
        )}

        {isLookbackNudgeOpen && createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-950/60 px-4 py-4 sm:py-6"
            onClick={() => {
              if (!lookbackNudgeLoading) handleLookbackNudgeDismiss();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="lookback-nudge-title"
              aria-describedby="lookback-nudge-description"
              className="w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
              style={{ maxHeight: 'min(90vh, 600px)' }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-100">
                  <RotateCcw className="h-5 w-5 text-brand-700" />
                </div>
                <div className="min-w-0">
                  <h2 id="lookback-nudge-title" className="text-lg font-semibold text-gray-900">
                    Change your lookback period?
                  </h2>
                  <div id="lookback-nudge-description" className="mt-3 space-y-3 text-sm leading-6 text-gray-600">
                    <p>
                      You&apos;ve now performed a few scans for this brand with a 1 year lookback period. This is a great way to establish a solid base of findings; however, if you leave the lookback period set to 1 year, future scans are likely to include a large number of findings that duplicate existing ones, so they&apos;ll be skipped.
                    </p>
                    <p>
                      We recommend switching to <strong className="font-medium text-gray-800">Since last scan</strong>. This focuses each scan on genuinely new activity, giving you higher quality, more recent findings.
                    </p>
                    <p>Would you like to switch the lookback period for this brand?</p>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleLookbackNudgeDismiss}
                  disabled={lookbackNudgeLoading}
                >
                  No thanks
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleLookbackNudgeAccept()}
                  loading={lookbackNudgeLoading}
                >
                  Yes
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

        {isCustomScanDialogOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/60 px-4 py-8"
            onClick={closeCustomScanDialog}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="custom-scan-title"
              aria-describedby="custom-scan-description"
              className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-5">
                <div className="min-w-0 pr-4">
                  <h2 id="custom-scan-title" className="text-lg font-semibold text-gray-900">
                    Custom scan
                  </h2>
                  <p id="custom-scan-description" className="mt-2 text-sm leading-6 text-gray-600">
                    Choose one-off settings for this scan. Your saved brand defaults will not be changed.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeCustomScanDialog}
                  disabled={scanning}
                  className="rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
                  aria-label="Close custom scan dialog"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                <div className="space-y-6">
                  <div className="rounded-2xl border border-gray-200 bg-white p-6">
                    <BrandScanTuningFields
                      hideDivider
                      hideInfoMessage={brand?.lookbackNudgeDismissed === true}
                      lookbackPeriod={customScanSettings.lookbackPeriod}
                      onLookbackPeriodChange={(value) => {
                        setCustomScanSettings((current) => ({ ...current, lookbackPeriod: value }));
                      }}
                      searchResultPages={customScanSettings.searchResultPages}
                      onSearchResultPagesChange={(value) => {
                        setCustomScanSettings((current) => ({ ...current, searchResultPages: value }));
                      }}
                      allowAiDeepSearches={customScanSettings.allowAiDeepSearches}
                      onAllowAiDeepSearchesChange={(value) => {
                        setCustomScanSettings((current) => ({ ...current, allowAiDeepSearches: value }));
                      }}
                      maxAiDeepSearches={customScanSettings.maxAiDeepSearches}
                      onMaxAiDeepSearchesChange={(value) => {
                        setCustomScanSettings((current) => ({ ...current, maxAiDeepSearches: value }));
                      }}
                    />
                  </div>

                  <div className="rounded-2xl border border-gray-200 bg-white p-6">
                    <div className="mb-4">
                      <h3 className="text-sm font-medium text-gray-700">Scan types</h3>
                      <p className="mt-1 text-sm text-gray-500">
                        Enable the sources you want to include in this scan only.
                      </p>
                    </div>
                    <BrandScanSourceFields
                      value={customScanSettings.scanSources}
                      onChange={(value) => {
                        setCustomScanSettings((current) => ({ ...current, scanSources: value }));
                        setCustomScanError('');
                      }}
                      error={customScanError}
                    />
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-100 bg-white px-6 py-4">
                <div className="flex justify-end gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={scanning}
                    onClick={closeCustomScanDialog}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    loading={scanning}
                    onClick={() => {
                      void triggerCustomScan();
                    }}
                  >
                    Run custom scan
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </AuthGuard>
  );
}

export default function BrandDetailPage() {
  return (
    <Suspense fallback={null}>
      <BrandDetailPageContent />
    </Suspense>
  );
}
