/// <reference lib="webworker" />
// Thin worker wrapper around GoogleTranslatorClient — same message protocol
// as bing-translation.worker.ts so TranslationEngine needs no special casing.

import {
  GoogleTranslatorClient,
  GoogleTranslateError,
  GoogleUnsupportedLanguageError,
} from '../../google-translator';

type InMessage =
  | { type: 'init'; sourceLang: string; targetLang: string }
  | { type: 'translate'; id: string; text: string; systemPrompt?: string; wrapTranscript?: boolean }
  | { type: 'dispose' };

type OutMessage =
  | { type: 'ready'; device: string; loadTimeMs: number }
  | {
      type: 'result';
      id: string;
      sourceText: string;
      translatedText: string;
      inferenceTimeMs: number;
      detectedLanguage?: { language: string; score: number };
    }
  | { type: 'error'; id?: string; error: string }
  | { type: 'disposed' };

let client: GoogleTranslatorClient | null = null;
let sourceLang = '';
let targetLang = '';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: OutMessage) {
  ctx.postMessage(msg);
}

ctx.onmessage = async (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': {
      const start = performance.now();
      sourceLang = msg.sourceLang;
      targetLang = msg.targetLang;
      client = new GoogleTranslatorClient();
      post({ type: 'ready', device: 'cloud', loadTimeMs: performance.now() - start });
      break;
    }

    case 'translate': {
      if (!client) {
        post({ type: 'error', id: msg.id, error: 'worker not initialized' });
        return;
      }
      try {
        const result = await client.translate(msg.text, sourceLang, targetLang);
        post({
          type: 'result',
          id: msg.id,
          sourceText: msg.text,
          translatedText: result.translatedText,
          inferenceTimeMs: result.inferenceTimeMs,
          detectedLanguage: result.detectedLanguage,
        });
      } catch (err) {
        const errorType = classifyError(err);
        const raw = err instanceof Error ? err.message : String(err);
        post({
          type: 'error',
          id: msg.id,
          error: `[google:${errorType}] ${raw}`,
        });
      }
      break;
    }

    case 'dispose': {
      client = null;
      post({ type: 'disposed' });
      break;
    }
  }
};

function classifyError(err: unknown): 'unsupported' | 'network' | 'unknown' {
  if (err instanceof GoogleUnsupportedLanguageError) return 'unsupported';
  if (err instanceof GoogleTranslateError) return 'network';
  return 'unknown';
}
