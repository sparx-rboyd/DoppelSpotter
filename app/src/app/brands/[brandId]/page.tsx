'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  ArrowLeft, Play, AlertCircle, AlertTriangle, Info, Shield, CheckCircle2, Loader2,
  ChevronDown, ChevronRight, Pencil, Trash2, X, EyeOff,
} from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/tooltip';
import { formatDate, formatScanDate } from '@/lib/utils';
import type { BrandProfile, Finding, Scan, ScanSummary } from '@/lib/types';

const POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// localStorage helpers — persist active scan ID across page reloads
// ---------------------------------------------------------------------------

function scanStorageKey(brandId: string) {
  return `doppelspotter:scan:${brandId}`;
}

function getStoredScanId(brandId: string): string | null {
  try {
    return localStorage.getItem(scanStorageKey(brandId));
  } catch {
    return null;
  }
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
    <span className="flex items-center gap-1.5">
      {high > 0 && (
        <Badge variant="danger">
          <AlertCircle className="w-3 h-3" />
          {high} High
        </Badge>
      )}
      {medium > 0 && (
        <Badge variant="warning">
          <AlertTriangle className="w-3 h-3" />
          {medium} Medium
        </Badge>
      )}
      {low > 0 && (
        <Badge variant="success">
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
  high:   { variant: 'danger'  as const, label: 'High',   icon: AlertCircle },
  medium: { variant: 'warning' as const, label: 'Medium', icon: AlertTriangle },
  low:    { variant: 'success' as const, label: 'Low',    icon: Info },
};

function SeverityGroup({
  severity,
  findings,
  onIgnoreToggle,
}: {
  severity: 'high' | 'medium' | 'low';
  findings: Finding[];
  onIgnoreToggle: (finding: Finding, isIgnored: boolean) => Promise<void>;
}) {
  const [isExpanded, setIsExpanded] = useState(severity === 'high');
  const [ignoringAll, setIgnoringAll] = useState(false);

  const { variant, label, icon: Icon } = SEVERITY_GROUP_CONFIG[severity];

  async function handleIgnoreAll(e: React.MouseEvent) {
    e.stopPropagation();
    if (ignoringAll) return;
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
      <div className="flex items-center hover:bg-gray-50 transition">
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
            <Icon className="w-3 h-3" />
            {label}
          </Badge>
          <span className="text-xs text-gray-500">
            {findings.length} finding{findings.length !== 1 ? 's' : ''}
          </span>
        </button>
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
  const [scanFindings, setScanFindings] = useState<Record<string, Finding[]>>({});
  const [scanNonHits, setScanNonHits] = useState<Record<string, Finding[]>>({});
  const [scanIgnored, setScanIgnored] = useState<Record<string, Finding[]>>({});
  const [loadingScanIds, setLoadingScanIds] = useState<string[]>([]);
  const [showNonHitsByScanId, setShowNonHitsByScanId] = useState<Record<string, boolean>>({});
  const [showIgnoredByScanId, setShowIgnoredByScanId] = useState<Record<string, boolean>>({});
  const [allIgnoredFindings, setAllIgnoredFindings] = useState<Finding[]>([]);
  const [showAllIgnored, setShowAllIgnored] = useState(false);
  const [confirmDeleteScanId, setConfirmDeleteScanId] = useState<string | null>(null);
  const [deletingScanId, setDeletingScanId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [activeScan, setActiveScan] = useState<Scan | null>(null);
  const [scanComplete, setScanComplete] = useState(false);
  const [scanCancelled, setScanCancelled] = useState(false);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Fetch scans list and auto-expand + pre-load the most recent scan
  // ---------------------------------------------------------------------------

  async function fetchScans(autoExpandScanId?: string) {
    try {
      const res = await fetch(`/api/brands/${brandId}/scans`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const json = await res.json();
      const newScans: ScanSummary[] = json.data ?? [];
      setScans(newScans);

      const targetId = autoExpandScanId ?? newScans[0]?.id;
      if (targetId) {
        setExpandedScanIds((prev) => (prev.includes(targetId) ? prev : [targetId, ...prev]));
        loadScanFindings(targetId);
      }
    } catch {
      // Non-critical
    }
  }

  async function loadScanFindings(scanId: string) {
    // Skip if already cached or already loading
    if (scanFindings[scanId] !== undefined || loadingScanIds.includes(scanId)) return;

    setLoadingScanIds((prev) => [...prev, scanId]);
    try {
      const [hitsRes, nonHitsRes, ignoredRes] = await Promise.all([
        fetch(`/api/brands/${brandId}/findings?scanId=${scanId}`, { credentials: 'same-origin' }),
        fetch(`/api/brands/${brandId}/findings?scanId=${scanId}&nonHitsOnly=true`, { credentials: 'same-origin' }),
        fetch(`/api/brands/${brandId}/findings?scanId=${scanId}&ignoredOnly=true`, { credentials: 'same-origin' }),
      ]);
      if (hitsRes.ok) {
        const json = await hitsRes.json();
        setScanFindings((prev) => ({ ...prev, [scanId]: json.data ?? [] }));
      }
      if (nonHitsRes.ok) {
        const json = await nonHitsRes.json();
        setScanNonHits((prev) => ({ ...prev, [scanId]: json.data ?? [] }));
      }
      if (ignoredRes.ok) {
        const json = await ignoredRes.json();
        setScanIgnored((prev) => ({ ...prev, [scanId]: json.data ?? [] }));
      }
    } catch {
      // Non-critical
    } finally {
      setLoadingScanIds((prev) => prev.filter((id) => id !== scanId));
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

  // ---------------------------------------------------------------------------
  // Ignore / un-ignore a finding
  // ---------------------------------------------------------------------------

  async function handleIgnoreToggle(triggerFinding: Finding, isIgnored: boolean) {
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
      const movingFromHits: Record<string, Finding[]> = {};
      const movingFromIgnored: Record<string, Finding[]> = {};

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
        const updated: Record<string, Finding[]> = {};
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
            updated[sId] = [...moved, ...(prev[sId] ?? []).filter((f) => f.url !== url)];
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
    let targetFinding: Finding | undefined;
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

    const updatedFinding: Finding = { ...targetFinding, isIgnored };

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
      setScanIgnored((prev) => ({
        ...prev,
        [targetScanId!]: [updatedFinding, ...(prev[targetScanId!] ?? [])],
      }));
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

        // Fetch scans list (findings lazy-loaded on expand)
        await fetchScans();

        // Resume scan progress banner if a scan was in flight when the page was last loaded
        const storedScanId = getStoredScanId(brandId);
        if (storedScanId) {
          const scanRes = await fetch(`/api/scan?scanId=${storedScanId}`, { credentials: 'same-origin' });
          if (scanRes.ok) {
            const scanJson = await scanRes.json();
            const scan = scanJson.data as Scan;
            if (scan.status === 'pending' || scan.status === 'running') {
              setScanning(true);
              setActiveScanId(storedScanId);
              setActiveScan(scan);
              startPolling(storedScanId);
            } else {
              clearStoredScanId(brandId);
              if (scan.status === 'cancelled') {
                setScanCancelled(true);
              }
            }
          } else {
            clearStoredScanId(brandId);
          }
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
          setScanning(false);
          setCancelling(false);
          setActiveScanId(null);
          setScanComplete(true);
          // Refresh scans list; the completed scan becomes the newest entry and auto-expands
          await fetchScans(scanId);
        } else if (scan.status === 'failed') {
          stopPolling();
          clearStoredScanId(brandId);
          setScanning(false);
          setCancelling(false);
          setActiveScanId(null);
          setError(scan.errorMessage ?? 'Scan failed');
          setActiveScan(null);
          await fetchScans();
        } else if (scan.status === 'cancelled') {
          stopPolling();
          clearStoredScanId(brandId);
          setScanning(false);
          setCancelling(false);
          setActiveScanId(null);
          setScanCancelled(true);
          setActiveScan(null);
          await fetchScans();
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
    setScanComplete(false);
    setScanCancelled(false);
    setActiveScanId(null);
    setActiveScan(null);

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ brandId }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'Failed to start scan');
      }

      const json = await res.json();
      const scanId: string = json.data.scanId;

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
      setScanComplete(false);
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
  const analysedCount = activeRun?.analysedCount ?? 0;
  const itemCount = activeRun?.itemCount ?? 0;
  const isDeepSearchActive = inFlightRuns.some((r) => (r.searchDepth ?? 0) > 0);
  const deepSearchCount = inFlightRuns.filter((r) => (r.searchDepth ?? 0) > 0).length;

  function getScanStatusLabel(): string {
    if (!activeRun) return 'Starting scan…';

    if (isDeepSearchActive) {
      const query = activeRun.searchQuery;
      switch (runStatus) {
        case 'fetching_dataset':
          return query
            ? `Fetching deeper results for "${query}"…`
            : `Fetching deeper results (${deepSearchCount} quer${deepSearchCount !== 1 ? 'ies' : 'y'})…`;
        case 'analysing':
          return query
            ? `Analysing deeper results for "${query}"…`
            : `Analysing deeper results with AI…`;
        default:
          return deepSearchCount > 1
            ? `Investigating ${deepSearchCount} related queries…`
            : query
              ? `Investigating related query: "${query}"…`
              : 'Running deeper investigation…';
      }
    }

    switch (runStatus) {
      case 'fetching_dataset': return 'Fetching results from Apify…';
      case 'analysing': return 'Analysing results with AI…';
      default: return 'Waiting for web search to complete…';
    }
  }

  function getScanProgressPct(): number {
    if (!activeRun) return 0;

    if (isDeepSearchActive) {
      if (runStatus === 'fetching_dataset') return 72;
      if (runStatus === 'analysing') {
        if (itemCount === 0) return 76;
        return Math.round(76 + 22 * (analysedCount / itemCount));
      }
      return 70;
    }

    if (runStatus === 'fetching_dataset') return 35;
    if (runStatus === 'analysing') {
      if (itemCount === 0) return 40;
      return Math.round(40 + 25 * (analysedCount / itemCount));
    }
    return 10;
  }

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------

  const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
  function sortBySeverity(items: Finding[]) {
    return [...items].sort(
      (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
    );
  }

  const totalFindings = scans.reduce((sum, s) => sum + s.highCount + s.mediumCount + s.lowCount, 0);
  const totalNonHits = scans.reduce((sum, s) => sum + s.nonHitCount, 0);
  const totalIgnored = scans.reduce((sum, s) => sum + (s.ignoredCount ?? 0), 0);
  const globalHighCount = scans.reduce((sum, s) => sum + s.highCount, 0);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AuthGuard>
      <Navbar />
      <main className="pt-16 min-h-screen bg-gray-50/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">

          {/* Back link */}
          <div className="flex items-center justify-between gap-3 mb-8">
            <div className="flex items-center gap-3">
              <Link href="/brands" className="text-gray-500 hover:text-gray-900 transition">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              {brand && (
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">{brand.name}</h1>
                  <p className="text-sm text-gray-500 mt-0.5">Brand profile · created {formatDate(brand.createdAt)}</p>
                </div>
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
              <div className="grid sm:grid-cols-3 gap-4 mb-8">
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      Keywords
                      <InfoTooltip content="The words associated with your brand that you want to protect and monitor (e.g. your trademarks). Scans will search for these keywords." />
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {brand.keywords.length > 0
                        ? brand.keywords.map((kw) => <Badge key={kw} variant="brand">{kw}</Badge>)
                        : <span className="text-sm text-gray-400">None set</span>}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      Official Domains
                      <InfoTooltip content="Domains that you own, so that the AI analysis knows not to flag them." />
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {brand.officialDomains.length > 0
                        ? brand.officialDomains.map((d) => <Badge key={d} variant="default">{d}</Badge>)
                        : <span className="text-sm text-gray-400">None set</span>}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      Watch Words
                      <InfoTooltip content="Words that you don't want to be associated with your brand. Scans won't search for these words, but if they appear in scan results the AI analysis will treat the results with more caution." />
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {(brand.watchWords ?? []).length > 0
                        ? (brand.watchWords ?? []).map((w) => <Badge key={w} variant="warning">{w}</Badge>)
                        : <span className="text-sm text-gray-400">None set</span>}
                    </div>
                  </CardContent>
                </Card>
              </div>

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
                        variant="ghost"
                        size="sm"
                        onClick={cancelScan}
                        className="flex-shrink-0 text-brand-600 hover:text-red-600 hover:bg-red-50"
                      >
                        <X className="w-3.5 h-3.5" />
                        Cancel
                      </Button>
                    )}
                  </div>
                  <div className="h-1.5 bg-brand-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-600 rounded-full transition-all duration-500"
                      style={{ width: `${getScanProgressPct()}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Scan complete banner */}
              {scanComplete && !scanning && (
                <div className="mb-6 bg-green-50 border border-green-200 rounded-xl px-5 py-4 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <span className="text-sm font-medium text-green-800">
                    Scan complete — {totalFindings} finding{totalFindings !== 1 ? 's' : ''} detected
                    {totalNonHits > 0 && `, ${totalNonHits} non-hit${totalNonHits !== 1 ? 's' : ''} filtered`}
                  </span>
                </div>
              )}
              {/* Scan cancelled banner */}
              {scanCancelled && !scanning && (
                <div className="mb-6 bg-gray-50 border border-gray-200 rounded-xl px-5 py-4 flex items-center gap-2">
                  <X className="w-4 h-4 text-gray-400" />
                  <span className="text-sm font-medium text-gray-600">
                    Scan cancelled
                    {totalFindings > 0 && ` — ${totalFindings} finding${totalFindings !== 1 ? 's' : ''} from previous scans`}
                  </span>
                </div>
              )}

              {/* Findings panel */}
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                {/* Panel header */}
                <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div>
                      <h2 className="text-base font-semibold text-gray-900">Findings</h2>
                      <p className="text-xs text-gray-500">
                        {scans.length === 0
                          ? 'No scans yet'
                          : `${scans.length} scan${scans.length !== 1 ? 's' : ''} · ${totalFindings} finding${totalFindings !== 1 ? 's' : ''} detected`}
                      </p>
                    </div>
                    {globalHighCount > 0 && (
                      <Badge variant="danger">
                        <AlertCircle className="w-3 h-3" />
                        {globalHighCount} High Risk
                      </Badge>
                    )}
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
                  <div className="px-5 py-4 bg-red-50 border-b border-red-100 flex items-center justify-between gap-4">
                    <p className="text-sm text-red-800">
                      Permanently delete all {totalFindings + totalNonHits + totalIgnored} finding{(totalFindings + totalNonHits + totalIgnored) !== 1 ? 's' : ''} and scan history? This cannot be undone.
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
                  {scans.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center">
                        <Shield className="w-5 h-5 text-gray-400" />
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
                            <div className="px-5 py-3.5 bg-red-50 flex items-center justify-between gap-4">
                              <p className="text-sm text-red-800">
                                Delete this scan and its {scan.highCount + scan.mediumCount + scan.lowCount + scan.nonHitCount + (scan.ignoredCount ?? 0)} result{(scan.highCount + scan.mediumCount + scan.lowCount + scan.nonHitCount + (scan.ignoredCount ?? 0)) !== 1 ? 's' : ''}? This cannot be undone.
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
                            <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50/70 transition group">
                              {/* Expand toggle */}
                              <button
                                type="button"
                                onClick={() => toggleScanExpand(scan.id)}
                                className="flex items-center gap-3 flex-1 min-w-0 text-left"
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
                            <div className="border-t border-gray-100 px-4 sm:px-6 py-5 bg-gray-50/30">
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
                                      <Shield className="w-5 h-5 text-gray-300" />
                                      <p className="text-sm text-gray-400">No findings detected in this scan.</p>
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
                                  {nonHits && nonHits.length > 0 && (
                                    <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setShowNonHitsByScanId((prev) => ({ ...prev, [scan.id]: !prev[scan.id] }))
                                        }
                                        className="w-full px-4 py-3 flex items-center gap-2 hover:bg-gray-50 transition text-left"
                                      >
                                        {showNonHits
                                          ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                          : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                                        <span className="text-sm font-medium text-gray-500">
                                          Non-hits
                                          <span className="ml-1.5 text-xs font-normal text-gray-400">
                                            ({nonHits.length})
                                          </span>
                                        </span>
                                        <span className="text-xs text-gray-400">· classified as false positives by AI</span>
                                      </button>
                                      {showNonHits && (
                                        <div className="border-t border-gray-100 p-4 space-y-4">
                                          {sortBySeverity(nonHits).map((finding) => (
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

                                  {/* Ignored sub-section */}
                                  {ignored && ignored.length > 0 && (
                                    <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setShowIgnoredByScanId((prev) => ({ ...prev, [scan.id]: !prev[scan.id] }))
                                        }
                                        className="w-full px-4 py-3 flex items-center gap-2 hover:bg-gray-50 transition text-left"
                                      >
                                        {showIgnored
                                          ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                          : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                                        <EyeOff className="w-3.5 h-3.5 text-gray-400" />
                                        <span className="text-sm font-medium text-gray-500">
                                          Ignored
                                          <span className="ml-1.5 text-xs font-normal text-gray-400">
                                            ({ignored.length})
                                          </span>
                                        </span>
                                        <span className="text-xs text-gray-400">· manually dismissed</span>
                                      </button>
                                      {showIgnored && (
                                        <div className="border-t border-gray-100 p-4 space-y-4">
                                          {ignored.map((finding) => (
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
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              {/* Brand-level ignored URLs panel */}
              {allIgnoredFindings.length > 0 && (
                <div className="mt-6 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowAllIgnored((v) => !v)}
                    className="w-full px-5 py-4 flex items-center gap-3 hover:bg-gray-50 transition text-left"
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
