// src/lib/ollama-translator/OllamaTranslatorClient.ts
import { LANGUAGE_OPTIONS } from '../../utils/languages';
import { unwrapTranslationText } from '../../utils/textUtils';

export interface OllamaModelItem {
  name: string;
  model: string;
  size: number;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
}

export interface OllamaTranslatorClientOptions {
  endpoint?: string;
  fetchFn?: typeof fetch;
}

export interface OllamaTranslationResult {
  sourceText: string;
  translatedText: string;
  inferenceTimeMs: number;
}

export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';

/**
 * Fetch adapter that prioritizes Electron main-process IPC proxy ('ollama-fetch')
 * to guarantee zero CORS issues across all environments, falling back to global fetch.
 */
export function createOllamaAwareFetch(): typeof fetch {
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
      try {
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
        const result = await electronInvoke('ollama-fetch', {
          url,
          method: init?.method || 'GET',
          headers,
          body: typeof init?.body === 'string' ? init.body : undefined,
        }) as { ok: boolean; status: number; headers: Record<string, string>; body: string; error?: string };

        if (result && typeof result.status === 'number') {
          return new Response(result.body, {
            status: result.status || (result.ok ? 200 : 500),
            statusText: result.error || '',
            headers: result.headers,
          });
        }
      } catch (err) {
        // Fall back to direct fetch if invoke failed
        console.warn('[Ollama] IPC fetch error, falling back to window.fetch:', err);
      }
    }
    return fetch(input, init);
  };
}

/**
 * Ping Ollama to check if service is alive.
 */
export async function checkOllamaHealthy(
  endpoint = DEFAULT_OLLAMA_ENDPOINT,
  customFetch: typeof fetch = createOllamaAwareFetch(),
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await customFetch(`${endpoint.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Retrieve installed chat/translation models from local Ollama service.
 * Filters out embedding-only models.
 */
export async function fetchOllamaModels(
  endpoint = DEFAULT_OLLAMA_ENDPOINT,
  customFetch: typeof fetch = createOllamaAwareFetch(),
): Promise<OllamaModelItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await customFetch(`${endpoint.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return [];

    const data = await res.json();
    if (!Array.isArray(data?.models)) return [];

    return data.models
      .filter((m: any) => {
        const name = (m.name || '').toLowerCase();
        // Skip dedicated embedding models
        if (name.includes('embed') || name.includes('bge-') || name.includes('gte-')) {
          return false;
        }
        return true;
      })
      .map((m: any) => ({
        name: m.name,
        model: m.model || m.name,
        size: m.size || 0,
        family: m.details?.family,
        parameterSize: m.details?.parameter_size,
        quantizationLevel: m.details?.quantization_level,
      }));
  } catch (err) {
    console.debug('[Ollama] Failed to fetch models from Ollama:', err);
    return [];
  }
}

/**
 * Client for translating text with local Ollama models.
 */
export class OllamaTranslatorClient {
  private endpoint: string;
  private modelId: string;
  private sourceLang: string = '';
  private targetLang: string = '';
  private fetchFn: typeof fetch;
  private abortController: AbortController | null = null;

  constructor(options?: OllamaTranslatorClientOptions) {
    this.endpoint = (options?.endpoint || DEFAULT_OLLAMA_ENDPOINT).replace(/\/$/, '');
    this.fetchFn = options?.fetchFn || createOllamaAwareFetch();
    this.modelId = 'translategemma:12b';
  }

  async init(
    sourceLang: string,
    targetLang: string,
    modelId?: string,
    options?: { endpoint?: string },
  ): Promise<{ loadTimeMs: number }> {
    const t0 = performance.now();
    this.sourceLang = sourceLang || '';
    this.targetLang = targetLang || '';
    if (modelId) {
      this.modelId = modelId;
    }
    if (options?.endpoint) {
      this.endpoint = options.endpoint.replace(/\/$/, '');
    }
    return { loadTimeMs: Math.round(performance.now() - t0) };
  }

  async translate(
    text: string,
    systemPrompt = '',
    _wrapTranscript = false,
  ): Promise<OllamaTranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { sourceText: text, translatedText: '', inferenceTimeMs: 0 };
    }

    const t0 = performance.now();
    const actualModelName = this.modelId.startsWith('ollama:')
      ? this.modelId.slice('ollama:'.length)
      : this.modelId;

    const curSourceLang = this.sourceLang;
    const curTargetLang = this.targetLang;
    const srcDisplay = curSourceLang === 'auto' || !curSourceLang
      ? 'the source language'
      : (LANGUAGE_OPTIONS[curSourceLang]?.englishName || curSourceLang);
    const tgtDisplay = LANGUAGE_OPTIONS[curTargetLang]?.englishName || curTargetLang;

    const prompt = systemPrompt && systemPrompt.trim().length > 0
      ? systemPrompt
      : `You are a professional translator. Translate the text from ${srcDisplay} to ${tgtDisplay} accurately and fluently. Preserve all formatting, line breaks, and nuances. Output ONLY the translation. No explanations, notes, or commentary.`;

    this.abortController = new AbortController();

    const payload = {
      model: actualModelName,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: trimmed },
      ],
      stream: false,
      options: {
        temperature: 0.1,
      },
    };

    const url = `${this.endpoint}/api/chat`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: this.abortController.signal,
    });

    if (!res.ok) {
      let errBody = '';
      try {
        errBody = await res.text();
      } catch {}
      throw new Error(`Ollama translation failed (${res.status}): ${errBody || res.statusText}`);
    }

    const json = await res.json();
    const rawOutput = json?.message?.content ?? json?.response ?? '';
    const translatedText = unwrapTranslationText(rawOutput).trim();

    return {
      sourceText: text,
      translatedText,
      inferenceTimeMs: Math.round(performance.now() - t0),
    };
  }

  dispose(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
