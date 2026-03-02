'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, Play, AlertCircle, Shield } from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/firebase/auth-context';
import { formatDate } from '@/lib/utils';
import type { BrandProfile, Finding } from '@/lib/types';

export default function BrandDetailPage() {
  const { brandId } = useParams<{ brandId: string }>();
  const { getIdToken } = useAuth();

  const [brand, setBrand] = useState<BrandProfile | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function fetchData() {
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
  }, [brandId, getIdToken]);

  async function triggerScan() {
    setScanning(true);
    try {
      const token = await getIdToken();
      await fetch('/api/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ brandId }),
      });
      // TODO: poll for scan completion and refresh findings
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }

  const highCount = findings.filter((f) => f.severity === 'high').length;

  return (
    <AuthGuard>
      <Navbar />
      <main className="pt-16 min-h-screen bg-gray-50/50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">

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
                  <Button size="sm" onClick={triggerScan} loading={scanning}>
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
