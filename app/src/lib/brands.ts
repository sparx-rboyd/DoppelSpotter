export const DEFAULT_SEARCH_RESULT_PAGES = 3;
export const MIN_SEARCH_RESULT_PAGES = 1;
export const MAX_SEARCH_RESULT_PAGES = 10;
export const DEFAULT_ALLOW_AI_DEEP_SEARCHES = true;
export const MIN_AI_DEEP_SEARCHES = 1;
export const MAX_AI_DEEP_SEARCHES = 10;
export const DEFAULT_MAX_AI_DEEP_SEARCHES = 5;

export function isValidSearchResultPages(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SEARCH_RESULT_PAGES &&
    value <= MAX_SEARCH_RESULT_PAGES
  );
}

export function normalizeSearchResultPages(value: unknown): number {
  return isValidSearchResultPages(value) ? value : DEFAULT_SEARCH_RESULT_PAGES;
}

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

export function getInitialGooglePageCount(searchResultPages?: unknown): number {
  return normalizeSearchResultPages(searchResultPages);
}

export function getDeepSearchGooglePageCount(searchResultPages?: unknown): number {
  return normalizeSearchResultPages(searchResultPages);
}

export function isValidAllowAiDeepSearches(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function normalizeAllowAiDeepSearches(value: unknown): boolean {
  return isValidAllowAiDeepSearches(value) ? value : DEFAULT_ALLOW_AI_DEEP_SEARCHES;
}
