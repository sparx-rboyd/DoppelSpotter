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
    <div style="margin:0;background:#f0f9ff;padding:24px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
      <div style="margin:0 auto;max-width:640px;overflow:hidden;border:1px solid #e5e7eb;border-radius:20px;background:#ffffff;">
        <div style="background:linear-gradient(135deg,#0369a1 0%,#0284c7 52%,#0ea5e9 100%);padding:28px 32px;color:#ffffff;">
          <img
            src="${escapeHtml(logoUrl)}"
            alt="DoppelSpotter"
            width="248"
            height="40"
            style="display:block;height:auto;max-width:248px;width:100%;"
          />
          <h1 style="margin:20px 0 0;font-size:30px;line-height:1.15;color:#ffffff;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:32px;">
          ${bodyHtml}
        </div>
      </div>
    </div>
  `.trim();
}
