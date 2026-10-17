// src/lib/ollama-translator/OllamaTranslatorClient.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OllamaTranslatorClient,
  fetchOllamaModels,
  checkOllamaHealthy,
  DEFAULT_OLLAMA_ENDPOINT,
} from './OllamaTranslatorClient';

describe('OllamaTranslatorClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('checkOllamaHealthy returns true when Ollama answers 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const isHealthy = await checkOllamaHealthy(DEFAULT_OLLAMA_ENDPOINT, mockFetch as unknown as typeof fetch);
    expect(isHealthy).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('checkOllamaHealthy returns false when fetch throws or returns 500', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const isHealthy = await checkOllamaHealthy(DEFAULT_OLLAMA_ENDPOINT, mockFetch as unknown as typeof fetch);
    expect(isHealthy).toBe(false);
  });

  it('fetchOllamaModels parses tags and filters out embedding models', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: 'translategemma:12b',
            model: 'translategemma:12b',
            size: 8109827612,
            details: {
              family: 'gemma3',
              parameter_size: '12.2B',
              quantization_level: 'Q4_K_M',
            },
          },
          {
            name: 'qwen3-embedding:8b',
            model: 'qwen3-embedding:8b',
            size: 4676805193,
            details: {
              family: 'qwen3',
              parameter_size: '7.6B',
            },
          },
          {
            name: 'bge-m3:latest',
            model: 'bge-m3:latest',
            size: 1200000000,
          },
          {
            name: 'qwen2.5:7b',
            model: 'qwen2.5:7b',
            size: 4500000000,
            details: {
              family: 'qwen2.5',
              parameter_size: '7B',
              quantization_level: 'Q4_0',
            },
          },
        ],
      }),
    });

    const models = await fetchOllamaModels(DEFAULT_OLLAMA_ENDPOINT, mockFetch as unknown as typeof fetch);
    expect(models).toHaveLength(2);
    expect(models[0].name).toBe('translategemma:12b');
    expect(models[0].parameterSize).toBe('12.2B');
    expect(models[1].name).toBe('qwen2.5:7b');
  });

  it('translates text using Ollama /api/chat endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'translategemma:12b',
        message: {
          role: 'assistant',
          content: '太棒了！',
        },
      }),
    });

    const client = new OllamaTranslatorClient({ fetchFn: mockFetch as unknown as typeof fetch });
    await client.init('en', 'zh', 'ollama:translategemma:12b');

    const result = await client.translate('This is awesome!');

    expect(result.sourceText).toBe('This is awesome!');
    expect(result.translatedText).toBe('太棒了！');
    expect(result.inferenceTimeMs).toBeGreaterThanOrEqual(0);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"model":"translategemma:12b"'),
      }),
    );
  });

  it('unwraps JSON output or strips quotes if returned by model', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'translategemma:12b',
        message: {
          role: 'assistant',
          content: '{"translation": "你好世界"}',
        },
      }),
    });

    const client = new OllamaTranslatorClient({ fetchFn: mockFetch as unknown as typeof fetch });
    await client.init('en', 'zh', 'translategemma:12b');

    const result = await client.translate('Hello world');
    expect(result.translatedText).toBe('你好世界');
  });

  it('throws error when Ollama returns HTTP 500 error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'model not found',
    });

    const client = new OllamaTranslatorClient({ fetchFn: mockFetch as unknown as typeof fetch });
    await client.init('en', 'zh', 'translategemma:12b');

    await expect(client.translate('Hello')).rejects.toThrow('Ollama translation failed (500): model not found');
  });
});
