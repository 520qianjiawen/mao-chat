import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiliconFlowTranslatorClient } from './SiliconFlowTranslatorClient';

describe('SiliconFlowTranslatorClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).electron = undefined;
  });

  it('throws NO_API_KEY error when apiKey is empty', async () => {
    const client = new SiliconFlowTranslatorClient({ apiKey: '' });
    await expect(client.translate('hello', 'en', 'zh')).rejects.toThrow('未配置硅基流动 API Key');
  });

  it('returns empty translation immediately when text is empty', async () => {
    const client = new SiliconFlowTranslatorClient({ apiKey: 'mock-key' });
    const res = await client.translate('', 'en', 'zh');
    expect(res.translatedText).toBe('');
    expect(res.inferenceTimeMs).toBe(0);
  });

  it('calls fetch when electron is not present', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: '硅基流动翻译结果' },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new SiliconFlowTranslatorClient({ apiKey: 'sf-key' });
    const res = await client.translate('Silicon flow test', 'en', 'zh');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.siliconflow.cn/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sf-key',
        }),
      }),
    );
    expect(res.translatedText).toBe('硅基流动翻译结果');
  });

  it('calls electron quick-translate:cloud-fetch when electron is present', async () => {
    (window as any).electron = {
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        body: JSON.stringify({
          choices: [{ message: { content: '代理硅基流动翻译' } }],
        }),
      }),
    };

    const client = new SiliconFlowTranslatorClient({ apiKey: 'sf-key-2' });
    const res = await client.translate('Proxy test', 'en', 'zh');

    expect((window as any).electron.invoke).toHaveBeenCalledWith(
      'quick-translate:cloud-fetch',
      expect.objectContaining({
        url: 'https://api.siliconflow.cn/v1/chat/completions',
      }),
    );
    expect(res.translatedText).toBe('代理硅基流动翻译');
  });
});
