import { FieldValue, type DocumentReference } from '@google-cloud/firestore';
import { db } from '@/lib/firestore';
import type {
  Finding,
  FindingSource,
  Scan,
  UserPreferenceHints,
  UserPreferenceSignal,
  UserPreferenceSignalReason,
} from '@/lib/types';
import { chatCompletion } from './openrouter';

const MIN_SIGNAL_EXAMPLES = 3;
const MAX_SIGNAL_EXAMPLES = 18;
const MAX_EXAMPLES_PER_SOURCE = 8;
const MAX_GLOBAL_HINTS = 1;
const MAX_SOURCE_HINTS_PER_SOURCE = 1;
const MAX_TEXT_LENGTH = 220;

const USER_PREFERENCE_HINTS_SYSTEM_PROMPT = `You summarise a user's explicit review actions into soft guidance for future brand-protection classification.

You will receive a compact list of recent explicit user-review signals for one brand. These come only from manual user actions such as ignoring a real finding or manually reclassifying a finding.

Your task is to infer a tiny set of soft tendencies about what this user appears to care more or less about.

You must respond with a raw JSON object matching this exact schema (no markdown, no code fences, just the JSON):
{
  "globalHints": ["Optional short hint"],
  "sourceHints": {
    "google": ["Optional short source-specific hint"],
    "reddit": ["Optional short source-specific hint"],
    "tiktok": ["Optional short source-specific hint"],
    "youtube": ["Optional short source-specific hint"],
    "facebook": ["Optional short source-specific hint"],
    "instagram": ["Optional short source-specific hint"],
    "discord": ["Optional short source-specific hint"]
  }
}

Rules:
- These are soft hints only, not hard rules.
- Do not mention or imply exact URLs, domains, usernames, or other specific identifiers.
- Do not instruct the classifier to always include or always ignore anything.
- Focus on recurring themes, not one-off examples.
- Keep each hint concise, natural, and under 24 words.
- Use British English.
- Return at most 1 global hint.
- Return at most 1 hint per source.
- If the evidence is too weak or inconsistent, return an empty JSON object {}.`;

type SignalFinding = Pick<
  Finding,
  | 'source'
  | 'title'
  | 'llmAnalysis'
  | 'url'
  | 'userPreferenceSignal'
  | 'userPreferenceSignalReason'
  | 'userPreferenceSignalAt'
>;

type SignalRecord = SignalFinding & { id: string };

type PreferenceHintExample = {
  source: FindingSource;
  signal: UserPreferenceSignal;
  reason: UserPreferenceSignalReason;
  title: string;
  summary: string;
  signalledAt: string;
};

type UserPreferenceHintsOutput = {
  globalHints?: string[];
  sourceHints?: Partial<Record<FindingSource, string[]>>;
};

