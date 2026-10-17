import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  AudioLines,
  Camera,
  Check,
  Clipboard,
  Languages,
  Loader2,
  MousePointerClick,
  Settings2,
  Trash2,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NativeTranslateClient } from '../../lib/local-inference/native/NativeTranslateClient';
import { TranslationEngine } from '../../lib/local-inference/engine/TranslationEngine';
import { OllamaTranslatorClient, fetchOllamaModels, type OllamaModelItem } from '../../lib/ollama-translator';
import {
  isNativeOnlineTranslation,
  isOllamaTranslation,
  resolveNativeTranslation,
} from '../../lib/local-inference/native/nativeCatalog';
import {
  useNativeCatalog,
  useNativeModelStatuses,
} from '../../stores/nativeModelStore';
import { useLocalNativeSettings } from '../../stores/settingsStore';
import { LANGUAGE_OPTIONS, getLanguageDisplayName } from '../../utils/languages';
import './TextTranslationView.scss';

interface TextTranslationViewProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
  onSendToTextToSpeech?: (text: string, language?: string) => void;
}

interface LiveTranslationClient {
  key: string;
  client: NativeTranslateClient | TranslationEngine | OllamaTranslatorClient;
}

interface SentenceRange {
  text: string;
  start: number;
  end: number;
}

// Popular languages prioritized in the dropdown
const POPULAR_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'it', 'pt'];

/**
 * Detect whether input is Chinese or other language.
 * Japanese Kana and Korean Hangul are categorized as 'other' so they target Chinese.
 */
export function detectLanguageGroup(text: string): 'zh' | 'other' {
  if (!text || !text.trim()) return 'zh';
  // Check if text has Japanese Kana (Hiragana or Katakana)
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
    return 'other';
  }
  // Check if text has Korean Hangul
  if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) {
    return 'other';
  }
  // Check if text has Chinese Hanzi
  if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) {
    return 'zh';
  }
  return 'other';
}

/**
 * Extract sentence ranges with exact character offsets for highlight alignment
 */
export function getSentenceRanges(fullText: string, locale: string): SentenceRange[] {
  if (!fullText || !fullText.trim()) return [];
  const ranges: SentenceRange[] = [];

  try {
    const bcpLocale = locale === 'auto' || locale === 'zh' ? 'zh-CN' : locale;
    const segmenter = new Intl.Segmenter(bcpLocale, { granularity: 'sentence' });
    for (const seg of segmenter.segment(fullText)) {
      const trimmed = seg.segment.trim();
      if (trimmed.length > 0) {
        const leadWs = seg.segment.length - seg.segment.trimStart().length;
        const start = seg.index + leadWs;
        const end = start + trimmed.length;
        ranges.push({ text: trimmed, start, end });
      }
    }
  } catch {
    const regex = /[^.!?。！？\n]+[.!?。！？\n]*/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(fullText)) !== null) {
      const trimmed = match[0].trim();
      if (trimmed.length > 0) {
        const leadWs = match[0].length - match[0].trimStart().length;
        const start = match.index + leadWs;
        const end = start + trimmed.length;
        ranges.push({ text: trimmed, start, end });
      }
    }
  }

  if (ranges.length === 0 && fullText.trim().length > 0) {
    const leadWs = fullText.length - fullText.trimStart().length;
    ranges.push({
      text: fullText.trim(),
      start: leadWs,
      end: leadWs + fullText.trim().length,
    });
  }

  return ranges;
}

/**
 * Map index between source and target sentence arrays
 */
export function mapSentenceIndex(idx: number, fromTotal: number, toTotal: number): number {
  if (fromTotal <= 0 || toTotal <= 0) return 0;
  if (fromTotal === toTotal) return idx;
  const ratio = idx / fromTotal;
  return Math.min(toTotal - 1, Math.floor(ratio * toTotal));
}

/**
 * Translate text preserving exact newline and paragraph structure, URLs, and symbols
 */
