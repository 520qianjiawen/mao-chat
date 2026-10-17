import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalNativeClient, shouldTranslateNativePartial } from './LocalNativeClient';
import { useNativeModelStore } from '../../stores/nativeModelStore';

const LOCAL_NATIVE_CONFIG: any = {
  provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en',
  asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b',
};

async function finalizeAsr(client: LocalNativeClient, asr: { onResult: ((r: any) => void) | null }, result: any) {
  await asr.onResult?.(result);
  client.createResponse();
  await Promise.resolve();
  await Promise.resolve();
}

function mocks() {
  const asr: any = {
    onResult: null, onSpeechStart: null, onStatus: null, onError: null, onPartialResult: null,
    init: vi.fn().mockResolvedValue({ loadTimeMs: 1 }), feedAudio: vi.fn(), flush: vi.fn(),
    setRefinementEnabled: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(),
  };
  const translate: any = {
    onError: null, init: vi.fn().mockResolvedValue({ loadTimeMs: 1 }),
    translate: vi.fn().mockResolvedValue({ sourceText: 'hola', translatedText: 'hello', inferenceTimeMs: 2 }),
    dispose: vi.fn(),
  };
  const onlineTranslate: any = {
    onError: null, init: vi.fn().mockResolvedValue({ loadTimeMs: 1, device: 'cloud' }),
    translate: vi.fn().mockResolvedValue({ sourceText: 'こんにちは', translatedText: '你好', inferenceTimeMs: 3 }),
    dispose: vi.fn(),
  };
  const ollamaTranslate: any = {
    onError: null, init: vi.fn().mockResolvedValue({ loadTimeMs: 1 }),
    translate: vi.fn().mockResolvedValue({ sourceText: 'hello', translatedText: '你好', inferenceTimeMs: 2 }),
    dispose: vi.fn(),
  };
  const tts: any = { onError: null, init: vi.fn(), generate: vi.fn(), dispose: vi.fn(), setVoice: vi.fn(), setSpeaker: vi.fn() };
  return { asr, translate, onlineTranslate, ollamaTranslate, tts };
}

