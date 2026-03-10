import type {
  BrandAnalysisSeverityDefinitions,
  ResolvedBrandAnalysisSeverityDefinitions,
  Severity,
} from '@/lib/types';

export const MAX_ANALYSIS_SEVERITY_DEFINITION_LENGTH = 1500;

export const DEFAULT_ANALYSIS_SEVERITY_DEFINITIONS: ResolvedBrandAnalysisSeverityDefinitions = {
  high:
    'Clear impersonation, phishing, counterfeit activity, scam infrastructure, fake official claims, or other direct brand misuse posing immediate risk to customers or the brand.',
  medium:
    'Suspicious activity, risky associations, or misleading brand references that warrant investigation but may still have a legitimate explanation.',
  low:
    'Likely benign mention, commentary, or peripheral reference worth logging, but with limited evidence of harmful intent or brand abuse.',
};

export const ANALYSIS_SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low'];

export function getAnalysisSeverityDefinitionError(value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'Severity definitions must be strings';
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Severity definitions cannot be empty';
  }

  if (trimmed.length > MAX_ANALYSIS_SEVERITY_DEFINITION_LENGTH) {
    return `Severity definitions cannot exceed ${MAX_ANALYSIS_SEVERITY_DEFINITION_LENGTH} characters`;
  }

  return null;
}

export function isValidBrandAnalysisSeverityDefinitions(
  value: unknown,
): value is BrandAnalysisSeverityDefinitions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const definitions = value as Record<string, unknown>;
  return ANALYSIS_SEVERITY_ORDER.every((severity) => {
    const next = definitions[severity];
    return next === undefined || getAnalysisSeverityDefinitionError(next) === null;
  });
}

export function normalizeBrandAnalysisSeverityDefinitions(value: unknown): BrandAnalysisSeverityDefinitions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const definitions = value as Record<string, unknown>;
  const normalized: BrandAnalysisSeverityDefinitions = {};

  for (const severity of ANALYSIS_SEVERITY_ORDER) {
    const next = definitions[severity];
    if (typeof next !== 'string') {
      continue;
    }

    const trimmed = next.trim();
    if (trimmed.length === 0) {
      continue;
    }

    normalized[severity] = trimmed;
  }

  return normalized;
}

export function resolveBrandAnalysisSeverityDefinitions(
  value: unknown,
): ResolvedBrandAnalysisSeverityDefinitions {
  const normalized = normalizeBrandAnalysisSeverityDefinitions(value);

  return {
    high: normalized.high ?? DEFAULT_ANALYSIS_SEVERITY_DEFINITIONS.high,
    medium: normalized.medium ?? DEFAULT_ANALYSIS_SEVERITY_DEFINITIONS.medium,
    low: normalized.low ?? DEFAULT_ANALYSIS_SEVERITY_DEFINITIONS.low,
  };
}

export function hasCustomBrandAnalysisSeverityDefinitions(value: unknown): boolean {
  return Object.keys(normalizeBrandAnalysisSeverityDefinitions(value)).length > 0;
}

export function isCustomBrandAnalysisSeverityDefinition(
  severity: Severity,
  value: unknown,
): boolean {
  const normalized = normalizeBrandAnalysisSeverityDefinitions(value);
  return typeof normalized[severity] === 'string';
}
