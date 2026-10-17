// BingTranslatorClient — free Microsoft Translator used by LOCAL_INFERENCE.
//
// Primary path (2026+): scrape bing.com/translator for AbusePreventionHelper
// credentials, then POST /ttranslatev3. The previous Edge JWT endpoint
// (`https://edge.microsoft.com/translate/auth`) now returns HTTP 404 regionally,
// so scrape is the working path again.
//
// Fallback path: Edge JWT + api-edge.cognitive.microsofttranslator.com, kept
// so environments where Microsoft re-enables it keep working without a release.

import { mapToBingCode, isSupportedByBing } from './languageMap';

export class BingTokenFetchError extends Error {
  readonly errorType = 'token' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BingTokenFetchError';
  }
}

export class BingUnsupportedLanguageError extends Error {
  readonly errorType = 'unsupported' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BingUnsupportedLanguageError';
  }
}

export class BingTranslateError extends Error {
  readonly errorType = 'network' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BingTranslateError';
  }
}

export interface BingTranslateResult {
  translatedText: string;
  detectedLanguage?: { language: string; score: number };
  usedLLM?: boolean;
  inferenceTimeMs: number;
}

export interface BingTranslatorClientOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  fetchTimeoutMs?: number;
  /**
   * Preferred transport. `auto` tries Edge JWT first, then falls back to the
   * HTML scrape path when auth is unavailable (the common 2026 failure mode).
   */
  transport?: 'auto' | 'edge' | 'scrape';
  /** Override host list for scrape path (tests). */
  scrapeHosts?: readonly string[];
}

const EDGE_AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const EDGE_TRANSLATE_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate';
const DEFAULT_TIMEOUT = 12_000;
/** Refresh a few minutes before JWT exp to avoid mid-request expiry. */
const TOKEN_SKEW_MS = 60_000;
/** Default sites — www may redirect by region; cn is the working host in many locales. */
const DEFAULT_SCRAPE_HOSTS = [
  'https://www.bing.com',
  'https://cn.bing.com',
] as const;

/**
 * Parse Microsoft Edge JWT `exp` (seconds). Returns 0 on failure.
 * Exported for unit tests.
 */
export function parseMsTokenExpiryMs(token: string): number {
  try {
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export interface ParsedTranslatorPage {
  ig: string;
  iid: string;
  key: string;
  token: string;
}

export function parseTranslatorPage(html: string): ParsedTranslatorPage {
  const ig = html.match(/IG:"([0-9A-Fa-f]+)"/)?.[1];
  if (!ig) throw new BingTokenFetchError('could not find IG in translator page');

  const iid = html.match(/data-iid="([^"]+)"/)?.[1];
  if (!iid) throw new BingTokenFetchError('could not find IID in translator page');

  const abuseMatch = html.match(
    /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*\d+\s*\]/,
  );
  if (!abuseMatch) {
    throw new BingTokenFetchError('could not find token (params_AbusePreventionHelper) in translator page');
  }

  return { ig, iid, key: abuseMatch[1], token: abuseMatch[2] };
}

type ScrapeSession = {
  host: string;
  page: ParsedTranslatorPage;
  /** Absolute expiry of the abuse token (key is epoch ms issued). */
  expiresAt: number;
  cookie: string;
};

