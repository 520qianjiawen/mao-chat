// src/lib/gemini/geminiSpeech.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGeminiSpeech,
  translateWithGemini,
  formatGeminiAudioToWav,
  GEMINI_SPEECH_VOICES,
  GEMINI_SPEECH_EMOTIONS,
  GEMINI_TTS_DEFAULT_MODEL,
} from './geminiSpeech';

describe('geminiSpeech', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exports default model, voices, and emotions', () => {
    expect(GEMINI_TTS_DEFAULT_MODEL).toBe('gemini-3.8-flash-tts');
    expect(GEMINI_SPEECH_VOICES.length).toBeGreaterThan(5);
    expect(GEMINI_SPEECH_EMOTIONS.some((e) => e.id === 'cheerful')).toBe(true);
    expect(GEMINI_SPEECH_EMOTIONS.some((e) => e.id === 'natural')).toBe(true);
  });

  it('formats raw PCM16 to WAV with valid 44-byte header', () => {
    // 240 samples of silence = 480 bytes
    const pcmBytes = new Uint8Array(480);
    const wavBuffer = formatGeminiAudioToWav(pcmBytes, 'audio/pcm', 24000);
    const wavBytes = new Uint8Array(wavBuffer);

    expect(wavBuffer.byteLength).toBe(44 + 480);
    expect(String.fromCharCode(...wavBytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wavBytes.slice(8, 12))).toBe('WAVE');
  });

  it('preserves existing RIFF WAV data without re-encoding', () => {
    const rawRiff = new Uint8Array(48);
    rawRiff.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const wavBuffer = formatGeminiAudioToWav(rawRiff, 'audio/wav');
    expect(wavBuffer.byteLength).toBe(48);
  });

  it('calls Gemini generateContent API with speechConfig and emotion systemInstruction', async () => {
    const fakePcm = new Uint8Array(240);
    const base64 = btoa(String.fromCharCode(...fakePcm));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/pcm',
                    data: base64,
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createGeminiSpeech({
      apiKey: 'test-api-key',
      text: '你好，欢迎使用 MAO Chat！',
      voice: 'Puck',
      emotionPrompt: 'Voice affect: Cheerful and lively.',
    });

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toContain('gemini-3.8-flash-tts:generateContent');
    expect(url).toContain('key=test-api-key');

    const body = JSON.parse(request.body);
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck');
    expect(body.contents[0].parts[0].speech_metadata.style).toContain('Cheerful and lively');
  });

  it('throws an error if apiKey is missing', async () => {
    await expect(
      createGeminiSpeech({
        apiKey: '',
        text: 'hello',
        voice: 'Puck',
      }),
    ).rejects.toThrow('Missing Gemini API Key');
  });

  it('handles API errors gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { message: 'API key not valid. Please pass a valid API key.' },
        }),
      }),
    );

    await expect(
      createGeminiSpeech({
        apiKey: 'invalid-key',
        text: 'hello',
        voice: 'Puck',
      }),
    ).rejects.toThrow('API key not valid');
  });

  it('translates text using translateWithGemini', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'Hello, welcome to MAO Chat!' }],
              },
            },
          ],
        }),
      }),
    );

    const res = await translateWithGemini({
      apiKey: 'test-key',
      text: '你好，欢迎使用 MAO Chat！',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
    });

    expect(res.translatedText).toBe('Hello, welcome to MAO Chat!');
    expect(res.inferenceTimeMs).toBeGreaterThanOrEqual(0);
  });
});
