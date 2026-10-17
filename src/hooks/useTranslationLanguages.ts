import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useProvider,
  useSettingsStore,
  useKizunaVolcengineAst2Settings,
  useLocalInferenceSettings,
  useLocalNativeSettings,
  useVolcengineAST2Settings,
  useZoomAISettings,
  useUpdateOpenAI,
  useUpdateGemini,
  useUpdateOpenAICompatible,
  useUpdatePalabraAI,
  useUpdateOpenAITranslate,
  useUpdateKizunaOpenaiTranslate,
  useUpdateKizunaVolcengineAst2,
  useUpdateKizunaSoniox,
  useUpdateLocalInference,
  useUpdateLocalNative,
  useUpdateVolcengineST,
  useUpdateVolcengineAST2,
  useUpdateZoomAI,
  useUpdateSoniox,
} from '../stores/settingsStore';
import type { SettingsStore } from '../stores/settingsStore';
import { Provider, kizunaBaseProvider } from '../types/Provider';
import { ProviderConfigFactory } from '../services/providers/ProviderConfigFactory';
import { resolveAST2LanguagePair } from '../services/providers/volcengineAST2LanguageSync';
import { useIsParticipantChannelInScope, useMode } from '../stores/audioStore';
import { shouldKeepCapturedAudioDirection } from '../components/MainPanel/participantDirection';
import { useAnalytics } from '../lib/analytics';
import { getTranslationTargetLanguages } from '../lib/local-inference/modelManifest';
import { useModelStore } from '../stores/modelStore';
import { useNativeModelStore } from '../stores/nativeModelStore';
import { preferLanguageSpecificStreamingAsr } from '../lib/local-inference/native/nativeCatalog';
import { isElectron, isExtension } from '../utils/environment';

