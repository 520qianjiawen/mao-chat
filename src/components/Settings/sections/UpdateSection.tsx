import React, { useState, useEffect } from 'react';
import { RefreshCw, ArrowUpCircle, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isElectron } from '../../../utils/environment';
import {
  useUpdateStatus,
  useCheckForUpdates,
  useOpenUpdateDialog,
  useUpdateNewVersion,
} from '../../../stores/updateStore';
import './UpdateSection.scss';

const UpdateSection: React.FC = () => {
  const { t } = useTranslation();
  const status = useUpdateStatus();
  const newVersion = useUpdateNewVersion();
  const checkForUpdates = useCheckForUpdates();
  const openDialog = useOpenUpdateDialog();
  const [showUpToDate, setShowUpToDate] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string>('');

  useEffect(() => {
    if (isElectron() && window.electron?.invoke) {
      window.electron.invoke('get-app-version').then((v: string) => {
        if (v) setCurrentVersion(v);
      }).catch(() => {});
    }
  }, []);

  // Show "Up to date" briefly after check completes
  useEffect(() => {
    if (status === 'not-available') {
      setShowUpToDate(true);
      const timer = setTimeout(() => setShowUpToDate(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  // When update is available, open dialog instead
  useEffect(() => {
    if (status === 'available') {
      openDialog();
    }
  }, [status, openDialog]);

  // Only show in Electron
  if (!isElectron()) return null;

  const handleClick = () => {
    if (status === 'checking') return;
    if (status === 'available') {
      openDialog();
      return;
    }
    checkForUpdates();
  };

  const getButtonText = (): string => {
    if (status === 'checking') return t('update.checking', '正在检查更新...');
    if (status === 'available' && newVersion) return t('update.upgradeTo', { version: newVersion, defaultValue: `立即升级到 v${newVersion}` });
    if (showUpToDate) return t('update.upToDate', '已是最新版本');
    return t('update.checkButton', '检查更新');
  };

  return (
    <div className="config-section" id="update-section">
      <h3>
        <RefreshCw size={18} />
        <span>{t('update.checkButton', '软件更新')}</span>
        {currentVersion && <span className="current-version-tag">v{currentVersion}</span>}
      </h3>
      <button
        className={`check-update-button ${status === 'checking' ? 'checking' : ''} ${status === 'available' ? 'is-available' : ''} ${showUpToDate ? 'up-to-date' : ''}`}
        onClick={handleClick}
        disabled={status === 'checking'}
      >
        {status === 'checking' && <RefreshCw size={14} className="spinning" />}
        {status === 'available' && <ArrowUpCircle size={15} />}
        {showUpToDate && <Check size={14} />}
        {getButtonText()}
      </button>
    </div>
  );
};

export default UpdateSection;
