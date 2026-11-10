import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  AudioLines,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Cpu,
  Download,
  ExternalLink,
  Globe,
  HelpCircle,
  Key,
  Languages,
  Loader2,
  MousePointerClick,
  Pin,
  PinOff,
  Settings,
  Sparkles,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TranslationEngine } from '../../lib/local-inference/engine/TranslationEngine';
import { ZhipuTranslatorClient } from '../../lib/zhipu-translator/ZhipuTranslatorClient';
import { SiliconFlowTranslatorClient } from '../../lib/siliconflow-translator/SiliconFlowTranslatorClient';
import { AppleSystemTranslatorClient } from '../../lib/apple-system-translator/AppleSystemTranslatorClient';
import { speakText, stopSpeaking } from '../../utils/speechVoice';
import { useLocalNativeSettings } from '../../stores/settingsStore';
import { LANGUAGE_OPTIONS, getLanguageDisplayName } from '../../utils/languages';
import {
  detectLanguageGroup,
  translateWithPreservedFormatting,
} from '../TextTranslation/TextTranslationView';
import {
  ALL_TRANSLATION_SERVICES,
  DEFAULT_ENABLED_SERVICE_IDS,
  type ServiceTranslationState,
} from './types';
import './QuickTranslateWindow.scss';

const POPULAR_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'];

const STORAGE_KEY_ENABLED = 'mao_qt_enabled_services';
const STORAGE_KEY_ZHIPU = 'mao_qt_zhipu_api_key';
const STORAGE_KEY_SILICON = 'mao_qt_silicon_api_key';