describe('LocalNativeClient', () => {
  it('starts live online translation only after a useful partial phrase', () => {
    expect(shouldTranslateNativePartial('one two three')).toBe(false);
    expect(shouldTranslateNativePartial('one two three four')).toBe(false);
    expect(shouldTranslateNativePartial('こんにちは')).toBe(false);
    expect(shouldTranslateNativePartial('这个句子已经说完了', 'zh')).toBe(false);
    expect(shouldTranslateNativePartial('この問題について説明します', 'ja')).toBe(false);
  });

  it('wires tts.onError to the session error handler', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    const errors: string[] = [];
    c.setEventHandlers({ onError: (e: any) => errors.push(String(e)) });
    await c.connect({ ...LOCAL_NATIVE_CONFIG } as any);
    expect(typeof m.tts.onError).toBe('function');
    m.tts.onError('tts exploded');
    expect(errors).toContain('tts exploded');
  });

  it('skips the translation stage entirely when no translation model is selected', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    const roles: string[] = [];
    c.setEventHandlers({ onConversationUpdated: ({ item }: any) => roles.push(item.role) });
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en',
      asrModelId: 'sense-voice',
    } as any);
    // No model: init must not run (the sidecar would substitute its default
    // model, silently translating in a session the UI declared
    // transcription-only), and per-utterance jobs must not translate.
    expect(m.translate.init).not.toHaveBeenCalled();
    await finalizeAsr(c, m.asr, { text: 'hola', durationMs: 100, recognitionTimeMs: 5 });
    expect(m.translate.translate).not.toHaveBeenCalled();
    expect(roles).toContain('user');
    expect(roles).not.toContain('assistant');
  });

  it('connects and runs ASR→translation, emitting user + assistant items', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    const items: any[] = [];
    c.setEventHandlers({ onConversationUpdated: ({ item }) => items.push({ role: item.role, status: item.status, text: item.formatted?.transcript }) });
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b',
    } as any);
    expect(m.asr.init).toHaveBeenCalled();
    // init signature: (src, tgt, translationModelId, translationDevice, asrModelId, ttsModelId, translationVariant)
    expect(m.translate.init).toHaveBeenCalledWith('es', 'en', 'qwen2.5-0.5b', undefined, 'sense-voice', undefined, undefined);

    await finalizeAsr(c, m.asr, { text: 'hola', durationMs: 100, recognitionTimeMs: 5 });

    const roles = items.map((i) => i.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    const assistant = [...items].reverse().find((i) => i.role === 'assistant');
    expect(assistant.text).toBe('hello');
    expect(assistant.status).toBe('completed');
  });

  it('uses Hayamimi auto LID, upstream VAD timings, and detected-language events', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    const events: any[] = [];
    c.setEventHandlers({ onRealtimeEvent: (event: any) => events.push(event) });
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'auto', targetLanguage: 'en',
      asrModelId: 'hayamimi-asr', translationModelId: 'qwen2.5-0.5b',
    } as any);

    expect(m.translate.init).toHaveBeenCalledWith(
      '', 'en', 'qwen2.5-0.5b', undefined, 'hayamimi-asr', undefined, undefined,
    );
    expect(m.asr.init).toHaveBeenCalledWith(
      'auto', 'hayamimi-asr', 24000,
      expect.objectContaining({
        threshold: 0.5, minSilence: 0.35, minSpeech: 0.25, maxSpeech: 12,
      }),
      undefined, undefined, true,
    );
    m.asr.onPartialResult('hola mundo', 'es');
    await finalizeAsr(c, m.asr, {
      text: 'hola mundo', language: 'es', durationMs: 1000, recognitionTimeMs: 20,
    });
    expect(events.some((entry) =>
      entry.event?.type === 'local.native.asr.end'
      && entry.event?.data?.language === 'es',
    )).toBe(true);
  });

  it('lets Hayamimi finals bypass semantic re-segmentation', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'auto', targetLanguage: 'zh',
      asrModelId: 'hayamimi-asr', translationModelId: 'qwen2.5-0.5b',
    } as any);

    m.asr.onPartialResult('Today weather', 'en');
    m.asr.onResult({
      text: "Today's weather.", language: 'en', segmentId: 41,
      startSample: 0, durationMs: 900, recognitionTimeMs: 15,
    });

    const source = c.getConversationItems().find((item) => item.role === 'user');
    expect(source).toMatchObject({
      status: 'completed', segmentId: 41, detectedLanguage: 'en',
    });
    expect(source?.formatted?.transcript).toBe("Today's weather.");
  });

  it('keeps the raw pair beside the refined pair (split conversation view)', async () => {
    const m = mocks();
    m.translate.translate.mockImplementation(async (text: string) => ({
      sourceText: text,
      translatedText: text === 'This is one complete sentence.' ? '这是一句完整的话。' : `draft:${text}`,
      inferenceTimeMs: 2,
    }));
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'zh',
      asrModelId: 'hayamimi-asr', translationModelId: 'qwen2.5-0.5b',
    } as any);

    m.asr.onResult({ text: 'This is one', language: 'en', segmentId: 1, durationMs: 800, recognitionTimeMs: 10 });
    m.asr.onResult({ text: 'complete sentence.', language: 'en', segmentId: 2, durationMs: 900, recognitionTimeMs: 11 });
    m.asr.onRefine({
      text: 'This is one complete sentence.', language: 'en', segmentIds: [1, 2],
      startSample: 0, durationMs: 2200, recognitionTimeMs: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const items = c.getConversationItems();
    // Raw first-pass group survives beside the polished rewrite.
    const rawSources = items.filter((item) => item.role === 'user' && !item.refined);
    const rawTranslations = items.filter((item) => item.role === 'assistant' && !item.refined);
    expect(rawSources.map((s) => s.formatted?.transcript)).toEqual(['This is one', 'complete sentence.']);
    expect(rawTranslations.map((t) => t.formatted?.transcript)).toEqual(['draft:This is one', 'draft:complete sentence.']);

    const refinedSources = items.filter((item) => item.role === 'user' && item.refined);
    const refinedTranslations = items.filter((item) => item.role === 'assistant' && item.refined);
    expect(refinedSources).toHaveLength(1);
    expect(refinedSources[0]).toMatchObject({
      segmentId: 100001, detectedLanguage: 'en', refinedFor: [1, 2],
    });
    expect(refinedSources[0].formatted?.transcript).toBe('This is one complete sentence.');
    expect(refinedTranslations).toHaveLength(1);
    expect(refinedTranslations[0]).toMatchObject({ segmentId: 100001, status: 'completed', refined: true });
    expect(refinedTranslations[0].formatted?.transcript).toBe('这是一句完整的话。');
    expect(m.translate.translate).toHaveBeenCalledTimes(3);
  });

  it('keeps subtitle mode on the fast pass and restores refinement in conversation mode', async () => {
    const m = mocks();
    m.translate.translate.mockImplementation(async (text: string) => ({
      sourceText: text, translatedText: `translated:${text}`, inferenceTimeMs: 2,
    }));
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'zh',
      asrModelId: 'hayamimi-asr', translationModelId: 'qwen2.5-0.5b',
      enableAsrRefinement: false,
    } as any);

    expect(m.asr.init).toHaveBeenLastCalledWith(
      'en', 'hayamimi-asr', 24000, expect.any(Object), undefined, undefined, false,
    );
    m.asr.onResult({ text: 'fast caption', language: 'en', segmentId: 1, durationMs: 700, recognitionTimeMs: 10 });
    m.asr.onRefine({
      text: 'polished caption.', language: 'en', segmentIds: [1],
      startSample: 0, durationMs: 1000, recognitionTimeMs: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(c.getConversationItems().some((item) => item.refined)).toBe(false);

    c.updateSession({ enableAsrRefinement: true } as any);
    expect(m.asr.setRefinementEnabled).toHaveBeenCalledWith(true);
    m.asr.onRefine({
      text: 'polished caption.', language: 'en', segmentIds: [1],
      startSample: 0, durationMs: 1000, recognitionTimeMs: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(c.getConversationItems().filter((item) => item.refined && item.role === 'user'))
      .toHaveLength(1);

    c.updateSession({ enableAsrRefinement: false } as any);
    expect(m.asr.setRefinementEnabled).toHaveBeenLastCalledWith(false);
  });

  it('replaces only the previous refined rendering on a second refine pass', async () => {
    const m = mocks();
    let refinedText = 'This is one complete sentence.';
    m.translate.translate.mockImplementation(async (text: string) => ({
      sourceText: text,
      translatedText: text === refinedText ? '终稿。' : `draft:${text}`,
      inferenceTimeMs: 2,
    }));
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'zh',
      asrModelId: 'hayamimi-asr', translationModelId: 'qwen2.5-0.5b',
    } as any);

    m.asr.onResult({ text: 'This is one', language: 'en', segmentId: 1, durationMs: 800, recognitionTimeMs: 10 });
    m.asr.onResult({ text: 'complete sentence.', language: 'en', segmentId: 2, durationMs: 900, recognitionTimeMs: 11 });
    m.asr.onRefine({
      text: refinedText, language: 'en', segmentIds: [1, 2],
      startSample: 0, durationMs: 2200, recognitionTimeMs: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    refinedText = 'This is one complete, polished sentence.';
    m.asr.onRefine({
      text: refinedText, language: 'en', segmentIds: [1, 2],
      startSample: 0, durationMs: 2400, recognitionTimeMs: 42,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const refinedSources = c.getConversationItems().filter((item) => item.role === 'user' && item.refined);
    expect(refinedSources).toHaveLength(1);
    expect(refinedSources[0].formatted?.transcript).toBe('This is one complete, polished sentence.');
    // Raw group untouched by both passes.
    expect(c.getConversationItems().filter((item) => item.role === 'user' && !item.refined))
      .toHaveLength(2);
  });

  it('uses Bing/Google online translation without initializing a native translation model', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    const items: any[] = [];
    c.setEventHandlers({ onConversationUpdated: ({ item }) => items.push(item) });
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'ja', targetLanguage: 'zh',
      asrModelId: 'sherpa-zipformer-multi-8lang', translationModelId: 'bing-translator',
    } as any);

    expect(m.translate.init).not.toHaveBeenCalled();
    expect(m.onlineTranslate.init).toHaveBeenCalledWith('ja', 'zh', 'bing-translator', { apiKey: undefined });
    await finalizeAsr(c, m.asr, { text: 'こんにちは', durationMs: 100, recognitionTimeMs: 5 });
    expect(m.onlineTranslate.translate).toHaveBeenCalledWith('こんにちは', '', false);
    expect(items.some((item) => item.role === 'assistant' && item.formatted?.transcript === '你好')).toBe(true);
  });

  it('uses Ollama local model for translation when translationModelId starts with ollama:', async () => {
    const m = mocks();
    m.ollamaTranslate.translate.mockResolvedValue({
      sourceText: 'hello from test',
      translatedText: '测试你好',
      inferenceTimeMs: 5,
    });
    const c = new LocalNativeClient(m);
    const items: any[] = [];
    c.setEventHandlers({ onConversationUpdated: ({ item }) => items.push(item) });
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'zh',
      asrModelId: 'sherpa-zipformer-multi-8lang', translationModelId: 'ollama:translategemma:12b',
      textOnly: true,
    } as any);

    expect(m.translate.init).not.toHaveBeenCalled();
    expect(m.onlineTranslate.init).not.toHaveBeenCalled();
    expect(m.ollamaTranslate.init).toHaveBeenCalledWith('en', 'zh', 'ollama:translategemma:12b');
    await finalizeAsr(c, m.asr, { text: 'hello from test', durationMs: 100, recognitionTimeMs: 5 });
    expect(m.ollamaTranslate.translate).toHaveBeenCalledWith('hello from test', '', false);
    expect(items.some((item) => item.role === 'assistant' && item.formatted?.transcript === '测试你好')).toBe(true);
  });

  it('shows a debounced online translation while ASR is still in progress and reuses it on final', async () => {
    vi.useFakeTimers();
    try {
      const m = mocks();
      m.onlineTranslate.translate.mockResolvedValue({
        sourceText: 'この問題について説明します', translatedText: '我来说明这个问题', inferenceTimeMs: 3,
      });
      const c = new LocalNativeClient(m);
      const snapshots: any[] = [];
      c.setEventHandlers({
        onConversationUpdated: ({ item }) => snapshots.push({
          id: item.id, role: item.role, status: item.status,
          text: item.formatted?.transcript,
        }),
      });
      await c.connect({
        provider: 'local_native', model: 'native', sourceLanguage: 'ja', targetLanguage: 'zh',
        asrModelId: 'sherpa-zipformer-multi-8lang', translationModelId: 'google-translator',
      } as any);

      m.asr.onPartialResult('この問題について説明します');
      await vi.advanceTimersByTimeAsync(400);
      expect(m.onlineTranslate.translate).not.toHaveBeenCalled();
      expect(snapshots.some((item) =>
        item.role === 'user' && String(item.text).includes('説明します'),
      )).toBe(true);

      m.asr.onResult({ text: 'この問題について説明します' });
      await vi.advanceTimersByTimeAsync(800);
      await Promise.resolve();
      await Promise.resolve();
      expect(m.onlineTranslate.translate).toHaveBeenCalledTimes(1);
      expect(c.getConversationItems().filter((item) => item.role === 'assistant')).toHaveLength(1);
      expect(c.getConversationItems().find((item) => item.role === 'assistant')?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits an audio delta when a non-cloning TTS model is configured', async () => {
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 16000, loadTimeMs: 1 });
    m.tts.generate = vi.fn().mockResolvedValue({ samples: new Float32Array(16000), sampleRate: 16000, generationTimeMs: 9 });
    const c = new LocalNativeClient(m);
    const deltas: any[] = [];
    c.setEventHandlers({ onConversationUpdated: ({ item, delta }) => { if (delta?.audio) deltas.push({ role: item.role, len: delta.audio.length }); } });
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b', ttsModelId: 'piper-en-amy',
    } as any);
    expect(m.tts.init).toHaveBeenCalledWith('piper-en-amy', undefined, 'en', undefined);
    await finalizeAsr(c, m.asr, { text: 'hi', durationMs: 10, recognitionTimeMs: 1 });
    expect(deltas.length).toBe(1);
    expect(deltas[0].role).toBe('assistant');
    expect(deltas[0].len).toBe(24000); // 16k resampled to 24k
  });

  it('does not initialize TTS in video segmentation mode', async () => {
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 16000, loadTimeMs: 1 });
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'ja', targetLanguage: 'zh',
      asrModelId: 'sense-voice', translationModelId: 'google-translator',
      ttsModelId: 'piper-en-amy', segmentationMode: 'video',
    } as any);
    expect(m.tts.init).not.toHaveBeenCalled();
  });

  it('forwards the ttsDevice override to tts.init', async () => {
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 16000, loadTimeMs: 1 });
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', ttsModelId: 'moss-tts-nano', ttsDevice: 'cuda',
    } as any);
    expect(m.tts.init).toHaveBeenCalledWith('moss-tts-nano', 'cuda', 'en', undefined);
  });

  it('forwards the ttsVariant pin to tts.init', async () => {
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 16000, loadTimeMs: 1 });
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', ttsModelId: 'qwen3-tts-1.7b', ttsVariant: 'bf16',
    } as any);
    expect(m.tts.init).toHaveBeenCalledWith('qwen3-tts-1.7b', undefined, 'en', 'bf16');
  });

  it('returns a fresh array from getConversationItems (so setItems re-renders)', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en', asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b' } as any);
    await finalizeAsr(c, m.asr, { text: 'hola', durationMs: 1, recognitionTimeMs: 1 });
    expect(c.getConversationItems()).not.toBe(c.getConversationItems()); // different reference each call
  });

  it('emits local.native.* events to onRealtimeEvent (Logs panel)', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    const types: string[] = [];
    c.setEventHandlers({ onRealtimeEvent: (e: any) => types.push(e.event.type) });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en', asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b' } as any);
    await finalizeAsr(c, m.asr, { text: 'hola', durationMs: 1, recognitionTimeMs: 1 });
    expect(types).toContain('local.native.init.start');
    expect(types).toContain('local.native.init.ready');
    expect(types).toContain('local.native.asr.end');
    expect(types).toContain('local.native.translation.end');
  });

  it('feedAudio forwards to the ASR client', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en', asrModelId: 'sense-voice',
    } as any);
    const buf = new Int16Array(10);
    c.appendInputAudio(buf);
    expect(m.asr.feedAudio).toHaveBeenCalledWith(buf, 24000);
  });

  it('renders partials as one in-progress item and runs the job only on the final', async () => {
    const translate = { init: async () => ({ device: 'cpu' }), translate: vi.fn(async () => ({ translatedText: 'T', inferenceTimeMs: 1 })), onError: null, dispose() {} };
    const asr: any = { init: async () => ({ device: 'cuda' }), feedAudio() {}, flush() {}, dispose() {}, onResult: null, onPartialResult: null, onError: null };
    const client = new LocalNativeClient({ asr, translate });
    const items: any[] = [];
    client.setEventHandlers({ onConversationUpdated: ({ item }) => items.push({ id: item.id, status: item.status, text: item.formatted?.transcript }), onOpen() {}, onRealtimeEvent() {} } as any);
    await client.connect(LOCAL_NATIVE_CONFIG);
    asr.onPartialResult('he');            // partial 1
    asr.onPartialResult('hello');         // partial 2 (same item updates)
    expect(translate.translate).not.toHaveBeenCalled();
    asr.onResult({ text: 'hello world' }); // final
    client.createResponse();
    await new Promise((r) => setTimeout(r, 0));
    expect(translate.translate).toHaveBeenCalledTimes(1);
    const userItems = items.filter((i) => i.id.startsWith('user'));
    expect(new Set(userItems.map((i) => i.id)).size).toBe(1);  // one user item across partials+final
  });

  it('drops the stale partial after clearConversationItems so the next final still lands', async () => {
    const translate = { init: async () => ({ device: 'cpu' }), translate: vi.fn(async () => ({ translatedText: 'T', inferenceTimeMs: 1 })), onError: null, dispose() {} };
    const asr: any = { init: async () => ({ device: 'cuda' }), feedAudio() {}, flush() {}, dispose() {}, onResult: null, onPartialResult: null, onError: null };
    const client = new LocalNativeClient({ asr, translate });
    client.setEventHandlers({ onConversationUpdated() {}, onOpen() {}, onRealtimeEvent() {} } as any);
    await client.connect(LOCAL_NATIVE_CONFIG);
    asr.onPartialResult('hel');                 // a partial user item is in progress
    client.clearConversationItems();            // user clears the conversation mid-utterance
    asr.onResult({ text: 'hello' });            // the final then arrives
    await new Promise((r) => setTimeout(r, 0));
    const userItems = client.getConversationItems().filter((i: any) => i.id.startsWith('user'));
    expect(userItems.length).toBe(1);                                   // the final landed as a fresh item
    expect(userItems[0].formatted?.transcript).toBe('hello');           // not lost on the detached item
  });
});

