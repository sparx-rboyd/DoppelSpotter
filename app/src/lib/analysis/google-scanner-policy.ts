import type { GoogleScannerConfig } from '@/lib/scan-sources';

export function buildGoogleClassificationSurfaceLine(scanner: GoogleScannerConfig): string {
  if (scanner.source !== 'google') {
    return `Monitoring surface: ${scanner.displayName} specialist scan (Google-powered)`;
  }

  return 'Monitoring surface: Web search';
}

export function buildGoogleDeepSearchSystemPolicy(scanner: GoogleScannerConfig): string {
  if (scanner.source === 'google') {
    return '';
  }

  return [
    `- This is a ${scanner.displayName} specialist scan.`,
    `- Suggest follow-up queries that are specifically useful for finding ${scanner.displayName} misuse or impersonation.`,
    '- Do NOT include explicit site: operators in your output; platform scoping is applied automatically.',
  ].join('\n');
}

export function buildGoogleDeepSearchUserPolicy(scanner: GoogleScannerConfig): string | null {
  if (scanner.source === 'google') {
    return null;
  }

  return [
    `Specialist scan focus: ${scanner.displayName}`,
    `Keep your follow-up ideas focused on ${scanner.displayName}-specific misuse patterns.`,
    'Do not add explicit site: operators to the query text you return.',
  ].join('\n');
}
