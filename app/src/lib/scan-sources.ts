import { normalizeBrandScanSources } from '@/lib/brands';
import type { BrandScanSources, FindingSource, GoogleScannerId } from '@/lib/types';

export type GoogleFindingSource = Extract<
  FindingSource,
  'google' | 'reddit' | 'tiktok' | 'youtube' | 'facebook' | 'instagram'
>;

export interface GoogleScannerConfig {
  id: GoogleScannerId;
  source: GoogleFindingSource;
  actorId: string;
  displayName: string;
  shortLabel: string;
  siteHost?: string;
}

export const GOOGLE_SEARCH_ACTOR_ID = 'apify/google-search-scraper';

export const GOOGLE_SCAN_SOURCE_ORDER: GoogleFindingSource[] = [
  'google',
  'reddit',
  'tiktok',
  'youtube',
  'facebook',
  'instagram',
];

const GOOGLE_SCANNER_CONFIGS: Record<GoogleScannerId, GoogleScannerConfig> = {
  'google-web': {
    id: 'google-web',
    source: 'google',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    displayName: 'Web search',
    shortLabel: 'Web',
  },
  'google-reddit': {
    id: 'google-reddit',
    source: 'reddit',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    displayName: 'Reddit',
    shortLabel: 'Reddit',
    siteHost: 'reddit.com',
  },
  'google-tiktok': {
    id: 'google-tiktok',
    source: 'tiktok',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    displayName: 'TikTok',
    shortLabel: 'TikTok',
    siteHost: 'tiktok.com',
  },
  'google-youtube': {
    id: 'google-youtube',
    source: 'youtube',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    displayName: 'YouTube',
    shortLabel: 'YouTube',
    siteHost: 'youtube.com',
  },
  'google-facebook': {
    id: 'google-facebook',
    source: 'facebook',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    displayName: 'Facebook',
    shortLabel: 'Facebook',
    siteHost: 'facebook.com',
  },
  'google-instagram': {
    id: 'google-instagram',
    source: 'instagram',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    displayName: 'Instagram',
    shortLabel: 'Instagram',
    siteHost: 'instagram.com',
  },
};

const GOOGLE_SCANNER_ID_BY_SOURCE: Record<GoogleFindingSource, GoogleScannerId> = {
  google: 'google-web',
  reddit: 'google-reddit',
  tiktok: 'google-tiktok',
  youtube: 'google-youtube',
  facebook: 'google-facebook',
  instagram: 'google-instagram',
};

export function hasEnabledBrandScanSource(scanSources: BrandScanSources | undefined): boolean {
  const normalized = normalizeBrandScanSources(scanSources);
  return GOOGLE_SCAN_SOURCE_ORDER.some((source) => normalized[source]);
}

export function getEnabledGoogleScannerConfigs(scanSources?: BrandScanSources): GoogleScannerConfig[] {
  const normalized = normalizeBrandScanSources(scanSources);
  return GOOGLE_SCAN_SOURCE_ORDER
    .filter((source) => normalized[source])
    .map((source) => GOOGLE_SCANNER_CONFIGS[GOOGLE_SCANNER_ID_BY_SOURCE[source]]);
}

export function getGoogleScannerConfigById(id: GoogleScannerId): GoogleScannerConfig {
  return GOOGLE_SCANNER_CONFIGS[id];
}

export function getGoogleScannerConfigBySource(source: GoogleFindingSource): GoogleScannerConfig {
  return GOOGLE_SCANNER_CONFIGS[GOOGLE_SCANNER_ID_BY_SOURCE[source]];
}

export function getFindingSourceLabel(source: FindingSource): string {
  if (source === 'unknown') {
    return 'Unknown';
  }

  return getGoogleScannerConfigBySource(source).displayName;
}

export function buildGoogleScannerQuery(
  source: GoogleFindingSource,
  baseQuery: string,
): string {
  const trimmedBaseQuery = baseQuery.trim().replace(/\s+/g, ' ');
  if (!trimmedBaseQuery) {
    return trimmedBaseQuery;
  }

  const scanner = getGoogleScannerConfigBySource(source);
  if (scanner.siteHost) {
    return `site:${scanner.siteHost} ${trimmedBaseQuery}`.trim();
  }

  const specialistExclusions = Object.values(GOOGLE_SCANNER_CONFIGS)
    .filter((config) => config.source !== 'google')
    .map((config) => config.siteHost)
    .filter((siteHost): siteHost is string => typeof siteHost === 'string' && siteHost.length > 0)
    .map((siteHost) => `-site:${siteHost}`);

  return [trimmedBaseQuery, ...specialistExclusions].join(' ').trim();
}

export function sanitizeGoogleQueryForDisplay(query: string): string {
  const sanitized = query
    .replace(/(^|\s)-?site:[^\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized || query.trim();
}
