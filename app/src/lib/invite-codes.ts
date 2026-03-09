import { createHash, randomBytes } from 'node:crypto';

const INVITE_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const INVITE_CODE_LENGTH = 10;
const INVITE_CODE_PATTERN = new RegExp(`^[a-z0-9]{${INVITE_CODE_LENGTH}}$`);

export function normalizeInviteCode(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return INVITE_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function generateInviteCode(): string {
  let code = '';

  while (code.length < INVITE_CODE_LENGTH) {
    const bytes = randomBytes(INVITE_CODE_LENGTH - code.length);
    for (const byte of bytes) {
      code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
      if (code.length === INVITE_CODE_LENGTH) break;
    }
  }

  return code;
}
