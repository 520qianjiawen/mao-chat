// DeepLTranslatorClient — official DeepL REST API (Free + Pro).
//
// Free keys end with ":fx" and hit https://api-free.deepl.com
// Pro keys hit https://api.deepl.com
//
// Auth: Authorization: DeepL-Auth-Key <key>
// Translate: POST /v2/translate  { text: string[], source_lang?, target_lang }
// Usage:     GET  /v2/usage

import {
  isSupportedByDeepL,
  mapToDeepLSourceCode,
  mapToDeepLTargetCode,
} from './languageMap';

export class DeepLTranslateError extends Error {
  readonly errorType = 'network' as const;
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DeepLTranslateError';
    this.status = status;
  }
}

export class DeepLUnsupportedLanguageError extends Error {
  readonly errorType = 'unsupported' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DeepLUnsupportedLanguageError';
  }
}

export class DeepLAuthError extends Error {
  readonly errorType = 'auth' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DeepLAuthError';
  }
}

export interface DeepLTranslateResult {
  translatedText: string;
  detectedLanguage?: { language: string; score: number };
  inferenceTimeMs: number;
}

export interface DeepLTranslatorClientOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  fetchTimeoutMs?: number;
  /** Override free/pro base URL (tests). */
  baseUrl?: string;
}

const DEFAULT_TIMEOUT = 20_000;
/** DeepL recommends keeping individual request bodies reasonable. */
const MAX_CHUNK_CHARS = 4500;

/** Free API keys end with ":fx" (DeepL Free). Pro keys do not. */
export function isDeepLFreeAuthKey(authKey: string): boolean {
  return authKey.trim().endsWith(':fx');
}

export function resolveDeepLBaseUrl(authKey: string): string {
  return isDeepLFreeAuthKey(authKey)
    ? 'https://api-free.deepl.com'
    : 'https://api.deepl.com';
}

/**
 * Fetch that works from the Electron renderer: DeepL does not send CORS headers,
 * so production Electron (webSecurity on) must proxy through main. Extension pages
 * with host_permissions can use plain fetch. Falls back to global fetch otherwise.
 */
export function createDeepLAwareFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    const electronInvoke = (typeof window !== 'undefined'
      ? (window as unknown as { electron?: { invoke?: (ch: string, data: unknown) => Promise<unknown> } }).electron?.invoke
      : undefined);

    if (electronInvoke) {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) headers[k] = v;
        } else {
          Object.assign(headers, init.headers);
        }
      }
      const result = await electronInvoke('deepl-fetch', {
        url,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : init?.body == null ? null : String(init.body),
      }) as {
        ok: boolean;
        status: number;
        headers: Record<string, string>;
        body: string;
        error?: string;
      };
      if (result.error && !result.status) {
        throw new TypeError(result.error);
      }
      return new Response(result.body, {
        status: result.status || 0,
        headers: result.headers || {},
      });
    }

    return fetch(input, init);
  };
}

