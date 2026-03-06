'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  ArrowLeft, Play, AlertCircle, AlertTriangle, Info, Shield, Loader2,
  ChevronDown, ChevronRight, Pencil, Trash2, X, EyeOff,
} from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InfoTooltip } from '@/components/ui/tooltip';
import { cn, formatScanDate } from '@/lib/utils';
import type { ActorRunInfo, BrandProfile, FindingSummary, Scan, ScanSummary } from '@/lib/types';

const POLL_INTERVAL_MS = 5_000;

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
  high:   { variant: 'danger'  as const, label: 'High',   icon: AlertCircle,   headerBg: 'bg-red-50',   headerBorder: 'border-red-100',   hoverBg: 'hover:bg-red-50' },
  medium: { variant: 'warning' as const, label: 'Medium', icon: AlertTriangle, headerBg: 'bg-amber-50', headerBorder: 'border-amber-100', hoverBg: 'hover:bg-amber-50' },
  low:    { variant: 'success' as const, label: 'Low',    icon: Info,          headerBg: 'bg-green-50', headerBorder: 'border-green-100', hoverBg: 'hover:bg-green-50' },
};

function SeverityGroup({
  severity,
  findings,
  onIgnoreToggle,
}: {
  severity: 'high' | 'medium' | 'low';
  findings: FindingSummary[];
  onIgnoreToggle?: (finding: FindingSummary, isIgnored: boolean) => Promise<void>;
}) {
  const [isExpanded, setIsExpanded] = useState(severity === 'high');
  const [ignoringAll, setIgnoringAll] = useState(false);

  const { variant, label, icon: Icon, headerBg, headerBorder, hoverBg } = SEVERITY_GROUP_CONFIG[severity];

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
      <div className={cn("flex items-center transition border-b", isExpanded ? `${headerBg} ${headerBorder}` : `border-transparent ${hoverBg}`)}>
        <button
          type="button"
          onClick={() => setIsExpanded((v) => !v)}
          className="flex items-center gap-2 flex-1 px-4 py-3 text-left min-w-0"
          aria-expanded={isExpanded}
        >
          {isExpanded
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
      {isExpanded && (
        <div className="border-t border-gray-100 p-4 space-y-4">
          {findings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              onIgnoreToggle={onIgnoreToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
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
  const [allIgnoredFindings, setAllIgnoredFindings] = useState<FindingSummary[]>([]);
  const [showAllIgnored, setShowAllIgnored] = useState(false);
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

  async function loadScanFindings(scanId: string) {
    // Only loads hits — non-hits and ignored are lazy-loaded when those sections are first opened.
    if (scanFindings[scanId] !== undefined || loadingScanIds.includes(scanId)) return;

    setLoadingScanIds((prev) => [...prev, scanId]);
    try {
      const res = await fetch(`/api/brands/${brandId}/findings?scanId=${scanId}`, { credentials: 'same-origin' });
      if (res.ok) {
        const json = await res.json();
        setScanFindings((prev) => ({ ...prev, [scanId]: json.data ?? [] }));
      }
    } catch {
      // Non-critical
    } finally {
      setLoadingScanIds((prev) => prev.filter((id) => id !== scanId));
    }
  }

  async function loadScanNonHits(scanId: string) {
    if (scanNonHits[scanId] !== undefined) return;
    try {
      const res = await fetch(`/api/brands/${brandId}/findings?scanId=${scanId}&nonHitsOnly=true`, { credentials: 'same-origin' });
      if (res.ok) {
        const json = await res.json();
        setScanNonHits((prev) => ({ ...prev, [scanId]: json.data ?? [] }));
      }
    } catch {
      // Non-critical
    }
  }

  async function loadScanIgnored(scanId: string) {
    if (scanIgnored[scanId] !== undefined) return;
    try {
      const res = await fetch(`/api/brands/${brandId}/findings?scanId=${scanId}&ignoredOnly=true`, { credentials: 'same-origin' });
      if (res.ok) {
        const json = await res.json();
        setScanIgnored((prev) => ({ ...prev, [scanId]: json.data ?? [] }));
      }
    } catch {
      // Non-critical
    }
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
      if (scan && (scan.status === 'pending' || scan.status === 'running')) {
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
      void loadAllIgnoredFindings();

      try {
        const brandRes = await fetch(`/api/brands/${brandId}`, { credentials: 'same-origin' });

        if (!brandRes.ok) throw new Error('Brand not found');
        const brandJson = await brandRes.json();
        setBrand(brandJson.data);

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
          await fetchScans();
        } else if (scan.status === 'cancelled') {
          stopPolling();
          clearStoredScanId(brandId);
          setScanning(false);
          setCancelling(false);
          setActiveScanId(null);
          setLiveScanFindings([]);
          setActiveScan(null);
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
  const isDeepSearchActive = inFlightRuns.some((r) => (r.searchDepth ?? 0) > 0);
  const deepSearchCount = inFlightRuns.filter((r) => (r.searchDepth ?? 0) > 0).length;
  const skippedDuplicateCount = allRuns.reduce((sum, run) => sum + (run.skippedDuplicateCount ?? 0), 0);

  function getRunAnalysisCounts(run?: ActorRunInfo): { completed: number; total: number } | null {
    if (!run || run.status !== 'analysing') return null;
    const total = run.itemCount ?? 0;
    if (total <= 0) return null;
    const completed = Math.max(0, Math.min(total, run.analysedCount ?? 0));
    return { completed, total };
  }

  function withAnalysisCounts(inProgressLabel: string, finalisingLabel: string, run?: ActorRunInfo): string {
    const counts = getRunAnalysisCounts(run);
    if (!counts) return `${inProgressLabel}…`;
    if (counts.completed >= counts.total) {
      return `${finalisingLabel} (${counts.total}/${counts.total})…`;
    }
    return `${inProgressLabel} (${counts.completed}/${counts.total})…`;
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

  function renderDeepSearchQueryLabel(prefix: string, query: string, suffix = '…'): ReactNode {
    const displayQuery = formatDeepSearchQueryForDisplay(query);

    return (
      <>
        {prefix}
        {' '}
        <em>{displayQuery}</em>
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
    const progress = ` (${counts.completed >= counts.total ? counts.total : counts.completed}/${counts.total})…`;

    return renderDeepSearchQueryLabel(prefix, query, progress);
  }

  function getScanStatusLabel(): ReactNode {
    if (!activeRun) return 'Starting scan…';

    if (isDeepSearchActive) {
      const query = activeRun.searchQuery;
      switch (runStatus) {
        case 'fetching_dataset':
          return query
            ? renderDeepSearchQueryLabel('Fetching deeper results for', query)
            : `Fetching deeper results (${deepSearchCount} quer${deepSearchCount !== 1 ? 'ies' : 'y'})…`;
        case 'analysing':
          return query
            ? renderDeepSearchAnalysisLabel(query, activeRun)
            : withAnalysisCounts('Analysing deep search results with AI', 'Finalising deep search results AI analysis', activeRun);
        default:
          return deepSearchCount > 1
            ? `Investigating ${deepSearchCount} related queries…`
            : query
              ? renderDeepSearchQueryLabel('Investigating related query:', query)
              : 'Running deeper investigation…';
      }
    }

    switch (runStatus) {
      case 'fetching_dataset': return 'Fetching results from Apify…';
      case 'analysing': return withAnalysisCounts('Analysing results with AI', 'Finalising results with AI', activeRun);
      default: return 'Waiting for web search to complete…';
    }
  }

  function getSkippedDuplicateSubtext(): string | null {
    if (skippedDuplicateCount <= 0) return null;
    if (skippedDuplicateCount === 1) {
      return '1 result is being skipped because it duplicates previous findings.';
    }
    return `${skippedDuplicateCount} results are being skipped because they duplicate previous findings.`;
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
    if (allRuns.length === 0) return 10;

    const totalFraction =
      allRuns.reduce((sum, run) => sum + getRunProgressFraction(run), 0) / allRuns.length;

    // Leave visible headroom so late-discovered deep-search runs do not imply the
    // scan is effectively complete before the backend has finished all work.
    return Math.round(8 + 86 * totalFraction);
  }

  const progressScanKey = activeScanId ?? activeScan?.id ?? null;
  const rawOverallScanProgressPct = getRawOverallScanProgressPct();

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

  const totalFindings = scans.reduce((sum, s) => sum + s.highCount + s.mediumCount + s.lowCount, 0);
  const totalNonHits = scans.reduce((sum, s) => sum + s.nonHitCount, 0);
  const totalIgnored = scans.reduce((sum, s) => sum + (s.ignoredCount ?? 0), 0);
  const totalSkipped = scans.reduce((sum, s) => sum + (s.skippedCount ?? 0), 0);

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
                  </div>
                );
              })()}

              {/* Scan progress banner */}
              {scanning && (
                <div className="mb-6 bg-brand-50 border border-brand-200 rounded-xl px-5 py-4">
                  <div className="flex items-center justify-between gap-4 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Loader2 className="w-4 h-4 text-brand-600 animate-spin flex-shrink-0" />
                      <span className="text-sm font-medium text-brand-800 truncate">
                        {cancelling ? 'Cancelling scan…' : getScanStatusLabel()}
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
                  {!cancelling && getSkippedDuplicateSubtext() && (
                    <p className="mt-2 text-xs text-brand-700/80">
                      {getSkippedDuplicateSubtext()}
                    </p>
                  )}
                </div>
              )}


              {/* Findings panel */}
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                {/* Panel header */}
                <div className="px-6 py-5 border-b border-brand-100 flex items-center justify-between gap-4 bg-brand-50">
                  <div className="flex items-center gap-3">
                    <div>
                      <h2 className="text-base font-semibold text-gray-900">Findings</h2>
                      <p className="text-xs text-gray-500">
                        {scans.length === 0
                          ? 'No scans yet'
                          : `${scans.length} scan${scans.length !== 1 ? 's' : ''} · ${totalFindings} finding${totalFindings !== 1 ? 's' : ''} detected`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(totalFindings > 0 || totalNonHits > 0) && !confirmClear && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmClear(true)}
                        disabled={scanning || clearing}
                        className="text-gray-400 hover:text-red-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Clear history
                      </Button>
                    )}
                    <Button size="sm" onClick={triggerScan} loading={scanning} disabled={scanning || clearing || confirmClear}>
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

                {/* Scan result sets */}
                <div className="divide-y divide-gray-100">
                  {/* Live findings — shown while a scan is in progress */}
                  {scanning && (
                    <div className="bg-brand-50/40">
                      {/* Live row header */}
                      <div className="flex items-center gap-4 px-6 py-4">
                        <div className="flex items-center gap-3 flex-1 min-w-0 text-left">
                          <Loader2 className="w-4 h-4 text-brand-600 animate-spin flex-shrink-0" />
                          <span className="text-sm font-semibold text-brand-700 flex-shrink-0">
                            Scan in progress
                          </span>
                          {liveScanFindings.length > 0 && (
                            <SeverityPills
                              high={liveScanFindings.filter((f) => f.severity === 'high').length}
                              medium={liveScanFindings.filter((f) => f.severity === 'medium').length}
                              low={liveScanFindings.filter((f) => f.severity === 'low').length}
                            />
                          )}
                        </div>
                      </div>
                      {/* Live row body */}
                      <div className="border-t border-brand-100 px-4 sm:px-6 py-5 bg-brand-50/30">
                        {liveScanFindings.length === 0 ? (
                          <div className="flex items-center justify-center py-8 gap-2 text-gray-400">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span className="text-sm">Waiting for first results…</span>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {(['high', 'medium', 'low'] as const)
                              .filter((sev) => liveScanFindings.some((f) => f.severity === sev))
                              .map((sev) => (
                                <SeverityGroup
                                  key={`live-${sev}`}
                                  severity={sev}
                                  findings={liveScanFindings.filter((f) => f.severity === sev)}
                                />
                              ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {scans.length === 0 && !scanning ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center">
                        <Shield className="w-5 h-5 text-brand-600" />
                      </div>
                      <p className="text-sm text-gray-500">No findings yet. Run a scan to start monitoring.</p>
                    </div>
                  ) : (
                    scans.map((scan) => {
                      const isExpanded = expandedScanIds.includes(scan.id);
                      const isLoading = loadingScanIds.includes(scan.id);
                      const hits = scanFindings[scan.id];
                      const nonHits = scanNonHits[scan.id];
                      const ignored = scanIgnored[scan.id];
                      const showNonHits = showNonHitsByScanId[scan.id] ?? false;
                      const showIgnored = showIgnoredByScanId[scan.id] ?? false;
                      const isConfirmingDelete = confirmDeleteScanId === scan.id;
                      const isDeleting = deletingScanId === scan.id;
                      const hasFindings = scan.highCount + scan.mediumCount + scan.lowCount > 0;

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
                        onClick={() => toggleScanExpand(scan.id)}
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
                                      high={scan.highCount}
                                      medium={scan.mediumCount}
                                      low={scan.lowCount}
                                    />
                                  ) : (
                                    <span className="text-xs text-gray-400">No findings</span>
                                  )}
                                  {scan.nonHitCount > 0 && (
                                    <span className="text-xs text-gray-400">
                                      · {scan.nonHitCount} non-hit{scan.nonHitCount !== 1 ? 's' : ''}
                                    </span>
                                  )}
                                  {(scan.ignoredCount ?? 0) > 0 && (
                                    <span className="text-xs text-gray-400">
                                      · {scan.ignoredCount} ignored
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
                              <button
                                type="button"
                                onClick={() => {
                                  setConfirmDeleteScanId(scan.id);
                                  setConfirmClear(false);
                                }}
                                disabled={scanning || clearing}
                                className="flex-shrink-0 p-1.5 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed"
                                aria-label="Delete scan"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
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
                                  {/* Real findings grouped by severity */}
                                  {!hits || hits.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-8 gap-2">
                                      <Shield className="w-5 h-5 text-brand-300" />
                                      <p className="text-sm text-gray-400">
                                        {scan.skippedCount > 0
                                          ? 'No new findings detected in this scan.'
                                          : 'No findings detected in this scan.'}
                                      </p>
                                    </div>
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
                                          />
                                        ))}
                                    </div>
                                  )}

                                  {/* Non-hits sub-section */}
                                  {scan.nonHitCount > 0 && (
                                    <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
                                      <button
                                        type="button"
                                        onClick={() => {
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
                                            ({nonHits ? nonHits.length : scan.nonHitCount})
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
                                                onIgnoreToggle={handleIgnoreToggle}
                                              />
                                            ))
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* Ignored sub-section */}
                                  {(scan.ignoredCount ?? 0) > 0 && (
                                    <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
                                      <button
                                        type="button"
                                        onClick={() => {
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
                                            ({ignored ? ignored.length : (scan.ignoredCount ?? 0)})
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
                                                onIgnoreToggle={handleIgnoreToggle}
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
              {allIgnoredFindings.length > 0 && (
                <div className="mt-6 bg-white rounded-2xl border border-gray-200 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowAllIgnored((v) => !v)}
                    className={cn(
                      "w-full px-6 py-5 flex items-center gap-3 transition text-left bg-brand-50",
                      showAllIgnored ? "border-b border-brand-100" : "hover:bg-brand-100"
                    )}
                    aria-expanded={showAllIgnored}
                  >
                    {showAllIgnored
                      ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                    <EyeOff className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <div>
                      <h2 className="text-base font-semibold text-gray-900">Ignored URLs</h2>
                      <p className="text-xs text-gray-500">
                        {allIgnoredFindings.length} URL{allIgnoredFindings.length !== 1 ? 's' : ''} manually dismissed · AI analysis will skip these in future scans
                      </p>
                    </div>
                  </button>
                  {showAllIgnored && (
                    <div className="border-t border-gray-100 p-4 sm:p-5 space-y-4">
                      {allIgnoredFindings.map((finding) => (
                        <FindingCard
                          key={finding.id}
                          finding={finding}
                          onIgnoreToggle={handleIgnoreToggle}
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
