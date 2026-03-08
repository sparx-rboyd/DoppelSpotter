import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import {
  Document,
  Font,
  Image,
  Link,
  Page,
  Path,
  StyleSheet,
  Svg,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import { getFindingSourceLabel } from './scan-sources';
import { buildCountOnlyScanAiSummary } from './scans';
import {
  filterActionableFindings,
  filterAddressedFindings,
  groupFindingsBySeverity,
  orderFindingsForExport,
  type ExportableFinding,
  type ScanExportData,
} from './scan-exports';
import type { FindingSource, Severity } from './types';
import { formatScanDate } from './utils';

const BRAND = {
  blue50: '#eff6ff',
  blue100: '#dbeafe',
  blue200: '#bfdbfe',
  blue600: '#2563eb',
  blue700: '#1d4ed8',
  slate50: '#f8fafc',
  slate100: '#f1f5f9',
  slate200: '#e2e8f0',
  slate400: '#94a3b8',
  slate500: '#64748b',
  slate700: '#334155',
  slate900: '#0f172a',
  white: '#ffffff',
} as const;

const SEVERITY_STYLES: Record<Severity, { label: string; bg: string; border: string; text: string }> = {
  high: {
    label: 'High',
    bg: '#fef2f2',
    border: '#fecaca',
    text: '#b91c1c',
  },
  medium: {
    label: 'Medium',
    bg: '#fffbeb',
    border: '#fde68a',
    text: '#b45309',
  },
  low: {
    label: 'Low',
    bg: '#ecfdf5',
    border: '#a7f3d0',
    text: '#047857',
  },
};

const SOURCE_BADGE_STYLES: Record<FindingSource, { bg: string; border: string; text: string }> = {
  google: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  reddit: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  tiktok: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  youtube: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  facebook: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  instagram: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  telegram: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  discord: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  github: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  x: {
    bg: BRAND.blue50,
    border: BRAND.blue100,
    text: BRAND.blue700,
  },
  unknown: {
    bg: BRAND.slate100,
    border: BRAND.slate200,
    text: BRAND.slate700,
  },
};

let logoDataUriPromise: Promise<string | null> | null = null;
let registeredPdfFontFamily: 'Inter' | 'Helvetica' | null = null;

const INTER_FONT_FILES = [
  {
    relativePath: path.join('node_modules', '@fontsource', 'inter', 'files', 'inter-latin-400-normal.woff'),
    fontWeight: 400,
  },
  {
    relativePath: path.join('node_modules', '@fontsource', 'inter', 'files', 'inter-latin-500-normal.woff'),
    fontWeight: 500,
  },
  {
    relativePath: path.join('node_modules', '@fontsource', 'inter', 'files', 'inter-latin-600-normal.woff'),
    fontWeight: 600,
  },
  {
    relativePath: path.join('node_modules', '@fontsource', 'inter', 'files', 'inter-latin-700-normal.woff'),
    fontWeight: 700,
  },
] as const;

function ensurePdfFontFamily(): 'Inter' | 'Helvetica' {
  if (registeredPdfFontFamily) return registeredPdfFontFamily;

  const interFonts = INTER_FONT_FILES.map(({ relativePath, fontWeight }) => ({
    src: path.join(process.cwd(), relativePath),
    fontWeight,
  }));

  if (interFonts.every(({ src }) => existsSync(src))) {
    Font.register({
      family: 'Inter',
      fonts: interFonts,
    });
    registeredPdfFontFamily = 'Inter';
    return registeredPdfFontFamily;
  }

  console.warn('PDF export Inter font files are unavailable at runtime; falling back to Helvetica.');
  registeredPdfFontFamily = 'Helvetica';
  return registeredPdfFontFamily;
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: BRAND.slate50,
    color: BRAND.slate900,
    fontFamily: 'Inter',
    fontSize: 10,
    lineHeight: 1.45,
    paddingTop: 24,
    paddingBottom: 32,
    paddingHorizontal: 24,
  },
  header: {
    backgroundColor: BRAND.blue600,
    borderRadius: 18,
    color: BRAND.white,
    marginBottom: 14,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 18,
  },
  logo: {
    height: 18,
    marginBottom: 12,
    objectFit: 'contain',
    width: 120,
  },
  logoFallback: {
    color: BRAND.white,
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 12,
  },
  headerEyebrow: {
    color: '#bfdbfe',
    fontSize: 7.25,
    fontWeight: 700,
    letterSpacing: 0.8,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  headerTitle: {
    color: BRAND.white,
    fontSize: 20,
    fontWeight: 700,
    lineHeight: 1.15,
  },
  headerMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
  },
  headerMetaItem: {
    backgroundColor: '#2e5fd3',
    borderRadius: 12,
    marginBottom: 8,
    marginRight: 8,
    minWidth: 180,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  headerMetaLabel: {
    color: '#bfdbfe',
    fontSize: 7,
    fontWeight: 700,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  headerMetaValue: {
    color: BRAND.white,
    fontSize: 10.5,
    fontWeight: 600,
    lineHeight: 1.3,
    marginTop: 3,
  },
  statRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  statCard: {
    borderRadius: 14,
    borderStyle: 'solid',
    borderWidth: 1,
    marginBottom: 8,
    marginRight: 8,
    minHeight: 62,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    width: '31.5%',
  },
  statLabel: {
    color: BRAND.slate500,
    fontSize: 7.25,
    fontWeight: 700,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  statValue: {
    color: BRAND.slate900,
    fontSize: 16,
    fontWeight: 700,
    lineHeight: 1.1,
    marginTop: 6,
  },
  statSubtle: {
    color: BRAND.slate500,
    fontSize: 8,
    marginTop: 4,
  },
  sectionCard: {
    backgroundColor: BRAND.white,
    borderColor: BRAND.slate200,
    borderRadius: 14,
    borderStyle: 'solid',
    borderWidth: 1,
    marginBottom: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
  },
  sectionEyebrow: {
    color: BRAND.blue700,
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 0.8,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  sectionHeading: {
    color: BRAND.slate900,
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1.2,
  },
  sectionDescription: {
    color: BRAND.slate500,
    fontSize: 9,
    lineHeight: 1.35,
    marginTop: 4,
  },
  summaryText: {
    color: BRAND.slate700,
    fontSize: 10,
    lineHeight: 1.55,
    marginTop: 10,
  },
  severitySection: {
    marginTop: 12,
  },
  severityHeader: {
    borderRadius: 10,
    borderStyle: 'solid',
    borderWidth: 1,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 6,
  },
  severityHeaderText: {
    fontSize: 9.5,
    fontWeight: 600,
    lineHeight: 1.15,
  },
  findingCard: {
    backgroundColor: BRAND.white,
    borderColor: BRAND.slate200,
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingTop: 11,
    paddingBottom: 12,
  },
  findingNumber: {
    color: BRAND.slate400,
    fontSize: 7.25,
    fontWeight: 600,
    letterSpacing: 0.6,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  findingTitle: {
    color: BRAND.slate900,
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.32,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  badgeItem: {
    marginBottom: 6,
    marginRight: 6,
  },
  badge: {
    alignItems: 'center',
    borderRadius: 999,
    borderStyle: 'solid',
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 24,
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 4,
  },
  badgeIcon: {
    height: 10,
    marginRight: 5,
    width: 10,
  },
  badgeText: {
    fontSize: 8.25,
    fontWeight: 600,
    lineHeight: 1.2,
  },
  findingUrlPanel: {
    backgroundColor: BRAND.slate50,
    borderColor: BRAND.slate200,
    borderRadius: 10,
    borderStyle: 'solid',
    borderWidth: 1,
    marginTop: 2,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
  },
  metaLabel: {
    color: BRAND.slate500,
    fontSize: 7,
    fontWeight: 700,
    letterSpacing: 0.7,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  findingUrl: {
    color: BRAND.blue600,
    fontSize: 8.5,
    lineHeight: 1.35,
    textDecoration: 'underline',
  },
  findingPanel: {
    borderRadius: 10,
    borderStyle: 'solid',
    borderWidth: 1,
    marginTop: 8,
    paddingTop: 8,
    paddingRight: 10,
    paddingBottom: 8,
    paddingLeft: 12,
  },
  panelLabel: {
    color: BRAND.blue700,
    fontSize: 7.25,
    fontWeight: 700,
    letterSpacing: 0.7,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  findingBodyText: {
    color: BRAND.slate700,
    fontSize: 9,
    lineHeight: 1.5,
  },
  emptyState: {
    color: BRAND.slate500,
    fontSize: 9,
    lineHeight: 1.45,
    marginTop: 2,
  },
});

async function getLogoDataUri(): Promise<string | null> {
  if (!logoDataUriPromise) {
    logoDataUriPromise = readFile(path.join(process.cwd(), 'public', 'logo-white.png'))
      .then((buffer) => `data:image/png;base64,${buffer.toString('base64')}`)
      .catch(() => null);
  }

  return logoDataUriPromise;
}

function wrapPdfUrl(value: string): string {
  return value.replace(/([/?&#=._-])/g, '$1\u200b');
}

function SourceIcon({ source, color }: { source: FindingSource; color: string }) {
  if (source === 'reddit') {
    return (
      <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
        <Path
          d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z"
          fill={color}
        />
      </Svg>
    );
  }

  if (source === 'tiktok') {
    return (
      <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
        <Path
          d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"
          fill={color}
        />
      </Svg>
    );
  }

  if (source === 'youtube') {
    return (
      <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
        <Path
          d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"
          fill={color}
        />
      </Svg>
    );
  }

  if (source === 'facebook') {
    return (
      <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
        <Path
          d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"
          fill={color}
        />
      </Svg>
    );
  }

  if (source === 'instagram') {
    return (
      <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
        <Path
          d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077"
          fill={color}
        />
      </Svg>
    );
  }

  if (source === 'telegram') {
    return (
      <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
        <Path
          d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
          fill={color}
        />
      </Svg>
    );
  }

  if (source === 'discord') {
    return (
      <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
        <Path
          d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.211.375-.445.865-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.2 12.2 0 0 0-.618-1.25a.077.077 0 0 0-.078-.037a19.74 19.74 0 0 0-4.885 1.515a.07.07 0 0 0-.032.028C.533 9.046-.319 13.58.099 18.058a.082.082 0 0 0 .031.056c2.053 1.508 4.041 2.423 5.993 3.029a.078.078 0 0 0 .084-.028a13.4 13.4 0 0 0 1.226-1.994a.076.076 0 0 0-.042-.106a12.3 12.3 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.011c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.01c.12.099.246.198.373.292a.077.077 0 0 1-.007.128a12.3 12.3 0 0 1-1.873.891a.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029c1.961-.607 3.95-1.522 6.002-3.029a.077.077 0 0 0 .031-.055c.5-5.177-.838-9.674-3.548-13.66a.061.061 0 0 0-.031-.029ZM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419s.956-2.419 2.157-2.419c1.211 0 2.176 1.095 2.157 2.419c0 1.333-.956 2.419-2.157 2.419Zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419s.955-2.419 2.157-2.419c1.211 0 2.176 1.095 2.157 2.419c0 1.333-.946 2.419-2.157 2.419Z"
          fill={color}
        />
      </Svg>
    );
  }

  if (source === 'github') {
    return (
      <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
        <Path
          d="M12 .297a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58l-.01-2.04c-3.34.73-4.04-1.61-4.04-1.61a3.18 3.18 0 0 0-1.34-1.76c-1.09-.75.08-.73.08-.73a2.52 2.52 0 0 1 1.84 1.24a2.55 2.55 0 0 0 3.49 1a2.56 2.56 0 0 1 .76-1.6c-2.66-.3-5.47-1.33-5.47-5.93a4.64 4.64 0 0 1 1.23-3.22a4.3 4.3 0 0 1 .12-3.18s1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.28-1.23 3.28-1.23a4.3 4.3 0 0 1 .12 3.18a4.63 4.63 0 0 1 1.23 3.22c0 4.61-2.81 5.62-5.49 5.92a2.88 2.88 0 0 1 .82 2.24l-.01 3.32c0 .32.22.7.83.58A12 12 0 0 0 12 .297"
          fill={color}
        />
      </Svg>
    );
  }

  if (source === 'x') {
    return (
      <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
        <Path
          d="M18.901 1.153h3.68l-8.037 9.187L24 22.846h-7.406l-5.8-7.584l-6.639 7.584H.474l8.596-9.826L0 1.154h7.594l5.243 6.932zm-1.291 19.49h2.039L6.486 3.24H4.298z"
          fill={color}
        />
      </Svg>
    );
  }

  return (
    <Svg viewBox="0 0 24 24" style={styles.badgeIcon}>
      <Path d="M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20Z" fill="none" stroke={color} strokeWidth={1.8} />
      <Path d="M2.5 12h19" fill="none" stroke={color} strokeLinecap="round" strokeWidth={1.8} />
      <Path
        d="M12 2c2.6 2.6 4 6.2 4 10s-1.4 7.4-4 10c-2.6-2.6-4-6.2-4-10S9.4 4.6 12 2Z"
        fill="none"
        stroke={color}
        strokeWidth={1.8}
      />
    </Svg>
  );
}

function renderSourceBadge(source: FindingSource) {
  const tone = SOURCE_BADGE_STYLES[source];

  return (
    <View style={styles.badgeItem}>
      <View
        style={{
          ...styles.badge,
          backgroundColor: tone.bg,
          borderColor: tone.border,
        }}
      >
        <SourceIcon source={source} color={tone.text} />
        <Text style={{ ...styles.badgeText, color: tone.text }}>
          Scan type: {getFindingSourceLabel(source)}
        </Text>
      </View>
    </View>
  );
}

function renderThemeBadge(theme: string | undefined) {
  const label = theme?.trim() || 'Unlabelled';

  return (
    <View style={styles.badgeItem}>
      <View
        style={{
          ...styles.badge,
          backgroundColor: BRAND.slate100,
          borderColor: BRAND.slate200,
        }}
      >
        <Text style={{ ...styles.badgeText, color: BRAND.slate700 }}>Theme: {label}</Text>
      </View>
    </View>
  );
}

function renderFindingCard(finding: ExportableFinding, index: number) {
  const note = finding.bookmarkNote?.trim();

  return (
    <View key={`${finding.title}-${index}-${finding.url ?? 'no-url'}`} style={styles.findingCard} wrap={false}>
      <Text style={styles.findingNumber}>Finding {index + 1}</Text>
      <Text style={styles.findingTitle}>{finding.title}</Text>
      <View style={styles.badgeRow}>
        {renderSourceBadge(finding.source)}
        {renderThemeBadge(finding.theme)}
      </View>
      {finding.url && (
        <View style={styles.findingUrlPanel}>
          <Text style={styles.metaLabel}>URL</Text>
          <Link src={finding.url} style={styles.findingUrl}>
            {wrapPdfUrl(finding.url)}
          </Link>
        </View>
      )}
      <View
        style={{
          ...styles.findingPanel,
          backgroundColor: BRAND.blue50,
          borderColor: BRAND.blue100,
          borderLeftWidth: 3,
        }}
      >
        <Text style={styles.panelLabel}>AI analysis</Text>
        <Text style={styles.findingBodyText}>{finding.llmAnalysis}</Text>
      </View>
      {note && (
        <View
          style={{
            ...styles.findingPanel,
            backgroundColor: '#fff7ed',
            borderColor: '#fed7aa',
            borderLeftWidth: 3,
          }}
        >
          <Text style={{ ...styles.panelLabel, color: '#c2410c' }}>Notes</Text>
          <Text style={styles.findingBodyText}>{note}</Text>
        </View>
      )}
    </View>
  );
}

function renderSeveritySection({
  title,
  severity,
  findings,
  emptyMessage,
}: {
  title: string;
  severity: Severity;
  findings: ExportableFinding[];
  emptyMessage: string;
}) {
  const tone = SEVERITY_STYLES[severity];

  return (
    <View style={styles.severitySection}>
      <View
        style={{
          ...styles.severityHeader,
          backgroundColor: tone.bg,
          borderColor: tone.border,
        }}
        wrap={false}
      >
        <Text style={{ ...styles.severityHeaderText, color: tone.text }}>
          {title} ({findings.length})
        </Text>
      </View>
      {findings.length > 0
        ? findings.map((finding, index) => renderFindingCard(finding, index))
        : <Text style={styles.emptyState}>{emptyMessage}</Text>}
    </View>
  );
}

function ScanExportPdfDocument({
  data,
  fontFamily,
  logoSrc,
}: {
  data: ScanExportData;
  fontFamily: 'Inter' | 'Helvetica';
  logoSrc: string | null;
}) {
  const summary = data.scan.aiSummary?.trim() || buildCountOnlyScanAiSummary(data.scan);
  const actionableBySeverity = groupFindingsBySeverity(orderFindingsForExport(filterActionableFindings(data.findings)));
  const addressedBySeverity = groupFindingsBySeverity(orderFindingsForExport(filterAddressedFindings(data.findings)));
  const actionableCount = Object.values(actionableBySeverity).reduce((sum, findings) => sum + findings.length, 0);
  const addressedCount = Object.values(addressedBySeverity).reduce((sum, findings) => sum + findings.length, 0);

  return (
    <Document title={`DoppelSpotter scan report for ${data.brand.name}`} author="DoppelSpotter">
      <Page size="A4" style={{ ...styles.page, fontFamily }}>
        <View style={styles.header} wrap={false}>
          {logoSrc
            ? (
              // `@react-pdf/renderer` Image does not support DOM-style alt text props.
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image src={logoSrc} style={styles.logo} />
            )
            : <Text style={styles.logoFallback}>DoppelSpotter</Text>}
          <Text style={styles.headerEyebrow}>Brand protection scan report</Text>
          <Text style={styles.headerTitle}>Scan findings report</Text>
          <View style={styles.headerMetaRow}>
            <View style={styles.headerMetaItem}>
              <Text style={styles.headerMetaLabel}>Brand</Text>
              <Text style={styles.headerMetaValue}>{data.brand.name}</Text>
            </View>
            <View style={styles.headerMetaItem}>
              <Text style={styles.headerMetaLabel}>Scan date/time</Text>
              <Text style={styles.headerMetaValue}>{formatScanDate(data.scan.startedAt)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.statRow} wrap={false}>
          {(['high', 'medium', 'low'] as const).map((severity) => {
            const tone = SEVERITY_STYLES[severity];

            return (
              <View
                key={severity}
                style={{
                  ...styles.statCard,
                  backgroundColor: tone.bg,
                  borderColor: tone.border,
                }}
              >
                <Text style={{ ...styles.statLabel, color: tone.text }}>{tone.label} severity findings</Text>
                <Text style={{ ...styles.statValue, color: tone.text }}>
                  {actionableBySeverity[severity].length}
                </Text>
              </View>
            );
          })}
          <View
            style={{
              ...styles.statCard,
              backgroundColor: BRAND.blue50,
              borderColor: BRAND.blue100,
            }}
          >
            <Text style={{ ...styles.statLabel, color: BRAND.blue700 }}>Addressed findings</Text>
            <Text style={{ ...styles.statValue, color: BRAND.blue700 }}>{addressedCount}</Text>
          </View>
          <View
            style={{
              ...styles.statCard,
              backgroundColor: BRAND.white,
              borderColor: BRAND.slate200,
            }}
          >
            <Text style={styles.statLabel}>Total in report</Text>
            <Text style={styles.statValue}>{actionableCount + addressedCount}</Text>
          </View>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionEyebrow}>Overview</Text>
          <Text style={styles.sectionHeading}>Scan summary</Text>
          <Text style={styles.summaryText}>{summary}</Text>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionEyebrow}>Findings</Text>
          <Text style={styles.sectionHeading}>Scan findings</Text>
          {renderSeveritySection({
            title: 'High severity findings',
            severity: 'high',
            findings: actionableBySeverity.high,
            emptyMessage: 'No high-severity actionable findings were present in this scan.',
          })}
          {renderSeveritySection({
            title: 'Medium severity findings',
            severity: 'medium',
            findings: actionableBySeverity.medium,
            emptyMessage: 'No medium-severity actionable findings were present in this scan.',
          })}
          {renderSeveritySection({
            title: 'Low severity findings',
            severity: 'low',
            findings: actionableBySeverity.low,
            emptyMessage: 'No low-severity actionable findings were present in this scan.',
          })}
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionEyebrow}>Follow-up</Text>
          <Text style={styles.sectionHeading}>Addressed findings</Text>
          {renderSeveritySection({
            title: 'Addressed high severity findings',
            severity: 'high',
            findings: addressedBySeverity.high,
            emptyMessage: 'No addressed high-severity findings were present in this scan.',
          })}
          {renderSeveritySection({
            title: 'Addressed medium severity findings',
            severity: 'medium',
            findings: addressedBySeverity.medium,
            emptyMessage: 'No addressed medium-severity findings were present in this scan.',
          })}
          {renderSeveritySection({
            title: 'Addressed low severity findings',
            severity: 'low',
            findings: addressedBySeverity.low,
            emptyMessage: 'No addressed low-severity findings were present in this scan.',
          })}
        </View>
      </Page>
    </Document>
  );
}

export async function buildScanExportPdfBuffer(data: ScanExportData): Promise<Buffer> {
  const fontFamily = ensurePdfFontFamily();
  const logoSrc = await getLogoDataUri();
  return renderToBuffer(<ScanExportPdfDocument data={data} fontFamily={fontFamily} logoSrc={logoSrc} />);
}
