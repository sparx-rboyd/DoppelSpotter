'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, Settings, User } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';

export function UserMenu() {
  const { user, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isOpen) return undefined;

    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  async function handleSignOut() {
    if (isSigningOut) return;

    setIsSigningOut(true);
    try {
      await signOut();
      router.replace('/login');
    } finally {
      setIsOpen(false);
      setIsSigningOut(false);
    }
  }

  const email = user?.email ?? 'Account';

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Open user menu"
        onClick={() => setIsOpen((open) => !open)}
        className={cn(
          'flex items-center gap-2 rounded-full border px-2 py-1.5 text-sm transition lg:px-2.5 lg:py-2',
          isOpen
            ? 'border-white/30 bg-white/15 text-white'
            : 'border-white/15 text-white/80 hover:border-white/25 hover:bg-white/10 hover:text-white',
        )}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-white lg:h-9 lg:w-9">
          <User className="h-4 w-4" aria-hidden="true" />
        </span>
        <ChevronDown className={cn('h-4 w-4 transition', isOpen && 'rotate-180')} />
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label="User menu"
          className="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
        >
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-gray-400">Signed in as</p>
            <p className="mt-1 truncate text-sm font-semibold text-gray-900">{email}</p>
          </div>

          <div className="p-2">
            <Link
              href="/settings"
              role="menuitem"
              className={cn(
                'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-50 hover:text-gray-900',
                pathname.startsWith('/settings') && 'bg-brand-50 text-brand-700',
              )}
            >
              <Settings className="h-4 w-4" />
              Settings
            </Link>

            <button
              type="button"
              role="menuitem"
              disabled={isSigningOut}
              onClick={handleSignOut}
              className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LogOut className="h-4 w-4" />
              {isSigningOut ? 'Signing out...' : 'Sign out'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
