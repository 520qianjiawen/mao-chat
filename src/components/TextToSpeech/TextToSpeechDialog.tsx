import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CircleCheck, Download, Languages, LoaderCircle, PencilLine, Play, RefreshCw, Settings2, Sparkles, Volume2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NativeTtsClient } from '../../lib/local-inference/native/NativeTtsClient';
import { NativeTranslateClient } from '../../lib/local-inference/native/NativeTranslateClient';
import { TranslationEngine } from '../../lib/local-inference/engine/TranslationEngine';
import {
  defaultTtsVoice,
  isNativeOnlineTranslation,
  resolveNativeTranslation,
  resolveNativeTts,
  voiceCapability,
} from '../../lib/local-inference/native/nativeCatalog';
import { buildDefaultLocalPrompt } from '../../lib/local-inference/prompts';
import {
  nativeListTtsVoices,
  useNativeCatalog,
  useNativeModelErrors,
  useNativeModelProgress,
  useNativeSidecarStatus,
  useNativeModelStatuses,
  useNativeModelStore,
} from '../../stores/nativeModelStore';
import type { NativeVoiceInfo } from '../../lib/local-inference/native/nativeProtocol';
import {
  useGeminiSettings,
  useUpdateGemini,
  useLocalNativeSettings,
  useOpenAICompatibleSettings,
  useOpenAISettings,
  useOpenAITranslateSettings,
  useProvider,
} from '../../stores/settingsStore';
import { useIsSessionActive } from '../../stores/sessionStore';
import { Provider } from '../../types/Provider';
import {
  OPENAI_SPEECH_MODEL,
  OPENAI_SPEECH_VOICES,
  OPENAI_SPEECH_VIBES,
  DEFAULT_OPENAI_SPEECH_VIBE,
  createOpenAISpeech,
  isOpenAISpeechProvider,
  translateWithOpenAI,
} from '../../lib/openai/openaiSpeech';
import {
  GEMINI_TTS_DEFAULT_MODEL,
  GEMINI_SPEECH_VOICES,
  GEMINI_SPEECH_EMOTIONS,
  DEFAULT_GEMINI_EMOTION,
  createGeminiSpeech,
  translateWithGemini,
} from '../../lib/gemini/geminiSpeech';
import { getLanguageDisplayName, getLanguageOption, LANGUAGE_OPTIONS, sortLanguageOptions } from '../../utils/languages';
import { formatBytes } from '../../lib/local-inference/formatBytes';
import { encodeMonoFloat32Wav } from '../../utils/ttsAudioExport';
import { downloadFile, formatTimestampForFilename } from '../../utils/conversationExport';
import { silenceForKokoroSegment, splitKokoroText } from '../../utils/kokoroText';
import './TextToSpeechDialog.scss';

interface TextToSpeechDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  initialText?: string;
  initialLanguage?: string;
}

interface LiveClient {
  key: string;
  client: NativeTtsClient;
}

interface LiveTranslationClient {
  key: string;
  client: NativeTranslateClient | TranslationEngine;
}

type TextToSpeechMode = 'direct' | 'translate';
export type TtsEngineType = 'auto' | 'gemini' | 'openai' | 'local';

export const TTS_MAX_TEXT_LENGTH = 10_000;

const TTS_LANGUAGE_STORAGE_KEY = 'mao-chat.tts.tool.language';
const TTS_VOICE_STORAGE_PREFIX = 'mao-chat.tts.tool.voice.';
const TTS_VIBE_STORAGE_KEY = 'mao-chat.tts.tool.vibe';
const TTS_ENGINE_STORAGE_KEY = 'mao-chat.tts.tool.engine';
const TTS_GEMINI_EMOTION_STORAGE_KEY = 'mao-chat.tts.tool.gemini.emotion';
const TTS_GEMINI_CUSTOM_PROMPT_STORAGE_KEY = 'mao-chat.tts.tool.gemini.custom_prompt';

function readStoredLanguage(fallback: string, allowed: readonly string[]): string {
  try {
    const stored = localStorage.getItem(TTS_LANGUAGE_STORAGE_KEY);
    if (stored && (allowed.length === 0 || allowed.includes(stored) || allowed.includes('multi'))) {
      return stored;
    }
  } catch { /* localStorage can be unavailable in a hardened renderer. */ }
  if (allowed.includes(fallback) || allowed.includes('multi') || allowed.length === 0) return fallback;
  return allowed[0] || 'en';
}

function readStoredVoice(modelId: string, language: string, fallback: string): string {
  try {
    return localStorage.getItem(`${TTS_VOICE_STORAGE_PREFIX}${modelId}.${language}`) || fallback;
  } catch {
    return fallback;
  }
}

/** Prefer human names from the catalog/sidecar; fall back to a cleaned raw id. */
function voiceLabel(voice: NativeVoiceInfo): string {
  const gv = GEMINI_SPEECH_VOICES.find((v) => v.id === voice.name);
  if (gv) return gv.name;

  if (voice.language) {
    const lang = voice.language.toUpperCase();
    const pretty = voice.name.includes('_')
      ? voice.name.split('_').slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
      : voice.name;
    const tags = [
      voice.default ? 'default' : '',
      voice.curated ? 'curated' : '',
      lang,
    ].filter(Boolean);
    return tags.length ? `${pretty} (${tags.join(' · ')})` : pretty;
  }
  return voice.name;
}

const joinChunks = (chunks: readonly Float32Array[]): Float32Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
};

/** Kokoro follows the official pipeline and only splits at explicit pause tags. */
function speechSegmentsForModel(modelId: string, text: string) {
  if (modelId.includes('kokoro')) return splitKokoroText(text);
  return [{ text, pauseMs: 0, explicitPause: false as boolean | undefined }];
}

