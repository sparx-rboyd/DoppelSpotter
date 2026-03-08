import { normalizeBrandScanSources } from '@/lib/brands';
import type { BrandScanSources, FindingSource, GoogleScannerId, ScannerId } from '@/lib/types';

export type ScanFindingSource = Exclude<FindingSource, 'unknown'>;
export type GoogleFindingSource = Extract<
  ScanFindingSource,
  'google' | 'reddit' | 'tiktok' | 'youtube' | 'facebook' | 'instagram' | 'telegram'
>;

interface BaseScannerConfig {
  id: ScannerId;
  source: ScanFindingSource;
  actorId: string;
  displayName: string;
  shortLabel: string;
  supportsDeepSearch: boolean;
}

export interface GoogleScannerConfig extends BaseScannerConfig {
  id: GoogleScannerId;
  source: GoogleFindingSource;
  kind: 'google';
  siteHost?: string;
}

export interface DiscordScannerConfig extends BaseScannerConfig {
  id: 'discord-servers';
  source: 'discord';
  kind: 'discord';
}

export interface GitHubScannerConfig extends BaseScannerConfig {
  id: 'github-repos';
  source: 'github';
  kind: 'github';
}

export interface XScannerConfig extends BaseScannerConfig {
  id: 'x-search';
  source: 'x';
  kind: 'x';
}

export type ScannerConfig =
  | GoogleScannerConfig
  | DiscordScannerConfig
  | GitHubScannerConfig
  | XScannerConfig;

export const GOOGLE_SEARCH_ACTOR_ID = 'apify/google-search-scraper';
export const DISCORD_SERVER_SCRAPER_ACTOR_ID = 'louisdeconinck/discord-server-scraper';
export const GITHUB_REPO_SEARCH_ACTOR_ID = 'ryanclinton/github-repo-search';
export const X_TWEET_SCRAPER_ACTOR_ID = 'apidojo/tweet-scraper';

export const SCAN_SOURCE_ORDER: ScanFindingSource[] = [
  'google',
  'reddit',
  'tiktok',
  'youtube',
  'facebook',
  'instagram',
  'telegram',
  'discord',
  'github',
  'x',
];

export const GOOGLE_SCAN_SOURCE_ORDER: GoogleFindingSource[] = [
  'google',
  'reddit',
  'tiktok',
  'youtube',
  'facebook',
  'instagram',
  'telegram',
];

const SCANNER_CONFIGS: Record<ScannerId, ScannerConfig> = {
  'google-web': {
    id: 'google-web',
    source: 'google',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    kind: 'google',
    displayName: 'Web search',
    shortLabel: 'Web',
    supportsDeepSearch: true,
  },
  'google-reddit': {
    id: 'google-reddit',
    source: 'reddit',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    kind: 'google',
    displayName: 'Reddit',
    shortLabel: 'Reddit',
    siteHost: 'reddit.com',
    supportsDeepSearch: true,
  },
  'google-tiktok': {
    id: 'google-tiktok',
    source: 'tiktok',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    kind: 'google',
    displayName: 'TikTok',
    shortLabel: 'TikTok',
    siteHost: 'tiktok.com',
    supportsDeepSearch: true,
  },
  'google-youtube': {
    id: 'google-youtube',
    source: 'youtube',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    kind: 'google',
    displayName: 'YouTube',
    shortLabel: 'YouTube',
    siteHost: 'youtube.com',
    supportsDeepSearch: true,
  },
  'google-facebook': {
    id: 'google-facebook',
    source: 'facebook',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    kind: 'google',
    displayName: 'Facebook',
    shortLabel: 'Facebook',
    siteHost: 'facebook.com',
    supportsDeepSearch: true,
  },
  'google-instagram': {
    id: 'google-instagram',
    source: 'instagram',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    kind: 'google',
    displayName: 'Instagram',
    shortLabel: 'Instagram',
    siteHost: 'instagram.com',
    supportsDeepSearch: true,
  },
  'google-telegram': {
    id: 'google-telegram',
    source: 'telegram',
    actorId: GOOGLE_SEARCH_ACTOR_ID,
    kind: 'google',
    displayName: 'Telegram channels',
    shortLabel: 'Telegram',
    siteHost: 't.me',
    supportsDeepSearch: true,
  },
  'discord-servers': {
    id: 'discord-servers',
    source: 'discord',
    actorId: DISCORD_SERVER_SCRAPER_ACTOR_ID,
    kind: 'discord',
    displayName: 'Discord servers',
    shortLabel: 'Discord',
    supportsDeepSearch: false,
  },
  'github-repos': {
    id: 'github-repos',
    source: 'github',
    actorId: GITHUB_REPO_SEARCH_ACTOR_ID,
    kind: 'github',
    displayName: 'GitHub repos',
    shortLabel: 'GitHub',
    supportsDeepSearch: false,
  },
  'x-search': {
    id: 'x-search',
    source: 'x',
    actorId: X_TWEET_SCRAPER_ACTOR_ID,
    kind: 'x',
    displayName: 'X',
    shortLabel: 'X',
    supportsDeepSearch: false,
  },
};

