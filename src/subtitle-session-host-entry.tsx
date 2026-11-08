import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './components/AppProviders';
import MainPanel from './components/MainPanel/MainPanel';
import { SettingsInitializer } from './components/SettingsInitializer/SettingsInitializer';
import { UserProfileProvider } from './contexts/UserProfileContext';
import { useInitializeAudioService } from './stores/audioStore';
import useSessionStore, {
  useIsSessionActive,
  useRequestSessionStart,
  useRequestSessionStop,
  useSessionStopCompletedVersion,
  useStartGate,
} from './stores/sessionStore';
import useSettingsStore, {
  useEnterSubtitleMode,
  useSettingsLoaded,
  useSubtitleModeActive,
} from './stores/settingsStore';
import { Provider } from './types/Provider';
import { useSubtitleStore } from './stores/subtitleStore';
import { useConversationDisplayStore } from './stores/conversationDisplayStore';

declare const chrome: any;

const HOST_START_EVENT = 'sokuji:subtitle-host-start';
let requestedTabId: number | null = null;

function send(message: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(message);
  } catch (error) {
    console.error('[Sokuji] [SubtitleHost] Failed to notify background:', error);
  }
}

function SessionHostController() {
  const initializeAudioService = useInitializeAudioService();
  const settingsLoaded = useSettingsLoaded();
  const startGate = useStartGate();
  const isSessionActive = useIsSessionActive();
  const subtitleActive = useSubtitleModeActive();
  const requestSessionStart = useRequestSessionStart();
  const requestSessionStop = useRequestSessionStop();
  const stopCompletedVersion = useSessionStopCompletedVersion();
  const enterSubtitleMode = useEnterSubtitleMode();
  const [startRequested, setStartRequested] = useState(false);
  const announcedActiveRef = useRef(false);
  const overlayWasActiveRef = useRef(false);
  const waitingForStopVersionRef = useRef<number | null>(null);
  const announcedFinishedRef = useRef(false);

  useEffect(() => {
    initializeAudioService();
    Promise.all([
      useSettingsStore.getState().loadSettings(),
      useSubtitleStore.getState().hydrate(),
      useConversationDisplayStore.getState().hydrate(),
    ]).catch((error) => {
      console.error('[Sokuji] [SubtitleHost] Store hydration failed:', error);
      send({ type: 'SUBTITLE_SESSION_HOST_ERROR', error: String(error) });
    });
  }, [initializeAudioService]);

  useEffect(() => {
    const onStart = () => setStartRequested(true);
    window.addEventListener(HOST_START_EVENT, onStart);
    return () => window.removeEventListener(HOST_START_EVENT, onStart);
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    send({ type: 'SUBTITLE_SESSION_HOST_READY' });
  }, [settingsLoaded]);

  useEffect(() => {
    if (!startRequested || isSessionActive) return;
    if (!startGate.canStart) {
      if (startGate.reason) {
        console.warn('[Sokuji] [SubtitleHost] startGate blocked start:', startGate.reason);
        send({
          type: 'SUBTITLE_SESSION_HOST_ERROR',
          error: startGate.reason,
          balance: startGate.balance,
        });
      }
      return;
    }
    requestSessionStart();
  }, [startRequested, isSessionActive, startGate.canStart, startGate.reason, startGate.balance, requestSessionStart]);

  useEffect(() => {
    if (!startRequested || !isSessionActive || subtitleActive || announcedActiveRef.current) return;
    let cancelled = false;
    void enterSubtitleMode()
      .then(() => {
        if (cancelled) return;
        announcedActiveRef.current = true;
        overlayWasActiveRef.current = true;
        send({
          type: 'SUBTITLE_SESSION_HOST_ACTIVE',
          tabId: requestedTabId,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        send({ type: 'SUBTITLE_SESSION_HOST_ERROR', error: String(error) });
      });
    return () => { cancelled = true; };
  }, [startRequested, isSessionActive, subtitleActive, enterSubtitleMode]);

  useEffect(() => {
    if (!overlayWasActiveRef.current || subtitleActive) return;
    if (announcedFinishedRef.current) return;

    if (waitingForStopVersionRef.current === null && isSessionActive) {
      waitingForStopVersionRef.current = stopCompletedVersion;
      requestSessionStop();
      return;
    }

    const waitingFor = waitingForStopVersionRef.current;
    if (waitingFor !== null && stopCompletedVersion <= waitingFor) return;

    announcedFinishedRef.current = true;
    send({ type: 'SUBTITLE_SESSION_HOST_FINISHED' });
  }, [
    subtitleActive,
    isSessionActive,
    stopCompletedVersion,
    requestSessionStop,
  ]);

  return (
    <>
      <SettingsInitializer />
      <MainPanel />
    </>
  );
}

async function bootstrap() {
  const bootstrapData = await new Promise<{ settings?: Record<string, unknown> }>((resolve) => {
    chrome.runtime.sendMessage({ type: 'SUBTITLE_SESSION_HOST_BOOTSTRAP' }, (response: any) => {
      resolve(response || {});
    });
  });

  // Offscreen documents expose only chrome.runtime on some Chrome versions.
  // Mirror sync settings into this document's localStorage before constructing
  // SettingsService so it sees exactly the side panel's persisted selection.
  for (const [key, value] of Object.entries(bootstrapData.settings || {})) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (r: any) => void) => {
    if (message?.type === 'SUBTITLE_SESSION_HOST_PING') {
      sendResponse({ success: true });
      return false;
    }
    if (message?.type === 'START_SUBTITLE_SESSION_HOST') {
      requestedTabId = Number(message.tabId) || null;
      (globalThis as any).__SOKUJI_SUBTITLE_TARGET_TAB_ID__ = requestedTabId;
      (globalThis as any).__MAO_IN_VIDEO_ONLY__ = Boolean(message.inVideoOnly);
      window.dispatchEvent(new Event(HOST_START_EVENT));
      sendResponse({ success: true });
      return false;
    }
    if (message?.type === 'STOP_SUBTITLE_SESSION_HOST') {
      void useSettingsStore.getState().exitSubtitleMode();
      sendResponse({ success: true });
      return false;
    }
    if (message?.type === 'UPDATE_SUBTITLE_LANGUAGES') {
      const { sourceLanguage, targetLanguage } = message;
      const store = useSettingsStore.getState();
      const prov = store.provider;
      const sLang = sourceLanguage === 'auto' ? undefined : (sourceLanguage === 'ja' ? (prov === Provider.GEMINI ? 'ja-JP' : 'ja') : (sourceLanguage === 'zh-CN' ? 'zh' : sourceLanguage));
      const tLang = targetLanguage === 'zh-CN' ? (prov === Provider.OPENAI ? 'zh_CN' : 'zh-CN') : (targetLanguage === 'ja' ? (prov === Provider.GEMINI ? 'ja-JP' : 'ja') : targetLanguage);
      const patch: any = {};
      if (sLang) patch.sourceLanguage = sLang;
      if (tLang) patch.targetLanguage = tLang;

      if (prov === Provider.GEMINI) store.updateGemini(patch);
      else if (prov === Provider.OPENAI) store.updateOpenAI(patch);
      else if (prov === Provider.SONIOX) store.updateSoniox(patch);
      else if (prov === Provider.VOLCENGINE_AST2) store.updateVolcengineAST2(patch);
      else if (prov === Provider.PALABRA_AI) store.updatePalabraAI(patch);
      else if (prov === Provider.ANT_LING) store.updateAntLing(patch);
      else if (prov === Provider.LOCAL_INFERENCE) store.updateLocalInference(patch);

      if (useSessionStore.getState().isSessionActive) {
        useSessionStore.getState().requestSessionStop();
        setTimeout(() => {
          useSessionStore.getState().requestSessionStart();
        }, 300);
      }

      sendResponse({ success: true });
      return false;
    }
    return undefined;
  });

  const root = document.getElementById('root');
  if (!root) throw new Error('subtitle session host root is missing');
  createRoot(root).render(
    <AppProviders posthogClient={null}>
      <UserProfileProvider>
        <SessionHostController />
      </UserProfileProvider>
    </AppProviders>,
  );
}

void bootstrap().catch((error) => {
  console.error('[Sokuji] [SubtitleHost] Bootstrap failed:', error);
  send({ type: 'SUBTITLE_SESSION_HOST_ERROR', error: String(error) });
});
