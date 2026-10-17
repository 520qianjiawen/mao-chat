import { Provider, type ProviderType } from '../../types/Provider';

export const OPENAI_SPEECH_MODEL = 'gpt-4o-mini-tts';
export const OPENAI_SPEECH_DEFAULT_HOST = 'https://api.openai.com';

/** Official Speech generation voices (gpt-4o-mini-tts). */
export const OPENAI_SPEECH_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'cedar',
  'coral',
  'echo',
  'fable',
  'marin',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
] as const;

export type OpenAISpeechVoice = (typeof OPENAI_SPEECH_VOICES)[number];

export interface OpenAISpeechVibe {
  id: string;
  name: string;
  nameZh: string;
  instructions: string;
}

/** openai.fm-style delivery presets. Sincere is the product-intro default. */
export const OPENAI_SPEECH_VIBES: OpenAISpeechVibe[] = [
  {
    id: 'sincere',
    name: 'Sincere',
    nameZh: '真诚',
    instructions: [
      'Voice Affect: Calm, composed, and reassuring; project quiet authority and warmth.',
      'Tone: Sincere and unhurried; speak as if explaining something important to a trusted friend.',
      'Pacing: Steady and measured; pause briefly after key product points.',
      'Pronunciation: Clear and natural; do not sound like an advertisement or a trailer.',
    ].join(' '),
  },
  {
    id: 'professional',
    name: 'Professional',
    nameZh: '专业',
    instructions: [
      'Voice Affect: Confident, clear, and composed.',
      'Tone: Professional and informative; suitable for a product briefing.',
      'Pacing: Even and businesslike; emphasize product names cleanly.',
    ].join(' '),
  },
  {
    id: 'calm',
    name: 'Calm',
    nameZh: '平静',
    instructions: [
      'Voice Affect: Soft, low, and settled.',
      'Tone: Calm and thoughtful; no urgency or hype.',
      'Pacing: Slightly slow; leave space between sentences.',
    ].join(' '),
  },
  {
    id: 'warm',
    name: 'Warm',
    nameZh: '温暖',
    instructions: [
      'Voice Affect: Friendly and approachable.',
      'Tone: Warm and inviting; make the listener feel welcome.',
      'Pacing: Natural conversational rhythm.',
    ].join(' '),
  },
  {
    id: 'dramatic',
    name: 'Dramatic',
    nameZh: '戏剧',
    instructions: [
      'Voice Affect: Expressive and cinematic.',
      'Tone: Dramatic and emotionally rich; suitable for a trailer.',
      'Pacing: Varied; linger on key words.',
    ].join(' '),
  },
  {
    id: 'none',
    name: 'None',
    nameZh: '无',
    instructions: '',
  },
];

export const DEFAULT_OPENAI_SPEECH_VIBE = 'sincere';

export function isOpenAISpeechProvider(provider: ProviderType): boolean {
  return provider === Provider.OPENAI
    || provider === Provider.OPENAI_TRANSLATE
    || provider === Provider.OPENAI_COMPATIBLE;
}

function normalizeHost(apiHost?: string): string {
  return (apiHost || OPENAI_SPEECH_DEFAULT_HOST).replace(/\/$/, '');
}

async function readOpenAIError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch { /* ignore non-JSON error bodies */ }
  return `OpenAI request failed (${response.status})`;
}

export async function createOpenAISpeech(opts: {
  apiKey: string;
  apiHost?: string;
  text: string;
  voice: string;
  speed?: number;
  instructions?: string;
}): Promise<ArrayBuffer> {
  const response = await fetch(`${normalizeHost(opts.apiHost)}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_SPEECH_MODEL,
      voice: opts.voice,
      input: opts.text,
      speed: opts.speed ?? 1,
      response_format: 'wav',
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    }),
  });
  if (!response.ok) throw new Error(await readOpenAIError(response));
  return response.arrayBuffer();
}

export async function translateWithOpenAI(opts: {
  apiKey: string;
  apiHost?: string;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
}): Promise<{ translatedText: string; inferenceTimeMs: number }> {
  const started = performance.now();
  const response = await fetch(`${normalizeHost(opts.apiHost)}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `Translate from ${opts.sourceLanguage} to ${opts.targetLanguage}. Return only the translation, with no quotes or commentary.`,
        },
        { role: 'user', content: opts.text },
      ],
    }),
  });
  if (!response.ok) throw new Error(await readOpenAIError(response));
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const translatedText = body.choices?.[0]?.message?.content?.trim() || '';
  return { translatedText, inferenceTimeMs: Math.round(performance.now() - started) };
}
