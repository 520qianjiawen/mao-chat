import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import QuickTranslateWindow from './QuickTranslateWindow';

const mocks = vi.hoisted(() => ({
  nativeTranslateInit: vi.fn().mockResolvedValue(undefined),
  nativeTranslate: vi.fn().mockResolvedValue({
    sourceText: 'Hello',
    translatedText: '你好',
    inferenceTimeMs: 40,
  }),
  nativeDispose: vi.fn(),
}));

vi.mock('../../stores/settingsStore', () => ({
  useLocalNativeSettings: () => ({
    translationVariantByModel: {},
    deeplApiKey: '',
    translationDevice: 'cpu',
  }),
}));

vi.mock('../../stores/nativeModelStore', () => ({
  useNativeCatalog: () => [
    {
      id: 'bing-translator',
      name: 'Bing Translator',
      kind: 'translate',
    },
  ],
  useNativeModelStatuses: () => ({
    'bing-translator': { status: 'ready' },
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
      init = mocks.nativeTranslateInit;
      translate = mocks.nativeTranslate;
      dispose = mocks.nativeDispose;
    },
  };
});

vi.mock('../../lib/ollama-translator', () => {
  return {
    fetchOllamaModels: vi.fn().mockResolvedValue([
      { name: 'translategemma:12b', model: 'translategemma:12b', size: 8109827612 },
    ]),
    OllamaTranslatorClient: class {
      init = mocks.nativeTranslateInit;
      translate = mocks.nativeTranslate;
      dispose = mocks.nativeDispose;
    },
  };
});

describe('QuickTranslateWindow', () => {
  let listeners: Record<string, Function[]> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    listeners = {};

    (window as any).electron = {
      invoke: vi.fn().mockImplementation((channel: string, data?: any) => {
        if (channel === 'quick-translate:ocr-screenshot') {
          return Promise.resolve({ ok: true, text: 'Captured from screen' });
        }
        if (channel === 'quick-translate:capture-selection') {
          return Promise.resolve({ ok: true, text: 'Captured from selection' });
        }
        return Promise.resolve({ ok: true });
      }),
      receive: vi.fn().mockImplementation((channel: string, cb: Function) => {
        listeners[channel] = listeners[channel] || [];
        listeners[channel].push(cb);
      }),
      removeListener: vi.fn().mockImplementation((channel: string, cb: Function) => {
        if (listeners[channel]) {
          listeners[channel] = listeners[channel].filter((f) => f !== cb);
        }
      }),
    };

    Object.assign(navigator, {
      clipboard: {
        readText: vi.fn().mockResolvedValue('Clipboard content'),
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders title, buttons, and input areas', () => {
    render(<QuickTranslateWindow />);
    expect(screen.getByText(/划词与截图翻译/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/划选文字或按 ⌃Z 截图/i)).toBeInTheDocument();
    expect(screen.getByTitle(/截图翻译/i)).toBeInTheDocument();
    expect(screen.getByTitle(/划词翻译/i)).toBeInTheDocument();
  });

  it('receives quick-translate:payload event and translates automatically', async () => {
    render(<QuickTranslateWindow />);

    // Simulate main process sending payload
    const payloadHandler = listeners['quick-translate:payload']?.[0];
    expect(payloadHandler).toBeDefined();

    payloadHandler({ text: 'Hello', source: 'selection' });

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(/划选文字或按 ⌃Z 截图/i) as HTMLTextAreaElement;
      expect(textarea.value).toBe('Hello');
      expect(screen.getByText('你好')).toBeInTheDocument();
    });
  });

  it('invokes screenshot OCR when camera button is clicked', async () => {
    render(<QuickTranslateWindow />);
    const ocrBtn = screen.getByTitle(/截图翻译/i);
    fireEvent.click(ocrBtn);

    await waitFor(() => {
      expect(window.electron.invoke).toHaveBeenCalledWith('quick-translate:ocr-screenshot');
      const textarea = screen.getByPlaceholderText(/划选文字或按 ⌃Z 截图/i) as HTMLTextAreaElement;
      expect(textarea.value).toBe('Captured from screen');
    });
  });

  it('invokes selection capture when selection button is clicked', async () => {
    render(<QuickTranslateWindow />);
    const selectBtn = screen.getByTitle(/划词翻译/i);
    fireEvent.click(selectBtn);

    await waitFor(() => {
      expect(window.electron.invoke).toHaveBeenCalledWith('quick-translate:capture-selection');
      const textarea = screen.getByPlaceholderText(/划选文字或按 ⌃Z 截图/i) as HTMLTextAreaElement;
      expect(textarea.value).toBe('Captured from selection');
    });
  });

  it('toggles pin state when pin button clicked', async () => {
    render(<QuickTranslateWindow />);
    const pinBtn = screen.getByTitle(/固定窗口/i);
    fireEvent.click(pinBtn);

    await waitFor(() => {
      expect(window.electron.invoke).toHaveBeenCalledWith('quick-translate:set-pinned', true);
    });
  });

  it('closes when close button is clicked or ESC is pressed', async () => {
    render(<QuickTranslateWindow />);
    const closeBtn = screen.getByTitle(/关闭/i);
    fireEvent.click(closeBtn);

    expect(window.electron.invoke).toHaveBeenCalledWith('quick-translate:close');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(window.electron.invoke).toHaveBeenCalledWith('quick-translate:close');
  });

  it('invokes quick-translate:open-main when open in main button is clicked', async () => {
    render(<QuickTranslateWindow />);
    const openMainBtn = screen.getByTitle(/在主窗口打开/i);
    fireEvent.click(openMainBtn);

    expect(window.electron.invoke).toHaveBeenCalledWith(
      'quick-translate:open-main',
      expect.objectContaining({
        text: '',
        translatedText: '',
      }),
    );
  });

  it('pulls initial payload on mount via quick-translate:get-payload', async () => {
    (window.electron.invoke as any).mockImplementation((channel: string) => {
      if (channel === 'quick-translate:get-payload') {
        return Promise.resolve({ text: 'Mounted initial text', source: 'selection' });
      }
      return Promise.resolve({ ok: true });
    });

    render(<QuickTranslateWindow />);

    await waitFor(() => {
      expect(window.electron.invoke).toHaveBeenCalledWith('quick-translate:get-payload');
      const textarea = screen.getByPlaceholderText(/划选文字或按 ⌃Z 截图/i) as HTMLTextAreaElement;
      expect(textarea.value).toBe('Mounted initial text');
    });
  });

  it('closes on window blur (clicking outside) when unpinned', async () => {
    (window.electron.invoke as any).mockResolvedValue({ ok: true });
    render(<QuickTranslateWindow />);

    fireEvent.blur(window);
    expect(window.electron.invoke).toHaveBeenCalledWith('quick-translate:close');
  });

  it('does not close on window blur when pinned', async () => {
    (window.electron.invoke as any).mockResolvedValue({ ok: true });
    render(<QuickTranslateWindow />);

    // Click pin button to pin the window
    const pinBtn = screen.getByTitle(/固定窗口/i);
    fireEvent.click(pinBtn);

    // Reset invoke history
    (window.electron.invoke as any).mockClear();

    // Trigger blur
    fireEvent.blur(window);

    // Should NOT close because it is pinned
    expect(window.electron.invoke).not.toHaveBeenCalledWith('quick-translate:close');
  });

  it('automatically sets target to English when typing Chinese in the input box', async () => {
    render(<QuickTranslateWindow />);
    const textarea = screen.getByPlaceholderText(/划选文字或按 ⌃Z 截图/i) as HTMLTextAreaElement;

    // Type Chinese into textarea
    fireEvent.change(textarea, { target: { value: '土耳其iCloud+ 2TB多少钱' } });

    await waitFor(() => {
      const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
      const targetSelect = selects[1];
      expect(targetSelect.value).toBe('en');
      expect(mocks.nativeTranslateInit).toHaveBeenCalledWith(
        'auto',
        'en',
        'bing-translator',
        expect.anything(),
      );
    });
  });

  it('preserves manually chosen target language when typing unless there is an identical language conflict', async () => {
    render(<QuickTranslateWindow />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const targetSelect = selects[1];

    // User manually chooses Japanese
    fireEvent.change(targetSelect, { target: { value: 'ja' } });
    expect(targetSelect.value).toBe('ja');

    // Type Chinese
    const textarea = screen.getByPlaceholderText(/划选文字或按 ⌃Z 截图/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '你好世界' } });

    await waitFor(() => {
      expect(targetSelect.value).toBe('ja');
      expect(mocks.nativeTranslateInit).toHaveBeenCalledWith(
        'auto',
        'ja',
        'bing-translator',
        expect.anything(),
      );
    });
  });

  it('auto-resolves conflict to en when target was manually set to zh and Chinese is entered', async () => {
    render(<QuickTranslateWindow />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const targetSelect = selects[1];

    // User explicitly selects Chinese as target
    fireEvent.change(targetSelect, { target: { value: 'zh' } });
    expect(targetSelect.value).toBe('zh');

    // Type Chinese: conflict should auto-resolve to 'en'
    const textarea = screen.getByPlaceholderText(/划选文字或按 ⌃Z 截图/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '测试冲突自动解决' } });

    await waitFor(() => {
      expect(targetSelect.value).toBe('en');
      expect(mocks.nativeTranslateInit).toHaveBeenCalledWith(
        'auto',
        'en',
        'bing-translator',
        expect.anything(),
      );
    });
  });

  it('automatically sets target to Chinese when typing English in the input box', async () => {
    render(<QuickTranslateWindow />);
    const textarea = screen.getByPlaceholderText(/划选文字或按 ⌃Z 截图/i) as HTMLTextAreaElement;

    // Type English into textarea
    fireEvent.change(textarea, { target: { value: 'How much does iCloud cost?' } });

    await waitFor(() => {
      const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
      const targetSelect = selects[1];
      expect(targetSelect.value).toBe('zh');
      expect(mocks.nativeTranslateInit).toHaveBeenCalledWith(
        'auto',
        'zh',
        'bing-translator',
        expect.anything(),
      );
    });
  });
});



