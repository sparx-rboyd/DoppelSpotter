import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Actor, log } from 'apify';

// ─── Constants ───────────────────────────────────────────────────────────────

const EUIPO_AUTH_PRODUCTION = 'https://euipo.europa.eu/cas-server-webapp/oidc/accessToken';
const EUIPO_AUTH_SANDBOX = 'https://auth-sandbox.euipo.europa.eu/oidc/accessToken';
const EUIPO_API_PRODUCTION = 'https://api.euipo.europa.eu/trademark-search';
const EUIPO_API_SANDBOX = 'https://api-sandbox.euipo.europa.eu/trademark-search';

const TOKEN_CACHE_STORE_NAME = 'euipo-token-cache';
const TOKEN_CACHE_VERSION = 1;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;   // 5-minute buffer before expiry
const TOKEN_REFRESH_WAIT_MS = 2_000;
const TOKEN_REFRESH_POLL_ATTEMPTS = 5;

const PAGE_SIZE = 100;
const DEFAULT_MAX_RESULTS = 50;
const MAX_ALLOWED_RESULTS = 500;

const RETRY_AFTER_FALLBACK_MS = 5_000;
const MAX_429_RETRIES = 3;

const MARK_FEATURE_VALUES = new Set([
  'WORD', 'FIGURATIVE', 'SHAPE_3D', 'COLOUR', 'SOUND',
  'HOLOGRAM', 'POSITION', 'PATTERN', 'MOTION', 'MULTIMEDIA', 'OTHER',
]);

const TRADEMARK_STATUS_VALUES = new Set([
  'REGISTERED', 'RECEIVED', 'UNDER_EXAMINATION', 'APPLICATION_PUBLISHED',
  'REGISTRATION_PENDING', 'WITHDRAWN', 'REFUSED', 'OPPOSITION_PENDING',
  'APPEALED', 'CANCELLATION_PENDING', 'CANCELLED', 'SURRENDERED', 'EXPIRED', 'ACCEPTED',
]);

const PLACEHOLDER_SECRET_VALUES = new Set([
  'demo', 'demo-key', 'demo-secret', 'placeholder', 'your-client-id',
  'your-client-secret', 'changeme',
]);

// ─── Input helpers ────────────────────────────────────────────────────────────

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isConfiguredSecretValue(value) {
  if (!isNonEmptyString(value)) return false;
  return !PLACEHOLDER_SECRET_VALUES.has(value.trim().toLowerCase());
}

function hasConfiguredCredentials(rawInput) {
  return isConfiguredSecretValue(rawInput.clientId) && isConfiguredSecretValue(rawInput.clientSecret);
}

function expectNonEmptyString(value, fieldName) {
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${fieldName} must not be empty`);
  return trimmed;
}

function expectOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const s = expectNonEmptyString(value, fieldName);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD format`);
  }
  return s;
}

function normalizeKeywords(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('keywords must be a non-empty array of strings');
  }

  const seen = new Set();
  const normalized = [];

  for (const kw of value) {
    if (typeof kw !== 'string') throw new Error('keywords must contain only strings');
    const trimmed = kw.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  if (normalized.length === 0) {
    throw new Error('keywords must include at least one non-empty value');
  }

  return normalized;
}

function normalizeMaxResults(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(value) || value < 1) throw new Error('maxResults must be a positive integer');
  return Math.min(value, MAX_ALLOWED_RESULTS);
}

function normalizeOptionalEnum(value, allowedValues, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const trimmed = String(value).trim().toUpperCase();
  if (!allowedValues.has(trimmed)) {
    throw new Error(`${fieldName} must be one of: ${Array.from(allowedValues).join(', ')}`);
  }
  return trimmed;
}

function normalizeNiceClass(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('niceClass must be a string');
  const parts = value.split(',').map((c) => c.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error(`Invalid Nice class value: ${part}`);
  }
  return parts;
}

