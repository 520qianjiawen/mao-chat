export class AppleSystemTranslatorClient {
  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<{ translatedText: string; inferenceTimeMs: number }> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { translatedText: '', inferenceTimeMs: 0 };
    }

    if (typeof window === 'undefined' || !(window as any).electron?.invoke) {
      throw new Error('系统翻译仅在 macOS 桌面端中可用');
    }

    const start = performance.now();
    const res = await (window as any).electron.invoke('quick-translate:apple-translate', {
      text: trimmed,
      sourceLang,
      targetLang,
    });

    const inferenceTimeMs = Math.round(performance.now() - start);

    if (!res?.ok) {
      if (res?.error === 'shortcut_not_installed') {
        const err = new Error(res.message || '未检测到系统翻译快捷指令');
        (err as any).code = 'SHORTCUT_NOT_INSTALLED';
        throw err;
      }
      throw new Error(res?.message || '系统翻译调用失败');
    }

    return {
      translatedText: res.text || '',
      inferenceTimeMs,
    };
  }

  async installShortcut(): Promise<void> {
    if (typeof window !== 'undefined' && (window as any).electron?.invoke) {
      await (window as any).electron.invoke('quick-translate:install-apple-shortcut');
    }
  }
}