// ── Task 3: loading flag + resolved plan ──────────────────────────────────────

const fakeAsr = () => ({
  onResult: null as any, onError: null as any,
  init: async () => ({ loadTimeMs: 5, device: 'cuda', rtf: 0.02 }),
  feedAudio() {}, flush: async () => {}, dispose() {},
});
const fakeTr = () => ({ onError: null as any, init: async () => ({ device: 'cpu' }), translate: async () => ({ translatedText: 'x', inferenceTimeMs: 1 }), dispose() {} });
const fakeTts = () => ({ init: async () => {}, generate: async () => ({ samples: new Float32Array(0), sampleRate: 24000, generationTimeMs: 1 }), dispose() {} });

const cfg: any = {
  provider: 'local_native', model: 'native-asr-translate', instructions: '',
  sourceLanguage: 'en', targetLanguage: 'ja', asrModelId: 'granite-speech-4.1-2b',
  translationModelId: 'qwen2.5-0.5b', asrDevice: 'cuda', textOnly: true,
};

describe('LocalNativeClient session channel', () => {
  beforeEach(() => { useNativeModelStore.setState({ asrLoading: false, asrResolved: null }); });

  it('stores the resolved plan and clears loading after connect', async () => {
    const c = new LocalNativeClient({ asr: fakeAsr(), translate: fakeTr(), tts: fakeTts() });
    c.setEventHandlers({});
    await c.connect(cfg);
    const st = useNativeModelStore.getState();
    expect(st.asrLoading).toBe(false);
    expect(st.asrResolved).toEqual({ model: 'granite-speech-4.1-2b', device: 'cuda', rtf: 0.02 });
  });

  it('stores measured memory + fallback reason from the resolved plan', async () => {
    const asr = {
      onResult: null as any, onError: null as any,
      init: async () => ({ loadTimeMs: 5, device: 'cuda', rtf: 0.02, memoryBytes: 8_000_000_000 }),
      feedAudio() {}, flush: async () => {}, dispose() {},
    };
    const translate = {
      onError: null as any,
      init: async () => ({ device: 'cpu', memoryBytes: 4_200_000_000, fallbackReason: 'cuda skipped; using CPU' }),
      translate: async () => ({ translatedText: 'x', inferenceTimeMs: 1 }), dispose() {},
    };
    const c = new LocalNativeClient({ asr, translate, tts: fakeTts() });
    c.setEventHandlers({});
    await c.connect(cfg);
    const st = useNativeModelStore.getState();
    expect(st.asrResolved).toMatchObject({ device: 'cuda', memoryBytes: 8_000_000_000 });
    expect(st.translationResolved).toMatchObject({ device: 'cpu', memoryBytes: 4_200_000_000, fallbackReason: 'cuda skipped; using CPU' });
  });
});

