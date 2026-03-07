import { FieldValue, type DocumentReference } from '@google-cloud/firestore';
import { db } from './firestore';
import { sendMailerSendEmail } from './mailersend';
import { buildCountOnlyScanAiSummary, scanFromSnapshot } from './scans';
import type { BrandProfile, Scan, UserRecord } from './types';
import { formatScanDate } from './utils';

const MAILERSEND_FROM_EMAIL = 'noreply@doppelspotter.com';
const MAILERSEND_FROM_NAME = 'DoppelSpotter';
const SKIPPED_FINDINGS_EXPLAINER = 'Findings that appeared in previous scans were skipped.';

type CountRowTone = 'high' | 'medium' | 'low' | 'neutral';

type ClaimScanSummaryEmailResult =
  | { kind: 'claimed'; scan: Scan; brand: BrandProfile; recipientEmail: string }
  | { kind: 'noop' }
  | { kind: 'already_handled' };

function buildAppBaseUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

function buildScanSummaryDeepLink(brandId: string, scanId: string): string {
  return `${buildAppBaseUrl()}/brands/${encodeURIComponent(brandId)}#scan-result-set-${encodeURIComponent(scanId)}`;
}

function buildEmailBrandLockupHtml() {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td style="padding:0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td style="border:2px solid #0284c7;border-radius:10px;background:#f0f9ff;width:30px;height:30px;text-align:center;vertical-align:middle;">
                <span style="display:inline-block;width:10px;height:10px;border-radius:9999px;background:#0284c7;"></span>
              </td>
              <td style="padding-left:10px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:24px;line-height:1;font-weight:700;letter-spacing:-0.3px;color:#111827;white-space:nowrap;">
                DoppelSpotter
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `.trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normaliseEmail(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
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
    { label: 'Non-hits', value: scan.nonHitCount ?? 0, tone: 'neutral' as const },
    { label: 'Skipped', value: scan.skippedCount ?? 0, tone: 'neutral' as const },
  ];
}

function buildScanSummaryEmailContent(scan: Scan, brand: BrandProfile) {
  const completedLabel = formatScanDate(scan.completedAt ?? scan.startedAt);
  const summary = scan.aiSummary?.trim() || buildCountOnlyScanAiSummary(scan);
  const deepLink = buildScanSummaryDeepLink(scan.brandId, scan.id);
  const countRows = buildCountRows(scan);
  const brandLockupHtml = buildEmailBrandLockupHtml();

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

  const html = `
    <div style="margin:0;background:#f0f9ff;padding:24px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
      <div style="margin:0 auto;max-width:640px;overflow:hidden;border:1px solid #e5e7eb;border-radius:20px;background:#ffffff;">
        <div style="background:linear-gradient(135deg,#0369a1 0%,#0284c7 52%,#0ea5e9 100%);padding:28px 32px;color:#ffffff;">
          <div style="display:inline-block;border-radius:14px;background:#ffffff;padding:12px 16px;">
            ${brandLockupHtml}
          </div>
          <h1 style="margin:20px 0 0;font-size:30px;line-height:1.15;color:#ffffff;">Scan summary</h1>
        </div>
        <div style="padding:32px;">
          <div style="margin:0 0 24px;border:1px solid #e0f2fe;border-radius:16px;background:#f0f9ff;padding:20px;">
            <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0369a1;">Brand</div>
            <div style="margin-top:8px;font-size:24px;font-weight:700;color:#111827;">${escapeHtml(brand.name)}</div>
            <div style="margin-top:8px;font-size:14px;color:#0c4a6e;">Scan completed: ${escapeHtml(completedLabel)}</div>
          </div>

          <div style="margin-bottom:24px;">
            <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0369a1;">AI summary</div>
            <p style="margin:12px 0 0;font-size:15px;line-height:1.7;color:#111827;">${escapeHtml(summary)}</p>
          </div>

          <div style="margin-bottom:24px;">
            <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0369a1;">Result totals</div>
            <table role="presentation" style="margin-top:12px;width:100%;border-collapse:collapse;">
              <tbody>
                ${countRows.map((row) => `
                  <tr>
                    <td style="border-bottom:1px solid #e5e7eb;padding:12px 0;font-size:14px;color:#4b5563;">
                      <span
                        style="display:inline-block;border:1px solid ${getCountRowStyles(row.tone).chipBorder};border-radius:9999px;background:${getCountRowStyles(row.tone).chipBackground};padding:6px 10px;font-size:13px;font-weight:700;color:${getCountRowStyles(row.tone).chipText};"
                      >
                        ${escapeHtml(row.label)}
                      </span>
                    </td>
                    <td style="border-bottom:1px solid #e5e7eb;padding:12px 0;text-align:right;font-size:18px;font-weight:700;color:${getCountRowStyles(row.tone).chipText};">${row.value}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            <p style="margin:14px 0 0;border-left:3px solid #0ea5e9;padding-left:12px;font-size:13px;line-height:1.6;color:#0c4a6e;">
              <strong>Skipped:</strong> ${escapeHtml(SKIPPED_FINDINGS_EXPLAINER)}
            </p>
          </div>

          <div style="margin-top:32px;">
            <a
              href="${escapeHtml(deepLink)}"
              style="display:inline-block;border-radius:9999px;background:#0284c7;padding:13px 20px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;"
            >
              View scan results
            </a>
            <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
              If the button does not work, open this link:<br />
              <a href="${escapeHtml(deepLink)}" style="color:#111827;text-decoration:underline;word-break:break-all;">${escapeHtml(deepLink)}</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  `.trim();

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

function normalizeEmailErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown email delivery error';
  return message.trim().slice(0, 1000) || 'Unknown email delivery error';
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
