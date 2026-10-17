// GoogleTranslatorClient — free Google Translate (gtx) endpoint used by
// kiss-translator as OPT_TRANS_GOOGLE.
//
//   GET https://translate.googleapis.com/translate_a/single
//     ?client=gtx&dt=t&dj=1&ie=UTF-8&sl=<from>&tl=<to>&q=<text>
//
// No API key. Response (dj=1):
//   { sentences: [{ trans, orig }, ...], src: "en" }
//
// Intended as a cloud fallback next to Bing/Microsoft Edge translate.

import { mapToGoogleCode, isSupportedByGoogle } from './languageMap';

export class GoogleTranslateError extends Error {
  readonly errorType = 'network' as const;
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTranslateError';
  }
}

export class GoogleUnsupportedLanguageError extends Error {
  readonly errorType = 'unsupported' as const;
  constructor(message: string) {
    super(message);
    this.name = 'GoogleUnsupportedLanguageError';
  }
}

export interface GoogleTranslateResult {
  translatedText: string;
  detectedLanguage?: { language: string; score: number };
  inferenceTimeMs: number;
}

export interface GoogleTranslatorClientOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  fetchTimeoutMs?: number;
  /** Override the gtx endpoint (tests / mirrors). */
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const DEFAULT_TIMEOUT = 12_000;
/** gtx URL length budget — stay well under common proxy/CDN limits. */
const MAX_QUERY_CHARS = 1800;

export class GoogleTranslatorClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private readonly endpoint: string;

  constructor(options: GoogleTranslatorClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_TIMEOUT;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  }

  async translate(text: string, from: string, to: string): Promise<GoogleTranslateResult> {
    const autoSource = from.trim().toLowerCase() === 'auto';
    if (!autoSource && !isSupportedByGoogle(from)) {
      throw new GoogleUnsupportedLanguageError(`source language not supported: ${from}`);
    }
    if (!isSupportedByGoogle(to)) {
      throw new GoogleUnsupportedLanguageError(`target language not supported: ${to}`);
    }

    const start = this.now();
    const trimmed = text.trim();
    if (!trimmed) {
      return { translatedText: '', inferenceTimeMs: 0 };
    }

    // Long ASR captions: split by sentence-ish boundaries, translate each chunk,
    // then rejoin. Keeps us under URL limits without losing punctuation.
    const chunks = splitForGoogle(trimmed);
    const parts: string[] = [];
    let detected: { language: string; score: number } | undefined;

    for (const chunk of chunks) {
      const r = await this.translateChunk(chunk, from, to);
      if (r.translatedText) parts.push(r.translatedText);
      detected ??= r.detectedLanguage;
    }

    return {
      translatedText: joinTranslatedChunks(parts, to),
      detectedLanguage: detected,
      inferenceTimeMs: this.now() - start,
    };
  }

  private async translateChunk(
    text: string,
    from: string,
    to: string,
  ): Promise<GoogleTranslateResult> {
    const sl = from.trim().toLowerCase() === 'auto' ? 'auto' : mapToGoogleCode(from);
    const tl = mapToGoogleCode(to);
    const params = new URLSearchParams({
      client: 'gtx',
      dt: 't',
      dj: '1',
      ie: 'UTF-8',
      sl,
      tl,
      q: text,
    });
    const url = `${this.endpoint}?${params.toString()}`;

    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const preview = (await res.text().catch(() => '')).slice(0, 160);
      throw new GoogleTranslateError(
        `translate request failed: HTTP ${res.status}${preview ? ` — ${preview}` : ''}`,
      );
    }

    const json = (await res.json().catch(() => null)) as {
      sentences?: Array<{ trans?: string; orig?: string }>;
      src?: string;
    } | null;

    if (!json || !Array.isArray(json.sentences)) {
      throw new GoogleTranslateError('unexpected response shape (missing sentences[])');
    }

    const translatedText = json.sentences
      .map((s) => s.trans ?? '')
      .join('')
      .trim();

    if (!translatedText) {
      throw new GoogleTranslateError('empty translation');
    }

    return {
      translatedText,
      detectedLanguage: json.src
        ? { language: json.src, score: 1 }
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
      throw new GoogleTranslateError(message);
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Split long source text into URL-safe chunks at sentence/clause boundaries.
 * Exported for unit tests.
 */
export function splitForGoogle(text: string, maxChars = MAX_QUERY_CHARS): string[] {
  const value = text.trim();
  if (!value) return [];
  if (value.length <= maxChars) return [value];

  const hardSplit = (s: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
    return out;
  };

  const parts: string[] = [];
  // Prefer sentence ends, then clause commas, then hard length.
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