// ── Load order: GPU-priority stage claims VRAM first ──────────────────────────

const orderRecordingDeps = (order: string[]) => ({
  asr: {
    onResult: null as any, onError: null as any,
    init: async () => { order.push('asr'); return { device: 'cuda', rtf: 0.02 }; },
    feedAudio() {}, flush: async () => {}, dispose() {},
  },
  translate: {
    onError: null as any,
    init: async () => { order.push('translate'); return { device: 'cpu' }; },
    translate: async () => ({ translatedText: 'x', inferenceTimeMs: 1 }), dispose() {},
  },
  tts: fakeTts(),
});

describe('LocalNativeClient load order', () => {
  beforeEach(() => useNativeModelStore.setState({ catalog: {}, sizes: {} } as any));

  it('loads a GPU-only ASR model before the flexible translation model', async () => {
    useNativeModelStore.setState({
      catalog: {
        'voxtral-mini-4b-realtime': { id: 'voxtral-mini-4b-realtime', name: '', languages: [], recommended: false,
          tiers: [{ tier: 'gpu-cuda', backend: 'voxtral_realtime', available: true }] },
        'qwen3.5-2b': { id: 'qwen3.5-2b', name: '', languages: [], recommended: false,
          tiers: [{ tier: 'gpu-cuda', backend: 'llamacpp_qwen', available: true },
                  { tier: 'cpu', backend: 'llamacpp_qwen', available: true }] },
      },
    } as any);
    const order: string[] = [];
    const c = new LocalNativeClient(orderRecordingDeps(order));
    c.setEventHandlers({});
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'ja',
      asrModelId: 'voxtral-mini-4b-realtime', translationModelId: 'qwen3.5-2b', textOnly: true } as any);
    expect(order).toEqual(['asr', 'translate']);
  });

  it('loads the larger model first when neither stage is GPU-only', async () => {
    useNativeModelStore.setState({
      catalog: {
        'sense-voice': { id: 'sense-voice', name: '', languages: [], recommended: false,
          tiers: [{ tier: 'gpu-cuda', backend: 'x', available: true }, { tier: 'cpu', backend: 'x', available: true }] },
        'qwen3.5-2b': { id: 'qwen3.5-2b', name: '', languages: [], recommended: false,
          tiers: [{ tier: 'gpu-cuda', backend: 'x', available: true }, { tier: 'cpu', backend: 'x', available: true }] },
      },
      sizes: { 'sense-voice': 900_000_000, 'qwen3.5-2b': 4_000_000_000 },
    } as any);
    const order: string[] = [];
    const c = new LocalNativeClient(orderRecordingDeps(order));
    c.setEventHandlers({});
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'ja',
      asrModelId: 'sense-voice', translationModelId: 'qwen3.5-2b', textOnly: true } as any);
    expect(order).toEqual(['translate', 'asr']);
  });
});

// ── Task 5: per-sentence TTS playback parity ─────────────────────────────────

function fakeDeps(over: { tts?: any; translate?: any } = {}) {
  return {
    asr: {
      onResult: null as any, onError: null as any, onPartialResult: null as any,
      init: vi.fn().mockResolvedValue({ loadTimeMs: 1, device: 'cpu' }),
      feedAudio: vi.fn(), flush: vi.fn(), dispose: vi.fn(),
    },
    translate: over.translate ?? {
      onError: null as any,
      init: vi.fn().mockResolvedValue({ device: 'cpu' }),
      translate: vi.fn().mockResolvedValue({ translatedText: 'Hello there. How are you?', inferenceTimeMs: 1 }),
      dispose: vi.fn(),
    },
    tts: over.tts ?? {
      init: vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, device: 'cpu', streaming: false }),
      generate: vi.fn().mockResolvedValue({ samples: new Float32Array(2400), sampleRate: 24000, generationTimeMs: 3 }),
      cancel: vi.fn(), dispose: vi.fn(),
    },
  };
}

