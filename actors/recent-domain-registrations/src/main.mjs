import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Actor, log } from 'apify';
import { load } from 'cheerio';

const CODEPUNCH_BASE_URL = 'https://api.codepunch.com/dnfeed/v2';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TOKEN_CACHE_STORE_NAME = 'codepunch-token-cache';
const TOKEN_CACHE_VERSION = 1;
const DEFAULT_TOTAL_LIMIT = 100;
const MAX_PAGE_SIZE = 5000;
const TOKEN_REFRESH_WAIT_MS = 2_000;
const TOKEN_REFRESH_POLL_ATTEMPTS = 5;
const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v3.2';
const ENHANCED_ANALYSIS_BATCH_SIZE = 10;
const ANALYSIS_BATCH_CONCURRENCY = 10;
const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_CHARS = 500_000;
const MAX_VISIBLE_TEXT_CHARS = 12_000;
const MIN_DOM_TEXT_LENGTH_FOR_SCRIPT_FALLBACK = 200;
const ANALYSIS_FRIENDLY_ERROR = 'AI analysis could not be completed for this domain';
const GENERIC_FETCH_ERROR = 'Website content could not be retrieved for this domain';
const DATE_COMPARISONS = new Set(['eq', 'lt', 'gt', 'lte', 'gte']);
const SORT_FIELDS = new Set(['date', 'domain', 'tld']);
const SORT_ORDERS = new Set(['asc', 'desc']);
const PLACEHOLDER_SECRET_VALUES = new Set([
  'demo',
  'demo-key',
  'demo-secret',
  'placeholder',
  'your-api-key',
  'your-api-secret',
  'openrouter-key',
  'changeme',
]);