export class DeepLTranslatorClient {
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: DeepLTranslatorClientOptions) {
    const key = (options.apiKey || '').trim();
    if (!key) {
      throw new DeepLAuthError('DeepL API key is required');
    }
    this.apiKey = key;
    this.fetchFn = options.fetchFn ?? createDeepLAwareFetch();
    this.now = options.now ?? (() => Date.now());
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_TIMEOUT;
    this.baseUrl = options.baseUrl ?? resolveDeepLBaseUrl(key);
  }

  async translate(text: string, from: string, to: string): Promise<DeepLTranslateResult> {
    const autoSource = from.trim().toLowerCase() === 'auto';
    if (!autoSource && !isSupportedByDeepL(from)) {
      throw new DeepLUnsupportedLanguageError(`source language not supported: ${from}`);
    }
    if (!isSupportedByDeepL(to)) {
      throw new DeepLUnsupportedLanguageError(`target language not supported: ${to}`);
    }

    const start = this.now();
    const trimmed = text.trim();
    if (!trimmed) {
      return { translatedText: '', inferenceTimeMs: 0 };
    }

    const sourceLang = autoSource ? undefined : mapToDeepLSourceCode(from);
    const targetLang = mapToDeepLTargetCode(to);
    const chunks = splitForDeepL(trimmed);
    const parts: string[] = [];
    let detected: { language: string; score: number } | undefined;

    for (const chunk of chunks) {
      const r = await this.translateChunk(chunk, sourceLang, targetLang);
      if (r.translatedText) parts.push(r.translatedText);
      detected ??= r.detectedLanguage;
    }

    return {
      translatedText: joinTranslatedChunks(parts, to),
      detectedLanguage: detected,
      inferenceTimeMs: this.now() - start,
    };
  }

  /** Cheap auth check used by settings validation. */
  async validateAuthKey(): Promise<{ characterCount: number; characterLimit: number }> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v2/usage`, {
      method: 'GET',
      headers: {
        Authorization: `DeepL-Auth-Key ${this.apiKey}`,
        Accept: 'application/json',
      },
    });
    if (res.status === 403 || res.status === 401) {
      throw new DeepLAuthError(`invalid DeepL API key (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const preview = (await res.text().catch(() => '')).slice(0, 160);
      throw new DeepLTranslateError(
        `usage request failed: HTTP ${res.status}${preview ? ` — ${preview}` : ''}`,
        res.status,
      );
    }
    const json = (await res.json().catch(() => null)) as {
      character_count?: number;
      character_limit?: number;
    } | null;
    return {
      characterCount: json?.character_count ?? 0,
      characterLimit: json?.character_limit ?? 0,
    };
  }

  private async translateChunk(
    text: string,
    sourceLang: string | undefined,
    targetLang: string,
  ): Promise<DeepLTranslateResult> {
    const body: { text: string[]; target_lang: string; source_lang?: string } = {
      text: [text],
      target_lang: targetLang,
    };
    if (sourceLang) body.source_lang = sourceLang;

    const res = await this.fetchWithTimeout(`${this.baseUrl}/v2/translate`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 403 || res.status === 401) {
      throw new DeepLAuthError(`invalid DeepL API key (HTTP ${res.status})`);
    }
    if (res.status === 456) {
      throw new DeepLTranslateError('DeepL quota exceeded', 456);
    }
    if (!res.ok) {
      const preview = (await res.text().catch(() => '')).slice(0, 160);
      throw new DeepLTranslateError(
        `translate request failed: HTTP ${res.status}${preview ? ` — ${preview}` : ''}`,
        res.status,
      );
    }

    const json = (await res.json().catch(() => null)) as {
      translations?: Array<{ text?: string; detected_source_language?: string }>;
    } | null;

    const first = json?.translations?.[0];
    const translatedText = (first?.text ?? '').trim();
    if (!translatedText) {
      throw new DeepLTranslateError('empty translation');
    }

    return {
      translatedText,
      detectedLanguage: first?.detected_source_language
        ? { language: first.detected_source_language.toLowerCase(), score: 1 }
        : undefined,
      inferenceTimeMs: 0,
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
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
      throw new DeepLTranslateError(message);
    } finally {
      clearTimeout(t);
    }
  }
}

/** Split long source text into body-safe chunks at sentence boundaries. */
export function splitForDeepL(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const value = text.trim();
  if (!value) return [];
  if (value.length <= maxChars) return [value];

  const hardSplit = (s: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
    return out;
  };

  const parts: string[] = [];
  const re = /[^.!?。！？；;]+[.!?。！？；;]?/gu;
  let buf = '';
  for (const m of value.match(re) ?? [value]) {
    const piece = m.trim();
    if (!piece) continue;
    if (piece.length > maxChars) {
      if (buf) {
        parts.push(buf);
        buf = '';
      }
      parts.push(...hardSplit(piece));
      continue;
    }
    if (!buf) {
      buf = piece;
      continue;
    }
    if (buf.length + 1 + piece.length <= maxChars) {
      buf = `${buf} ${piece}`.replace(/\s+/g, ' ').trim();
    } else {
      parts.push(buf);
      buf = piece;
    }
  }
  if (buf) parts.push(buf);
  return parts.length ? parts : hardSplit(value);
}

function joinTranslatedChunks(parts: string[], targetLang: string): string {
  if (parts.length <= 1) return parts[0] ?? '';
  const cjk = /^(zh|ja|yue)/i.test(targetLang) || targetLang.toLowerCase().startsWith('zh');
  return parts.map((p) => p.trim()).filter(Boolean).join(cjk ? '' : ' ');
}