export class BingTranslatorClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private readonly preferredTransport: 'auto' | 'edge' | 'scrape';
  private readonly scrapeHosts: readonly string[];

  // Edge JWT state
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private authInFlight: Promise<string> | null = null;
  private edgeDisabled = false;

  // Scrape path state
  private scrapeSession: ScrapeSession | null = null;
  private scrapeInFlight: Promise<ScrapeSession> | null = null;

  constructor(options: BingTranslatorClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_TIMEOUT;
    this.preferredTransport = options.transport ?? 'auto';
    this.scrapeHosts = options.scrapeHosts ?? DEFAULT_SCRAPE_HOSTS;
  }

  async translate(text: string, from: string, to: string): Promise<BingTranslateResult> {
    const autoSource = from.trim().toLowerCase() === 'auto';
    if (!autoSource && !isSupportedByBing(from)) {
      throw new BingUnsupportedLanguageError(`source language not supported: ${from}`);
    }
    if (!isSupportedByBing(to)) {
      throw new BingUnsupportedLanguageError(`target language not supported: ${to}`);
    }

    const start = this.now();
    const trimmed = text.trim();
    if (!trimmed) {
      return { translatedText: '', inferenceTimeMs: 0 };
    }

    const order = this.transportOrder();
    let lastError: unknown;
    for (const transport of order) {
      try {
        if (transport === 'edge') {
          return await this.translateViaEdge(trimmed, from, to, start);
        }
        return await this.translateViaScrape(trimmed, from, to, start);
      } catch (err) {
        lastError = err;
        if (transport === 'edge') {
          // Permanent-looking auth failures: skip Edge for the rest of this client life.
          if (err instanceof BingTokenFetchError) {
            this.edgeDisabled = true;
            this.token = null;
            this.tokenExpiresAt = 0;
            continue;
          }
          if (err instanceof BingTranslateError && this.looksLikeTokenError(err.message)) {
            this.token = null;
            this.tokenExpiresAt = 0;
            // One Edge retry with fresh token is handled inside translateViaEdge;
            // if we still land here, fall through to scrape.
            continue;
          }
        }
        // Scrape failed, or non-auth Edge error with no more transports.
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new BingTranslateError(String(lastError));
  }

  private transportOrder(): Array<'edge' | 'scrape'> {
    if (this.preferredTransport === 'edge') return ['edge'];
    if (this.preferredTransport === 'scrape') return ['scrape'];
    // Scrape is the working path in 2026 (Edge JWT auth returns 404 in many
    // regions). Keep Edge as a secondary option if Microsoft restores it.
    if (this.edgeDisabled) return ['scrape'];
    return ['scrape', 'edge'];
  }

  private looksLikeTokenError(msg: string): boolean {
    return /token|unauthori[sz]ed|401|403|jwt|auth/i.test(msg);
  }

  // ── Edge JWT path ────────────────────────────────────────────────────────

  private async translateViaEdge(
    text: string,
    from: string,
    to: string,
    startTime: number,
  ): Promise<BingTranslateResult> {
    try {
      return await this.doEdgeTranslate(text, from, to, startTime);
    } catch (err) {
      if (err instanceof BingTranslateError && this.looksLikeTokenError(err.message)) {
        this.token = null;
        this.tokenExpiresAt = 0;
        this.authInFlight = null;
        return await this.doEdgeTranslate(text, from, to, startTime);
      }
      throw err;
    }
  }

  private async getEdgeToken(): Promise<string> {
    if (this.token && this.tokenExpiresAt > this.now() + TOKEN_SKEW_MS) {
      return this.token;
    }
    if (this.authInFlight) {
      try {
        return await this.authInFlight;
      } catch {
        // fall through
      }
    }
    this.authInFlight = this.refreshEdgeToken().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async refreshEdgeToken(): Promise<string> {
    const res = await this.fetchWithTimeout(
      EDGE_AUTH_URL,
      { method: 'GET', headers: { Accept: '*/*' } },
      (m) => new BingTokenFetchError(m),
    );

    if (!res.ok) {
      throw new BingTokenFetchError(`auth request failed: HTTP ${res.status}`);
    }

    const token = (await res.text()).trim();
    if (!token || token.split('.').length < 3) {
      throw new BingTokenFetchError(
        'auth endpoint did not return a JWT (got empty or non-token body). Check network / region access to edge.microsoft.com.',
      );
    }

    const expMs = parseMsTokenExpiryMs(token);
    this.token = token;
    this.tokenExpiresAt = expMs > 0 ? expMs : this.now() + 10 * 60_000;
    return token;
  }

  private async doEdgeTranslate(
    text: string,
    from: string,
    to: string,
    startTime: number,
  ): Promise<BingTranslateResult> {
    const token = await this.getEdgeToken();
    const toCode = mapToBingCode(to);
    const params = new URLSearchParams({
      'api-version': '3.0',
      to: toCode,
    });
    if (from.trim().toLowerCase() !== 'auto') {
      params.set('from', mapToBingCode(from));
    }
    const url = `${EDGE_TRANSLATE_URL}?${params.toString()}`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify([{ Text: text }]),
    });

    if (!res.ok) {
      const bodyPreview = (await res.text().catch(() => '')).slice(0, 200);
      throw new BingTranslateError(
        `translate request failed: HTTP ${res.status}${bodyPreview ? ` — ${bodyPreview}` : ''}`,
      );
    }

    const json = (await res.json().catch(() => null)) as unknown;
    if (!Array.isArray(json) || json.length === 0) {
      throw new BingTranslateError('unexpected response shape (not array)');
    }

    const first = json[0] as {
      translations?: Array<{ text?: string; to?: string }>;
      detectedLanguage?: { language: string; score: number };
      error?: { message?: string; code?: number };
    };

    if (first.error?.message) {
      throw new BingTranslateError(first.error.message);
    }

    const translation = first.translations?.[0]?.text;
    if (typeof translation !== 'string') {
      throw new BingTranslateError('empty translations[]');
    }

    return {
      translatedText: translation,
      detectedLanguage: first.detectedLanguage,
      inferenceTimeMs: this.now() - startTime,
    };
  }

  // ── HTML scrape + ttranslatev3 path ──────────────────────────────────────

  private async translateViaScrape(
    text: string,
    from: string,
    to: string,
    startTime: number,
  ): Promise<BingTranslateResult> {
    try {
      return await this.doScrapeTranslate(text, from, to, startTime);
    } catch (err) {
      // One refresh of the page credentials on auth-ish failure.
      if (
        err instanceof BingTranslateError
        && this.looksLikeTokenError(err.message)
      ) {
        this.scrapeSession = null;
        return await this.doScrapeTranslate(text, from, to, startTime);
      }
      throw err;
    }
  }

  private async getScrapeSession(): Promise<ScrapeSession> {
    if (this.scrapeSession && this.scrapeSession.expiresAt > this.now() + TOKEN_SKEW_MS) {
      return this.scrapeSession;
    }
    if (this.scrapeInFlight) {
      try {
        return await this.scrapeInFlight;
      } catch {
        // fall through
      }
    }
    this.scrapeInFlight = this.refreshScrapeSession().finally(() => {
      this.scrapeInFlight = null;
    });
    return this.scrapeInFlight;
  }

  private async refreshScrapeSession(): Promise<ScrapeSession> {
    let lastError: unknown;
    for (const host of this.scrapeHosts) {
      try {
        const session = await this.fetchScrapeSession(host);
        this.scrapeSession = session;
        return session;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new BingTokenFetchError(String(lastError));
  }

  private async fetchScrapeSession(host: string): Promise<ScrapeSession> {
    const pageUrl = `${host}/translator`;
    const res = await this.fetchWithTimeout(
      pageUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          // Electron main injects Origin/Referer for www/cn.bing.com translator.
        },
        // Let the runtime keep cookies when available (Electron / extension).
        credentials: 'include',
      },
      (m) => new BingTokenFetchError(m),
    );

    if (!res.ok) {
      throw new BingTokenFetchError(`translator page failed: HTTP ${res.status} (${host})`);
    }

    const html = await res.text();
    const page = parseTranslatorPage(html);
    // Abuse token TTL is typically 3_600_000 ms; use key (issue time) + 55 min.
    const issued = Number(page.key);
    const expiresAt = Number.isFinite(issued) && issued > 0
      ? issued + 55 * 60_000
      : this.now() + 55 * 60_000;

    // Prefer final response URL host after redirects (www → cn).
    let resolvedHost = host;
    try {
      if (res.url) resolvedHost = new URL(res.url).origin;
    } catch {
      // keep host
    }

    return {
      host: resolvedHost,
      page,
      expiresAt,
      cookie: mergeSetCookie(res.headers),
    };
  }

  private async doScrapeTranslate(
    text: string,
    from: string,
    to: string,
    startTime: number,
  ): Promise<BingTranslateResult> {
    const session = await this.getScrapeSession();
    const fromCode = from.trim().toLowerCase() === 'auto'
      ? 'auto-detect'
      : mapToBingCode(from);
    const toCode = mapToBingCode(to);
    const { ig, iid, key, token } = session.page;
    const url =
      `${session.host}/ttranslatev3?isVertical=1`
      + `&IG=${encodeURIComponent(ig)}`
      + `&IID=${encodeURIComponent(iid)}`;

    const body = new URLSearchParams({
      fromLang: fromCode,
      text,
      to: toCode,
      token,
      key,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (session.cookie) headers.Cookie = session.cookie;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: body.toString(),
      credentials: 'include',
    });

    if (!res.ok) {
      const preview = (await res.text().catch(() => '')).slice(0, 200);
      throw new BingTranslateError(
        `ttranslatev3 failed: HTTP ${res.status}${preview ? ` — ${preview}` : ''}`,
      );
    }

    // Response may be array or nested array depending on Bing version.
    const json = (await res.json().catch(() => null)) as unknown;
    const first = unwrapBingTranslatePayload(json);
    if (!first) {
      throw new BingTranslateError('unexpected ttranslatev3 response shape');
    }

    if (first.error?.message) {
      throw new BingTranslateError(first.error.message);
    }

    const translation = first.translations?.[0]?.text;
    if (typeof translation !== 'string') {
      throw new BingTranslateError('empty translations[] from ttranslatev3');
    }

    // Fold any new cookies for subsequent calls.
    const extra = mergeSetCookie(res.headers);
    if (extra) {
      session.cookie = mergeCookieStrings(session.cookie, extra);
    }

    return {
      translatedText: translation,
      detectedLanguage: first.detectedLanguage,
      usedLLM: first.usedLLM,
      inferenceTimeMs: this.now() - startTime,
    };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    makeError: (message: string) => Error = (m) => new BingTranslateError(m),
  ): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `request timed out after ${this.fetchTimeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw makeError(message);
    } finally {
      clearTimeout(t);
    }
  }
}

/** Normalize Bing's sometimes-double-wrapped JSON response. */
export function unwrapBingTranslatePayload(json: unknown): {
  translations?: Array<{ text?: string; to?: string }>;
  detectedLanguage?: { language: string; score: number };
  usedLLM?: boolean;
  error?: { message?: string; code?: number };
} | null {
  if (!json) return null;
  if (Array.isArray(json)) {
    const head = json[0];
    if (Array.isArray(head)) return unwrapBingTranslatePayload(head);
    if (head && typeof head === 'object') return head as ReturnType<typeof unwrapBingTranslatePayload>;
  }
  if (typeof json === 'object') return json as ReturnType<typeof unwrapBingTranslatePayload>;
  return null;
}

function mergeSetCookie(headers: Headers): string {
  // Headers.getSetCookie is available in modern runtimes; fall back to get().
  const list = typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
    ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
    : (() => {
        const single = headers.get('set-cookie');
        return single ? [single] : [];
      })();
  const pairs: string[] = [];
  for (const raw of list) {
    const pair = raw.split(';')[0]?.trim();
    if (pair && pair.includes('=')) pairs.push(pair);
  }
  return pairs.join('; ');
}

function mergeCookieStrings(a: string, b: string): string {
  const map = new Map<string, string>();
  for (const part of `${a}; ${b}`.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