export async function prepareUserPreferenceHintsForScan(params: {
  scanRef: DocumentReference;
  brandId: string;
  brandName: string;
  userId: string;
  targetSources: FindingSource[];
}): Promise<void> {
  const { scanRef, brandId, brandName, userId, targetSources } = params;

  await scanRef.update({
    userPreferenceHintsStatus: 'pending',
    userPreferenceHintsStartedAt: FieldValue.serverTimestamp(),
    userPreferenceHintsCompletedAt: FieldValue.delete(),
    userPreferenceHintsError: FieldValue.delete(),
    userPreferenceHints: FieldValue.delete(),
  });

  try {
    const hints = await buildUserPreferenceHints({
      brandId,
      brandName,
      userId,
      targetSources,
    });

    await scanRef.update({
      userPreferenceHintsStatus: 'ready',
      userPreferenceHints: hints,
      userPreferenceHintsError: FieldValue.delete(),
      userPreferenceHintsCompletedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await scanRef.update({
      userPreferenceHintsStatus: 'failed',
      userPreferenceHints: FieldValue.delete(),
      userPreferenceHintsError: toErrorMessage(error),
      userPreferenceHintsCompletedAt: FieldValue.serverTimestamp(),
    });
  }
}

export function areUserPreferenceHintsTerminal(scan: Pick<Scan, 'userPreferenceHintsStatus'>): boolean {
  return !scan.userPreferenceHintsStatus
    || scan.userPreferenceHintsStatus === 'ready'
    || scan.userPreferenceHintsStatus === 'failed';
}

async function buildUserPreferenceHints(params: {
  brandId: string;
  brandName: string;
  userId: string;
  targetSources: FindingSource[];
}): Promise<UserPreferenceHints> {
  const { brandId, brandName, userId, targetSources } = params;
  const uniqueTargetSources = uniqueSources(targetSources);
  const signalRecords = await loadSignalRecords({ brandId, userId });

  if (signalRecords.length < MIN_SIGNAL_EXAMPLES) {
    return {
      version: 1,
      generatedFromSignalCount: signalRecords.length,
      globalLines: [],
    };
  }

  const examples = buildPromptExamples(signalRecords, uniqueTargetSources);
  if (examples.length < MIN_SIGNAL_EXAMPLES) {
    return {
      version: 1,
      generatedFromSignalCount: signalRecords.length,
      globalLines: [],
    };
  }

  const prompt = buildUserPreferenceHintsPrompt({
    brandName,
    targetSources: uniqueTargetSources,
    examples,
  });
  const raw = await chatCompletion([
    { role: 'system', content: USER_PREFERENCE_HINTS_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);
  const parsed = parseUserPreferenceHintsOutput(raw, uniqueTargetSources);

  if (!parsed) {
    throw new Error(`Failed to parse user preference hints output: ${raw.slice(0, 200)}`);
  }

  return {
    version: 1,
    generatedFromSignalCount: signalRecords.length,
    globalLines: parsed.globalHints ?? [],
    ...(parsed.sourceHints && Object.keys(parsed.sourceHints).length > 0
      ? { sourceLines: parsed.sourceHints }
      : {}),
  };
}

async function loadSignalRecords(params: {
  brandId: string;
  userId: string;
}): Promise<SignalRecord[]> {
  const { brandId, userId } = params;

  const [positiveSnap, negativeSnap] = await Promise.all([
    db
      .collection('findings')
      .where('brandId', '==', brandId)
      .where('userId', '==', userId)
      .where('userPreferenceSignal', '==', 'positive')
      .select('source', 'title', 'llmAnalysis', 'url', 'userPreferenceSignal', 'userPreferenceSignalReason', 'userPreferenceSignalAt')
      .get(),
    db
      .collection('findings')
      .where('brandId', '==', brandId)
      .where('userId', '==', userId)
      .where('userPreferenceSignal', '==', 'negative')
      .select('source', 'title', 'llmAnalysis', 'url', 'userPreferenceSignal', 'userPreferenceSignalReason', 'userPreferenceSignalAt')
      .get(),
  ]);

  const records = [...positiveSnap.docs, ...negativeSnap.docs]
    .map((doc) => ({ id: doc.id, ...(doc.data() as SignalFinding) }))
    .filter((record): record is SignalRecord =>
      typeof record.source === 'string'
      && typeof record.title === 'string'
      && typeof record.llmAnalysis === 'string'
      && (record.userPreferenceSignal === 'positive' || record.userPreferenceSignal === 'negative')
      && typeof record.userPreferenceSignalReason === 'string'
      && typeof record.userPreferenceSignalAt?.toMillis === 'function',
    )
    .sort((left, right) => right.userPreferenceSignalAt!.toMillis() - left.userPreferenceSignalAt!.toMillis());

  const deduped = new Map<string, SignalRecord>();
  for (const record of records) {
    const key = `${record.userPreferenceSignal}:${record.userPreferenceSignalReason}:${record.source}:${record.url?.trim().toLowerCase() || `doc:${record.id}`}`;
    if (!deduped.has(key)) {
      deduped.set(key, record);
    }
  }

  return Array.from(deduped.values());
}

function buildPromptExamples(
  signalRecords: SignalRecord[],
  targetSources: FindingSource[],
): PreferenceHintExample[] {
  const targetSourceSet = new Set(targetSources);
  const perSourceCount = new Map<FindingSource, number>();

  return signalRecords
    .sort((left, right) => {
      const leftTarget = targetSourceSet.has(left.source) ? 1 : 0;
      const rightTarget = targetSourceSet.has(right.source) ? 1 : 0;
      if (leftTarget !== rightTarget) {
        return rightTarget - leftTarget;
      }

      return right.userPreferenceSignalAt!.toMillis() - left.userPreferenceSignalAt!.toMillis();
    })
    .filter((record) => {
      const currentCount = perSourceCount.get(record.source) ?? 0;
      if (currentCount >= MAX_EXAMPLES_PER_SOURCE) {
        return false;
      }
      perSourceCount.set(record.source, currentCount + 1);
      return true;
    })
    .slice(0, MAX_SIGNAL_EXAMPLES)
    .map((record) => ({
      source: record.source,
      signal: record.userPreferenceSignal!,
      reason: record.userPreferenceSignalReason!,
      title: truncateText(record.title, 120),
      summary: truncateText(record.llmAnalysis, MAX_TEXT_LENGTH),
      signalledAt: record.userPreferenceSignalAt!.toDate().toISOString(),
    }));
}

function buildUserPreferenceHintsPrompt(params: {
  brandName: string;
  targetSources: FindingSource[];
  examples: PreferenceHintExample[];
}): string {
  const { brandName, targetSources, examples } = params;

  return `Brand being protected: "${brandName}"

Monitoring surfaces in this scan:
${targetSources.length > 0 ? targetSources.map((source) => `- ${source}`).join('\n') : '- unknown'}

Recent explicit user-review signals (${examples.length}):
${JSON.stringify(examples, null, 2)}

Summarise only soft recurring tendencies that may help future classification.`;
}

function parseUserPreferenceHintsOutput(
  raw: string,
  allowedSources: FindingSource[],
): UserPreferenceHintsOutput | null {
  try {
    const parsed = JSON.parse(stripJsonFences(raw));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const output = parsed as Record<string, unknown>;
    const globalHints = normalizeHintLines(output.globalHints, MAX_GLOBAL_HINTS);
    const sourceHintsValue = output.sourceHints;
    const sourceHints: Partial<Record<FindingSource, string[]>> = {};

    if (typeof sourceHintsValue === 'object' && sourceHintsValue !== null) {
      for (const source of allowedSources) {
        const lines = normalizeHintLines((sourceHintsValue as Record<string, unknown>)[source], MAX_SOURCE_HINTS_PER_SOURCE);
        if (lines.length > 0) {
          sourceHints[source] = lines;
        }
      }
    }

    return {
      ...(globalHints.length > 0 ? { globalHints } : {}),
      ...(Object.keys(sourceHints).length > 0 ? { sourceHints } : {}),
    };
  } catch {
    return null;
  }
}

function normalizeHintLines(value: unknown, maxLines: number): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = truncateText(entry.replace(/\s+/g, ' ').trim(), 180);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(normalized);
    if (lines.length >= maxLines) break;
  }

  return lines;
}

function uniqueSources(sources: FindingSource[]): FindingSource[] {
  const seen = new Set<FindingSource>();
  const unique: FindingSource[] = [];
  for (const source of sources) {
    if (seen.has(source)) continue;
    seen.add(source);
    unique.push(source);
  }
  return unique;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return 'Failed to prepare user preference hints';
}
