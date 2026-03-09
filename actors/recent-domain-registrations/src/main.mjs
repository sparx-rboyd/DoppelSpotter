import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Actor, log } from 'apify';

const CODEPUNCH_BASE_URL = 'https://api.codepunch.com/dnfeed/v2';
const TOKEN_CACHE_STORE_NAME = 'codepunch-token-cache';
const TOKEN_CACHE_VERSION = 1;
const DEFAULT_TOTAL_LIMIT = 100;
const MAX_PAGE_SIZE = 5000;
const TOKEN_REFRESH_WAIT_MS = 2_000;
const TOKEN_REFRESH_POLL_ATTEMPTS = 5;
const DATE_COMPARISONS = new Set(['eq', 'lt', 'gt', 'lte', 'gte']);
const SORT_FIELDS = new Set(['date', 'domain', 'tld']);
const SORT_ORDERS = new Set(['asc', 'desc']);

function normalizeInput(rawInput) {
  const apiKey = expectNonEmptyString(rawInput.apiKey, 'apiKey');
  const apiSecret = expectNonEmptyString(rawInput.apiSecret, 'apiSecret');
  const selectedDate = expectIsoDate(rawInput.date);
  const dateComparison = expectEnum(rawInput.dateComparison, DATE_COMPARISONS, 'dateComparison');
  const keywords = normalizeKeywordArray(rawInput.keywords);
  const tlds = normalizeTldArray(rawInput.tlds);
  const sortField = normalizeOptionalEnum(rawInput.sortField, SORT_FIELDS, 'sortField');
  const sortOrder = normalizeOptionalEnum(rawInput.sortOrder, SORT_ORDERS, 'sortOrder');
  const totalLimit = normalizeTotalLimit(rawInput.totalLimit);

  return {
    apiKey,
    apiSecret,
    selectedDate,
    codePunchDate: toCodePunchDate(selectedDate),
    dateComparison,
    keywords,
    keywordParam: keywords.join('|'),
    tlds,
    tldsParam: tlds.length > 0 ? tlds.join(',') : null,
    sortField,
    sortOrder,
    totalLimit,
  };
}

