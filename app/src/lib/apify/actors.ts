import {
  getEnabledScannerConfigs,
  getScannerConfigById,
  GOOGLE_SEARCH_ACTOR_ID,
  X_TWEET_SCRAPER_ACTOR_ID,
  DISCORD_SERVER_SCRAPER_ACTOR_ID,
  GITHUB_REPO_SEARCH_ACTOR_ID,
  type ScannerConfig,
} from '@/lib/scan-sources';
import type { BrandProfile, ScannerId } from '@/lib/types';

export type ActorConfig = ScannerConfig;

export const CORE_SCANNER_IDS: ScannerId[] = [
  'google-web',
  'google-reddit',
  'google-tiktok',
  'google-youtube',
  'google-facebook',
  'google-instagram',
  'google-telegram',
  'discord-servers',
  'github-repos',
  'x-search',
];

export function getActorConfigByScannerId(scannerId: ScannerId): ActorConfig {
  return getScannerConfigById(scannerId);
}

export function getTargetActorConfigs(brand: BrandProfile): ActorConfig[] {
  return getEnabledScannerConfigs(brand.scanSources);
}

export {
  DISCORD_SERVER_SCRAPER_ACTOR_ID,
  GITHUB_REPO_SEARCH_ACTOR_ID,
  GOOGLE_SEARCH_ACTOR_ID,
  X_TWEET_SCRAPER_ACTOR_ID,
};
