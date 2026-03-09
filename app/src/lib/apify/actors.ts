import {
  getEnabledScannerConfigs,
  DOMAIN_REGISTRATIONS_ACTOR_ID,
  getScannerConfigById,
  GOOGLE_SEARCH_ACTOR_ID,
  X_TWEET_SCRAPER_ACTOR_ID,
  DISCORD_SERVER_SCRAPER_ACTOR_ID,
  GITHUB_REPO_SEARCH_ACTOR_ID,
  type ScannerConfig,
} from '@/lib/scan-sources';
import type { BrandScanSources, ScannerId } from '@/lib/types';

export type ActorConfig = ScannerConfig;

export const CORE_SCANNER_IDS: ScannerId[] = [
  'google-web',
  'google-reddit',
  'google-tiktok',
  'google-youtube',
  'google-facebook',
  'google-instagram',
  'google-telegram',
  'google-apple-app-store',
  'google-play',
  'domain-registrations',
  'discord-servers',
  'github-repos',
  'x-search',
];

export function getActorConfigByScannerId(scannerId: ScannerId): ActorConfig {
  return getScannerConfigById(scannerId);
}

export function getTargetActorConfigs(scanSources?: BrandScanSources): ActorConfig[] {
  return getEnabledScannerConfigs(scanSources);
}

export {
  DISCORD_SERVER_SCRAPER_ACTOR_ID,
  DOMAIN_REGISTRATIONS_ACTOR_ID,
  GITHUB_REPO_SEARCH_ACTOR_ID,
  GOOGLE_SEARCH_ACTOR_ID,
  X_TWEET_SCRAPER_ACTOR_ID,
};