function hasConfiguredCredentials(rawInput) {
  return isConfiguredSecretValue(rawInput.apiKey) && isConfiguredSecretValue(rawInput.apiSecret);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isConfiguredSecretValue(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return !PLACEHOLDER_SECRET_VALUES.has(normalized);
}

function normalizeInput(rawInput) {
  const apiKey = expectNonEmptyString(rawInput.apiKey, 'apiKey');
  const apiSecret = expectNonEmptyString(rawInput.apiSecret, 'apiSecret');
  const selectedDate = expectIsoDate(rawInput.date);
  const dateComparison = expectEnum(rawInput.dateComparison, DATE_COMPARISONS, 'dateComparison');
  const keywords = normalizeKeywordArray(rawInput.keywords);
  const tlds = normalizeTldArray(rawInput.tlds);
  const enhancedAnalysis = normalizeEnhancedAnalysis(rawInput);
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
    enhancedAnalysis,
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

function normalizeEnhancedAnalysis(rawInput) {
  const enabled = rawInput.enhancedAnalysisEnabled === true;
  const modelInput = typeof rawInput.openRouterModel === 'string' ? rawInput.openRouterModel.trim() : '';
  const apiKeyInput = typeof rawInput.openRouterApiKey === 'string' ? rawInput.openRouterApiKey.trim() : '';

  if (!enabled) {
    return {
      enabled: false,
      model: modelInput || DEFAULT_OPENROUTER_MODEL,
    };
  }

  if (!apiKeyInput) {
    throw new Error('openRouterApiKey is required when enhancedAnalysisEnabled is true');
  }

  return {
    enabled: true,
    apiKey: apiKeyInput,
    model: modelInput || DEFAULT_OPENROUTER_MODEL,
  };
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

async function enrichItemsWithEnhancedAnalysis(items, config) {
  if (!config.enabled || items.length === 0) {
    return items;
  }

  log.info('Enhanced analysis enabled', {
    itemCount: items.length,
    model: config.model,
    batchSize: ENHANCED_ANALYSIS_BATCH_SIZE,
    batchConcurrency: ANALYSIS_BATCH_CONCURRENCY,
  });

  const fetchResults = await mapWithConcurrency(items, FETCH_CONCURRENCY, async (item) => (
    fetchDomainHomepageContent(item.domain)
  ));

  const enhancedByDomain = new Map(
    fetchResults.map((result) => [result.domain, {
      ...result.enhancedAnalysis,
      model: config.model,
    }]),
  );

  const readyItems = fetchResults.filter((result) => result.status === 'ready');
  const batches = chunkArray(readyItems, ENHANCED_ANALYSIS_BATCH_SIZE);

  log.info('Enhanced analysis homepage fetch complete', {
    readyCount: readyItems.length,
    fetchFailedCount: fetchResults.length - readyItems.length,
    batchCount: batches.length,
  });

  await mapWithConcurrency(batches, ANALYSIS_BATCH_CONCURRENCY, async (batch) => {
    try {
      log.info('Submitting enhanced analysis batch', {
        batchSize: batch.length,
      });

      const summaries = await analyseDomainContentBatch(batch, config);

      let completedCount = 0;
      let fallbackCount = 0;

      for (const item of batch) {
        const summary = summaries.get(item.domain);
        if (!summary) {
          enhancedByDomain.set(item.domain, buildAnalysisFailureResult(item, config.model));
          fallbackCount += 1;
          continue;
        }

        enhancedByDomain.set(item.domain, {
          status: 'completed',
          model: config.model,
          sourceUrl: item.sourceUrl,
          finalUrl: item.finalUrl,
          summary,
          extractedTextLength: item.text.length,
        });
        completedCount += 1;
      }

      log.info('Enhanced analysis batch complete', {
        batchSize: batch.length,
        completedCount,
        fallbackCount,
      });
    } catch (error) {
      log.warning('Enhanced analysis batch failed', {
        batchSize: batch.length,
        message: error instanceof Error ? error.message : String(error),
      });

      for (const item of batch) {
        enhancedByDomain.set(item.domain, buildAnalysisFailureResult(item, config.model));
      }
    }
  });

  const finalEnhancedItems = items.map((item) => ({
    ...item,
    enhancedAnalysis: enhancedByDomain.get(item.domain) ?? buildAnalysisFailureResult({
      sourceUrl: null,
      finalUrl: null,
    }, config.model),
  }));

  const statusCounts = finalEnhancedItems.reduce((counts, item) => {
    const status = item.enhancedAnalysis?.status ?? 'missing';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});

  log.info('Enhanced analysis complete', statusCounts);

  return finalEnhancedItems;
}

async function fetchDomainHomepageContent(domain) {
  const attempts = [
    `https://${domain}/`,
    `http://${domain}/`,
  ];

  let lastError = {
    errorMessage: GENERIC_FETCH_ERROR,
    failureReason: 'unknown',
    sourceUrl: null,
  };

  for (const sourceUrl of attempts) {
    try {
      const response = await fetch(sourceUrl, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'DoppelSpotter Recent Domain Registrations Actor/0.1',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        lastError = classifyFetchFailureFromHttpResponse(sourceUrl, response.status);
        continue;
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('text/html')) {
        lastError = {
          errorMessage: `The domain resolved, but the homepage did not return HTML content${formatContentTypeSuffix(contentType)}.`,
          failureReason: 'non_html_content',
          sourceUrl,
          finalUrl: response.url,
          contentType: contentType || null,
        };
        continue;
      }

      const html = (await response.text()).slice(0, MAX_HTML_CHARS);
      const text = extractVisibleText(html).slice(0, MAX_VISIBLE_TEXT_CHARS);

      if (!text) {
        lastError = {
          errorMessage: 'The homepage loaded, but there was no visible text to analyze.',
          failureReason: 'no_visible_text',
          sourceUrl,
          finalUrl: response.url,
          contentType: contentType || null,
        };
        continue;
      }

      return {
        domain,
        status: 'ready',
        text,
        sourceUrl,
        finalUrl: response.url,
        enhancedAnalysis: {
          status: 'pending',
          sourceUrl,
          finalUrl: response.url,
          extractedTextLength: text.length,
        },
      };
    } catch (error) {
      lastError = classifyFetchFailureFromError(sourceUrl, error);
    }
  }

  return {
    domain,
    status: 'fetch_failed',
    sourceUrl: lastError.sourceUrl ?? null,
    finalUrl: lastError.finalUrl ?? null,
    enhancedAnalysis: {
      status: 'fetch_failed',
      errorMessage: lastError.errorMessage,
      failureReason: lastError.failureReason,
      contentType: lastError.contentType ?? null,
      summary: null,
    },
  };
}

function extractVisibleText(html) {
  const $ = load(html);
  const scriptContents = $('script')
    .map((_, element) => $(element).html() ?? '')
    .get();
  const metadataText = extractMetadataText($);

  $('script, style, noscript, svg, canvas, iframe').remove();

  const domText = (($('body').text() || $.root().text()) ?? '').replace(/\s+/g, ' ').trim();
  const sections = [metadataText, domText].filter(Boolean);

  if (domText.length < MIN_DOM_TEXT_LENGTH_FOR_SCRIPT_FALLBACK) {
    const hydrationText = extractHydrationFallbackText(scriptContents);
    if (hydrationText) {
      sections.push(hydrationText);
    }
  }

  return dedupeTextSections(sections).join(' ').replace(/\s+/g, ' ').trim();
}

function extractMetadataText($) {
  const values = [
    $('title').first().text(),
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:title"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    $('meta[name="twitter:title"]').attr('content'),
    $('meta[name="twitter:description"]').attr('content'),
  ];

  return dedupeTextSections(values).join(' ');
}

function extractHydrationFallbackText(scriptContents) {
  const candidates = [];

  for (const rawScript of scriptContents) {
    if (!rawScript) continue;
    if (
      !rawScript.includes('self.__next_f.push')
      && !rawScript.includes('__NEXT_DATA__')
      && !rawScript.includes('application/ld+json')
    ) {
      continue;
    }

    const decoded = decodeScriptContent(rawScript);
    const matches = decoded.matchAll(/"((?:[^"\\]|\\.){12,})"/g);

    for (const match of matches) {
      const value = normalizeQuotedCandidate(match[1]);
      if (!isUsefulHydrationText(value)) continue;
      candidates.push(value);
      if (candidates.length >= 80) {
        break;
      }
    }

    if (candidates.length >= 80) {
      break;
    }
  }

  return dedupeTextSections(candidates).join(' ');
}

function decodeScriptContent(value) {
  return value
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ');
}

function normalizeQuotedCandidate(value) {
  return value
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulHydrationText(value) {
  if (!value) return false;
  if (value.length < 12) return false;
  if (value.length > 280) return false;
  if (!/[a-z]{3,}/i.test(value)) return false;
  if (!/\s/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (value.includes('/_next/')) return false;
  if (/\.(css|js|png|jpg|jpeg|svg|woff2?)(\b|$)/i.test(value)) return false;
  if (/^[A-Za-z0-9+/_=-]+$/.test(value)) return false;
  if ((value.match(/[{}[\]]/g) ?? []).length > 2) return false;
  if ((value.match(/[/:]/g) ?? []).length > 8) return false;

  const wordCount = value.split(/\s+/).length;
  return wordCount >= 3;
}

function dedupeTextSections(values) {
  const seen = new Set();
  const deduped = [];

  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

async function analyseDomainContentBatch(batch, config) {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You summarize visible homepage text for newly registered domains. Return strict JSON only. For each domain, provide a short factual summary of what appears on the page. If the page is parked, blank, placeholder content, or not meaningful, say so plainly.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            instructions: {
              responseShape: {
                items: [
                  {
                    domain: 'string',
                    summary: 'string',
                  },
                ],
              },
              summaryRequirements: [
                'Return one item for every input domain.',
                'Keep each summary concise, ideally 1-3 sentences.',
                'Do not invent content that is not present in the supplied text.',
              ],
            },
            items: batch.map((item) => ({
              domain: item.domain,
              url: item.finalUrl ?? item.sourceUrl,
              text: item.text,
            })),
          }),
        },
      ],
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readOpenRouterError(payload) ?? `OpenRouter request failed with status ${response.status}`);
  }

  const content = readOpenRouterMessageContent(payload);
  const parsed = parseJsonObject(content);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const summaries = new Map();

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.domain !== 'string' || typeof item.summary !== 'string') continue;

    const normalizedSummary = item.summary.trim();
    if (!normalizedSummary) continue;
    summaries.set(item.domain.trim(), normalizedSummary);
  }

  return summaries;
}

