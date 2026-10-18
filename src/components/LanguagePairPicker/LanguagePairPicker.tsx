import React from 'react';
import { ArrowLeftRight, ChevronDown, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTranslationLanguages } from '../../hooks/useTranslationLanguages';
import { getLanguageDisplayName } from '../../utils/languages';
import { useNavigateToSettings } from '../../stores/settingsStore';
import './LanguagePairPicker.scss';

export function languageFlagEmoji(code: string): string {
  const normalized = String(code || '').toLowerCase().split(/[-_]/)[0];
  return ({
    en: '🇺🇸',
    zh: '🇨🇳',
    ja: '🇯🇵',
    ko: '🇰🇷',
    es: '🇪🇸',
    fr: '🇫🇷',
    de: '🇩🇪',
    pt: '🇵🇹',
    ru: '🇷🇺',
    ar: '🇸🇦',
    hi: '🇮🇳',
    vi: '🇻🇳',
    th: '🇹🇭',
    it: '🇮🇹',
    tr: '🇹🇷',
  } as Record<string, string>)[normalized] ?? '🌐';
}

interface Props {
  disabled?: boolean;
  variant?: 'launcher' | 'footer';
  showSettingsButton?: boolean;
}

const LanguagePairPicker: React.FC<Props> = ({
  disabled = false,
  variant = 'launcher',
  showSettingsButton = variant === 'launcher',
}) => {
  const { t, i18n } = useTranslation();
  const navigateToSettings = useNavigateToSettings();
  const {
    sourceLanguage,
    targetLanguage,
    sourceLanguages,
    targetLanguages,
    showAutoSourceOption,
    sourceLanguageLabel,
    targetLanguageLabel,
    canSwap,
    updateSourceLanguage,
    updateTargetLanguage,
    swapLanguages,
  } = useTranslationLanguages();

  const sourceDisplayName = React.useMemo(() => {
    if (sourceLanguage === 'auto') return t('common.autoDetect', '自动检测');
    const found = sourceLanguages.find((lang) => lang.value === sourceLanguage);
    return getLanguageDisplayName(sourceLanguage, i18n.language, found?.name);
  }, [sourceLanguage, sourceLanguages, i18n.language, t]);

  const targetDisplayName = React.useMemo(() => {
    const found = targetLanguages.find((lang) => lang.value === targetLanguage);
    return getLanguageDisplayName(targetLanguage, i18n.language, found?.name);
  }, [targetLanguage, targetLanguages, i18n.language]);

  return (
    <div className={`language-pair-picker language-pair-picker--${variant}`}>
      <label className="language-pair-picker__field">
        <span className="language-pair-picker__flag" aria-hidden="true">
          {languageFlagEmoji(sourceLanguage)}
        </span>
        <span className="language-pair-picker__copy">
          {variant !== 'footer' && <small>{sourceLanguageLabel}</small>}
          <span className="language-pair-picker__select-wrap">
            <span className="language-pair-picker__selected-text">
              {sourceDisplayName}
            </span>
            <ChevronDown size={variant === 'footer' ? 12 : 14} aria-hidden="true" />
            <select
              aria-label={sourceLanguageLabel}
              value={sourceLanguage}
              disabled={disabled}
              onChange={(event) => updateSourceLanguage(event.target.value)}
              className="language-pair-picker__native-select"
            >
              {showAutoSourceOption && (
                <option value="auto">{t('common.autoDetect', '自动检测')}</option>
              )}
              {sourceLanguages.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {getLanguageDisplayName(lang.value, i18n.language, lang.name)}
                </option>
              ))}
            </select>
          </span>
        </span>
      </label>

      <button
        type="button"
        className="language-pair-picker__swap"
        onClick={swapLanguages}
        disabled={disabled || !canSwap}
        title={t('simpleConfig.swapLanguages', '交换左右语言')}
        aria-label={t('simpleConfig.swapLanguages', '交换左右语言')}
      >
        <ArrowLeftRight size={variant === 'footer' ? 12 : 15} />
      </button>

      <label className="language-pair-picker__field">
        <span className="language-pair-picker__flag" aria-hidden="true">
          {languageFlagEmoji(targetLanguage)}
        </span>
        <span className="language-pair-picker__copy">
          {variant !== 'footer' && <small>{targetLanguageLabel}</small>}
          <span className="language-pair-picker__select-wrap">
            <span className="language-pair-picker__selected-text">
              {targetDisplayName}
            </span>
            <ChevronDown size={variant === 'footer' ? 12 : 14} aria-hidden="true" />
            <select
              aria-label={targetLanguageLabel}
              value={targetLanguage}
              disabled={disabled}
              onChange={(event) => updateTargetLanguage(event.target.value)}
              className="language-pair-picker__native-select"
            >
              {targetLanguages.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {getLanguageDisplayName(lang.value, i18n.language, lang.name)}
                </option>
              ))}
            </select>
          </span>
        </span>
      </label>

      {showSettingsButton && (
        <button
          type="button"
          className="language-pair-picker__settings"
          onClick={() => navigateToSettings('languages')}
          title={t('settings.title', 'Settings')}
          aria-label={t('settings.title', 'Settings')}
        >
          <Settings size={18} />
        </button>
      )}
    </div>
  );
};

export default LanguagePairPicker;
