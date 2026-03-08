import { FieldValue, type DocumentReference } from '@google-cloud/firestore';
import { db } from './firestore';
import {
  buildAppBaseUrl,
  buildBrandedEmailFrame,
  escapeHtml,
  MAILERSEND_FROM_EMAIL,
  MAILERSEND_FROM_NAME,
  normalizeEmailErrorMessage,
  normaliseEmail,
} from './email-branding';
import { sendMailerSendEmail } from './mailersend';
import { buildCountOnlyScanAiSummary, scanFromSnapshot } from './scans';
import type { BrandProfile, Scan, UserRecord } from './types';
import { formatScanDate } from './utils';

const SKIPPED_FINDINGS_EXPLAINER = 'Findings that appeared in other searches in this scan, or historical findings, were skipped';

type CountRowTone = 'high' | 'medium' | 'low' | 'neutral';

type ClaimScanSummaryEmailResult =
  | { kind: 'claimed'; scan: Scan; brand: BrandProfile; recipientEmail: string }
  | { kind: 'noop' }
  | { kind: 'already_handled' };

function buildScanSummaryDeepLink(brandId: string, scanId: string): string {
  return `${buildAppBaseUrl()}/brands/${encodeURIComponent(brandId)}#scan-result-set-${encodeURIComponent(scanId)}`;
}

function getCountRowStyles(tone: CountRowTone) {
  switch (tone) {
    case 'high':
      return {
        chipBackground: '#fef2f2',
        chipBorder: '#fecaca',
        chipText: '#dc2626',
      };
    case 'medium':
      return {
        chipBackground: '#fffbeb',
        chipBorder: '#fde68a',
        chipText: '#d97706',
      };
    case 'low':
      return {
        chipBackground: '#ecfdf5',
        chipBorder: '#a7f3d0',
        chipText: '#059669',
      };
    default:
      return {
        chipBackground: '#f0f9ff',
        chipBorder: '#bae6fd',
        chipText: '#0369a1',
      };
  }
}

function buildCountRows(scan: Scan) {
  return [
    { label: 'High', value: scan.highCount ?? 0, tone: 'high' as const },
    { label: 'Medium', value: scan.mediumCount ?? 0, tone: 'medium' as const },
    { label: 'Low', value: scan.lowCount ?? 0, tone: 'low' as const },
    { label: 'Non-findings', value: scan.nonHitCount ?? 0, tone: 'neutral' as const },
    { label: 'Skipped', value: scan.skippedCount ?? 0, tone: 'neutral' as const },
  ];
}

