'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

declare global {
  function gtag(...args: unknown[]): void;
}

export function GaPageTracker() {
  const pathname = usePathname();

  useEffect(() => {
    // Small delay ensures the page component's usePageTitle effect has already
    // updated document.title before we capture it for the page_view event.
    const id = setTimeout(() => {
      if (typeof window === 'undefined' || typeof gtag === 'undefined') return;
      gtag('event', 'page_view', {
        page_title: document.title,
        page_path: pathname,
        page_location: window.location.href,
      });
    }, 0);
    return () => clearTimeout(id);
  }, [pathname]);

  return null;
}
