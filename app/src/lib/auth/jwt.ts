import jwt from 'jsonwebtoken';

export const AUTH_COOKIE_NAME = 'auth-token';

export interface AuthTokenPayload {
  userId: string;
  email: string;
  sessionVersion?: number;
  iat?: number;
  exp?: number;
}

export function signToken(userId: string, email: string, sessionVersion = 0): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is not set');
  return jwt.sign({ userId, email, sessionVersion }, secret, { expiresIn: '7d' });
}

export function verifyToken(token: string): AuthTokenPayload | null {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is not set');
  try {
    return jwt.verify(token, secret) as AuthTokenPayload;
  } catch {
    return null;
  }
}
