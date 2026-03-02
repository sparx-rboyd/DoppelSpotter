import type { FindingSource } from '@/lib/types';

export interface ActorConfig {
  actorId: string;
  source: FindingSource;
  displayName: string;
  /** Whether this actor is enabled by default in a core scan */
  enabledByDefault: boolean;
}

/**
 * Registry of all Apify actors used by DoppelSpotter.
 * v1 core actors are enabled by default; v2 stretch actors are opt-in.
 */
export const ACTOR_REGISTRY: ActorConfig[] = [
  // ─── v1 Core ──────────────────────────────────────────────────────────────
  {
    actorId: 'doppelspotter/whoisxml-brand-alert',
    source: 'domain',
    displayName: 'Newly-Registered Domains',
    enabledByDefault: true,
  },
  {
    actorId: 'apify/google-search-scraper',
    source: 'google',
    displayName: 'Google Search',
    enabledByDefault: true,
  },
  {
    actorId: 'apify/instagram-search-scraper',
    source: 'instagram',
    displayName: 'Instagram',
    enabledByDefault: true,
  },
  {
    actorId: 'data-slayer/twitter-search',
    source: 'twitter',
    displayName: 'Twitter / X',
    enabledByDefault: true,
  },
  {
    actorId: 'apify/facebook-search-scraper',
    source: 'facebook',
    displayName: 'Facebook',
    enabledByDefault: true,
  },
  {
    actorId: 'apilab/google-play-scraper',
    source: 'google-play',
    displayName: 'Google Play',
    enabledByDefault: true,
  },
  {
    actorId: 'dan.scraper/apple-app-store-search-scraper',
    source: 'app-store',
    displayName: 'Apple App Store',
    enabledByDefault: true,
  },
  {
    actorId: 'ryanclinton/euipo-trademark-search',
    source: 'trademark',
    displayName: 'EUIPO Trademark Register',
    enabledByDefault: false, // Requires separate credentials
  },

  // ─── v2 Stretch ───────────────────────────────────────────────────────────
  {
    actorId: 'crawlerbros/reddit-keywords',
    source: 'unknown',
    displayName: 'Reddit',
    enabledByDefault: false,
  },
  {
    actorId: 'apify/screenshot-url',
    source: 'unknown',
    displayName: 'Screenshot (Evidence)',
    enabledByDefault: false,
  },
  {
    actorId: 'salman_bareesh/whois-scraper',
    source: 'domain',
    displayName: 'WHOIS Enrichment',
    enabledByDefault: false,
  },
];

/** IDs of all default-enabled (core) actors */
export const CORE_ACTOR_IDS: string[] = ACTOR_REGISTRY
  .filter((a) => a.enabledByDefault)
  .map((a) => a.actorId);

/** Look up an actor config by its Apify actor ID */
export function getActorConfig(actorId: string): ActorConfig | undefined {
  return ACTOR_REGISTRY.find((a) => a.actorId === actorId);
}
