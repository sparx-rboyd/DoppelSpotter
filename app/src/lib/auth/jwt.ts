import jwt from 'jsonwebtoken';
import { PASSWORD_RESET_TOKEN_MAX_AGE_SECONDS } from '@/lib/password-reset';
import { EMAIL_VERIFICATION_TOKEN_MAX_AGE_SECONDS } from '@/lib/email-verification';

export const AUTH_COOKIE_NAME = 'auth-token';

export interface AuthTokenPayload {
  userId: string;
  email: string;
  sessionVersion?: number;
  iat?: number;
  exp?: number;
}

export interface PasswordResetTokenPayload {
  userId: string;
  email: string;
  sessionVersion?: number;
  purpose: 'password-reset';
  iat?: number;
  exp?: number;
}

export interface EmailVerificationTokenPayload {
  userId: string;
  email: string;
  purpose: 'email-verification';
  iat?: number;
  exp?: number;
}

function getAuthJwtSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is not set');
  return secret;
}

function getPasswordResetJwtSecret(): string {
  return `${getAuthJwtSecret()}:password-reset`;
}

function getEmailVerificationJwtSecret(): string {
  return `${getAuthJwtSecret()}:email-verification`;
}

export function signToken(userId: string, email: string, sessionVersion = 0): string {
  return jwt.sign({ userId, email, sessionVersion }, getAuthJwtSecret(), { expiresIn: '7d' });
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, getAuthJwtSecret()) as AuthTokenPayload;
  } catch {
    return null;
  }
}

export function signPasswordResetToken(userId: string, email: string, sessionVersion = 0): string {
  return jwt.sign(
    {
      userId,
      email,
      sessionVersion,
      purpose: 'password-reset',
    },
    getPasswordResetJwtSecret(),
    { expiresIn: PASSWORD_RESET_TOKEN_MAX_AGE_SECONDS },
  );
}

export function verifyPasswordResetToken(token: string): PasswordResetTokenPayload | null {
  try {
    const payload = jwt.verify(token, getPasswordResetJwtSecret()) as PasswordResetTokenPayload;
    return payload.purpose === 'password-reset' ? payload : null;
  } catch {
    return null;
  }
}

export function signEmailVerificationToken(userId: string, email: string): string {
  return jwt.sign(
    { userId, email, purpose: 'email-verification' },
    getEmailVerificationJwtSecret(),
    { expiresIn: EMAIL_VERIFICATION_TOKEN_MAX_AGE_SECONDS },
  );
}

export function verifyEmailVerificationToken(token: string): EmailVerificationTokenPayload | null {
  try {
    const payload = jwt.verify(
      token,
      getEmailVerificationJwtSecret(),
    ) as EmailVerificationTokenPayload;
    return payload.purpose === 'email-verification' ? payload : null;
  } catch {
    return null;
  }
}
