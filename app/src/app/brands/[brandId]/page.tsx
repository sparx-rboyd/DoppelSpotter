'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Play, AlertCircle, AlertTriangle, Info, Shield, Search, Loader2,
  ChevronDown, ChevronRight, Settings, Trash2, X, EyeOff, Bookmark, Link2, Check, Download, RotateCcw,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
import { SelectDropdown } from '@/components/ui/select-dropdown';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { InfoTooltip, Tooltip } from '@/components/ui/tooltip';
import { normalizeAllowAiDeepSearches } from '@/lib/brands';
import {
  formatScanScheduleFrequency,
  formatScheduledRunAt,
} from '@/lib/scan-schedules';
import { cn, formatScanDate } from '@/lib/utils';
import type { ActorRunInfo, BrandProfile, FindingCategory, FindingSummary, Scan, ScanSummary } from '@/lib/types';

const POLL_INTERVAL_MS = 5_000;
const ACTIVE_SCAN_IDLE_POLL_INTERVAL_MS = 20_000;
const ACTIVE_SCAN_DELETE_TOOLTIP =
  "Scan history can't be changed while a scan is running because current results are compared against previous findings.";
const CLEARING_HISTORY_DELETE_TOOLTIP = 'Please wait while scan history is being deleted.';
const SCAN_RESULT_SET_HASH_PREFIX = 'scan-result-set-';
const OTHER_FINDING_TAXONOMY_KEY = 'other';
const DRILLDOWN_CATEGORY_QUERY_PARAM = 'category';
const DRILLDOWN_PLATFORM_QUERY_PARAM = 'platform';
const DRILLDOWN_THEME_QUERY_PARAM = 'theme';
const RETURN_TO_QUERY_PARAM = 'returnTo';
const RETURN_TO_DASHBOARD_VALUE = 'dashboard';