export async function translateWithPreservedFormatting(
  translateFn: (chunk: string) => Promise<string>,
  fullText: string,
): Promise<string> {
  if (!fullText.includes('\n')) {
    return translateFn(fullText);
  }

  const parts = fullText.split(/(\n+)/);

  const translatedParts = await Promise.all(
    parts.map(async (part, idx) => {
      // If it's a newline sequence (odd index), preserve as-is
      if (idx % 2 === 1) {
        return part;
      }

      const trimmed = part.trim();
      if (!trimmed) {
        return part;
      }

      // Preserve standalone URLs without translation
      if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
        return part;
      }

      // Preserve pure divider / structural symbols (e.g. |, ---, ***, ===, etc.)
      if (/^[|\-=_~*#/\\]+$/.test(trimmed) && trimmed.length <= 5) {
        return part;
      }

      try {
        const translated = await translateFn(trimmed);
        const leadWs = part.slice(0, part.length - part.trimStart().length);
        const trailWs = part.slice(part.trimEnd().length);
        return `${leadWs}${translated}${trailWs}`;
      } catch {
        return part;
      }
    }),
  );

  return translatedParts.join('');
}

export const TextTranslationView: React.FC<TextTranslationViewProps> = ({
  isOpen,
  onClose,
  onOpenSettings,
  onSendToTextToSpeech,
}) => {
  const { t } = useTranslation();
  const settings = useLocalNativeSettings();
  const catalog = useNativeCatalog();
  const statuses = useNativeModelStatuses();

  // Selected languages
  const [sourceLang, setSourceLang] = useState<string>('auto');
  const [targetLang, setTargetLang] = useState<string>(() => {
    return settings.targetLanguage && settings.targetLanguage !== 'auto'
      ? settings.targetLanguage
      : 'zh';
  });

  const userManuallyPickedTarget = useRef(false);

  const [ollamaModels, setOllamaModels] = useState<OllamaModelItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchOllamaModels().then((models) => {
      if (!cancelled && models.length > 0) {
        setOllamaModels(models);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Available models list (online + Ollama local + downloaded native models)
  const availableModels = useMemo(() => {
    const list: { id: string; name: string; isOnline: boolean; isReady: boolean }[] = [];

    // Online models (always available)
    list.push(
      { id: 'bing-translator', name: 'Bing Translator (在线 · 无需下载)', isOnline: true, isReady: true },
      { id: 'google-translator', name: 'Google Translator (在线 · 无需下载)', isOnline: true, isReady: true },
      { id: 'deepl-translator', name: 'DeepL Translator (在线 · API)', isOnline: true, isReady: true },
    );

    // Ollama local models
    for (const om of ollamaModels) {
      list.push({
        id: `ollama:${om.name}`,
        name: `${om.name} (Ollama · 本地无需下载)`,
        isOnline: false,
        isReady: true,
      });
    }

    // Local native models from catalog
    for (const [id, info] of Object.entries(catalog)) {
      if (info.kind !== 'translate') continue;
      const isReady = statuses[id] === 'ready';
      list.push({
        id,
        name: `${info.name}${isReady ? ' (已下载 · 本地)' : ' (本地)'}`,
        isOnline: false,
        isReady,
      });
    }

    return list;
  }, [catalog, statuses, ollamaModels]);

  // Selected model (default to online translator or downloaded local model)
  const defaultModelId = useMemo(() => {
    const configured = resolveNativeTranslation(settings.translationModel);
    if (configured) {
      if (isNativeOnlineTranslation(configured) || isOllamaTranslation(configured)) return configured;
      if (statuses[configured] === 'ready') return configured;
    }
    // Check if any local model in catalog is downloaded and ready
    for (const [id, info] of Object.entries(catalog)) {
      if (info.kind === 'translate' && statuses[id] === 'ready') {
        return id;
      }
    }
    return 'bing-translator';
  }, [settings.translationModel, statuses, catalog]);

  const [selectedModelId, setSelectedModelId] = useState<string>(defaultModelId);

  // If the currently selected model is an un-downloaded local model or not in available list, fallback cleanly to defaultModelId
  useEffect(() => {
    const isReadyOrOnline = isNativeOnlineTranslation(selectedModelId)
      || isOllamaTranslation(selectedModelId)
      || statuses[selectedModelId] === 'ready';
    const isInList = availableModels.some((m) => m.id === selectedModelId);
    if (!isReadyOrOnline || !isInList) {
      setSelectedModelId(defaultModelId);
    }
  }, [defaultModelId, selectedModelId, statuses, availableModels]);

  // Text inputs & outputs
  const [sourceText, setSourceText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationTimeMs, setTranslationTimeMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isCapturingOcr, setIsCapturingOcr] = useState(false);

  // Bilingual synchronized sentence highlighting
  const [activeSentence, setActiveSentence] = useState<{ srcIdx: number | null; tgtIdx: number | null }>({
    srcIdx: null,
    tgtIdx: null,
  });

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const targetResultRef = useRef<HTMLDivElement | null>(null);

  const clientRef = useRef<LiveTranslationClient | null>(null);
  const runRef = useRef(0);

  // Sentence ranges
  const sourceRanges = useMemo(() => getSentenceRanges(sourceText, sourceLang), [sourceText, sourceLang]);
  const targetRanges = useMemo(() => getSentenceRanges(translatedText, targetLang), [translatedText, targetLang]);

  // Clean speech synthesis & debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (clientRef.current) {
        try {
          (clientRef.current.client as any).dispose?.();
        } catch {
          // ignore
        }
        clientRef.current = null;
      }
    };
  }, []);

  // Track last executed translation parameters to prevent redundant calls
  const lastTranslatedRef = useRef<{ text: string; src: string; tgt: string; model: string } | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstMount = useRef(true);
  const prevLangRef = useRef({ sourceLang, targetLang, selectedModelId });

  // Intelligent default target language based on input language:
  // If Chinese input -> default target is English ('en')
  // If non-Chinese input -> default target is Chinese ('zh')
  useEffect(() => {
    const trimmed = sourceText.trim();
    if (!trimmed || sourceLang !== 'auto') return;

    const group = detectLanguageGroup(trimmed);
    const expectedTarget = group === 'zh' ? 'en' : 'zh';

    if (!userManuallyPickedTarget.current) {
      if (targetLang !== expectedTarget) {
        setTargetLang(expectedTarget);
      }
    } else if (group === 'zh' && targetLang === 'zh') {
      // Auto-fix conflict if Chinese is entered while target is also Chinese
      setTargetLang('en');
    }
  }, [sourceText, sourceLang, targetLang]);

  // Execute translation
  const handleTranslate = useCallback(async (
    textOverride?: string,
    srcLangOverride?: string,
    tgtLangOverride?: string,
    modelOverride?: string,
  ) => {
    const value = (textOverride !== undefined ? textOverride : sourceText).trim();
    if (!value) {
      setTranslatedText('');
      setError(null);
      setTranslationTimeMs(null);
      setIsTranslating(false);
      lastTranslatedRef.current = null;
      return;
    }

    const curSourceLang = srcLangOverride ?? sourceLang;
    const curTargetLang = tgtLangOverride ?? targetLang;
    const curModelId = modelOverride ?? selectedModelId;

    lastTranslatedRef.current = {
      text: value,
      src: curSourceLang,
      tgt: curTargetLang,
      model: curModelId,
    };

    setIsTranslating(true);
    setError(null);
    const run = ++runRef.current;
    const t0 = performance.now();

    try {
      const isOnline = isNativeOnlineTranslation(curModelId);
      const variant = settings.translationVariantByModel[curModelId];
      const clientKey = `${curModelId}:${curSourceLang}:${curTargetLang}:${variant || ''}`;

      let clientInstance = clientRef.current;
      if (!clientInstance || clientInstance.key !== clientKey) {
        if (clientInstance) {
          try {
            (clientInstance.client as any).dispose?.();
          } catch {
            // ignore
          }
        }

        if (isOnline) {
          const client = new TranslationEngine();
          await client.init(curSourceLang, curTargetLang, curModelId, {
            apiKey: settings.deeplApiKey,
          });
          clientInstance = { key: clientKey, client };
        } else if (isOllamaTranslation(curModelId)) {
          const client = new OllamaTranslatorClient();
          await client.init(curSourceLang, curTargetLang, curModelId);
          clientInstance = { key: clientKey, client };
        } else {
          const client = new NativeTranslateClient();
          await client.init(
            curSourceLang === 'auto' ? '' : curSourceLang,
            curTargetLang,
            curModelId,
            settings.translationDevice,
            null,
            null,
            variant,
          );
          clientInstance = { key: clientKey, client };
        }
        clientRef.current = clientInstance;
      }

      // Build clean system prompt for text/article translation
      const srcDisplay = curSourceLang === 'auto' ? 'the source language' : (LANGUAGE_OPTIONS[curSourceLang]?.englishName || curSourceLang);
      const tgtDisplay = LANGUAGE_OPTIONS[curTargetLang]?.englishName || curTargetLang;
      const textPrompt = `You are a professional translator. Translate the text from ${srcDisplay} to ${tgtDisplay} accurately and fluently. Preserve all formatting, line breaks, and nuances. Output ONLY the translation. No explanations, notes, or commentary.`;

      const translateSingleChunk = async (chunk: string): Promise<string> => {
        const r = await clientInstance!.client.translate(
          chunk,
          isOnline ? '' : textPrompt,
          !isOnline && !isOllamaTranslation(curModelId),
        );
        return (r.translatedText || '').trim();
      };

      const output = await translateWithPreservedFormatting(translateSingleChunk, value);

      if (runRef.current !== run) return;

      setTranslatedText(output.trim());
      setTranslationTimeMs(Math.round(performance.now() - t0));
    } catch (err) {
      if (runRef.current !== run) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      if (runRef.current === run) {
        setIsTranslating(false);
      }
    }
  }, [
    sourceText,
    sourceLang,
    targetLang,
    selectedModelId,
    settings.translationVariantByModel,
    settings.deeplApiKey,
    settings.translationDevice,
  ]);

  const handleTranslateRef = useRef(handleTranslate);
  useEffect(() => {
    handleTranslateRef.current = handleTranslate;
  }, [handleTranslate]);

  // Auto-translate on input (debounced 500ms) or language/model switch (immediate 50ms)
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const trimmed = sourceText.trim();
    if (!trimmed) {
      setTranslatedText('');
      setError(null);
      setTranslationTimeMs(null);
      setIsTranslating(false);
      lastTranslatedRef.current = null;
      prevLangRef.current = { sourceLang, targetLang, selectedModelId };
      return;
    }

    const isSameAsLast =
      lastTranslatedRef.current &&
      lastTranslatedRef.current.text === trimmed &&
      lastTranslatedRef.current.src === sourceLang &&
      lastTranslatedRef.current.tgt === targetLang &&
      lastTranslatedRef.current.model === selectedModelId;

    if (isSameAsLast) {
      prevLangRef.current = { sourceLang, targetLang, selectedModelId };
      return;
    }

    const langOrModelChanged =
      sourceLang !== prevLangRef.current.sourceLang ||
      targetLang !== prevLangRef.current.targetLang ||
      selectedModelId !== prevLangRef.current.selectedModelId;

    prevLangRef.current = { sourceLang, targetLang, selectedModelId };

    // If language or model changed: start translation immediately (50ms)
    // If text was typed: debounce 500ms
    const delay = langOrModelChanged ? 50 : 500;

    debounceTimerRef.current = setTimeout(() => {
      void handleTranslateRef.current(trimmed, sourceLang, targetLang, selectedModelId);
    }, delay);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [sourceText, sourceLang, targetLang, selectedModelId]);

  // Manual instant translate
  const onManualTranslate = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    void handleTranslate();
  }, [handleTranslate]);

  // One-click Paste
  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setSourceText(text);
        setError(null);
        textareaRef.current?.focus();
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        void handleTranslate(text);
      }
    } catch {
      textareaRef.current?.focus();
    }
  }, [handleTranslate]);

  // Trigger Screenshot OCR Translation (⌃Z)
  const handleScreenshotOcr = useCallback(async () => {
    if (!window.electron?.invoke) return;
    setIsCapturingOcr(true);
    setError(null);
    try {
      const res = await window.electron.invoke('quick-translate:ocr-screenshot');
      if (res?.ok && res.text) {
        setSourceText(res.text);
        setError(null);
        if (!userManuallyPickedTarget.current) {
          const detected = detectLanguageGroup(res.text);
          setTargetLang(detected === 'zh' ? 'en' : 'zh');
        }
        void handleTranslate(res.text);
      } else if (res?.error === 'permission_denied' || res?.permission === 'screen') {
        setError(t('textTranslation.screenPermissionRequired', '截图翻译需要「屏幕与系统音频录制」权限，请在 macOS 系统设置中授权'));
      } else if (res?.ok && !res.text && !res?.cancelled) {
        setError(t('textTranslation.noTextDetected', '未在截图区域中检测到文字，请重新框选。若截图中包含文字，请检查是否已在「系统设置 > 隐私与安全性 > 屏幕与系统音频录制」中授予 MAO Chat 权限。'));
      }
    } catch (e: any) {
      setError(e?.message || '截图识别失败');
    } finally {
      setIsCapturingOcr(false);
    }
  }, [handleTranslate, t]);

  // Trigger Selection/Clipboard Translation (⌃Q)
  const handleSelectionCapture = useCallback(async () => {
    if (!window.electron?.invoke) return;
    setError(null);
    try {
      const res = await window.electron.invoke('quick-translate:capture-selection');
      if (res?.ok && res.text) {
        setSourceText(res.text);
        setError(null);
        if (!userManuallyPickedTarget.current) {
          const detected = detectLanguageGroup(res.text);
          setTargetLang(detected === 'zh' ? 'en' : 'zh');
        }
        void handleTranslate(res.text);
      } else if (res?.ok && !res.text) {
        setError(t('textTranslation.noSelectionDetected', '未检测到划选文字。您可以选中文本后按 ⌘C 复制，或检查「系统设置 > 隐私与安全性 > 辅助功能」中是否已允许 MAO Chat。'));
      }
    } catch (e: any) {
      setError(e?.message || '划词获取失败');
    }
  }, [handleTranslate, t]);

  // Listen for open-in-main from floating quick translate window
  useEffect(() => {
    if (!window.electron?.receive) return;
    const onOpenInMain = (payload: any) => {
      if (payload?.text) {
        setSourceText(payload.text);
        if (payload.targetLang) {
          userManuallyPickedTarget.current = true;
          setTargetLang(payload.targetLang);
        }
        if (payload.sourceLang) setSourceLang(payload.sourceLang);
        if (payload.translatedText) {
          setTranslatedText(payload.translatedText);
        } else {
          void handleTranslate(payload.text, payload.sourceLang, payload.targetLang);
        }
      }
    };
    window.electron.receive('quick-translate:open-in-main', onOpenInMain);
    return () => {
      window.electron?.removeListener?.('quick-translate:open-in-main', onOpenInMain);
    };
  }, [handleTranslate]);

  // One-click Copy
  const handleCopy = useCallback(async () => {
    if (!translatedText) return;
    try {
      await navigator.clipboard.writeText(translatedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }, [translatedText]);

  // One-click Clear
  const handleClear = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    lastTranslatedRef.current = null;
    userManuallyPickedTarget.current = false;
    setSourceText('');
    setTranslatedText('');
    setError(null);
    setTranslationTimeMs(null);
    setIsTranslating(false);
    setActiveSentence({ srcIdx: null, tgtIdx: null });
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
    textareaRef.current?.focus();
  }, []);

  // Language Swap
  const handleSwap = useCallback(() => {
    if (sourceLang === 'auto') return;
    const oldSource = sourceLang;
    const oldTarget = targetLang;
    const oldSrcText = sourceText;
    const oldTrText = translatedText;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    userManuallyPickedTarget.current = true;
    setSourceLang(oldTarget);
    setTargetLang(oldSource);
    setSourceText(oldTrText);
    setTranslatedText('');
    setError(null);
    setActiveSentence({ srcIdx: null, tgtIdx: null });

    if (oldTrText.trim()) {
      void handleTranslate(oldTrText, oldTarget, oldSource);
    }
  }, [sourceLang, targetLang, sourceText, translatedText, handleTranslate]);

  // Read aloud (TTS) using native OS speech synthesis
  const handleSpeak = useCallback(() => {
    if (!translatedText || !('speechSynthesis' in window)) return;

    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(translatedText);
    utterance.lang = targetLang === 'zh' ? 'zh-CN' : targetLang;
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }, [translatedText, isSpeaking, targetLang]);

  // Handle keyboard shortcut: Cmd+Enter / Ctrl+Enter
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        onManualTranslate();
      }
    },
    [onManualTranslate],
  );

  // Synchronous highlighting handlers
  const handleSourceScroll = useCallback(() => {
    if (textareaRef.current && backdropRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
      backdropRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  const handleSourceSelect = useCallback(() => {
    if (!textareaRef.current || sourceRanges.length === 0) return;
    const pos = textareaRef.current.selectionStart;
    const foundIdx = sourceRanges.findIndex((r) => pos >= r.start && pos <= r.end);
    if (foundIdx !== -1) {
      const tgtIdx = targetRanges.length > 0 ? mapSentenceIndex(foundIdx, sourceRanges.length, targetRanges.length) : null;
      setActiveSentence({ srcIdx: foundIdx, tgtIdx });
    }
  }, [sourceRanges, targetRanges.length]);

  const handleTargetSentenceHover = useCallback((tgtIdx: number) => {
    const srcIdx = sourceRanges.length > 0 ? mapSentenceIndex(tgtIdx, targetRanges.length, sourceRanges.length) : null;
    setActiveSentence({ srcIdx, tgtIdx });
  }, [sourceRanges.length, targetRanges.length]);

  const handleTargetSentenceClick = useCallback((tgtIdx: number) => {
    const srcIdx = sourceRanges.length > 0 ? mapSentenceIndex(tgtIdx, targetRanges.length, sourceRanges.length) : null;
    setActiveSentence({ srcIdx, tgtIdx });
    if (srcIdx !== null && sourceRanges[srcIdx] && textareaRef.current) {
      const start = sourceRanges[srcIdx].start;
      const end = sourceRanges[srcIdx].end;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(start, end);
    }
  }, [sourceRanges, targetRanges.length]);

  const handleTargetMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !targetResultRef.current) return;
    const anchor = selection.anchorNode;
    if (anchor && targetResultRef.current.contains(anchor)) {
      const el = anchor.parentElement?.closest('[data-sentence-index]');
      if (el) {
        const idx = parseInt(el.getAttribute('data-sentence-index') || '-1', 10);
        if (idx >= 0) {
          const srcIdx = sourceRanges.length > 0 ? mapSentenceIndex(idx, targetRanges.length, sourceRanges.length) : null;
          setActiveSentence({ srcIdx, tgtIdx: idx });
        }
      }
    }
  }, [sourceRanges.length, targetRanges.length]);

  const handleSentenceLeave = useCallback(() => {
    // Only clear on hover out if there is no active text selection in progress
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setActiveSentence({ srcIdx: null, tgtIdx: null });
    }
  }, []);

  // Render highlighted backdrop underneath the source textarea
  const renderSourceBackdrop = () => {
    if (!sourceText) return null;
    if (activeSentence.srcIdx === null || !sourceRanges[activeSentence.srcIdx]) {
      return <span>{sourceText}</span>;
    }
    const r = sourceRanges[activeSentence.srcIdx];
    const before = sourceText.slice(0, r.start);
    const highlighted = sourceText.slice(r.start, r.end);
    const after = sourceText.slice(r.end);

    return (
      <span>
        {before}
        <mark className="sync-highlight">{highlighted}</mark>
        {after}
      </span>
    );
  };

  // Render target translation preserving exact newlines and paragraphs
  const renderTargetContent = () => {
    if (!translatedText) return null;
    if (targetRanges.length === 0) {
      return <span>{translatedText}</span>;
    }

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;

    targetRanges.forEach((range, idx) => {
      // Preserve any whitespace/newlines before this sentence
      if (range.start > lastIndex) {
        elements.push(translatedText.slice(lastIndex, range.start));
      }

      const isHighlighted = activeSentence.tgtIdx === idx;
      elements.push(
        <span
          key={idx}
          data-sentence-index={idx}
          className={`sync-sentence ${isHighlighted ? 'is-highlighted' : ''}`}
          onClick={() => handleTargetSentenceClick(idx)}
          onMouseEnter={() => handleTargetSentenceHover(idx)}
          onMouseLeave={handleSentenceLeave}
          title="点击或悬停可与左侧原文双向高亮对应"
        >
          {range.text}
        </span>,
      );

      lastIndex = range.end;
    });

    // Any trailing whitespace/newlines
    if (lastIndex < translatedText.length) {
      elements.push(translatedText.slice(lastIndex));
    }

    return elements;
  };

  // Compute stats
  const charCount = sourceText.length;
  const wordCount = sourceText.trim() ? sourceText.trim().split(/\s+/).length : 0;
  const targetCharCount = translatedText.length;

  if (!isOpen) return null;

  return (
    <div className="text-translation-view" role="region" aria-label={t('textTranslation.title', '文本翻译')}>
      {/* Header Bar */}
      <div className="text-translation-view__header">
        <div className="text-translation-view__title">
          <div className="text-translation-view__title-icon">
            <Languages size={18} />
          </div>
          <h2>{t('textTranslation.title', '文本翻译')}</h2>

          {/* Model Switcher Dropdown */}
          <div className="text-translation-view__model-selector">
            <select
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              title={t('textTranslation.model', '翻译模型')}
              aria-label={t('textTranslation.model', '翻译模型')}
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="text-translation-view__header-actions">
          {onOpenSettings && (
            <button
              type="button"
              className="text-translation-view__icon-btn"
              onClick={onOpenSettings}
              title={t('settings.title', '设置')}
              aria-label={t('settings.title', '设置')}
            >
              <Settings2 size={16} />
            </button>
          )}
          <button
            type="button"
            className="text-translation-view__icon-btn"
            onClick={onClose}
            title={t('common.close', '关闭')}
            aria-label={t('common.close', '关闭')}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Language Bar */}
      <div className="text-translation-view__language-bar">
        <div className="language-selector-group">
          {/* Source Language */}
          <div className="language-select-wrapper">
            <select
              className="language-select"
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
              aria-label="源语言"
            >
              <option value="auto">🌐 {t('common.autoDetect', '自动检测 (Auto)')}</option>
              {POPULAR_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {getLanguageDisplayName(code)}
                </option>
              ))}
              {Object.keys(LANGUAGE_OPTIONS)
                .filter((code) => code !== 'auto' && !POPULAR_LANGUAGES.includes(code))
                .sort((a, b) => (LANGUAGE_OPTIONS[a]?.name || a).localeCompare(LANGUAGE_OPTIONS[b]?.name || b))
                .map((code) => (
                  <option key={code} value={code}>
                    {getLanguageDisplayName(code)}
                  </option>
                ))}
            </select>
          </div>

          {/* Swap Button */}
          <button
            type="button"
            className={`swap-btn ${sourceLang === 'auto' ? 'disabled' : ''}`}
            onClick={handleSwap}
            disabled={sourceLang === 'auto'}
            title={
              sourceLang === 'auto'
                ? t('textTranslation.swapDisabled', '自动检测模式下无法互换语言')
                : t('textTranslation.swap', '互换语言')
            }
            aria-label={t('textTranslation.swap', '互换语言')}
          >
            <ArrowLeftRight size={15} />
          </button>

          {/* Target Language */}
          <div className="language-select-wrapper">
            <select
              className="language-select"
              value={targetLang}
              onChange={(e) => {
                userManuallyPickedTarget.current = true;
                setTargetLang(e.target.value);
              }}
              aria-label="目标语言"
            >
              {POPULAR_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {getLanguageDisplayName(code)}
                </option>
              ))}
              {Object.keys(LANGUAGE_OPTIONS)
                .filter((code) => code !== 'auto' && !POPULAR_LANGUAGES.includes(code))
                .sort((a, b) => (LANGUAGE_OPTIONS[a]?.name || a).localeCompare(LANGUAGE_OPTIONS[b]?.name || b))
                .map((code) => (
                  <option key={code} value={code}>
                    {getLanguageDisplayName(code)}
                  </option>
                ))}
            </select>
          </div>
        </div>

        {/* Big Translate Action Button */}
        <button
          type="button"
          className={`translate-action-btn ${isTranslating ? 'is-loading' : ''}`}
          onClick={onManualTranslate}
          disabled={!sourceText.trim() || isTranslating}
          title="输入后或切换语言自动开始翻译，也可按 ⌘ + Enter 立即翻译"
        >
          {isTranslating ? (
            <>
              <Loader2 size={16} className="spin-icon" />
              <span>{t('textTranslation.translating', '正在翻译...')}</span>
            </>
          ) : (
            <>
              <Languages size={16} />
              <span>{t('textTranslation.translate', '立即翻译')}</span>
              <kbd className="shortcut-badge">⌘ ↵</kbd>
            </>
          )}
        </button>
      </div>

      {/* Dual Pane Translation Workspace */}
      <div className="text-translation-view__workspace">
        {/* Left: Source Input Card */}
        <div className="translation-card translation-card--source">
          <div className="translation-card__body">
            <div className="translation-input-wrapper">
              <div
                ref={backdropRef}
                className="translation-highlight-backdrop"
                aria-hidden="true"
              >
                {renderSourceBackdrop()}
              </div>
              <textarea
                ref={textareaRef}
                className="translation-textarea"
                placeholder={t('textTranslation.sourcePlaceholder', '在此输入或粘贴需要翻译的文本...（输入或切换语言自动翻译，也可按 ⌘ + Enter 立即翻译）')}
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                onSelect={handleSourceSelect}
                onClick={handleSourceSelect}
                onKeyUp={handleSourceSelect}
                onScroll={handleSourceScroll}
                onKeyDown={handleKeyDown}
                spellCheck={false}
              />
            </div>
          </div>

          {/* Source Toolbar */}
          <div className="translation-card__footer">
            <div className="card-actions-left">
              <button
                type="button"
                className={`action-btn action-btn--ocr ${isCapturingOcr ? 'is-loading' : ''}`}
                onClick={handleScreenshotOcr}
                disabled={isCapturingOcr}
                title={t('textTranslation.screenshotOcrTooltip', '截取屏幕任意区域并自动识别翻译 (⌃Z)')}
                aria-label={t('textTranslation.screenshotTranslate', '截图翻译')}
              >
                {isCapturingOcr ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
                <span>{t('textTranslation.screenshotTranslateShort', '截图')}</span>
                <kbd className="shortcut-badge">⌃Z</kbd>
              </button>

              <button
                type="button"
                className="action-btn"
                onClick={handleSelectionCapture}
                title={t('textTranslation.selectionTooltip', '读取当前选中文本并翻译 (⌃Q)')}
                aria-label={t('textTranslation.selectionTranslate', '划词翻译')}
              >
                <MousePointerClick size={14} />
                <span>{t('textTranslation.selectionTranslateShort', '划词')}</span>
                <kbd className="shortcut-badge">⌃Q</kbd>
              </button>

              <button
                type="button"
                className="action-btn"
                onClick={handlePaste}
                title={t('textTranslation.paste', '粘贴剪贴板文本并立即翻译')}
              >
                <Clipboard size={14} />
                <span>{t('textTranslation.paste', '粘贴')}</span>
              </button>

              <button
                type="button"
                className="action-btn action-btn--danger"
                onClick={handleClear}
                disabled={!sourceText}
                title={t('textTranslation.clear', '清空输入')}
              >
                <Trash2 size={14} />
                <span>{t('textTranslation.clear', '清空')}</span>
              </button>
            </div>

            <div className="card-actions-right">
              {charCount > 0 && (
                <span className="char-count">
                  {charCount} 字符 · {wordCount} 词
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right: Target Translation Card */}
        <div className="translation-card translation-card--target">
          <div className="translation-card__body">
            {isTranslating ? (
              <div className="translation-card__loading">
                <Loader2 size={24} className="spin-icon" />
                <p>{t('textTranslation.translating', '正在翻译中，请稍候...')}</p>
              </div>
            ) : error ? (
              <div className="translation-card__error">
                <p className="error-title">翻译遇到问题</p>
                <p className="error-detail">{error}</p>
                <button
                  type="button"
                  className="retry-btn"
                  onClick={onManualTranslate}
                >
                  重试
                </button>
              </div>
            ) : translatedText ? (
              <div
                ref={targetResultRef}
                className="translation-result-text"
                tabIndex={0}
                onMouseUp={handleTargetMouseUp}
              >
                {renderTargetContent()}
              </div>
            ) : (
              <div className="translation-card__placeholder">
                <p>{t('textTranslation.targetPlaceholder', '翻译结果将清晰展示在此处')}</p>
                <span className="sub-hint">支持大段文章、多语言自动检测与一键复制</span>
              </div>
            )}
          </div>

          {/* Target Toolbar */}
          <div className="translation-card__footer">
            <div className="card-actions-left">
              <button
                type="button"
                className={`action-btn action-btn--copy ${copied ? 'is-copied' : ''}`}
                onClick={handleCopy}
                disabled={!translatedText}
                title={t('textTranslation.copy', '复制翻译结果')}
              >
                {copied ? <Check size={14} /> : <Clipboard size={14} />}
                <span>{copied ? t('textTranslation.copied', '已复制!') : t('textTranslation.copy', '复制')}</span>
              </button>

              <button
                type="button"
                className={`action-btn ${isSpeaking ? 'is-active' : ''}`}
                onClick={handleSpeak}
                disabled={!translatedText}
                title={isSpeaking ? '停止朗读' : '朗读译文（macOS 系统语音）'}
              >
                {isSpeaking ? <VolumeX size={14} /> : <Volume2 size={14} />}
                <span>{isSpeaking ? '停止' : '朗读'}</span>
              </button>

              {onSendToTextToSpeech && (
                <button
                  type="button"
                  className="action-btn action-btn--tts"
                  onClick={() => onSendToTextToSpeech(translatedText, targetLang)}
                  disabled={!translatedText}
                  title="推送到文本转语音工具（使用神经网络大模型/自选声音合成）"
                >
                  <AudioLines size={14} />
                  <span>推送到语音</span>
                </button>
              )}
            </div>

            <div className="card-actions-right">
              {translationTimeMs !== null && (
                <span className="time-badge" title="模型推理耗时">
                  <Zap size={12} />
                  {translationTimeMs}ms
                </span>
              )}
              {targetCharCount > 0 && (
                <span className="char-count">{targetCharCount} 字符</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TextTranslationView;
