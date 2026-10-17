/**
 * DeepL API key input — shown whenever the selected translation model is
 * deepl-translator. Rendered outside collapsible ModelGroups so it stays
 * visible even when the Translation section is collapsed.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import FormInput from '../shared/FormInput';

export interface DeepLApiKeyFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputId?: string;
}

const DeepLApiKeyField: React.FC<DeepLApiKeyFieldProps> = ({
  value,
  onChange,
  disabled = false,
  inputId = 'deepl-api-key-input',
}) => {
  const { t } = useTranslation();
  return (
    <div className="deepl-api-key" data-testid="deepl-api-key">
      <label className="deepl-api-key__label" htmlFor={inputId}>
        {t('settings.deeplApiKey', 'DeepL API Key')}
        <span className="deepl-api-key__required">
          {t('settings.deeplApiKeyRequiredBadge', 'Required')}
        </span>
      </label>
      <FormInput
        id={inputId}
        type="password"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t(
          'settings.deeplApiKeyPlaceholder',
          'Free or Pro auth key (Free keys end with :fx)',
        )}
        disabled={disabled}
        status={value?.trim() ? 'valid' : 'invalid'}
        autoComplete="off"
      />
      <p className="deepl-api-key__hint">
        {t(
          'settings.deeplApiKeyHint',
          'Required for DeepL. Free keys use api-free.deepl.com; Pro keys use api.deepl.com. Get a key at deepl.com/pro-api.',
        )}
      </p>
    </div>
  );
};

export default DeepLApiKeyField;
