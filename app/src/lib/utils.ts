/**
 * Merges class names, filtering out falsy values.
 * Lightweight alternative to clsx/tailwind-merge for this project.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * Format a Firestore Timestamp or Date for display.
 */
export function formatDate(date: Date | { toDate(): Date } | null | undefined): string {
  if (!date) return '—';
  try {
    const d = 'toDate' in date ? date.toDate() : date;
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    return '—';
  }
}

/**
 * Capitalise the first letter of a string.
 */
export function capitalise(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