function readOpenRouterError(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (typeof payload.error?.message === 'string' && payload.error.message.trim()) {
    return payload.error.message.trim();
  }

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  return null;
}

function readOpenRouterMessageContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }

  throw new Error('OpenRouter response did not include message content');
}

function parseJsonObject(value) {
  if (typeof value !== 'string') {
    throw new Error('OpenRouter response content was not a string');
  }

  const trimmed = value.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }

    throw new Error('OpenRouter response did not contain valid JSON');
  }
}

function buildAnalysisFailureResult(item, model) {
  return {
    status: 'analysis_failed',
    model,
    sourceUrl: item.sourceUrl ?? null,
    finalUrl: item.finalUrl ?? null,
    errorMessage: ANALYSIS_FRIENDLY_ERROR,
    summary: null,
  };
}

function classifyFetchFailureFromHttpResponse(sourceUrl, status) {
  if (status === 401 || status === 403) {
    return {
      errorMessage: 'The domain resolved, but access to the homepage was blocked by the site.',
      failureReason: 'http_blocked',
      sourceUrl,
      finalUrl: sourceUrl,
    };
  }

  if (status === 404) {
    return {
      errorMessage: 'The domain resolved, but no homepage was available at the top-level URL.',
      failureReason: 'http_not_found',
      sourceUrl,
      finalUrl: sourceUrl,
    };
  }

  if (status >= 500) {
    return {
      errorMessage: `The domain resolved, but the website returned a server error (HTTP ${status}).`,
      failureReason: 'http_server_error',
      sourceUrl,
      finalUrl: sourceUrl,
    };
  }

  return {
    errorMessage: `The domain resolved, but the homepage could not be retrieved (HTTP ${status}).`,
    failureReason: 'http_error',
    sourceUrl,
    finalUrl: sourceUrl,
  };
}