type BookmarkUpdate = {
  isBookmarked?: boolean;
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
          {high} High
        </Badge>
      )}
      {medium > 0 && (
        <Badge variant="warning" className="gap-1 px-2 py-0.5 text-[11px]">
          <AlertTriangle className="w-3 h-3" />
          {medium} Medium
        </Badge>
      )}
      {low > 0 && (
        <Badge variant="success" className="gap-1 px-2 py-0.5 text-[11px]">
          <Info className="w-3 h-3" />
          {low} Low
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
    <div id={sectionAnchorId} className="scroll-mt-28 bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className={cn("flex items-center transition border-b", headerBg, headerBorder, !forceExpanded && hoverBg)}>
        <button
          type="button"
          onClick={() => {
            if (forceExpanded) return;
            setIsExpanded((v) => !v);
          }}
          className="flex items-center gap-2 flex-1 px-4 py-3 text-left min-w-0"
          aria-expanded={expanded}
        >
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
          <Badge variant={variant} className={SEVERITY_BADGE_CLASSES[severity]}>
            <Icon className="w-3.5 h-3.5" />
            {label}
          </Badge>
          <span className={cn('text-xs', SEVERITY_COUNT_TEXT_CLASSES[severity])}>
            {findings.length} finding{findings.length !== 1 ? 's' : ''}
          </span>
        </button>
        {onIgnoreToggle && (
          <button
            type="button"
            onClick={handleIgnoreAll}
            disabled={ignoringAll}
            className="flex-shrink-0 mr-3 inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 transition hover:bg-gray-300 disabled:opacity-50"
          >
            {ignoringAll
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <EyeOff className="w-3 h-3" />}
            Ignore all
          </button>
        )}
      </div>
      {expanded && (
        <div className="border-t border-gray-100 p-4 space-y-4">
          {findings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              highlightQuery={highlightQuery}
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

function ScanSummaryPanel({ summary }: { summary: string }) {
  return (
    <div className="rounded-xl border border-brand-100 bg-brand-50/70 px-4 py-4 border-l-2 border-l-brand-500">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-500" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-700/80">
            AI summary
          </p>
          <p className="mt-1 text-sm leading-6 text-gray-700">
            {summary}
          </p>
        </div>
      </div>
    </div>
  );
}

function normalizeFindingsSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
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

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function BrandDetailPage() {
  const { brandId } = useParams<{ brandId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const showDebug = searchParams.get('debug') === 'true';
  const backHref = searchParams.get(RETURN_TO_QUERY_PARAM) === RETURN_TO_DASHBOARD_VALUE
    ? '/dashboard'
    : '/brands';
  const initialFindingCategory = parseFindingCategoryFilter(searchParams.get(DRILLDOWN_CATEGORY_QUERY_PARAM));
  const initialFindingPlatform = searchParams.get(DRILLDOWN_PLATFORM_QUERY_PARAM)?.trim() ?? '';
  const initialFindingTheme = searchParams.get(DRILLDOWN_THEME_QUERY_PARAM)?.trim() ?? '';

  const [brand, setBrand] = useState<BrandProfile | null>(null);
  const [scans, setScans] = useState<ScanSummary[]>([]);
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
  const [allAddressedFindings, setAllAddressedFindings] = useState<FindingSummary[]>([]);
  const [activeTab, setActiveTab] = useState<'scans' | 'bookmarks' | 'ignored' | 'addressed'>('scans');
  const [allIgnoredFindings, setAllIgnoredFindings] = useState<FindingSummary[]>([]);
  const [findingsSearchQuery, setFindingsSearchQuery] = useState('');
  const [findingsSearchLoading, setFindingsSearchLoading] = useState(false);
  const [findingTaxonomyOptions, setFindingTaxonomyOptions] = useState<{ platforms: string[]; themes: string[] }>({
    platforms: [],
    themes: [],
  });
  const [hasLoadedFindingTaxonomyOptions, setHasLoadedFindingTaxonomyOptions] = useState(false);
  const [selectedFindingCategory, setSelectedFindingCategory] = useState<FindingCategory | null>(initialFindingCategory);
  const [selectedFindingPlatform, setSelectedFindingPlatform] = useState(initialFindingPlatform);
  const [selectedFindingTheme, setSelectedFindingTheme] = useState(initialFindingTheme);
  const [confirmDeleteScanId, setConfirmDeleteScanId] = useState<string | null>(null);
  const [deletingScanId, setDeletingScanId] = useState<string | null>(null);
  const [exportingCsvScanId, setExportingCsvScanId] = useState<string | null>(null);
  const [exportingPdfScanId, setExportingPdfScanId] = useState<string | null>(null);
  const [copiedScanLinkId, setCopiedScanLinkId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [activeScan, setActiveScan] = useState<Scan | null>(null);
  const [liveScanFindings, setLiveScanFindings] = useState<FindingSummary[]>([]);
  const [liveScanNonHits, setLiveScanNonHits] = useState<FindingSummary[]>([]);
  const [showLiveScanNonHits, setShowLiveScanNonHits] = useState(false);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const copiedScanLinkResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressScanKeyRef = useRef<string | null>(null);
  const pendingScanFindingsLoadsRef = useRef<Record<string, Promise<void>>>({});
  const pendingScanNonHitsLoadsRef = useRef<Record<string, Promise<void>>>({});
  const pendingScanIgnoredLoadsRef = useRef<Record<string, Promise<void>>>({});
  const [displayedScanProgressPct, setDisplayedScanProgressPct] = useState(0);
  const normalizedFindingsSearchQuery = normalizeFindingsSearchText(findingsSearchQuery);
  const normalizedSelectedFindingPlatform = normalizeFindingsTaxonomyValue(selectedFindingPlatform);
  const normalizedSelectedFindingTheme = normalizeFindingsTaxonomyValue(selectedFindingTheme);
  const isFindingsSearchActive = normalizedFindingsSearchQuery.length > 0;
  const hasActiveFindingCategoryFilter = selectedFindingCategory !== null;
  const hasActiveFindingPlatformFilter = normalizedSelectedFindingPlatform.length > 0;
  const hasActiveFindingThemeFilter = normalizedSelectedFindingTheme.length > 0;
  const isAnyFindingFilterActive =
    isFindingsSearchActive
    || hasActiveFindingCategoryFilter
    || hasActiveFindingPlatformFilter
    || hasActiveFindingThemeFilter;
  const activeHighlightQuery = isFindingsSearchActive ? findingsSearchQuery : undefined;

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function updateDrilldownUrl(updates: {
    category?: FindingCategory | null;
    platform?: string | null;
    theme?: string | null;
  }) {
    const params = new URLSearchParams(searchParams.toString());

    if (updates.category !== undefined) {
      if (updates.category) {
        params.set(DRILLDOWN_CATEGORY_QUERY_PARAM, updates.category);
      } else {
        params.delete(DRILLDOWN_CATEGORY_QUERY_PARAM);
      }
    }

    if (updates.platform !== undefined) {
      if (updates.platform && updates.platform.trim()) {
        params.set(DRILLDOWN_PLATFORM_QUERY_PARAM, updates.platform.trim());
      } else {
        params.delete(DRILLDOWN_PLATFORM_QUERY_PARAM);
      }
    }

    if (updates.theme !== undefined) {
      if (updates.theme && updates.theme.trim()) {
        params.set(DRILLDOWN_THEME_QUERY_PARAM, updates.theme.trim());
      } else {
        params.delete(DRILLDOWN_THEME_QUERY_PARAM);
      }
    }

    const queryString = params.toString();
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    router.replace(`${pathname}${queryString ? `?${queryString}` : ''}${hash}`, { scroll: false });
  }

  function handleFindingCategoryFilterChange(nextValue: string) {
    const nextCategory = parseFindingCategoryFilter(nextValue);
    setSelectedFindingCategory(nextCategory);
    updateDrilldownUrl({ category: nextCategory });
  }

  function handleFindingPlatformFilterChange(nextValue: string) {
    setSelectedFindingPlatform(nextValue);
    updateDrilldownUrl({ platform: nextValue || null });
  }

  function handleFindingThemeFilterChange(nextValue: string) {
    setSelectedFindingTheme(nextValue);
    updateDrilldownUrl({ theme: nextValue || null });
  }

  function resetFindingsSearchAndFilters() {
    setFindingsSearchQuery('');
    setSelectedFindingCategory(null);
    setSelectedFindingPlatform('');
    setSelectedFindingTheme('');
    updateDrilldownUrl({
      category: null,
      platform: null,
      theme: null,
    });
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

  async function refreshBrandProfile() {
    const brandRes = await fetch(`/api/brands/${brandId}`, { credentials: 'same-origin' });
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

  async function loadAllIgnoredFindings() {
    try {
      const res = await fetch(`/api/brands/${brandId}/findings?ignoredOnly=true`, { credentials: 'same-origin' });
      if (res.ok) {
        const json = await res.json();
        setAllIgnoredFindings(json.data ?? []);
      }
    } catch {
      // Non-critical
    }
  }

  async function loadAllAddressedFindings() {
    try {
      const res = await fetch(`/api/brands/${brandId}/findings?addressedOnly=true`, { credentials: 'same-origin' });
      if (res.ok) {
        const json = await res.json();
        setAllAddressedFindings(json.data ?? []);
      }
    } catch {
      // Non-critical
    }
  }

  async function loadAllBookmarkedFindings() {
    try {
      const res = await fetch(`/api/brands/${brandId}/findings?bookmarkedOnly=true`, { credentials: 'same-origin' });
      if (res.ok) {
        const json = await res.json();
        setAllBookmarkedFindings(json.data ?? []);
      }
    } catch {
      // Non-critical
    }
  }

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
          platforms: json.data?.platforms ?? [],
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

  function getFindingDisplayBucket(finding: FindingSummary) {
    if (finding.isFalsePositive === true) return 'non-hit' as const;
    if (finding.isIgnored === true) return 'ignored' as const;
    if (finding.isAddressed === true) return 'addressed' as const;
    return 'hit' as const;
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

  function applyFindingMetadataUpdate(
    triggerFinding: FindingSummary,
    responseData: {
      isBookmarked?: boolean;
      bookmarkNote?: string | null;
    },
  ) {
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

  // ---------------------------------------------------------------------------
  // On mount: fetch brand + scans; restore in-flight scan if present
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function fetchData() {
      setError('');
      setLoading(true);

      // Fire non-critical loads immediately so they run in parallel with brand + scans fetches
      void loadAllBookmarkedFindings();
      void loadAllAddressedFindings();
      void loadAllIgnoredFindings();
      void loadFindingTaxonomyOptions();

      try {
        await refreshBrandProfile();

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
  }, [brandId]);

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
    if (!anchorTargetScanId || selectedFindingCategory !== 'non-hit') return;
    if (!scans.some((scan) => scan.id === anchorTargetScanId)) return;

    void loadScanNonHits(anchorTargetScanId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorTargetScanId, selectedFindingCategory, scans]);

  useEffect(() => {
    if (!anchorTargetScanId || !selectedFindingCategory) return;
    if (!scans.some((scan) => scan.id === anchorTargetScanId)) return;

    scrollToScanCategorySection(anchorTargetScanId, selectedFindingCategory);
  }, [anchorTargetScanId, scanFindings, scanNonHits, scans, selectedFindingCategory]);

  useEffect(() => {
    if (loading || scanning) return;

    const idlePoll = setInterval(() => {
      void restoreActiveScan();
    }, ACTIVE_SCAN_IDLE_POLL_INTERVAL_MS);

    return () => clearInterval(idlePoll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, loading, scanning]);

  useEffect(() => {
    if (!isAnyFindingFilterActive) {
      setFindingsSearchLoading(false);
      return;
    }

    const needsHydration = scans.some((scan) => {
      const hitCount = scan.highCount + scan.mediumCount + scan.lowCount;
      return (
        (hitCount > 0 && scanFindings[scan.id] === undefined)
        || (scan.nonHitCount > 0 && scanNonHits[scan.id] === undefined)
        || ((scan.ignoredCount ?? 0) > 0 && scanIgnored[scan.id] === undefined)
      );
    });

    if (!needsHydration) {
      setFindingsSearchLoading(false);
      return;
    }

    let cancelled = false;
    setFindingsSearchLoading(true);

    void Promise.all(
      scans.flatMap((scan) => {
        const loads: Promise<void>[] = [];
        const hitCount = scan.highCount + scan.mediumCount + scan.lowCount;

        if (hitCount > 0 && scanFindings[scan.id] === undefined) {
          loads.push(loadScanFindings(scan.id));
        }
        if (scan.nonHitCount > 0 && scanNonHits[scan.id] === undefined) {
          loads.push(loadScanNonHits(scan.id));
        }
        if ((scan.ignoredCount ?? 0) > 0 && scanIgnored[scan.id] === undefined) {
          loads.push(loadScanIgnored(scan.id));
        }

        return loads;
      }),
    ).finally(() => {
      if (!cancelled) {
        setFindingsSearchLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnyFindingFilterActive, scans, scanFindings, scanNonHits, scanIgnored]);

  const availableFindingPlatforms = useMemo(() => collectDistinctFindingTaxonomyLabels([
    ...findingTaxonomyOptions.platforms,
    ...allBookmarkedFindings.map((finding) => finding.platform),
    ...allAddressedFindings.map((finding) => finding.platform),
    ...allIgnoredFindings.map((finding) => finding.platform),
    ...liveScanFindings.map((finding) => finding.platform),
    ...liveScanNonHits.map((finding) => finding.platform),
    ...Object.values(scanFindings).flat().map((finding) => finding.platform),
    ...Object.values(scanNonHits).flat().map((finding) => finding.platform),
    ...Object.values(scanIgnored).flat().map((finding) => finding.platform),
  ]), [
    findingTaxonomyOptions.platforms,
    allBookmarkedFindings,
    allAddressedFindings,
    allIgnoredFindings,
    liveScanFindings,
    liveScanNonHits,
    scanFindings,
    scanNonHits,
    scanIgnored,
  ]);

  const availableFindingThemes = useMemo(() => collectDistinctFindingTaxonomyLabels([
    ...findingTaxonomyOptions.themes,
    ...allBookmarkedFindings.map((finding) => finding.theme),
    ...allAddressedFindings.map((finding) => finding.theme),
    ...allIgnoredFindings.map((finding) => finding.theme),
    ...liveScanFindings.map((finding) => finding.theme),
    ...liveScanNonHits.map((finding) => finding.theme),
    ...Object.values(scanFindings).flat().map((finding) => finding.theme),
    ...Object.values(scanNonHits).flat().map((finding) => finding.theme),
    ...Object.values(scanIgnored).flat().map((finding) => finding.theme),
  ]), [
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

  useEffect(() => {
    if (!hasLoadedFindingTaxonomyOptions) return;
    if (availableFindingPlatforms.length === 0) return;
    if (
      normalizedSelectedFindingPlatform
      && !availableFindingPlatforms.some(
        (platform) => normalizeFindingsTaxonomyValue(platform) === normalizedSelectedFindingPlatform,
      )
    ) {
      setSelectedFindingPlatform('');
    }
  }, [availableFindingPlatforms, hasLoadedFindingTaxonomyOptions, normalizedSelectedFindingPlatform]);

  useEffect(() => {
    if (!hasLoadedFindingTaxonomyOptions) return;
    if (availableFindingThemes.length === 0) return;
    if (
      normalizedSelectedFindingTheme
      && !availableFindingThemes.some(
        (theme) => normalizeFindingsTaxonomyValue(theme) === normalizedSelectedFindingTheme,
      )
    ) {
      setSelectedFindingTheme('');
    }
  }, [availableFindingThemes, hasLoadedFindingTaxonomyOptions, normalizedSelectedFindingTheme]);

  useEffect(() => {
    return () => {
      if (copiedScanLinkResetTimeoutRef.current) {
        clearTimeout(copiedScanLinkResetTimeoutRef.current);
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

  async function triggerScan() {
    setScanning(true);
    setError('');
    setActiveScanId(null);
    setActiveScan(null);
    setLiveScanFindings([]);
    setLiveScanNonHits([]);
    setShowLiveScanNonHits(false);

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ brandId }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const existingScan = json.data?.activeScan as Scan | undefined;
        if (res.status === 409 && existingScan) {
          attachToActiveScan(existingScan);
          return;
        }
        throw new Error(json.error ?? 'Failed to start scan');
      }

      const json = await res.json();
      const scanId: string = json.data.scanId;

      setExpandedScanIds([]);
      setActiveScanId(scanId);
      setStoredScanId(brandId, scanId);
      startPolling(scanId);
    } catch (err) {
      setScanning(false);
      setError(err instanceof Error ? err.message : 'Scan failed');
    }
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
      setAllAddressedFindings([]);
      setAllIgnoredFindings([]);
      setFindingTaxonomyOptions({ platforms: [], themes: [] });
      setExpandedScanIds([]);
      setActiveScan(null);
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

  const allRuns = activeScan?.actorRuns ? Object.values(activeScan.actorRuns) : [];
  const inFlightRuns = allRuns.filter(
    (r) => r.status === 'running' || r.status === 'waiting_for_preference_hints' || r.status === 'fetching_dataset' || r.status === 'analysing',
  );
  const activeRun =
    inFlightRuns.find((r) => (r.searchDepth ?? 0) > 0) ??
    inFlightRuns[0] ??
    allRuns[0];

  const runStatus = activeRun?.status;
  const allDeepSearchRuns = allRuns.filter((r) => (r.searchDepth ?? 0) > 0);
  const isDeepSearchActive = inFlightRuns.some((r) => (r.searchDepth ?? 0) > 0);
  const activeDeepSearchCount = inFlightRuns.filter((r) => (r.searchDepth ?? 0) > 0).length;
  const identifiedDeepSearchCount = Math.max(
    allDeepSearchRuns.length,
    allRuns.reduce((max, run) => Math.max(max, (run.searchDepth ?? 0) === 0 ? run.suggestedSearches?.length ?? 0 : 0), 0),
  );
  const skippedDuplicateCount = allRuns.reduce((sum, run) => sum + (run.skippedDuplicateCount ?? 0), 0);
  const isAiDeepSearchEnabled = normalizeAllowAiDeepSearches(brand?.allowAiDeepSearches);

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

  function formatDeepSearchQueryForDisplay(query: string): string {
    const formatted = query
      .trim()
      .replace(/(^|[\s([{])[`"'“”‘’]+/g, '$1')
      .replace(/[`"'“”‘’]+(?=[\s)\]},.!?:;]|$)/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return formatted || query.trim();
  }

  function renderDeepSearchQueryLabel(prefix: string, query: string, suffix = ''): ReactNode {
    const displayQuery = formatDeepSearchQueryForDisplay(query);

    return (
      <>
        {prefix}
        {' '}
        <span className="align-bottom" title={displayQuery}>
          <em>{displayQuery}</em>
        </span>
        {suffix}
      </>
    );
  }

  function renderDeepSearchAnalysisLabel(query: string, run?: ActorRunInfo): ReactNode {
    const counts = getRunAnalysisCounts(run);
    if (!counts) {
      return renderDeepSearchQueryLabel('Analysing deep search results for', query);
    }

    const prefix = counts.completed >= counts.total
      ? 'Finalising deep search results for'
      : 'Analysing deep search results for';

    return renderDeepSearchQueryLabel(prefix, query);
  }

  function getDeepSearchSelectionAnnouncement(): string | null {
    if (identifiedDeepSearchCount <= 0) return null;
    return `AI analysis identified ${identifiedDeepSearchCount} follow up search${identifiedDeepSearchCount !== 1 ? 'es' : ''}.`;
  }

  function getScanStatusLabel(): ReactNode {
    if (activeScan?.status === 'summarising') {
      return 'Summarising findings';
    }
    if (!activeRun) return 'Starting scan';

    if (isDeepSearchActive) {
      const query = activeRun.searchQuery;
      switch (runStatus) {
        case 'waiting_for_preference_hints':
          return query
            ? renderDeepSearchQueryLabel('Preparing analysis context for', query)
            : 'Preparing analysis context';
        case 'fetching_dataset':
          return query
            ? renderDeepSearchQueryLabel('Fetching deeper results for', query)
            : `Investigating ${activeDeepSearchCount} more related quer${activeDeepSearchCount !== 1 ? 'ies' : 'y'}`;
        case 'analysing':
          return query
            ? renderDeepSearchAnalysisLabel(query, activeRun)
            : withAnalysisCounts('Analysing deep search results', 'Finalising deep search results', activeRun);
        default:
          return activeDeepSearchCount > 1
            ? `Investigating ${activeDeepSearchCount} more related queries`
            : query
              ? renderDeepSearchQueryLabel('Investigating related query:', query)
              : 'Running deeper investigation';
      }
    }

    switch (runStatus) {
      case 'waiting_for_preference_hints': return 'Preparing analysis context';
      case 'fetching_dataset': return 'Fetching search results';
      case 'analysing': return withAnalysisCounts('Analysing search results', 'Analysing search results', activeRun);
      default: return 'Waiting for web search to complete';
    }
  }

  function getSkippedDuplicateSubtext(): string | null {
    if (skippedDuplicateCount <= 0) return null;
    if (skippedDuplicateCount === 1) {
      return '1 result is being skipped because it duplicates previous findings.';
    }
    return `${skippedDuplicateCount} results are being skipped because they duplicate previous findings.`;
  }

  function getDeepSearchProgressSubtext(): string | null {
    const announcement = getDeepSearchSelectionAnnouncement();
    if (!announcement) return null;
    return announcement;
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

  function getRawOverallScanProgressPct(): number {
    if (!scanning) return 0;
    if (!activeScan) return 8;
    if (activeScan.status === 'summarising') return 96;
    if (allRuns.length === 0) return 10;

    const totalFraction =
      allRuns.reduce((sum, run) => sum + getRunProgressFraction(run), 0) / allRuns.length;

    if (isAiDeepSearchEnabled && identifiedDeepSearchCount === 0) {
      const initialRun = allRuns.find((run) => (run.searchDepth ?? 0) === 0) ?? activeRun;
      const initialFraction = initialRun ? getRunProgressFraction(initialRun) : totalFraction;
      // Reserve more visible headroom while the initial pass is still deciding
      // whether any AI deep-search follow-ups will be launched.
      return Math.round(8 + 70 * initialFraction);
    }

    // Leave visible headroom so late-discovered deep-search runs do not imply the
    // scan is effectively complete before the backend has finished all work.
    return Math.round(8 + 86 * totalFraction);
  }

  const progressScanKey = activeScanId ?? activeScan?.id ?? null;
  const rawOverallScanProgressPct = getRawOverallScanProgressPct();
  const isSummarisingFindings = activeScan?.status === 'summarising';

  useEffect(() => {
    if (!progressScanKey) {
      progressScanKeyRef.current = null;
      setDisplayedScanProgressPct(0);
      return;
    }

    if (progressScanKeyRef.current !== progressScanKey) {
      progressScanKeyRef.current = progressScanKey;
      setDisplayedScanProgressPct(rawOverallScanProgressPct);
      return;
    }

    setDisplayedScanProgressPct((prev) => Math.max(prev, rawOverallScanProgressPct));
  }, [progressScanKey, rawOverallScanProgressPct]);

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
    const matchesSearch = !isFindingsSearchActive || normalizeFindingsSearchText(
      `${finding.title} ${finding.url ?? ''} ${finding.llmAnalysis}`,
    ).includes(normalizedFindingsSearchQuery);
    const matchesCategory = !selectedFindingCategory || (
      selectedFindingCategory === 'non-hit'
        ? finding.isFalsePositive === true
        : finding.isFalsePositive !== true && finding.severity === selectedFindingCategory
    );
    const matchesPlatform = !hasActiveFindingPlatformFilter
      || normalizeFindingsTaxonomyValue(finding.platform) === normalizedSelectedFindingPlatform;
    const matchesTheme = !hasActiveFindingThemeFilter
      || normalizeFindingsTaxonomyValue(finding.theme) === normalizedSelectedFindingTheme;

    return matchesSearch && matchesCategory && matchesPlatform && matchesTheme;
  }

  function filterFindings(findings?: FindingSummary[]) {
    if (!findings) return findings;
    return isAnyFindingFilterActive ? findings.filter(matchesFindingFilters) : findings;
  }

  const totalFindings = scans.reduce((sum, s) => sum + s.highCount + s.mediumCount + s.lowCount, 0);
  const totalNonHits = scans.reduce((sum, s) => sum + s.nonHitCount, 0);
  const totalAddressed = scans.reduce((sum, s) => sum + (s.addressedCount ?? 0), 0);
  const totalIgnored = scans.reduce((sum, s) => sum + (s.ignoredCount ?? 0), 0);
  const totalSkipped = scans.reduce((sum, s) => sum + (s.skippedCount ?? 0), 0);
  const totalResultsCount = totalFindings + totalNonHits + totalAddressed + totalIgnored + totalSkipped;
  const requiresClearHistoryConfirmation = totalResultsCount > 0;
  const isAwaitingClearHistoryConfirmation = confirmClear && requiresClearHistoryConfirmation;
  const activeFindingsFilterLabel = isFindingsSearchActive && (hasActiveFindingPlatformFilter || hasActiveFindingThemeFilter)
    ? 'search and filters'
    : isFindingsSearchActive
      ? 'search'
      : 'filters';
  const findingPlatformOptions = [
    { value: '', label: 'All platforms' },
    ...availableFindingPlatforms.map((platform) => ({ value: platform, label: platform })),
  ];
  const findingThemeOptions = [
    { value: '', label: 'All themes' },
    ...availableFindingThemes.map((theme) => ({ value: theme, label: theme })),
  ];
  const findingCategoryOptions = [
    { value: '', label: 'All' },
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
    { value: 'non-hit', label: 'Non-findings' },
  ];
  const visibleBookmarkedFindings = filterFindings(allBookmarkedFindings) ?? [];
  const bookmarkedHits = visibleBookmarkedFindings.filter((finding) => !finding.isFalsePositive);
  const bookmarkedNonHits = sortBySeverity(visibleBookmarkedFindings.filter((finding) => finding.isFalsePositive));
  const visibleBookmarkedCount = visibleBookmarkedFindings.length;
  const visibleAddressedFindings = filterFindings(allAddressedFindings) ?? [];
  const visibleAddressedCount = visibleAddressedFindings.length;
  const visibleIgnoredFindings = filterFindings(allIgnoredFindings) ?? [];
  const visibleIgnoredCount = visibleIgnoredFindings.length;
  const visibleLiveScanFindings = filterFindings(liveScanFindings) ?? [];
  const visibleLiveScanNonHits = sortBySeverity(filterFindings(liveScanNonHits) ?? []);
  const scansToRender = anchorTargetScanId
    ? scans
    : isAnyFindingFilterActive
      ? scans.filter((scan) => {
          const hits = filterFindings(scanFindings[scan.id]) ?? [];
          const nonHits = filterFindings(scanNonHits[scan.id]) ?? [];
          const ignored = filterFindings(scanIgnored[scan.id]) ?? [];
          return hits.length > 0 || nonHits.length > 0 || ignored.length > 0;
        })
      : scans;
  const hasVisibleScanMatches = (
    visibleLiveScanFindings.length > 0
    || visibleLiveScanNonHits.length > 0
    || scansToRender.length > 0
  );
  const clearHistoryDisabledReason = scanning
    ? ACTIVE_SCAN_DELETE_TOOLTIP
    : clearing
      ? CLEARING_HISTORY_DELETE_TOOLTIP
      : null;
  const showClearHistoryAction = activeTab === 'scans' && scans.length > 0 && !isAwaitingClearHistoryConfirmation;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AuthGuard>
      <Navbar />
      <main className="pt-16 min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">

          {/* Back link */}
          <div className="flex items-center justify-between gap-3 mb-8">
            <div className="flex items-center gap-3">
              <Link href={backHref} className="text-brand-600 hover:text-brand-700 transition">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              {brand && (
                <h1 className="text-2xl font-bold text-gray-900">{brand.name}</h1>
              )}
            </div>
            {brand && (
              <Link href={`/brands/${brandId}/edit`}>
                <Button variant="secondary" size="sm">
                  <Settings className="w-4 h-4" />
                  Brand Settings
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
              {brand.scanSchedule?.enabled && (
                <div className="mb-4 rounded-lg bg-brand-100/70 px-3 py-2">
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

              <section className="mb-6">
                <div className="rounded-t-2xl bg-brand-600 px-5 py-6 sm:px-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-4">
                      <h2 className="text-xl font-semibold text-white sm:text-2xl">Findings</h2>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="inline-flex items-center rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/95 ring-1 ring-white/10">
                          {scans.length === 0
                            ? 'No scans yet'
                            : `${scans.length} scan${scans.length !== 1 ? 's' : ''}`}
                        </span>
                        {scans.length > 0 && (
                          <span className="inline-flex items-center rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/95 ring-1 ring-white/10">
                            {totalFindings} finding{totalFindings !== 1 ? 's' : ''} detected
                          </span>
                        )}
                        {totalNonHits > 0 && (
                          <span className="inline-flex items-center rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/95 ring-1 ring-white/10">
                            {totalNonHits} non-hit{totalNonHits !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
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
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={triggerScan}
                        loading={scanning}
                        disabled={scanning || clearing || isAwaitingClearHistoryConfirmation}
                        className="border-white/15 bg-white !text-brand-700 hover:border-white/30 hover:bg-brand-50 disabled:hover:bg-white"
                      >
                        <Play className="w-4 h-4" />
                        Run scan
                      </Button>
                    </div>
                  </div>
                  <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center">
                    <div className="relative max-w-xl flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <Input
                        value={findingsSearchQuery}
                        onChange={(e) => setFindingsSearchQuery(e.target.value)}
                        placeholder="Search finding titles, URLs, and analyses"
                        aria-label="Search findings"
                        className="pl-9 pr-10 border-white/20 bg-white text-gray-900 placeholder:text-gray-400"
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
                    <div className="flex flex-col gap-3 sm:flex-row lg:flex-shrink-0">
                      <SelectDropdown
                        id="findings-platform-filter"
                        ariaLabel="Filter findings by platform"
                        value={selectedFindingPlatform}
                        options={findingPlatformOptions}
                        onChange={handleFindingPlatformFilterChange}
                        triggerClassName={cn(
                          'min-w-[11rem] border-white/20',
                          hasActiveFindingPlatformFilter && 'border-brand-200 bg-brand-50 text-brand-800',
                        )}
                        matchTriggerWidth={false}
                        panelClassName="min-w-[16rem] max-w-[calc(100vw-1.5rem)]"
                        dividerAfterValue=""
                        showActiveIndicator={hasActiveFindingPlatformFilter}
                      />
                      <SelectDropdown
                        id="findings-theme-filter"
                        ariaLabel="Filter findings by theme"
                        value={selectedFindingTheme}
                        options={findingThemeOptions}
                        onChange={handleFindingThemeFilterChange}
                        triggerClassName={cn(
                          'min-w-[11rem] border-white/20',
                          hasActiveFindingThemeFilter && 'border-brand-200 bg-brand-50 text-brand-800',
                        )}
                        matchTriggerWidth={false}
                        panelClassName="min-w-[16rem] max-w-[calc(100vw-1.5rem)]"
                        dividerAfterValue=""
                        showActiveIndicator={hasActiveFindingThemeFilter}
                      />
                      <SelectDropdown
                        id="findings-severity-filter"
                        ariaLabel="Filter findings by severity"
                        value={selectedFindingCategory ?? ''}
                        options={findingCategoryOptions}
                        onChange={handleFindingCategoryFilterChange}
                        triggerClassName={cn(
                          'min-w-[11rem] border-white/20',
                          hasActiveFindingCategoryFilter && 'border-brand-200 bg-brand-50 text-brand-800',
                        )}
                        matchTriggerWidth={false}
                        panelClassName="min-w-[14rem] max-w-[calc(100vw-1.5rem)]"
                        dividerAfterValue=""
                        showActiveIndicator={hasActiveFindingCategoryFilter}
                      />
                      {isAnyFindingFilterActive && (
                        <button
                          type="button"
                          onClick={resetFindingsSearchAndFilters}
                          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/8 px-3 py-2 text-xs font-medium text-white/85 transition hover:bg-white/12 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                  {isAnyFindingFilterActive && (
                    <p className="mt-3 text-xs text-white/80">
                      {findingsSearchLoading
                        ? 'Filtering across hits, non-hits, ignored, addressed, and bookmarked findings...'
                        : `Showing only findings that match the current ${activeFindingsFilterLabel}.`}
                    </p>
                  )}
                </div>

                {activeTab === 'scans' && isAwaitingClearHistoryConfirmation && (
                  <div className="border-x border-b border-red-100 bg-red-50 px-4 py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-red-800">
                        <span className="font-semibold">
                          Permanently delete all {totalResultsCount} result{totalResultsCount !== 1 ? 's' : ''} and scan history?
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
                  <div className="border-b border-gray-200 px-4 sm:px-6">
                    <div className="flex items-end gap-7 overflow-x-auto">
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
                        {visibleBookmarkedCount > 0 && (
                          <Badge variant="default" className="rounded-full border-none bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-gray-600">
                            {visibleBookmarkedCount}
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
                        {visibleAddressedCount > 0 && (
                          <Badge variant="default" className="rounded-full border-none bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-gray-600">
                            {visibleAddressedCount}
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
                        {visibleIgnoredCount > 0 && (
                          <Badge variant="default" className="rounded-full border-none bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-gray-600">
                            {visibleIgnoredCount}
                          </Badge>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="bg-gray-50 px-4 py-6 sm:px-6">
                    {activeTab === 'bookmarks' && (
                      visibleBookmarkedCount === 0 ? (
                        <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                            <Bookmark className="w-5 h-5 text-brand-600" />
                          </div>
                          <p className="text-sm text-gray-500">
                            {isAnyFindingFilterActive ? `No bookmarked findings match the current ${activeFindingsFilterLabel}.` : 'No bookmarked findings yet.'}
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-6">
                          {(['high', 'medium', 'low'] as const)
                            .filter((sev) => bookmarkedHits.some((finding) => finding.severity === sev))
                            .map((sev) => (
                              <SeverityGroup
                                key={`bookmarked-${sev}`}
                                severity={sev}
                                findings={bookmarkedHits.filter((finding) => finding.severity === sev)}
                                onAddressToggle={handleAddressedToggle}
                                onReclassify={handleReclassifyFinding}
                                onBookmarkUpdate={handleBookmarkUpdate}
                                onNoteUpdate={handleFindingNoteUpdate}
                                forceExpanded={true}
                                highlightQuery={activeHighlightQuery}
                              />
                            ))}

                          {bookmarkedNonHits.length > 0 && (
                            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                              <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-4 py-3">
                                <Bookmark className="w-3.5 h-3.5 text-gray-400" />
                                <span className="text-sm font-medium text-gray-500">
                                  Non-hits
                                  <span className="ml-1.5 text-xs font-normal text-gray-400">
                                    ({bookmarkedNonHits.length})
                                  </span>
                                </span>
                                <span className="text-xs text-gray-400">· bookmarked despite AI classifying them as false positives · reclassify to any category</span>
                              </div>
                              <div className="space-y-4 border-t border-gray-100 p-4">
                                {bookmarkedNonHits.map((finding) => (
                                  <FindingCard
                                    key={finding.id}
                                    finding={finding}
                                    highlightQuery={activeHighlightQuery}
                                    onReclassify={handleReclassifyFinding}
                                    onBookmarkUpdate={handleBookmarkUpdate}
                                    onNoteUpdate={handleFindingNoteUpdate}
                                  />
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    )}

                    {activeTab === 'addressed' && (
                      visibleAddressedCount === 0 ? (
                        <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                            <Check className="w-5 h-5 text-brand-600" />
                          </div>
                          <p className="text-sm text-gray-500">
                            {isAnyFindingFilterActive ? `No addressed findings match the current ${activeFindingsFilterLabel}.` : 'No addressed findings yet.'}
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-6">
                          {(['high', 'medium', 'low'] as const)
                            .filter((sev) => visibleAddressedFindings.some((finding) => finding.severity === sev))
                            .map((sev) => (
                              <SeverityGroup
                                key={`addressed-${sev}`}
                                severity={sev}
                                findings={visibleAddressedFindings.filter((finding) => finding.severity === sev)}
                                onAddressToggle={handleAddressedToggle}
                                onBookmarkUpdate={handleBookmarkUpdate}
                                onNoteUpdate={handleFindingNoteUpdate}
                                forceExpanded={true}
                                highlightQuery={activeHighlightQuery}
                              />
                            ))}
                        </div>
                      )
                    )}

                    {activeTab === 'ignored' && (
                      visibleIgnoredCount === 0 ? (
                        <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-6 py-12 text-center">
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                            <EyeOff className="w-5 h-5 text-brand-600" />
                          </div>
                          <p className="text-sm text-gray-500">
                            {isAnyFindingFilterActive ? `No ignored findings match the current ${activeFindingsFilterLabel}.` : 'No ignored findings yet.'}
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {visibleIgnoredFindings.map((finding) => (
                            <FindingCard
                              key={finding.id}
                              finding={finding}
                              highlightQuery={activeHighlightQuery}
                              onIgnoreToggle={handleIgnoreToggle}
                              onReclassify={handleReclassifyFinding}
                              onBookmarkUpdate={handleBookmarkUpdate}
                              onNoteUpdate={handleFindingNoteUpdate}
                            />
                          ))}
                        </div>
                      )
                    )}

                    {activeTab === 'scans' && (
                      <div className="space-y-4">
                        {scanning && (
                          (() => {
                            const showLiveNonHitsSection = isAnyFindingFilterActive
                              ? visibleLiveScanNonHits.length > 0
                              : showLiveScanNonHits;

                            return (
                              <div className="overflow-hidden rounded-xl border border-brand-200 bg-white">
                                <div className="bg-brand-50/40 px-6 py-4">
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center gap-3 text-left">
                                        <Loader2 className="w-4 h-4 text-brand-600 animate-spin flex-shrink-0" />
                                        <span className="text-sm font-semibold text-brand-700 flex-shrink-0">
                                          Scan in progress
                                        </span>
                                        {visibleLiveScanFindings.length > 0 && (
                                          <SeverityPills
                                            high={visibleLiveScanFindings.filter((f) => f.severity === 'high').length}
                                            medium={visibleLiveScanFindings.filter((f) => f.severity === 'medium').length}
                                            low={visibleLiveScanFindings.filter((f) => f.severity === 'low').length}
                                          />
                                        )}
                                      </div>
                                      <div className="mt-3 pl-7">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="text-sm font-medium text-brand-700">
                                            {cancelling ? 'Cancelling scan' : getScanStatusLabel()}
                                          </span>
                                          {isDeepSearchActive && !cancelling && (
                                            <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
                                              Deep search
                                            </span>
                                          )}
                                        </div>
                                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-brand-100">
                                          <div
                                            className="h-full rounded-full bg-brand-600 transition-all duration-500"
                                            style={{ width: `${displayedScanProgressPct}%` }}
                                          />
                                        </div>
                                        {!cancelling && !isSummarisingFindings && getDeepSearchProgressSubtext() && (
                                          <p className="mt-3 text-xs text-brand-700/80">
                                            {getDeepSearchProgressSubtext()}
                                          </p>
                                        )}
                                        {!cancelling && !isSummarisingFindings && getSkippedDuplicateSubtext() && (
                                          <p className="mt-2 text-xs text-brand-700/80">
                                            {getSkippedDuplicateSubtext()}
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                    {!cancelling && (
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={cancelScan}
                                        className="flex-shrink-0 hover:bg-red-50 hover:text-red-600 hover:border-red-200"
                                      >
                                        <X className="w-3.5 h-3.5" />
                                        Cancel
                                      </Button>
                                    )}
                                  </div>
                                </div>
                                <div className="border-t border-brand-100 bg-brand-50/30 px-4 py-5 sm:px-6">
                                  {visibleLiveScanFindings.length === 0 && visibleLiveScanNonHits.length === 0 ? (
                                    <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                      <span className="text-sm">
                                        {isAnyFindingFilterActive ? `No live findings match the current ${activeFindingsFilterLabel} yet.` : 'Waiting for first results…'}
                                      </span>
                                    </div>
                                  ) : (
                                    <div className="space-y-4">
                                      {visibleLiveScanFindings.length === 0 ? (
                                        !isAnyFindingFilterActive && (
                                          <div className="flex flex-col items-center justify-center gap-2 py-6">
                                            <Shield className="w-5 h-5 text-brand-300" />
                                            <p className="text-sm text-gray-400">
                                              No live findings detected yet.
                                            </p>
                                          </div>
                                        )
                                      ) : (
                                        <div className="space-y-3">
                                          {(['high', 'medium', 'low'] as const)
                                            .filter((sev) => visibleLiveScanFindings.some((f) => f.severity === sev))
                                            .map((sev) => (
                                              <SeverityGroup
                                                key={`live-${sev}`}
                                                severity={sev}
                                                findings={visibleLiveScanFindings.filter((f) => f.severity === sev)}
                                                onReclassify={handleReclassifyFinding}
                                                onBookmarkUpdate={handleBookmarkUpdate}
                                                onNoteUpdate={handleFindingNoteUpdate}
                                                forceExpanded={isAnyFindingFilterActive}
                                                highlightQuery={activeHighlightQuery}
                                                autoExpandToken={
                                                  anchorTargetScanId === activeScan?.id && selectedFindingCategory === sev
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
                                          className="scroll-mt-28 overflow-hidden rounded-xl border border-gray-200 bg-white"
                                        >
                                          <button
                                            type="button"
                                            onClick={() => {
                                              if (isAnyFindingFilterActive) return;
                                              setShowLiveScanNonHits((prev) => !prev);
                                            }}
                                            className={cn(
                                              "flex w-full items-center gap-2 px-4 py-3 text-left transition",
                                              showLiveNonHitsSection ? "border-b border-gray-100 bg-gray-50" : "hover:bg-gray-50",
                                            )}
                                          >
                                            {showLiveNonHitsSection
                                              ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                              : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                                            <span className="text-sm font-medium text-gray-500">
                                              Non-hits
                                              <span className="ml-1.5 text-xs font-normal text-gray-400">
                                                ({visibleLiveScanNonHits.length})
                                              </span>
                                            </span>
                                            <span className="text-xs text-gray-400">· classified as false positives by AI · reclassify to any category</span>
                                          </button>
                                          {showLiveNonHitsSection && (
                                            <div className="space-y-4 border-t border-gray-100 p-4">
                                              {visibleLiveScanNonHits.map((finding) => (
                                                <FindingCard
                                                  key={finding.id}
                                                  finding={finding}
                                                  highlightQuery={activeHighlightQuery}
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
                            const isExpanded = anchorTargetScanId
                              ? anchorTargetScanId === scan.id
                              : isAnyFindingFilterActive
                                ? matchingHitCount + matchingNonHitCount + matchingIgnoredCount > 0
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
                            const isConfirmingDelete = confirmDeleteScanId === scan.id;
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
                            const deleteDisabledReason = scanning
                              ? ACTIVE_SCAN_DELETE_TOOLTIP
                              : clearing
                                ? CLEARING_HISTORY_DELETE_TOOLTIP
                                : null;

                            return (
                              <div
                                key={scan.id}
                                id={getScanResultSetAnchorId(scan.id)}
                                className="scroll-mt-24 overflow-hidden rounded-xl border border-gray-200 bg-white"
                              >
                                {isConfirmingDelete ? (
                                  <div className="flex items-center justify-between gap-4 bg-red-50 px-6 py-4">
                                    <p className="text-sm text-red-800">
                                      <span className="font-semibold">
                                        Delete this scan and its {scanResultsCount} result{scanResultsCount !== 1 ? 's' : ''}?
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
                                  <div className="group flex items-start gap-3 px-6 py-4 transition hover:bg-gray-50">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (isAnyFindingFilterActive) return;
                                        toggleScanExpand(scan.id);
                                      }}
                                      className="flex min-w-0 flex-1 items-start gap-4 text-left"
                                      aria-expanded={isExpanded}
                                    >
                                      {isExpanded
                                        ? <ChevronDown className="mt-0.5 w-4 h-4 text-gray-400 flex-shrink-0" />
                                        : <ChevronRight className="mt-0.5 w-4 h-4 text-gray-400 flex-shrink-0" />}
                                      <span className="flex min-w-0 flex-1 flex-col gap-2.5">
                                        <span className="text-sm font-semibold text-gray-500">
                                          {formatScanDate(scan.startedAt)}
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
                                            <span className="text-xs text-gray-400">
                                              · {displayedNonHitCount} non-hit{displayedNonHitCount !== 1 ? 's' : ''}
                                            </span>
                                          )}
                                          {displayedAddressedCount > 0 && (
                                            <span className="text-xs text-gray-400">
                                              · {displayedAddressedCount} addressed
                                            </span>
                                          )}
                                          {displayedIgnoredCount > 0 && (
                                            <span className="text-xs text-gray-400">
                                              · {displayedIgnoredCount} ignored
                                            </span>
                                          )}
                                          {(scan.skippedCount ?? 0) > 0 && (
                                            <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                                              · {scan.skippedCount} skipped
                                              <InfoTooltip
                                                content="Findings that appeared in previous scans were skipped."
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

                                    <div className="flex flex-shrink-0 items-center gap-2">
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        loading={exportingCsvScanId === scan.id}
                                        disabled={exportingCsvScanId !== null && exportingCsvScanId !== scan.id}
                                        onClick={() => void exportScanFindings(scan)}
                                        className="flex-shrink-0"
                                      >
                                        <Download className="w-3.5 h-3.5" />
                                        Export CSV
                                      </Button>

                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        loading={exportingPdfScanId === scan.id}
                                        disabled={exportingPdfScanId !== null && exportingPdfScanId !== scan.id}
                                        onClick={() => void exportScanPdf(scan)}
                                        className="flex-shrink-0"
                                      >
                                        <Download className="w-3.5 h-3.5" />
                                        Export PDF
                                      </Button>
                                    </div>

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
                                            'flex-shrink-0 rounded-md p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
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

                                    {deleteDisabledReason ? (
                                      <Tooltip content={deleteDisabledReason} align="end" triggerClassName="flex-shrink-0">
                                        <button
                                          type="button"
                                          aria-disabled="true"
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                          }}
                                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-300 opacity-50 cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </Tooltip>
                                    ) : (
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
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                                        aria-label="Delete scan"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                )}

                                {isExpanded && (
                                  <div className="border-t border-gray-100 bg-gray-50 px-4 py-5 sm:px-6">
                                    {isLoading ? (
                                      <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        <span className="text-sm">Loading results…</span>
                                      </div>
                                    ) : (
                                      <>
                                        {scan.aiSummary && (
                                          <div className="mb-4">
                                            <ScanSummaryPanel summary={scan.aiSummary} />
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
                                          <div className="space-y-3">
                                            {(['high', 'medium', 'low'] as const)
                                              .filter((sev) => hits.some((f) => f.severity === sev))
                                              .map((sev) => (
                                                <SeverityGroup
                                                  key={`${scan.id}-${sev}`}
                                                  severity={sev}
                                                  findings={hits.filter((f) => f.severity === sev)}
                                                  onIgnoreToggle={handleIgnoreToggle}
                                                  onAddressToggle={handleAddressedToggle}
                                                  onReclassify={handleReclassifyFinding}
                                                  onBookmarkUpdate={handleBookmarkUpdate}
                                                  onNoteUpdate={handleFindingNoteUpdate}
                                                  forceExpanded={isAnyFindingFilterActive}
                                                  highlightQuery={activeHighlightQuery}
                                                  autoExpandToken={
                                                    anchorTargetScanId === scan.id && selectedFindingCategory === sev
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
                                            className="mt-4 scroll-mt-28 overflow-hidden rounded-xl border border-gray-200 bg-white"
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
                                                "flex w-full items-center gap-2 px-4 py-3 text-left transition",
                                                showNonHits ? "border-b border-gray-100 bg-gray-50" : "hover:bg-gray-50",
                                              )}
                                            >
                                              {showNonHits
                                                ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                                : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                                              <span className="text-sm font-medium text-gray-500">
                                                Non-hits
                                                <span className="ml-1.5 text-xs font-normal text-gray-400">
                                                  ({nonHits ? nonHits.length : displayedNonHitCount})
                                                </span>
                                              </span>
                                              <span className="text-xs text-gray-400">· classified as false positives by AI · reclassify to any category</span>
                                            </button>
                                            {showNonHits && (
                                              <div className="space-y-4 border-t border-gray-100 p-4">
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
                                                      highlightQuery={activeHighlightQuery}
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
                                          <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                if (isAnyFindingFilterActive) return;
                                                const next = !showIgnoredByScanId[scan.id];
                                                setShowIgnoredByScanId((prev) => ({ ...prev, [scan.id]: next }));
                                                if (next) loadScanIgnored(scan.id);
                                              }}
                                              className={cn(
                                                "flex w-full items-center gap-2 px-4 py-3 text-left transition",
                                                showIgnored ? "border-b border-gray-100 bg-gray-50" : "hover:bg-gray-50",
                                              )}
                                            >
                                              {showIgnored
                                                ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                                : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
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
                                              <div className="space-y-4 border-t border-gray-100 p-4">
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
                                                      highlightQuery={activeHighlightQuery}
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
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