function normalizeInput(rawInput) {
  const clientId = expectNonEmptyString(rawInput.clientId, 'clientId');
  const clientSecret = expectNonEmptyString(rawInput.clientSecret, 'clientSecret');
  const keywords = normalizeKeywords(rawInput.keywords);
  const dateFrom = expectOptionalDate(rawInput.dateFrom, 'dateFrom');
  const dateTo = expectOptionalDate(rawInput.dateTo, 'dateTo');
  const maxResults = normalizeMaxResults(rawInput.maxResults);
  const niceClasses = normalizeNiceClass(rawInput.niceClass);
  const status = normalizeOptionalEnum(rawInput.status, TRADEMARK_STATUS_VALUES, 'status');
  const markFeature = normalizeOptionalEnum(rawInput.markFeature, MARK_FEATURE_VALUES, 'markFeature');
  const useSandbox = rawInput.useSandbox === true;

  return {
    clientId,
    clientSecret,
    keywords,
    dateFrom,
    dateTo,
    maxResults,
    niceClasses,
    status,
    markFeature,
    useSandbox,
  };
}

// ─── RSQL builder ─────────────────────────────────────────────────────────────

/**
 * Converts a brand keyword into an unquoted RSQL wildcard value.
 *
 * EUIPO's RSQL parser treats `*` as a wildcard only when the value is
 * unquoted. Double-quoting a value (e.g. `=="*sparx maths*"`) causes `*` to
 * be interpreted as a literal asterisk character, returning zero results.
 *
 * Spaces in an unquoted RSQL value would also break the parser, so we replace
 * any internal spaces with `*`. This turns "sparx maths" into `*sparx*maths*`,
 * which correctly matches trademarks containing both words in sequence while
 * remaining syntactically valid without quotes.
 */
function buildVerbalElementRsqlValue(value) {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  // Replace spaces with * so the value remains unquoted and valid
  const spaceNormalised = trimmed.replace(/\s/g, '*');
  // Always ensure leading and trailing wildcards
  const withLeading = spaceNormalised.startsWith('*') ? spaceNormalised : `*${spaceNormalised}`;
  return withLeading.endsWith('*') ? withLeading : `${withLeading}*`;
}

function buildRsqlFilter({ keywords, dateFrom, dateTo, niceClasses, status, markFeature }) {
  const clauses = [];

  // Keyword OR group — each term uses unquoted wildcards so * is treated as a
  // wildcard character rather than a literal by the EUIPO RSQL parser.
  const kwFilters = keywords.map((kw) => {
    const rsqlValue = buildVerbalElementRsqlValue(kw);
    return `wordMarkSpecification.verbalElement==${rsqlValue}`;
  });
  clauses.push(kwFilters.length === 1 ? kwFilters[0] : `(${kwFilters.join(',')})`);

  if (dateFrom) clauses.push(`applicationDate>=${dateFrom}`);
  if (dateTo) clauses.push(`applicationDate<=${dateTo}`);

  if (niceClasses && niceClasses.length > 0) {
    if (niceClasses.length === 1) {
      clauses.push(`tradeMarkGoodAndServices.niceClass==${niceClasses[0]}`);
    } else {
      clauses.push(`tradeMarkGoodAndServices.niceClass=in=(${niceClasses.join(',')})`);
    }
  }

  if (status) clauses.push(`tradeMarkStatus==${status}`);
  if (markFeature) clauses.push(`markFeature==${markFeature}`);

  return clauses.join(';');
}

// ─── Token manager ────────────────────────────────────────────────────────────

function buildCredentialCacheKey(clientId, clientSecret) {
  return `token-${crypto.createHash('sha256').update(`${clientId}:${clientSecret}`).digest('hex')}`;
}

class EuipoApiError extends Error {
  constructor(message, { cause, statusCode, isTokenError = false } = {}) {
    super(message, { cause });
    this.name = 'EuipoApiError';
    this.statusCode = statusCode;
    this.isTokenError = isTokenError;
  }
}

function isLikelyTokenError(message, statusCode) {
  if (statusCode === 401 || statusCode === 403) return true;
  const normalized = String(message).toLowerCase();
  return (
    normalized.includes('token')
    || normalized.includes('authoriz')
    || normalized.includes('auth')
    || normalized.includes('forbidden')
    || normalized.includes('unauthor')
  );
}