describe('LocalNativeClient TTS playback parity', () => {
  beforeEach(() => useNativeModelStore.setState({ ttsResolved: null, ttsLoading: false } as any));

  it('one-shot piper: splits sentences and emits a delta + karaoke segment per sentence', async () => {
    const deltas: any[] = [];
    const deps = fakeDeps({
      tts: {
        init: vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, device: 'cpu', streaming: false, clones: false }),
        generate: vi.fn().mockResolvedValue({ samples: new Float32Array(2400), sampleRate: 24000, generationTimeMs: 3 }),
        cancel: vi.fn(), dispose: vi.fn(),
      },
    });
    const c = new LocalNativeClient(deps as any);
    c.setEventHandlers({ onConversationUpdated: (e: any) => { if (e.delta?.audio) deltas.push(e); } });
    // translate returns 'Hello there. How are you?' (two sentences)
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'q', ttsModelId: 'csukuangfj/vits-piper-en_US-amy-low', ttsSpeed: 1.0, textOnly: false } as any);
    await (c as any).runJob('hola');
    expect(deps.tts.generate).toHaveBeenCalledTimes(2);          // one per sentence
    expect(deltas.length).toBe(2);                                // one audio delta per sentence
    const item = deltas[deltas.length - 1].item;
    expect(item.formatted.audioSegments.length).toBe(2);         // karaoke segment per sentence
  });

  it('streaming MOSS: emits one delta per chunk via onChunk', async () => {
    const deltas: any[] = [];
    const deps = fakeDeps({
      tts: {
        init: vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, device: 'cpu', streaming: true, clones: true }),
        generate: vi.fn().mockImplementation(async (_t: string, _s: number, onChunk: any) => {
          onChunk(new Float32Array(800)); onChunk(new Float32Array(800));
          return { samples: new Float32Array(0), sampleRate: 24000, generationTimeMs: 4 };
        }),
        cancel: vi.fn(), dispose: vi.fn(),
      },
      translate: {
        onError: null as any,
        init: vi.fn().mockResolvedValue({ device: 'cpu' }),
        translate: vi.fn().mockResolvedValue({ translatedText: 'Hi.', inferenceTimeMs: 1 }),
        dispose: vi.fn(),
      },
    });
    const c = new LocalNativeClient(deps as any);
    c.setEventHandlers({ onConversationUpdated: (e: any) => { if (e.delta?.audio) deltas.push(e); } });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'a', translationModelId: 't', ttsModelId: 'moss-tts-nano', ttsSpeed: 1.0, textOnly: false } as any);
    await (c as any).runJob('hi');
    expect(deltas.length).toBe(2);                                // one delta per streamed chunk
  });

  it('per-sentence TTS error skips the failing sentence and still completes the item', async () => {
    // translate returns 'Hello there. How are you?' (two sentences via fakeDeps)
    // first sentence generate() throws → should be skipped; second sentence plays → delta emitted
    let callCount = 0;
    const tts = {
      init: vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, device: 'cpu', streaming: false, clones: false }),
      generate: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('tts boom');
        return { samples: new Float32Array(2400), sampleRate: 24000, generationTimeMs: 3 };
      }),
      cancel: vi.fn(), dispose: vi.fn(),
    };
    const deps = fakeDeps({ tts });
    const c = new LocalNativeClient(deps as any);
    const deltas: any[] = [];
    let completedItem: any = null;
    c.setEventHandlers({
      onConversationUpdated: (e: any) => {
        if (e.delta?.audio) deltas.push(e);
        if (e.item.role === 'assistant' && e.item.status === 'completed') completedItem = e.item;
      },
    });
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'q',
      ttsModelId: 'csukuangfj/vits-piper-en_US-amy-low', ttsSpeed: 1.0, textOnly: false,
    } as any);
    await (c as any).runJob('hola');
    // first sentence failed (skipped), second sentence's audio still emitted
    expect(deltas.length).toBe(1);
    // item must reach completed — not stranded in_progress
    expect(completedItem).toBeDefined();
    expect(completedItem.status).toBe('completed');
  });

  it('cancelResponse cancels the in-flight TTS stream', async () => {
    const deps = fakeDeps({
      tts: {
        init: vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, device: 'cpu', streaming: true, clones: true }),
        generate: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
      },
    });
    const c = new LocalNativeClient(deps as any);
    c.setEventHandlers({});
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'a', translationModelId: 't', ttsModelId: 'moss-tts-nano', ttsSpeed: 1.0, textOnly: false } as any);
    c.cancelResponse();
    expect(deps.tts.cancel).toHaveBeenCalled();
  });

  // ── Karaoke timing parity (Fix 1 + Fix 2) ───────────────────────────────────

  it('streaming: pre-sets audioTextEnd before chunks and emits bare update after sentence stream', async () => {
    // 'Hi.' is a single sentence — simplifies the event sequence.
    const events: Array<{ hasDeltaAudio: boolean; audioTextEnd?: number; segCount: number; status: string }> = [];
    const tts = {
      init: vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, device: 'cpu', streaming: true }),
      generate: vi.fn().mockImplementation(async (_t: string, _s: number, onChunk: any) => {
        onChunk(new Float32Array(800)); // one chunk per sentence
      }),
      cancel: vi.fn(), dispose: vi.fn(),
    };
    const translate = {
      onError: null as any,
      init: vi.fn().mockResolvedValue({ device: 'cpu' }),
      translate: vi.fn().mockResolvedValue({ translatedText: 'Hi.', inferenceTimeMs: 1 }),
      dispose: vi.fn(),
    };
    const deps = fakeDeps({ tts, translate });
    const c = new LocalNativeClient(deps as any);
    c.setEventHandlers({
      onConversationUpdated: (e: any) => events.push({
        hasDeltaAudio: !!e.delta?.audio,
        audioTextEnd: e.item.formatted?.audioTextEnd,
        segCount: e.item.formatted?.audioSegments?.length ?? 0,
        status: e.item.status,
      }),
    });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'a', translationModelId: 't', ttsModelId: 'moss-tts-nano', ttsSpeed: 1.0, textOnly: false } as any);
    await (c as any).runJob('hi');

    // The bare emit after the sentence stream has audioSegments populated and status still in_progress.
    const bareSegmentEmit = events.find((e) => !e.hasDeltaAudio && e.segCount >= 1 && e.status !== 'completed');
    expect(bareSegmentEmit).toBeDefined();                   // bare emit fired (Fix 2)
    expect(bareSegmentEmit!.audioTextEnd).toBeGreaterThan(0); // audioTextEnd was set (Fix 2)

    // Every chunk delta should already carry the pre-set audioTextEnd (non-zero).
    const chunkDeltas = events.filter((e) => e.hasDeltaAudio);
    expect(chunkDeltas.length).toBeGreaterThan(0);
    expect(chunkDeltas[0].audioTextEnd).toBeGreaterThan(0);  // pre-set before generate (Fix 2)
  });

  it('one-shot: audioTextEnd set before generate and audioSegments pushed before audio delta', async () => {
    // generate mock captures audioTextEnd on the item at call time; event handler
    // records audioSegments.length when each audio delta fires.
    let capturedItem: any = null;
    let audioTextEndAtFirstGenerate: number | undefined;
    const deltaSegCounts: number[] = [];

    const tts = {
      init: vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, device: 'cpu', streaming: false }),
      generate: vi.fn().mockImplementation(async () => {
        if (audioTextEndAtFirstGenerate === undefined) {
          audioTextEndAtFirstGenerate = capturedItem?.formatted?.audioTextEnd;
        }
        return { samples: new Float32Array(2400), sampleRate: 24000 };
      }),
      cancel: vi.fn(), dispose: vi.fn(),
    };
    // fakeDeps translate returns 'Hello there. How are you?' (two sentences)
    const deps = fakeDeps({ tts });
    const c = new LocalNativeClient(deps as any);
    c.setEventHandlers({
      onConversationUpdated: (e: any) => {
        if (e.item.role === 'assistant') {
          capturedItem = e.item;
          if (e.delta?.audio) deltaSegCounts.push(e.item.formatted?.audioSegments?.length ?? 0);
        }
      },
    });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'q', ttsModelId: 'csukuangfj/vits-piper-en_US-amy-low', ttsSpeed: 1.0, textOnly: false } as any);
    await (c as any).runJob('hola');

    expect(audioTextEndAtFirstGenerate).toBeGreaterThan(0); // audioTextEnd set before first generate (Fix 1)
    expect(deltaSegCounts).toEqual([1, 2]);                 // segment pushed before each delta (Fix 1)
  });
});

