export const GOOGLE_RESULTS_STEP = 10;
export const MIN_GOOGLE_RESULTS_LIMIT = 10;
export const MAX_GOOGLE_RESULTS_LIMIT = 100;
export const DEFAULT_GOOGLE_RESULTS_LIMIT = 10;
export const GOOGLE_SERP_RESULTS_PER_PAGE = 10;
export const DEFAULT_ALLOW_AI_DEEP_SEARCHES = true;

export function isValidGoogleResultsLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_GOOGLE_RESULTS_LIMIT &&
    value <= MAX_GOOGLE_RESULTS_LIMIT &&
    value % GOOGLE_RESULTS_STEP === 0
  );
}

export function normalizeGoogleResultsLimit(value: unknown): number {
  return isValidGoogleResultsLimit(value) ? value : DEFAULT_GOOGLE_RESULTS_LIMIT;
}

export function getGoogleResultsPageCount(value: unknown): number {
  return Math.ceil(normalizeGoogleResultsLimit(value) / GOOGLE_SERP_RESULTS_PER_PAGE);
}

export function isValidAllowAiDeepSearches(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function normalizeAllowAiDeepSearches(value: unknown): boolean {
  return isValidAllowAiDeepSearches(value) ? value : DEFAULT_ALLOW_AI_DEEP_SEARCHES;
}
