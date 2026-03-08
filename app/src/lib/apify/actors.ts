import type { FindingSource } from '@/lib/types';

export interface ActorConfig {
  actorId: string;
  source: FindingSource;
  displayName: string;
}

export const GOOGLE_SEARCH_ACTOR_ID = 'apify/google-search-scraper';

/** The only supported Apify actor in the current Google-only scan pipeline. */
export const GOOGLE_SEARCH_ACTOR: ActorConfig = {
  actorId: GOOGLE_SEARCH_ACTOR_ID,
  source: 'google',
  displayName: 'Google Search',
};

/** Registry kept for compatibility with scan/webhook lookup helpers. */
export const ACTOR_REGISTRY: ActorConfig[] = [
  GOOGLE_SEARCH_ACTOR,
];

/** IDs requested when a new scan starts. */
export const CORE_ACTOR_IDS: string[] = [GOOGLE_SEARCH_ACTOR_ID];

/** Look up an actor config by its Apify actor ID */
export function getActorConfig(actorId: string): ActorConfig | undefined {
  return ACTOR_REGISTRY.find((a) => a.actorId === actorId);
}
