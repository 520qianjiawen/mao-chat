import React, { useState, useRef, useCallback, useEffect, Activity } from 'react';
import { useTranslation } from 'react-i18next';
import { CaptionsOff } from 'lucide-react';
import MainPanel from '../MainPanel/MainPanel';
import LogsPanel from '../LogsPanel/LogsPanel';
import { Settings as SettingsComponent } from '../Settings';
import Onboarding from '../Onboarding/Onboarding';
import UserTypeSelection from '../UserTypeSelection/UserTypeSelection';
import TitleBar from '../TitleBar/TitleBar';
import TextToSpeechDialog from '../TextToSpeech/TextToSpeechDialog';
import TextTranslationView from '../TextTranslation/TextTranslationView';
import PanelResizer from './PanelResizer';
import { clampPanelWidth, maxPanelWidth, readPanelWidth, savePanelWidth, PANEL_MIN_WIDTH } from './panelWidth';
import './MainLayout.scss';
import { useAnalytics } from '../../lib/analytics';
import {
  useProvider,
  useUIMode,
  useSetProvider,
  useSetUIMode,
  useSettingsNavigationTarget,
  useNavigateToSettings,
  useSubtitleModeActive,
  useExitSubtitleMode,
} from '../../stores/settingsStore';
import { isElectron, isExtension, isKizunaAIEnabled } from '../../utils/environment';
import SubtitleApp from '../Subtitle/SubtitleApp';
import { useOnboarding } from '../../contexts/OnboardingContext';
import { useAuth } from '../../lib/auth/hooks';
import { Provider, isKizunaManagedProvider } from '../../types/Provider';

type PanelName = 'settings' | 'logs' | 'main';

