export const MAILERSEND_FROM_EMAIL = 'noreply@doppelspotter.com';
export const MAILERSEND_FROM_NAME = 'DoppelSpotter';

interface BrandedEmailFrameInput {
  title: string;
  bodyHtml: string;
}

export function buildAppBaseUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

export function buildLogoUrl(): string {
  return 'https://www.doppelspotter.com/logo-white.png';
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function normaliseEmail(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeEmailErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown email delivery error';
  return message.trim().slice(0, 1000) || 'Unknown email delivery error';
}

export function buildBrandedEmailFrame({ title, bodyHtml }: BrandedEmailFrameInput): string {
  const logoUrl = buildLogoUrl();

  return `
    <div style="margin:0;background:#f8fafc;padding:20px 12px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
      <div style="margin:0 auto;max-width:620px;overflow:hidden;border:1px solid #dbe5ef;border-radius:18px;background:#ffffff;">
        <div style="background:linear-gradient(135deg,#075985 0%,#0284c7 55%,#22c1f1 100%);padding:22px 24px 24px;color:#ffffff;">
          <img
            src="${escapeHtml(logoUrl)}"
            alt="DoppelSpotter"
            width="176"
            height="28"
            style="display:block;height:auto;max-width:176px;width:100%;"
          />
          <h1 style="margin:14px 0 0;font-size:28px;line-height:1.15;font-weight:400;color:#ffffff;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:28px 24px 24px;">
          ${bodyHtml}
        </div>
      </div>
    </div>
  `.trim();
}
