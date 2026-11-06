// src/components/MainPanel/ListenPill.tsx
import React, { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import useSessionStore from '../../stores/sessionStore';
import { useNavigateToSettings } from '../../stores/settingsStore';
import { reasonToI18n, reasonToSettingsTarget } from './sessionStartGate';
import { formatClock } from '../../types/meeting';
import appLogo from '../../assets/logo.png';
import './ListenPill.scss';

export const ListenPill: React.FC = () => {
  const { t } = useTranslation();
  const navigateToSettings = useNavigateToSettings();

  const isSessionActive = useSessionStore((s) => s.isSessionActive);
  const isInitializing = useSessionStore((s) => s.isInitializing);
  const sessionStartTime = useSessionStore((s) => s.sessionStartTime);
  const requestSessionStart = useSessionStore((s) => s.requestSessionStart);
  const requestSessionStop = useSessionStore((s) => s.requestSessionStop);
  const startGate = useSessionStore((s) => s.startGate);

  const [elapsed, setElapsed] = useState(0);

  const isBlocked = Boolean(startGate && !startGate.canStart && startGate.reason !== null && !isInitializing);

  const blockInfo = useMemo(() => {
    if (!startGate || startGate.canStart || !startGate.reason) return null;
    const { key, defaultValue, values } = reasonToI18n(startGate.reason, startGate.balance);
    const message = t(key, defaultValue, values);
    const target = reasonToSettingsTarget(startGate.reason, startGate.deviceScope);
    return { message, target };
  }, [startGate, t]);

  const tooltipText = useMemo(() => {
    if (isInitializing) return '连接中...';
    if (blockInfo) return `${blockInfo.message} (点击前往设置)`;
    return '开始听 (⌘R)';
  }, [isInitializing, blockInfo]);

  const handleIdleClick = () => {
    if (isInitializing) return;
    if (isBlocked && blockInfo?.target) {
      navigateToSettings(blockInfo.target);
      return;
    }
    requestSessionStart();
  };

  // Keyboard shortcut: Cmd+R / Ctrl+R to start/stop
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        // Prevent default browser refresh in Electron / browser
        e.preventDefault();
        if (isSessionActive) {
          requestSessionStop();
        } else if (!isInitializing) {
          if (isBlocked && blockInfo?.target) {
            navigateToSettings(blockInfo.target);
          } else {
            requestSessionStart();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSessionActive, isInitializing, isBlocked, blockInfo, navigateToSettings, requestSessionStart, requestSessionStop]);

  // Update timer every second during active session
  useEffect(() => {
    if (!isSessionActive || !sessionStartTime) {
      setElapsed(0);
      return;
    }
    const update = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - sessionStartTime) / 1000)));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isSessionActive, sessionStartTime]);

  if (isSessionActive) {
    return (
      <div className="listen-pill listen-pill--active" role="status" aria-label="正在听">
        <div className="listen-pill__breathing">
          <img src={appLogo} alt="" className="listen-pill__logo-img" />
          <span className="listen-pill__pulse-ring ring-1" />
          <span className="listen-pill__pulse-ring ring-2" />
        </div>
        <span className="listen-pill__label">正在听</span>
        <div className="listen-pill__meter" aria-hidden="true">
          <span className="meter-bar b1" />
          <span className="meter-bar b2" />
          <span className="meter-bar b3" />
          <span className="meter-bar b4" />
          <span className="meter-bar b5" />
          <span className="meter-bar b6" />
          <span className="meter-bar b7" />
          <span className="meter-bar b8" />
        </div>
        <span className="listen-pill__timer">{formatClock(elapsed)}</span>
        <button
          type="button"
          className="listen-pill__stop-btn"
          onClick={(e) => {
            e.stopPropagation();
            requestSessionStop();
          }}
          title="结束会议 (⌘R)"
        >
          结束
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`listen-pill listen-pill--idle${isBlocked ? ' listen-pill--blocked' : ''}`}
      onClick={handleIdleClick}
      disabled={isInitializing}
      title={tooltipText}
      aria-label="开始听"
    >
      <img src={appLogo} alt="" className="listen-pill__logo-img" />
      <span className="listen-pill__brand">MAO Chat</span>
      <span className="listen-pill__divider" />
      <span className="listen-pill__text">{isInitializing ? '连接中...' : '开始听'}</span>
      <span className="listen-pill__shortcut">⌘R</span>
    </button>
  );
};

export default ListenPill;