function detectLanguageLabel(text: string): string {
  if (!text || !text.trim()) return '';
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return '日语';
  if (/[\uAC00-\uD7AF]/.test(text)) return '韩语';
  if (/[\u4e00-\u9fa5]/.test(text)) return '中文';
  if (/^[A-Za-z0-9\s.,!?'"()\-–—;:/]+$/.test(text.trim())) return '英语';
  return '自动检测';
}

export const QuickTranslateWindow: React.FC = () => {
  const { t } = useTranslation();
  const settings = useLocalNativeSettings();

  const [sourceText, setSourceText] = useState('');
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('en');
  const [isCapturingOcr, setIsCapturingOcr] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [isSpeakingSource, setIsSpeakingSource] = useState(false);
  const [speakingServiceId, setSpeakingServiceId] = useState<string | null>(null);
  const [copiedSource, setCopiedSource] = useState(false);
  const [copiedServiceId, setCopiedServiceId] = useState<string | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAppleGuide, setShowAppleGuide] = useState(false);

  // Enabled services & API keys
  const [enabledServices, setEnabledServices] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ENABLED);
      if (saved) return JSON.parse(saved);
    } catch {}
    return DEFAULT_ENABLED_SERVICE_IDS;
  });

  const [zhipuApiKey, setZhipuApiKey] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY_ZHIPU) || '';
  });

  const [siliconFlowApiKey, setSiliconFlowApiKey] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY_SILICON) || '';
  });

  // Inline key editing states on cards
  const [editingKeyForService, setEditingKeyForService] = useState<string | null>(null);
  const [tempKeyInput, setTempKeyInput] = useState('');

  // Per-service translation results
  const [serviceStates, setServiceStates] = useState<Record<string, ServiceTranslationState>>({});

  const bingEngineRef = useRef<TranslationEngine | null>(null);
  const runRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userManuallyPickedTarget = useRef(false);

  const isPinnedRef = useRef(false);
  useEffect(() => {
    isPinnedRef.current = isPinned;
  }, [isPinned]);

  // Save settings helpers
  const updateEnabledServices = useCallback((next: string[]) => {
    setEnabledServices(next);
    try {
      localStorage.setItem(STORAGE_KEY_ENABLED, JSON.stringify(next));
    } catch {}
  }, []);

  const saveZhipuKey = useCallback((key: string) => {
    const trimmed = key.trim();
    setZhipuApiKey(trimmed);
    try {
      localStorage.setItem(STORAGE_KEY_ZHIPU, trimmed);
    } catch {}
  }, []);

  const saveSiliconKey = useCallback((key: string) => {
    const trimmed = key.trim();
    setSiliconFlowApiKey(trimmed);
    try {
      localStorage.setItem(STORAGE_KEY_SILICON, trimmed);
    } catch {}
  }, []);

  // Auto-close when clicking outside (window blur) unless pinned
  useEffect(() => {
    const handleWindowBlur = () => {
      if (!isPinnedRef.current && window.electron?.invoke) {
        window.electron.invoke('quick-translate:close');
      }
    };
    window.addEventListener('blur', handleWindowBlur);
    return () => window.removeEventListener('blur', handleWindowBlur);
  }, []);

  // Multi-model translation dispatcher
  const handleTranslateAll = useCallback(
    async (textToTranslate?: string, srcL?: string, tgtL?: string) => {
      const text = (textToTranslate !== undefined ? textToTranslate : sourceText).trim();
      if (!text) {
        setServiceStates({});
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

      const run = ++runRef.current;

      // Mark all enabled services as translating
      setServiceStates((prev) => {
        const next = { ...prev };
        for (const sid of enabledServices) {
          next[sid] = {
            serviceId: sid,
            isTranslating: true,
            translatedText: prev[sid]?.translatedText || '',
            isCollapsed: prev[sid]?.isCollapsed || false,
            error: null,
            errorCode: null,
          };
        }
        return next;
      });

      // Execute each service in parallel
      for (const sid of enabledServices) {
        (async () => {
          try {
            if (sid === 'apple-system') {
              const client = new AppleSystemTranslatorClient();
              const res = await client.translate(text, curSourceLang, curTargetLang);
              if (runRef.current !== run) return;
              setServiceStates((p) => ({
                ...p,
                [sid]: {
                  serviceId: sid,
                  isTranslating: false,
                  translatedText: res.translatedText,
                  latencyMs: res.inferenceTimeMs,
                  error: null,
                  errorCode: null,
                  isCollapsed: p[sid]?.isCollapsed,
                },
              }));
            } else if (sid === 'zhipu') {
              if (!zhipuApiKey) {
                if (runRef.current !== run) return;
                setServiceStates((p) => ({
                  ...p,
                  [sid]: {
                    serviceId: sid,
                    isTranslating: false,
                    translatedText: '',
                    error: '未配置智谱 API Key，填入后即可免费使用',
                    errorCode: 'NO_API_KEY',
                    isCollapsed: p[sid]?.isCollapsed,
                  },
                }));
                return;
              }
              const client = new ZhipuTranslatorClient({ apiKey: zhipuApiKey });
              const res = await client.translate(text, curSourceLang, curTargetLang);
              if (runRef.current !== run) return;
              setServiceStates((p) => ({
                ...p,
                [sid]: {
                  serviceId: sid,
                  isTranslating: false,
                  translatedText: res.translatedText,
                  latencyMs: res.inferenceTimeMs,
                  error: null,
                  errorCode: null,
                  isCollapsed: p[sid]?.isCollapsed,
                },
              }));
            } else if (sid === 'siliconflow') {
              if (!siliconFlowApiKey) {
                if (runRef.current !== run) return;
                setServiceStates((p) => ({
                  ...p,
                  [sid]: {
                    serviceId: sid,
                    isTranslating: false,
                    translatedText: '',
                    error: '未配置硅基流动 API Key',
                    errorCode: 'NO_API_KEY',
                    isCollapsed: p[sid]?.isCollapsed,
                  },
                }));
                return;
              }
              const client = new SiliconFlowTranslatorClient({ apiKey: siliconFlowApiKey });
              const res = await client.translate(text, curSourceLang, curTargetLang);
              if (runRef.current !== run) return;
              setServiceStates((p) => ({
                ...p,
                [sid]: {
                  serviceId: sid,
                  isTranslating: false,
                  translatedText: res.translatedText,
                  latencyMs: res.inferenceTimeMs,
                  error: null,
                  errorCode: null,
                  isCollapsed: p[sid]?.isCollapsed,
                },
              }));
            } else if (sid === 'bing' || sid === 'google' || sid === 'deepl') {
              const engineModel =
                sid === 'bing'
                  ? 'bing-translator'
                  : sid === 'google'
                  ? 'google-translator'
                  : 'deepl-translator';

              let engine = bingEngineRef.current;
              if (!engine) {
                engine = new TranslationEngine();
                bingEngineRef.current = engine;
              }
              const start = performance.now();
              await engine.init(curSourceLang, curTargetLang, engineModel, {
                apiKey: settings.deeplApiKey,
              });

              const translateChunk = async (chunk: string): Promise<string> => {
                const r = await engine!.translate(chunk);
                return (r.translatedText || '').trim();
              };

              const output = await translateWithPreservedFormatting(translateChunk, text);
              const latencyMs = Math.round(performance.now() - start);

              if (runRef.current !== run) return;
              setServiceStates((p) => ({
                ...p,
                [sid]: {
                  serviceId: sid,
                  isTranslating: false,
                  translatedText: output.trim(),
                  latencyMs,
                  error: null,
                  errorCode: null,
                  isCollapsed: p[sid]?.isCollapsed,
                },
              }));
            }
          } catch (err: any) {
            if (runRef.current !== run) return;
            setServiceStates((p) => ({
              ...p,
              [sid]: {
                serviceId: sid,
                isTranslating: false,
                translatedText: '',
                error: err?.message || '翻译失败',
                errorCode: err?.code || (err?.message?.includes('API Key') ? 'NO_API_KEY' : 'FAILED'),
                isCollapsed: p[sid]?.isCollapsed,
              },
            }));
          }
        })();
      }
    },
    [sourceText, sourceLang, targetLang, enabledServices, zhipuApiKey, siliconFlowApiKey, settings.deeplApiKey],
  );

  // Set input text and automatically pick the appropriate target language
  const applyTextAndTranslate = useCallback(
    (text: string) => {
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
      void handleTranslateAll(trimmed, sourceLang, nextTarget);
    },
    [targetLang, sourceLang, handleTranslateAll],
  );

  const applyTextAndTranslateRef = useRef(applyTextAndTranslate);
  useEffect(() => {
    applyTextAndTranslateRef.current = applyTextAndTranslate;
  }, [applyTextAndTranslate]);

  // Auto-translate with 400ms debounce when user manually edits sourceText
  useEffect(() => {
    const trimmed = sourceText.trim();
    if (!trimmed) {
      setServiceStates({});
      return;
    }

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
        effectiveTarget = 'en';
        setTargetLang('en');
      } else if (group === 'other' && targetLang === 'en') {
        effectiveTarget = 'zh';
        setTargetLang('zh');
      }
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      void handleTranslateAll(trimmed, sourceLang, effectiveTarget);
    }, 400);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [sourceText, sourceLang, targetLang, handleTranslateAll]);

  // Listen for payload from main process and pull initial payload on mount
  useEffect(() => {
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
    try {
      const res = await window.electron.invoke('quick-translate:ocr-screenshot');
      if (res?.ok && res.text) {
        applyTextAndTranslate(res.text);
      }
    } catch (e: any) {
      console.warn('Screenshot OCR error:', e);
    } finally {
      setIsCapturingOcr(false);
    }
  }, [applyTextAndTranslate]);

  // Action: Trigger Selection Capture
  const handleSelectionCapture = useCallback(async () => {
    if (!window.electron?.invoke) return;
    try {
      const res = await window.electron.invoke('quick-translate:capture-selection');
      if (res?.ok && res.text) {
        applyTextAndTranslate(res.text);
      }
    } catch (e: any) {
      console.warn('Selection error:', e);
    }
  }, [applyTextAndTranslate]);

  // Action: Toggle Pin
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
    stopSpeaking();
    if (window.electron?.invoke) {
      window.electron.invoke('quick-translate:close');
    }
  }, []);

  // Action: Open in main window
  const handleOpenMain = useCallback(() => {
    // Find first non-empty translation
    let chosenTranslation = '';
    for (const sid of enabledServices) {
      if (serviceStates[sid]?.translatedText) {
        chosenTranslation = serviceStates[sid].translatedText;
        break;
      }
    }

    if (window.electron?.invoke) {
      window.electron.invoke('quick-translate:open-main', {
        text: sourceText,
        translatedText: chosenTranslation,
        sourceLang,
        targetLang,
      });
    }
  }, [sourceText, serviceStates, enabledServices, sourceLang, targetLang]);

  // Action: Copy text
  const handleCopy = useCallback(async (text: string, serviceId?: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (serviceId) {
        setCopiedServiceId(serviceId);
        setTimeout(() => setCopiedServiceId(null), 1500);
      } else {
        setCopiedSource(true);
        setTimeout(() => setCopiedSource(false), 1500);
      }
    } catch (e) {
      console.error('Failed to copy', e);
    }
  }, []);

  // Action: Read aloud (TTS)
  const handleSpeak = useCallback((text: string, lang: string, serviceId?: string) => {
    if (!text) return;

    if (serviceId) {
      if (speakingServiceId === serviceId) {
        stopSpeaking();
        setSpeakingServiceId(null);
        return;
      }
      setSpeakingServiceId(serviceId);
      void speakText(text, lang, {
        onEnd: () => setSpeakingServiceId(null),
        onError: () => setSpeakingServiceId(null),
      });
    } else {
      if (isSpeakingSource) {
        stopSpeaking();
        setIsSpeakingSource(false);
        return;
      }
      setIsSpeakingSource(true);
      void speakText(text, lang, {
        onEnd: () => setIsSpeakingSource(false),
        onError: () => setIsSpeakingSource(false),
      });
    }
  }, [speakingServiceId, isSpeakingSource]);

  // Action: Toggle card collapse
  const handleToggleCollapse = useCallback((sid: string) => {
    setServiceStates((prev) => ({
      ...prev,
      [sid]: {
        ...prev[sid],
        serviceId: sid,
        isTranslating: prev[sid]?.isTranslating || false,
        translatedText: prev[sid]?.translatedText || '',
        isCollapsed: !prev[sid]?.isCollapsed,
      },
    }));
  }, []);

  // Save inline API Key
  const handleSaveInlineKey = useCallback((sid: string) => {
    if (!tempKeyInput.trim()) return;
    if (sid === 'zhipu') {
      saveZhipuKey(tempKeyInput);
    } else if (sid === 'siliconflow') {
      saveSiliconKey(tempKeyInput);
    }
    setEditingKeyForService(null);
    setTempKeyInput('');
    void handleTranslateAll(sourceText, sourceLang, targetLang);
  }, [tempKeyInput, saveZhipuKey, saveSiliconKey, handleTranslateAll, sourceText, sourceLang, targetLang]);

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showSettingsModal) {
          setShowSettingsModal(false);
        } else {
          handleClose();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleTranslateAll();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, handleTranslateAll, showSettingsModal]);

  // Render Service Icon
  const renderServiceIcon = (id: string) => {
    switch (id) {
      case 'apple-system':
        return <Cpu size={14} className="qt-icon--apple" />;
      case 'zhipu':
        return <Sparkles size={14} className="qt-icon--zhipu" />;
      case 'siliconflow':
        return <Zap size={14} className="qt-icon--silicon" />;
      case 'bing':
      case 'google':
      default:
        return <Globe size={14} className="qt-icon--bing" />;
    }
  };

  const isAnyTranslating = useMemo(() => {
    return Object.values(serviceStates).some((s) => s.isTranslating);
  }, [serviceStates]);

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
            className={`qt-header__btn ${showSettingsModal ? 'is-active' : ''}`}
            onClick={() => setShowSettingsModal((v) => !v)}
            title="服务配置"
          >
            <Settings size={14} />
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
            title={
              isPinned
                ? t('textTranslation.unpin', '固定窗口（已常驻，点击外部不隐藏）')
                : t('textTranslation.pin', '固定窗口（点击外部空白处自动隐藏）')
            }
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

      {/* Main Body */}
      <main className="qt-body">
        {/* Source Text Box */}
        <div className="qt-source-card">
          <textarea
            className="qt-textarea"
            placeholder={t('textTranslation.quickInputPlaceholder', '划选文字或按 ⌃Z 截图，亦可在此直接输入...')}
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleTranslateAll();
              }
            }}
          />

          <div className="qt-source-card__footer">
            <div className="qt-source-card__actions">
              <button
                type="button"
                className="qt-icon-btn"
                onClick={() => handleSpeak(sourceText, sourceLang)}
                disabled={!sourceText}
                title="朗读原文"
              >
                {isSpeakingSource ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
              <button
                type="button"
                className="qt-icon-btn"
                onClick={() => handleCopy(sourceText)}
                disabled={!sourceText}
                title="复制原文"
              >
                {copiedSource ? <Check size={13} className="is-success" /> : <Clipboard size={13} />}
              </button>
              {sourceText && (
                <button
                  type="button"
                  className="qt-icon-btn"
                  onClick={() => {
                    setSourceText('');
                    setServiceStates({});
                  }}
                  title="清空"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {sourceText && (
              <div className="qt-source-card__info">
                <span className="qt-detected-badge">
                  识别为 {detectLanguageLabel(sourceText)}
                </span>
                <span className="qt-char-count">{sourceText.length} 字符</span>
              </div>
            )}
          </div>
        </div>

        {/* Language Selection Bar */}
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
              void handleTranslateAll(sourceText, next, targetLang);
            }}
          >
            <option value="auto">{t('textTranslation.autoDetect', '自动检测')}</option>
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
              void handleTranslateAll(sourceText, nextSrc, nextTgt);
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
              void handleTranslateAll(sourceText, sourceLang, next);
            }}
          >
            {POPULAR_LANGUAGES.map((code) => (
              <option key={`tgt-${code}`} value={code}>
                {getLanguageDisplayName(code)}
              </option>
            ))}
          </select>

          <div className="qt-lang-bar__right">
            <span className="qt-enabled-count-badge">
              {enabledServices.length} 个服务同时翻译
            </span>
            {isAnyTranslating && <Loader2 size={13} className="qt-loading-spinner animate-spin" />}
          </div>
        </div>

        {/* Stacked Multi-Model Translation Cards */}
        <div className="qt-results-container">
          {enabledServices.map((sid) => {
            const def = ALL_TRANSLATION_SERVICES.find((s) => s.id === sid);
            if (!def) return null;
            const state = serviceStates[sid] || {
              serviceId: sid,
              isTranslating: false,
              translatedText: '',
            };
            const isCollapsed = Boolean(state.isCollapsed);

            return (
              <div key={sid} className={`qt-service-card ${isCollapsed ? 'is-collapsed' : ''}`}>
                {/* Service Header */}
                <div
                  className="qt-service-card__header"
                  onClick={() => handleToggleCollapse(sid)}
                >
                  <div className="qt-service-card__brand">
                    {renderServiceIcon(sid)}
                    <span className="qt-service-card__name">{def.name}</span>
                    <span className={`qt-service-card__badge qt-service-card__badge--${sid}`}>
                      {def.badge}
                    </span>
                  </div>

                  <div className="qt-service-card__status">
                    {state.isTranslating ? (
                      <span className="qt-translating-tag">
                        <Loader2 size={11} className="animate-spin" />
                        <span>翻译中...</span>
                      </span>
                    ) : state.latencyMs ? (
                      <span className="qt-latency-tag">{state.latencyMs}ms</span>
                    ) : null}

                    <button
                      type="button"
                      className="qt-collapse-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleCollapse(sid);
                      }}
                    >
                      {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                    </button>
                  </div>
                </div>

                {/* Service Card Body */}
                {!isCollapsed && (
                  <div className="qt-service-card__body">
                    {state.isTranslating && !state.translatedText ? (
                      <div className="qt-service-card__shimmer">
                        <Loader2 size={14} className="animate-spin" />
                        <span>正在获取 {def.name} 翻译...</span>
                      </div>
                    ) : state.errorCode === 'SHORTCUT_NOT_INSTALLED' ? (
                      <div className="qt-service-card__error-box">
                        <p className="qt-error-msg">
                          {state.error || '未检测到系统快捷指令。系统翻译基于 macOS Apple Translate 原生引擎（免 Key、零消耗）。'}
                        </p>
                        <div className="qt-error-actions">
                          <button
                            type="button"
                            className="qt-btn-install-shortcut"
                            onClick={async () => {
                              const client = new AppleSystemTranslatorClient();
                              await client.installShortcut();
                            }}
                          >
                            <Download size={13} />
                            <span>一键安装「MAO.Translate」快捷指令</span>
                          </button>
                          <button
                            type="button"
                            className="qt-btn-guide-toggle"
                            onClick={() => setShowAppleGuide((prev) => !prev)}
                          >
                            <HelpCircle size={13} />
                            <span>{showAppleGuide ? '收起配置说明' : '30秒配置教程'}</span>
                          </button>
                        </div>
                        {showAppleGuide && (
                          <div className="qt-shortcut-guide">
                            <div className="qt-shortcut-guide__step">
                              <span className="step-num">1</span>
                              <div className="step-content">
                                <strong>一键安装</strong>：点击上方按钮，系统将自动弹出导入窗口，点击「添加快捷指令」即可。
                              </div>
                            </div>
                            <div className="qt-shortcut-guide__step">
                              <span className="step-num">2</span>
                              <div className="step-content">
                                <strong>或手动创建</strong>：打开 Mac「快捷指令」App ➔ 点击「+」新建 ➔ 添加动作「翻译文本」➔ 命名为 <code>MAO.Translate</code> 即可。
                              </div>
                            </div>
                            <div className="qt-shortcut-guide__step">
                              <span className="step-num">3</span>
                              <div className="step-content">
                                <strong>自动化授权</strong>：若提示无权限，请前往「系统设置」➔「隐私与安全性」➔「自动化」➔「MAO Chat」勾选「Shortcuts Events」。
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : state.errorCode === 'NO_API_KEY' ? (
                      <div className="qt-service-card__error-box">
                        <p className="qt-error-msg">尚未配置 API Key，填入后即可极速免费调用。</p>
                        {editingKeyForService === sid ? (
                          <div className="qt-inline-key-input">
                            <input
                              type="password"
                              className="qt-input"
                              placeholder={`输入 ${def.name} API Key...`}
                              value={tempKeyInput}
                              onChange={(e) => setTempKeyInput(e.target.value)}
                              autoFocus
                            />
                            <button
                              type="button"
                              className="qt-btn-save"
                              onClick={() => handleSaveInlineKey(sid)}
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              className="qt-btn-cancel"
                              onClick={() => {
                                setEditingKeyForService(null);
                                setTempKeyInput('');
                              }}
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <div className="qt-error-actions">
                            <button
                              type="button"
                              className="qt-btn-install-shortcut"
                              onClick={() => {
                                setEditingKeyForService(sid);
                                setTempKeyInput(sid === 'zhipu' ? zhipuApiKey : siliconFlowApiKey);
                              }}
                            >
                              <Key size={13} />
                              <span>配置 API Key</span>
                            </button>
                            {def.keyHelpUrl && (
                              <a
                                href={def.keyHelpUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="qt-link-help"
                              >
                                免费获取 Key →
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    ) : state.error ? (
                      <div className="qt-service-card__error-text">{state.error}</div>
                    ) : state.translatedText ? (
                      <div className="qt-service-card__text">{state.translatedText}</div>
                    ) : (
                      <div className="qt-service-card__empty">等待输入内容...</div>
                    )}

                    {/* Card Actions Footer */}
                    {state.translatedText && (
                      <div className="qt-service-card__actions">
                        <button
                          type="button"
                          className="qt-action-btn"
                          onClick={() => handleSpeak(state.translatedText, targetLang, sid)}
                          title="朗读译文"
                        >
                          {speakingServiceId === sid ? <VolumeX size={13} /> : <Volume2 size={13} />}
                        </button>

                        <button
                          type="button"
                          className="qt-action-btn"
                          onClick={() => handleCopy(state.translatedText, sid)}
                          title="复制译文"
                        >
                          {copiedServiceId === sid ? (
                            <Check size={13} className="is-success" />
                          ) : (
                            <Clipboard size={13} />
                          )}
                        </button>

                        <button
                          type="button"
                          className="qt-action-btn qt-action-btn--tts"
                          onClick={handleOpenMain}
                          title="在主界面朗读 / 语音合成"
                        >
                          <AudioLines size={13} />
                          <span>转语音</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>

      {/* Settings Modal Popover */}
      {showSettingsModal && (
        <div className="qt-modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="qt-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="qt-modal-header">
              <h3>翻译服务管理</h3>
              <button
                type="button"
                className="qt-icon-btn"
                onClick={() => setShowSettingsModal(false)}
              >
                <X size={15} />
              </button>
            </div>

            <div className="qt-modal-body">
              <div className="qt-settings-section">
                <label className="qt-settings-label">启用的翻译服务（多模型并发）：</label>
                <div className="qt-services-toggle-grid">
                  {ALL_TRANSLATION_SERVICES.map((s) => {
                    const isEnabled = enabledServices.includes(s.id);
                    return (
                      <label key={s.id} className="qt-service-toggle-item">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={(e) => {
                            if (e.target.checked) {
                              updateEnabledServices([...enabledServices, s.id]);
                            } else {
                              if (enabledServices.length <= 1) return; // Keep at least one
                              updateEnabledServices(enabledServices.filter((id) => id !== s.id));
                            }
                          }}
                        />
                        <span className="qt-toggle-name">{s.name}</span>
                        <span className="qt-toggle-badge">{s.badge}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="qt-settings-section">
                <div className="qt-settings-row">
                  <label className="qt-settings-label">系统翻译 (Apple Translate 离线引擎)：</label>
                  <button
                    type="button"
                    className="qt-btn-install-shortcut"
                    onClick={async () => {
                      const client = new AppleSystemTranslatorClient();
                      await client.installShortcut();
                    }}
                  >
                    <Download size={11} />
                    <span>安装 MAO.Translate 快捷指令</span>
                  </button>
                </div>
                <p className="qt-settings-desc">
                  完全调用 macOS 原生翻译能力，免配置 API Key。指令名称需保持为 <code>MAO.Translate</code>。
                </p>
              </div>

              <div className="qt-settings-section">
                <div className="qt-settings-row">
                  <label className="qt-settings-label">智谱 API Key (GLM-4-Flash 永久免费)：</label>
                  <a
                    href="https://open.bigmodel.cn/usercenter/apikeys"
                    target="_blank"
                    rel="noreferrer"
                    className="qt-link-help"
                  >
                    免费获取 Key →
                  </a>
                </div>
                <input
                  type="password"
                  className="qt-input"
                  placeholder="如: 8e6cffe1bce9454cafde670c526822d4..."
                  value={zhipuApiKey}
                  onChange={(e) => saveZhipuKey(e.target.value)}
                />
              </div>

              <div className="qt-settings-section">
                <div className="qt-settings-row">
                  <label className="qt-settings-label">硅基流动 API Key (Qwen2.5 免费调用)：</label>
                  <a
                    href="https://cloud.siliconflow.cn/account/ak"
                    target="_blank"
                    rel="noreferrer"
                    className="qt-link-help"
                  >
                    免费获取 Key →
                  </a>
                </div>
                <input
                  type="password"
                  className="qt-input"
                  placeholder="如: sk-studio-xxxx..."
                  value={siliconFlowApiKey}
                  onChange={(e) => saveSiliconKey(e.target.value)}
                />
              </div>
            </div>

            <div className="qt-modal-footer">
              <button
                type="button"
                className="qt-btn-done"
                onClick={() => {
                  setShowSettingsModal(false);
                  void handleTranslateAll(sourceText, sourceLang, targetLang);
                }}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default QuickTranslateWindow;
