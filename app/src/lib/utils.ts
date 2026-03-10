/**
 * Merges class names, filtering out falsy values.
 * Lightweight alternative to clsx/tailwind-merge for this project.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

type AnyTimestamp =
  | Date
  | { toDate(): Date }
  | { _seconds: number; _nanoseconds: number }
  | { seconds: number; nanoseconds: number };

/**
 * Resolve any Firestore Timestamp variant (live object or JSON-serialised) to a plain Date.
 * The Firestore Admin SDK serialises Timestamps as `{ _seconds, _nanoseconds }` when passed
 * through JSON.stringify (e.g. NextResponse.json), so `.toDate()` is no longer available.
 */
function toDate(date: AnyTimestamp): Date {
  if (typeof (date as { toDate?: unknown }).toDate === 'function') {
    return (date as { toDate(): Date }).toDate();
  }
  if ('_seconds' in date) return new Date((date as { _seconds: number })._seconds * 1000);
  if ('seconds' in date) return new Date((date as { seconds: number }).seconds * 1000);
  return date as Date;
}

/**
 * Format a Firestore Timestamp or Date for display.
 * Output: "5 Mar 2026, 13:19"
 */
export function formatDate(date: AnyTimestamp | null | undefined): string {
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(toDate(date));
  } catch {
    return '—';
  }
}

function ordinalSuffix(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

/**
 * Format a Firestore Timestamp or Date as a long-form scan label.
 * Output: "Thursday 5th March 2026 at 13:19"
 */
export function formatScanDate(date: AnyTimestamp | null | undefined): string {
  if (!date) return '—';
  try {
    const d = toDate(date);
    const day = d.getDate();
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(d);
    const month = new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(d);
    const year = d.getFullYear();
    const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(d);
    return `${weekday} ${day}${ordinalSuffix(day)} ${month} ${year} at ${time}`;
  } catch {
    return '—';
  }
}

/**
 * Format an integer count with locale-aware thousands separators.
 * Output: "1,798"
 */
export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('en-GB', {
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Capitalise the first letter of a string.
 */
export function capitalise(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