/** Shared source/target language read+write used by Settings and the main page picker. */
export function useTranslationLanguages() {
  const { t } = useTranslation();
  const { trackEvent } = useAnalytics();
  const extensionExperience = isExtension();
  const provider = useProvider();
  const audioMode = useMode();
  const isParticipantChannelInScope = useIsParticipantChannelInScope();

  const kizunaVolcengineAst2Settings = useKizunaVolcengineAst2Settings();
  const localInferenceSettings = useLocalInferenceSettings();
  const localNativeSettings = useLocalNativeSettings();
  const volcengineAST2Settings = useVolcengineAST2Settings();
  const zoomAISettings = useZoomAISettings();

  const updateOpenAISettings = useUpdateOpenAI();
  const updateGeminiSettings = useUpdateGemini();
  const updateOpenAICompatibleSettings = useUpdateOpenAICompatible();
  const updatePalabraAISettings = useUpdatePalabraAI();
  const updateOpenAITranslateSettings = useUpdateOpenAITranslate();
  const updateKizunaOpenaiTranslateSettings = useUpdateKizunaOpenaiTranslate();
  const updateKizunaVolcengineAst2Settings = useUpdateKizunaVolcengineAst2();
  const updateKizunaSonioxSettings = useUpdateKizunaSoniox();
  const updateVolcengineSTSettings = useUpdateVolcengineST();
  const updateVolcengineAST2Settings = useUpdateVolcengineAST2();
  const updateLocalInferenceSettings = useUpdateLocalInference();
  const updateLocalNativeSettings = useUpdateLocalNative();
  const updateZoomAISettings = useUpdateZoomAI();
  const updateSonioxSettings = useUpdateSoniox();

  const effectiveProvider = kizunaBaseProvider(provider) ?? provider;
  const activeVolcengineAST2Settings =
    provider === Provider.KIZUNA_AI_VOLCENGINE_AST2
      ? kizunaVolcengineAst2Settings
      : volcengineAST2Settings;
  const updateActiveVolcengineAST2Settings =
    provider === Provider.KIZUNA_AI_VOLCENGINE_AST2
      ? updateKizunaVolcengineAst2Settings
      : updateVolcengineAST2Settings;

  const providerConfig = useMemo(() => {
    try {
      return ProviderConfigFactory.getConfig(provider);
    } catch {
      return ProviderConfigFactory.getConfig(Provider.OPENAI);
    }
  }, [provider]);

  const currentProviderSettings = useSettingsStore(
    (s) => s[ProviderConfigFactory.getDescriptor(s.provider).settingsSliceKey as keyof SettingsStore],
  ) as Record<string, any>;

  const sourceLanguage = currentProviderSettings?.sourceLanguage || 'auto';
  const targetLanguage = currentProviderSettings?.targetLanguage || 'en';

  const translationLanguagesDescription = audioMode === 'both'
    ? t('modePicker.descBoth', 'Two-way. Your mic language and the computer-audio language translate into each other. Both must be set — automatic detection cannot be used.')
    : audioMode === 'participant'
      ? t('modePicker.descOthers', "Computer audio → translated for you. Source is their language; target is the language you want to read.")
      : t('modePicker.descYou', 'Your microphone → spoken to others. Source is your language; target is the language they hear.');

  const sourceLanguageLabel = audioMode === 'both'
    ? t('simpleConfig.sourceLanguageBoth', 'What I speak')
    : extensionExperience && audioMode !== 'speaker'
      ? '视频语言'
      : t('simpleConfig.yourLanguage');
  const targetLanguageLabel = audioMode === 'both'
    ? t('simpleConfig.targetLanguageBoth', 'What they speak')
    : extensionExperience && audioMode !== 'speaker'
      ? '字幕语言'
      : t('simpleConfig.targetLanguage');

  const updateSourceLanguage = (value: string) => {
    switch (provider) {
      case Provider.OPENAI:
        updateOpenAISettings({ sourceLanguage: value });
        break;
      case Provider.GEMINI:
        updateGeminiSettings({ sourceLanguage: value });
        break;
      case Provider.OPENAI_COMPATIBLE:
        updateOpenAICompatibleSettings({ sourceLanguage: value });
        break;
      case Provider.PALABRA_AI:
        updatePalabraAISettings({ sourceLanguage: value });
        break;
      case Provider.OPENAI_TRANSLATE:
        updateOpenAITranslateSettings({ sourceLanguage: value });
        break;
      case Provider.KIZUNA_AI_OPENAI_TRANSLATE:
        updateKizunaOpenaiTranslateSettings({ sourceLanguage: value });
        break;
      case Provider.VOLCENGINE_ST:
        updateVolcengineSTSettings({ sourceLanguage: value });
        break;
      case Provider.VOLCENGINE_AST2:
      case Provider.KIZUNA_AI_VOLCENGINE_AST2: {
        const prev = activeVolcengineAST2Settings;
        const next = resolveAST2LanguagePair(
          { sourceLanguage: prev.sourceLanguage, targetLanguage: prev.targetLanguage },
          { side: 'source', value },
        );
        updateActiveVolcengineAST2Settings({
          sourceLanguage: next.sourceLanguage,
          targetLanguage: next.targetLanguage,
        });
        trackEvent('language_changed', {
          to_language: next.sourceLanguage,
          language_type: 'source',
        });
        if (next.targetLanguage !== prev.targetLanguage) {
          trackEvent('language_changed', {
            to_language: next.targetLanguage,
            language_type: 'target',
          });
        }
        return;
      }
      case Provider.LOCAL_INFERENCE: {
        const availableTargets = getTranslationTargetLanguages(value);
        const currentTarget = localInferenceSettings.targetLanguage;
        const nextTarget = availableTargets.some((item) => item.value === currentTarget)
          ? currentTarget
          : (availableTargets[0]?.value || 'en');
        const updates: Record<string, string> = { sourceLanguage: value };
        if (nextTarget !== currentTarget) updates.targetLanguage = nextTarget;
        const textOnly = useSettingsStore.getState().textOnly;
        const corrections = useModelStore.getState().autoSelectModels(
          value,
          nextTarget,
          localInferenceSettings.asrModel,
          localInferenceSettings.translationModel,
          localInferenceSettings.ttsModel,
          textOnly,
        );
        if (corrections?.asrModel) updates.asrModel = corrections.asrModel;
        if (corrections?.translationModel) updates.translationModel = corrections.translationModel;
        updateLocalInferenceSettings(updates);
        break;
      }
      case Provider.LOCAL_NATIVE: {
        const availableTargets = getTranslationTargetLanguages(value);
        const currentTarget = localNativeSettings.targetLanguage;
        const nextTarget = availableTargets.some((item) => item.value === currentTarget)
          ? currentTarget
          : (availableTargets[0]?.value || 'en');
        const updates: Record<string, string> = { sourceLanguage: value };
        if (!availableTargets.some((item) => item.value === currentTarget)) {
          updates.targetLanguage = nextTarget;
        }
        const nativeStore = useNativeModelStore.getState();
        const preferredAsr = preferLanguageSpecificStreamingAsr(
          value,
          localNativeSettings.asrModel,
          (id) => id !== null && nativeStore.statuses[id] === 'ready',
          nativeStore.catalog,
        );
        if (preferredAsr !== localNativeSettings.asrModel) {
          updates.asrModel = preferredAsr;
          nativeStore.rememberModels(value, nextTarget, {
            asrModel: preferredAsr,
            translationModel: localNativeSettings.translationModel,
            ttsModel: localNativeSettings.ttsModel,
          });
        }
        updateLocalNativeSettings(updates);
        break;
      }
      case Provider.ZOOM_AI: {
        updateZoomAISettings({
          sourceLanguage: value,
          targetLanguage: ProviderConfigFactory.getDescriptor(provider).reconcileTarget(value, zoomAISettings.targetLanguage),
        });
        break;
      }
      case Provider.SONIOX:
        updateSonioxSettings({ sourceLanguage: value });
        break;
      case Provider.KIZUNA_AI_SONIOX:
        updateKizunaSonioxSettings({ sourceLanguage: value });
        break;
    }
    trackEvent('language_changed', {
      to_language: value,
      language_type: 'source',
    });
  };

  const updateTargetLanguage = (value: string) => {
    switch (provider) {
      case Provider.OPENAI:
        updateOpenAISettings({ targetLanguage: value });
        break;
      case Provider.GEMINI:
        updateGeminiSettings({ targetLanguage: value });
        break;
      case Provider.OPENAI_COMPATIBLE:
        updateOpenAICompatibleSettings({ targetLanguage: value });
        break;
      case Provider.PALABRA_AI:
        updatePalabraAISettings({ targetLanguage: value });
        break;
      case Provider.OPENAI_TRANSLATE:
        updateOpenAITranslateSettings({ targetLanguage: value as any });
        break;
      case Provider.KIZUNA_AI_OPENAI_TRANSLATE:
        updateKizunaOpenaiTranslateSettings({ targetLanguage: value as any });
        break;
      case Provider.VOLCENGINE_ST:
        updateVolcengineSTSettings({ targetLanguage: value });
        break;
      case Provider.VOLCENGINE_AST2:
      case Provider.KIZUNA_AI_VOLCENGINE_AST2: {
        const prev = activeVolcengineAST2Settings;
        const next = resolveAST2LanguagePair(
          { sourceLanguage: prev.sourceLanguage, targetLanguage: prev.targetLanguage },
          { side: 'target', value },
        );
        updateActiveVolcengineAST2Settings({
          sourceLanguage: next.sourceLanguage,
          targetLanguage: next.targetLanguage,
        });
        if (next.sourceLanguage !== prev.sourceLanguage) {
          trackEvent('language_changed', {
            to_language: next.sourceLanguage,
            language_type: 'source',
          });
        }
        trackEvent('language_changed', {
          to_language: next.targetLanguage,
          language_type: 'target',
        });
        return;
      }
      case Provider.LOCAL_INFERENCE:
        updateLocalInferenceSettings({ targetLanguage: value });
        break;
      case Provider.LOCAL_NATIVE:
        updateLocalNativeSettings({ targetLanguage: value });
        break;
      case Provider.ZOOM_AI:
        updateZoomAISettings({ targetLanguage: value });
        break;
      case Provider.SONIOX:
        updateSonioxSettings({ targetLanguage: value });
        break;
      case Provider.KIZUNA_AI_SONIOX:
        updateKizunaSonioxSettings({ targetLanguage: value });
        break;
    }
    trackEvent('language_changed', {
      to_language: value,
      language_type: 'target',
    });
  };

  const swapLanguages = () => {
    const src = currentProviderSettings?.sourceLanguage;
    const tgt = currentProviderSettings?.targetLanguage;
    if (!tgt || src === 'zhen') return;

    // Left side is often "auto" on the launch page. Still swap: put the
    // current subtitle language on the left, and pick a concrete right side.
    if (!src || src === 'auto') {
      const targetList = providerConfig.targetLanguages ?? providerConfig.languages;
      const fallback = targetList.find((item) => item.value !== tgt)?.value
        || targetList[0]?.value
        || 'en';
      updateSourceLanguage(tgt);
      updateTargetLanguage(fallback);
      return;
    }

    if (provider === Provider.LOCAL_INFERENCE) {
      const availableTargets = getTranslationTargetLanguages(tgt);
      const newTarget = availableTargets.some((item) => item.value === src) ? src : availableTargets[0]?.value || 'en';
      updateLocalInferenceSettings({ sourceLanguage: tgt, targetLanguage: newTarget });
    } else if (effectiveProvider === Provider.VOLCENGINE_AST2) {
      updateActiveVolcengineAST2Settings({ sourceLanguage: tgt, targetLanguage: src });
      trackEvent('language_changed', { to_language: tgt, language_type: 'source' });
      trackEvent('language_changed', { to_language: src, language_type: 'target' });
    } else if (provider === Provider.ZOOM_AI) {
      const descriptor = ProviderConfigFactory.getDescriptor(provider);
      const sources = descriptor.resolveSourceLanguages().map((item) => item.value);
      if (!sources.includes(tgt)) return;
      const allowed = descriptor.resolveTargetLanguages(tgt).map((item) => item.value);
      const newTarget = allowed.includes(src) ? src : (allowed[0] || 'en-US');
      updateZoomAISettings({ sourceLanguage: tgt, targetLanguage: newTarget });
      trackEvent('language_changed', { to_language: tgt, language_type: 'source' });
      trackEvent('language_changed', { to_language: newTarget, language_type: 'target' });
    } else {
      updateSourceLanguage(tgt);
      const targetList = providerConfig.targetLanguages ?? providerConfig.languages;
      const newTarget = targetList.some((item) => item.value === src)
        ? src
        : (targetList[0]?.value ?? src);
      updateTargetLanguage(newTarget);
    }
  };

  const targetLanguages = useMemo(() => {
    if (provider === Provider.LOCAL_INFERENCE || provider === Provider.LOCAL_NATIVE) {
      return getTranslationTargetLanguages(sourceLanguage || 'ja');
    }
    if (provider === Provider.ZOOM_AI) {
      return ProviderConfigFactory.getDescriptor(provider).resolveTargetLanguages(sourceLanguage || 'ja-JP');
    }
    return providerConfig.targetLanguages ?? providerConfig.languages;
  }, [provider, providerConfig.languages, providerConfig.targetLanguages, sourceLanguage]);

  const showAutoSourceOption = provider !== Provider.LOCAL_INFERENCE
    && (provider !== Provider.LOCAL_NATIVE || localNativeSettings.asrModel === 'hayamimi-asr')
    && provider !== Provider.ZOOM_AI
    && (audioMode !== 'both' || sourceLanguage === 'auto');

  const canSwap = Boolean(
    targetLanguage
    && sourceLanguage !== 'zhen'
    && !(
      provider === Provider.ZOOM_AI
      && !ProviderConfigFactory.getDescriptor(provider).resolveSourceLanguages().some((item) => item.value === targetLanguage)
    ),
  );

  const showTranslateParticipantWarning = useMemo(() => {
    if (effectiveProvider !== Provider.OPENAI_TRANSLATE) return false;
    if (!isParticipantChannelInScope) return false;
    if (shouldKeepCapturedAudioDirection(provider, audioMode, {
      electron: isElectron(),
      extension: isExtension(),
    })) return false;
    const supportedTargets = ProviderConfigFactory.getDescriptor(Provider.OPENAI_TRANSLATE)
      .resolveTargetLanguages(sourceLanguage);
    return !supportedTargets.some((item) => item.value === sourceLanguage);
  }, [effectiveProvider, isParticipantChannelInScope, sourceLanguage, provider, audioMode]);

  const showSonioxAutoParticipantWarning = useMemo(() => {
    return effectiveProvider === Provider.SONIOX
      && audioMode === 'both'
      && sourceLanguage === 'auto';
  }, [effectiveProvider, audioMode, sourceLanguage]);

  const showBothAutoWarning = audioMode === 'both' && sourceLanguage === 'auto';

  return {
    provider,
    providerConfig,
    currentProviderSettings,
    sourceLanguage,
    targetLanguage,
    sourceLanguages: providerConfig.languages,
    targetLanguages,
    showAutoSourceOption,
    translationLanguagesDescription,
    sourceLanguageLabel,
    targetLanguageLabel,
    canSwap,
    updateSourceLanguage,
    updateTargetLanguage,
    swapLanguages,
    showTranslateParticipantWarning,
    showSonioxAutoParticipantWarning,
    showBothAutoWarning,
  };
}
