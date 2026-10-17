import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDegenerateTranslationOutput,
  LocalInferenceClient,
  shouldTranslatePartial,
  splitTranslationSource,
} from './LocalInferenceClient';

describe('LocalInferenceClient incremental translation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not translate pending ASR text before the sentence buffer commits', () => {
    expect(shouldTranslatePartial('breaking news from')).toBe(false);
    expect(shouldTranslatePartial('breaking news from idaho')).toBe(false);
    expect(shouldTranslatePartial('今天天气非常好')).toBe(false);
    expect(shouldTranslatePartial('short sentence.')).toBe(false);
    expect(shouldTranslatePartial('現在政府は', 'ja')).toBe(false);
    expect(shouldTranslatePartial('現在政府は新しい政策を発表しました', 'ja')).toBe(false);
    expect(shouldTranslatePartial('这个句子已经说完了', 'zh')).toBe(false);
  });

  it('splits long unpunctuated ASR text into bounded translation requests', () => {
    const source = Array.from({ length: 80 }, (_, index) => `word${index + 1}`).join(' ');
    const chunks = splitTranslationSource(source);
    expect(chunks).toHaveLength(3);
    expect(chunks.every(chunk => chunk.split(/\s+/).length <= 36)).toBe(true);
    expect(chunks.join(' ')).toBe(source);
  });

  it('detects repetitive model degeneration without rejecting normal Chinese', () => {
    expect(isDegenerateTranslationOutput(`警方正在调查${'去'.repeat(40)}`)).toBe(true);
    expect(isDegenerateTranslationOutput('警方正在调查这起事件，现场情况仍然十分复杂。')).toBe(false);
  });

  it('reuses stable translation chunks as the live transcript grows', async () => {
    const client = new LocalInferenceClient();
    const translate = vi.fn(async (sourceText: string) => ({
      sourceText,
      translatedText: `译文${translate.mock.calls.length}`,
      inferenceTimeMs: 10,
    }));
    const internals = client as any;
    internals.translationEngine = { translate };
    internals.config = { targetLanguage: 'zh' };

    const first = Array.from({ length: 74 }, (_, index) => `word${index + 1}`).join(' ');
    await internals.translateTextSafely(first, '', false);
    expect(translate).toHaveBeenCalledTimes(3);

    const grown = Array.from({ length: 80 }, (_, index) => `word${index + 1}`).join(' ');
    await internals.translateTextSafely(grown, '', false);
    // The two completed 36-word chunks are cached; only the changed tail runs.
    expect(translate).toHaveBeenCalledTimes(4);
  });

  it('buffers short streaming finals until the sentence segmenter commits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const client = new LocalInferenceClient();
    const translate = vi.fn(async (sourceText: string) => ({
      sourceText,
      translatedText: `译:${sourceText}`,
      inferenceTimeMs: 5,
    }));
    const internals = client as any;
    internals.translationEngine = { translate };
    internals.config = {
      translationModelId: 'google-translator',
      instructions: '',
      wrapTranscript: false,
      targetLanguage: 'zh',
      segmentationMode: 'meeting',
    };
    const updated: string[] = [];
    internals.handlers = {
      onConversationUpdated: ({ item }: { item: { role: string; formatted?: { transcript?: string } } }) => {
        if (item.role === 'user') updated.push(item.formatted?.transcript || '');
      },
    };

    internals.ingestAsrFinal('however now in twenty twenty six');
    internals.ingestAsrFinal("we're in a very different place");
    // Still within the idle window — no final MT commit yet.
    expect(translate).not.toHaveBeenCalled();
    expect(updated.at(-1)).toContain('twenty twenty six');
    expect(updated.at(-1)).toContain('different place');

    await vi.advanceTimersByTimeAsync(700);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][0]).toContain('however now in twenty twenty six');
    expect(translate.mock.calls[0][0]).toContain("we're in a very different place");
  });

  it('does not translate a 3-word ASR final immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const client = new LocalInferenceClient();
    const translate = vi.fn(async (sourceText: string) => ({
      sourceText,
      translatedText: `译:${sourceText}`,
      inferenceTimeMs: 5,
    }));
    const internals = client as any;
    internals.translationEngine = { translate };
    internals.config = {
      translationModelId: 'google-translator',
      instructions: '',
      wrapTranscript: false,
      targetLanguage: 'zh',
      segmentationMode: 'meeting',
    };
    internals.handlers = { onConversationUpdated: () => {} };

    internals.ingestAsrFinal('there is something');
    expect(translate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(translate).not.toHaveBeenCalled();
  });

  it('translates only after a committed ASR utterance, not on the live partial', async () => {
    vi.useFakeTimers();
    const client = new LocalInferenceClient();
    const translate = vi.fn()
      .mockResolvedValueOnce({
        sourceText: 'breaking news from idaho where police are responding',
        translatedText: '爱达荷州突发新闻，警方正在响应。',
        inferenceTimeMs: 25,
      });

    const internals = client as any;
    internals.translationEngine = { translate };
    internals.config = {
      translationModelId: 'test-translation',
      instructions: '',
      wrapTranscript: false,
      targetLanguage: 'zh',
    };

    internals.handlePartialAsrResult('breaking news from idaho');
    await vi.runAllTimersAsync();
    expect(translate).not.toHaveBeenCalled();

    vi.useRealTimers();
    internals.handleAsrResult('breaking news from idaho where police are responding');
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      const finalAssistant = client.getConversationItems().filter(item => item.role === 'assistant');
      expect(finalAssistant).toHaveLength(1);
      expect(finalAssistant[0]).toMatchObject({
        status: 'completed',
        formatted: { transcript: '爱达荷州突发新闻，警方正在响应。' },
      });
    });
  });

  it('translates the committed source once when no live partial ran', async () => {
    vi.useFakeTimers();
    const client = new LocalInferenceClient();
    const translate = vi.fn().mockResolvedValue({
      sourceText: 'breaking news from idaho',
      translatedText: '爱达荷州的突发新闻',
      inferenceTimeMs: 20,
    });

    const internals = client as any;
    internals.translationEngine = { translate };
    internals.config = {
      translationModelId: 'test-translation',
      instructions: '',
      wrapTranscript: false,
      targetLanguage: 'zh',
    };

    internals.handlePartialAsrResult('breaking news from idaho');
    await vi.runAllTimersAsync();
    expect(translate).not.toHaveBeenCalled();

    vi.useRealTimers();
    internals.handleAsrResult('breaking news from idaho');
    await vi.waitFor(() => {
      const finalAssistant = client.getConversationItems().filter(item => item.role === 'assistant');
      expect(finalAssistant).toHaveLength(1);
      expect(finalAssistant[0]).toMatchObject({
        status: 'completed',
        formatted: { transcript: '爱达荷州的突发新闻' },
      });
    });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('clears a mismatched longer partial when smart-split finalizes a shorter head', async () => {
    vi.useFakeTimers();
    const client = new LocalInferenceClient();
    const translate = vi.fn()
      .mockResolvedValue({
        sourceText: 'one two three four five',
        translatedText: '一二三四五',
        inferenceTimeMs: 12,
      });

    const internals = client as any;
    internals.translationEngine = { translate };
    internals.config = {
      translationModelId: 'test-translation',
      instructions: '',
      wrapTranscript: false,
      targetLanguage: 'zh',
    };

    internals.handlePartialAsrResult('one two three four five six seven eight');
    await vi.runAllTimersAsync();
    expect(translate).not.toHaveBeenCalled();

    vi.useRealTimers();
    internals.handleAsrResult('one two three four five');
    // Immediately after finalize, the reused row should be blanked (or already
    // replaced by the shorter translation if the mock resolved synchronously).
    await vi.waitFor(() => {
      const assistant = client.getConversationItems().find(i => i.role === 'assistant');
      expect(assistant?.formatted?.transcript).not.toBe('一二三四五六七八');
    });
    await vi.waitFor(() => {
      const assistant = client.getConversationItems().find(i => i.role === 'assistant');
      expect(assistant).toMatchObject({
        status: 'completed',
        formatted: { transcript: '一二三四五' },
      });
    });
    expect(translate).toHaveBeenCalledTimes(1);
  });
});
