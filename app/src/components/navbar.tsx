'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ScanEye, LayoutDashboard, Shield, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';

const navLinks = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/brands', label: 'Brands', icon: Shield },
];

export function Navbar() {
  const { signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.replace('/login');
  }

  return (
    <nav className="fixed w-full bg-white/80 backdrop-blur-md z-50 border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link href="/dashboard" className="flex items-center gap-2">
            <ScanEye className="text-brand-600 w-6 h-6" />
            <span className="font-bold text-lg tracking-tight text-gray-900">DoppelSpotter</span>
          </Link>

          {/* Nav links */}
          <div className="hidden sm:flex items-center gap-1">
            {navLinks.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition',
                  pathname.startsWith(href)
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50',
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            ))}
          </div>

          {/* Sign out */}
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition px-3 py-2 rounded-lg hover:bg-gray-50"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
