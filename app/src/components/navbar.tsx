'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ScanEye, LayoutDashboard, Shield, CircleHelp, Menu, X } from 'lucide-react';
import { UserMenu } from '@/components/user-menu';
import { cn } from '@/lib/utils';

const navLinks = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/brands', label: 'Brands', icon: Shield },
];

type NavbarProps = {
  activeHref?: string;
};

export function Navbar({ activeHref }: NavbarProps = {}) {
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  return (
    <nav className="fixed z-50 w-full border-b border-brand-700/60 bg-brand-600/95 backdrop-blur supports-[backdrop-filter]:bg-brand-600/90">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 xl:max-w-[88rem]">
        <div className="flex h-16 items-center justify-between lg:h-[4.5rem]">
          {/* Logo */}
          <Link href="/dashboard" className="flex items-center gap-2 lg:gap-2.5">
            <ScanEye className="h-6 w-6 text-white lg:h-7 lg:w-7" />
            <span className="text-lg font-bold tracking-tight text-white lg:text-[1.1875rem]">DoppelSpotter</span>
          </Link>

          {/* Desktop nav links */}
          <div className="hidden items-center gap-1 sm:flex lg:gap-2">
            {navLinks.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition lg:px-4 lg:py-2.5',
                  (activeHref ? activeHref === href : pathname.startsWith(href))
                    ? 'bg-white/20 text-white'
                    : 'text-white/70 hover:text-white hover:bg-white/10',
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-2 lg:gap-3">
            <Link
              href="/help"
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full transition lg:h-9 lg:w-9',
                pathname === '/help'
                  ? 'bg-white/20 text-white'
                  : 'text-white/80 hover:bg-white/10 hover:text-white'
              )}
              aria-label="Help"
            >
              <CircleHelp className="h-5 w-5" />
            </Link>
            <UserMenu />
            {/* Mobile hamburger button */}
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen((open) => !open)}
              aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={isMobileMenuOpen}
              className="sm:hidden flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile menu drawer */}
      {isMobileMenuOpen && (
        <div className="sm:hidden border-t border-brand-700/60 bg-brand-600 px-4 pb-3 pt-2">
          {navLinks.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-3 text-sm font-medium transition',
                (activeHref ? activeHref === href : pathname.startsWith(href))
                  ? 'bg-white/20 text-white'
                  : 'text-white/70 hover:text-white hover:bg-white/10',
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
