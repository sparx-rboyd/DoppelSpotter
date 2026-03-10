import { buildAppBaseUrl, buildBrandedEmailFrame, escapeHtml } from './email-branding';

export const PASSWORD_RESET_TOKEN_MAX_AGE_SECONDS = 60 * 60;
export const PASSWORD_RESET_TOKEN_MAX_AGE_LABEL = '1 hour';
export const PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE =
  'Password reset email sent';

export function buildPasswordResetLink(token: string): string {
  return `${buildAppBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
}

export function buildPasswordResetEmailContent(resetLink: string) {
  const expiryLabel = PASSWORD_RESET_TOKEN_MAX_AGE_LABEL;
  const text = [
    'DoppelSpotter password reset',
    '',
    `We received a request to reset your password. This link is valid for ${expiryLabel}.`,
    '',
    `Set a new password: ${resetLink}`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = buildBrandedEmailFrame({
    title: 'Reset your password',
    bodyHtml: `
      <div style="margin:0 0 18px;border:1px solid #dbeafe;border-radius:16px;background:linear-gradient(180deg,#f8fbff 0%,#eff6ff 100%);padding:18px 18px 16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0369a1;">Security</div>
        <div style="margin-top:6px;font-size:22px;line-height:1.2;font-weight:400;color:#0369a1;">Password reset requested</div>
        <div style="margin-top:8px;font-size:14px;line-height:1.5;color:#677180;">
          Use the button below to choose a new password. The link expires in ${escapeHtml(expiryLabel)}.
        </div>
      </div>

      <div style="margin-bottom:18px;border:1px solid #dbeafe;border-radius:14px;background:#f8fbff;padding:16px 18px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0369a1;">What happens next</div>
        <p style="margin:10px 0 0;font-size:14px;line-height:1.5;color:#677180;">
          Once you save a new password, older sessions for this account will stop working automatically.
        </p>
      </div>

      <div style="margin-top:24px;border-top:1px solid #e2e8f0;padding-top:18px;">
        <a
          href="${escapeHtml(resetLink)}"
          style="display:inline-block;border-radius:9999px;background:#0284c7;padding:12px 18px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;"
        >
          Set new password
        </a>
        <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
          If the button does not work, open this link:<br />
          <a href="${escapeHtml(resetLink)}" style="color:#0f172a;text-decoration:underline;word-break:break-all;">${escapeHtml(resetLink)}</a>
        </p>
        <p style="margin:12px 0 0;border-left:3px solid #38bdf8;padding-left:12px;font-size:12px;line-height:1.6;color:#475569;">
          If you did not request this password reset, you can safely ignore this email.
        </p>
      </div>
    `,
  });

  return {
    subject: 'Reset your DoppelSpotter password',
    html,
    text,
  };
}
