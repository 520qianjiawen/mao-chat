import { LANGUAGE_OPTIONS } from '../../utils/languages';

export interface SiliconFlowTranslateOptions {
  apiKey: string;
  model?: string;
  fetchFn?: typeof fetch;
}

export class SiliconFlowTranslatorClient {
  private apiKey: string;
  private model: string;

  constructor(options: SiliconFlowTranslateOptions) {
    this.apiKey = options.apiKey?.trim() || '';
    this.model = options.model || 'Qwen/Qwen2.5-7B-Instruct';
  }

  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<{ translatedText: string; inferenceTimeMs: number }> {
    if (!this.apiKey) {
      const err = new Error('未配置硅基流动 API Key');
      (err as any).code = 'NO_API_KEY';
      throw err;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return { translatedText: '', inferenceTimeMs: 0 };
    }

    const srcDisplay =
      sourceLang === 'auto'
        ? 'the source language'
        : (LANGUAGE_OPTIONS[sourceLang]?.englishName || sourceLang);
    const tgtDisplay = LANGUAGE_OPTIONS[targetLang]?.englishName || targetLang;

    const systemPrompt = `You are a professional translator. Translate the text from ${srcDisplay} to ${tgtDisplay} accurately and fluently.
Rules:
- Preserve original layout, line breaks, indentation, and punctuation.
- Output ONLY the translated text without explanations, markdown backticks wrapper, or commentary.`;

    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.2,
    });

    const start = performance.now();
    let resData: any;

    if (typeof window !== 'undefined' && (window as any).electron?.invoke) {
      const res = await (window as any).electron.invoke('quick-translate:cloud-fetch', {
        url: 'https://api.siliconflow.cn/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body,
      });
      if (!res.ok) {
        throw new Error(res.error || `硅基流动请求失败 (HTTP ${res.status})`);
      }
      resData = JSON.parse(res.body);
    } else {
      const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`硅基流动请求失败 (${res.status}): ${errText}`);
      }
      resData = await res.json();
    }

    const output = (resData?.choices?.[0]?.message?.content || '').trim();
    const inferenceTimeMs = Math.round(performance.now() - start);
    return { translatedText: output, inferenceTimeMs };
  }
}
