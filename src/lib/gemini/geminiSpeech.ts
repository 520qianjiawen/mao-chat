// src/lib/gemini/geminiSpeech.ts
import { encodeMonoPcm16Wav } from '../../utils/ttsAudioExport';

export const GEMINI_TTS_DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
export const GEMINI_TRANSLATE_DEFAULT_MODEL = 'gemini-2.5-flash';
export const GEMINI_TTS_FALLBACK_MODELS = [
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
] as const;

export const GEMINI_DEFAULT_HOST = 'https://generativelanguage.googleapis.com';
const DEFAULT_TTS_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSLATE_TIMEOUT_MS = 30_000;

/**
 * High-quality prebuilt voices supported by Gemini audio generation.
 */
export const GEMINI_SPEECH_VOICES = [
  { id: 'Puck', name: 'Puck (男声 · 阳光活力)', gender: 'male' },
  { id: 'Charon', name: 'Charon (男声 · 沉稳成熟)', gender: 'male' },
  { id: 'Kore', name: 'Kore (女声 · 亲切明亮)', gender: 'female' },
  { id: 'Fenrir', name: 'Fenrir (男声 · 权威深沉)', gender: 'male' },
  { id: 'Aoede', name: 'Aoede (女声 · 典雅温柔)', gender: 'female' },
  { id: 'Leda', name: 'Leda (女声 · 灵动自然)', gender: 'female' },
  { id: 'Orus', name: 'Orus (男声 · 磁性清晰)', gender: 'male' },
  { id: 'Zephyr', name: 'Zephyr (中性 · 清脆活泼)', gender: 'neutral' },
  { id: 'Achernar', name: 'Achernar (男声 · 低沉浑厚)', gender: 'male' },
  { id: 'Gacrux', name: 'Gacrux (男声 · 温暖从容)', gender: 'male' },
  { id: 'Sadachbia', name: 'Sadachbia (女声 · 柔和知性)', gender: 'female' },
  { id: 'Enceladus', name: 'Enceladus (男声 · 热情开朗)', gender: 'male' },
  { id: 'Callirrhoe', name: 'Callirrhoe (女声 · 优雅从容)', gender: 'female' },
] as const;

export type GeminiSpeechVoice = typeof GEMINI_SPEECH_VOICES[number]['id'];

export interface GeminiSpeechEmotion {
  id: string;
  name: string;
  nameZh: string;
  prompt: string;
}

/**
 * Granular emotion and style presets for Gemini TTS.
 */
export const GEMINI_SPEECH_EMOTIONS: GeminiSpeechEmotion[] = [
  {
    id: 'natural',
    name: 'Natural',
    nameZh: '自然流利',
    prompt: 'Speak naturally with balanced inflection, clear articulation, and steady cadence.',
  },
  {
    id: 'cheerful',
    name: 'Cheerful',
    nameZh: '欢快愉悦',
    prompt: 'Voice affect: Cheerful, upbeat, and joyful. Tone: Enthusiastic, warm, smiling delivery with lively rhythm.',
  },
  {
    id: 'warm',
    name: 'Warm & Caring',
    nameZh: '温柔体贴',
    prompt: 'Voice affect: Warm, gentle, and compassionate. Tone: Kind, comforting, and reassuring with a soft vocal touch.',
  },
  {
    id: 'calm',
    name: 'Calm & Soothing',
    nameZh: '平静舒缓',
    prompt: 'Voice affect: Calm, peaceful, and relaxed. Pacing: Unhurried and steady with gentle breaths between sentences.',
  },
  {
    id: 'serious',
    name: 'Professional & Serious',
    nameZh: '严肃庄重',
    prompt: 'Voice affect: Serious, authoritative, and formal. Tone: Professional, objective, and composed with precise diction.',
  },
  {
    id: 'whisper',
    name: 'Whisper',
    nameZh: '低语耳语',
    prompt: 'Voice affect: Breathy, intimate, and quiet whisper. Pacing: Soft and close to the ear.',
  },
  {
    id: 'dramatic',
    name: 'Dramatic & Storytelling',
    nameZh: '戏剧表现',
    prompt: 'Voice affect: Dramatic, emotionally rich, and expressive. Tone: Cinematic storytelling with dynamic pauses and emotional depth.',
  },
  {
    id: 'custom',
    name: 'Custom Prompt',
    nameZh: '自定义情感/提示词',
    prompt: '',
  },
];

export const DEFAULT_GEMINI_EMOTION = 'natural';

