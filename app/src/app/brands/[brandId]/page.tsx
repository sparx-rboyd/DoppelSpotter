'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, Play, AlertCircle, Shield, CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/firebase/auth-context';
import { formatDate } from '@/lib/utils';
import type { BrandProfile, Finding, Scan } from '@/lib/types';

const POLL_INTERVAL_MS = 5_000;

export default function BrandDetailPage() {
  const { brandId } = useParams<{ brandId: string }>();
  const { getIdToken } = useAuth();

  const [brand, setBrand] = useState<BrandProfile | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [activeScan, setActiveScan] = useState<Scan | null>(null);
  const [scanComplete, setScanComplete] = useState(false);
  const [error, setError] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Fetch brand profile and initial findings
  useEffect(() => {
    async function fetchData() {
      setError('');
      setLoading(true);
      try {
        const token = await getIdToken();
        const [brandRes, findingsRes] = await Promise.all([
          fetch(`/api/brands/${brandId}`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`/api/brands/${brandId}/findings`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);

        if (!brandRes.ok) throw new Error('Brand not found');
        const brandJson = await brandRes.json();
        setBrand(brandJson.data);

        if (findingsRes.ok) {
          const findingsJson = await findingsRes.json();
          setFindings(findingsJson.data ?? []);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
    return () => stopPolling();
  }, [brandId, getIdToken]);

  async function refreshFindings() {
    try {
      const token = await getIdToken();
      const res = await fetch(`/api/brands/${brandId}/findings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        setFindings(json.data ?? []);
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
      const token = await getIdToken();
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
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
          const pollToken = await getIdToken();
          const pollRes = await fetch(`/api/scan?scanId=${scanId}`, {
            headers: { Authorization: `Bearer ${pollToken}` },
          });
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

  const highCount = findings.filter((f) => f.severity === 'high').length;
  const completedRuns = activeScan?.completedRunCount ?? 0;
  const totalRuns = activeScan?.actorRunIds?.length ?? activeScan?.actorIds?.length ?? 0;
  const progressPct = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;

  return (
    <AuthGuard>
      <Navbar />
      <main className="pt-16 min-h-screen bg-gray-50/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">

          {/* Back link */}
          <div className="flex items-center gap-3 mb-8">
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
              <div className="grid sm:grid-cols-2 gap-4 mb-8">
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
              </div>

              {/* Scan progress banner */}
              {scanning && activeScan && (
                <div className="mb-6 bg-brand-50 border border-brand-200 rounded-xl px-5 py-4">
                  <div className="flex items-center justify-between gap-4 mb-3">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 text-brand-600 animate-spin" />
                      <span className="text-sm font-medium text-brand-800">
                        Scanning across {totalRuns} source{totalRuns !== 1 ? 's' : ''}…
                      </span>
                    </div>
                    <span className="text-xs text-brand-600 tabular-nums">
                      {completedRuns} / {totalRuns} completed
                    </span>
                  </div>
                  <div className="h-1.5 bg-brand-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-600 rounded-full transition-all duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Scan in progress but no active scan data yet (just started) */}
              {scanning && !activeScan && (
                <div className="mb-6 bg-brand-50 border border-brand-200 rounded-xl px-5 py-4 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-brand-600 animate-spin" />
                  <span className="text-sm font-medium text-brand-800">Starting scan…</span>
                </div>
              )}

              {/* Scan complete banner */}
              {scanComplete && !scanning && (
                <div className="mb-6 bg-green-50 border border-green-200 rounded-xl px-5 py-4 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <span className="text-sm font-medium text-green-800">
                    Scan complete — {findings.length} finding{findings.length !== 1 ? 's' : ''} detected
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
                  <Button size="sm" onClick={triggerScan} loading={scanning} disabled={scanning}>
                    <Play className="w-4 h-4" />
                    Run scan
                  </Button>
                </div>

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
            </>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
