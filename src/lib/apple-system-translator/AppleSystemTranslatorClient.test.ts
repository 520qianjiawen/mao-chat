import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppleSystemTranslatorClient } from './AppleSystemTranslatorClient';

describe('AppleSystemTranslatorClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).electron = undefined;
  });

  it('throws error when window.electron is not available', async () => {
    const client = new AppleSystemTranslatorClient();
    await expect(client.translate('hello', 'en', 'zh')).rejects.toThrow('仅在 macOS 桌面端中可用');
  });

  it('returns empty text immediately when text is empty', async () => {
    (window as any).electron = { invoke: vi.fn() };
    const client = new AppleSystemTranslatorClient();
    const res = await client.translate('   ', 'en', 'zh');
    expect(res.translatedText).toBe('');
    expect((window as any).electron.invoke).not.toHaveBeenCalled();
  });

  it('calls quick-translate:apple-translate when electron is available', async () => {
    (window as any).electron = {
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        text: '苹果系统翻译结果',
      }),
    };

    const client = new AppleSystemTranslatorClient();
    const res = await client.translate('Hello Apple', 'en', 'zh');

    expect((window as any).electron.invoke).toHaveBeenCalledWith('quick-translate:apple-translate', {
      text: 'Hello Apple',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    expect(res.translatedText).toBe('苹果系统翻译结果');
  });

  it('handles SHORTCUT_NOT_INSTALLED error code when shortcut is missing', async () => {
    (window as any).electron = {
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: 'shortcut_not_installed',
        message: '未检测到快捷指令',
      }),
    };

    const client = new AppleSystemTranslatorClient();
    await expect(client.translate('Hello', 'en', 'zh')).rejects.toMatchObject({
      code: 'SHORTCUT_NOT_INSTALLED',
      message: '未检测到快捷指令',
    });
  });

  it('triggers install shortcut via electron', async () => {
    (window as any).electron = {
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const client = new AppleSystemTranslatorClient();
    await client.installShortcut();
    expect((window as any).electron.invoke).toHaveBeenCalledWith('quick-translate:install-apple-shortcut');
  });
});
