import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZhipuTranslatorClient } from './ZhipuTranslatorClient';

describe('ZhipuTranslatorClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).electron = undefined;
  });

  it('throws NO_API_KEY error when apiKey is empty', async () => {
    const client = new ZhipuTranslatorClient({ apiKey: '' });
    await expect(client.translate('hello', 'en', 'zh')).rejects.toThrow('未配置智谱 API Key');
  });

  it('returns empty translation immediately when text is empty', async () => {
    const client = new ZhipuTranslatorClient({ apiKey: 'mock-key' });
    const res = await client.translate('   ', 'en', 'zh');
    expect(res.translatedText).toBe('');
    expect(res.inferenceTimeMs).toBe(0);
  });

  it('calls fetch when electron is not present', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: '你好世界' },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new ZhipuTranslatorClient({ apiKey: 'test-key' });
    const res = await client.translate('Hello world', 'en', 'zh');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
    expect(res.translatedText).toBe('你好世界');
    expect(res.inferenceTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('calls electron quick-translate:cloud-fetch when electron is present', async () => {
    (window as any).electron = {
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        body: JSON.stringify({
          choices: [{ message: { content: '这是通过 Electron 代理的翻译' } }],
        }),
      }),
    };

    const client = new ZhipuTranslatorClient({ apiKey: 'test-key-2' });
    const res = await client.translate('Test electron invoke', 'en', 'zh');

    expect((window as any).electron.invoke).toHaveBeenCalledWith(
      'quick-translate:cloud-fetch',
      expect.objectContaining({
        url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      }),
    );
    expect(res.translatedText).toBe('这是通过 Electron 代理的翻译');
  });
});