const SCANNER_ID_BY_SOURCE: Record<ScanFindingSource, ScannerId> = {
  google: 'google-web',
  reddit: 'google-reddit',
  tiktok: 'google-tiktok',
  youtube: 'google-youtube',
  facebook: 'google-facebook',
  instagram: 'google-instagram',
  telegram: 'google-telegram',
  discord: 'discord-servers',
  github: 'github-repos',
  x: 'x-search',
};

export function isGoogleScannerConfig(config: ScannerConfig): config is GoogleScannerConfig {
  return config.kind === 'google';
}

export function supportsScannerDeepSearch(config: ScannerConfig): boolean {
  return config.supportsDeepSearch;
}

export function supportsSourceDeepSearch(source: ScanFindingSource): boolean {
  return getScannerConfigBySource(source).supportsDeepSearch;
}

export function hasEnabledBrandScanSource(scanSources: BrandScanSources | undefined): boolean {
  const normalized = normalizeBrandScanSources(scanSources);
  return SCAN_SOURCE_ORDER.some((source) => normalized[source]);
}

export function getEnabledScannerConfigs(scanSources?: BrandScanSources): ScannerConfig[] {
  const normalized = normalizeBrandScanSources(scanSources);
  return SCAN_SOURCE_ORDER
    .filter((source) => normalized[source])
    .map((source) => SCANNER_CONFIGS[SCANNER_ID_BY_SOURCE[source]]);
}

export function getEnabledGoogleScannerConfigs(scanSources?: BrandScanSources): GoogleScannerConfig[] {
  return getEnabledScannerConfigs(scanSources).filter(isGoogleScannerConfig);
}

export function getScannerConfigById(id: ScannerId): ScannerConfig {
  return SCANNER_CONFIGS[id];
}

export function getGoogleScannerConfigById(id: GoogleScannerId): GoogleScannerConfig {
  const config = SCANNER_CONFIGS[id];
  if (!isGoogleScannerConfig(config)) {
    throw new Error(`Scanner ${id} is not a Google scanner`);
  }
  return config;
}

export function getScannerConfigBySource(source: ScanFindingSource): ScannerConfig {
  return SCANNER_CONFIGS[SCANNER_ID_BY_SOURCE[source]];
}

export function getGoogleScannerConfigBySource(source: GoogleFindingSource): GoogleScannerConfig {
  const config = SCANNER_CONFIGS[SCANNER_ID_BY_SOURCE[source]];
  if (!isGoogleScannerConfig(config)) {
    throw new Error(`Source ${source} is not Google-backed`);
  }
  return config;
}

export function getFindingSourceLabel(source: FindingSource): string {
  if (source === 'unknown') {
    return 'Unknown';
  }

  return getScannerConfigBySource(source).displayName;
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

  const specialistExclusions = Object.values(SCANNER_CONFIGS)
    .filter(isGoogleScannerConfig)
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