// ── Task 4: ttsResolved + streaming flag ──────────────────────────────────────

function tts4Deps(over: any = {}) {
  return {
    asr: {
      onResult: null as any, onError: null as any, onPartialResult: null as any,
      init: vi.fn().mockResolvedValue({ loadTimeMs: 1, device: 'cpu' }),
      feedAudio: vi.fn(), flush: vi.fn(), dispose: vi.fn(),
    },
    translate: {
      onError: null as any,
      init: vi.fn().mockResolvedValue({ device: 'cpu' }),
      translate: vi.fn().mockResolvedValue({ translatedText: 'x', inferenceTimeMs: 1 }),
      dispose: vi.fn(),
    },
    tts: {
      init: vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 2, device: 'cpu', rtf: 0.44, streaming: true, clones: true }),
      generate: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
    },
    ...over,
  };
}

describe('LocalNativeClient TTS connect', () => {
  beforeEach(() => useNativeModelStore.setState({ ttsResolved: null, ttsLoading: false }));

  it('surfaces ttsResolved from the TTS init', async () => {
    const deps = tts4Deps();
    const c = new LocalNativeClient(deps);
    c.setEventHandlers({});
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'ja',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b',
      ttsModelId: 'moss-tts-nano', ttsSpeed: 1.0, textOnly: false,
    } as any);
    expect(deps.tts.init).toHaveBeenCalledWith('moss-tts-nano', undefined, 'ja', undefined);
    expect(useNativeModelStore.getState().ttsResolved).toMatchObject({ model: 'moss-tts-nano', device: 'cpu', rtf: 0.44 });
  });

  it('sets ttsLoading true then false around init', async () => {
    const loadingStates: boolean[] = [];
    let resolveTtsInit!: (v: any) => void;
    const slowTts = {
      init: vi.fn().mockReturnValue(new Promise((res) => { resolveTtsInit = res; })),
      generate: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
    };
    const deps = tts4Deps({ tts: slowTts });
    const c = new LocalNativeClient(deps);
    c.setEventHandlers({});
    const connectPromise = c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'ja',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b',
      ttsModelId: 'piper-en-amy', ttsSpeed: 1.0, textOnly: false,
    } as any);
    // Allow ASR + translate to finish but TTS init still pending
    await new Promise((r) => setTimeout(r, 0));
    loadingStates.push(useNativeModelStore.getState().ttsLoading);
    resolveTtsInit({ sampleRate: 22050, loadTimeMs: 3, device: 'cpu', rtf: 0.3, streaming: false });
    await connectPromise;
    loadingStates.push(useNativeModelStore.getState().ttsLoading);
    expect(loadingStates[0]).toBe(true);
    expect(loadingStates[1]).toBe(false);
  });

  it('inits TTS for pocket models like any other voice-capable card', async () => {
    // The pocket exclusion predated the pluggable pocket_onnx backend: pocket
    // now rides the standard tts_init + capability-driven voice path, so the
    // model-id string gate is gone.
    const deps = tts4Deps();
    const c = new LocalNativeClient(deps);
    c.setEventHandlers({});
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'ja',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b',
      ttsModelId: 'pocket-tts-en', ttsSpeed: 1.0, textOnly: false,
    } as any);
    expect(deps.tts.init).toHaveBeenCalledWith('pocket-tts-en', undefined, 'ja', undefined);
    expect(useNativeModelStore.getState().ttsResolved).not.toBeNull();
  });
});

// ── Task 7: built-in voice applied at connect ─────────────────────────────────