function classifyFetchFailureFromError(sourceUrl, error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('aborted')) {
    return {
      errorMessage: 'The domain resolved, but the homepage request timed out before content could be analyzed.',
      failureReason: 'timeout',
      sourceUrl,
      finalUrl: sourceUrl,
    };
  }

  if (normalized.includes('enotfound') || normalized.includes('dns') || normalized.includes('getaddrinfo')) {
    return {
      errorMessage: 'The domain does not currently appear to resolve to a reachable website.',
      failureReason: 'dns_not_resolved',
      sourceUrl,
      finalUrl: sourceUrl,
    };
  }

  if (normalized.includes('econnrefused') || normalized.includes('refused')) {
    return {
      errorMessage: 'The domain resolved, but the server refused the connection.',
      failureReason: 'connection_refused',
      sourceUrl,
      finalUrl: sourceUrl,
    };
  }

  if (normalized.includes('tls') || normalized.includes('ssl') || normalized.includes('certificate')) {
    return {
      errorMessage: 'The domain resolved, but the homepage could not be fetched because of an SSL/TLS issue.',
      failureReason: 'tls_error',
      sourceUrl,
      finalUrl: sourceUrl,
    };
  }

  return {
    errorMessage: GENERIC_FETCH_ERROR,
    failureReason: 'network_error',
    sourceUrl,
    finalUrl: sourceUrl,
  };
}

function formatContentTypeSuffix(contentType) {
  return contentType ? ` (${contentType})` : '';
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const results = new Array(items.length);
  let index = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
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

async function emitMissingCredentialsHealthcheck(rawInput) {
  const apiKeyConfigured = isConfiguredSecretValue(rawInput.apiKey);
  const apiSecretConfigured = isConfiguredSecretValue(rawInput.apiSecret);

  const summary = {
    status: 'healthcheck_configuration_required',
    message: 'Configure CodePunch API key and CodePunch API secret to run recent-domain lookups.',
    details: [
      'This actor depends on the CodePunch GTLD Domain Name Activity Feed v2.',
      'The Apify Store healthcheck can run without secrets, so this diagnostic item is emitted instead of failing the run.',
      'Once valid credentials are provided, the actor will query CodePunch and return matching domains normally.',
    ],
    configuredCredentials: {
      apiKey: apiKeyConfigured,
      apiSecret: apiSecretConfigured,
    },
    enhancedAnalysisConfigured: rawInput.enhancedAnalysisEnabled === true
      ? isNonEmptyString(rawInput.openRouterApiKey)
      : null,
    checkedAt: new Date().toISOString(),
  };

  await Actor.pushData(summary);
  await Actor.setValue('OUTPUT_SUMMARY', summary);

  log.warning('Actor completed with healthcheck response because CodePunch credentials are not configured');
}

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

      const finalItems = await enrichItemsWithEnhancedAnalysis(pageItems, input.enhancedAnalysis);

      await Actor.pushData(finalItems);

      emitted += finalItems.length;
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
      enhancedAnalysis: {
        enabled: input.enhancedAnalysis.enabled,
        model: input.enhancedAnalysis.model,
      },
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