/**
 * Manages EUIPO OAuth2 access tokens with:
 * - KV-store caching with expiry awareness (using `expires_in` from the auth response)
 * - Refresh-token grant to extend sessions without re-sending full credentials
 * - Concurrent-refresh lock to prevent thundering-herd re-auth in parallel runs
 * - Automatic fallback to full re-auth if the refresh grant fails
 */
class EuipoTokenManager {
  constructor({ clientId, clientSecret, store, useSandbox }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.store = store;
    this.authUrl = useSandbox ? EUIPO_AUTH_SANDBOX : EUIPO_AUTH_PRODUCTION;
    this.cacheKey = buildCredentialCacheKey(clientId, clientSecret);
  }

  async getValidAccessToken() {
    const cached = await this.getCachedRecord();

    if (cached && cached.accessToken && cached.expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
      log.debug('Using cached EUIPO access token', { cacheKey: this.cacheKey });
      return cached.accessToken;
    }

    if (cached && cached.refreshToken) {
      try {
        log.info('Cached EUIPO token nearing expiry, attempting refresh grant');
        return await this.refreshWithRefreshToken(cached.refreshToken);
      } catch (error) {
        log.warning('EUIPO refresh grant failed, falling back to full re-auth', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.acquireNewToken();
  }

  async handleTokenRejection() {
    const cached = await this.getCachedRecord();
    await this.clearCachedToken();

    if (cached && cached.refreshToken) {
      try {
        log.info('EUIPO access token rejected, attempting refresh grant');
        return await this.refreshWithRefreshToken(cached.refreshToken);
      } catch {
        // fall through to full re-auth
      }
    }

    log.info('Falling back to full EUIPO re-auth');
    return this.acquireNewToken();
  }

  async getCachedRecord() {
    const record = await this.store.getValue(this.cacheKey);
    if (!record || typeof record !== 'object') return null;
    if (record.version !== TOKEN_CACHE_VERSION) return null;
    if (typeof record.accessToken !== 'string' || !record.accessToken.trim()) return null;
    return record;
  }

  async clearCachedToken() {
    await this.store.setValue(this.cacheKey, null);
  }

  async refreshWithRefreshToken(refreshToken) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const tokenData = await this.postTokenRequest(body);
    return this.storeTokenData(tokenData);
  }

  async acquireNewToken() {
    const lockKey = `${this.cacheKey}-refreshing`;
    const currentLock = await this.store.getValue(lockKey);
    const now = Date.now();

    // If another invocation is already refreshing, poll for its result
    if (currentLock && typeof currentLock === 'object' && typeof currentLock.expiresAt === 'number' && currentLock.expiresAt > now) {
      for (let attempt = 0; attempt < TOKEN_REFRESH_POLL_ATTEMPTS; attempt += 1) {
        await sleep(TOKEN_REFRESH_WAIT_MS);
        const freshCached = await this.getCachedRecord();
        if (freshCached && freshCached.accessToken && freshCached.expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
          return freshCached.accessToken;
        }
      }
    }

    // Acquire the refresh lock
    await this.store.setValue(lockKey, {
      expiresAt: now + TOKEN_REFRESH_WAIT_MS * TOKEN_REFRESH_POLL_ATTEMPTS,
      updatedAt: new Date(now).toISOString(),
    });

    try {
      log.info('Requesting new EUIPO access token');
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'uid',
      });

      const tokenData = await this.postTokenRequest(body);
      return this.storeTokenData(tokenData);
    } finally {
      await this.store.setValue(lockKey, null);
    }
  }

