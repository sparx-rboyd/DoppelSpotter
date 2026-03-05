import type { Timestamp } from '@google-cloud/firestore';

// ─── Users ──────────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Timestamp;
}

// ─── Brand Profile ─────────────────────────────────────────────────────────

export interface BrandProfile {
  id: string;
  userId: string;
  name: string;
  keywords: string[];
  officialDomains: string[];
  /** Terms the LLM should flag if found associated with the brand in search results. */
  watchWords?: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type BrandProfileCreateInput = Omit<BrandProfile, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;

// ─── Findings ──────────────────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'low';

export type FindingSource =
  | 'domain'
  | 'instagram'
  | 'twitter'
  | 'facebook'
  | 'tiktok'
  | 'google'
  | 'google-play'
  | 'app-store'
  | 'trademark'
  | 'unknown';

export interface Finding {
  id: string;
  scanId: string;
  brandId: string;
  userId: string;
  source: FindingSource;
  actorId: string;
  severity: Severity;
  title: string;
  description: string;
  llmAnalysis: string;
  url?: string;
  rawData: Record<string, unknown>;
  /** Set to true for LLM-classified false positives (not real threats). */
  isFalsePositive?: boolean;
  /** The raw JSON string returned by the LLM before parsing. */
  rawLlmResponse?: string;
  createdAt: Timestamp;
}

// ─── Scans ─────────────────────────────────────────────────────────────────

export type ScanStatus = 'pending' | 'running' | 'completed' | 'failed';

export type ActorRunStatus =
  | 'pending'
  | 'running'
  | 'fetching_dataset'
  | 'analysing'
  | 'succeeded'
  | 'failed';

export interface ActorRunInfo {
  actorId: string;
  source: FindingSource;
  /** Apify run status for this individual actor */
  status: ActorRunStatus;
  /** Total items in the dataset — set once the dataset has been fetched */
  itemCount?: number;
  /** Number of items that have completed LLM analysis so far */
  analysedCount?: number;
  /**
   * 0 = initial scan run; 1 = LLM-requested deep follow-up.
   * Deep searches are never spawned from depth > 0 (loop guard).
   */
  searchDepth?: number;
  /** The literal query string used for this run — set on deep follow-up runs */
  searchQuery?: string;
}

export interface Scan {
  id: string;
  brandId: string;
  userId: string;
  status: ScanStatus;
  /** The actor IDs requested for this scan */
  actorIds: string[];
  /** Flat array of Apify run IDs — used for Firestore array-contains queries in the webhook handler */
  actorRunIds?: string[];
  /** Per-actor run details, keyed by Apify run ID */
  actorRuns?: Record<string, ActorRunInfo>;
  /** How many actor runs have completed (succeeded or failed) — used to detect scan completion */
  completedRunCount?: number;
  findingCount: number;
  errorMessage?: string;
  startedAt: Timestamp;
  completedAt?: Timestamp;
}

// ─── LLM Analysis ──────────────────────────────────────────────────────────

export interface AnalysisResult {
  severity: Severity;
  title: string;
  llmAnalysis: string;
  isFalsePositive: boolean;
}

// ─── API response shapes ────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  code?: string;
}

export interface ApiSuccess<T> {
  data: T;
}
