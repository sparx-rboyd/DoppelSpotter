'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, Play, AlertCircle, Shield, CheckCircle2, Loader2, ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatDate } from '@/lib/utils';
import type { BrandProfile, Finding, Scan } from '@/lib/types';

const POLL_INTERVAL_MS = 5_000;

export default function BrandDetailPage() {
  const { brandId } = useParams<{ brandId: string }>();

  const [brand, setBrand] = useState<BrandProfile | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [nonHits, setNonHits] = useState<Finding[]>([]);
  const [showNonHits, setShowNonHits] = useState(false);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [activeScan, setActiveScan] = useState<Scan | null>(null);
  const [scanComplete, setScanComplete] = useState(false);
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

  // Fetch brand profile, findings, and non-hits
  useEffect(() => {
    async function fetchData() {
      setError('');
      setLoading(true);
      try {
        const [brandRes, findingsRes, nonHitsRes] = await Promise.all([
          fetch(`/api/brands/${brandId}`, { credentials: 'same-origin' }),
          fetch(`/api/brands/${brandId}/findings`, { credentials: 'same-origin' }),
          fetch(`/api/brands/${brandId}/findings?nonHitsOnly=true`, { credentials: 'same-origin' }),
        ]);

        if (!brandRes.ok) throw new Error('Brand not found');
        const brandJson = await brandRes.json();
        setBrand(brandJson.data);

        if (findingsRes.ok) {
          const findingsJson = await findingsRes.json();
          setFindings(findingsJson.data ?? []);
        }

        if (nonHitsRes.ok) {
          const nonHitsJson = await nonHitsRes.json();
          setNonHits(nonHitsJson.data ?? []);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
    return () => stopPolling();
  }, [brandId]);

  async function refreshFindings() {
    try {
      const [findingsRes, nonHitsRes] = await Promise.all([
        fetch(`/api/brands/${brandId}/findings`, { credentials: 'same-origin' }),
        fetch(`/api/brands/${brandId}/findings?nonHitsOnly=true`, { credentials: 'same-origin' }),
      ]);
      if (findingsRes.ok) {
        const json = await findingsRes.json();
        setFindings(json.data ?? []);
      }
      if (nonHitsRes.ok) {
        const json = await nonHitsRes.json();
        setNonHits(json.data ?? []);
      }
    } catch {
      // Non-critical — findings will just not refresh
    }
  }

  async function triggerScan() {
    setScanning(true);
    setError('');
    setScanComplete(false);
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

      // Begin polling for scan completion
      pollRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/scan?scanId=${scanId}`, { credentials: 'same-origin' });
          if (!pollRes.ok) return;

          const pollJson = await pollRes.json();
          const scan = pollJson.data as Scan;
          setActiveScan(scan);

          if (scan.status === 'completed') {
            stopPolling();
            setScanning(false);
            setScanComplete(true);
            await refreshFindings();
          } else if (scan.status === 'failed') {
            stopPolling();
            setScanning(false);
            setError(scan.errorMessage ?? 'Scan failed');
            setActiveScan(null);
          }
        } catch {
          // Transient poll failure — keep trying
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setScanning(false);
      setError(err instanceof Error ? err.message : 'Scan failed');
    }
  }

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
      setFindings([]);
      setNonHits([]);
      setScanComplete(false);
      setActiveScan(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear history');
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  const highCount = findings.filter((f) => f.severity === 'high').length;

  // All actor runs for the active scan
  const allRuns = activeScan?.actorRuns ? Object.values(activeScan.actorRuns) : [];
  const inFlightRuns = allRuns.filter(
    (r) => r.status === 'running' || r.status === 'fetching_dataset' || r.status === 'analysing',
  );

  // Prefer showing a deep-search run's status when one is active; fall back to any in-flight run
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
      case 'analysing':
        return itemCount > 0
          ? `Analysing with AI (${analysedCount} / ${itemCount})…`
          : 'Analysing results with AI…';
      default: return 'Waiting for web search to complete…';
    }
  }

  function getScanProgressPct(): number {
    if (!activeRun) return 0;

    if (isDeepSearchActive) {
      // Deep-search phase: 70–98 %
      if (runStatus === 'fetching_dataset') return 72;
      if (runStatus === 'analysing') {
        if (itemCount === 0) return 76;
        return Math.round(76 + 22 * (analysedCount / itemCount));
      }
      return 70; // 'running'
    }

    if (runStatus === 'fetching_dataset') return 35;
    if (runStatus === 'analysing') {
      if (itemCount === 0) return 40;
      // Initial analysis caps at 65 % to leave headroom for the deep-search phase
      return Math.round(40 + 25 * (analysedCount / itemCount));
    }
    return 10; // 'running' — actor executing on Apify
  }

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
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Keywords</p>
                    <div className="flex flex-wrap gap-1.5">
                      {brand.keywords.length > 0
                        ? brand.keywords.map((kw) => <Badge key={kw} variant="brand">{kw}</Badge>)
                        : <span className="text-sm text-gray-400">None set</span>}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Official Domains</p>
                    <div className="flex flex-wrap gap-1.5">
                      {brand.officialDomains.length > 0
                        ? brand.officialDomains.map((d) => <Badge key={d} variant="default">{d}</Badge>)
                        : <span className="text-sm text-gray-400">None set</span>}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Watch Words</p>
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
                        {getScanStatusLabel()}
                      </span>
                      {isDeepSearchActive && (
                        <span className="flex-shrink-0 inline-flex items-center gap-1 bg-brand-100 text-brand-700 text-xs font-medium px-2 py-0.5 rounded-full">
                          Deep search
                        </span>
                      )}
                    </div>
                    {runStatus === 'analysing' && itemCount > 0 && (
                      <span className="text-xs text-brand-600 tabular-nums flex-shrink-0">
                        {analysedCount} / {itemCount}
                      </span>
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
                    Scan complete — {findings.length} finding{findings.length !== 1 ? 's' : ''} detected
                    {nonHits.length > 0 && `, ${nonHits.length} non-hit${nonHits.length !== 1 ? 's' : ''} filtered`}
                  </span>
                </div>
              )}

              {/* Findings panel */}
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div>
                      <h2 className="text-base font-semibold text-gray-900">Findings</h2>
                      <p className="text-xs text-gray-500">{findings.length} finding{findings.length !== 1 ? 's' : ''} detected</p>
                    </div>
                    {highCount > 0 && (
                      <Badge variant="danger">
                        <AlertCircle className="w-3 h-3" />
                        {highCount} High Risk
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {(findings.length > 0 || nonHits.length > 0) && !confirmClear && (
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

                {/* Inline clear confirmation */}
                {confirmClear && (
                  <div className="px-5 py-4 bg-red-50 border-b border-red-100 flex items-center justify-between gap-4">
                    <p className="text-sm text-red-800">
                      Permanently delete all {findings.length + nonHits.length} finding{findings.length + nonHits.length !== 1 ? 's' : ''} and scan history? This cannot be undone.
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

                <div className="p-4 sm:p-6">
                  {findings.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center">
                        <Shield className="w-5 h-5 text-gray-400" />
                      </div>
                      <p className="text-sm text-gray-500">No findings yet. Run a scan to start monitoring.</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {findings.map((finding) => (
                        <FindingCard key={finding.id} finding={finding} />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Non-hits / false positives (collapsible) */}
              <div className="mt-4 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowNonHits((v) => !v)}
                  className="w-full px-5 py-4 flex items-center justify-between gap-4 hover:bg-gray-50 transition text-left"
                >
                  <div className="flex items-center gap-2">
                    {showNonHits ? (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    )}
                    <div>
                      <h2 className="text-base font-semibold text-gray-500">
                        Non-hits
                        {nonHits.length > 0 && (
                          <span className="ml-2 text-xs font-normal text-gray-400">({nonHits.length})</span>
                        )}
                      </h2>
                      <p className="text-xs text-gray-400">
                        Results the LLM classified as false positives
                      </p>
                    </div>
                  </div>
                </button>

                {showNonHits && (
                  <div className="border-t border-gray-100 p-4 sm:p-6">
                    {nonHits.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 gap-2">
                        <p className="text-sm text-gray-400">No non-hits recorded yet.</p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {nonHits.map((finding) => (
                          <FindingCard key={finding.id} finding={finding} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