function buildScanSummaryEmailContent(scan: Scan, brand: BrandProfile) {
  const completedLabel = formatScanDate(scan.completedAt ?? scan.startedAt);
  const summary = scan.aiSummary?.trim() || buildCountOnlyScanAiSummary(scan);
  const deepLink = buildScanSummaryDeepLink(scan.brandId, scan.id);
  const countRows = buildCountRows(scan);

  const text = [
    `DoppelSpotter scan summary for ${brand.name}`,
    '',
    `Brand: ${brand.name}`,
    `Scan completed: ${completedLabel}`,
    '',
    'AI summary',
    summary,
    '',
    'Results',
    ...countRows.map((row) => `- ${row.label}: ${row.value}`),
    '',
    `Skipped: ${SKIPPED_FINDINGS_EXPLAINER}`,
    '',
    `View scan results: ${deepLink}`,
  ].join('\n');

  const html = buildBrandedEmailFrame({
    title: 'Scan summary',
    bodyHtml: `
      <div style="margin:0 0 18px;border:1px solid #dbeafe;border-radius:16px;background:linear-gradient(180deg,#f8fbff 0%,#eff6ff 100%);padding:18px 18px 16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0369a1;">Brand</div>
        <div style="margin-top:6px;font-size:22px;line-height:1.2;font-weight:700;color:#0f172a;">${escapeHtml(brand.name)}</div>
        <div style="margin-top:8px;font-size:13px;line-height:1.5;color:#475569;">Scan completed: <span style="color:#0f172a;font-weight:600;">${escapeHtml(completedLabel)}</span></div>
      </div>

      <div style="margin-bottom:18px;border:1px solid #dbeafe;border-radius:14px;background:#f8fbff;padding:16px 18px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0369a1;">AI summary</div>
        <p style="margin:10px 0 0;font-size:14px;line-height:1.65;color:#334155;">${escapeHtml(summary)}</p>
      </div>

      <div style="margin-bottom:20px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0369a1;">Result totals</div>
        <div style="margin-top:10px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff;overflow:hidden;">
          <table role="presentation" style="width:100%;border-collapse:collapse;">
            <tbody>
              ${countRows.map((row, index) => `
                <tr>
                  <td style="${index < countRows.length - 1 ? 'border-bottom:1px solid #edf2f7;' : ''}padding:11px 14px;font-size:14px;color:#475569;">
                    <span
                      style="display:inline-block;border:1px solid ${getCountRowStyles(row.tone).chipBorder};border-radius:9999px;background:${getCountRowStyles(row.tone).chipBackground};padding:5px 9px;font-size:12px;font-weight:700;line-height:1.2;color:${getCountRowStyles(row.tone).chipText};"
                    >
                      ${escapeHtml(row.label)}
                    </span>
                  </td>
                  <td style="${index < countRows.length - 1 ? 'border-bottom:1px solid #edf2f7;' : ''}padding:11px 14px;text-align:right;font-size:20px;line-height:1.1;font-weight:700;color:${row.label === 'Skipped' ? '#0f172a' : getCountRowStyles(row.tone).chipText};">${row.value}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <p style="margin:12px 0 0;border-left:3px solid #38bdf8;padding-left:12px;font-size:12px;line-height:1.6;color:#475569;">
          <strong>Skipped:</strong> ${escapeHtml(SKIPPED_FINDINGS_EXPLAINER)}
        </p>
      </div>

      <div style="margin-top:24px;border-top:1px solid #e2e8f0;padding-top:18px;">
        <a
          href="${escapeHtml(deepLink)}"
          style="display:inline-block;border-radius:9999px;background:#0284c7;padding:12px 18px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;"
        >
          View scan results
        </a>
        <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
          If the button does not work, open this link:<br />
          <a href="${escapeHtml(deepLink)}" style="color:#0f172a;text-decoration:underline;word-break:break-all;">${escapeHtml(deepLink)}</a>
        </p>
      </div>
    `,
  });

  return {
    subject: `DoppelSpotter scan summary for ${brand.name}`,
    html,
    text,
  };
}

async function claimScanSummaryEmailSend(scanRef: DocumentReference): Promise<ClaimScanSummaryEmailResult> {
  return db.runTransaction(async (tx) => {
    const scanSnap = await tx.get(scanRef);
    if (!scanSnap.exists) return { kind: 'noop' };

    const scan = scanFromSnapshot(scanSnap);
    if (scan.status !== 'completed') return { kind: 'noop' };

    if (
      scan.scanSummaryEmailStatus === 'sent'
      || scan.scanSummaryEmailStatus === 'sending'
      || scan.scanSummaryEmailStatus === 'skipped'
    ) {
      return { kind: 'already_handled' };
    }

    const brandRef = db.collection('brands').doc(scan.brandId);
    const userRef = db.collection('users').doc(scan.userId);
    const [brandSnap, userSnap] = await Promise.all([
      tx.get(brandRef),
      tx.get(userRef),
    ]);

    if (!brandSnap.exists) {
      tx.update(scanRef, {
        scanSummaryEmailStatus: 'failed',
        scanSummaryEmailAttemptedAt: FieldValue.serverTimestamp(),
        scanSummaryEmailError: 'Brand not found while preparing summary email',
      });
      return { kind: 'already_handled' };
    }

    const brand = brandSnap.data() as BrandProfile;
    if (!brand.sendScanSummaryEmails) {
      tx.update(scanRef, {
        scanSummaryEmailStatus: 'skipped',
        scanSummaryEmailAttemptedAt: FieldValue.serverTimestamp(),
        scanSummaryEmailError: FieldValue.delete(),
      });
      return { kind: 'already_handled' };
    }

    const user = userSnap.exists ? userSnap.data() as UserRecord : null;
    const recipientEmail = normaliseEmail(user?.email);
    if (!recipientEmail) {
      tx.update(scanRef, {
        scanSummaryEmailStatus: 'failed',
        scanSummaryEmailAttemptedAt: FieldValue.serverTimestamp(),
        scanSummaryEmailError: 'User email not found while preparing summary email',
      });
      return { kind: 'already_handled' };
    }

    tx.update(scanRef, {
      scanSummaryEmailStatus: 'sending',
      scanSummaryEmailAttemptedAt: FieldValue.serverTimestamp(),
      scanSummaryEmailError: FieldValue.delete(),
    });

    return { kind: 'claimed', scan, brand, recipientEmail };
  });
}

export async function sendCompletedScanSummaryEmailIfNeeded(scanRef: DocumentReference): Promise<void> {
  const claim = await claimScanSummaryEmailSend(scanRef);
  if (claim.kind !== 'claimed') return;

  const content = buildScanSummaryEmailContent(claim.scan, claim.brand);

  try {
    const result = await sendMailerSendEmail({
      from: {
        email: MAILERSEND_FROM_EMAIL,
        name: MAILERSEND_FROM_NAME,
      },
      to: [{ email: claim.recipientEmail }],
      subject: content.subject,
      html: content.html,
      text: content.text,
    });

    await scanRef.update({
      scanSummaryEmailStatus: 'sent',
      scanSummaryEmailSentAt: FieldValue.serverTimestamp(),
      scanSummaryEmailMessageId: result.messageId ?? FieldValue.delete(),
      scanSummaryEmailError: FieldValue.delete(),
    });
  } catch (error) {
    const message = normalizeEmailErrorMessage(error);
    console.error(`[scan-summary-email] Failed to send email for scan ${claim.scan.id}:`, error);

    await scanRef.update({
      scanSummaryEmailStatus: 'failed',
      scanSummaryEmailError: message,
    });
  }
}
