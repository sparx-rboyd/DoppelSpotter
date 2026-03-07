const DEFAULT_POST_LOGIN_PATH = '/dashboard';

export function resolveSafeReturnTo(
  returnTo: string | null | undefined,
  fallback = DEFAULT_POST_LOGIN_PATH,
) {
  if (!returnTo) return fallback;

  const trimmed = returnTo.trim();
  if (!trimmed.startsWith('/')) return fallback;
  if (trimmed.startsWith('//')) return fallback;

  return trimmed;
}

export function buildLoginRedirectHref(returnTo: string) {
  const safeReturnTo = resolveSafeReturnTo(returnTo, '/');
  const params = new URLSearchParams({ returnTo: safeReturnTo });
  return `/login?${params.toString()}`;
}