function expectNonEmptyString(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must not be empty`);
  }

  return normalized;
}

function expectIsoDate(value) {
  const normalized = expectNonEmptyString(value, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error('date must use YYYY-MM-DD format');
  }
  return normalized;
}

function toCodePunchDate(value) {
  return value.replaceAll('-', '');
}

function expectEnum(value, allowedValues, fieldName) {
  const normalized = expectNonEmptyString(value, fieldName).toLowerCase();
  if (!allowedValues.has(normalized)) {
    throw new Error(`${fieldName} must be one of: ${Array.from(allowedValues).join(', ')}`);
  }
  return normalized;
}

function normalizeOptionalEnum(value, allowedValues, fieldName) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return expectEnum(value, allowedValues, fieldName);
}

function normalizeKeywordArray(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('keywords must be a non-empty array of strings');
  }

  const seen = new Set();
  const normalized = [];

  for (const keyword of value) {
    if (typeof keyword !== 'string') {
      throw new Error('keywords must contain only strings');
    }

    const trimmed = keyword.trim();
    if (!trimmed) continue;
    if (trimmed.includes('|')) {
      throw new Error('keywords must not include the pipe character');
    }

    const wildcarded = trimmed.includes('%') ? trimmed : `%${trimmed}%`;
    const dedupeKey = wildcarded.toLowerCase();

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(wildcarded);
  }

  if (normalized.length === 0) {
    throw new Error('keywords must include at least one non-empty value');
  }

  return normalized;
}

function normalizeTldArray(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('tlds must be an array of strings when provided');
  }

  const seen = new Set();
  const normalized = [];

  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error('tlds must contain only strings');
    }

    const trimmed = item.trim().replace(/^\./, '').toLowerCase();
    if (!trimmed) continue;
    if (!/^[a-z0-9-]+$/.test(trimmed)) {
      throw new Error(`Invalid TLD value: ${item}`);
    }

    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeTotalLimit(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_TOTAL_LIMIT;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error('totalLimit must be a positive integer');
  }

  return value;
}

function normalizeResponseRows(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('Unexpected CodePunch response shape');
  }

  if (!response.status) {
    const message = readResponseMessage(response) ?? 'CodePunch returned an unsuccessful response';
    throw buildCodePunchResponseError(response, message);
  }

  if (!Array.isArray(response.data)) {
    return [];
  }

  return response.data;
}

function buildDatasetItem({ row, input, response, start, pageLimit }) {
  return {
    ...row,
    requestMetadata: {
      selectedDate: input.selectedDate,
      codePunchDate: input.codePunchDate,
      dateComparison: input.dateComparison,
      keywords: input.keywords,
      tlds: input.tlds,
      totalLimit: input.totalLimit,
      sortField: input.sortField ?? null,
      sortOrder: input.sortOrder ?? null,
    },
    responseMetadata: {
      keyword: typeof response.keyword === 'string' ? response.keyword : input.keywordParam,
      datamode: typeof response.datamode === 'string' ? response.datamode : 'data',
      source: typeof response.source === 'string' ? response.source : null,
      requestedStart: start,
      requestedLimit: pageLimit,
      upstreamStart: typeof response.start === 'number' ? response.start : start,
      upstreamLimit: typeof response.limit === 'number' ? response.limit : pageLimit,
      totalRecords: typeof response.records === 'number' ? response.records : null,
      upstreamDate: typeof response.date === 'string' ? response.date : null,
      upstreamTlds: typeof response.tlds === 'string' ? response.tlds : null,
      sortField: typeof response.sorton === 'string' ? response.sorton : input.sortField ?? null,
      sortOrder: typeof response.sortorder === 'string' ? response.sortorder : input.sortOrder ?? null,
    },
  };
}

class CodePunchTokenManager {
  constructor({ apiKey, apiSecret, store }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.store = store;
    this.cacheKey = buildCredentialCacheKey(apiKey, apiSecret);
  }

  async fetchAddedDomains(params) {
    const cachedToken = await this.getCachedToken();

    if (cachedToken) {
      try {
        return await this.requestAddedDomains(cachedToken, params);
      } catch (error) {
        if (!(error instanceof CodePunchApiError) || !error.isTokenError) {
          throw error;
        }

        log.warning('Cached CodePunch token was rejected, requesting a fresh token', {
          cacheKey: this.cacheKey,
        });
        await this.clearCachedToken();
      }
    }

    const refreshedToken = await this.refreshTokenWithPolling();
    return this.requestAddedDomains(refreshedToken, params);
  }

  async getCachedToken() {
    const record = await this.store.getValue(this.cacheKey);
    if (!record || typeof record !== 'object') {
      return null;
    }

    if (record.version !== TOKEN_CACHE_VERSION || typeof record.token !== 'string' || !record.token.trim()) {
      return null;
    }

    return record.token;
  }

  async clearCachedToken() {
    await this.store.setValue(this.cacheKey, null);
  }

  async refreshTokenWithPolling() {
    const lockKey = `${this.cacheKey}-refreshing`;
    const currentLock = await this.store.getValue(lockKey);
    const now = Date.now();

    if (currentLock && typeof currentLock === 'object' && typeof currentLock.expiresAt === 'number' && currentLock.expiresAt > now) {
      for (let attempt = 0; attempt < TOKEN_REFRESH_POLL_ATTEMPTS; attempt += 1) {
        await sleep(TOKEN_REFRESH_WAIT_MS);
        const cachedToken = await this.getCachedToken();
        if (cachedToken) {
          return cachedToken;
        }
      }
    }

    await this.store.setValue(lockKey, {
      expiresAt: now + TOKEN_REFRESH_WAIT_MS * TOKEN_REFRESH_POLL_ATTEMPTS,
      updatedAt: new Date(now).toISOString(),
    });

    try {
      const token = await this.requestNewToken();
      await this.store.setValue(this.cacheKey, {
        version: TOKEN_CACHE_VERSION,
        token,
        updatedAt: new Date().toISOString(),
      });
      return token;
    } finally {
      await this.store.setValue(lockKey, null);
    }
  }

  async requestNewToken() {
    const url = `${CODEPUNCH_BASE_URL}/auth/${encodeURIComponent(this.apiKey)}/${encodeURIComponent(this.apiSecret)}/`;
    const response = await fetchJson(url);
    const token = typeof response.token === 'string' ? response.token.trim() : '';

    if (!response.status || !token) {
      const message = readResponseMessage(response) ?? 'CodePunch token request failed';
      throw new CodePunchApiError(message, {
        response,
        isTokenError: true,
      });
    }

    return token;
  }

  async requestAddedDomains(token, params) {
    const query = new URLSearchParams({
      format: 'json',
      dm: 'data',
      kw: params.keywordParam,
      date: params.date,
      dcm: params.dateComparison,
      start: String(params.start),
      limit: String(params.limit),
    });

    if (params.tldsParam) {
      query.set('tlds', params.tldsParam);
    }

    if (params.sortField) {
      query.set('sorton', params.sortField);
    }

    if (params.sortOrder) {
      query.set('sortorder', params.sortOrder);
    }

    const url = `${CODEPUNCH_BASE_URL}/${encodeURIComponent(token)}/added/?${query.toString()}`;

    try {
      const response = await fetchJson(url);
      if (!response || typeof response !== 'object') {
        throw new CodePunchApiError('Unexpected CodePunch response shape');
      }

      if (!response.status) {
        const message = readResponseMessage(response) ?? 'CodePunch returned an unsuccessful response';
        throw buildCodePunchResponseError(response, message);
      }

      return response;
    } catch (error) {
      if (error instanceof CodePunchApiError) {
        throw error;
      }

      throw new CodePunchApiError(error instanceof Error ? error.message : 'Unknown CodePunch request failure', {
        cause: error,
      });
    }
  }
}

class CodePunchApiError extends Error {
  constructor(message, { cause, response, isTokenError = false } = {}) {
    super(message, { cause });
    this.name = 'CodePunchApiError';
    this.response = response;
    this.isTokenError = isTokenError;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
  });

  const text = await response.text();
  let parsed;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new CodePunchApiError(`CodePunch returned a non-JSON response (${response.status})`, {
      cause: error,
    });
  }

  if (!response.ok) {
    const message = readResponseMessage(parsed) ?? `CodePunch request failed with status ${response.status}`;
    throw new CodePunchApiError(message, {
      response: parsed,
      isTokenError: response.status === 401 || response.status === 403 || isLikelyTokenError(message),
    });
  }

  return parsed;
}

function readResponseMessage(response) {
  if (!response || typeof response !== 'object') return null;

  const candidates = [
    response.message,
    response.error,
    response.errors,
    response.reason,
    response.detail,
    response.details,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (Array.isArray(response.errors) && response.errors.length > 0) {
    const first = response.errors.find((value) => typeof value === 'string' && value.trim());
    if (first) return first.trim();
  }

  return null;
}

function isLikelyTokenError(message) {
  const normalized = String(message).toLowerCase();
  return normalized.includes('token')
    || normalized.includes('authoriz')
    || normalized.includes('auth')
    || normalized.includes('forbidden')
    || normalized.includes('unauthor');
}

function buildCredentialCacheKey(apiKey, apiSecret) {
  return `token-${crypto.createHash('sha256').update(`${apiKey}:${apiSecret}`).digest('hex')}`;
}

function buildCodePunchResponseError(response, message) {
  return new CodePunchApiError(message, {
    response,
    isTokenError: isLikelyTokenError(message),
  });
}

await runActor();

async function runActor() {
  await Actor.init();

  try {
    const rawInput = (await Actor.getInput()) ?? {};
    const input = normalizeInput(rawInput);
    const tokenCache = await Actor.openKeyValueStore(TOKEN_CACHE_STORE_NAME);
    const tokenManager = new CodePunchTokenManager({
      apiKey: input.apiKey,
      apiSecret: input.apiSecret,
      store: tokenCache,
    });

    let emitted = 0;
    let start = 0;
    let page = 0;
    let totalRecords = null;

    while (emitted < input.totalLimit) {
      const pageLimit = Math.min(MAX_PAGE_SIZE, input.totalLimit - emitted);
      if (pageLimit <= 0) break;

      const response = await tokenManager.fetchAddedDomains({
        date: input.codePunchDate,
        dateComparison: input.dateComparison,
        keywordParam: input.keywordParam,
        tldsParam: input.tldsParam,
        sortField: input.sortField,
        sortOrder: input.sortOrder,
        start,
        limit: pageLimit,
      });

      const rows = normalizeResponseRows(response);
      totalRecords = typeof response.records === 'number' ? response.records : totalRecords;

      if (rows.length === 0) {
        break;
      }

      const pageItems = rows.map((row) => buildDatasetItem({
        row,
        input,
        response,
        start,
        pageLimit,
      }));

      await Actor.pushData(pageItems);

      emitted += pageItems.length;
      start += rows.length;
      page += 1;

      log.info('Fetched page of recent domain registrations', {
        page,
        emitted,
        pageSize: pageItems.length,
        totalLimit: input.totalLimit,
        totalRecords,
      });

      if (rows.length < pageLimit) {
        break;
      }

      if (typeof totalRecords === 'number' && start >= totalRecords) {
        break;
      }
    }

    await Actor.setValue('OUTPUT_SUMMARY', {
      emitted,
      totalLimit: input.totalLimit,
      totalRecords,
      selectedDate: input.selectedDate,
      codePunchDate: input.codePunchDate,
      dateComparison: input.dateComparison,
      keywords: input.keywords,
      tlds: input.tlds,
      sortField: input.sortField ?? null,
      sortOrder: input.sortOrder ?? null,
    });
  } catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
  } finally {
    await Actor.exit();
  }
}
