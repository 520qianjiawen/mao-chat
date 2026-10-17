import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  AudioLines,
  Camera,
  Check,
  Clipboard,
  ExternalLink,
  Languages,
  Loader2,
  MousePointerClick,
  Pin,
  PinOff,
  Volume2,
  VolumeX,
  X,
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
import {
  detectLanguageGroup,
  translateWithPreservedFormatting,
} from '../TextTranslation/TextTranslationView';
import './QuickTranslateWindow.scss';

const POPULAR_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'];

interface LiveTranslationClient {
  key: string;
  client: NativeTranslateClient | TranslationEngine;
}

export const QuickTranslateWindow: React.FC = () => {
  const { t } = useTranslation();
  const settings = useLocalNativeSettings();
  const catalog = useNativeCatalog();
  const modelStatuses = useNativeModelStatuses();

  const [sourceText, setSourceText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('en');
  const [isTranslating, setIsTranslating] = useState(false);
  const [isCapturingOcr, setIsCapturingOcr] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<LiveTranslationClient | null>(null);
  const runRef = useRef(0);
  const lastTranslatedRef = useRef<{ text: string; src: string; tgt: string } | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userManuallyPickedTarget = useRef(false);

  const isPinnedRef = useRef(false);
  useEffect(() => {
    isPinnedRef.current = isPinned;
  }, [isPinned]);

  // Method A: Auto-close when clicking outside (window blur) unless pinned
  useEffect(() => {
    const handleWindowBlur = () => {
      if (!isPinnedRef.current && window.electron?.invoke) {
        window.electron.invoke('quick-translate:close');
      }
    };
    window.addEventListener('blur', handleWindowBlur);
    return () => window.removeEventListener('blur', handleWindowBlur);
  }, []);

  const [ollamaModels, setOllamaModels] = useState<OllamaModelItem[]>([]);
  const [selectedModelOverride, setSelectedModelOverride] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchOllamaModels().then((models) => {
      if (!cancelled && models.length > 0) {
        setOllamaModels(models);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Available models (online engines, Ollama local models, plus downloaded local native models)
  const availableModels = useMemo(() => {
    const list: { id: string; name: string; isOnline: boolean; isReady: boolean }[] = [
      { id: 'bing-translator', name: 'Bing Translator', isOnline: true, isReady: true },
      { id: 'google-translator', name: 'Google Translator', isOnline: true, isReady: true },
      { id: 'deepl-translator', name: 'DeepL Translator', isOnline: true, isReady: true },
    ];

    for (const om of ollamaModels) {
      const id = `ollama:${om.name}`;
      if (!list.some((m) => m.id === id)) {
        list.push({
          id,
          name: `${om.name} (Ollama · 本地)`,
          isOnline: false,
          isReady: true,
        });
      }
    }

    const entries = Array.isArray(catalog)
      ? catalog.map((item: any) => [item.id, item] as const)
      : Object.entries(catalog || {});

    for (const [id, info] of entries) {
      if (!info || info.kind !== 'translate') continue;
      const rawStatus = (modelStatuses as any)?.[id];
      const isReady = rawStatus === 'ready' || rawStatus?.status === 'ready';
      if (isReady && !list.some((m) => m.id === id)) {
        list.push({
          id,
          name: info.name || id,
          isOnline: false,
          isReady: true,
        });
      }
    }

    return list;
  }, [catalog, modelStatuses, ollamaModels]);

  const selectedModelId = useMemo(() => {
    if (selectedModelOverride && availableModels.some((m) => m.id === selectedModelOverride)) {
      return selectedModelOverride;
    }
    const configured = resolveNativeTranslation(settings.translationModel);
    if (configured) {
      const match = availableModels.find((m) => m.id === configured);
      if (match) return match.id;
    }
    return availableModels[0]?.id || 'bing-translator';
  }, [availableModels, settings.translationModel, selectedModelOverride]);

  // Handle translation
  const handleTranslate = useCallback(async (textToTranslate?: string, srcL?: string, tgtL?: string) => {
    const text = (textToTranslate !== undefined ? textToTranslate : sourceText).trim();
    if (!text) {
      setTranslatedText('');
      setError(null);
      setIsTranslating(false);
      return;
    }

    const curSourceLang = srcL || sourceLang;
    let curTargetLang = tgtL || targetLang;

    if (curSourceLang === 'auto') {
      const group = detectLanguageGroup(text);
      const expectedTarget = group === 'zh' ? 'en' : 'zh';
      if (!userManuallyPickedTarget.current) {
        curTargetLang = expectedTarget;
        if (targetLang !== expectedTarget) {
          setTargetLang(expectedTarget);
        }
      } else if (group === 'zh' && curTargetLang === 'zh') {
        curTargetLang = 'en';
        setTargetLang('en');
      } else if (group === 'other' && curTargetLang === 'en') {
        curTargetLang = 'zh';
        setTargetLang('zh');
      }
    }

    lastTranslatedRef.current = { text, src: curSourceLang, tgt: curTargetLang };

    setIsTranslating(true);
    setError(null);
    const run = ++runRef.current;

    try {
      const curModelId = selectedModelId;
      const isOnline = isNativeOnlineTranslation(curModelId);
      const variant = settings.translationVariantByModel[curModelId] || 'default';
      const clientKey = `${curModelId}:${variant}:${curSourceLang}:${curTargetLang}:${settings.deeplApiKey || ''}`;

      let clientInstance = clientRef.current;
      if (!clientInstance || clientInstance.key !== clientKey) {
        if (clientInstance?.client) {
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

      const output = await translateWithPreservedFormatting(translateSingleChunk, text);
      if (runRef.current !== run) return;

      setTranslatedText(output.trim());
    } catch (err) {
      if (runRef.current !== run) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (runRef.current === run) {
        setIsTranslating(false);
      }
    }
  }, [sourceText, sourceLang, targetLang, selectedModelId, settings.translationVariantByModel, settings.deeplApiKey, settings.translationDevice]);

  // Set input text and automatically pick the appropriate target language
  const applyTextAndTranslate = useCallback((text: string) => {
    const trimmed = text ? text.trim() : '';
    if (!trimmed) return;
    userManuallyPickedTarget.current = false;
    setSourceText(trimmed);

    let nextTarget = targetLang;
    const detectedGroup = detectLanguageGroup(trimmed);
    if (detectedGroup === 'zh') {
      nextTarget = 'en';
    } else {
      nextTarget = 'zh';
    }
    setTargetLang(nextTarget);
    lastTranslatedRef.current = { text: trimmed, src: sourceLang, tgt: nextTarget };
    void handleTranslate(trimmed, sourceLang, nextTarget);
  }, [targetLang, sourceLang, handleTranslate]);

  const applyTextAndTranslateRef = useRef(applyTextAndTranslate);
  useEffect(() => {
    applyTextAndTranslateRef.current = applyTextAndTranslate;
  }, [applyTextAndTranslate]);

  // Auto-translate with 400ms debounce when user manually edits sourceText
  useEffect(() => {
    const trimmed = sourceText.trim();
    if (!trimmed) {
      setTranslatedText('');
      setError(null);
      setIsTranslating(false);
      lastTranslatedRef.current = null;
      return;
    }

    // Intelligent auto-language direction when sourceLang is 'auto'
    let effectiveTarget = targetLang;
    if (sourceLang === 'auto') {
      const group = detectLanguageGroup(trimmed);
      const expectedTarget = group === 'zh' ? 'en' : 'zh';
      if (!userManuallyPickedTarget.current) {
        effectiveTarget = expectedTarget;
        if (targetLang !== expectedTarget) {
          setTargetLang(expectedTarget);
        }
      } else if (group === 'zh' && targetLang === 'zh') {
        // Auto-fix conflict if Chinese is entered while target is also Chinese
        effectiveTarget = 'en';
        setTargetLang('en');
      } else if (group === 'other' && targetLang === 'en') {
        // If non-Chinese (e.g. English) is entered while target is English, switch to Chinese
        effectiveTarget = 'zh';
        setTargetLang('zh');
      }
    }

    if (
      lastTranslatedRef.current &&
      lastTranslatedRef.current.text === trimmed &&
      lastTranslatedRef.current.src === sourceLang &&
      lastTranslatedRef.current.tgt === effectiveTarget
    ) {
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      void handleTranslate(trimmed, sourceLang, effectiveTarget);
    }, 400);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [sourceText, sourceLang, targetLang, handleTranslate]);

  // Listen for payload from main process and pull initial payload on mount
  useEffect(() => {
    // 1. Immediately request the latest payload upon component mount
    if (window.electron?.invoke) {
      window.electron
        .invoke('quick-translate:get-payload')
        .then((payload: any) => {
          if (payload?.text) {
            applyTextAndTranslateRef.current(payload.text);
          }
        })
        .catch(console.warn);
    }

    // 2. Also listen for subsequent updates while open
    if (!window.electron?.receive) return;

    const onPayload = (payload: { text: string; source: string }) => {
      if (payload?.text) {
        applyTextAndTranslateRef.current(payload.text);
      }
    };

    window.electron.receive('quick-translate:payload', onPayload);
    return () => {
      window.electron?.removeListener?.('quick-translate:payload', onPayload);
    };
  }, []);

  // Action: Trigger Screenshot OCR
  const handleScreenshotOcr = useCallback(async () => {
    if (!window.electron?.invoke) return;
    setIsCapturingOcr(true);
    setError(null);
    try {
      const res = await window.electron.invoke('quick-translate:ocr-screenshot');
      if (res?.ok && res.text) {
        applyTextAndTranslate(res.text);
      } else if (res?.error === 'permission_denied' || res?.permission === 'screen') {
        setError(t('textTranslation.screenPermissionRequired', '截图翻译需要「屏幕与系统音频录制」权限，请在 macOS 系统设置中授权'));
      } else if (res?.ok && !res.text && !res?.cancelled) {
        setError(t('textTranslation.noTextDetected', '未在截图区域中检测到文字，请重新框选'));
      }
    } catch (e: any) {
      setError(e?.message || '截图识别失败');
    } finally {
      setIsCapturingOcr(false);
    }
  }, [applyTextAndTranslate, t]);

  // Action: Trigger Selection Capture
  const handleSelectionCapture = useCallback(async () => {
    if (!window.electron?.invoke) return;
    setError(null);
    try {
      const res = await window.electron.invoke('quick-translate:capture-selection');
      if (res?.ok && res.text) {
        applyTextAndTranslate(res.text);
      } else if (res?.ok && !res.text) {
        setError(t('textTranslation.noSelectionDetected', '未检测到划选文字，可按 ⌘C 复制后翻译'));
      }
    } catch (e: any) {
      setError(e?.message || '划词获取失败');
    }
  }, [applyTextAndTranslate, t]);

  // Action: Toggle Pin (Always-on-top)
  const handleTogglePin = useCallback(async () => {
    const nextPin = !isPinned;
    setIsPinned(nextPin);
    isPinnedRef.current = nextPin;
    if (window.electron?.invoke) {
      await window.electron.invoke('quick-translate:set-pinned', nextPin);
    }
  }, [isPinned]);

  // Action: Close window
  const handleClose = useCallback(() => {
    if (window.electron?.invoke) {
      window.electron.invoke('quick-translate:close');
    }
  }, []);

  // Action: Open in main window
  const handleOpenMain = useCallback(() => {
    if (window.electron?.invoke) {
      window.electron.invoke('quick-translate:open-main', {
        text: sourceText,
        translatedText,
        sourceLang,
        targetLang,
      });
    }
  }, [sourceText, translatedText, sourceLang, targetLang]);

  // Action: Copy translated text
  const handleCopyTarget = useCallback(async () => {
    if (!translatedText) return;
    try {
      await navigator.clipboard.writeText(translatedText);
      setCopiedTarget(true);
      setTimeout(() => setCopiedTarget(false), 1500);
    } catch (e) {
      console.error('Failed to copy', e);
    }
  }, [translatedText]);

  // Action: Read aloud (TTS)
  const handleToggleSpeak = useCallback(() => {
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

  // Keyboard shortcut listener within the window
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleTranslate();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, handleTranslate]);

  return (
    <div className="quick-translate-window">
      {/* Draggable Title Bar */}
      <header className="qt-header">
        <div className="qt-header__title">
          <Languages size={15} className="qt-header__icon" />
          <span>{t('textTranslation.quickTitle', 'MAO 划词与截图翻译')}</span>
        </div>

        <div className="qt-header__actions">
          <button
            type="button"
            className={`qt-header__btn ${isCapturingOcr ? 'is-active' : ''}`}
            onClick={handleScreenshotOcr}
            title={t('textTranslation.screenshotOcrTooltip', '截图翻译 (⌃Z)')}
          >
            <Camera size={14} />
            <span className="qt-header__btn-key">⌃Z</span>
          </button>

          <button
            type="button"
            className="qt-header__btn"
            onClick={handleSelectionCapture}
            title={t('textTranslation.selectionTooltip', '划词翻译 (⌃Q)')}
          >
            <MousePointerClick size={14} />
            <span className="qt-header__btn-key">⌃Q</span>
          </button>

          <button
            type="button"
            className="qt-header__btn"
            onClick={handleOpenMain}
            title={t('textTranslation.openInMain', '在主窗口打开')}
          >
            <ExternalLink size={14} />
          </button>

          <button
            type="button"
            className={`qt-header__btn ${isPinned ? 'is-pinned' : ''}`}
            onClick={handleTogglePin}
            title={isPinned ? t('textTranslation.unpin', '固定窗口（已常驻，点击外部不隐藏）') : t('textTranslation.pin', '固定窗口（点击外部空白处自动隐藏）')}
          >
            {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>

          <button
            type="button"
            className="qt-header__btn qt-header__btn--close"
            onClick={handleClose}
            title={t('common.close', '关闭 (ESC)')}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {/* Language Switch Bar */}
      <div className="qt-lang-bar">
        <select
          className="qt-lang-select"
          value={sourceLang}
          onChange={(e) => {
            const next = e.target.value;
            if (next === 'auto') {
              userManuallyPickedTarget.current = false;
            }
            setSourceLang(next);
            void handleTranslate(sourceText, next, targetLang);
          }}
        >
          <option value="auto">{t('textTranslation.autoDetect', '自动识别')}</option>
          {POPULAR_LANGUAGES.map((code) => (
            <option key={`src-${code}`} value={code}>
              {getLanguageDisplayName(code)}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="qt-swap-btn"
          onClick={() => {
            userManuallyPickedTarget.current = true;
            const nextSrc = targetLang;
            const nextTgt = sourceLang === 'auto' ? 'zh' : sourceLang;
            setSourceLang(nextSrc);
            setTargetLang(nextTgt);
            setSourceText(translatedText);
            setTranslatedText(sourceText);
            void handleTranslate(translatedText, nextSrc, nextTgt);
          }}
          title={t('textTranslation.swapLanguages', '交换语言')}
        >
          <ArrowLeftRight size={13} />
        </button>

        <select
          className="qt-lang-select"
          value={targetLang}
          onChange={(e) => {
            const next = e.target.value;
            userManuallyPickedTarget.current = true;
            setTargetLang(next);
            void handleTranslate(sourceText, sourceLang, next);
          }}
        >
          {POPULAR_LANGUAGES.map((code) => (
            <option key={`tgt-${code}`} value={code}>
              {getLanguageDisplayName(code)}
            </option>
          ))}
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <select
            className="qt-model-select"
            value={selectedModelId}
            onChange={(e) => {
              const next = e.target.value;
              setSelectedModelOverride(next);
              void handleTranslate(sourceText, sourceLang, targetLang, next);
            }}
            title={t('textTranslation.model', '翻译模型')}
          >
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {isTranslating && <Loader2 size={13} className="qt-loading-spinner animate-spin" />}
        </div>
      </div>

      {/* Content Area */}
      <main className="qt-body">
        {/* Source Text Box */}
        <div className="qt-card qt-card--source">
          <textarea
            className="qt-textarea"
            placeholder={t('textTranslation.quickInputPlaceholder', '划选文字或按 ⌃Z 截图，亦可在此直接输入...')}
            value={sourceText}
            onChange={(e) => {
              setSourceText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleTranslate();
              }
            }}
          />
        </div>

        {/* Translation Output Box */}
        <div className="qt-card qt-card--target">
          {error ? (
            <div className="qt-error">{error}</div>
          ) : isTranslating && !translatedText ? (
            <div className="qt-translating-state">
              <Loader2 size={16} className="animate-spin" />
              <span>{t('textTranslation.translating', '正在翻译...')}</span>
            </div>
          ) : translatedText ? (
            <div className="qt-target-content">{translatedText}</div>
          ) : (
            <div className="qt-target-empty">
              <span>{t('textTranslation.waitingForInput', '翻译结果将在此显示')}</span>
            </div>
          )}

          {/* Target Footer Actions */}
          <div className="qt-target-actions">
            <button
              type="button"
              className="qt-action-btn"
              onClick={handleToggleSpeak}
              disabled={!translatedText}
              title={isSpeaking ? t('textTranslation.stopSpeak', '停止朗读') : t('textTranslation.speak', '朗读译文')}
            >
              {isSpeaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>

            <button
              type="button"
              className="qt-action-btn"
              onClick={handleCopyTarget}
              disabled={!translatedText}
              title={t('textTranslation.copy', '复制译文')}
            >
              {copiedTarget ? <Check size={13} className="is-success" /> : <Clipboard size={13} />}
            </button>

            <button
              type="button"
              className="qt-action-btn qt-action-btn--tts"
              onClick={handleOpenMain}
              disabled={!translatedText}
              title={t('textTranslation.sendToSpeech', '推送到语音朗读')}
            >
              <AudioLines size={13} />
              <span>{t('textTranslation.sendToSpeechShort', '转语音')}</span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default QuickTranslateWindow;
