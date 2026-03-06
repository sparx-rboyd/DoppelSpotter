export const FIXED_INITIAL_GOOGLE_PAGE_COUNT = 3;
export const DEFAULT_ALLOW_AI_DEEP_SEARCHES = true;
export const MIN_AI_DEEP_SEARCHES = 1;
export const MAX_AI_DEEP_SEARCHES = 10;
export const DEFAULT_MAX_AI_DEEP_SEARCHES = 5;
export const MIN_DEEP_SEARCH_PAGE_COUNT = 1;
export const MAX_DEEP_SEARCH_PAGE_COUNT = 2;

export function isValidMaxAiDeepSearches(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_AI_DEEP_SEARCHES &&
    value <= MAX_AI_DEEP_SEARCHES
  );
}

export function normalizeMaxAiDeepSearches(value: unknown): number {
  return isValidMaxAiDeepSearches(value) ? value : DEFAULT_MAX_AI_DEEP_SEARCHES;
}

export function getInitialGooglePageCount(): number {
  return FIXED_INITIAL_GOOGLE_PAGE_COUNT;
}

export function getDeepSearchGooglePageCount(): number {
  return MAX_DEEP_SEARCH_PAGE_COUNT;
}

export function isValidAllowAiDeepSearches(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function normalizeAllowAiDeepSearches(value: unknown): boolean {
  return isValidAllowAiDeepSearches(value) ? value : DEFAULT_ALLOW_AI_DEEP_SEARCHES;
}
