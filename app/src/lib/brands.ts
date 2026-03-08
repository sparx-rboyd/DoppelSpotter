import type { BrandScanSources } from '@/lib/types';

export const DEFAULT_SEARCH_RESULT_PAGES = 3;
export const MIN_SEARCH_RESULT_PAGES = 1;
export const MAX_SEARCH_RESULT_PAGES = 5;
export const DEFAULT_ALLOW_AI_DEEP_SEARCHES = true;
export const MIN_AI_DEEP_SEARCHES = 1;
export const MAX_AI_DEEP_SEARCHES = 5;
export const DEFAULT_MAX_AI_DEEP_SEARCHES = 5;
export const DEFAULT_BRAND_SCAN_SOURCES: BrandScanSources = {
  google: true,
  reddit: false,
  tiktok: false,
  youtube: false,
  facebook: false,
  instagram: false,
  telegram: false,
  discord: false,
  github: false,
  x: false,
};

export function isValidSearchResultPages(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SEARCH_RESULT_PAGES &&
    value <= MAX_SEARCH_RESULT_PAGES
  );
}

export function normalizeSearchResultPages(value: unknown): number {
  return normalizeClampedIntegerInRange(
    value,
    MIN_SEARCH_RESULT_PAGES,
    MAX_SEARCH_RESULT_PAGES,
    DEFAULT_SEARCH_RESULT_PAGES,
  );
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
  return normalizeClampedIntegerInRange(
    value,
    MIN_AI_DEEP_SEARCHES,
    MAX_AI_DEEP_SEARCHES,
    DEFAULT_MAX_AI_DEEP_SEARCHES,
  );
}

export function getInitialGooglePageCount(searchResultPages?: unknown): number {
  return normalizeSearchResultPages(searchResultPages);
}

export function getInitialXMaxItems(searchResultPages?: unknown): number {
  return normalizeSearchResultPages(searchResultPages) * 50;
}

export function getInitialDiscordMaxTotalChargeUsd(searchResultPages?: unknown): number {
  const depth = normalizeSearchResultPages(searchResultPages);
  const minUsd = 0.2;
  const maxUsd = 0.6;
  const ratio = (depth - MIN_SEARCH_RESULT_PAGES) / Math.max(1, MAX_SEARCH_RESULT_PAGES - MIN_SEARCH_RESULT_PAGES);
  const value = minUsd + ((maxUsd - minUsd) * ratio);
  return Math.round(value * 100) / 100;
}

export function getInitialGitHubMaxResults(searchResultPages?: unknown): number {
  return normalizeSearchResultPages(searchResultPages) * 50;
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

export function isValidBrandScanSources(value: unknown): value is BrandScanSources {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const scanSources = value as Record<string, unknown>;
  return (
    typeof scanSources.google === 'boolean' &&
    typeof scanSources.reddit === 'boolean' &&
    typeof scanSources.tiktok === 'boolean' &&
    typeof scanSources.youtube === 'boolean' &&
    typeof scanSources.facebook === 'boolean' &&
    typeof scanSources.instagram === 'boolean' &&
    typeof scanSources.telegram === 'boolean' &&
    typeof scanSources.discord === 'boolean' &&
    typeof scanSources.github === 'boolean' &&
    typeof scanSources.x === 'boolean'
  );
}

export function normalizeBrandScanSources(value: unknown): BrandScanSources {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_BRAND_SCAN_SOURCES };
  }

  const scanSources = value as Record<string, unknown>;
  return {
    google: typeof scanSources.google === 'boolean' ? scanSources.google : DEFAULT_BRAND_SCAN_SOURCES.google,
    reddit: typeof scanSources.reddit === 'boolean' ? scanSources.reddit : DEFAULT_BRAND_SCAN_SOURCES.reddit,
    tiktok: typeof scanSources.tiktok === 'boolean' ? scanSources.tiktok : DEFAULT_BRAND_SCAN_SOURCES.tiktok,
    youtube: typeof scanSources.youtube === 'boolean' ? scanSources.youtube : DEFAULT_BRAND_SCAN_SOURCES.youtube,
    facebook: typeof scanSources.facebook === 'boolean' ? scanSources.facebook : DEFAULT_BRAND_SCAN_SOURCES.facebook,
    instagram: typeof scanSources.instagram === 'boolean' ? scanSources.instagram : DEFAULT_BRAND_SCAN_SOURCES.instagram,
    telegram: typeof scanSources.telegram === 'boolean' ? scanSources.telegram : DEFAULT_BRAND_SCAN_SOURCES.telegram,
    discord: typeof scanSources.discord === 'boolean' ? scanSources.discord : DEFAULT_BRAND_SCAN_SOURCES.discord,
    github: typeof scanSources.github === 'boolean' ? scanSources.github : DEFAULT_BRAND_SCAN_SOURCES.github,
    x: typeof scanSources.x === 'boolean' ? scanSources.x : DEFAULT_BRAND_SCAN_SOURCES.x,
  };
}

export function hasEnabledBrandScanSource(value: unknown): boolean {
  const scanSources = normalizeBrandScanSources(value);
  return (
    scanSources.google
    || scanSources.reddit
    || scanSources.tiktok
    || scanSources.youtube
    || scanSources.facebook
    || scanSources.instagram
    || scanSources.telegram
    || scanSources.discord
    || scanSources.github
    || scanSources.x
  );
}

function normalizeClampedIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}
