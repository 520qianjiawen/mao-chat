import React from 'react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../../Tooltip/Tooltip';
import {
  useSegmentationMode,
  useSetSegmentationMode,
} from '../../../stores/settingsStore';
import './SegmentationModePicker.scss';

interface SegmentationModePickerProps {
  disabled?: boolean;
  variant?: 'settings' | 'launcher';
}

const SegmentationModePicker: React.FC<SegmentationModePickerProps> = ({
  disabled = false,
  variant = 'settings',
}) => {
  const { t } = useTranslation();
  const mode = useSegmentationMode();
  const setMode = useSetSegmentationMode();
  const active = mode === 'video' ? 'video' : 'meeting';

  return (
    <div className={`segmentation-mode-picker segmentation-mode-picker--${variant}`}>
      <div className="segmentation-mode-picker__label">
        <span>{t('settings.segmentationMode', 'Sentence break mode')}</span>
        <Tooltip
          content={t(
            'settings.segmentationModeTooltip',
            'Meeting mode waits for a complete thought before translating. Video mode breaks sooner to keep subtitles in sync.',
          )}
          position="top"
          icon="help"
        />
      </div>
      <div className="segmentation-mode-picker__options" role="group" aria-label={t('settings.segmentationMode', 'Sentence break mode')}>
        <button
          type="button"
          className={`segmentation-mode-picker__option ${active === 'meeting' ? 'active' : ''}`}
          onClick={() => setMode('meeting')}
          disabled={disabled}
        >
          {t('settings.segmentationModeMeeting', 'Meeting')}
        </button>
        <button
          type="button"
          className={`segmentation-mode-picker__option ${active === 'video' ? 'active' : ''}`}
          onClick={() => setMode('video')}
          disabled={disabled}
        >
          {t('settings.segmentationModeVideo', 'Video')}
        </button>
      </div>
      <p className="segmentation-mode-picker__hint">
        {active === 'video'
          ? t('settings.segmentationModeVideoHint', 'YouTube, talks, and livestreams. Faster subtitles with slightly shorter phrases.')
          : t('settings.segmentationModeMeetingHint', 'Live speech: Teams, Zoom, Google Meet. Waits for a complete thought.')}
      </p>
    </div>
  );
};

export default SegmentationModePicker;
