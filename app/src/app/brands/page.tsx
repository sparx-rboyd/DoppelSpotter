'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Shield, ChevronRight } from 'lucide-react';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { BrandProfile } from '@/lib/types';

export default function BrandsPage() {
  const [brands, setBrands] = useState<BrandProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function fetchBrands() {
      setError('');
      setLoading(true);
      try {
        const res = await fetch('/api/brands', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Failed to load brands');
        const json = await res.json();
        setBrands(json.data ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    fetchBrands();
  }, []);

  return (
    <AuthGuard>
      <Navbar />
      <main className="pt-16 min-h-screen bg-gray-50/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Brand Profiles</h1>
              <p className="text-sm text-gray-500 mt-0.5">Manage the brands you&apos;re monitoring</p>
            </div>
            <Link href="/brands/new">
              <Button size="sm">
                <Plus className="w-4 h-4" />
                Add Brand
              </Button>
            </Link>
          </div>

          {loading && (
            <div className="flex justify-center py-16">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
              {error}
            </p>
          )}

          {!loading && !error && brands.length === 0 && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
                <div className="w-12 h-12 bg-brand-50 rounded-xl flex items-center justify-center">
                  <Shield className="w-6 h-6 text-brand-600" />
                </div>
                <div className="text-center">
                  <h3 className="font-semibold text-gray-900 mb-1">No brands yet</h3>
                  <p className="text-sm text-gray-500">Add your first brand to start monitoring the web for infringements.</p>
                </div>
                <Link href="/brands/new">
                  <Button>
                    <Plus className="w-4 h-4" />
                    Add your first brand
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {!loading && brands.length > 0 && (
            <div className="flex flex-col gap-4">
              {brands.map((brand) => (
                <Link key={brand.id} href={`/brands/${brand.id}`}>
                  <Card className="hover:border-brand-300 transition cursor-pointer">
                    <CardContent className="flex items-center gap-4 py-4">
                      <div className="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <Shield className="w-5 h-5 text-brand-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 truncate">{brand.name}</h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {brand.keywords.length} keyword{brand.keywords.length !== 1 ? 's' : ''} · {brand.officialDomains.length} domain{brand.officialDomains.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
