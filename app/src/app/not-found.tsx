'use client';

import Link from 'next/link';
import { ScanEye } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';

export default function NotFound() {
  const { user, loading } = useAuth();

  const ctaHref = !loading && user ? '/dashboard' : '/login';
  const ctaLabel = !loading && user ? 'Back to dashboard' : 'Back to login';

  return (
    <div className="min-h-screen hero-pattern flex flex-col items-center justify-center px-4">
      <div className="flex items-center justify-center gap-2 mb-10">
        <ScanEye className="text-brand-600 w-8 h-8" />
        <span className="font-bold text-xl tracking-tight text-gray-900">DoppelSpotter</span>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-10 w-full max-w-md text-center shadow-sm">
        <p className="text-8xl font-black gradient-text mb-1 leading-none">404</p>
        <h1 className="text-xl font-bold text-gray-900 mt-4 mb-2">Page not found</h1>
        <p className="text-sm text-gray-500 mb-8">
          We scanned everywhere, but this page doesn&apos;t exist. It may have been moved or the
          link may be incorrect.
        </p>
        <Link
          href={ctaHref}
          className="inline-flex items-center justify-center bg-brand-600 hover:bg-brand-700 text-white font-medium px-6 py-2.5 rounded-full transition text-sm"
        >
          {ctaLabel}
        </Link>
      </div>
    </div>
  );
}
