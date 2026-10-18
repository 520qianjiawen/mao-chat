import React, { useMemo } from 'react';
import { Globe, Languages, ArrowLeftRight, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../../Tooltip/Tooltip';
import ToggleSwitch from '../shared/ToggleSwitch';
import {
  useSetUILanguage,
  useNavigateToSettings,
  useSetUIMode,
  useTextOnly,
  useSetTextOnly,
  useUseYouTubeCaptions,
  useSetUseYouTubeCaptions,
  useKeepReplayAudio,
  useSetKeepReplayAudio,
  useSegmentationMode,
} from '../../../stores/settingsStore';
import SegmentationModePicker from '../shared/SegmentationModePicker';
import { Provider } from '../../../types/Provider';
import { changeLanguageWithLoad } from '../../../locales';
import { useAnalytics } from '../../../lib/analytics';
import { getManifestByType, isTranslationModelCompatible } from '../../../lib/local-inference/modelManifest';
import { useModelStatuses, useModelInitialized } from '../../../stores/modelStore';
import { isExtension } from '../../../utils/environment';
import { getLanguageDisplayName } from '../../../utils/languages';
import { useTranslationLanguages } from '../../../hooks/useTranslationLanguages';

interface LanguageSectionProps {
  isSessionActive: boolean;
  /** Show interface language selector */
  showInterfaceLanguage?: boolean;
  /** Show translation languages selector */
  showTranslationLanguages?: boolean;
  /** Use simplified language list for interface (12 languages) */
  simplifiedInterfaceList?: boolean;
  /** Additional class name */
  className?: string;
}

const LanguageSection: React.FC<LanguageSectionProps> = ({
  isSessionActive,
  showInterfaceLanguage = true,
  showTranslationLanguages = true,
  simplifiedInterfaceList = false,
  className = ''
}) => {
  const { t, i18n } = useTranslation();
  const { trackEvent } = useAnalytics();
  const extensionExperience = isExtension();
  const translationLanguagesTitle = extensionExperience ? '视频字幕语言' : t('simpleConfig.translationLanguages');
  const textOnlyLabel = extensionExperience ? '仅显示字幕' : t('simpleConfig.textOnly', 'Text Only');
  const textOnlyDescription = extensionExperience
    ? '显示实时双语字幕，不生成语音翻译'
    : t('simpleConfig.textOnlyDesc', 'Show translation as text only, without generating an audio response');

  const {
    provider,
    providerConfig,
    sourceLanguage,
    targetLanguage,
    sourceLanguages,
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
  } = useTranslationLanguages();

  const modelStatuses = useModelStatuses();
  const modelInitialized = useModelInitialized();
  const navigateToSettings = useNavigateToSettings();
  const setUIMode = useSetUIMode();

  const textOnly = useTextOnly();
  const setTextOnly = useSetTextOnly();
  const segmentationMode = useSegmentationMode();
  const videoCaptions = segmentationMode === 'video';
  const useYouTubeCaptions = useUseYouTubeCaptions();
  const setUseYouTubeCaptions = useSetUseYouTubeCaptions();

  const keepReplayAudio = useKeepReplayAudio();
  const setKeepReplayAudio = useSetKeepReplayAudio();

  const setUILanguage = useSetUILanguage();


  // Simplified interface language list (12 most common languages)
  const simplifiedLanguages = [
    { value: 'en', label: 'English' },
    { value: 'zh_CN', label: '中文 (简体)' },
    { value: 'zh_TW', label: '中文 (繁體)' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
    { value: 'es', label: 'Español' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'pt_BR', label: 'Português (Brasil)' },
    { value: 'pt_PT', label: 'Português (Portugal)' },
    { value: 'vi', label: 'Tiếng Việt' },
    { value: 'hi', label: 'हिन्दी' }
  ];

  // Full interface language list (35 languages)
  const fullLanguages = [
    { value: 'en', label: 'English' },
    { value: 'zh_CN', label: '中文 (简体)' },
    { value: 'hi', label: 'हिन्दी' },
    { value: 'es', label: 'Español' },
    { value: 'fr', label: 'Français' },
    { value: 'ar', label: 'العربية' },
    { value: 'bn', label: 'বাংলা' },
    { value: 'pt_BR', label: 'Português (Brasil)' },
    { value: 'ru', label: 'Русский' },
    { value: 'ja', label: '日本語' },
    { value: 'de', label: 'Deutsch' },
    { value: 'ko', label: '한국어' },
    { value: 'fa', label: 'فارسی' },
    { value: 'tr', label: 'Türkçe' },
    { value: 'vi', label: 'Tiếng Việt' },
    { value: 'it', label: 'Italiano' },
    { value: 'th', label: 'ไทย' },
    { value: 'pl', label: 'Polski' },
    { value: 'id', label: 'Bahasa Indonesia' },
    { value: 'ms', label: 'Bahasa Melayu' },
    { value: 'nl', label: 'Nederlands' },
    { value: 'zh_TW', label: '中文 (繁體)' },
    { value: 'pt_PT', label: 'Português (Portugal)' },
    { value: 'uk', label: 'Українська' },
    { value: 'ta', label: 'தமிழ்' },
    { value: 'te', label: 'తెలుగు' },
    { value: 'he', label: 'עברית' },
    { value: 'fil', label: 'Filipino' },
    { value: 'sv', label: 'Svenska' },
    { value: 'fi', label: 'Suomi' }
  ];

  const interfaceLanguages = simplifiedInterfaceList ? simplifiedLanguages : fullLanguages;

  // Check which model types are missing for current LOCAL_INFERENCE language pair
  const missingModelTypes = useMemo(() => {
    if (provider !== Provider.LOCAL_INFERENCE || !modelInitialized) return [];
    const missing: { label: string; navTarget: string }[] = [];
    const src = sourceLanguage;
    const tgt = targetLanguage;

    // Check ASR models (offline + streaming)
    const allAsr = [...getManifestByType('asr'), ...getManifestByType('asr-stream')];
    const hasAsr = allAsr.some(m =>
      (m.multilingual || m.languages.includes(src)) && modelStatuses[m.id] === 'downloaded'
    );
    if (!hasAsr) missing.push({ label: t('settings.modelTypeAsr', 'ASR'), navTarget: 'model-asr' });

    // Check Translation models
    const allTrans = getManifestByType('translation');
    const hasTrans = allTrans.some(m =>
      isTranslationModelCompatible(m, src, tgt)
      && (m.isCloudModel || modelStatuses[m.id] === 'downloaded')
    );
    if (!hasTrans) missing.push({ label: t('settings.modelTypeTranslation', 'Translation'), navTarget: 'model-translation' });

    // Check TTS models
    const allTts = getManifestByType('tts');
    const hasTts = allTts.some(m =>
      (m.multilingual || m.languages.includes(tgt)) && (m.isCloudModel || modelStatuses[m.id] === 'downloaded')
    );
    if (!extensionExperience && !textOnly && !hasTts) {
      missing.push({ label: t('settings.modelTypeTts', 'TTS'), navTarget: 'model-tts' });
    }

    return missing;
  }, [provider, modelInitialized, modelStatuses, sourceLanguage, targetLanguage, extensionExperience, textOnly, t]);

  return (
    <>
      {/* Interface Language Section */}
      {showInterfaceLanguage && (
        <div className={`config-section ${className}`}>
          <h3>
            <Globe size={18} />
            <span>{t('simpleConfig.interfaceLanguage')}</span>
            <Tooltip
              content={t('simpleConfig.interfaceLanguageDesc')}
              position="top"
              icon="help"
            />
          </h3>

          <div className="setting-row">
            <select
              value={i18n.language}
              onChange={async (e) => {
                const oldLanguage = i18n.language;
                const newLanguage = e.target.value;
                await changeLanguageWithLoad(newLanguage);
                setUILanguage(newLanguage);
                trackEvent('language_changed', {
                  from_language: oldLanguage,
                  to_language: newLanguage,
                  language_type: 'ui'
                });
              }}
              disabled={isSessionActive}
              className="language-select"
            >
              {interfaceLanguages.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Translation Languages Section */}
      {showTranslationLanguages && (
        <div className={`config-section ${className}`} id="languages-section">
          <h3>
            <Languages size={18} />
            <span>{translationLanguagesTitle}</span>
            <Tooltip
              content={translationLanguagesDescription}
              position="top"
              icon="help"
            />
          </h3>

          <div className="language-pair-row">
            <div className="language-select-group">
              <label>{sourceLanguageLabel}</label>
              <select
                value={sourceLanguage}
                onChange={(e) => updateSourceLanguage(e.target.value)}
                disabled={isSessionActive}
                className="language-select"
              >
                {showAutoSourceOption && (
                  <option value="auto">{t('common.autoDetect')}</option>
                )}
                {sourceLanguages.map((lang) => (
                  <option key={lang.value} value={lang.value}>
                    {getLanguageDisplayName(lang.value, i18n.language, lang.name)}
                  </option>
                ))}
              </select>
            </div>

            <div className="language-arrow">
              <button
                className="language-swap-btn"
                onClick={swapLanguages}
                disabled={isSessionActive || !canSwap}
                title={extensionExperience ? '交换视频与字幕语言' : t('simpleConfig.swapLanguages', 'Swap languages')}
                type="button"
              >
                <ArrowLeftRight size={18} />
              </button>
            </div>

            <div className="language-select-group">
              <label>{targetLanguageLabel}</label>
              <select
                value={targetLanguage}
                onChange={(e) => updateTargetLanguage(e.target.value)}
                disabled={isSessionActive}
                className="language-select"
              >
                {targetLanguages.map((lang) => (
                  <option key={lang.value} value={lang.value}>
                    {getLanguageDisplayName(lang.value, i18n.language, lang.name)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {showTranslateParticipantWarning && (
            <div className="language-warning">
              <AlertTriangle size={12} />
              <span>{t('settings.translateSourceParticipantWarning')}</span>
            </div>
          )}

          {showBothAutoWarning && (
            <div className="language-warning">
              <AlertTriangle size={12} />
              <span>{t('settings.bothModeAutoWarning', 'Both mode needs two specific languages — automatic detection cannot be used.')}</span>
            </div>
          )}
          {showSonioxAutoParticipantWarning && !showBothAutoWarning && (
            <div className="language-warning">
              <AlertTriangle size={12} />
              <span>{t('settings.sonioxAutoParticipantWarning')}</span>
            </div>
          )}

          {extensionExperience && (
            <ToggleSwitch
              checked={useYouTubeCaptions}
              onChange={() => setUseYouTubeCaptions(!useYouTubeCaptions)}
              label="YouTube 字幕轨"
              disabled={isSessionActive}
              tooltip="拦截播放器字幕、按句切开再翻译。没有字幕轨时才用语音识别。"
            />
          )}

          {(extensionExperience
            || provider === Provider.LOCAL_INFERENCE
            || provider === Provider.LOCAL_NATIVE) && (
            <SegmentationModePicker disabled={isSessionActive} />
          )}

          {providerConfig.capabilities.textOnlyCapability === 'optional' && (
            <ToggleSwitch
              checked={textOnly || videoCaptions}
              onChange={() => setTextOnly(!textOnly)}
              label={textOnlyLabel}
              disabled={isSessionActive || videoCaptions}
              tooltip={videoCaptions
                ? t('settings.segmentationModeDisablesTts', 'Video mode shows subtitles only and does not synthesize speech.')
                : textOnlyDescription}
            />
          )}

          {/* Inherently text-only providers (e.g. Zoom AI, Volcengine ST) show a
              permanently-on, non-interactive switch so users can see at a glance
              that the provider produces text only and never synthesizes audio. */}
          {providerConfig.capabilities.textOnlyCapability === 'always' && (
            <ToggleSwitch
              checked={true}
              onChange={() => {}}
              label={textOnlyLabel}
              disabled
              tooltip={textOnlyDescription}
            />
          )}

          {!extensionExperience && (
            <ToggleSwitch
              checked={keepReplayAudio}
              onChange={() => setKeepReplayAudio(!keepReplayAudio)}
              label={t('simpleConfig.keepReplayAudio', 'Keep audio for replay')}
              disabled={isSessionActive}
              tooltip={t('simpleConfig.keepReplayAudioDesc', 'Store translated audio in memory so you can replay it later from each message. Off by default to reduce memory use during long sessions.')}
            />
          )}

          {provider === Provider.LOCAL_INFERENCE && missingModelTypes.length > 0 && (
            <div className="language-model-warning">
              <AlertTriangle size={14} />
              <span>
                {t('settings.missingModelsWarning', 'Missing {{types}} model(s) for this language pair.', { types: missingModelTypes.map(m => m.label).join(', ') })}
                {' '}
                {missingModelTypes.map((m, i) => (
                  <span key={m.navTarget}>
                    {i > 0 && ', '}
                    <a
                      className="language-model-warning__link"
                      onClick={() => {
                        setUIMode('advanced');
                        setTimeout(() => navigateToSettings(m.navTarget), 100);
                      }}
                    >
                      {t('settings.downloadModelType', 'Download {{type}}', { type: m.label })}
                    </a>
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default LanguageSection;
