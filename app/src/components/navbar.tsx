'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ScanEye, LayoutDashboard, Shield } from 'lucide-react';
import { UserMenu } from '@/components/user-menu';
import { cn } from '@/lib/utils';

const navLinks = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/brands', label: 'Brands', icon: Shield },
];

export function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="fixed z-50 w-full border-b border-brand-700/60 bg-brand-600">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link href="/dashboard" className="flex items-center gap-2">
            <ScanEye className="text-white w-6 h-6" />
            <span className="font-bold text-lg tracking-tight text-white">DoppelSpotter</span>
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
                    ? 'bg-white/20 text-white'
                    : 'text-white/70 hover:text-white hover:bg-white/10',
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            ))}
          </div>

          <UserMenu />
        </div>
      </div>
    </nav>
  );
}