const MainLayout: React.FC = () => {
  const { t } = useTranslation();
  const { trackEvent } = useAnalytics();
  const provider = useProvider();
  const uiMode = useUIMode();
  const setProvider = useSetProvider();
  const setUIMode = useSetUIMode();
  const settingsNavigationTarget = useSettingsNavigationTarget();
  const navigateToSettings = useNavigateToSettings();
  const { userTypeSelected, setUserType } = useOnboarding();
  const { isSignedIn } = useAuth();
  const subtitleActive = useSubtitleModeActive();
  const exitSubtitleMode = useExitSubtitleMode();
  const [showLogs, setShowLogs] = useState(() => {
    return sessionStorage.getItem('panelState.showLogs') === 'true';
  });
  const [showSettings, setShowSettings] = useState(() => {
    return sessionStorage.getItem('panelState.showSettings') === 'true';
  });
  const [showTextToSpeech, setShowTextToSpeech] = useState(false);
  const [showTextTranslation, setShowTextTranslation] = useState(false);
  const [ttsInitialText, setTtsInitialText] = useState('');
  const [ttsInitialLanguage, setTtsInitialLanguage] = useState<string | undefined>(undefined);
  const [panelWidth, setPanelWidth] = useState(() => clampPanelWidth(readPanelWidth(), window.innerWidth));

  // Track panel view times
  const panelOpenTimeRef = useRef<number | null>(null);
  const currentPanelRef = useRef<PanelName | null>(null);

  // Track previous auth state to detect login
  const prevIsSignedInRef = useRef(isSignedIn);

  // Helper function to track panel view events
  const trackPanelView = (panelName: PanelName | null) => {
    // Track closing of previous panel
    if (currentPanelRef.current && panelOpenTimeRef.current) {
      const viewDuration = Date.now() - panelOpenTimeRef.current;
      trackEvent('panel_viewed', {
        panel_name: currentPanelRef.current,
        view_duration_ms: viewDuration
      });
    }

    // Track opening of new panel
    if (panelName) {
      trackEvent('panel_viewed', {
        panel_name: panelName
      });
      panelOpenTimeRef.current = Date.now();
      currentPanelRef.current = panelName;
    } else {
      // Going back to main panel
      trackEvent('panel_viewed', {
        panel_name: 'main'
      });
      panelOpenTimeRef.current = null;
      currentPanelRef.current = null;
    }
  };

  // Modify toggle functions to ensure only one panel is displayed at a time
  const toggleLogs = () => {
    // If already shown, close it; otherwise open it and close other panels
    if (showLogs) {
      setShowLogs(false);
      sessionStorage.setItem('panelState.showLogs', 'false');
      trackPanelView(null);
    } else {
      setShowLogs(true);
      setShowSettings(false);
      sessionStorage.setItem('panelState.showLogs', 'true');
      sessionStorage.setItem('panelState.showSettings', 'false');
      trackPanelView('logs');
    }
  };

  const toggleSettings = () => {
    // If already shown, close it; otherwise open it and close other panels
    if (showSettings) {
      setShowSettings(false);
      sessionStorage.setItem('panelState.showSettings', 'false');
      trackPanelView(null);
    } else {
      setShowSettings(true);
      setShowLogs(false);
      sessionStorage.setItem('panelState.showSettings', 'true');
      sessionStorage.setItem('panelState.showLogs', 'false');
      trackPanelView('settings');
    }
  };

  const openTtsSettings = useCallback(() => {
    // Keep TTS in the main window; open Settings as the side panel.
    setShowSettings(true);
    setShowLogs(false);
    setUIMode('advanced');
    sessionStorage.setItem('panelState.showSettings', 'true');
    sessionStorage.setItem('panelState.showLogs', 'false');
    const target = provider === Provider.OPENAI
      || provider === Provider.OPENAI_TRANSLATE
      || provider === Provider.OPENAI_COMPATIBLE
      ? 'voice-settings'
      : 'model-tts';
    setTimeout(() => navigateToSettings(target), 0);
  }, [navigateToSettings, provider, setUIMode]);

  const openTranslationSettings = useCallback(() => {
    // Keep Translation in the main window; open Settings as the side panel.
    setShowSettings(true);
    setShowLogs(false);
    setUIMode('advanced');
    sessionStorage.setItem('panelState.showSettings', 'true');
    sessionStorage.setItem('panelState.showLogs', 'false');
    setTimeout(() => navigateToSettings('model-translation'), 0);
  }, [navigateToSettings, setUIMode]);

  const toggleTextTranslation = useCallback(() => {
    setShowTextTranslation((open) => {
      const next = !open;
      if (next) {
        setShowTextToSpeech(false);
        trackPanelView(null);
      }
      return next;
    });
  }, []);

  // Open TextTranslationView when requested by floating quick-translate window
  useEffect(() => {
    if (!window.electron?.receive) return;
    const onOpenInMain = () => {
      setShowTextTranslation(true);
      setShowTextToSpeech(false);
    };
    const onOpenSettings = () => {
      setShowSettings(true);
      setShowLogs(false);
      sessionStorage.setItem('panelState.showSettings', 'true');
      sessionStorage.setItem('panelState.showLogs', 'false');
    };
    window.electron.receive('quick-translate:open-in-main', onOpenInMain);
    window.electron.receive('menu:open-settings', onOpenSettings);
    return () => {
      window.electron?.removeListener?.('quick-translate:open-in-main', onOpenInMain);
      window.electron?.removeListener?.('menu:open-settings', onOpenSettings);
    };
  }, []);

  const toggleTextToSpeech = useCallback(() => {
    setShowTextToSpeech((open) => {
      const next = !open;
      if (next) {
        setShowTextTranslation(false);
        // Entering TTS uses the main content area (same place as the session view).
        trackPanelView(null);
      }
      return next;
    });
  }, []);

  const handleSendToTts = useCallback((text: string, lang?: string) => {
    setTtsInitialText(text);
    setTtsInitialLanguage(lang);
    setShowTextTranslation(false);
    setShowTextToSpeech(true);
    trackPanelView(null);
  }, []);


  // Re-clamp the saved/active width when the window shrinks so a wide panel
  // can never strand MainPanel below its minimum.
  useEffect(() => {
    const onResize = () => setPanelWidth((w) => clampPanelWidth(w, window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handlePanelResize = useCallback((next: number) => {
    setPanelWidth(clampPanelWidth(next, window.innerWidth));
  }, []);
  const handlePanelResizeCommit = useCallback((next: number) => {
    const clamped = clampPanelWidth(next, window.innerWidth);
    setPanelWidth(clamped);
    savePanelWidth(clamped);
  }, []);

  // Listen for navigation requests from settings context
  useEffect(() => {
    if (settingsNavigationTarget) {
      // Open settings panel when navigation is requested
      setShowSettings(true);
      setShowLogs(false);
      // Save to sessionStorage when programmatically opening settings
      sessionStorage.setItem('panelState.showSettings', 'true');
      sessionStorage.setItem('panelState.showLogs', 'false');
      trackPanelView('settings');
    }
  }, [settingsNavigationTarget]);

  // Entering subtitle mode should free the sidepanel chrome: auto-collapse
  // Settings/Logs so the main view (and extension side panel) can use the
  // full width. Only runs on the enter transition; the user can still open
  // settings manually afterwards while subtitle mode stays active.
  useEffect(() => {
    if (!subtitleActive) return;
    setShowSettings((open) => {
      if (open) sessionStorage.setItem('panelState.showSettings', 'false');
      return false;
    });
    setShowLogs((open) => {
      if (open) sessionStorage.setItem('panelState.showLogs', 'false');
      return false;
    });
    if (currentPanelRef.current === 'settings' || currentPanelRef.current === 'logs') {
      trackPanelView(null);
    }
  }, [subtitleActive]);

  // Handle user type selection
  const handleUserTypeSelection = useCallback((type: 'regular' | 'experienced') => {
    // Set UI mode based on user type
    const newMode = type === 'regular' ? 'basic' : 'advanced';
    setUIMode(newMode);

    // Call the onboarding context to handle the selection
    setUserType(type);

    trackEvent('user_type_applied', {
      user_type: type,
      ui_mode: newMode
    });
  }, [setUIMode, setUserType, trackEvent]);

  // Auto-switch to KizunaAI when Basic Mode users log in
  useEffect(() => {
    // Check if user just logged in (was false, now true)
    if (!prevIsSignedInRef.current && isSignedIn) {
      // User just logged in. Only auto-switch when the Kizuna twins are actually
      // registered (isKizunaAIEnabled); otherwise we'd strand non-Kizuna builds on
      // a provider that ProviderConfigFactory/ClientFactory never registered.
      if (isKizunaAIEnabled() && uiMode === 'basic' && !isKizunaManagedProvider(provider)) {
        // User is in Basic Mode and not using a Kizuna-managed provider; switch
        // to the default relay-managed provider (the Translate twin).
        setProvider(Provider.KIZUNA_AI_OPENAI_TRANSLATE);

        // Track the auto-switch
        trackEvent('settings_modified', {
          setting_name: 'provider',
          new_value: Provider.KIZUNA_AI_OPENAI_TRANSLATE,
          old_value: provider,
          category: 'api'
        });

        console.log('[MainLayout] Auto-switched to KizunaAI provider for Basic Mode user on login');
      }
    }

    // Update the ref for next render
    prevIsSignedInRef.current = isSignedIn;
  }, [isSignedIn, uiMode, provider, setProvider, trackEvent]);

  // Subtitle mode hides the full translation chrome (title bar + MainPanel +
  // settings/logs). MainPanel stays mounted under display:none so the active
  // session, ASR, and port to the in-tab overlay keep running.
  // - Electron: main process reshapes the window; SubtitleApp mounts here.
  // - Extension: SubtitleApp lives in the tab overlay iframe; the side panel
  //   shows only a slim "session still running" placeholder.
  const electronSubtitleTakeover = subtitleActive && isElectron();
  const extensionSubtitleTakeover = subtitleActive && isExtension();
  const hideTranslationChrome = electronSubtitleTakeover || extensionSubtitleTakeover;

  return (
    <>
    {!hideTranslationChrome && (
      <TitleBar
        showSettings={showSettings}
        showLogs={showLogs}
        showTextToSpeech={showTextToSpeech}
        showTextTranslation={showTextTranslation}
        onToggleSettings={toggleSettings}
        onToggleLogs={toggleLogs}
        onToggleTextToSpeech={toggleTextToSpeech}
        onToggleTextTranslation={toggleTextTranslation}
      />
    )}
    <div
      className={`main-layout main-layout--interpreter${showTextToSpeech ? ' main-layout--tts' : ''}${showTextTranslation ? ' main-layout--translation' : ''}`}
      style={hideTranslationChrome ? { display: 'none' } : undefined}
    >
      <div className={`main-content ${(showLogs || showSettings) ? 'with-panel' : 'full-width'}`}>
        <div className="main-panel-container">
          {/* Session view stays mounted (hidden) so an active translation
              session survives while the user is in Text-to-speech or Text-translation mode. */}
          <div
            className="main-panel-slot"
            style={(showTextToSpeech || showTextTranslation) ? { display: 'none' } : undefined}
          >
            <MainPanel />
          </div>
          {isElectron() && showTextToSpeech && !hideTranslationChrome && (
            <TextToSpeechDialog
              isOpen
              onClose={() => setShowTextToSpeech(false)}
              onOpenSettings={openTtsSettings}
              initialText={ttsInitialText}
              initialLanguage={ttsInitialLanguage}
            />
          )}
          {isElectron() && showTextTranslation && !hideTranslationChrome && (
            <TextTranslationView
              isOpen
              onClose={() => setShowTextTranslation(false)}
              onOpenSettings={openTranslationSettings}
              onSendToTextToSpeech={handleSendToTts}
            />
          )}
        </div>
      </div>
      {(showLogs || showSettings) && (
        <PanelResizer
          width={panelWidth}
          min={PANEL_MIN_WIDTH}
          max={maxPanelWidth(window.innerWidth)}
          onResize={handlePanelResize}
          onCommit={handlePanelResizeCommit}
        />
      )}
      {/* The panel container stays mounted; each panel lives inside an
          <Activity> boundary so hidden panels keep their state (active tab,
          scroll positions, collapsed sections) while their effects are
          unmounted and their rendering is deprioritized. */}
      <div
        className="settings-panel-container"
        style={{
          width: panelWidth,
          ...((showLogs || showSettings) ? null : { display: 'none' }),
        }}
      >
        <Activity mode={showLogs ? 'visible' : 'hidden'}>
          <LogsPanel toggleLogs={toggleLogs} />
        </Activity>
        <Activity mode={showSettings ? 'visible' : 'hidden'}>
          <SettingsComponent
            toggleSettings={toggleSettings}
            highlightSection={settingsNavigationTarget}
          />
        </Activity>
      </div>
      <Onboarding />
    </div>
    {electronSubtitleTakeover && <SubtitleApp />}
    {extensionSubtitleTakeover && (
      <div className="subtitle-sidepanel-placeholder">
        <div className="subtitle-sidepanel-placeholder__card">
          <CaptionsOff size={28} aria-hidden="true" />
          <p className="subtitle-sidepanel-placeholder__title">
            {t('mainPanel.subtitleTakeover', 'Translations are showing in the subtitle overlay')}
          </p>
          <p className="subtitle-sidepanel-placeholder__hint">
            {t(
              'mainPanel.subtitleTakeoverHint',
              'The translation panel is hidden. Session keeps running — exit subtitle to restore it.',
            )}
          </p>
          <button
            type="button"
            className="subtitle-sidepanel-placeholder__exit"
            onClick={() => { void exitSubtitleMode(); }}
          >
            {t('subtitle.exitButton.label', 'Exit subtitle')}
          </button>
        </div>
      </div>
    )}
    </>
  );
};

export default MainLayout;
