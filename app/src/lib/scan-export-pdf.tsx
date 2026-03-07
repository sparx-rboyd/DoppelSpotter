import { readFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import {
  Document,
  Font,
  Image,
  Link,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import { buildCountOnlyScanAiSummary } from './scans';
import {
  filterActionableFindings,
  filterAddressedFindings,
  groupFindingsBySeverity,
  orderFindingsForExport,
  type ExportableFinding,
  type ScanExportData,
} from './scan-exports';
import type { Severity } from './types';
import { formatScanDate } from './utils';

const BRAND = {
  blue50: '#f0f9ff',
  blue100: '#e0f2fe',
  blue200: '#bae6fd',
  blue500: '#0ea5e9',
  blue600: '#0284c7',
  blue700: '#0369a1',
  blue900: '#0c4a6e',
  gray50: '#f9fafb',
  gray100: '#f3f4f6',
  gray200: '#e5e7eb',
  gray500: '#6b7280',
  gray700: '#374151',
  gray900: '#111827',
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

let fontsRegistered = false;
let logoDataUriPromise: Promise<string | null> | null = null;

function ensureFontsRegistered() {
  if (fontsRegistered) return;

  Font.register({
    family: 'Inter',
    fonts: [
      {
        src: path.join(process.cwd(), 'node_modules', '@fontsource', 'inter', 'files', 'inter-latin-400-normal.woff'),
        fontWeight: 400,
      },
      {
        src: path.join(process.cwd(), 'node_modules', '@fontsource', 'inter', 'files', 'inter-latin-500-normal.woff'),
        fontWeight: 500,
      },
      {
        src: path.join(process.cwd(), 'node_modules', '@fontsource', 'inter', 'files', 'inter-latin-600-normal.woff'),
        fontWeight: 600,
      },
      {
        src: path.join(process.cwd(), 'node_modules', '@fontsource', 'inter', 'files', 'inter-latin-700-normal.woff'),
        fontWeight: 700,
      },
    ],
  });

  fontsRegistered = true;
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: BRAND.gray50,
    color: BRAND.gray900,
    fontFamily: 'Inter',
    fontSize: 10,
    lineHeight: 1.4,
    paddingTop: 22,
    paddingBottom: 34,
    paddingHorizontal: 22,
  },
  header: {
    backgroundColor: BRAND.blue600,
    borderRadius: 14,
    color: BRAND.white,
    marginBottom: 12,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 14,
  },
  logo: {
    height: 20,
    marginBottom: 12,
    objectFit: 'contain',
    width: 132,
  },
  logoFallback: {
    color: BRAND.white,
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 12,
  },
  headerEyebrow: {
    color: '#dbeafe',
    fontSize: 7.5,
    fontWeight: 700,
    letterSpacing: 0.8,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  headerTitle: {
    color: BRAND.white,
    fontSize: 19,
    fontWeight: 700,
    lineHeight: 1.15,
  },
  headerSubtitle: {
    color: '#e0f2fe',
    fontSize: 9.5,
    lineHeight: 1.35,
    marginTop: 4,
  },
  card: {
    backgroundColor: BRAND.white,
    borderColor: BRAND.gray200,
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
  },
  metaCard: {
    backgroundColor: BRAND.white,
    borderColor: BRAND.blue100,
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
  },
  metaEyebrow: {
    color: BRAND.blue700,
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  brandName: {
    color: BRAND.gray900,
    fontSize: 17,
    fontWeight: 700,
    lineHeight: 1.2,
    marginTop: 4,
  },
  metaLabel: {
    color: BRAND.blue900,
    fontSize: 9,
    marginTop: 6,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  chipItem: {
    marginRight: 6,
    marginBottom: 6,
  },
  chip: {
    alignItems: 'center',
    borderRadius: 999,
    borderStyle: 'solid',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 22,
    paddingHorizontal: 8,
  },
  chipLabel: {
    fontSize: 8.5,
    fontWeight: 600,
    lineHeight: 1,
  },
  sectionTitle: {
    color: BRAND.blue700,
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 0.8,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  summaryText: {
    color: BRAND.gray700,
    fontSize: 10,
    lineHeight: 1.45,
  },
  severitySection: {
    marginBottom: 10,
  },
  severityHeader: {
    borderRadius: 8,
    borderStyle: 'solid',
    borderWidth: 1,
    marginBottom: 6,
    paddingHorizontal: 8,
    paddingTop: 5,
    paddingBottom: 5,
  },
  severityHeaderText: {
    fontSize: 9.5,
    fontWeight: 600,
    lineHeight: 1.15,
  },
  findingCard: {
    backgroundColor: BRAND.white,
    borderColor: BRAND.gray200,
    borderRadius: 10,
    borderStyle: 'solid',
    borderWidth: 1,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 9,
  },
  findingNumber: {
    color: BRAND.gray500,
    fontSize: 7.5,
    fontWeight: 600,
    letterSpacing: 0.5,
    marginBottom: 3,
    textTransform: 'uppercase',
  },
  findingTitle: {
    color: BRAND.gray900,
    fontSize: 10.5,
    fontWeight: 600,
    lineHeight: 1.3,
  },
  findingUrl: {
    color: BRAND.blue600,
    fontSize: 8.5,
    lineHeight: 1.3,
    marginTop: 4,
    textDecoration: 'underline',
  },
  findingBodyLabel: {
    color: BRAND.blue700,
    fontSize: 7.5,
    fontWeight: 700,
    letterSpacing: 0.5,
    marginTop: 7,
    textTransform: 'uppercase',
  },
  findingBodyText: {
    color: BRAND.gray700,
    fontSize: 9,
    lineHeight: 1.4,
    marginTop: 2,
  },
  noteBox: {
    backgroundColor: BRAND.blue50,
    borderColor: BRAND.blue100,
    borderRadius: 8,
    borderStyle: 'solid',
    borderWidth: 1,
    marginTop: 6,
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 6,
  },
  emptyState: {
    color: BRAND.gray500,
    fontSize: 9,
    lineHeight: 1.35,
  },
  footer: {
    bottom: 14,
    color: BRAND.gray500,
    fontSize: 7.5,
    left: 22,
    position: 'absolute',
    right: 22,
    textAlign: 'right',
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

function renderFindingCard(finding: ExportableFinding, index: number) {
  const note = finding.bookmarkNote?.trim();

  return (
    <View key={`${finding.title}-${index}-${finding.url ?? 'no-url'}`} style={styles.findingCard}>
      <Text style={styles.findingNumber}>Finding {index + 1}</Text>
      <Text style={styles.findingTitle}>{finding.title}</Text>
      {finding.url && (
        <Link src={finding.url} style={styles.findingUrl}>
          {wrapPdfUrl(finding.url)}
        </Link>
      )}
      <Text style={styles.findingBodyLabel}>AI analysis</Text>
      <Text style={styles.findingBodyText}>{finding.llmAnalysis}</Text>
      {note && (
        <View style={styles.noteBox}>
          <Text style={styles.findingBodyLabel}>Notes</Text>
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
  logoSrc,
}: {
  data: ScanExportData;
  logoSrc: string | null;
}) {
  const summary = data.scan.aiSummary?.trim() || buildCountOnlyScanAiSummary(data.scan);
  const actionableBySeverity = groupFindingsBySeverity(orderFindingsForExport(filterActionableFindings(data.findings)));
  const addressedBySeverity = groupFindingsBySeverity(orderFindingsForExport(filterAddressedFindings(data.findings)));
  const actionableCount = Object.values(actionableBySeverity).reduce((sum, findings) => sum + findings.length, 0);
  const addressedCount = Object.values(addressedBySeverity).reduce((sum, findings) => sum + findings.length, 0);

  return (
    <Document title={`DoppelSpotter scan report for ${data.brand.name}`} author="DoppelSpotter">
      <Page size="A4" style={styles.page}>
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
          <Text style={styles.headerSubtitle}>Actionable findings grouped by severity, with addressed items summarised separately.</Text>
        </View>

        <View style={styles.metaCard} wrap={false}>
          <Text style={styles.metaEyebrow}>Brand</Text>
          <Text style={styles.brandName}>{data.brand.name}</Text>
          <Text style={styles.metaLabel}>Scan date/time: {formatScanDate(data.scan.startedAt)}</Text>
        </View>

        <View style={styles.chipRow} wrap={false}>
          {(['high', 'medium', 'low'] as const).map((severity) => {
            const tone = SEVERITY_STYLES[severity];

            return (
              <View key={severity} style={styles.chipItem}>
                <View
                  style={{
                    ...styles.chip,
                    backgroundColor: tone.bg,
                    borderColor: tone.border,
                  }}
                >
                  <Text style={{ ...styles.chipLabel, color: tone.text }}>
                    {tone.label}: {actionableBySeverity[severity].length}
                  </Text>
                </View>
              </View>
            );
          })}
          <View style={styles.chipItem}>
            <View
              style={{
                ...styles.chip,
                backgroundColor: BRAND.blue50,
                borderColor: BRAND.blue200,
              }}
            >
              <Text style={{ ...styles.chipLabel, color: BRAND.blue700 }}>
                Addressed: {addressedCount}
              </Text>
            </View>
          </View>
          <View style={styles.chipItem}>
            <View
              style={{
                ...styles.chip,
                backgroundColor: BRAND.gray100,
                borderColor: BRAND.gray200,
              }}
            >
              <Text style={{ ...styles.chipLabel, color: BRAND.gray700 }}>
                Total in report: {actionableCount + addressedCount}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>AI summary</Text>
          <Text style={styles.summaryText}>{summary}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Findings</Text>
          {renderSeveritySection({
            title: 'High findings',
            severity: 'high',
            findings: actionableBySeverity.high,
            emptyMessage: 'No high-severity actionable findings were present in this scan.',
          })}
          {renderSeveritySection({
            title: 'Medium findings',
            severity: 'medium',
            findings: actionableBySeverity.medium,
            emptyMessage: 'No medium-severity actionable findings were present in this scan.',
          })}
          {renderSeveritySection({
            title: 'Low findings',
            severity: 'low',
            findings: actionableBySeverity.low,
            emptyMessage: 'No low-severity actionable findings were present in this scan.',
          })}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Addressed findings</Text>
          {renderSeveritySection({
            title: 'Addressed high findings',
            severity: 'high',
            findings: addressedBySeverity.high,
            emptyMessage: 'No addressed high-severity findings were present in this scan.',
          })}
          {renderSeveritySection({
            title: 'Addressed medium findings',
            severity: 'medium',
            findings: addressedBySeverity.medium,
            emptyMessage: 'No addressed medium-severity findings were present in this scan.',
          })}
          {renderSeveritySection({
            title: 'Addressed low findings',
            severity: 'low',
            findings: addressedBySeverity.low,
            emptyMessage: 'No addressed low-severity findings were present in this scan.',
          })}
        </View>

        <Text
          fixed
          style={styles.footer}
          render={({ pageNumber, totalPages }) => `DoppelSpotter report - Page ${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

export async function buildScanExportPdfBuffer(data: ScanExportData): Promise<Buffer> {
  ensureFontsRegistered();
  const logoSrc = await getLogoDataUri();
  return renderToBuffer(<ScanExportPdfDocument data={data} logoSrc={logoSrc} />);
}
