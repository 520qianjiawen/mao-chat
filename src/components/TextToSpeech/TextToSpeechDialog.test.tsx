import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TextToSpeechDialog from './TextToSpeechDialog';

const mocks = vi.hoisted(() => ({
  translate: vi.fn(),
  ttsGenerate: vi.fn(),
  ttsInit: vi.fn(),
  ttsSetVoice: vi.fn(),
  geminiSpeech: vi.fn(),
  geminiTranslate: vi.fn(),
  sidecarStatus: 'ready' as 'idle' | 'starting' | 'ready' | 'unavailable',
  provider: 'local_native' as string,
  openai: { apiKey: 'sk-test', voice: 'alloy' },
  openaiTranslate: { apiKey: '' },
  openaiCompatible: { apiKey: '', customEndpoint: '' },
  gemini: { apiKey: 'test-gemini-key' },
  updateGemini: vi.fn(),
  settings: {
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    ttsModel: 'kokoro-82m',
    ttsVoice: 'builtin:af_heart',
    ttsSpeed: 1,
    ttsDevice: 'auto',
    translationModel: 'qwen2.5-0.5b',
    translationDevice: 'auto',
    translationVariantByModel: {} as Record<string, string>,
    deeplApiKey: '',
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../../stores/settingsStore', () => ({
  useLocalNativeSettings: () => mocks.settings,
  useProvider: () => mocks.provider,
  useOpenAISettings: () => mocks.openai,
  useOpenAITranslateSettings: () => mocks.openaiTranslate,
  useOpenAICompatibleSettings: () => mocks.openaiCompatible,
  useGeminiSettings: () => mocks.gemini,
  useUpdateGemini: () => mocks.updateGemini,
}));
vi.mock('../../lib/gemini/geminiSpeech', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/gemini/geminiSpeech')>();
  return {
    ...actual,
    createGeminiSpeech: mocks.geminiSpeech,
    translateWithGemini: mocks.geminiTranslate,
  };
});
vi.mock('../../stores/sessionStore', () => ({ useIsSessionActive: () => false }));
vi.mock('../../stores/nativeModelStore', () => ({
  useNativeCatalog: () => ({
    'kokoro-82m': {
      id: 'kokoro-82m', name: 'Kokoro 82M', kind: 'tts',
      languages: ['en', 'zh', 'es', 'fr', 'hi', 'it', 'ja', 'pt'],
      recommended: true, tiers: [{ tier: 'cpu', backend: 'kokoro_official', available: true }],
      order: 1, repo: 'kokoro', voice: { builtin: 'named', custom: 'none' },
      sizeBytes: 355_000_000,
    },
    'moss-tts-nano': {
      id: 'moss-tts-nano', name: 'MOSS-TTS-Nano', kind: 'tts',
      languages: ['en', 'ja'],
      recommended: true, tiers: [{ tier: 'cpu', backend: 'moss', available: true }],
      order: 0, repo: 'moss', voice: { builtin: 'named', custom: 'clip' },
      clones: true,
    },
    'qwen2.5-0.5b': {
      id: 'qwen2.5-0.5b', name: 'Qwen 2.5 0.5B', kind: 'translate', languages: ['multi'],
      recommended: true, tiers: [{ tier: 'cpu', backend: 'llama_cpp', available: true }],
      order: 1, repo: 'qwen',
    },
  }),
  useNativeModelStatuses: () => ({
    'kokoro-82m': 'ready',
    'moss-tts-nano': 'ready',
    'qwen2.5-0.5b': 'ready',
  }),
  useNativeModelProgress: () => ({}),
  useNativeModelErrors: () => ({}),
  useNativeSidecarStatus: () => mocks.sidecarStatus,
  useNativeModelStore: { getState: () => ({
    ensureCatalog: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    cancelDownload: vi.fn().mockResolvedValue(undefined),
    catalog: {
      'kokoro-82m': {
        id: 'kokoro-82m', name: 'Kokoro 82M', kind: 'tts',
        languages: ['en', 'zh', 'ja'], recommended: true, tiers: [],
        order: 1, repo: 'kokoro', voice: { builtin: 'named', custom: 'none' },
      },
      'moss-tts-nano': {
        id: 'moss-tts-nano', name: 'MOSS-TTS-Nano', kind: 'tts',
        languages: ['en', 'ja'], recommended: true, tiers: [],
        order: 0, repo: 'moss', voice: { builtin: 'named', custom: 'clip' },
      },
      'qwen2.5-0.5b': {
        id: 'qwen2.5-0.5b', name: 'Qwen 2.5 0.5B', kind: 'translate', languages: ['multi'],
        recommended: true, tiers: [], order: 1, repo: 'qwen',
      },
    },
    errors: {},
  }) },
  nativeListTtsVoices: vi.fn(async (model?: string) => {
    if (model === 'moss-tts-nano') {
      return [
        { name: 'Ava', language: 'en', curated: true, unstable: false, default: true },
        { name: 'Emma', language: 'en', curated: true, unstable: false, default: false },
      ];
    }
    // Kokoro-style names for the official model
    return [
      { name: 'af_heart', language: 'en', curated: true, unstable: false, default: true },
      { name: 'af_bella', language: 'en', curated: true, unstable: false, default: false },
      { name: 'zf_xiaoxiao', language: 'zh', curated: true, unstable: false, default: true },
      { name: 'zm_yunyang', language: 'zh', curated: true, unstable: false, default: false },
      { name: 'jf_alpha', language: 'ja', curated: true, unstable: false, default: true },
      { name: 'jm_kumo', language: 'ja', curated: true, unstable: false, default: false },
    ];
  }),
}));
vi.mock('../../lib/local-inference/native/NativeTtsClient', () => ({
  NativeTtsClient: class {
    init = mocks.ttsInit;
    setVoice = mocks.ttsSetVoice;
    setSpeaker = vi.fn();
    generate = mocks.ttsGenerate;
    cancel = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('../../lib/local-inference/native/NativeTranslateClient', () => ({
  NativeTranslateClient: class {
    init = vi.fn().mockResolvedValue({});
    translate = mocks.translate;
    dispose = vi.fn();
  },
}));
vi.mock('../../lib/local-inference/engine/TranslationEngine', () => ({
  TranslationEngine: class {},
}));

describe('TextToSpeechDialog modes', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.provider = 'local_native';
    mocks.settings.ttsModel = 'kokoro-82m';
    mocks.settings.ttsVoice = 'builtin:af_heart';
    mocks.settings.targetLanguage = 'en';
    mocks.sidecarStatus = 'ready';
    mocks.translate.mockReset().mockResolvedValue({ translatedText: 'Editable translation.', inferenceTimeMs: 80 });
    mocks.ttsInit.mockReset().mockResolvedValue({ sampleRate: 24_000 });
    mocks.ttsSetVoice.mockReset().mockResolvedValue(undefined);
    mocks.ttsGenerate.mockReset().mockResolvedValue({
      samples: new Float32Array([0.1, 0.2]), sampleRate: 24_000, generationTimeMs: 30,
    });
    mocks.geminiSpeech.mockReset().mockResolvedValue(new ArrayBuffer(100));
    mocks.geminiTranslate.mockReset().mockResolvedValue({
      translatedText: 'Gemini translated text.',
      inferenceTimeMs: 120,
    });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test-audio'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('waits for a fresh Native sidecar before showing the voice list', async () => {
    mocks.sidecarStatus = 'starting';
    const { rerender } = render(
      <TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />,
    );

    expect(screen.getByRole('option', { name: '正在加载声音…' })).toBeInTheDocument();

    mocks.sidecarStatus = 'ready';
    rerender(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: /声音/ })).toHaveValue('af_heart'));
    expect(screen.queryByRole('option', { name: '暂无可用声音' })).not.toBeInTheDocument();
  });

  it('offers direct speech and translate-then-speech as explicit choices', () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByRole('button', { name: '直接转语音' })).toHaveClass('is-active');
    fireEvent.click(screen.getByRole('button', { name: '翻译后转语音' }));

    expect(screen.getByRole('button', { name: '翻译后转语音' })).toHaveClass('is-active');
    expect(screen.getByText('原文语言')).toBeInTheDocument();
    expect(screen.getByText('语音语言')).toBeInTheDocument();
    expect(screen.getByText('Qwen 2.5 0.5B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '翻译' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成语音' })).toBeDisabled();
  });

  it('follows the TTS model selected in settings', async () => {
    mocks.settings.ttsModel = 'moss-tts-nano';
    mocks.settings.ttsVoice = 'builtin:Ava';
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByText('MOSS-TTS-Nano')).toBeInTheDocument();
    expect(screen.queryByText('Kokoro 82M')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: /Ava/ })).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: /声音/ })).toHaveValue('Ava');
  });

  it('loads voices for the settings TTS model (Kokoro)', async () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByText('Kokoro 82M')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: /Heart|af_heart/i })).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: /声音/ })).toHaveValue('af_heart');
  });

  it('switches Chinese text to a Chinese default voice', async () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: /声音/ })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox', { name: '文本与语音语言' }), { target: { value: 'zh' } });

    await waitFor(() => expect(screen.getByRole('combobox', { name: /声音/ })).toHaveValue('zf_xiaoxiao'));
  });

  it('exposes model languages including Japanese', async () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    const languageSelect = screen.getByRole('combobox', { name: '文本与语音语言' });
    fireEvent.change(languageSelect, { target: { value: 'ja' } });

    await waitFor(() => expect(screen.getByRole('combobox', { name: /声音/ })).toHaveValue('jf_alpha'));
  });

  it('shows an editable translation before generating speech', async () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '翻译后转语音' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^输入要翻译的原文/ }), {
      target: { value: '需要翻译的内容。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '翻译' }));

    const result = await screen.findByRole('textbox', { name: '翻译结果（可编辑）' });
    expect(result).toHaveValue('Editable translation.');
    expect(mocks.ttsGenerate).not.toHaveBeenCalled();

    fireEvent.change(result, { target: { value: 'Edited sentence. Another sentence!' } });
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }));

    await waitFor(() => expect(mocks.ttsGenerate).toHaveBeenCalledTimes(1));
    expect(mocks.ttsGenerate).toHaveBeenCalledWith(
      'Edited sentence. Another sentence!',
      1,
      expect.any(Function),
    );
    expect(screen.getByRole('button', { name: '重新翻译' })).toBeInTheDocument();
  });

  it('keeps the translation when switching voice so speech can be regenerated', async () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '翻译后转语音' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^输入要翻译的原文/ }), {
      target: { value: '需要翻译的内容。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '翻译' }));

    expect(await screen.findByRole('textbox', { name: '翻译结果（可编辑）' }))
      .toHaveValue('Editable translation.');

    await waitFor(() => expect(screen.getByRole('option', { name: /Bella|af_bella/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox', { name: /声音/ }), {
      target: { value: 'af_bella' },
    });

    expect(screen.getByRole('textbox', { name: '翻译结果（可编辑）' })).toHaveValue('Editable translation.');
    expect(screen.getByRole('button', { name: '生成语音' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }));
    await waitFor(() => expect(mocks.ttsGenerate).toHaveBeenCalled());
  });

  it('uses OpenAI Speech voices when the OpenAI provider is selected', async () => {
    mocks.provider = 'openai';
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByText('OpenAI Speech')).toBeInTheDocument();
    expect(screen.queryByText('Kokoro 82M')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: /marin/i })).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: /声音/ })).toHaveValue('alloy');
    expect(screen.getByRole('option', { name: /cedar/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Vibe/ })).toHaveValue('sincere');
    expect(screen.getByRole('option', { name: /真诚/ })).toBeInTheDocument();
  });

  it('supports up to 10,000 characters for long paragraphs', () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    const textarea = screen.getByPlaceholderText('在这里输入文字…');
    expect(textarea).toHaveAttribute('maxLength', '10000');
    expect(screen.getByText('0/10000')).toBeInTheDocument();
  });

  it('switches to Gemini 3.8 Flash TTS when gemini engine is selected', async () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    const engineSelect = screen.getByRole('combobox', { name: '语音引擎' });
    fireEvent.change(engineSelect, { target: { value: 'gemini' } });

    expect(screen.getByText('Google Gemini 3.8 Flash TTS')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: /Puck/i })).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: /声音/ })).toHaveValue('Puck');
    expect(screen.getByRole('combobox', { name: '情感与风格' })).toHaveValue('natural');
  });

  it('supports selecting different Gemini emotions and custom emotion prompt', async () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.change(screen.getByRole('combobox', { name: '语音引擎' }), { target: { value: 'gemini' } });
    const emotionSelect = screen.getByRole('combobox', { name: '情感与风格' });

    fireEvent.change(emotionSelect, { target: { value: 'cheerful' } });
    expect(emotionSelect).toHaveValue('cheerful');

    // Switch to custom emotion prompt
    fireEvent.change(emotionSelect, { target: { value: 'custom' } });
    const customPromptInput = screen.getByPlaceholderText(/例如：带着兴奋而激动的语气/i);
    expect(customPromptInput).toBeInTheDocument();

    fireEvent.change(customPromptInput, { target: { value: '充满激情地大声演讲' } });
    expect(customPromptInput).toHaveValue('充满激情地大声演讲');

    // Generate speech calls createGeminiSpeech with voice and emotion prompt
    const textarea = screen.getByPlaceholderText('在这里输入文字…');
    fireEvent.change(textarea, { target: { value: '你好世界！' } });
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }));

    await waitFor(() => expect(mocks.geminiSpeech).toHaveBeenCalledTimes(1));
    expect(mocks.geminiSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-gemini-key',
        text: '你好世界！',
        voice: 'Puck',
        emotionPrompt: '充满激情地大声演讲',
      }),
    );
  });

  it('uses Gemini translation and Gemini TTS in translate mode', async () => {
    render(<TextToSpeechDialog isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.change(screen.getByRole('combobox', { name: '语音引擎' }), { target: { value: 'gemini' } });
    fireEvent.click(screen.getByRole('button', { name: '翻译后转语音' }));

    expect(screen.getByText('gemini-3.8-flash-tts')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /^输入要翻译的原文/ }), {
      target: { value: '今天天气真好。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '翻译' }));

    await waitFor(() => expect(mocks.geminiTranslate).toHaveBeenCalledTimes(1));
    expect(mocks.geminiTranslate).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-gemini-key',
        text: '今天天气真好。',
      }),
    );

    const result = await screen.findByRole('textbox', { name: '翻译结果（可编辑）' });
    expect(result).toHaveValue('Gemini translated text.');

    fireEvent.click(screen.getByRole('button', { name: '生成语音' }));
    await waitFor(() => expect(mocks.geminiSpeech).toHaveBeenCalledTimes(1));
    expect(mocks.geminiSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Gemini translated text.',
      }),
    );
  });
});