describe('LocalNativeClient voice selection', () => {
  it('applies the selected builtin voice after init', async () => {
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, streaming: true });
    m.tts.setVoice = vi.fn().mockResolvedValue(undefined);
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', ttsModelId: 'moss-tts-nano', ttsVoice: 'builtin:Bella',
    } as any);
    expect(m.tts.init).toHaveBeenCalledWith('moss-tts-nano', undefined, 'en', undefined);
    expect(m.tts.setVoice).toHaveBeenCalledWith('Bella');
  });

  it('keeps TTS enabled when a stale builtin voice is rejected', async () => {
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, streaming: false });
    m.tts.setVoice = vi.fn().mockRejectedValue(new Error('unknown builtin voice: Xiaoyu'));
    const onError = vi.fn();
    const c = new LocalNativeClient({ ...m, onError });
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'ja', targetLanguage: 'zh',
      asrModelId: 'sense-voice', ttsModelId: 'kokoro-82m', ttsVoice: 'builtin:Xiaoyu',
    } as any);
    expect(c['ttsEnabled']).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('empty ttsVoice on a cloning model resolves to the per-language default builtin', async () => {
    // Voice capability now comes from the catalog entry (voiceCapability), not the
    // runtime init response — a clone-capable model must be registered there.
    useNativeModelStore.setState({
      catalog: { 'moss-tts-nano': { id: 'moss-tts-nano', name: 'MOSS', languages: ['en'], recommended: false, tiers: [], clones: true } as any },
    } as any);
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, clones: true });
    m.tts.setVoice = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(await import('../../stores/nativeModelStore'), 'nativeListTtsVoices')
      .mockResolvedValue([{ name: 'Ava', language: 'en', curated: true, unstable: false, default: true }] as any);
    const c = new LocalNativeClient(m);
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', ttsModelId: 'moss-tts-nano' } as any);
    expect(m.tts.setVoice).toHaveBeenCalledWith('Ava');
  });

  it('empty ttsVoice on named non-cloning Kokoro selects the target-language default', async () => {
    useNativeModelStore.setState({
      catalog: {
        'kokoro-82m': {
          id: 'kokoro-82m', name: 'Kokoro', languages: ['zh', 'en'], recommended: true,
          tiers: [], clones: false, numSpeakers: 53,
          voice: { builtin: 'named', custom: 'none' },
        } as any,
      },
    } as any);
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, clones: false });
    m.tts.setVoice = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(await import('../../stores/nativeModelStore'), 'nativeListTtsVoices')
      .mockResolvedValue([
        { name: 'af_heart', language: 'en', curated: true, unstable: false, default: true },
        { name: 'zf_xiaoxiao', language: 'zh', curated: true, unstable: false, default: true },
      ] as any);
    const c = new LocalNativeClient(m);
    await c.connect({
      provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'zh',
      asrModelId: 'sense-voice', ttsModelId: 'kokoro-82m',
    } as any);
    expect(m.tts.setVoice).toHaveBeenCalledWith('zf_xiaoxiao');
  });

  it('sid: voice calls setSpeaker on a range (multi-speaker) model', async () => {
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, clones: false });
    m.tts.setSpeaker = vi.fn().mockResolvedValue(undefined);
    const c = new LocalNativeClient(m);
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', ttsModelId: 'piper-en', ttsVoice: 'sid:3' } as any);
    expect(m.tts.setSpeaker).toHaveBeenCalledWith(3);
    expect(m.tts.setVoice).not.toHaveBeenCalled();
  });

  it('single-voice (non-cloning, no ttsVoice) sends no voice command', async () => {
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1, clones: false });
    const c = new LocalNativeClient(m);
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', ttsModelId: 'piper-en-amy' } as any);
    expect(m.tts.setVoice).not.toHaveBeenCalled();
    expect(m.tts.setSpeaker).not.toHaveBeenCalled();
  });

  it('applies a custom cloned voice via setReferenceVoice', async () => {
    // Voice capability (and so which NativeVoiceStore backs 'custom:') now comes
    // from the catalog entry: a clip-clone-capable model must be registered there.
    useNativeModelStore.setState({
      catalog: { 'moss-tts-nano': { id: 'moss-tts-nano', name: 'MOSS', languages: ['en'], recommended: false, tiers: [], clones: true } as any },
    } as any);
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1 });
    m.tts.setReferenceVoice = vi.fn().mockResolvedValue(undefined);
    // Stub the storage read the ClipVoiceStore uses under the hood (inject via deps or vi.mock the module).
    vi.spyOn(await import('../../lib/local-inference/nativeVoiceStorage'), 'listNativeVoices')
      .mockResolvedValue([{ id: 7, name: 'Mine', audio: new Float32Array([0.1, 0.2]).buffer, sampleRate: 16000, createdAt: 0, transcript: 'the transcript' }]);
    vi.spyOn(await import('../../lib/local-inference/nativeVoiceStorage'), 'getNativeVoice')
      .mockResolvedValue({ id: 7, name: 'Mine', audio: new Float32Array([0.1, 0.2]).buffer, sampleRate: 16000, createdAt: 0, transcript: 'the transcript' });
    const c = new LocalNativeClient(m);
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', ttsModelId: 'moss-tts-nano', ttsVoice: 'custom:7' } as any);
    expect(m.tts.setReferenceVoice).toHaveBeenCalledWith(expect.any(Float32Array), 16000, 'the transcript');
  });

  it('applies a custom cloned voice without a transcript (MOSS back-compat)', async () => {
    useNativeModelStore.setState({
      catalog: { 'moss-tts-nano': { id: 'moss-tts-nano', name: 'MOSS', languages: ['en'], recommended: false, tiers: [], clones: true } as any },
    } as any);
    const m = mocks();
    m.tts.init = vi.fn().mockResolvedValue({ sampleRate: 24000, loadTimeMs: 1 });
    m.tts.setReferenceVoice = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(await import('../../lib/local-inference/nativeVoiceStorage'), 'listNativeVoices')
      .mockResolvedValue([{ id: 8, name: 'Mine', audio: new Float32Array([0.1, 0.2]).buffer, sampleRate: 16000, createdAt: 0 }]);
    vi.spyOn(await import('../../lib/local-inference/nativeVoiceStorage'), 'getNativeVoice')
      .mockResolvedValue({ id: 8, name: 'Mine', audio: new Float32Array([0.1, 0.2]).buffer, sampleRate: 16000, createdAt: 0 });
    const c = new LocalNativeClient(m);
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', ttsModelId: 'moss-tts-nano', ttsVoice: 'custom:8' } as any);
    expect(m.tts.setReferenceVoice).toHaveBeenCalledWith(expect.any(Float32Array), 16000, undefined);
  });
});

// ── Enriched Logs-panel event payloads ───────────────────────────────────────
// Native events must carry the same rich fields the WASM LocalInferenceClient
// logs (modelId + timing + rtf per stage) and surface the sidecar's resolved
// hardware plan (device/backend/computeType/memory) + fallback + machine info.

