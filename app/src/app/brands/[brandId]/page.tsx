'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  ArrowLeft, Play, AlertCircle, AlertTriangle, Info, Shield, Search, Loader2,
  ChevronDown, ChevronRight, Pencil, Trash2, X, EyeOff, Bookmark,
  Sparkles, Clock3,
} from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
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
import type { ActorRunInfo, BrandProfile, FindingSummary, Scan, ScanSummary } from '@/lib/types';

const POLL_INTERVAL_MS = 5_000;
const ACTIVE_SCAN_IDLE_POLL_INTERVAL_MS = 20_000;
const ACTIVE_SCAN_DELETE_TOOLTIP =
  "Scan history can't be changed while a scan is running because current results are compared against previous findings.";
const CLEARING_HISTORY_DELETE_TOOLTIP = 'Please wait while scan history is being deleted.';
const ANALYSIS_PROGRESS_BUCKET_SIZE = 10;

type BookmarkUpdate = {
  isBookmarked?: boolean;
  bookmarkNote?: string | null;
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

function SeverityPills({ high, medium, low }: { high: number; medium: number; low: number }) {
  if (high === 0 && medium === 0 && low === 0) return null;
  return (
    <span className="flex items-center gap-2">
      {high > 0 && (
        <Badge variant="danger">
          <AlertCircle className="w-3.5 h-3.5" />
          {high} High
        </Badge>
      )}
      {medium > 0 && (
        <Badge variant="warning">
          <AlertTriangle className="w-3.5 h-3.5" />
          {medium} Medium
        </Badge>
      )}
      {low > 0 && (
        <Badge variant="success">
          <Info className="w-3.5 h-3.5" />
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
  onBookmarkUpdate,
  forceExpanded = false,
  highlightQuery,
}: {
  severity: 'high' | 'medium' | 'low';
  findings: FindingSummary[];
  onIgnoreToggle?: (finding: FindingSummary, isIgnored: boolean) => Promise<void>;
  onBookmarkUpdate?: (finding: FindingSummary, updates: BookmarkUpdate) => Promise<void>;
  forceExpanded?: boolean;
  highlightQuery?: string;
}) {
  const [isExpanded, setIsExpanded] = useState(severity === 'high');
  const [ignoringAll, setIgnoringAll] = useState(false);

  const { variant, label, icon: Icon, headerBg, headerBorder, hoverBg } = SEVERITY_GROUP_CONFIG[severity];
  const expanded = forceExpanded || isExpanded;

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
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
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
          <Badge variant={variant}>
            <Icon className="w-3.5 h-3.5" />
            {label}
          </Badge>
          <span className="text-xs text-gray-500">
            {findings.length} finding{findings.length !== 1 ? 's' : ''}
          </span>
        </button>
        {onIgnoreToggle && (
          <button
            type="button"
            onClick={handleIgnoreAll}
            disabled={ignoringAll}
            className="flex-shrink-0 mr-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition disabled:opacity-50"
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
              onBookmarkUpdate={onBookmarkUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScanSummaryPanel({ summary }: { summary: string }) {
  return (
    <div className="rounded-xl border border-brand-100 bg-brand-50/70 px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white border border-brand-100">
          <Sparkles className="w-4 h-4 text-brand-600" />
        </div>
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

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function BrandDetailPage() {
  const { brandId } = useParams<{ brandId: string }>();

  const [brand, setBrand] = useState<BrandProfile | null>(null);
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [expandedScanIds, setExpandedScanIds] = useState<string[]>([]);
  const [scanFindings, setScanFindings] = useState<Record<string, FindingSummary[]>>({});
  const [scanNonHits, setScanNonHits] = useState<Record<string, FindingSummary[]>>({});
  const [scanIgnored, setScanIgnored] = useState<Record<string, FindingSummary[]>>({});
  const [loadingScanIds, setLoadingScanIds] = useState<string[]>([]);
  const [showNonHitsByScanId, setShowNonHitsByScanId] = useState<Record<string, boolean>>({});
  const [showIgnoredByScanId, setShowIgnoredByScanId] = useState<Record<string, boolean>>({});
  const [allBookmarkedFindings, setAllBookmarkedFindings] = useState<FindingSummary[]>([]);
  const [showAllBookmarked, setShowAllBookmarked] = useState(false);
  const [allIgnoredFindings, setAllIgnoredFindings] = useState<FindingSummary[]>([]);
  const [showAllIgnored, setShowAllIgnored] = useState(false);
  const [findingsSearchQuery, setFindingsSearchQuery] = useState('');
  const [findingsSearchLoading, setFindingsSearchLoading] = useState(false);
  const [confirmDeleteScanId, setConfirmDeleteScanId] = useState<string | null>(null);
  const [deletingScanId, setDeletingScanId] = useState<string | null>(null);

  const [expandedBrandSection, setExpandedBrandSection] = useState<'keywords' | 'officialDomains' | 'watchWords' | 'safeWords' | null>(null);

  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [activeScan, setActiveScan] = useState<Scan | null>(null);
  const [liveScanFindings, setLiveScanFindings] = useState<FindingSummary[]>([]);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressScanKeyRef = useRef<string | null>(null);
  const pendingScanFindingsLoadsRef = useRef<Record<string, Promise<void>>>({});
  const pendingScanNonHitsLoadsRef = useRef<Record<string, Promise<void>>>({});
  const pendingScanIgnoredLoadsRef = useRef<Record<string, Promise<void>>>({});
  const [displayedScanProgressPct, setDisplayedScanProgressPct] = useState(0);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
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

      const targetId = options?.autoExpandScanId ?? newScans[0]?.id;
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
    setStoredScanId(brandId, scan.id);
    startPolling(scan.id);
    void fetchLiveFindings(scan.id);
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
  // Ignore / un-ignore a finding
  // ---------------------------------------------------------------------------

  async function handleBookmarkUpdate(triggerFinding: FindingSummary, updates: BookmarkUpdate) {
    const res = await fetch(`/api/brands/${brandId}/findings/${triggerFinding.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? 'Failed to update bookmark');
    }

    const json = await res.json().catch(() => ({}));
    const responseData = (json.data ?? {}) as {
      isBookmarked?: boolean;
      bookmarkNote?: string | null;
    };
    const isBookmarked = responseData.isBookmarked ?? triggerFinding.isBookmarked ?? false;
    const bookmarkNote = responseData.bookmarkNote ?? null;

    const applyBookmarkUpdate = (finding: FindingSummary): FindingSummary => ({
      ...finding,
      isBookmarked,
      bookmarkedAt: isBookmarked ? finding.bookmarkedAt : undefined,
      bookmarkNote: bookmarkNote ?? undefined,
    });

    setScanFindings((prev) => updateFindingMap(prev, triggerFinding.id, applyBookmarkUpdate));
    setScanNonHits((prev) => updateFindingMap(prev, triggerFinding.id, applyBookmarkUpdate));
    setScanIgnored((prev) => updateFindingMap(prev, triggerFinding.id, applyBookmarkUpdate));
    setLiveScanFindings((prev) => updateFindingList(prev, triggerFinding.id, applyBookmarkUpdate));
    setAllIgnoredFindings((prev) => updateFindingList(prev, triggerFinding.id, applyBookmarkUpdate));
    setAllBookmarkedFindings((prev) => {
      if (!isBookmarked) {
        return prev.filter((finding) => finding.id !== triggerFinding.id);
      }

      const existing = prev.find((finding) => finding.id === triggerFinding.id);
      const updatedFinding = applyBookmarkUpdate(existing ?? triggerFinding);
      return [updatedFinding, ...prev.filter((finding) => finding.id !== triggerFinding.id)];
    });
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

  // ---------------------------------------------------------------------------
  // On mount: fetch brand + scans; restore in-flight scan if present
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function fetchData() {
      setError('');
      setLoading(true);

      // Fire non-critical loads immediately so they run in parallel with brand + scans fetches
      void loadAllBookmarkedFindings();
      void loadAllIgnoredFindings();

      try {
        await refreshBrandProfile();

        // Fetch scans list without auto-expanding until we know whether an
        // in-flight scan should own the active UI slot.
        const loadedScans = await fetchScans({ skipAutoExpand: true });

        // Resume any globally active scan for this brand, even if it was started in another tab
        // or environment that shares the same Firestore data.
        const restoredActiveScan = await restoreActiveScan();

        if (!restoredActiveScan && loadedScans[0]?.id) {
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
    if (loading || scanning) return;

    const idlePoll = setInterval(() => {
      void restoreActiveScan();
    }, ACTIVE_SCAN_IDLE_POLL_INTERVAL_MS);

    return () => clearInterval(idlePoll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, loading, scanning]);

  useEffect(() => {
    if (!normalizeFindingsSearchText(findingsSearchQuery)) {
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
  }, [findingsSearchQuery, scans, scanFindings, scanNonHits, scanIgnored]);

  // ---------------------------------------------------------------------------
  // Scan toggling
  // ---------------------------------------------------------------------------

  function toggleScanExpand(scanId: string) {
    const isCurrentlyExpanded = expandedScanIds.includes(scanId);
    setExpandedScanIds((prev) =>
      isCurrentlyExpanded ? prev.filter((id) => id !== scanId) : [...prev, scanId],
    );
    if (!isCurrentlyExpanded) {
      loadScanFindings(scanId);
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
          await fetchLiveFindings(scanId);
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
          setScanning(false);
          setCancelling(false);
          setActiveScanId(null);
          setActiveScan(null);
          setLiveScanFindings([]);
          // (scan complete — findings visible in the scan list row)
        } else if (scan.status === 'failed') {
          stopPolling();
          clearStoredScanId(brandId);
          setScanning(false);
          setCancelling(false);
          setActiveScanId(null);
          setLiveScanFindings([]);
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
          setActiveScan(null);
          await refreshBrandProfile().catch(() => {
            // Non-critical
          });
          await fetchScans();
        } else {
          // Scan still running — refresh live findings
          await fetchLiveFindings(scanId);
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
      setExpandedScanIds((prev) => prev.filter((id) => id !== scanId));
      setScans((prev) => prev.filter((s) => s.id !== scanId));
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
      setAllIgnoredFindings([]);
      setExpandedScanIds([]);
      setActiveScan(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear history');
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Progress bar helpers
  // ---------------------------------------------------------------------------

  const allRuns = activeScan?.actorRuns ? Object.values(activeScan.actorRuns) : [];
  const inFlightRuns = allRuns.filter(
    (r) => r.status === 'running' || r.status === 'fetching_dataset' || r.status === 'analysing',
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

  function formatAnalysisProgressRange(completed: number, total: number): string {
    if (total <= ANALYSIS_PROGRESS_BUCKET_SIZE + 1) {
      return `0 - ${total}`;
    }
    if (completed >= total) return `${total} out of ${total}`;
    if (completed <= ANALYSIS_PROGRESS_BUCKET_SIZE) {
      return `0 - ${Math.min(total, ANALYSIS_PROGRESS_BUCKET_SIZE)} out of ${total}`;
    }

    const rangeStart = Math.floor((completed - 1) / ANALYSIS_PROGRESS_BUCKET_SIZE) * ANALYSIS_PROGRESS_BUCKET_SIZE + 1;
    const rangeEnd = Math.min(total, rangeStart + ANALYSIS_PROGRESS_BUCKET_SIZE - 1);
    return `${rangeStart} - ${rangeEnd} out of ${total}`;
  }

  function withAnalysisCounts(inProgressLabel: string, finalisingLabel: string, run?: ActorRunInfo): string {
    const counts = getRunAnalysisCounts(run);
    if (!counts) return inProgressLabel;
    if (counts.completed >= counts.total) {
      return `${finalisingLabel} (${formatAnalysisProgressRange(counts.total, counts.total)})`;
    }
    return `${inProgressLabel} (${formatAnalysisProgressRange(counts.completed, counts.total)})`;
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
    const progress = ` (${formatAnalysisProgressRange(counts.completed, counts.total)})`;

    return renderDeepSearchQueryLabel(prefix, query, progress);
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
        case 'fetching_dataset':
          return query
            ? renderDeepSearchQueryLabel('Fetching deeper results for', query)
            : `Investigating ${activeDeepSearchCount} more related quer${activeDeepSearchCount !== 1 ? 'ies' : 'y'}`;
        case 'analysing':
          return query
            ? renderDeepSearchAnalysisLabel(query, activeRun)
            : withAnalysisCounts('Analysing deep search results with AI', 'Finalising deep search results with AI', activeRun);
        default:
          return activeDeepSearchCount > 1
            ? `Investigating ${activeDeepSearchCount} more related queries`
            : query
              ? renderDeepSearchQueryLabel('Investigating related query:', query)
              : 'Running deeper investigation';
      }
    }

    switch (runStatus) {
      case 'fetching_dataset': return 'Fetching initial search results from Apify';
      case 'analysing': return withAnalysisCounts('Analysing initial search results with AI', 'Finalising initial search results with AI', activeRun);
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

  const normalizedFindingsSearchQuery = normalizeFindingsSearchText(findingsSearchQuery);
  const isFindingsSearchActive = normalizedFindingsSearchQuery.length > 0;
  const activeHighlightQuery = isFindingsSearchActive ? findingsSearchQuery : undefined;

  function matchesFindingsSearch(finding: FindingSummary) {
    if (!isFindingsSearchActive) return true;

    return normalizeFindingsSearchText(
      `${finding.title} ${finding.url ?? ''} ${finding.llmAnalysis}`,
    ).includes(normalizedFindingsSearchQuery);
  }

  function filterFindingsForSearch(findings?: FindingSummary[]) {
    if (!findings) return findings;
    return isFindingsSearchActive ? findings.filter(matchesFindingsSearch) : findings;
  }

  const totalFindings = scans.reduce((sum, s) => sum + s.highCount + s.mediumCount + s.lowCount, 0);
  const totalNonHits = scans.reduce((sum, s) => sum + s.nonHitCount, 0);
  const totalIgnored = scans.reduce((sum, s) => sum + (s.ignoredCount ?? 0), 0);
  const totalSkipped = scans.reduce((sum, s) => sum + (s.skippedCount ?? 0), 0);
  const visibleBookmarkedFindings = filterFindingsForSearch(allBookmarkedFindings) ?? [];
  const bookmarkedHits = visibleBookmarkedFindings.filter((finding) => !finding.isFalsePositive);
  const bookmarkedNonHits = sortBySeverity(visibleBookmarkedFindings.filter((finding) => finding.isFalsePositive));
  const visibleIgnoredFindings = filterFindingsForSearch(allIgnoredFindings) ?? [];
  const visibleLiveScanFindings = filterFindingsForSearch(liveScanFindings) ?? [];
  const scansToRender = isFindingsSearchActive
    ? scans.filter((scan) => {
        const hits = filterFindingsForSearch(scanFindings[scan.id]) ?? [];
        const nonHits = filterFindingsForSearch(scanNonHits[scan.id]) ?? [];
        const ignored = filterFindingsForSearch(scanIgnored[scan.id]) ?? [];
        return hits.length > 0 || nonHits.length > 0 || ignored.length > 0;
      })
    : scans;
  const hasAnyVisibleSearchMatches = (
    visibleLiveScanFindings.length > 0
    || bookmarkedHits.length > 0
    || bookmarkedNonHits.length > 0
    || visibleIgnoredFindings.length > 0
    || scansToRender.length > 0
  );
  const clearHistoryDisabledReason = scanning
    ? ACTIVE_SCAN_DELETE_TOOLTIP
    : clearing
      ? CLEARING_HISTORY_DELETE_TOOLTIP
      : null;

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
              <Link href="/brands" className="text-brand-600 hover:text-brand-700 transition">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              {brand && (
                <h1 className="text-2xl font-bold text-gray-900">{brand.name}</h1>
              )}
            </div>
            {brand && (
              <Link href={`/brands/${brandId}/edit`}>
                <Button variant="secondary" size="sm">
                  <Pencil className="w-4 h-4" />
                  Edit
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
              {/* Brand meta */}
              {(() => {
                const keywords = brand.keywords;
                const domains = brand.officialDomains;
                const watchWords = brand.watchWords ?? [];
                const safeWords = brand.safeWords ?? [];
                const scanSchedule = brand.scanSchedule;

                type Section = 'keywords' | 'officialDomains' | 'watchWords' | 'safeWords';
                function toggleSection(section: Section) {
                  setExpandedBrandSection((prev) => (prev === section ? null : section));
                }

                const sections: {
                  key: Section;
                  label: string;
                  count: number;
                  tooltip: string;
                  items: string[];
                  badgeVariant: 'brand' | 'default' | 'warning';
                  emptyLabel: string;
                }[] = [
                  {
                    key: 'keywords',
                    label: 'Keywords',
                    count: keywords.length,
                    tooltip: 'The words associated with your brand that you want to protect and monitor (e.g. your trademarks). Scans will search for these keywords.',
                    items: keywords,
                    badgeVariant: 'default',
                    emptyLabel: 'No keywords set',
                  },
                  {
                    key: 'officialDomains',
                    label: 'Official Domains',
                    count: domains.length,
                    tooltip: 'Domains that you own, so that the AI analysis knows not to flag them.',
                    items: domains,
                    badgeVariant: 'default',
                    emptyLabel: 'No official domains set',
                  },
                  {
                    key: 'watchWords',
                    label: 'Watch Words',
                    count: watchWords.length,
                    tooltip: "Words that you don't want to be associated with your brand. Scans won't search for these words, but if they appear in scan results the AI analysis will treat the results with more caution.",
                    items: watchWords,
                    badgeVariant: 'default',
                    emptyLabel: 'No watch words set',
                  },
                  {
                    key: 'safeWords',
                    label: 'Safe Words',
                    count: safeWords.length,
                    tooltip: "Words that you're happy to be associated with your brand. If they appear in scan results the AI analysis will treat the results with less caution.",
                    items: safeWords,
                    badgeVariant: 'default',
                    emptyLabel: 'No safe words set',
                  },
                ];

                const activeSection = sections.find((s) => s.key === expandedBrandSection);

                return (
                  <div className="mb-8">
                    <div className="flex items-center gap-1 flex-wrap">
                      {sections.map((section, idx) => {
                        const isOpen = expandedBrandSection === section.key;
                        return (
                          <div key={section.key} className="flex items-center gap-1">
                            {idx > 0 && <span className="text-gray-300 text-xs select-none">·</span>}
                            <button
                              type="button"
                              onClick={() => toggleSection(section.key)}
                              className={cn(
                                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition",
                                isOpen
                                  ? "bg-brand-600 text-white"
                                  : "text-gray-500 hover:text-gray-900 hover:bg-gray-100"
                              )}
                            >
                              <span>{section.label}</span>
                              <span className={cn(
                                "inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold",
                                isOpen ? "bg-white text-gray-900" : "bg-gray-200 text-gray-600"
                              )}>
                                {section.count}
                              </span>
                              <InfoTooltip content={section.tooltip} iconClassName={isOpen ? 'text-white/70 hover:text-white' : 'text-gray-400 hover:text-gray-500'} />
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    {activeSection && (
                      <div className="mt-2 px-3 py-2.5 bg-white border border-gray-200 rounded-xl flex flex-wrap gap-2">
                        {activeSection.items.length > 0
                          ? activeSection.items.map((item) => (
                              <Badge key={item} variant={activeSection.badgeVariant}>{item}</Badge>
                            ))
                          : <span className="text-sm text-gray-400">{activeSection.emptyLabel}</span>}
                      </div>
                    )}

                    <div className="mt-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                          <Clock3 className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-gray-700">Scheduled scans</span>
                            {scanSchedule?.enabled ? (
                              <Badge variant="brand">{formatScanScheduleFrequency(scanSchedule.frequency)}</Badge>
                            ) : (
                              <Badge variant="default">Off</Badge>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-gray-500">
                            <span>
                              {scanSchedule?.enabled
                                ? `Next due ${formatScheduledRunAt(scanSchedule.nextRunAt, scanSchedule.timeZone)}`
                                : 'Scheduling is currently disabled for this brand.'}
                            </span>
                            {scanSchedule?.enabled && (
                              <InfoTooltip content="Scheduled scans will run within 10 minutes of the scheduled start time." />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Scan progress banner */}
              {scanning && (
                <div className="mb-6 bg-brand-50 border border-brand-200 rounded-xl px-5 py-4">
                  <div className="flex items-center justify-between gap-4 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Loader2 className="w-4 h-4 text-brand-600 animate-spin flex-shrink-0" />
                      <span className="text-sm font-medium text-brand-700 truncate">
                        {cancelling ? 'Cancelling scan' : getScanStatusLabel()}
                      </span>
                      {isDeepSearchActive && !cancelling && (
                        <span className="flex-shrink-0 inline-flex items-center gap-1 bg-brand-100 text-brand-700 text-xs font-medium px-2 py-0.5 rounded-full">
                          Deep search
                        </span>
                      )}
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
                  <div className="h-1.5 bg-brand-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-600 rounded-full transition-all duration-500"
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
              )}


              {/* Findings panel */}
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                {/* Panel header */}
                <div className="px-6 py-5 border-b border-brand-700 flex items-center justify-between gap-4 bg-brand-600">
                  <div className="flex items-center gap-3">
                    <div>
                      <h2 className="text-base font-semibold text-white">Findings</h2>
                      <p className="text-xs font-medium text-white/85">
                        {scans.length === 0
                          ? 'No scans yet'
                          : `${scans.length} scan${scans.length !== 1 ? 's' : ''} · ${totalFindings} finding${totalFindings !== 1 ? 's' : ''} detected`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(totalFindings > 0 || totalNonHits > 0) && !confirmClear && (
                      clearHistoryDisabledReason ? (
                        <Tooltip content={clearHistoryDisabledReason} align="end">
                          <button
                            type="button"
                            aria-disabled="true"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-xs font-medium bg-white/5 text-white/50 opacity-70 cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Clear history
                          </button>
                        </Tooltip>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmClear(true)}
                          className="border border-white/15 text-white/90 hover:text-white hover:bg-white/10"
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
                      disabled={scanning || clearing || confirmClear}
                      className="border-white/20 bg-white !text-brand-700 hover:bg-brand-50 hover:border-white/30 disabled:hover:bg-white"
                    >
                      <Play className="w-4 h-4" />
                      Run scan
                    </Button>
                  </div>
                </div>

                {/* Inline clear all confirmation */}
                {confirmClear && (
                  <div className="px-6 py-4 bg-red-50 border-b border-red-100 flex items-center justify-between gap-4">
                    <p className="text-sm text-red-800">
                      Permanently delete all {totalFindings + totalNonHits + totalIgnored + totalSkipped} result{(totalFindings + totalNonHits + totalIgnored + totalSkipped) !== 1 ? 's' : ''} and scan history? This cannot be undone.
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
                )}

                <div className="px-6 py-4 border-b border-gray-100 bg-white">
                  <div className="relative max-w-xl">
                    <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <Input
                      value={findingsSearchQuery}
                      onChange={(e) => setFindingsSearchQuery(e.target.value)}
                      placeholder="Search finding titles, URLs, and analyses"
                      aria-label="Search findings"
                      className="pl-9 pr-10"
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
                  {isFindingsSearchActive && (
                    <p className="mt-2 text-xs text-gray-500">
                      {findingsSearchLoading
                        ? 'Searching across hits, non-hits, ignored, and bookmarked findings...'
                        : 'Showing only findings that match this search.'}
                    </p>
                  )}
                </div>

                {(isFindingsSearchActive ? visibleBookmarkedFindings.length > 0 : allBookmarkedFindings.length > 0) && (
                  <div className="border-b border-gray-100">
                    <button
                      type="button"
                      onClick={() => {
                        if (isFindingsSearchActive) return;
                        setShowAllBookmarked((v) => !v);
                      }}
                      className={cn(
                        "w-full px-6 py-5 flex items-center gap-3 transition text-left bg-amber-50",
                        (isFindingsSearchActive || showAllBookmarked) ? "border-b border-amber-100" : "hover:bg-amber-100/70",
                      )}
                      aria-expanded={isFindingsSearchActive || showAllBookmarked}
                    >
                      {(isFindingsSearchActive || showAllBookmarked)
                        ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                      <Bookmark className="w-4 h-4 text-amber-600 flex-shrink-0" />
                      <div>
                        <h2 className="text-base font-semibold text-gray-900">Bookmarked findings</h2>
                        <p className="text-xs text-gray-500">
                          {(isFindingsSearchActive ? visibleBookmarkedFindings.length : allBookmarkedFindings.length)} bookmarked finding{(isFindingsSearchActive ? visibleBookmarkedFindings.length : allBookmarkedFindings.length) !== 1 ? 's' : ''} saved for follow-up
                        </p>
                      </div>
                    </button>

                    {(isFindingsSearchActive || showAllBookmarked) && (
                      <div className="bg-gray-50 px-4 sm:px-6 py-5">
                        <div className="space-y-3">
                          {(['high', 'medium', 'low'] as const)
                            .filter((sev) => bookmarkedHits.some((finding) => finding.severity === sev))
                            .map((sev) => (
                              <SeverityGroup
                                key={`bookmarked-${sev}`}
                                severity={sev}
                                findings={bookmarkedHits.filter((finding) => finding.severity === sev)}
                                onBookmarkUpdate={handleBookmarkUpdate}
                                forceExpanded={isFindingsSearchActive}
                                highlightQuery={activeHighlightQuery}
                              />
                            ))}

                          {bookmarkedNonHits.length > 0 && (
                            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                              <div className="px-4 py-3 flex items-center gap-2 bg-gray-50 border-b border-gray-100">
                                <Bookmark className="w-3.5 h-3.5 text-gray-400" />
                                <span className="text-sm font-medium text-gray-500">
                                  Non-hits
                                  <span className="ml-1.5 text-xs font-normal text-gray-400">
                                    ({bookmarkedNonHits.length})
                                  </span>
                                </span>
                                <span className="text-xs text-gray-400">· bookmarked despite AI classifying them as false positives</span>
                              </div>
                              <div className="border-t border-gray-100 p-4 space-y-4">
                                {bookmarkedNonHits.map((finding) => (
                                  <FindingCard
                                    key={finding.id}
                                    finding={finding}
                                    highlightQuery={activeHighlightQuery}
                                    onBookmarkUpdate={handleBookmarkUpdate}
                                  />
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Scan result sets */}
                <div className="divide-y divide-gray-100">
                  {/* Live findings — shown while a scan is in progress */}
                  {scanning && (!isFindingsSearchActive || visibleLiveScanFindings.length > 0) && (
                    <div className="bg-brand-50/40">
                      {/* Live row header */}
                      <div className="flex items-center gap-4 px-6 py-4">
                        <div className="flex items-center gap-3 flex-1 min-w-0 text-left">
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
                      </div>
                      {/* Live row body */}
                      <div className="border-t border-brand-100 px-4 sm:px-6 py-5 bg-brand-50/30">
                        {visibleLiveScanFindings.length === 0 ? (
                          <div className="flex items-center justify-center py-8 gap-2 text-gray-400">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span className="text-sm">
                              {isFindingsSearchActive ? 'No live findings match this search yet.' : 'Waiting for first results…'}
                            </span>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {(['high', 'medium', 'low'] as const)
                              .filter((sev) => visibleLiveScanFindings.some((f) => f.severity === sev))
                              .map((sev) => (
                                <SeverityGroup
                                  key={`live-${sev}`}
                                  severity={sev}
                                  findings={visibleLiveScanFindings.filter((f) => f.severity === sev)}
                                  onBookmarkUpdate={handleBookmarkUpdate}
                                  forceExpanded={isFindingsSearchActive}
                                  highlightQuery={activeHighlightQuery}
                                />
                              ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {isFindingsSearchActive && findingsSearchLoading ? (
                    <div className="flex items-center justify-center py-12 gap-2 text-gray-400">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-sm">Searching across all findings…</span>
                    </div>
                  ) : isFindingsSearchActive && !hasAnyVisibleSearchMatches ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center">
                        <Search className="w-5 h-5 text-brand-600" />
                      </div>
                      <p className="text-sm text-gray-500">No findings match this search.</p>
                    </div>
                  ) : !isFindingsSearchActive && scansToRender.length === 0 && !scanning ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center">
                        <Shield className="w-5 h-5 text-brand-600" />
                      </div>
                      <p className="text-sm text-gray-500">No findings yet. Run a scan to start monitoring.</p>
                    </div>
                  ) : (
                    scansToRender.map((scan) => {
                      const hits = filterFindingsForSearch(scanFindings[scan.id]);
                      const nonHits = filterFindingsForSearch(scanNonHits[scan.id]);
                      const ignored = filterFindingsForSearch(scanIgnored[scan.id]);
                      const matchingHitCount = hits?.length ?? 0;
                      const matchingNonHitCount = nonHits?.length ?? 0;
                      const matchingIgnoredCount = ignored?.length ?? 0;
                      const isExpanded = isFindingsSearchActive
                        ? matchingHitCount + matchingNonHitCount + matchingIgnoredCount > 0
                        : expandedScanIds.includes(scan.id);
                      const isLoading = loadingScanIds.includes(scan.id);
                      const showNonHits = isFindingsSearchActive
                        ? matchingNonHitCount > 0
                        : showNonHitsByScanId[scan.id] ?? false;
                      const showIgnored = isFindingsSearchActive
                        ? matchingIgnoredCount > 0
                        : showIgnoredByScanId[scan.id] ?? false;
                      const isConfirmingDelete = confirmDeleteScanId === scan.id;
                      const isDeleting = deletingScanId === scan.id;
                      const hasFindings = isFindingsSearchActive
                        ? matchingHitCount > 0
                        : scan.highCount + scan.mediumCount + scan.lowCount > 0;
                      const displayedHighCount = isFindingsSearchActive
                        ? hits?.filter((f) => f.severity === 'high').length ?? 0
                        : scan.highCount;
                      const displayedMediumCount = isFindingsSearchActive
                        ? hits?.filter((f) => f.severity === 'medium').length ?? 0
                        : scan.mediumCount;
                      const displayedLowCount = isFindingsSearchActive
                        ? hits?.filter((f) => f.severity === 'low').length ?? 0
                        : scan.lowCount;
                      const displayedNonHitCount = isFindingsSearchActive
                        ? matchingNonHitCount
                        : scan.nonHitCount;
                      const displayedIgnoredCount = isFindingsSearchActive
                        ? matchingIgnoredCount
                        : (scan.ignoredCount ?? 0);
                      const deleteDisabledReason = scanning
                        ? ACTIVE_SCAN_DELETE_TOOLTIP
                        : clearing
                          ? CLEARING_HISTORY_DELETE_TOOLTIP
                          : null;

                      return (
                        <div key={scan.id}>
                          {/* Scan row header */}
                          {isConfirmingDelete ? (
                            <div className="px-6 py-4 bg-red-50 flex items-center justify-between gap-4">
                              <p className="text-sm text-red-800">
                                Delete this scan and its {scan.highCount + scan.mediumCount + scan.lowCount + scan.nonHitCount + (scan.ignoredCount ?? 0) + (scan.skippedCount ?? 0)} result{(scan.highCount + scan.mediumCount + scan.lowCount + scan.nonHitCount + (scan.ignoredCount ?? 0) + (scan.skippedCount ?? 0)) !== 1 ? 's' : ''}? This cannot be undone.
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
                    <div className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50 transition group">
                      {/* Expand toggle */}
                      <button
                        type="button"
                        onClick={() => {
                          if (isFindingsSearchActive) return;
                          toggleScanExpand(scan.id);
                        }}
                        className="flex items-center gap-4 flex-1 min-w-0 text-left"
                        aria-expanded={isExpanded}
                      >
                                {isExpanded
                                  ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                  : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                                <span className="text-sm font-semibold text-gray-500 flex-shrink-0">
                                  {formatScanDate(scan.startedAt)}
                                </span>
                                <span className="flex items-center gap-1.5 flex-wrap min-w-0">
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
                                    <span className="text-xs text-gray-400 italic">· cancelled</span>
                                  )}
                                  {scan.status === 'failed' && (
                                    <span className="text-xs text-red-400 italic">· failed</span>
                                  )}
                                </span>
                              </button>

                              {/* Delete button */}
                              {deleteDisabledReason ? (
                                <Tooltip content={deleteDisabledReason} align="end" triggerClassName="flex-shrink-0">
                                  <button
                                    type="button"
                                    aria-disabled="true"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                    }}
                                    className="inline-flex items-center justify-center p-1.5 rounded-md text-gray-300 opacity-40 cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </Tooltip>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setConfirmDeleteScanId(scan.id);
                                    setConfirmClear(false);
                                  }}
                                  className="flex-shrink-0 p-1.5 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed"
                                  aria-label="Delete scan"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          )}

                          {/* Expanded body */}
                          {isExpanded && (
                            <div className="border-t border-gray-100 px-4 sm:px-6 py-5 bg-gray-50">
                              {isLoading ? (
                                <div className="flex items-center justify-center py-8 gap-2 text-gray-400">
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

                                  {/* Real findings grouped by severity */}
                                  {!hits || hits.length === 0 ? (
                                    !isFindingsSearchActive && (
                                      <div className="flex flex-col items-center justify-center py-8 gap-2">
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
                                            onBookmarkUpdate={handleBookmarkUpdate}
                                            forceExpanded={isFindingsSearchActive}
                                            highlightQuery={activeHighlightQuery}
                                          />
                                        ))}
                                    </div>
                                  )}

                                  {/* Non-hits sub-section */}
                                  {displayedNonHitCount > 0 && (
                                    <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (isFindingsSearchActive) return;
                                          const next = !showNonHitsByScanId[scan.id];
                                          setShowNonHitsByScanId((prev) => ({ ...prev, [scan.id]: next }));
                                          if (next) loadScanNonHits(scan.id);
                                        }}
                                        className={cn(
                                          "w-full px-4 py-3 flex items-center gap-2 transition text-left",
                                          showNonHits ? "bg-gray-50 border-b border-gray-100" : "hover:bg-gray-50"
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
                                        <span className="text-xs text-gray-400">· classified as false positives by AI</span>
                                      </button>
                                      {showNonHits && (
                                        <div className="border-t border-gray-100 p-4 space-y-4">
                                          {!nonHits ? (
                                            <div className="flex items-center justify-center py-4 gap-2 text-gray-400">
                                              <Loader2 className="w-4 h-4 animate-spin" />
                                              <span className="text-sm">Loading…</span>
                                            </div>
                                          ) : (
                                            sortBySeverity(nonHits).map((finding) => (
                                              <FindingCard
                                                key={finding.id}
                                                finding={finding}
                                                highlightQuery={activeHighlightQuery}
                                                onIgnoreToggle={handleIgnoreToggle}
                                                onBookmarkUpdate={handleBookmarkUpdate}
                                              />
                                            ))
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* Ignored sub-section */}
                                  {displayedIgnoredCount > 0 && (
                                    <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (isFindingsSearchActive) return;
                                          const next = !showIgnoredByScanId[scan.id];
                                          setShowIgnoredByScanId((prev) => ({ ...prev, [scan.id]: next }));
                                          if (next) loadScanIgnored(scan.id);
                                        }}
                                        className={cn(
                                          "w-full px-4 py-3 flex items-center gap-2 transition text-left",
                                          showIgnored ? "bg-gray-50 border-b border-gray-100" : "hover:bg-gray-50"
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
                                        <div className="border-t border-gray-100 p-4 space-y-4">
                                          {!ignored ? (
                                            <div className="flex items-center justify-center py-4 gap-2 text-gray-400">
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
                                                onBookmarkUpdate={handleBookmarkUpdate}
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
              </div>
              {/* Brand-level ignored URLs panel */}
              {(isFindingsSearchActive ? visibleIgnoredFindings.length > 0 : allIgnoredFindings.length > 0) && (
                <div className="mt-6 bg-white rounded-2xl border border-gray-200 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => {
                      if (isFindingsSearchActive) return;
                      setShowAllIgnored((v) => !v);
                    }}
                    className={cn(
                      "w-full px-6 py-5 flex items-center gap-3 transition text-left bg-brand-50",
                      (isFindingsSearchActive || showAllIgnored) ? "border-b border-brand-100" : "hover:bg-brand-100"
                    )}
                    aria-expanded={isFindingsSearchActive || showAllIgnored}
                  >
                    {(isFindingsSearchActive || showAllIgnored)
                      ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                    <EyeOff className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <div>
                      <h2 className="text-base font-semibold text-gray-900">Ignored URLs</h2>
                      <p className="text-xs text-gray-500">
                        {(isFindingsSearchActive ? visibleIgnoredFindings.length : allIgnoredFindings.length)} URL{(isFindingsSearchActive ? visibleIgnoredFindings.length : allIgnoredFindings.length) !== 1 ? 's' : ''} manually dismissed · AI analysis will skip these in future scans
                      </p>
                    </div>
                  </button>
                  {(isFindingsSearchActive || showAllIgnored) && (
                    <div className="border-t border-gray-100 p-4 sm:p-5 space-y-4">
                      {visibleIgnoredFindings.map((finding) => (
                        <FindingCard
                          key={finding.id}
                          finding={finding}
                          highlightQuery={activeHighlightQuery}
                          onIgnoreToggle={handleIgnoreToggle}
                          onBookmarkUpdate={handleBookmarkUpdate}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
