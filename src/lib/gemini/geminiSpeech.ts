// src/lib/gemini/geminiSpeech.ts
import { encodeMonoPcm16Wav } from '../../utils/ttsAudioExport';

export const GEMINI_TTS_DEFAULT_MODEL = 'gemini-3.8-flash-tts';
export const GEMINI_TTS_FALLBACK_MODELS = [
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
] as const;

export const GEMINI_DEFAULT_HOST = 'https://generativelanguage.googleapis.com';

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
 * Granular emotion and style presets for Gemini 3.8 Flash TTS.
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

  // Raw PCM16 format from Gemini (24 kHz, 16-bit mono signed LE)
  const pcmLength = Math.floor(bytes.length / 2);
  const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, pcmLength);
  return encodeMonoPcm16Wav([pcm16], sampleRate);
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

/**
 * Synthesize speech from text using Google Gemini 3.8 Flash TTS.
 */
export async function createGeminiSpeech(opts: {
  apiKey: string;
  apiHost?: string;
  model?: string;
  text: string;
  voice: string;
  speed?: number;
  emotionPrompt?: string;
}): Promise<ArrayBuffer> {
  if (!opts.apiKey) {
    throw new Error('Missing Gemini API Key');
  }

  const model = opts.model || GEMINI_TTS_DEFAULT_MODEL;
  const host = normalizeHost(opts.apiHost);
  const url = `${host}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  const part: Record<string, any> = {
    text: opts.text,
  };

  // Add emotion and vocal style control via speech_metadata (Gemini 3.8 Flash TTS standard)
  if (opts.emotionPrompt && opts.emotionPrompt.trim()) {
    const style = opts.emotionPrompt.trim();
    part.speech_metadata = { style };
    part.speechMetadata = { style };
  }

  const body: Record<string, any> = {
    contents: [
      {
        role: 'user',
        parts: [part],
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

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorMsg = await readGeminiError(response);
    throw new Error(errorMsg);
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
}): Promise<{ translatedText: string; inferenceTimeMs: number }> {
  const started = performance.now();
  const model = opts.model || 'gemini-2.5-flash';
  const host = normalizeHost(opts.apiHost);
  const url = `${host}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  const prompt = `Translate the following text from ${opts.sourceLanguage} to ${opts.targetLanguage}. Output ONLY the translated text without explanations, greetings, or formatting fences.\n\n${opts.text}`;

  const response = await fetch(url, {
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
  });

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
