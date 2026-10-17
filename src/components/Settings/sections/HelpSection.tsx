import React from 'react';
import { HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOnboarding } from '../../../contexts/OnboardingContext';

interface HelpSectionProps {
  toggleSettings?: () => void;
}

const HelpSection: React.FC<HelpSectionProps> = ({ toggleSettings }) => {
  const { t } = useTranslation();
  const { startOnboarding } = useOnboarding();

  return (
    <div className="config-section" id="help-section">
      <h3>
        <HelpCircle size={18} />
        <span>{t('settings.help', 'Help')}</span>
        <span className="version-label">v{__APP_VERSION__}</span>
      </h3>
      <div className="help-links">
        <a className="help-link" onClick={() => { startOnboarding(); if (toggleSettings) toggleSettings(); }}>
          <HelpCircle size={13} />
          <span>{t('onboarding.restartTour', 'Restart Setup Guide')}</span>
        </a>
      </div>
    </div>
  );
};

export default HelpSection;
