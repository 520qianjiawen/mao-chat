import { describe, expect, it, vi, afterEach } from 'vitest';
import { Provider } from '../../types/Provider';
import {
  createOpenAISpeech,
  isOpenAISpeechProvider,
  translateWithOpenAI,
} from './openaiSpeech';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isOpenAISpeechProvider', () => {
  it('covers OpenAI, Translate, and Compatible', () => {
    expect(isOpenAISpeechProvider(Provider.OPENAI)).toBe(true);
    expect(isOpenAISpeechProvider(Provider.OPENAI_TRANSLATE)).toBe(true);
    expect(isOpenAISpeechProvider(Provider.OPENAI_COMPATIBLE)).toBe(true);
    expect(isOpenAISpeechProvider(Provider.LOCAL_NATIVE)).toBe(false);
  });
});

describe('createOpenAISpeech', () => {
  it('posts wav speech to the OpenAI audio endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    });
    vi.stubGlobal('fetch', fetchMock);

    const audio = await createOpenAISpeech({
      apiKey: 'sk-test',
      text: 'Hello',
      voice: 'marin',
      speed: 1.1,
    });

    expect(audio.byteLength).toBe(8);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      input: 'Hello',
      response_format: 'wav',
    });
    expect(body.instructions).toBeUndefined();
  });

  it('forwards vibe instructions when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    });
    vi.stubGlobal('fetch', fetchMock);
    await createOpenAISpeech({
      apiKey: 'sk-test', text: 'Hi', voice: 'alloy', instructions: 'Speak sincerely.',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.instructions).toBe('Speak sincerely.');
  });

  it('surfaces the API error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Rate limit' } }),
    }));
    await expect(createOpenAISpeech({
      apiKey: 'sk-test', text: 'Hi', voice: 'alloy',
    })).rejects.toThrow('Rate limit');
  });
});

describe('translateWithOpenAI', () => {
  it('returns the completion text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '  你好  ' } }] }),
    }));
    const result = await translateWithOpenAI({
      apiKey: 'sk-test',
      text: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
    });
    expect(result.translatedText).toBe('你好');
    expect(result.inferenceTimeMs).toBeGreaterThanOrEqual(0);
  });
});