const TextToSpeechDialog: React.FC<TextToSpeechDialogProps> = ({
  isOpen,
  onClose,
  onOpenSettings,
  initialText,
  initialLanguage,
}) => {
  const { t, i18n } = useTranslation();
  const provider = useProvider();
  const openaiSettings = useOpenAISettings();
  const openaiTranslateSettings = useOpenAITranslateSettings();
  const openaiCompatibleSettings = useOpenAICompatibleSettings();
  const geminiSettings = useGeminiSettings();
  const updateGemini = useUpdateGemini();
  const settings = useLocalNativeSettings();
  const catalog = useNativeCatalog();

  const [engine, setEngine] = useState<TtsEngineType>(() => {
    try {
      return (localStorage.getItem(TTS_ENGINE_STORAGE_KEY) as TtsEngineType) || 'auto';
    } catch {
      return 'auto';
    }
  });

  const effectiveEngine = useMemo<Exclude<TtsEngineType, 'auto'>>(() => {
    if (engine === 'gemini') return 'gemini';
    if (engine === 'openai') return 'openai';
    if (engine === 'local') return 'local';
    if (provider === Provider.GEMINI) return 'gemini';
    if (isOpenAISpeechProvider(provider)) return 'openai';
    return 'local';
  }, [engine, provider]);

  const isGeminiSpeech = effectiveEngine === 'gemini';
  const isOpenAISpeech = effectiveEngine === 'openai';

  const geminiApiKey = geminiSettings.apiKey || '';
  const [editingGeminiKey, setEditingGeminiKey] = useState(false);
  const [tempGeminiKey, setTempGeminiKey] = useState('');

  const [geminiEmotionId, setGeminiEmotionId] = useState<string>(() => {
    try {
      return localStorage.getItem(TTS_GEMINI_EMOTION_STORAGE_KEY) || DEFAULT_GEMINI_EMOTION;
    } catch {
      return DEFAULT_GEMINI_EMOTION;
    }
  });
  const [customEmotionPrompt, setCustomEmotionPrompt] = useState<string>(() => {
    try {
      return localStorage.getItem(TTS_GEMINI_CUSTOM_PROMPT_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });

  const geminiVoices = useMemo<NativeVoiceInfo[]>(
    () => GEMINI_SPEECH_VOICES.map((item, index) => ({
      name: item.id,
      language: 'multi',
      curated: true,
      unstable: false,
      default: index === 0,
    })),
    [],
  );

  const cloudApiKey = provider === Provider.OPENAI_COMPATIBLE
    ? openaiCompatibleSettings.apiKey
    : (provider === Provider.OPENAI_TRANSLATE
      ? (openaiTranslateSettings.apiKey || openaiSettings.apiKey)
      : openaiSettings.apiKey);
  const cloudApiHost = provider === Provider.OPENAI_COMPATIBLE
    ? openaiCompatibleSettings.customEndpoint
    : undefined;
  const cloudVoices = useMemo<NativeVoiceInfo[]>(
    () => OPENAI_SPEECH_VOICES.map((name, index) => ({
      name,
      language: 'multi',
      curated: true,
      unstable: false,
      default: index === 0,
    })),
    [],
  );
  const statuses = useNativeModelStatuses();
  const modelProgress = useNativeModelProgress();
  const modelErrors = useNativeModelErrors();
  const sidecarStatus = useNativeSidecarStatus();
  const isSessionActive = useIsSessionActive();
  const [mode, setMode] = useState<TextToSpeechMode>('direct');
  const [text, setText] = useState(() => initialText || '');
  const [sourceLanguage, setSourceLanguage] = useState(settings.sourceLanguage || 'zh');
  const [language, setLanguage] = useState(() => initialLanguage || settings.targetLanguage || 'en');

  useEffect(() => {
    if (initialText) {
      setText(initialText);
      setMode('direct');
    }
  }, [initialText]);

  useEffect(() => {
    if (initialLanguage) {
      setLanguage(initialLanguage);
    }
  }, [initialLanguage]);
  const [voice, setVoice] = useState('');
  const [vibeId, setVibeId] = useState(() => {
    try {
      return localStorage.getItem(TTS_VIBE_STORAGE_KEY) || DEFAULT_OPENAI_SPEECH_VIBE;
    } catch {
      return DEFAULT_OPENAI_SPEECH_VIBE;
    }
  });
  const selectedVibe = OPENAI_SPEECH_VIBES.find((item) => item.id === vibeId) ?? OPENAI_SPEECH_VIBES[0];
  const [voices, setVoices] = useState<NativeVoiceInfo[]>([]);
  const [checkingModel, setCheckingModel] = useState(false);
  const [speed, setSpeed] = useState(settings.ttsSpeed || 1);
  const [translating, setTranslating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [wav, setWav] = useState<ArrayBuffer | null>(null);
  const [generationMs, setGenerationMs] = useState<number | null>(null);
  const [translatedText, setTranslatedText] = useState('');
  const [translationMs, setTranslationMs] = useState<number | null>(null);
  const [translationEdited, setTranslationEdited] = useState(false);
  const clientRef = useRef<LiveClient | null>(null);
  const translationClientRef = useRef<LiveTranslationClient | null>(null);
  const audioUrlRef = useRef('');
  const runRef = useRef(0);

  // Follow the TTS model chosen in Settings (native catalog), not a hard-coded Kokoro id.
  // Gemini / OpenAI use cloud Speech generation instead.
  const selectedModelId = isGeminiSpeech
    ? GEMINI_TTS_DEFAULT_MODEL
    : (isOpenAISpeech
      ? OPENAI_SPEECH_MODEL
      : (resolveNativeTts(settings.ttsModel, language, catalog)
        || (settings.ttsModel && settings.ttsModel !== 'off' ? settings.ttsModel : '')
        || ''));
  const selectedModel = selectedModelId ? catalog[selectedModelId] : undefined;
  const selectedStatus = isGeminiSpeech
    ? (geminiApiKey ? 'ready' : 'absent')
    : (isOpenAISpeech
      ? (cloudApiKey ? 'ready' : 'absent')
      : (selectedModelId ? statuses[selectedModelId] : undefined));
  const downloadProgress = (selectedModelId && modelProgress[selectedModelId]) || { downloaded: 0, total: 0 };
  const modelError = (selectedModelId && modelErrors[selectedModelId]) || '';
  const ttsVariant = selectedModelId
    ? settings.translationVariantByModel[selectedModelId]
    : undefined;
  const capability = (isGeminiSpeech || isOpenAISpeech)
    ? { builtin: 'named' as const, custom: 'none' as const }
    : voiceCapability(selectedModel);
  const translationModelId = resolveNativeTranslation(settings.translationModel) || 'qwen2.5-0.5b';
  const translationModel = catalog[translationModelId];
  const translationStatus = statuses[translationModelId];
  const translationIsOnline = isNativeOnlineTranslation(translationModelId);

  const modelLanguages = useMemo(() => {
    if (isGeminiSpeech) {
      return ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'it', 'ru', 'vi', 'th', 'ar', 'hi'];
    }
    if (isOpenAISpeech) return ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'ru', 'vi', 'th'];
    const langs = selectedModel?.languages?.filter((l) => l && l !== 'multi') || [];
    if (langs.length > 0) return langs;
    // multi / unknown: expose common UI languages
    return ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es'];
  }, [isGeminiSpeech, isOpenAISpeech, selectedModel]);

  const languageOptions = useMemo(
    () => sortLanguageOptions(modelLanguages.map(getLanguageOption)),
    [modelLanguages],
  );

  const voiceOptions = useMemo(() => {
    // Prefer language-matched voices; if none match (e.g. Qwen3 CustomVoice
    // has zh/en/ja/ko tags but the UI language is something else), fall back
    // to the full list so the picker never shows "暂无可用声音" for a model
    // that does have speakers.
    const source = isGeminiSpeech ? geminiVoices : (isOpenAISpeech ? cloudVoices : voices);
    const matching = source.filter((item) => !item.language || item.language === language
      || item.language === 'multi');
    const list = matching.length > 0 ? matching : source;
    return [...list].sort((a, b) => {
      const aDef = Number(!!b.default) - Number(!!a.default);
      if (aDef !== 0) return aDef;
      const aCur = Number(!!b.curated) - Number(!!a.curated);
      if (aCur !== 0) return aCur;
      return a.name.localeCompare(b.name);
    });
  }, [isGeminiSpeech, geminiVoices, isOpenAISpeech, cloudVoices, language, voices]);

  const sourceLanguageOptions = useMemo(() => sortLanguageOptions(
    Object.values(LANGUAGE_OPTIONS).filter((option) => option.value !== 'mul'),
  ), []);

  const clearAudio = useCallback(() => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = '';
    setAudioUrl('');
    setWav(null);
    setGenerationMs(null);
  }, []);

  const clearResult = useCallback(() => {
    clearAudio();
    setTranslatedText('');
    setTranslationMs(null);
    setTranslationEdited(false);
  }, [clearAudio]);

  const disposeClient = useCallback(() => {
    const live = clientRef.current;
    clientRef.current = null;
    if (live) {
      live.client.cancel();
      live.client.dispose();
    }
  }, []);

  const disposeTranslationClient = useCallback(() => {
    const live = translationClientRef.current;
    translationClientRef.current = null;
    live?.client.dispose();
  }, []);

  // Keep language in the selected TTS model's support set.
  useEffect(() => {
    if (modelLanguages.includes(language) || selectedModel?.languages?.includes('multi')) return;
    const next = readStoredLanguage(settings.targetLanguage || 'en', modelLanguages);
    setLanguage(next);
  }, [language, modelLanguages, selectedModel, settings.targetLanguage]);

  useEffect(() => {
    if (!isOpen) return;
    if (isGeminiSpeech) {
      setCheckingModel(false);
      setVoices(geminiVoices);
      return;
    }
    if (isOpenAISpeech) {
      setCheckingModel(false);
      setVoices(cloudVoices);
      return;
    }
    if (sidecarStatus === 'starting') {
      setCheckingModel(true);
      return;
    }
    if (sidecarStatus === 'unavailable') {
      setCheckingModel(false);
      return;
    }
    let cancelled = false;
    setCheckingModel(true);
    void (async () => {
      const store = useNativeModelStore.getState();
      await store.ensureCatalog();
      const modelId = resolveNativeTts(settings.ttsModel, language, store.catalog)
        || (settings.ttsModel && settings.ttsModel !== 'off' ? settings.ttsModel : '')
        || selectedModelId;
      const refreshIds = [modelId, translationModelId].filter(Boolean) as string[];
      if (refreshIds.length) await store.refresh(refreshIds);
      let availableVoices: NativeVoiceInfo[] = [];
      if (modelId && voiceCapability(store.catalog[modelId]).builtin === 'named') {
        availableVoices = await nativeListTtsVoices(modelId);
      }
      if (!cancelled) {
        setVoices(availableVoices);
        setCheckingModel(false);
      }
    })().catch((cause) => {
      if (!cancelled) {
        setCheckingModel(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => { cancelled = true; };
  }, [cloudVoices, geminiVoices, isGeminiSpeech, isOpen, isOpenAISpeech, language, selectedModelId, settings.ttsModel, sidecarStatus, translationModelId]);

  // Resolve default / stored voice when model, language, or voice list changes.
  useEffect(() => {
    if (capability.builtin !== 'named') {
      if (capability.builtin === 'range') {
        const max = Math.max(0, (selectedModel?.numSpeakers ?? 1) - 1);
        const fromSettings = settings.ttsVoice?.startsWith('sid:')
          ? settings.ttsVoice.slice(4)
          : '';
        const n = Number(fromSettings);
        setVoice(Number.isFinite(n) ? String(Math.min(max, Math.max(0, n))) : '0');
      } else {
        setVoice('');
      }
      return;
    }
    const names = new Set(voiceOptions.map((item) => item.name));
    if (names.size > 0 && names.has(voice)) return;
    const settingsBuiltin = isGeminiSpeech
      ? ''
      : (isOpenAISpeech
        ? (openaiSettings.voice || '')
        : (settings.ttsVoice?.startsWith('builtin:')
          ? settings.ttsVoice.slice('builtin:'.length)
          : ''));
    const fallbackId = isGeminiSpeech
      ? (voiceOptions[0]?.name || 'Puck')
      : (isOpenAISpeech
        ? (voiceOptions[0]?.name || 'alloy')
        : (defaultTtsVoice(language, voices).replace(/^builtin:/, '')
          || voiceOptions[0]?.name
          || ''));
    const next = readStoredVoice(
      selectedModelId,
      language,
      (settingsBuiltin && names.has(settingsBuiltin) ? settingsBuiltin : '') || fallbackId,
    );
    setVoice(next);
  }, [
    capability.builtin,
    isGeminiSpeech,
    isOpenAISpeech,
    language,
    openaiSettings.voice,
    selectedModel?.numSpeakers,
    selectedModelId,
    settings.ttsVoice,
    voice,
    voiceOptions,
    voices,
  ]);

  useEffect(() => {
    if (!selectedModelId || !voice) return;
    try {
      localStorage.setItem(TTS_LANGUAGE_STORAGE_KEY, language);
      localStorage.setItem(`${TTS_VOICE_STORAGE_PREFIX}${selectedModelId}.${language}`, voice);
      if (isOpenAISpeech) localStorage.setItem(TTS_VIBE_STORAGE_KEY, vibeId);
      if (isGeminiSpeech) {
        localStorage.setItem(TTS_GEMINI_EMOTION_STORAGE_KEY, geminiEmotionId);
        localStorage.setItem(TTS_GEMINI_CUSTOM_PROMPT_STORAGE_KEY, customEmotionPrompt);
      }
      localStorage.setItem(TTS_ENGINE_STORAGE_KEY, engine);
    } catch { /* Persisting preferences is best-effort. */ }
  }, [customEmotionPrompt, engine, geminiEmotionId, isGeminiSpeech, isOpenAISpeech, language, selectedModelId, vibeId, voice]);

  useEffect(() => {
    if (isOpen) return;
    runRef.current += 1;
    setTranslating(false);
    setGenerating(false);
    setError('');
    disposeClient();
    disposeTranslationClient();
    clearResult();
  }, [clearResult, disposeClient, disposeTranslationClient, isOpen]);

  useEffect(() => () => {
    runRef.current += 1;
    disposeClient();
    disposeTranslationClient();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  }, [disposeClient, disposeTranslationClient]);

  const downloadTtsModel = useCallback(async () => {
    if (!selectedModelId) return;
    setError('');
    const store = useNativeModelStore.getState();
    await store.ensureCatalog();
    await store.download(selectedModelId);
    const latestError = useNativeModelStore.getState().errors[selectedModelId];
    if (latestError) setError(latestError);
    if (voiceCapability(store.catalog[selectedModelId]).builtin === 'named') {
      const availableVoices = await nativeListTtsVoices(selectedModelId);
      if (availableVoices.length > 0) setVoices(availableVoices);
    }
  }, [selectedModelId]);

  const cancelTtsDownload = useCallback(() => {
    if (!selectedModelId) return;
    void useNativeModelStore.getState().cancelDownload(selectedModelId);
  }, [selectedModelId]);

  const translate = useCallback(async () => {
    const value = text.trim();
    if (!value || translating || generating || isSessionActive) return;
    if (isGeminiSpeech && !geminiApiKey) {
      setError(t('ttsTool.geminiKeyRequired', '请先填写 Google Gemini API Key。'));
      return;
    }
    if (isOpenAISpeech && !cloudApiKey) {
      setError(t('ttsTool.openaiKeyRequired', '请先在设置中填写 OpenAI API Key。'));
      return;
    }
    if (!isGeminiSpeech && !isOpenAISpeech && !translationIsOnline
      && (translationStatus === 'absent' || translationStatus === 'downloading')) {
      setError(t('ttsTool.translationModelNotReady', '当前翻译模型尚未下载完成，请先到设置中下载。'));
      return;
    }

    const run = runRef.current + 1;
    runRef.current = run;
    setTranslating(true);
    setError('');
    clearAudio();

    try {
      let result = '';
      let inferenceTimeMs = 0;
      if (isGeminiSpeech) {
        const translation = await translateWithGemini({
          apiKey: geminiApiKey,
          text: value,
          sourceLanguage,
          targetLanguage: language,
        });
        result = translation.translatedText.trim();
        inferenceTimeMs = translation.inferenceTimeMs;
      } else if (isOpenAISpeech) {
        const translation = await translateWithOpenAI({
          apiKey: cloudApiKey,
          apiHost: cloudApiHost,
          text: value,
          sourceLanguage,
          targetLanguage: language,
        });
        result = translation.translatedText.trim();
        inferenceTimeMs = translation.inferenceTimeMs;
      } else {
        const variant = settings.translationVariantByModel[translationModelId];
        const translationKey = [
          translationModelId,
          settings.translationDevice,
          sourceLanguage,
          language,
          variant || '',
          selectedModelId,
          settings.deeplApiKey || '',
        ].join('|');
        let translationLive = translationClientRef.current;
        if (!translationLive || translationLive.key !== translationKey) {
          disposeTranslationClient();
          if (translationIsOnline) {
            const client = new TranslationEngine();
            await client.init(sourceLanguage, language, translationModelId, {
              apiKey: settings.deeplApiKey,
            });
            translationLive = { key: translationKey, client };
          } else {
            const client = new NativeTranslateClient();
            await client.init(
              sourceLanguage,
              language,
              translationModelId,
              settings.translationDevice,
              null,
              selectedModelId,
              variant,
            );
            translationLive = { key: translationKey, client };
          }
          translationClientRef.current = translationLive;
        }
        const translation = await translationLive.client.translate(
          value,
          translationIsOnline ? '' : buildDefaultLocalPrompt(sourceLanguage, language),
          !translationIsOnline,
        );
        result = translation.translatedText.trim();
        inferenceTimeMs = translation.inferenceTimeMs;
      }
      if (runRef.current !== run) return;
      if (!result) throw new Error(t('ttsTool.emptyTranslation', '翻译结果为空，无法生成语音。'));
      setTranslatedText(result);
      setTranslationMs(inferenceTimeMs);
      setTranslationEdited(false);
    } catch (cause) {
      if (runRef.current !== run) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (runRef.current === run) setTranslating(false);
    }
  }, [
    clearAudio,
    cloudApiHost,
    cloudApiKey,
    disposeTranslationClient,
    geminiApiKey,
    generating,
    isGeminiSpeech,
    isOpenAISpeech,
    isSessionActive,
    language,
    selectedModelId,
    settings.deeplApiKey,
    settings.translationDevice,
    settings.translationVariantByModel,
    sourceLanguage,
    t,
    text,
    translating,
    translationIsOnline,
    translationModelId,
    translationStatus,
  ]);

  const generate = useCallback(async () => {
    const speechText = mode === 'translate' ? translatedText.trim() : text.trim();
    if (!speechText || generating || translating || isSessionActive) return;
    if (isGeminiSpeech) {
      if (!geminiApiKey) {
        setError(t('ttsTool.geminiKeyRequired', '请先填写 Google Gemini API Key。'));
        return;
      }
    } else if (isOpenAISpeech) {
      if (!cloudApiKey) {
        setError(t('ttsTool.openaiKeyRequired', '请先在设置中填写 OpenAI API Key。'));
        return;
      }
      if (speechText.length > 4096) {
        setError(t('ttsTool.openaiLimitExceeded', 'OpenAI 官方接口单次最多支持 4096 字符。如需转换超长文本，请使用本地 Kokoro 模型。'));
        return;
      }
    } else {
      if (!selectedModelId) {
        setError(t('ttsTool.noTtsModel', '请先在设置中选择一个语音合成（TTS）模型。'));
        return;
      }
      if (selectedStatus !== 'ready') {
        setError(t('ttsTool.modelNotReady', '当前 TTS 模型尚未下载完成，请先点击下载模型。'));
        return;
      }
    }

    const run = runRef.current + 1;
    runRef.current = run;
    setGenerating(true);
    setError('');
    clearAudio();

    try {
      if (isGeminiSpeech) {
        const started = performance.now();
        const emotionPrompt = geminiEmotionId === 'custom'
          ? customEmotionPrompt.trim()
          : (GEMINI_SPEECH_EMOTIONS.find((e) => e.id === geminiEmotionId)?.prompt || '');
        const nextWav = await createGeminiSpeech({
          apiKey: geminiApiKey,
          text: speechText,
          voice: voice || 'Puck',
          emotionPrompt,
          speed,
        });
        if (runRef.current !== run) return;
        const nextUrl = URL.createObjectURL(new Blob([nextWav], { type: 'audio/wav' }));
        audioUrlRef.current = nextUrl;
        setWav(nextWav);
        setAudioUrl(nextUrl);
        setGenerationMs(Math.round(performance.now() - started));
        return;
      }

      if (isOpenAISpeech) {
        const started = performance.now();
        const nextWav = await createOpenAISpeech({
          apiKey: cloudApiKey,
          apiHost: cloudApiHost,
          text: speechText,
          voice: voice || 'alloy',
          speed,
          instructions: selectedVibe.instructions,
        });
        if (runRef.current !== run) return;
        const nextUrl = URL.createObjectURL(new Blob([nextWav], { type: 'audio/wav' }));
        audioUrlRef.current = nextUrl;
        setWav(nextWav);
        setAudioUrl(nextUrl);
        setGenerationMs(Math.round(performance.now() - started));
        return;
      }

      const device = settings.ttsDevice || 'auto';
      const key = [selectedModelId, device, language, voice, ttsVariant || ''].join('|');

      let live = clientRef.current;
      if (!live || live.key !== key) {
        disposeClient();
        const client = new NativeTtsClient();
        await client.init(selectedModelId, device, language, ttsVariant);
        if (capability.builtin === 'named' && voice) {
          await client.setVoice(voice);
        } else if (capability.builtin === 'range') {
          await client.setSpeaker(Number(voice) || 0);
        }
        live = { key, client };
        clientRef.current = live;
      }

      const speechSegments = speechSegmentsForModel(selectedModelId, speechText);
      const chunks: Float32Array[] = [];
      let sampleRate = 24_000;
      let totalGenerationMs = 0;

      for (let index = 0; index < speechSegments.length; index += 1) {
        const segment = speechSegments[index];
        if (segment.text) {
          const streamedChunks: Float32Array[] = [];
          const result = await live.client.generate(
            segment.text,
            speed,
            (chunk) => streamedChunks.push(chunk.slice()),
          );
          if (runRef.current !== run) return;
          sampleRate = result.sampleRate || sampleRate;
          totalGenerationMs += result.generationTimeMs;
          const generated = result.samples.length > 0 ? result.samples : joinChunks(streamedChunks);
          if (generated.length > 0) chunks.push(generated);
        }
        if (
          selectedModelId.includes('kokoro')
          && segment.pauseMs > 0
          && (segment.explicitPause || index < speechSegments.length - 1)
        ) {
          chunks.push(silenceForKokoroSegment(segment, sampleRate, speed));
        }
      }

      const samples = joinChunks(chunks);
      if (samples.length === 0) throw new Error(t('ttsTool.emptyAudio', '模型没有生成音频，请检查语言和声音设置。'));

      const nextWav = encodeMonoFloat32Wav(samples, sampleRate);
      const nextUrl = URL.createObjectURL(new Blob([nextWav], { type: 'audio/wav' }));
      audioUrlRef.current = nextUrl;
      setWav(nextWav);
      setAudioUrl(nextUrl);
      setGenerationMs(totalGenerationMs);
      // A successful generation proves the Native sidecar is ready. Recover a
      // voice picker that raced first boot on a newly installed machine.
      if (capability.builtin === 'named' && voices.length === 0) {
        void nativeListTtsVoices(selectedModelId).then((availableVoices) => {
          if (availableVoices.length > 0) setVoices(availableVoices);
        });
      }
    } catch (cause) {
      if (runRef.current !== run) return;
      disposeClient();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (runRef.current === run) setGenerating(false);
    }
  }, [
    capability.builtin,
    clearAudio,
    cloudApiHost,
    cloudApiKey,
    customEmotionPrompt,
    disposeClient,
    geminiApiKey,
    geminiEmotionId,
    generating,
    isGeminiSpeech,
    isOpenAISpeech,
    isSessionActive,
    language,
    mode,
    selectedModelId,
    selectedStatus,
    selectedVibe.instructions,
    settings.ttsDevice,
    speed,
    t,
    text,
    translatedText,
    translating,
    ttsVariant,
    voice,
    voices.length,
  ]);

  const save = useCallback(() => {
    if (!wav) return;
    downloadFile(
      wav,
      `mao-chat-tts-${formatTimestampForFilename(Date.now())}.wav`,
      'audio/wav',
    );
  }, [wav]);

  const changeLanguage = useCallback((nextLanguage: string) => {
    setLanguage(nextLanguage);
    clearResult();
    setError('');
  }, [clearResult]);

  const modelName = isGeminiSpeech
    ? 'Google Gemini 3.8 Flash TTS'
    : (isOpenAISpeech
      ? t('ttsTool.openaiSpeechTitle', 'OpenAI Speech')
      : (selectedModel?.name
        || (selectedModelId
          ? selectedModelId
          : t('ttsTool.noTtsModelTitle', '未选择 TTS 模型'))));
  const translationModelName = isGeminiSpeech
    ? 'gemini-3.8-flash-tts'
    : (isOpenAISpeech
      ? 'gpt-4o-mini'
      : (translationModel?.name || translationModelId));
  const progressTotal = downloadProgress.total || selectedModel?.sizeBytes || 0;
  const progressPercent = progressTotal > 0
    ? Math.min(100, Math.round((downloadProgress.downloaded / progressTotal) * 100))
    : 0;
  const modelReady = selectedStatus === 'ready';
  const modelSubtitle = isGeminiSpeech
    ? `${GEMINI_TTS_DEFAULT_MODEL} · ${t('ttsTool.geminiVoicesCount', '13 种高表现力音色 · 支持情感与风格控制')}`
    : (isOpenAISpeech
      ? `${OPENAI_SPEECH_MODEL} · ${t('ttsTool.openaiSpeechVoices', '13 种声音')}`
      : [
        selectedModel?.languages?.includes('multi')
          ? t('ttsTool.multiLanguage', '多语言')
          : (selectedModel?.languages?.join(' · ') || ''),
        selectedModel?.streaming ? t('ttsTool.streaming', '流式') : '',
        settings.ttsDevice && settings.ttsDevice !== 'auto'
          ? settings.ttsDevice.toUpperCase()
          : t('ttsTool.deviceAuto', '设备自动'),
      ].filter(Boolean).join(' · '));

  if (!isOpen) return null;

  // Renders as a main-window panel (same chrome as the conversation view),
  // not a floating Modal — title bar "文本转语音" toggles this surface.
  return (
    <section
      className="text-to-speech-panel"
      aria-label={t('ttsTool.title', '文本转语音')}
    >
      <header className="text-to-speech-panel__header">
        <div className="text-to-speech-panel__title">
          <Volume2 size={18} />
          <h2>{t('ttsTool.title', '文本转语音')}</h2>
        </div>
        <button
          type="button"
          className="text-to-speech-panel__close"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          title={t('ttsTool.backToSession', '返回实时翻译')}
        >
          <X size={18} />
        </button>
      </header>
      <div className="text-to-speech text-to-speech--panel">
        <div className="text-to-speech__engine-bar">
          <label className="text-to-speech__engine-label">
            <Sparkles size={16} className="text-to-speech__engine-icon" />
            <span>{t('ttsTool.engine', '语音引擎')}</span>
            <select
              value={engine}
              onChange={(event) => {
                setEngine(event.target.value as TtsEngineType);
                clearAudio();
                setError('');
              }}
            >
              <option value="auto">
                {t('ttsTool.engineAuto', '跟随全局服务商')} ({provider})
              </option>
              <option value="gemini">Google Gemini 3.8 Flash TTS（推荐 · 情感表现力）</option>
              <option value="openai">OpenAI Speech（13 种声音）</option>
              <option value="local">本地离线模型（Kokoro / Qwen3）</option>
            </select>
          </label>
        </div>

        <div className="text-to-speech__mode" role="group" aria-label={t('ttsTool.mode', '转换方式')}>
          <button
            type="button"
            className={mode === 'direct' ? 'is-active' : ''}
            onClick={() => { setMode('direct'); clearResult(); setError(''); }}
          >
            <Volume2 size={16} />
            <span>{t('ttsTool.directMode', '直接转语音')}</span>
          </button>
          <button
            type="button"
            className={mode === 'translate' ? 'is-active' : ''}
            onClick={() => { setMode('translate'); clearResult(); setError(''); }}
          >
            <Languages size={16} />
            <span>{t('ttsTool.translateMode', '翻译后转语音')}</span>
          </button>
        </div>

        <div className={`text-to-speech__model-card${modelReady ? ' is-ready' : ''}`}>
          <div className="text-to-speech__model-icon"><Volume2 size={18} /></div>
          <div className="text-to-speech__model-copy">
            <strong>{modelName}</strong>
            <span>
              {modelSubtitle || t('ttsTool.followsSettings', '跟随设置中的 TTS 模型')}
            </span>
            <small>
              {isGeminiSpeech
                ? (geminiApiKey
                  ? t('ttsTool.geminiReadyHint', '已配置 Gemini API Key，支持自由情感风格调节')
                  : t('ttsTool.geminiKeyRequired', '需要配置 Google Gemini API Key（支持免费层）'))
                : isOpenAISpeech
                  ? (cloudApiKey
                    ? t('ttsTool.openaiSpeechHint', '使用当前 OpenAI API Key 生成语音')
                    : t('ttsTool.openaiKeyRequired', '请先在设置中填写 OpenAI API Key。'))
                  : (selectedModelId
                    ? t('ttsTool.modelDownloadHint', '模型文件单独下载，不包含在安装包中')
                    : t('ttsTool.pickTtsInSettings', '请到设置 → 模型管理 → TTS 中选择模型'))}
              {!isGeminiSpeech && !isOpenAISpeech && progressTotal > 0 ? ` · ${formatBytes(progressTotal)}` : ''}
            </small>
          </div>
          <div className="text-to-speech__model-actions">
            {isGeminiSpeech ? (
              geminiApiKey ? (
                <>
                  <span className="text-to-speech__ready"><CircleCheck size={16} />{t('ttsTool.ready', '已就绪')}</span>
                  <button
                    type="button"
                    className="text-to-speech__download-model"
                    onClick={() => {
                      setTempGeminiKey(geminiApiKey);
                      setEditingGeminiKey((prev) => !prev);
                    }}
                    title={t('ttsTool.editKey', '修改 Key')}
                  >
                    <Settings2 size={16} />
                    {t('ttsTool.editKey', '修改 Key')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="text-to-speech__download-model"
                  onClick={() => {
                    setTempGeminiKey('');
                    setEditingGeminiKey(true);
                  }}
                >
                  <Settings2 size={16} />
                  {t('ttsTool.setGeminiKey', '填写 API Key')}
                </button>
              )
            ) : isOpenAISpeech ? (
              modelReady ? (
                <span className="text-to-speech__ready"><CircleCheck size={16} />{t('ttsTool.ready', '已就绪')}</span>
              ) : (
                <button type="button" className="text-to-speech__download-model" onClick={onOpenSettings}>
                  <Settings2 size={16} />
                  {t('ttsTool.openProviderSettings', '填写 API Key')}
                </button>
              )
            ) : !selectedModelId ? (
              <button type="button" className="text-to-speech__download-model" onClick={onOpenSettings}>
                <Settings2 size={16} />
                {t('ttsTool.openTtsSettings', '选择模型')}
              </button>
            ) : modelReady ? (
              <span className="text-to-speech__ready"><CircleCheck size={16} />{t('ttsTool.ready', '已就绪')}</span>
            ) : selectedStatus === 'downloading' ? (
              <button type="button" className="text-to-speech__download-cancel" onClick={cancelTtsDownload}>
                <X size={15} />{t('common.cancel', '取消')}
              </button>
            ) : (
              <button
                type="button"
                className="text-to-speech__download-model"
                disabled={checkingModel}
                onClick={() => { void downloadTtsModel(); }}
              >
                {checkingModel ? <LoaderCircle className="is-spinning" size={16} /> : <Download size={16} />}
                {checkingModel ? t('ttsTool.checking', '检查中…') : t('ttsTool.downloadModel', '下载模型')}
              </button>
            )}
            {!isGeminiSpeech && (
              <button type="button" className="text-to-speech__all-models" onClick={onOpenSettings} title={t('ttsTool.openTtsSettings', '选择模型')}>
                <Settings2 size={16} />
              </button>
            )}
          </div>
          {isGeminiSpeech && editingGeminiKey && (
            <div className="text-to-speech__key-input-row">
              <span className="text-to-speech__key-label">API Key</span>
              <input
                type="password"
                placeholder="输入 Google AI Studio API Key (AIza...)"
                value={tempGeminiKey}
                onChange={(event) => setTempGeminiKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    updateGemini({ apiKey: tempGeminiKey.trim() });
                    setEditingGeminiKey(false);
                  }
                }}
              />
              <button
                type="button"
                className="text-to-speech__key-save"
                onClick={() => {
                  updateGemini({ apiKey: tempGeminiKey.trim() });
                  setEditingGeminiKey(false);
                }}
              >
                {t('common.save', '保存')}
              </button>
              <button
                type="button"
                className="text-to-speech__key-cancel is-cancel"
                onClick={() => setEditingGeminiKey(false)}
              >
                {t('common.cancel', '取消')}
              </button>
            </div>
          )}
          {!isGeminiSpeech && !isOpenAISpeech && selectedStatus === 'downloading' && (
            <div className="text-to-speech__download-progress">
              <div><span style={{ width: `${progressPercent}%` }} /></div>
              <small>
                {progressPercent}%
                {progressTotal > 0
                  ? ` · ${formatBytes(downloadProgress.downloaded)} / ${formatBytes(progressTotal)}`
                  : ''}
              </small>
            </div>
          )}
          {modelError && <div className="text-to-speech__model-error">{modelError}</div>}
        </div>

        {mode === 'translate' && (
          <div className="text-to-speech__translation-model">
            <span>{t('ttsTool.translationModel', '翻译模型')}</span>
            <strong>{translationModelName}</strong>
            {!isGeminiSpeech && !isOpenAISpeech && (
              <button type="button" onClick={onOpenSettings}><Settings2 size={14} />更换</button>
            )}
          </div>
        )}

        {mode === 'translate' ? (
          <div className="text-to-speech__language-pair">
            <label className="text-to-speech__field">
              <span>{t('ttsTool.sourceLanguage', '原文语言')}</span>
              <select value={sourceLanguage} onChange={(event) => { setSourceLanguage(event.target.value); clearResult(); }}>
                {sourceLanguageOptions.map((option) => (
                  <option key={option.value} value={option.value}>{getLanguageDisplayName(option.value, i18n?.language || 'zh', option.name)}</option>
                ))}
              </select>
            </label>
            <ArrowRight size={18} />
            <label className="text-to-speech__field">
              <span>{t('ttsTool.outputLanguage', '语音语言')}</span>
              <select value={language} onChange={(event) => changeLanguage(event.target.value)}>
                {languageOptions.map((option) => (
                  <option key={option.value} value={option.value}>{getLanguageDisplayName(option.value, i18n?.language || 'zh', option.name)}</option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="text-to-speech__voice-controls">
            <label className="text-to-speech__field">
              <span>{t('ttsTool.language', '文本与语音语言')}</span>
              <select value={language} onChange={(event) => changeLanguage(event.target.value)}>
                {languageOptions.map((option) => (
                  <option key={option.value} value={option.value}>{getLanguageDisplayName(option.value, i18n?.language || 'zh', option.name)}</option>
                ))}
              </select>
            </label>
            {capability.builtin === 'named' && (
              <label className="text-to-speech__field">
                <span>{t('ttsTool.voice', '声音')}（{voiceOptions.length}）</span>
                <select value={voice} onChange={(event) => { setVoice(event.target.value); clearAudio(); setError(''); }}>
                  {voiceOptions.length > 0 ? voiceOptions.map((item) => (
                    <option key={item.name} value={item.name}>{voiceLabel(item)}</option>
                  )) : (
                    <option value="">{checkingModel
                      ? t('ttsTool.loadingVoices', '正在加载声音…')
                      : t('ttsTool.noVoices', '暂无可用声音')}</option>
                  )}
                </select>
              </label>
            )}
            {isGeminiSpeech && (
              <>
                <label className="text-to-speech__field">
                  <span>{t('ttsTool.geminiEmotion', '情感与风格')}</span>
                  <select
                    value={geminiEmotionId}
                    onChange={(event) => { setGeminiEmotionId(event.target.value); clearAudio(); setError(''); }}
                  >
                    {GEMINI_SPEECH_EMOTIONS.map((item) => (
                      <option key={item.id} value={item.id}>{item.nameZh} · {item.description}</option>
                    ))}
                  </select>
                </label>
                {geminiEmotionId === 'custom' && (
                  <div className="text-to-speech__custom-prompt-container">
                    <input
                      type="text"
                      placeholder={t('ttsTool.geminiCustomPromptPlaceholder', '例如：带着兴奋而激动的语气，语速稍快，像是在宣布重大喜讯…')}
                      value={customEmotionPrompt}
                      onChange={(event) => { setCustomEmotionPrompt(event.target.value); clearAudio(); setError(''); }}
                    />
                  </div>
                )}
              </>
            )}
            {isOpenAISpeech && (
              <label className="text-to-speech__field">
                <span>{t('ttsTool.vibe', 'Vibe')}</span>
                <select
                  value={vibeId}
                  onChange={(event) => { setVibeId(event.target.value); clearAudio(); setError(''); }}
                >
                  {OPENAI_SPEECH_VIBES.map((item) => (
                    <option key={item.id} value={item.id}>{item.nameZh} · {item.name}</option>
                  ))}
                </select>
              </label>
            )}
            {capability.builtin === 'range' && (
              <label className="text-to-speech__field">
                <span>{t('ttsTool.speakerId', '说话人 ID')}</span>
                <select value={voice} onChange={(event) => { setVoice(event.target.value); clearAudio(); setError(''); }}>
                  {Array.from({ length: Math.max(1, selectedModel?.numSpeakers ?? 1) }, (_, i) => (
                    <option key={i} value={String(i)}>{i}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {mode === 'translate' && capability.builtin === 'named' && (
          <label className="text-to-speech__field">
            <span>{t('ttsTool.voice', '声音')}（{voiceOptions.length}）</span>
            {/* Voice only affects TTS — keep the translation result when switching voices. */}
            <select value={voice} onChange={(event) => { setVoice(event.target.value); clearAudio(); setError(''); }}>
              {voiceOptions.length > 0 ? voiceOptions.map((item) => (
                <option key={item.name} value={item.name}>{voiceLabel(item)}</option>
              )) : (
                <option value="">{checkingModel
                  ? t('ttsTool.loadingVoices', '正在加载声音…')
                  : t('ttsTool.noVoices', '暂无可用声音')}</option>
              )}
            </select>
          </label>
        )}
        {mode === 'translate' && isGeminiSpeech && (
          <>
            <label className="text-to-speech__field">
              <span>{t('ttsTool.geminiEmotion', '情感与风格')}</span>
              <select
                value={geminiEmotionId}
                onChange={(event) => { setGeminiEmotionId(event.target.value); clearAudio(); setError(''); }}
              >
                {GEMINI_SPEECH_EMOTIONS.map((item) => (
                  <option key={item.id} value={item.id}>{item.nameZh} · {item.description}</option>
                ))}
              </select>
            </label>
            {geminiEmotionId === 'custom' && (
              <div className="text-to-speech__custom-prompt-container">
                <input
                  type="text"
                  placeholder={t('ttsTool.geminiCustomPromptPlaceholder', '例如：带着兴奋而激动的语气，语速稍快，像是在宣布重大喜讯…')}
                  value={customEmotionPrompt}
                  onChange={(event) => { setCustomEmotionPrompt(event.target.value); clearAudio(); setError(''); }}
                />
              </div>
            )}
          </>
        )}
        {mode === 'translate' && isOpenAISpeech && (
          <label className="text-to-speech__field">
            <span>{t('ttsTool.vibe', 'Vibe')}</span>
            <select
              value={vibeId}
              onChange={(event) => { setVibeId(event.target.value); clearAudio(); setError(''); }}
            >
              {OPENAI_SPEECH_VIBES.map((item) => (
                <option key={item.id} value={item.id}>{item.nameZh} · {item.name}</option>
              ))}
            </select>
          </label>
        )}
        {mode === 'translate' && capability.builtin === 'range' && (
          <label className="text-to-speech__field">
            <span>{t('ttsTool.speakerId', '说话人 ID')}</span>
            <select value={voice} onChange={(event) => { setVoice(event.target.value); clearAudio(); setError(''); }}>
              {Array.from({ length: Math.max(1, selectedModel?.numSpeakers ?? 1) }, (_, i) => (
                <option key={i} value={String(i)}>{i}</option>
              ))}
            </select>
          </label>
        )}

        <label className="text-to-speech__field">
          <span>{mode === 'translate'
            ? t('ttsTool.sourceTextLabel', '输入要翻译的原文')
            : t('ttsTool.inputLabel', '输入要转换为语音的文字')}</span>
          <textarea
            value={text}
            maxLength={TTS_MAX_TEXT_LENGTH}
            rows={6}
            placeholder={t('ttsTool.placeholder', '在这里输入文字…')}
            onChange={(event) => { setText(event.target.value); clearResult(); }}
          />
          <small>{text.length}/{TTS_MAX_TEXT_LENGTH}</small>
        </label>

        <label className="text-to-speech__speed">
          <span>{t('ttsTool.speed', '语速')}</span>
          <input
            type="range"
            min="0.7"
            max="1.3"
            step="0.05"
            value={speed}
            onChange={(event) => { setSpeed(Number(event.target.value)); clearAudio(); }}
          />
          <output>{speed.toFixed(2)}×</output>
        </label>

        {isSessionActive && (
          <div className="text-to-speech__notice">
            {t('ttsTool.sessionActive', '请先结束实时翻译会话，再使用独立文本转语音。')}
          </div>
        )}
        {mode === 'translate' && !translationIsOnline
          && (translationStatus === 'absent' || translationStatus === 'downloading') && (
          <div className="text-to-speech__notice text-to-speech__notice--error">
            {translationStatus === 'downloading'
              ? t('ttsTool.translationDownloading', '翻译模型正在下载，请稍后再试。')
              : t('ttsTool.translationModelNotReady', '当前翻译模型尚未下载完成，请先到设置中下载。')}
          </div>
        )}
        {error && <div className="text-to-speech__notice text-to-speech__notice--error">{error}</div>}

        {mode === 'translate' && translatedText && (
          <div className="text-to-speech__translation-result">
            <div>
              {translationEdited ? <PencilLine size={17} /> : <Languages size={17} />}
              <span>{t('ttsTool.translationResultEditable', '翻译结果（可编辑）')}</span>
              {translationEdited && <em>{t('ttsTool.edited', '已调整')}</em>}
              {translationMs != null && <small>{(translationMs / 1_000).toFixed(1)}s</small>}
            </div>
            <textarea
              aria-label={t('ttsTool.translationResultEditable', '翻译结果（可编辑）')}
              value={translatedText}
              maxLength={TTS_MAX_TEXT_LENGTH}
              rows={5}
              onChange={(event) => {
                setTranslatedText(event.target.value);
                setTranslationEdited(true);
                clearAudio();
              }}
            />
            <small>{translatedText.length}/{TTS_MAX_TEXT_LENGTH}</small>
            <p>{t('ttsTool.reviewTranslationHint', '请先检查或修改译文，确认合适后再生成语音。支持 [pause:1.5s] 自定义停顿。')}</p>
          </div>
        )}

        {audioUrl && (
          <div className="text-to-speech__preview">
            <div>
              <Volume2 size={17} />
              <span>{t('ttsTool.preview', '试听')}</span>
              {generationMs != null && <small>{(generationMs / 1_000).toFixed(1)}s</small>}
            </div>
            <audio controls src={audioUrl} />
          </div>
        )}

        <div className="text-to-speech__actions">
          {mode === 'translate' ? (
            <>
              <button
                type="button"
                className={`text-to-speech__button${translatedText ? '' : ' text-to-speech__button--primary'}`}
                disabled={!text.trim() || translating || generating || isSessionActive
                  || (!isGeminiSpeech && !isOpenAISpeech && !translationIsOnline
                    && (translationStatus === 'absent' || translationStatus === 'downloading'))}
                onClick={() => { void translate(); }}
              >
                {translating
                  ? <LoaderCircle className="is-spinning" size={17} />
                  : (translatedText ? <RefreshCw size={17} /> : <Languages size={17} />)}
                {translating
                  ? t('ttsTool.translating', '正在翻译…')
                  : (translatedText
                    ? t('ttsTool.retranslate', '重新翻译')
                    : t('ttsTool.translate', '翻译'))}
              </button>
              <button
                type="button"
                className="text-to-speech__button text-to-speech__button--primary"
                disabled={!translatedText.trim() || translating || generating || isSessionActive || !modelReady}
                onClick={() => { void generate(); }}
                title={!translatedText.trim()
                  ? t('ttsTool.generateNeedsTranslation', '请先翻译，再生成语音')
                  : undefined}
              >
                {generating
                  ? <LoaderCircle className="is-spinning" size={17} />
                  : <Play size={17} fill="currentColor" />}
                {generating
                  ? t('ttsTool.generating', '正在生成…')
                  : t('ttsTool.generateSpeech', '生成语音')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-to-speech__button text-to-speech__button--primary"
              disabled={!text.trim() || generating || translating || isSessionActive || !modelReady}
              onClick={() => { void generate(); }}
            >
              {generating ? <LoaderCircle className="is-spinning" size={17} /> : <Play size={17} fill="currentColor" />}
              {generating
                ? t('ttsTool.generating', '正在生成…')
                : t('ttsTool.generateSpeech', '生成语音')}
            </button>
          )}
          <button
            type="button"
            className="text-to-speech__button"
            disabled={!wav}
            onClick={save}
          >
            <Download size={17} />
            {t('ttsTool.download', '下载 WAV')}
          </button>
        </div>
      </div>
    </section>
  );
};

export default TextToSpeechDialog;