  async postTokenRequest(body) {
    let response;
    try {
      response = await fetch(this.authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      throw new EuipoApiError(
        `Failed to connect to EUIPO auth server: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, isTokenError: true },
      );
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw new EuipoApiError(`EUIPO auth server returned non-JSON (${response.status})`, {
        statusCode: response.status,
        isTokenError: true,
      });
    }

    if (!response.ok) {
      const detail = parsed?.error_description ?? parsed?.error ?? `HTTP ${response.status}`;
      throw new EuipoApiError(`EUIPO token request failed: ${detail}`, {
        statusCode: response.status,
        isTokenError: true,
      });
    }

    return parsed;
  }

  async storeTokenData(tokenData) {
    const accessToken = typeof tokenData.access_token === 'string' ? tokenData.access_token.trim() : '';
    const refreshToken = typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token.trim() : undefined;
    const expiresIn = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : 3600;

    if (!accessToken) {
      throw new EuipoApiError('EUIPO auth response missing access_token', { isTokenError: true });
    }

    const record = {
      version: TOKEN_CACHE_VERSION,
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: Date.now() + expiresIn * 1000,
      obtainedAt: new Date().toISOString(),
    };

    await this.store.setValue(this.cacheKey, record);
    log.info('EUIPO access token obtained and cached', { expiresInSeconds: expiresIn });

    return accessToken;
  }
}

// ─── EUIPO search client ─────────────────────────────────────────────────────

async function searchTrademarks({ apiBaseUrl, clientId, filter, page, size }) {
  const url = new URL(`${apiBaseUrl}/trademarks`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', String(size));
  url.searchParams.set('query', filter);
  url.searchParams.set('sort', 'applicationDate:desc');

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${searchTrademarks._accessToken}`,
          'X-IBM-Client-Id': clientId,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      throw new EuipoApiError(
        `EUIPO API request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // 429 rate-limit — respect Retry-After and retry
    if (response.status === 429) {
      if (attempt >= MAX_429_RETRIES) {
        throw new EuipoApiError('EUIPO API rate limit exceeded and retry limit reached', {
          statusCode: 429,
        });
      }

      const retryAfter = response.headers.get('Retry-After');
      const delayMs = retryAfter ? Number(retryAfter) * 1000 : RETRY_AFTER_FALLBACK_MS;
      log.warning(`EUIPO API rate limited (429), retrying after ${delayMs}ms`, {
        attempt: attempt + 1,
        maxRetries: MAX_429_RETRIES,
      });
      await sleep(delayMs);
      continue;
    }

    // Parse response
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw new EuipoApiError(`EUIPO API returned non-JSON response (${response.status})`, {
        statusCode: response.status,
      });
    }

    // Auth errors
    if (response.status === 401 || response.status === 403) {
      const detail = extractApiErrorDetail(parsed);
      throw new EuipoApiError(
        `EUIPO API authentication failed: ${detail ?? `HTTP ${response.status}`}`,
        { statusCode: response.status, isTokenError: true },
      );
    }

    // Input validation errors (400) — surface the detail so they are not silently swallowed
    if (response.status === 400) {
      const detail = extractApiErrorDetail(parsed);
      throw new EuipoApiError(
        `EUIPO API input validation error: ${detail ?? `HTTP ${response.status}`}`,
        { statusCode: 400 },
      );
    }

    if (!response.ok) {
      const detail = extractApiErrorDetail(parsed);
      throw new EuipoApiError(
        `EUIPO API error ${response.status}: ${detail ?? 'Unknown error'}`,
        { statusCode: response.status },
      );
    }

    return parsed;
  }
}

// Attach the access token as a property so the function can be called with the
// correct token after it is obtained (avoids threading it through every call site).
searchTrademarks._accessToken = '';

function extractApiErrorDetail(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const candidates = [parsed.detail, parsed.message, parsed.error, parsed.title];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

// ─── Output normalization ────────────────────────────────────────────────────

function normalizePageItems({ trademarks, input, page, filter }) {
  if (!Array.isArray(trademarks)) return [];

  return trademarks.map((tm) => {
    const applicationNumber = typeof tm.applicationNumber === 'string' ? tm.applicationNumber.trim() : '';
    const euipoUrl = applicationNumber
      ? `https://euipo.europa.eu/eSearch/#basic/1+1+1+1/50+50+50+50/${applicationNumber}`
      : '';

    return {
      applicationNumber,
      markName: readString(tm.wordMarkSpecification?.verbalElement ?? tm.markName ?? tm.tradeMarkName),
      applicantName: readApplicantName(tm),
      niceClasses: readNiceClasses(tm),
      filingDate: readString(tm.applicationDate ?? tm.filingDate),
      registrationDate: readString(tm.registrationDate),
      expiryDate: readString(tm.expiryDate),
      status: readString(tm.tradeMarkStatus ?? tm.status),
      markType: readString(tm.markFeature ?? tm.markType),
      markKind: readString(tm.tradeMarkKind ?? tm.markKind),
      markBasis: readString(tm.tradeMarkBasis ?? tm.markBasis),
      representativeName: readRepresentativeName(tm),
      goodsAndServicesDescription: readGoodsAndServices(tm),
      renewalStatus: readString(tm.renewalStatus),
      markImageUrl: readString(tm.markImageUrl ?? tm.tradeMarkImageUrl),
      euipoUrl: readString(tm.euipoUrl) || euipoUrl,
      extractedAt: new Date().toISOString(),
      requestMetadata: {
        keywords: input.keywords,
        dateFrom: input.dateFrom ?? null,
        dateTo: input.dateTo ?? null,
        maxResults: input.maxResults,
        niceClass: input.niceClasses ? input.niceClasses.join(',') : null,
        status: input.status ?? null,
        markFeature: input.markFeature ?? null,
        filter,
        page,
        useSandbox: input.useSandbox,
      },
    };
  });
}

function readString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function readApplicantName(tm) {
  // EUIPO API may return applicants as an array of objects
  if (Array.isArray(tm.applicants) && tm.applicants.length > 0) {
    const names = tm.applicants
      .map((a) => readString(a.name ?? a.applicantName))
      .filter(Boolean);
    if (names.length > 0) return names.join('; ');
  }
  return readString(tm.applicantName);
}

function readRepresentativeName(tm) {
  if (Array.isArray(tm.representatives) && tm.representatives.length > 0) {
    const names = tm.representatives
      .map((r) => readString(r.name ?? r.representativeName))
      .filter(Boolean);
    if (names.length > 0) return names.join('; ');
  }
  return readString(tm.representativeName);
}

function readNiceClasses(tm) {
  // Classes may come as an array or as a comma-separated string
  if (Array.isArray(tm.niceClasses)) {
    return tm.niceClasses.map((c) => (typeof c === 'object' ? (c.classNumber ?? c.niceClass) : c)).filter(Boolean).join(', ');
  }
  if (Array.isArray(tm.tradeMarkGoodAndServices)) {
    const classes = [...new Set(tm.tradeMarkGoodAndServices.map((gs) => gs.niceClass).filter(Boolean))];
    if (classes.length > 0) return classes.join(', ');
  }
  return readString(tm.niceClasses);
}

function readGoodsAndServices(tm) {
  if (Array.isArray(tm.tradeMarkGoodAndServices) && tm.tradeMarkGoodAndServices.length > 0) {
    const parts = tm.tradeMarkGoodAndServices.map((gs) => {
      const cls = gs.niceClass ? `Class ${gs.niceClass}: ` : '';
      const desc = readString(gs.description ?? gs.goodsServices) ?? '';
      return `${cls}${desc}`.trim();
    }).filter(Boolean);
    if (parts.length > 0) return parts.join(' | ');
  }
  return readString(tm.goodsAndServicesDescription);
}

// ─── Healthcheck mode ────────────────────────────────────────────────────────

async function emitMissingCredentialsHealthcheck(rawInput) {
  const clientIdConfigured = isConfiguredSecretValue(rawInput.clientId);
  const clientSecretConfigured = isConfiguredSecretValue(rawInput.clientSecret);

  const summary = {
    status: 'healthcheck_configuration_required',
    message: 'Configure EUIPO Client ID and Client Secret to run trademark searches.',
    details: [
      'This actor depends on the official EUIPO Trademark Search API.',
      'Register for free credentials at https://dev.euipo.europa.eu/',
      'The Apify Store healthcheck can run without secrets, so this diagnostic item is emitted instead of failing the run.',
      'Once valid credentials are provided, the actor will query the EUIPO API and return matching trademark filings normally.',
    ],
    configuredCredentials: {
      clientId: clientIdConfigured,
      clientSecret: clientSecretConfigured,
    },
    checkedAt: new Date().toISOString(),
  };

  await Actor.pushData(summary);
  await Actor.setValue('OUTPUT_SUMMARY', summary);

  log.warning('Actor completed with healthcheck response because EUIPO credentials are not configured');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

await runActor();

async function runActor() {
  await Actor.init();

  try {
    const rawInput = (await Actor.getInput()) ?? {};

    if (!hasConfiguredCredentials(rawInput)) {
      await emitMissingCredentialsHealthcheck(rawInput);
      return;
    }

    const input = normalizeInput(rawInput);
    const apiBaseUrl = input.useSandbox ? EUIPO_API_SANDBOX : EUIPO_API_PRODUCTION;

    const tokenCache = await Actor.openKeyValueStore(TOKEN_CACHE_STORE_NAME);
    const tokenManager = new EuipoTokenManager({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      store: tokenCache,
      useSandbox: input.useSandbox,
    });

    const filter = buildRsqlFilter({
      keywords: input.keywords,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      niceClasses: input.niceClasses,
      status: input.status,
      markFeature: input.markFeature,
    });

    log.info('Starting EUIPO trademark search', {
      keywords: input.keywords,
      filter,
      maxResults: input.maxResults,
      useSandbox: input.useSandbox,
    });

    let emitted = 0;
    let page = 0;
    let totalElements = null;

    while (emitted < input.maxResults) {
      const pageSize = Math.min(PAGE_SIZE, input.maxResults - emitted);
      if (pageSize <= 0) break;

      // Obtain a valid token before each page request
      searchTrademarks._accessToken = await tokenManager.getValidAccessToken();

      let pageData;
      try {
        pageData = await searchTrademarks({
          apiBaseUrl,
          clientId: input.clientId,
          filter,
          page,
          size: pageSize,
        });
      } catch (error) {
        if (error instanceof EuipoApiError && error.isTokenError) {
          log.warning('EUIPO search returned auth error, attempting token recovery', {
            page,
            error: error.message,
          });
          searchTrademarks._accessToken = await tokenManager.handleTokenRejection();
          pageData = await searchTrademarks({
            apiBaseUrl,
            clientId: input.clientId,
            filter,
            page,
            size: pageSize,
          });
        } else {
          throw error;
        }
      }

      // Log the top-level response keys so we can identify the correct array field
      if (page === 0 && pageData && typeof pageData === 'object') {
        log.info('EUIPO API response shape', {
          keys: Object.keys(pageData),
          totalElements: pageData.totalElements,
          totalPages: pageData.totalPages,
          numberOfElements: pageData.numberOfElements,
          size: pageData.size,
          number: pageData.number,
          hasContent: Array.isArray(pageData.content),
          contentLength: Array.isArray(pageData.content) ? pageData.content.length : undefined,
        });
      }

      const trademarks = pageData?.trademarks ?? pageData?.content ?? pageData?.tradeMarks ?? pageData?.items ?? [];
      if (totalElements === null) {
        totalElements = typeof pageData?.totalElements === 'number' ? pageData.totalElements
          : typeof pageData?.totalResults === 'number' ? pageData.totalResults
          : null;
      }

      if (!Array.isArray(trademarks) || trademarks.length === 0) {
        log.info('No more trademark results', { page, emitted });
        break;
      }

      const pageItems = normalizePageItems({ trademarks, input, page, filter });
      await Actor.pushData(pageItems);

      emitted += pageItems.length;
      page += 1;

      log.info('Fetched page of trademark results', {
        page,
        pageSize: pageItems.length,
        emitted,
        totalElements,
        maxResults: input.maxResults,
      });

      // Stop if the API returned fewer items than requested (last page)
      if (trademarks.length < pageSize) {
        break;
      }

      // Stop if we have reached the known total
      if (typeof totalElements === 'number' && emitted >= totalElements) {
        break;
      }
    }

    await Actor.setValue('OUTPUT_SUMMARY', {
      emitted,
      maxResults: input.maxResults,
      totalElements,
      pagesRequested: page,
      keywords: input.keywords,
      filter,
      dateFrom: input.dateFrom ?? null,
      dateTo: input.dateTo ?? null,
      niceClass: input.niceClasses ? input.niceClasses.join(',') : null,
      status: input.status ?? null,
      markFeature: input.markFeature ?? null,
      useSandbox: input.useSandbox,
    });

    log.info('EUIPO trademark search complete', { emitted, totalElements });
  } catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
  } finally {
    await Actor.exit();
  }
}
