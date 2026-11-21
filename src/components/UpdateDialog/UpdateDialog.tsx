import React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isElectron } from '../../utils/environment';
import {
  useUpdateStatus,
  useUpdateNewVersion,
  useUpdateChangelog,
  useUpdateProgressPercent,
  useUpdateProgressTransferred,
  useUpdateProgressTotal,
  useUpdateError,
  useUpdateDownloadUrl,
  useUpdateDialogOpen,
  useCloseUpdateDialog,
  useCheckForUpdates,
  useDownloadUpdate,
  useInstallUpdate,
  useUpdateSupportsAutoUpdate,
  useUpdateAppImageUrl,
  useUpdateDebUrl,
} from '../../stores/updateStore';
import './UpdateDialog.scss';

const UpdateDialog: React.FC = () => {
  const { t } = useTranslation();
  const status = useUpdateStatus();
  const newVersion = useUpdateNewVersion();
  const changelog = useUpdateChangelog();
  const percent = useUpdateProgressPercent();
  const transferred = useUpdateProgressTransferred();
  const total = useUpdateProgressTotal();
  const errorMessage = useUpdateError();
  const downloadUrl = useUpdateDownloadUrl();
  const dialogOpen = useUpdateDialogOpen();
  const closeDialog = useCloseUpdateDialog();
  const checkForUpdates = useCheckForUpdates();
  const downloadUpdate = useDownloadUpdate();
  const installUpdate = useInstallUpdate();
  const supportsAutoUpdate = useUpdateSupportsAutoUpdate();
  const appImageUrl = useUpdateAppImageUrl();
  const debUrl = useUpdateDebUrl();

  const [currentVersion, setCurrentVersion] = React.useState('?');

  React.useEffect(() => {
    if (isElectron() && dialogOpen) {
      (window as any).electron?.invoke('get-app-version')?.then((v: string) => {
        if (v) setCurrentVersion(v);
      }).catch(() => {});
    }
  }, [dialogOpen]);

  if (!dialogOpen) return null;

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const getTitle = (): string => {
    switch (status) {
      case 'checking': return t('update.checking', '正在检查更新...');
      case 'available': return t('update.available', { version: newVersion });
      case 'downloading': return t('update.downloading', { percent: Math.round(percent) });
      case 'downloaded': return t('update.downloaded');
      case 'not-available': return t('update.notAvailable');
      case 'error': return t('update.error', '检查更新失败');
      default: return t('update.checkButton');
    }
  };

  return (
    <div
      className="update-dialog-overlay"
      onClick={closeDialog}
      onKeyDown={(e) => { if (e.key === 'Escape') closeDialog(); }}
    >
      <div
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="update-dialog-header">
          <h3 id="update-dialog-title">{getTitle()}</h3>
          <button
            type="button"
            className="close-button"
            aria-label={t('common.close', 'Close')}
            onClick={closeDialog}
          >
            <X size={16} />
          </button>
        </div>

        <div className="update-dialog-body">
          {status === 'available' && newVersion && (
            <div className="version-info">
              <span>{t('update.currentVersion', { version: currentVersion })}</span>
              <span className="arrow">→</span>
              <span className="new-version">{t('update.newVersion', { version: newVersion })}</span>
            </div>
          )}

          {/* Only shown to Linux non-AppImage users (e.g. .deb installs):
              AppImage users already have auto-updates, and Windows/macOS
              don't populate appImageUrl/debUrl. */}
          {status === 'available' && !supportsAutoUpdate && (appImageUrl || debUrl) && (
            <div className="auto-update-note">
              {t('update.autoUpdateNote')}
            </div>
          )}

          {changelog && (status === 'available' || status === 'downloading' || status === 'downloaded') && (
            <div
              className="changelog"
              dangerouslySetInnerHTML={{ __html: changelog }}
            />
          )}

          {status === 'downloading' && (
            <div className="download-progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="progress-details">
                <span>{formatBytes(transferred)} / {formatBytes(total)}</span>
                <span>{Math.round(percent)}%</span>
              </div>
            </div>
          )}

          {status === 'not-available' && (
            <div className="up-to-date">
              <p>{t('update.notAvailable')}</p>
            </div>
          )}

          {status === 'error' && (
            <div className="up-to-date">
              <p>{errorMessage || t('update.error', '更新失败，请检查网络连接后重试')}</p>
            </div>
          )}
        </div>

        <div className="update-dialog-footer">
          {status === 'available' && (
            <>
              {!supportsAutoUpdate && (appImageUrl || debUrl) ? (
                // Non-AppImage Linux: offer two download paths
                <>
                  {appImageUrl && (
                    <button
                      className="primary-button"
                      onClick={() => {
                        if (isElectron() && (window as any).electron?.invoke) {
                          (window as any).electron.invoke('open-external', appImageUrl);
                        } else {
                          window.open(appImageUrl, '_blank');
                        }
                        closeDialog();
                      }}
                    >
                      {t('update.downloadAppImage')}
                    </button>
                  )}
                  {debUrl && (
                    <button
                      className="tertiary-button"
                      onClick={() => {
                        if (isElectron() && (window as any).electron?.invoke) {
                          (window as any).electron.invoke('open-external', debUrl);
                        } else {
                          window.open(debUrl, '_blank');
                        }
                        closeDialog();
                      }}
                    >
                      {t('update.downloadDeb')}
                    </button>
                  )}
                  <button className="secondary-button" onClick={closeDialog}>
                    {t('update.later')}
                  </button>
                </>
              ) : downloadUrl && !supportsAutoUpdate ? (
                // Manual download path (when auto-update is not supported)
                <>
                  <button
                    className="primary-button"
                    onClick={() => {
                      if (isElectron() && (window as any).electron?.invoke) {
                        (window as any).electron.invoke('open-external', downloadUrl);
                      } else {
                        window.open(downloadUrl, '_blank');
                      }
                      closeDialog();
                    }}
                  >
                    {t('update.goToDownload')}
                  </button>
                  <button className="secondary-button" onClick={closeDialog}>
                    {t('update.later')}
                  </button>
                </>
              ) : (
                // Windows / AppImage Linux: full auto-update flow
                <>
                  <button className="primary-button" onClick={downloadUpdate}>
                    {t('update.downloadNow')}
                  </button>
                  <button className="secondary-button" onClick={closeDialog}>
                    {t('update.later')}
                  </button>
                </>
              )}
            </>
          )}

          {status === 'downloaded' && (
            <>
              <button className="primary-button" onClick={installUpdate}>
                {t('update.restartNow')}
              </button>
              <button className="secondary-button" onClick={closeDialog}>
                {t('update.later')}
              </button>
            </>
          )}

          {status === 'error' && (
            <>
              <button
                className="primary-button"
                onClick={newVersion ? downloadUpdate : checkForUpdates}
              >
                {t('common.retry', '重试')}
              </button>
              <button className="secondary-button" onClick={closeDialog}>
                {t('common.close', '关闭')}
              </button>
            </>
          )}

          {(status === 'not-available' || status === 'idle' || status === 'checking') && (
            <button className="secondary-button" onClick={closeDialog}>
              {t('common.close', '关闭')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default UpdateDialog;
