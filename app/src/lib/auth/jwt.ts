import jwt from 'jsonwebtoken';

export const AUTH_COOKIE_NAME = 'auth-token';

export interface AuthTokenPayload {
  userId: string;
  email: string;
}

export function signToken(userId: string, email: string): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is not set');
  return jwt.sign({ userId, email }, secret, { expiresIn: '7d' });
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
