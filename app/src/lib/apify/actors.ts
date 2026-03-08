import {
  getEnabledGoogleScannerConfigs,
  getGoogleScannerConfigById,
  GOOGLE_SEARCH_ACTOR_ID,
  type GoogleScannerConfig,
} from '@/lib/scan-sources';
import type { BrandProfile, GoogleScannerId } from '@/lib/types';

export type ActorConfig = GoogleScannerConfig;

export const CORE_SCANNER_IDS: GoogleScannerId[] = [
  'google-web',
  'google-reddit',
  'google-tiktok',
  'google-youtube',
  'google-facebook',
  'google-instagram',
];

export function getActorConfigByScannerId(scannerId: GoogleScannerId): ActorConfig {
  return getGoogleScannerConfigById(scannerId);
}

export function getTargetActorConfigs(brand: BrandProfile): ActorConfig[] {
  return getEnabledGoogleScannerConfigs(brand.scanSources);
}

export { GOOGLE_SEARCH_ACTOR_ID };