describe('LocalNativeClient enriched log fields', () => {
  beforeEach(() => useNativeModelStore.setState({
    asrResolved: null, translationResolved: null, ttsResolved: null,
    asrLoading: false, ttsLoading: false, catalog: {}, sizes: {},
  } as any));
  // Restore module spies (nativeHardwareInfo) so they don't leak into later
  // tests — the shared vitest setup doesn't enable restoreMocks.
  afterEach(() => vi.restoreAllMocks());

  it('asr.end carries modelId + timing + rtf, and partials are logged', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    const events: any[] = [];
    c.setEventHandlers({ onRealtimeEvent: (e: any) => events.push(e.event) });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b' } as any);
    m.asr.onPartialResult('ho');
    await m.asr.onResult({ text: 'hola', durationMs: 200, recognitionTimeMs: 10 });
    await new Promise((r) => setTimeout(r, 0));

    const partial = events.find((e) => e.type === 'local.native.asr.partial');
    expect(partial?.data.text).toBe('ho');
    const end = events.find((e) => e.type === 'local.native.asr.end');
    expect(end.data).toMatchObject({ text: 'hola', modelId: 'sense-voice', durationMs: 200, recognitionTimeMs: 10, rtf: 0.05 });
  });

  it('translation.start/end carry sourceText, modelId, systemPrompt, wrapTranscript', async () => {
    const m = mocks();
    const c = new LocalNativeClient(m);
    const events: any[] = [];
    c.setEventHandlers({ onRealtimeEvent: (e: any) => events.push(e.event) });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b', instructions: 'be terse', wrapTranscript: true } as any);
    await finalizeAsr(c, m.asr, { text: 'hola', durationMs: 1, recognitionTimeMs: 1 });

    const start = events.find((e) => e.type === 'local.native.translation.start');
    expect(start.data).toMatchObject({ sourceText: 'hola', modelId: 'qwen2.5-0.5b', systemPrompt: 'be terse', wrapTranscript: true });
    const end = events.find((e) => e.type === 'local.native.translation.end');
    expect(end.data).toMatchObject({ sourceText: 'hola', translatedText: 'hello', inferenceTimeMs: 2, modelId: 'qwen2.5-0.5b' });
  });

  it('tts.start carries text/sentenceCount/modelId/voice/speed and per-sentence events fire with generateMs', async () => {
    const deps = fakeDeps(); // translate → 'Hello there. How are you?' (2 sentences); generate generationTimeMs:3
    const c = new LocalNativeClient(deps as any);
    const events: any[] = [];
    c.setEventHandlers({ onRealtimeEvent: (e: any) => events.push(e.event) });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'q',
      ttsModelId: 'csukuangfj/vits-piper-en_US-amy-low', ttsSpeed: 1.25, textOnly: false } as any);
    await (c as any).runJob('hola');

    const start = events.find((e) => e.type === 'local.native.tts.start');
    expect(start.data).toMatchObject({ sentenceCount: 2, modelId: 'csukuangfj/vits-piper-en_US-amy-low', speed: 1.25 });
    expect(start.data.text).toContain('Hello');
    const sentEnds = events.filter((e) => e.type === 'local.native.tts.sentence.end');
    expect(sentEnds.length).toBe(2);
    expect(sentEnds[0].data).toMatchObject({ sentenceIndex: 0, sentenceCount: 2, generateMs: 3 });
    expect(sentEnds[0].data.audioDurationMs).toBeGreaterThan(0);
    const ttsEnd = events.find((e) => e.type === 'local.native.tts.end');
    expect(ttsEnd.data).toMatchObject({ sentenceCount: 2 });
    expect(ttsEnd.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('init.{engine}.ready carry device/backend/computeType/memory/loadTimeMs; fallback event emitted', async () => {
    const asr = {
      onResult: null as any, onError: null as any, onPartialResult: null as any,
      init: async () => ({ loadTimeMs: 5, device: 'cuda', backend: 'ort', computeType: 'fp16', rtf: 0.02, memoryBytes: 8_000_000_000 }),
      feedAudio() {}, flush: async () => {}, dispose() {},
    };
    const translate = {
      onError: null as any,
      init: async () => ({ loadTimeMs: 9, device: 'cpu', backend: 'llamacpp', computeType: 'q4', tokensPerSec: 12.5, memoryBytes: 4_000_000_000, fallbackReason: 'cuda skipped; using CPU' }),
      translate: async () => ({ translatedText: 'x', inferenceTimeMs: 1 }), dispose() {},
    };
    const c = new LocalNativeClient({ asr, translate, tts: fakeTts() });
    const events: any[] = [];
    c.setEventHandlers({ onRealtimeEvent: (e: any) => events.push(e.event) });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'en', targetLanguage: 'ja',
      asrModelId: 'granite', translationModelId: 'q', textOnly: true } as any);

    const asrReady = events.find((e) => e.type === 'local.native.init.asr.ready');
    expect(asrReady.data).toMatchObject({ model: 'granite', device: 'cuda', backend: 'ort', computeType: 'fp16', rtf: 0.02, memoryBytes: 8_000_000_000, loadTimeMs: 5 });
    const trReady = events.find((e) => e.type === 'local.native.init.translation.ready');
    expect(trReady.data).toMatchObject({ model: 'q', device: 'cpu', backend: 'llamacpp', tokensPerSec: 12.5, loadTimeMs: 9 });
    const fb = events.find((e) => e.type === 'local.native.init.translation.fallback');
    expect(fb.data).toMatchObject({ model: 'q', fallbackReason: 'cuda skipped; using CPU' });
  });

  it('emits local.native.hardware from nativeHardwareInfo', async () => {
    vi.spyOn(await import('../../stores/nativeModelStore'), 'nativeHardwareInfo')
      .mockResolvedValue({
        type: 'hardware_info_result', id: 1, os: 'linux', arch: 'x64', cpuCores: 16,
        gpus: [{ vendor: 'nvidia', name: 'RTX 4070', vramMb: 12000 }], backendsInstalled: ['ort-cuda'], accelAvailable: true,
      } as any);
    const m = mocks();
    const c = new LocalNativeClient(m);
    const events: any[] = [];
    c.setEventHandlers({ onRealtimeEvent: (e: any) => events.push(e.event) });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b' } as any);
    await new Promise((r) => setTimeout(r, 0)); // hardware probe runs off the critical path

    const hw = events.find((e) => e.type === 'local.native.hardware');
    expect(hw.data).toMatchObject({ os: 'linux', arch: 'x64', cpuCores: 16, accelAvailable: true });
    expect(hw.data.gpus[0].name).toBe('RTX 4070');
    expect(hw.data.backendsInstalled).toContain('ort-cuda');
  });

  it('does not block session startup on a slow hardware probe', async () => {
    // A hardware probe that never resolves must not hang connect() — the ASR/
    // translation init is the critical path; hardware logging is diagnostic-only.
    vi.spyOn(await import('../../stores/nativeModelStore'), 'nativeHardwareInfo')
      .mockReturnValue(new Promise(() => { /* never resolves */ }));
    const m = mocks();
    const c = new LocalNativeClient(m);
    c.setEventHandlers({});
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b' } as any);
    expect(m.asr.init).toHaveBeenCalled(); // reached here → connect resolved despite the stalled probe
  });

  it('translation failure emits a stage-tagged local.native.error', async () => {
    const m = mocks();
    m.translate.translate = vi.fn().mockRejectedValue(new Error('translate boom'));
    const c = new LocalNativeClient(m);
    const events: any[] = [];
    c.setEventHandlers({ onRealtimeEvent: (e: any) => events.push(e.event), onError() {} });
    await c.connect({ provider: 'local_native', model: 'native', sourceLanguage: 'es', targetLanguage: 'en',
      asrModelId: 'sense-voice', translationModelId: 'qwen2.5-0.5b' } as any);
    await finalizeAsr(c, m.asr, { text: 'hola', durationMs: 1, recognitionTimeMs: 1 });

    const err = events.find((e) => e.type === 'local.native.error' && e.data.stage === 'translation');
    expect(err).toBeDefined();
    expect(err.data.modelId).toBe('qwen2.5-0.5b');
    expect(err.data.error).toContain('translate boom');
  });
});
