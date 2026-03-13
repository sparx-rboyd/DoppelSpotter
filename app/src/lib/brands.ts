import type { BrandProfile, BrandScanSources, EffectiveScanSettings, LookbackPeriod, ScanSettingsInput } from '@/lib/types';

export const DEFAULT_LOOKBACK_PERIOD: LookbackPeriod = '1year';
export const LOOKBACK_PERIOD_VALUES: LookbackPeriod[] = ['1year', '1month', '1week', 'since_last_scan'];

export const MAX_BRAND_KEYWORDS = 10;
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
  apple_app_store: false,
  google_play: false,
  domains: false,
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

export function getInitialDomainRegistrationLimit(searchResultPages?: unknown): number {
  return normalizeSearchResultPages(searchResultPages) * 100;
}

export function getInitialDiscordMaxTotalChargeUsd(searchResultPages?: unknown): number {
  const depth = normalizeSearchResultPages(searchResultPages);
  const minUsd = 0.2;
  const maxUsd = 0.6;
  const ratio = (depth - MIN_SEARCH_RESULT_PAGES) / Math.max(1, MAX_SEARCH_RESULT_PAGES - MIN_SEARCH_RESULT_PAGES);
  const value = minUsd + ((maxUsd - minUsd) * ratio);
  return Math.round(value * 100) / 100;
}

export function getInitialRedditTotalPosts(searchResultPages?: unknown): number {
  return normalizeSearchResultPages(searchResultPages) * 60;
}

export function getInitialTikTokTotalPosts(searchResultPages?: unknown): number {
  return normalizeSearchResultPages(searchResultPages) * 100;
}

export function getInitialRedditMaxTotalChargeUsd(searchResultPages?: unknown): number {
  const depth = normalizeSearchResultPages(searchResultPages);
  const minUsd = 0.1;
  const maxUsd = 0.5;
  const ratio = (depth - MIN_SEARCH_RESULT_PAGES) / Math.max(1, MAX_SEARCH_RESULT_PAGES - MIN_SEARCH_RESULT_PAGES);
  const value = minUsd + ((maxUsd - minUsd) * ratio);
  return Math.round(value * 100) / 100;
}

export function getDeepSearchRedditMaxPosts(): number {
  return 20;
}

export function getDeepSearchTikTokMaxItems(): number {
  return 50;
}

export function getDeepSearchXMaxItems(): number {
  return 30;
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
    typeof scanSources.apple_app_store === 'boolean' &&
    typeof scanSources.google_play === 'boolean' &&
    typeof scanSources.domains === 'boolean' &&
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
    apple_app_store: typeof scanSources.apple_app_store === 'boolean'
      ? scanSources.apple_app_store
      : DEFAULT_BRAND_SCAN_SOURCES.apple_app_store,
    google_play: typeof scanSources.google_play === 'boolean'
      ? scanSources.google_play
      : DEFAULT_BRAND_SCAN_SOURCES.google_play,
    domains: typeof scanSources.domains === 'boolean' ? scanSources.domains : DEFAULT_BRAND_SCAN_SOURCES.domains,
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
    || scanSources.apple_app_store
    || scanSources.google_play
    || scanSources.domains
    || scanSources.discord
    || scanSources.github
    || scanSources.x
  );
}

export function isValidLookbackPeriod(value: unknown): value is LookbackPeriod {
  return typeof value === 'string' && (LOOKBACK_PERIOD_VALUES as string[]).includes(value);
}

export function normalizeLookbackPeriod(value: unknown): LookbackPeriod {
  return isValidLookbackPeriod(value) ? value : DEFAULT_LOOKBACK_PERIOD;
}

/**
 * Resolves the lookback period to a concrete YYYY-MM-DD date string.
 * Applies a 1-day buffer (subtracts an extra day) so edge-case results at the
 * exact period boundary are not missed.
 * Falls back to "1 year" when `since_last_scan` is selected but no prior scan exists.
 */
export function resolveLookbackDate(
  period: LookbackPeriod,
  lastScanCompletedAt?: Date,
  now = new Date(),
): string {
  let boundary: Date;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  if (period === '1year') {
    boundary = new Date(Date.UTC(year - 1, month, day - 1));
  } else if (period === '1month') {
    boundary = new Date(Date.UTC(year, month - 1, day - 1));
  } else if (period === '1week') {
    boundary = new Date(Date.UTC(year, month, day - 7 - 1));
  } else {
    // since_last_scan — fall back to 1 year if no prior scan
    if (lastScanCompletedAt) {
      const ly = lastScanCompletedAt.getUTCFullYear();
      const lm = lastScanCompletedAt.getUTCMonth();
      const ld = lastScanCompletedAt.getUTCDate();
      boundary = new Date(Date.UTC(ly, lm, ld - 1));
    } else {
      boundary = new Date(Date.UTC(year - 1, month, day - 1));
    }
  }

  return boundary.toISOString().slice(0, 10);
}

export function getEffectiveScanSettings(
  source?: Pick<BrandProfile, 'searchResultPages' | 'lookbackPeriod' | 'allowAiDeepSearches' | 'maxAiDeepSearches' | 'scanSources'> | null,
  overrides?: ScanSettingsInput,
  lastScanCompletedAt?: Date,
): EffectiveScanSettings {
  const baseSearchResultPages = overrides?.searchResultPages ?? source?.searchResultPages;
  const baseLookbackPeriod = overrides?.lookbackPeriod ?? source?.lookbackPeriod;
  const baseAllowAiDeepSearches = overrides?.allowAiDeepSearches ?? source?.allowAiDeepSearches;
  const baseMaxAiDeepSearches = overrides?.maxAiDeepSearches ?? source?.maxAiDeepSearches;
  const baseScanSources = overrides?.scanSources ?? source?.scanSources;

  const lookbackPeriod = normalizeLookbackPeriod(baseLookbackPeriod);

  return {
    searchResultPages: normalizeSearchResultPages(baseSearchResultPages),
    lookbackPeriod,
    lookbackDate: resolveLookbackDate(lookbackPeriod, lastScanCompletedAt),
    allowAiDeepSearches: normalizeAllowAiDeepSearches(baseAllowAiDeepSearches),
    maxAiDeepSearches: normalizeMaxAiDeepSearches(baseMaxAiDeepSearches),
    scanSources: normalizeBrandScanSources(baseScanSources),
  };
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