function normalizeHost(host?: string): string {
  return (host || GEMINI_DEFAULT_HOST).replace(/\/$/, '');
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Checks if the buffer starts with the standard RIFF/WAVE header.
 */
function isRiffWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return (
    bytes[0] === 0x52 && // 'R'
    bytes[1] === 0x49 && // 'I'
    bytes[2] === 0x46 && // 'F'
    bytes[3] === 0x46 && // 'F'
    bytes[8] === 0x57 && // 'W'
    bytes[9] === 0x41 && // 'A'
    bytes[10] === 0x56 && // 'V'
    bytes[11] === 0x45    // 'E'
  );
}

function parseSampleRateFromMime(mimeType: string, fallback = 24_000): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/**
 * Format raw audio bytes into an ArrayBuffer (standard WAV).
 */
export function formatGeminiAudioToWav(
  bytes: Uint8Array,
  mimeType = '',
  sampleRate = 24_000,
): ArrayBuffer {
  // If already WAV format, return ArrayBuffer directly
  if (isRiffWav(bytes) || mimeType.includes('wav')) {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
  }

  // Raw PCM16 format from Gemini (default 24 kHz, 16-bit mono signed LE)
  const resolvedRate = parseSampleRateFromMime(mimeType, sampleRate);
  const pcmLength = Math.floor(bytes.length / 2);
  const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, pcmLength);
  return encodeMonoPcm16Wav([pcm16], resolvedRate);
}

async function readGeminiError(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as any;
    if (json.error?.message) return json.error.message;
    if (json.message) return json.message;
  } catch {
    // ignore non-json
  }
  return `Gemini API request failed (${response.status})`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new Error(`Gemini API 请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function buildSpeechInputText(text: string, emotionPrompt?: string, speed?: number): string {
  const directives: string[] = [];
  if (emotionPrompt && emotionPrompt.trim()) {
    directives.push(emotionPrompt.trim());
  }
  if (typeof speed === 'number' && Number.isFinite(speed) && Math.abs(speed - 1) >= 0.05) {
    const paceLabel = speed > 1 ? 'faster' : 'slower';
    directives.push(`Speaking speed: ${speed.toFixed(2)}x (${paceLabel} than normal).`);
  }
  if (directives.length === 0) return text;
  return `Read the following text aloud with this delivery style — ${directives.join(' ')}\n\n${text}`;
}

/**
 * Synthesize speech from text using Google Gemini TTS.
 */
export async function createGeminiSpeech(opts: {
  apiKey: string;
  apiHost?: string;
  model?: string;
  text: string;
  voice: string;
  speed?: number;
  emotionPrompt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ArrayBuffer> {
  if (!opts.apiKey) {
    throw new Error('Missing Gemini API Key');
  }

  const host = normalizeHost(opts.apiHost);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const modelsToTry = opts.model
    ? [opts.model]
    : [...GEMINI_TTS_FALLBACK_MODELS];

  const promptText = buildSpeechInputText(opts.text, opts.emotionPrompt, opts.speed);
  const body: Record<string, any> = {
    contents: [
      {
        role: 'user',
        parts: [{ text: promptText }],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: opts.voice || 'Puck',
          },
        },
      },
    },
  };

  let lastError: Error | null = null;
  for (let i = 0; i < modelsToTry.length; i += 1) {
    const model = modelsToTry[i];
    const url = `${host}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
      opts.signal,
    );

    if (!response.ok) {
      const errorMsg = await readGeminiError(response);
      lastError = new Error(errorMsg);
      // Fallback to next candidate model only on 404 (model unavailable)
      if (response.status === 404 && i < modelsToTry.length - 1) {
        continue;
      }
      throw lastError;
    }

    const json = (await response.json()) as any;
    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    for (const part of parts) {
      if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || 'audio/wav';
        const rawBytes = base64ToUint8Array(part.inlineData.data);
        return formatGeminiAudioToWav(rawBytes, mimeType, 24_000);
      }
    }

    throw new Error('Gemini API did not return audio data in the response.');
  }

  throw lastError || new Error('Gemini TTS request failed.');
}

/**
 * Text translation using Gemini Flash model.
 */
export async function translateWithGemini(opts: {
  apiKey: string;
  apiHost?: string;
  model?: string;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ translatedText: string; inferenceTimeMs: number }> {
  const started = performance.now();
  const model = opts.model || GEMINI_TRANSLATE_DEFAULT_MODEL;
  const host = normalizeHost(opts.apiHost);
  const url = `${host}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  const prompt = `Translate the following text from ${opts.sourceLanguage} to ${opts.targetLanguage}. Output ONLY the translated text without explanations, greetings, or formatting fences.\n\n${opts.text}`;

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      }),
    },
    opts.timeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS,
    opts.signal,
  );

  if (!response.ok) {
    throw new Error(await readGeminiError(response));
  }

  const json = (await response.json()) as any;
  const translated = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return {
    translatedText: translated,
    inferenceTimeMs: Math.round(performance.now() - started),
  };
}
