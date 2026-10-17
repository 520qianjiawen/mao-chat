import React from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useAudioSystemStatus,
  useAudioSystemReason,
  useAudioSystemDismissed,
  useAudioSystemRetrying,
  useAudioSystemRetry,
  useAudioSystemDismiss,
} from '../../stores/audioSystemStore';
import './AudioSystemBanner.scss';

const AudioSystemBanner: React.FC = () => {
  const { t } = useTranslation();
  const status = useAudioSystemStatus();
  const reason = useAudioSystemReason();
  const dismissed = useAudioSystemDismissed();
  const retrying = useAudioSystemRetrying();
  const retry = useAudioSystemRetry();
  const dismiss = useAudioSystemDismiss();

  if (status !== 'unavailable' || dismissed) {
    return null;
  }

  const isPactlMissing = reason === 'pactl-missing';
  const bodyText = (() => {
    switch (reason) {
      case 'pactl-missing':
        return t('audioSystem.pactlMissingBody');
      case 'macos-driver-missing':
        return t(
          'audioSystem.macosDriverMissingBody',
          'MAO Chat Virtual Audio driver was not found. Reinstall with the official macOS installer, allow the driver in System Settings → Privacy & Security if blocked, then restart your Mac. Translation still works with your real microphone.',
        );
      case 'windows-driver-missing':
        return t(
          'audioSystem.windowsDriverMissingBody',
          'VB-CABLE virtual audio driver was not found. Install VB-CABLE and retry. Translation still works with your real microphone.',
        );
      case 'pulseaudio-unavailable':
        return t('audioSystem.unavailableBody');
      default:
        return t(
          'audioSystem.genericUnavailableBody',
          'MAO Chat couldn\'t set up its virtual microphone/speaker. Translation still works with your real microphone.',
        );
    }
  })();

  return (
    <div className="audio-system-banner">
      <div className="audio-system-banner-content">
        <AlertTriangle size={14} />
        <div className="audio-system-banner-text">
          <span>{bodyText}</span>
          {isPactlMissing && (
            <code className="audio-system-banner-command">{t('audioSystem.installCommand')}</code>
          )}
        </div>
      </div>
      <div className="audio-system-banner-actions">
        <button
          className="retry-button"
          onClick={() => retry()}
          disabled={retrying}
        >
          <RefreshCw size={12} className={retrying ? 'spinning' : ''} />
          {retrying ? t('audioSystem.retrying') : t('audioSystem.retry')}
        </button>
        <button className="dismiss-button" onClick={dismiss} aria-label="Dismiss">
          <X size={12} />
        </button>
      </div>
    </div>
  );
};

export default AudioSystemBanner;
