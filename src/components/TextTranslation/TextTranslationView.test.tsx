import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TextTranslationView from './TextTranslationView';

const mocks = vi.hoisted(() => ({
  nativeTranslateInit: vi.fn().mockResolvedValue({ loadTimeMs: 100 }),
  nativeTranslate: vi.fn().mockResolvedValue({
    sourceText: 'Hello world',
    translatedText: '你好，世界',
    inferenceTimeMs: 120,
  }),
  nativeDispose: vi.fn(),
  onlineInit: vi.fn().mockResolvedValue({ loadTimeMs: 50, device: 'wasm' }),
  onlineTranslate: vi.fn().mockResolvedValue({
    sourceText: 'Hello world',
    translatedText: '你好，世界',
    inferenceTimeMs: 100,
  }),
  onlineDispose: vi.fn(),
  ollamaInit: vi.fn().mockResolvedValue({ loadTimeMs: 40 }),
  ollamaTranslate: vi.fn().mockResolvedValue({
    sourceText: 'Hello world',
    translatedText: '你好，世界（Ollama）',
    inferenceTimeMs: 90,
  }),
  ollamaDispose: vi.fn(),
  settings: {
    targetLanguage: 'zh',
    translationModel: 'confucius4-t3po-14b',
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
}));

vi.mock('../../stores/nativeModelStore', () => ({
  useNativeCatalog: () => ({
    'confucius4-t3po-14b': {
      id: 'confucius4-t3po-14b',
      name: 'Confucius4-T3PO 14B',
      kind: 'translate',
      languages: ['multi'],
      recommended: true,
      tiers: [{ tier: 'metal', backend: 'llama_cpp', available: true }],
    },
  }),
  useNativeModelStatuses: () => ({
    'confucius4-t3po-14b': 'ready',
  }),
}));

vi.mock('../../lib/local-inference/native/NativeTranslateClient', () => {
  return {
    NativeTranslateClient: class {
      init = mocks.nativeTranslateInit;
      translate = mocks.nativeTranslate;
      dispose = mocks.nativeDispose;
    },
  };
});

vi.mock('../../lib/local-inference/engine/TranslationEngine', () => {
  return {
    TranslationEngine: class {
      init = mocks.onlineInit;
      translate = mocks.onlineTranslate;
      dispose = mocks.onlineDispose;
    },
  };
});

vi.mock('../../lib/ollama-translator', () => {
  return {
    fetchOllamaModels: vi.fn().mockResolvedValue([
      { name: 'translategemma:12b', model: 'translategemma:12b', size: 8109827612 },
    ]),
    OllamaTranslatorClient: class {
      init = mocks.ollamaInit;
      translate = mocks.ollamaTranslate;
      dispose = mocks.ollamaDispose;
    },
  };
});

describe('TextTranslationView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).electron = {
      invoke: vi.fn().mockResolvedValue({}),
      send: vi.fn(),
      receive: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    Object.assign(navigator, {
      clipboard: {
        readText: vi.fn().mockResolvedValue('Clipboard content'),
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders dual panels when open', () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i)).toBeInTheDocument();
    expect(screen.getByText(/翻译结果将清晰展示在此处/i)).toBeInTheDocument();
  });

  it('pastes text from clipboard when paste button clicked', async () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const pasteBtn = screen.getByRole('button', { name: /粘贴/i });
    fireEvent.click(pasteBtn);

    await waitFor(() => {
      expect(navigator.clipboard.readText).toHaveBeenCalled();
      const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i) as HTMLTextAreaElement;
      expect(textarea.value).toBe('Clipboard content');
    });
  });

  it('translates input text when translate button is clicked', async () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i);
    fireEvent.change(textarea, { target: { value: 'Hello world' } });

    const translateBtn = screen.getByRole('button', { name: /立即翻译/i });
    fireEvent.click(translateBtn);

    await waitFor(() => {
      expect(mocks.nativeTranslateInit).toHaveBeenCalled();
      expect(mocks.nativeTranslate).toHaveBeenCalled();
      expect(screen.getByText('你好，世界')).toBeInTheDocument();
    });
  });

  it('copies translated result to clipboard when copy button clicked', async () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i);
    fireEvent.change(textarea, { target: { value: 'Hello world' } });

    const translateBtn = screen.getByRole('button', { name: /立即翻译/i });
    fireEvent.click(translateBtn);

    await waitFor(() => {
      expect(screen.getByText('你好，世界')).toBeInTheDocument();
    });

    const copyBtn = screen.getByRole('button', { name: /复制/i });
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('你好，世界');
  });

  it('clears source and translation when clear button clicked', async () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Hello world' } });
    expect(textarea.value).toBe('Hello world');

    const clearBtn = screen.getByRole('button', { name: /清空/i });
    fireEvent.click(clearBtn);

    expect(textarea.value).toBe('');
    expect(screen.queryByText('你好，世界')).not.toBeInTheDocument();
  });

  it('automatically translates after typing without clicking translate button', async () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i);
    fireEvent.change(textarea, { target: { value: 'Hello world auto' } });

    // Wait for the 500ms debounce to fire translation automatically
    await waitFor(() => {
      expect(mocks.nativeTranslate).toHaveBeenCalledWith(
        'Hello world auto',
        expect.any(String),
        true,
      );
      expect(screen.getByText('你好，世界')).toBeInTheDocument();
    }, { timeout: 2000 });
  });

  it('automatically translates when target language is changed', async () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i);
    fireEvent.change(textarea, { target: { value: 'Hello' } });

    // Change target language to Japanese ('ja')
    const targetSelect = screen.getByLabelText('目标语言');
    fireEvent.change(targetSelect, { target: { value: 'ja' } });

    await waitFor(() => {
      expect(mocks.nativeTranslateInit).toHaveBeenCalledWith(
        '',
        'ja',
        'confucius4-t3po-14b',
        'auto',
        null,
        null,
        undefined,
      );
      expect(mocks.nativeTranslate).toHaveBeenCalled();
    }, { timeout: 2000 });
  });

  it('defaults target to English when Chinese input is detected, and Chinese when non-Chinese input is detected', async () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i);
    const targetSelect = screen.getByLabelText('目标语言') as HTMLSelectElement;

    // Type Chinese text
    fireEvent.change(textarea, { target: { value: '你好世界' } });
    await waitFor(() => {
      expect(targetSelect.value).toBe('en');
    });

    // Type English text
    fireEvent.change(textarea, { target: { value: 'Hello world' } });
    await waitFor(() => {
      expect(targetSelect.value).toBe('zh');
    });
  });

  it('calls onSendToTextToSpeech with translated text and target language when clicked', async () => {
    const onSendToTextToSpeech = vi.fn();
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
        onSendToTextToSpeech={onSendToTextToSpeech}
      />,
    );

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i);
    fireEvent.change(textarea, { target: { value: 'Hello' } });

    const translateBtn = screen.getByRole('button', { name: /立即翻译/i });
    fireEvent.click(translateBtn);

    await waitFor(() => {
      expect(screen.getByText('你好，世界')).toBeInTheDocument();
    });

    const ttsBtn = screen.getByRole('button', { name: /推送到语音/i });
    fireEvent.click(ttsBtn);

    expect(onSendToTextToSpeech).toHaveBeenCalledWith('你好，世界', 'zh');
  });

  it('highlights sentence on click in the result card', async () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i);
    fireEvent.change(textarea, { target: { value: 'Hello world.' } });

    const translateBtn = screen.getByRole('button', { name: /立即翻译/i });
    fireEvent.click(translateBtn);

    await waitFor(() => {
      expect(screen.getByText('你好，世界')).toBeInTheDocument();
    });

    const sentenceEl = screen.getByText('你好，世界');
    fireEvent.click(sentenceEl);

    expect(sentenceEl).toHaveClass('is-highlighted');
  });

  it('preserves line breaks and paragraphs across translation', async () => {
    mocks.nativeTranslate.mockImplementation(async (text: string) => ({
      sourceText: text,
      translatedText: text === 'Paragraph 1' ? '段落一' : '段落二',
      inferenceTimeMs: 50,
    }));

    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i);
    fireEvent.change(textarea, { target: { value: 'Paragraph 1\n\nParagraph 2' } });

    const translateBtn = screen.getByRole('button', { name: /立即翻译/i });
    fireEvent.click(translateBtn);

    await waitFor(() => {
      expect(screen.getByText('段落一')).toBeInTheDocument();
      expect(screen.getByText('段落二')).toBeInTheDocument();
    });

    const resultContainer = screen.getByText('段落一').parentElement;
    expect(resultContainer?.textContent).toContain('\n\n');
  });

  it('triggers screenshot OCR translation when OCR button is clicked', async () => {
    (window.electron.invoke as any).mockImplementation((channel: string) => {
      if (channel === 'quick-translate:ocr-screenshot') {
        return Promise.resolve({ ok: true, text: 'Hello from screenshot' });
      }
      return Promise.resolve({});
    });

    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const ocrBtn = screen.getByRole('button', { name: /截图翻译/i });
    fireEvent.click(ocrBtn);

    await waitFor(() => {
      expect(window.electron.invoke).toHaveBeenCalledWith('quick-translate:ocr-screenshot');
      const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i) as HTMLTextAreaElement;
      expect(textarea.value).toBe('Hello from screenshot');
    });
  });

  it('triggers selection capture translation when selection button is clicked', async () => {
    (window.electron.invoke as any).mockImplementation((channel: string) => {
      if (channel === 'quick-translate:capture-selection') {
        return Promise.resolve({ ok: true, text: 'Selected text' });
      }
      return Promise.resolve({});
    });

    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const selectBtn = screen.getByRole('button', { name: /划词翻译/i });
    fireEvent.click(selectBtn);

    await waitFor(() => {
      expect(window.electron.invoke).toHaveBeenCalledWith('quick-translate:capture-selection');
      const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i) as HTMLTextAreaElement;
      expect(textarea.value).toBe('Selected text');
    });
  });

  it('translates with Ollama local model when selected', async () => {
    render(
      <TextTranslationView
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    const modelSelect = await screen.findByRole('combobox', { name: /翻译模型/i });
    fireEvent.change(modelSelect, { target: { value: 'ollama:translategemma:12b' } });

    const textarea = screen.getByPlaceholderText(/在此输入或粘贴需要翻译的文本/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Hello world' } });

    const translateBtn = screen.getByRole('button', { name: /立即翻译/i });
    fireEvent.click(translateBtn);

    await waitFor(() => {
      expect(mocks.ollamaInit).toHaveBeenCalledWith('auto', 'zh', 'ollama:translategemma:12b');
      expect(mocks.ollamaTranslate).toHaveBeenCalledWith('Hello world', expect.any(String), false);
    });
  });
});
