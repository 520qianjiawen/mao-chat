import {
  IAudioService,
  AudioDevices,
  AudioDeviceQueryOptions,
  AudioOperationResult,
  AudioRecordingCallback
} from '../../services/interfaces/IAudioService';
import { ModernAudioRecorder } from './ModernAudioRecorder';
import { ModernAudioPlayer } from './ModernAudioPlayer';
import { TabAudioRecorder } from './TabAudioRecorder';
import { LoopbackRecorder } from './LoopbackRecorder';
import { AppAudioRecorder } from './AppAudioRecorder';
import { DeviceCaptureRecorder } from './DeviceCaptureRecorder';
import { IParticipantAudioRecorder } from './IParticipantAudioRecorder';
import { isApplicationSource } from './participantSource';
import { ServiceFactory } from '../../services/ServiceFactory';
import { AudioDevice } from '../../stores/audioStore';
import { isExtension } from '../../utils/environment';
import { isVirtualMic, isVirtualSpeaker } from '../../utils/audioDevices';

// Declare chrome namespace for extension messaging
declare const chrome: any;

/**
 * Modern Browser Audio Service using standard APIs for better echo cancellation
 * Replaces the old wavtools-based implementation
 */
export class ModernBrowserAudioService implements IAudioService {
  private recorder: ModernAudioRecorder;
  private player: ModernAudioPlayer;
  private virtualSpeakerPlayer: ModernAudioPlayer | null;
  private targetTabId: number | null = null;
  private interruptedTrackIds: { [key: string]: boolean } = {};
  private initialized: boolean = false;
  // In-flight guards: collapse concurrent initialize() / permission warm-up
  // calls into a single run so we never open the microphone twice at once
  // (which fails with NotReadableError on drivers that can't share a device).
  private initPromise: Promise<void> | null = null;
  private permissionWarmupPromise: Promise<void> | null = null;
  private recordingCallback: AudioRecordingCallback | null = null;
  private currentRecordingDeviceId: string | undefined = undefined;

  // System audio capture state (Electron - uses PipeWire/PulseAudio on Linux, electron-audio-loopback on Windows/macOS)
  // Connection state (switched via pw-link when user selects device on Linux, state flags on Windows)
  private systemAudioSourceConnected: boolean = false;
  private currentSystemAudioSinkId: string | undefined = undefined; // The sink being captured
  // Recording state (started when session starts)
  private systemAudioRecorder: IParticipantAudioRecorder | null = null; // Platform-specific (Linux/Windows/macOS)
  // 'app' means a helper process pushes PCM over IPC (Windows/macOS
  // per-application capture); 'system' means whole-system loopback.
  private currentCaptureMode: 'system' | 'app' = 'system';
  /** Serializes participant-source switches; see switchParticipantSource. */
  private participantSwitchChain: Promise<unknown> = Promise.resolve();
  /** Serializes mic begin/record/end so a late device refresh cannot call
   *  record() after a concurrent end() — that surfaces as
   *  "Session ended: please call .begin() first". */
  private micOpChain: Promise<unknown> = Promise.resolve();
  /**
   * Set by the UI to surface non-fatal capture-helper warnings. Without it a
   * macOS permission denial is invisible: the session runs and stays silent.
   */
  public onParticipantWarning: ((code: string) => void) | null = null;
  // Chromium deviceId of a per-application capture monitor (Linux), or null.
  private currentMonitorDeviceId: string | null = null;
  private systemAudioCallback: AudioRecordingCallback | null = null;
  private systemAudioRecordingActive: boolean = false;

  // Tab audio capture state (Extension - uses Chrome tabCapture API)
  private tabAudioRecorder: TabAudioRecorder | null = null;
  private tabAudioCallback: AudioRecordingCallback | null = null;
  private tabAudioRecordingActive: boolean = false;
  /** Last passthrough output device used for tab capture (for mid-session tab switch). */
  private tabAudioOutputDeviceId: string | undefined = undefined;


  constructor() {
    // Initialize modern audio components
    this.recorder = new ModernAudioRecorder({ 
      sampleRate: 24000, 
      enablePassthrough: true
    });
    
    this.player = new ModernAudioPlayer({ 
      sampleRate: 24000 
    });
    
    // Initialize virtual speaker player only in Electron
    this.virtualSpeakerPlayer = null;
    if (ServiceFactory.isElectron()) {
      console.info('[Sokuji] [ModernBrowserAudio] Initializing virtual speaker player for Electron');
      this.virtualSpeakerPlayer = new ModernAudioPlayer({
        sampleRate: 24000,
        // Meeting apps downmix the HAL loopback and TTS is often well below
        // full scale. 2.5× (~8 dB) keeps speech clearly audible without
        // clipping typical synthesizer peaks.
        outputGain: 2.5,
      });
    }
  }

  /**
   * Initialize the modern audio service
   */
  async initialize(): Promise<void> {
    // Make initialization idempotent AND concurrency-safe. Two effects mount at
    // startup — Home's initializeAudioService and MainPanel's initAudioService —
    // and React StrictMode double-invokes each in dev, so up to four
    // initialize() calls race on this singleton. The `initialized` flag alone is
    // not enough because it is only set at the very end (after several awaits),
    // so every overlapping caller passes the guard below and each would run
    // detectAndSetVirtualSpeaker() -> getDevices() -> getUserMedia() on the mic
    // concurrently, tripping "NotReadableError: Could not start audio source".
    // Caching the in-flight promise makes all callers share one initialization.
    if (this.initialized) {
      console.info('[Sokuji] [ModernBrowserAudio] Audio service already initialized');
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((err) => {
        this.initPromise = null; // allow a retry after a failed initialization
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // Connect the player
    await this.player.connect();

    // Connect virtual speaker player if available
    if (this.virtualSpeakerPlayer) {
      await this.virtualSpeakerPlayer.connect();
      // Player defaults to monitor-off (gain 0). Virtual mic must stay at
      // full output even before the first setMonitorVolume() call.
      this.virtualSpeakerPlayer.setGlobalVolume(1.0);
      // Auto-detect and configure virtual speaker device
      await this.detectAndSetVirtualSpeaker();
    }
    
    // Initialize passthrough settings (will be configured later via setupPassthrough)
    this.recorder.setupPassthrough(false, 0.3);

    // Get tabId from URL parameters if available
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const tabIdParam = urlParams.get('tabId');
      
      if (tabIdParam) {
        this.targetTabId = parseInt(tabIdParam, 10);
        console.info(`[Sokuji] [ModernBrowserAudio] Initialized with target tabId: ${this.targetTabId}`);
      }
      
    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Error parsing URL parameters:', error);
    }

    this.initialized = true;
    console.info('[Sokuji] [ModernBrowserAudio] Audio service initialized');
  }

  /**
   * Get available audio input and output devices
   */
  async getDevices(options: AudioDeviceQueryOptions = {}): Promise<AudioDevices> {
    try {
      // The extension's participant channel captures the current tab with
      // chrome.tabCapture. It does not need microphone access. Do not open the
      // mic merely to reveal device labels during extension startup; choosing
      // You/Both still requests it naturally when mic recording begins.
      const requestMicrophonePermission =
        options.requestMicrophonePermission ?? !isExtension();

      // Enumerate FIRST. Once microphone permission has been granted for this
      // origin (always the case in Electron after the first run), enumerate
      // returns fully-labeled devices WITHOUT needing an active stream — so the
      // getUserMedia({ audio: true }) warm-up is only needed to unlock labels
      // the very first time.
      //
      // Crucially, the warm-up opens the system DEFAULT input device. If that
      // default is broken — e.g. a stale/phantom "3- ZUM-2" left by a
      // replugged USB mic — getUserMedia hangs ~20s and then throws
      // NotReadableError, even though every real device enumerates fine and the
      // user's *selected* mic works. The old code let that warm-up failure
      // discard the entire (good) device list and return empty, so the UI
      // reported "no audio devices". We must never do that: enumerate is the
      // source of truth for the device list; the warm-up is best-effort.
      let devices = await navigator.mediaDevices.enumerateDevices();

      // The warm-up exists to unlock MICROPHONE (input) labels, so key the
      // decision on inputs only. A labeled audiooutput can otherwise mask
      // unlabeled inputs and skip a warm-up the mic picker still needs. If
      // there are no inputs at all, there is nothing to warm up.
      const needsMicrophoneWarmup = requestMicrophonePermission && devices.some(
        d => d.kind === 'audioinput' && d.label === ''
      );

      if (needsMicrophoneWarmup) {
        // Input labels missing => mic permission not yet granted this session.
        // Warm up to unlock them, but if the warm-up fails (e.g. broken default
        // device), fall through with whatever enumerate already gave us instead
        // of wiping the list.
        try {
          await this.ensureMicrophonePermission();
          devices = await navigator.mediaDevices.enumerateDevices();
        } catch (permissionError: any) {
          console.error('[Sokuji] [ModernBrowserAudio] Microphone permission warm-up failed; returning enumerated devices anyway:', permissionError);
          this.showPermissionError(permissionError);
        }
      }

      const enumeratedInputs = devices.filter(device => device.kind === 'audioinput');
      const hasConcreteInput = enumeratedInputs.some(
        device => device.deviceId !== '' &&
          device.deviceId !== 'default' &&
          device.deviceId !== 'communications'
      );

      const inputs = enumeratedInputs
        // Before mic permission, Chrome commonly exposes only a "default"
        // placeholder. Keep that placeholder so You/Both can start and let
        // getUserMedia show the permission prompt at the moment it is needed.
        .filter(device =>
          (requestMicrophonePermission || hasConcreteInput)
            ? device.deviceId !== 'default' && device.deviceId !== 'communications'
            : device.deviceId !== 'communications'
        )
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label ||
            (device.deviceId === 'default' || device.deviceId === ''
              ? 'Default microphone'
              : `Microphone ${device.deviceId.substring(0, 5)}...`),
          // Use the same detector as the Settings device pickers (hooks.ts) so a
          // device flagged virtual there is also excluded from default-selection
          // fallbacks here — e.g. Sokuji's own "Sokuji_Virtual_Mic" (the monitor of
          // its own virtual speaker, meant for other apps to consume, not for
          // Sokuji to listen to itself).
          isVirtual: device.label ? isVirtualMic(device) : false
        }));

      const outputs = devices
        .filter(device => device.kind === 'audiooutput')
        .filter(device => device.deviceId !== 'default')
        .filter(device => device.deviceId !== 'communications')
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `Speaker ${device.deviceId.substring(0, 5)}...`,
          isVirtual: device.label ? isVirtualSpeaker(device) : false
        }));
      
      return { inputs, outputs };
    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Failed to get audio devices:', error);
      return { inputs: [], outputs: [] };
    }
  }

  /**
   * Warm up microphone permission so enumerateDevices() returns labeled
   * devices, then release the stream immediately.
   *
   * Serialized via a shared in-flight promise: at startup getDevices() is
   * called from several overlapping paths (initialize()'s
   * detectAndSetVirtualSpeaker + the store's refreshDevices, each doubled by
   * React StrictMode). Without this guard they fire concurrent
   * getUserMedia({ audio: true }) on the same physical mic, and drivers that
   * cannot open one device twice reject the losers with
   * "NotReadableError: Could not start audio source". Sharing one warm-up
   * collapses them into a single open. The stream is stopped right away
   * because enumerateDevices() only needs permission to have been granted, not
   * a live track (leaving it open would leak an audio source that is only
   * released on process teardown — abrupt on Windows and prone to stranding
   * the capture endpoint for the next launch).
   * @private
   */
  private ensureMicrophonePermission(): Promise<void> {
    if (!this.permissionWarmupPromise) {
      this.permissionWarmupPromise = (async () => {
        const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        permStream.getTracks().forEach(track => track.stop());
      })().finally(() => {
        // Clear once settled so a later refresh can re-warm; concurrent callers
        // still share this single in-flight open.
        this.permissionWarmupPromise = null;
      });
    }
    return this.permissionWarmupPromise;
  }

  /**
   * Synchronously release the microphone device on page/window close.
   *
   * The renderer holds the mic through the recorder's capture stream (and the
   * warm-up stream, already stopped). Nothing stops these when the window
   * closes — the empty MainPanel cleanup and the analytics-only beforeunload
   * handler leave the OS to reclaim the device on process teardown. On Windows
   * that teardown is abrupt and can strand the WASAPI capture endpoint, so the
   * next launch's getUserMedia fails with
   * "NotReadableError: Could not start audio source" until the endpoint resets
   * (often only after a reboot). Stopping the tracks here, wired to `pagehide`,
   * makes the release clean and deterministic on every close.
   */
  public releaseMicrophone(): void {
    try {
      this.recorder.releaseStream();
    } catch (error) {
      console.warn('[Sokuji] [ModernBrowserAudio] Error releasing microphone on close:', error);
    }
  }

  /**
   * Show permission error to user
   * @private
   */
  private showPermissionError(permissionError: any): void {
    const errorType = permissionError.name || 'Error';
    let errorMessage = 'Unable to access your microphone. ';
    
    if (errorType === 'NotAllowedError' || errorType === 'PermissionDeniedError') {
      let permissionUrl = '';
      if (chrome && chrome.runtime && chrome.runtime.getURL) {
        permissionUrl = chrome.runtime.getURL('permission.html');
      }
      
      errorMessage += 'Please allow microphone access to use this extension. ';
      
      if (permissionUrl) {
        errorMessage += `<a href="${permissionUrl}" target="_blank" style="color: white; text-decoration: underline; font-weight: bold;">Click here</a> to grant microphone permission, or `;
      }
      
      errorMessage += 'click the camera/microphone icon in your browser address bar and grant permission.';
    } else if (errorType === 'NotFoundError') {
      errorMessage += 'No microphone was found on your device.';
    } else if (errorType === 'NotReadableError') {
      errorMessage += 'Your microphone is already in use by another application.';
    } else {
      errorMessage += `Error details: ${permissionError.message || errorType}`;
    }
    
    // Display error message to user
    if (typeof window !== 'undefined') {
      this.displayErrorNotification(errorMessage);
    }
  }

  /**
   * Display error notification
   * @private
   */
  private displayErrorNotification(errorMessage: string): void {
    // Create or update error notification element
    let notification = document.getElementById('sokuji-mic-error');
    if (!notification) {
      notification = document.createElement('div');
      notification.id = 'sokuji-mic-error';
      notification.style.cssText = 'position:fixed; top:10px; left:50%; transform:translateX(-50%); '
        + 'background:#f44336; color:white; padding:12px 24px; border-radius:4px; z-index:9999; '
        + 'max-width:80%; text-align:center; box-shadow:0 2px 5px rgba(0,0,0,0.3); font-family:sans-serif;';
      
      // Add close button
      const closeBtn = document.createElement('button');
      closeBtn.innerHTML = '&times;';
      closeBtn.style.cssText = 'background:none; border:none; color:white; font-size:20px; '
        + 'position:absolute; right:5px; top:5px; cursor:pointer; padding:0 5px;';
      closeBtn.onclick = () => notification?.remove();
      notification.appendChild(closeBtn);
      
      document.body.appendChild(notification);
    }
    
    // Add message content
    notification.innerHTML = `<div>${errorMessage}</div>`;
    
    // Auto-hide after 15 seconds
    setTimeout(() => notification?.remove(), 15000);
  }

  /**
   * Detect and configure virtual speaker device for Electron
   * @private
   */
  private async detectAndSetVirtualSpeaker(): Promise<void> {
    try {
      const devices = await this.getDevices();

      // First priority: Look for Sokuji_Virtual_Speaker (Linux)
      let virtualSpeaker = devices.outputs.find(device =>
        device.label.includes('Sokuji_Virtual_Speaker')
      );

      // Second priority: Look for SokujiVirtualAudio (Mac)
      if (!virtualSpeaker) {
        virtualSpeaker = devices.outputs.find(device =>
          device.label.includes('SokujiVirtualAudio')
        );
      }

      // Third priority: Look for VB-CABLE devices (Windows)
      if (!virtualSpeaker) {
        virtualSpeaker = devices.outputs.find(device =>
          device.label.toUpperCase().includes('CABLE')
        );
      }

      if (virtualSpeaker && this.virtualSpeakerPlayer) {
        await this.virtualSpeakerPlayer.setSinkId(virtualSpeaker.deviceId);
        console.info('[Sokuji] [ModernBrowserAudio] Virtual speaker detected and configured:', virtualSpeaker.label);
      } else if (this.virtualSpeakerPlayer) {
        console.warn('[Sokuji] [ModernBrowserAudio] Virtual speaker device not found (neither Sokuji_Virtual_Speaker, SokujiVirtualAudio, nor VB-CABLE)');
      }
    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Error detecting virtual speaker:', error);
    }
  }

  /**
   * Connect to a monitoring device
   */
  async connectMonitoringDevice(deviceId: string, label: string): Promise<AudioOperationResult> {
    try {
      console.debug(`[Sokuji] [ModernBrowserAudio] Connecting monitoring device: ${label} (${deviceId})`);
      
      const success = await this.player.setSinkId(deviceId);
      
      if (success) {
        // Re-detect virtual speaker when output device changes
        if (this.virtualSpeakerPlayer) {
          await this.detectAndSetVirtualSpeaker();
        }
        
        return {
          success: true,
          message: `Connected to monitoring device: ${label}`
        };
      } else {
        return {
          success: false,
          error: 'Failed to set output device'
        };
      }
    } catch (error: any) {
      console.error('[Sokuji] [ModernBrowserAudio] Error connecting monitoring device:', error);
      return {
        success: false,
        error: error.message || 'Failed to connect monitoring device'
      };
    }
  }

  /**
   * Disconnect from all monitoring devices
   */
  async disconnectMonitoringDevices(): Promise<AudioOperationResult> {
    try {
      // Reset to default output
      await this.player.setSinkId('');
      
      return {
        success: true,
        message: 'Disconnected from all monitoring devices'
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to disconnect monitoring devices'
      };
    }
  }

  /**
   * Create virtual devices (not applicable for browser extensions)
   */
  async createVirtualDevices(): Promise<AudioOperationResult> {
    return {
      success: true,
      message: 'Using modern browser audio APIs with echo cancellation support'
    };
  }

  /**
   * Check if the platform supports virtual devices
   */
  supportsVirtualDevices(): boolean {
    return false; // Browser extensions use virtual microphone through messaging
  }

  /**
   * Setup virtual audio output
   */
  async setupVirtualAudioOutput(): Promise<boolean> {
    // Modern implementation doesn't need special virtual output setup
    // HTMLAudioElement handles echo cancellation automatically
    console.info('[Sokuji] [ModernBrowserAudio] Virtual audio output ready with modern implementation');
    return true;
  }

  /**
   * Get the modern audio player (compatibility method)
   */
  public getWavStreamPlayer(): ModernAudioPlayer {
    return this.player;
  }

  /**
   * Whether assistant (TTS) audio is still queued in either playback path.
   * The audible Electron path is the virtual speaker player; the monitor/WebRTC
   * path is the main player. Echo-gating must cover both, because macOS
   * loopback capture lags the actual output by up to seconds.
   */
  public hasPendingTtsAudio(): boolean {
    if (this.player && typeof (this.player as { hasPendingAudio?: () => boolean }).hasPendingAudio === 'function'
      && (this.player as { hasPendingAudio: () => boolean }).hasPendingAudio()) {
      return true;
    }
    if (this.virtualSpeakerPlayer
      && typeof (this.virtualSpeakerPlayer as { hasPendingAudio?: () => boolean }).hasPendingAudio === 'function'
      && (this.virtualSpeakerPlayer as { hasPendingAudio: () => boolean }).hasPendingAudio()) {
      return true;
    }
    return false;
  }

  /**
   * Set monitor volume (0 to mute, 1 for normal)
   * @param enabled Whether monitor is enabled
   */
  public setMonitorVolume(enabled: boolean): void {
    const volume = enabled ? 1.0 : 0.0;
    this.player.setGlobalVolume(volume);
    console.debug(`[Sokuji] [ModernBrowserAudio] Monitor volume set to: ${volume}`);
    
    // Virtual speaker always plays at full volume (not affected by monitor toggle)
    if (this.virtualSpeakerPlayer) {
      this.virtualSpeakerPlayer.setGlobalVolume(1.0);
    }
  }

  /**
   * Re-bind the virtual speaker and start its element. Both mode never
   * connects a monitor device, so this is the only path that keeps TTS
   * flowing into SokujiVirtualAudio after a cold start.
   */
  public async ensureVirtualSpeakerOutput(): Promise<void> {
    if (!this.virtualSpeakerPlayer) return;
    await this.virtualSpeakerPlayer.connect();
    this.virtualSpeakerPlayer.setGlobalVolume(1.0);
    await this.detectAndSetVirtualSpeaker();
    if (typeof this.virtualSpeakerPlayer.ensurePlaying === 'function') {
      await this.virtualSpeakerPlayer.ensurePlaying();
    }
  }

  /**
   * Add audio data for playback and virtual microphone
   * @param data The audio data to add
   * @param trackId Optional track ID
   * @param shouldPlay Whether to play the audio (not used, kept for compatibility)
   * @param metadata Optional metadata (e.g., itemId for tracking)
   */
  public addAudioData(data: Int16Array, trackId?: string, shouldPlay?: boolean, metadata?: any): void {
    let result = data;
    
    // Always add audio to player - let global volume control handle muting
    // Use streaming audio for real-time playback to avoid audio fragments
    // Pass metadata to the player for tracking
    result = this.player.addStreamingAudio(result, trackId, 1.0, metadata);
    
    // Also add to virtual speaker player if available (Electron only)
    if (this.virtualSpeakerPlayer) {
      this.virtualSpeakerPlayer.addStreamingAudio(data, trackId, 1.0, metadata);
    }
    
    // Always send to virtual microphone (maintain compatibility)
    this.sendPcmDataToTabs(result, trackId);
  }

  /**
   * Send PCM data to tabs for virtual microphone
   * Maintains full compatibility with existing implementation
   */
  public sendPcmDataToTabs(data: Int16Array, trackId?: string): void {
    // Skip empty data
    if (!data || data.length === 0) {
      console.debug('[Sokuji] [ModernBrowserAudio] Attempted to send empty audio data');
      return;
    }
    
    // Get sample rate from player
    const sampleRate = this.player?.sampleRate || 24000;
    
    // Use an appropriate chunk size based on the data size
    const isLargeFile = data.length > 48000; // > 2 seconds at 24kHz
    const chunkSize = isLargeFile ? 4800 : 9600; // 200ms or 400ms chunks
    
    // Calculate the total number of chunks needed
    const totalChunks = Math.ceil(data.length / chunkSize);
    
    if (isLargeFile) {
      console.info(`[Sokuji] [ModernBrowserAudio] Sending audio data (${data.length} samples, ~${(data.length / sampleRate).toFixed(2)}s) in ${totalChunks} chunks`);
    }
    
    // Process chunks recursively
    const processChunk = (chunkIndex: number): void => {
      // Calculate start and end positions for this chunk
      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize, data.length);
      
      // Create a slice of data for this chunk
      const chunkData = data.slice(start, end);
      
      // Create a message object with all necessary metadata - using PCM_DATA format
      const message = {
        type: 'PCM_DATA',
        pcmData: Array.from(chunkData), // Convert to regular array for serialization
        chunkIndex: chunkIndex,
        totalChunks: totalChunks,
        sampleRate: sampleRate,
        trackId: trackId || 'default',
        timestamp: Date.now()
      };
      
      // Send the message to the appropriate tabs
      this.sendMessageToTabs(message);
      
      // Process the next chunk if not done
      if (chunkIndex < totalChunks - 1) {
        processChunk(chunkIndex + 1);
      }
    };
    
    // Start processing with the first chunk
    processChunk(0);
  }

  /**
   * Send message to tabs
   * @private
   */
  private sendMessageToTabs(message: any): void {
    // Only proceed if Chrome extension API is available
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
      return; // Silent fail in non-extension context
    }
    
    // If we have a specific target tab ID from URL, use it directly
    if (this.targetTabId !== null) {
      this.sendMessageToTab(this.targetTabId, message);
      return;
    }
    
    // Otherwise send to all tabs
    this.sendToAllTabs(message);
  }

  /**
   * Send message to specific tab
   * @private
   */
  private sendMessageToTab(tabId: number, message: any): void {
    // Check if the tab still exists
    chrome.tabs.get(tabId, (tab: any) => {
      if (chrome.runtime.lastError) {
        // Fall back to sending to all tabs
        this.sendToAllTabs(message);
        return;
      }
      
      if (!tab) {
        this.sendToAllTabs(message);
        return;
      }
      
      // Tab exists, send the message
      chrome.tabs.sendMessage(tabId, message, (_response: any) => {
        if (chrome.runtime.lastError) {
          console.warn(`[Sokuji] [ModernBrowserAudio] Error sending to tab ${tabId}: ${chrome.runtime.lastError.message}`);
        }
      });
    });
  }

  /**
   * Send message to all tabs
   * @private
   */
  private sendToAllTabs(message: any): void {
    chrome.tabs.query({}, (tabs: any[]) => {
      if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
        return;
      }
      
      // Send to all tabs (excluding extension pages)
      for (const tab of tabs) {
        // Skip chrome:// pages and extension pages
        if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
          continue;
        }
        
        chrome.tabs.sendMessage(tab.id, message, (_response: any) => {
          // Ignore errors, as not all tabs will have our content script
          if (chrome.runtime.lastError) {
            console.debug(`[Sokuji] [ModernBrowserAudio] Tab ${tab.id} not ready: ${chrome.runtime.lastError.message}`);
          }
        });
      }
    });
  }

  /**
   * Interrupt currently playing audio
   */
  public async interruptAudio(): Promise<{ trackId: string; offset: number } | null> {
    const rawResult = await this.player.interrupt();
    
    // Also interrupt virtual speaker player
    if (this.virtualSpeakerPlayer) {
      await this.virtualSpeakerPlayer.interrupt();
    }
    
    // If no result or trackId is null, return null
    if (!rawResult || rawResult.trackId === null) {
      return null;
    }
    
    // Track interrupted track IDs
    this.interruptedTrackIds[rawResult.trackId] = true;
    
    // Return only the properties we need in the correct format
    return {
      trackId: rawResult.trackId,
      offset: rawResult.offset
    };
  }

  /**
   * Clear streaming audio data for a specific track
   * @param trackId The track ID to clear
   */
  public clearStreamingTrack(trackId: string): void {
    this.player.clearStreamingTrack(trackId);
    
    // Also clear from virtual speaker player
    if (this.virtualSpeakerPlayer) {
      this.virtualSpeakerPlayer.clearStreamingTrack(trackId);
    }
  }

  /**
   * Clear interrupted tracks
   */
  public clearInterruptedTracks(): void {
    this.interruptedTrackIds = {};
    // Also clear interrupted tracks in the player
    this.player.clearInterruptedTracks();
    

    // Also clear from virtual speaker player
    if (this.virtualSpeakerPlayer) {
      this.virtualSpeakerPlayer.clearInterruptedTracks();
    }
    
    console.debug('[Sokuji] [ModernBrowserAudio] Cleared interrupted tracks');
  }

  /**
   * Start recording audio from the specified device
   */
  public async startRecording(deviceId: string | undefined, callback: AudioRecordingCallback): Promise<void> {
    const run = this.micOpChain.then(() => this.applyStartRecording(deviceId, callback));
    this.micOpChain = run.catch(() => { /* next op must not stall */ });
    return run;
  }

  private async applyStartRecording(deviceId: string | undefined, callback: AudioRecordingCallback): Promise<void> {
    this.recordingCallback = callback;

    console.debug(`[Sokuji] [ModernBrowserAudio] Starting recording from device: ${deviceId}`);
    
    // Check if we need to switch devices
    const recorderStatus = this.recorder.getStatus();
    const needsDeviceSwitch = this.currentRecordingDeviceId !== deviceId && recorderStatus !== 'ended';
    
    if (needsDeviceSwitch) {
      console.info(`[Sokuji] [ModernBrowserAudio] Switching recording device from ${this.currentRecordingDeviceId} to ${deviceId}`);
      // Need to end current recording session to switch devices
      await this.recorder.end();
    }
    
    // Check if recorder needs to be connected
    if (this.recorder.getStatus() === 'ended') {
      // Connect with the (potentially new) device
      await this.recorder.begin(deviceId);
      this.currentRecordingDeviceId = deviceId;
    }

    if (this.recorder.getStatus() === 'ended') {
      throw new Error('Failed to start the microphone. Check input permissions and try again.');
    }

    // Start recording with callback that handles both AI and passthrough
    await this.recorder.record((data) => {
      // Handle passthrough BEFORE the external callback, because some clients
      // (e.g. LocalInferenceClient) transfer the audio buffer to a Worker via
      // postMessage, which detaches/neuters the ArrayBuffer.  Passthrough must
      // read the buffer while it is still valid.  (#177)
      if (data.isPassthrough && data.mono) {
        this.handlePassthroughAudio(data.mono, data.passthroughVolume || 0.3);
      }

      // Forward to the external callback (MainPanel will send to AI)
      if (this.recordingCallback) {
        this.recordingCallback(data);
      }
    });
  }

  /**
   * Stop recording and clean up resources
   */
  public async stopRecording(): Promise<void> {
    const run = this.micOpChain.then(async () => {
      if (this.recorder.getStatus() !== 'ended') {
        await this.recorder.end();
      }
      this.recordingCallback = null;
      this.currentRecordingDeviceId = undefined;
    });
    this.micOpChain = run.catch(() => { /* next op must not stall */ });
    return run;
  }

  /**
   * Pause recording (keeps resources allocated)
   */
  public async pauseRecording(): Promise<void> {
    const run = this.micOpChain.then(async () => {
      if (this.recorder.getStatus() === 'recording') {
        await this.recorder.pause();
      }
    });
    this.micOpChain = run.catch(() => { /* next op must not stall */ });
    return run;
  }

  /**
   * Switch recording device while maintaining session
   * @param deviceId The new device ID to switch to
   */
  public async switchRecordingDevice(deviceId: string | undefined): Promise<void> {
    const run = this.micOpChain.then(() => this.applySwitchRecordingDevice(deviceId));
    this.micOpChain = run.catch(() => { /* next op must not stall */ });
    return run;
  }

  private async applySwitchRecordingDevice(deviceId: string | undefined): Promise<void> {
    if (this.currentRecordingDeviceId === deviceId) {
      console.debug(`[Sokuji] [ModernBrowserAudio] Already using device: ${deviceId}`);
      return;
    }

    console.info(`[Sokuji] [ModernBrowserAudio] Switching recording device from ${this.currentRecordingDeviceId} to ${deviceId}`);
    
    // Save the current recording state
    const wasRecording = this.recorder.getStatus() === 'recording';
    const savedCallback = this.recordingCallback;
    
    // End current recording session
    if (this.recorder.getStatus() !== 'ended') {
      await this.recorder.end();
    }
    
    // Begin with new device
    await this.recorder.begin(deviceId);
    this.currentRecordingDeviceId = deviceId;

    if (this.recorder.getStatus() === 'ended') {
      throw new Error('Failed to start the microphone on the new device. Check input permissions and try again.');
    }
    
    // Resume recording if it was active
    if (wasRecording && savedCallback) {
      await this.recorder.record((data) => {
        // Passthrough before external callback — see #177
        if (data.isPassthrough && data.mono) {
          this.handlePassthroughAudio(data.mono, data.passthroughVolume || 0.3);
        }

        if (savedCallback) {
          savedCallback(data);
        }
      });
    }
  }

  /**
   * Get the recorder instance
   */
  public getRecorder(): ModernAudioRecorder {
    return this.recorder;
  }

  /**
   * Setup passthrough settings
   */
  public setupPassthrough(enabled: boolean, volume: number): void {
    this.recorder.setupPassthrough(enabled, volume);
  }

  /**
   * Handle passthrough audio routing to outputs
   */
  public handlePassthroughAudio(audioData: Int16Array, volume: number): void {
    const delay = 150; // ms delay for echo cancellation

    // Send to monitor output
    this.player.addToPassthroughBuffer(audioData, volume, delay);
    
    // Send to virtual speaker if available
    if (this.virtualSpeakerPlayer) {
      this.virtualSpeakerPlayer.addToPassthroughBuffer(audioData, volume, delay);
    }

    // Apply volume before sending to virtual microphone (for extension environment)
    const volumeAdjustedData = this.applyPassthroughVolume(audioData, volume);
    this.sendPcmDataToTabs(volumeAdjustedData, 'passthrough');
  }

  /**
   * Apply volume to passthrough audio data
   * @private
   */
  private applyPassthroughVolume(buffer: Int16Array, volume: number): Int16Array {
    if (volume === 1.0) return buffer;

    const result = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      result[i] = Math.round(buffer[i] * volume);
    }
    return result;
  }

  // ============================================
  // System Audio Capture Methods
  // ============================================

  /**
   * Check if system audio capture is supported
   * Supported on:
   * - Linux with Electron (uses PipeWire/PulseAudio)
   * - Windows/macOS with Electron (uses electron-audio-loopback)
   * - Browser extension (uses Chrome tabCapture API)
   */
  public supportsSystemAudioCapture(): boolean {
    // Check if we're in Electron
    if (ServiceFactory.isElectron() && window.electron) {
      // The actual platform check is done in the main process
      return true;
    }
    // Check if we're in browser extension
    if (isExtension()) {
      return true;
    }
    return false;
  }

  /**
   * Get available system audio sources (audio outputs that can be captured)
   */
  public async getSystemAudioSources(): Promise<AudioDevice[]> {
    if (!ServiceFactory.isElectron() || !window.electron) {
      return [];
    }

    try {
      // Check if platform supports system audio capture
      const supported = await window.electron.invoke('supports-system-audio-capture');
      if (!supported) {
        console.info('[Sokuji] [ModernBrowserAudio] System audio capture not supported on this platform');
        return [];
      }

      // Get list of audio sinks from the main process
      const sources = await window.electron.invoke('list-system-audio-sources');
      console.info('[Sokuji] [ModernBrowserAudio] Found system audio sources:', sources?.length || 0);
      return sources || [];
    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Error getting system audio sources:', error);
      return [];
    }
  }

  /**
   * Connect a system audio source to the virtual mic
   * Called when user selects a system audio device
   * Sets state flags for electron-audio-loopback capture via getDisplayMedia
   * @param sourceDeviceId The sink name to capture audio from
   */
  public async connectSystemAudioSource(sourceDeviceId: string): Promise<void> {
    if (!ServiceFactory.isElectron() || !window.electron) {
      throw new Error('System audio capture is only supported in Electron');
    }

    try {
      console.info(`[Sokuji] [ModernBrowserAudio] Connecting system audio source: ${sourceDeviceId}`);
      const result = await window.electron.invoke('connect-system-audio-source', sourceDeviceId);

      if (result?.success === false) {
        throw new Error(result.error || 'Failed to connect system audio source');
      }

      // A 'capture: app' result means the main process will drive the
      // per-application helper instead of getDisplayMedia loopback.
      this.currentCaptureMode = result?.capture === 'app' ? 'app' : 'system';

      // A monitorLabel means the main process created a per-application tap and
      // we must record its monitor device. If it cannot be found, degrade to
      // whole-system capture rather than failing the session outright.
      this.currentMonitorDeviceId = null;
      if (result?.monitorLabel) {
        this.currentMonitorDeviceId = await this.resolveMonitorDeviceId(result.monitorLabel);
        if (!this.currentMonitorDeviceId) {
          console.warn(
            '[Sokuji] [ModernBrowserAudio] Application capture monitor not found; ' +
            'falling back to whole-system audio'
          );
        }
      }

      // Store the connection info
      this.systemAudioSourceConnected = true;
      this.currentSystemAudioSinkId = sourceDeviceId;

      console.info(`[Sokuji] [ModernBrowserAudio] System audio source connected: ${sourceDeviceId}`);
    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Failed to connect system audio source:', error);
      // Reset state on failure
      this.systemAudioSourceConnected = false;
      this.currentSystemAudioSinkId = undefined;
      this.currentCaptureMode = 'system';
      this.currentMonitorDeviceId = null;
      throw error;
    }
  }

  /**
   * Map a capture-sink description to a Chromium input deviceId.
   *
   * The main process cannot know Chromium's opaque deviceId, so it reports the
   * sink description instead and we match on the enumerated label, which
   * Chromium renders as "Monitor of <description>".
   */
  private async resolveMonitorDeviceId(monitorLabel: string): Promise<string | null> {
    // The sink was created moments ago and the browser's device list refreshes
    // asynchronously, so a single lookup can miss it. Retry briefly rather than
    // degrade to whole-system audio over a few milliseconds.
    for (let attempt = 0; attempt < 10; attempt++) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const match = devices.find(
        (d) => d.kind === 'audioinput' && d.label.includes(monitorLabel)
      );
      if (match) return match.deviceId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  /**
   * Disconnect the current system audio source
   * Called when user deselects the system audio device
   */
  public async disconnectSystemAudioSource(): Promise<void> {
    console.info('[Sokuji] [ModernBrowserAudio] Disconnecting system audio source');

    // Stop recording first if active
    if (this.systemAudioRecordingActive) {
      await this.stopSystemAudioRecording();
    }

    // Disconnect in the main process
    if (ServiceFactory.isElectron() && window.electron) {
      try {
        await window.electron.invoke('disconnect-system-audio-source');
      } catch (error) {
        console.warn('[Sokuji] [ModernBrowserAudio] Error disconnecting system audio source:', error);
      }
    }

    this.systemAudioSourceConnected = false;
    this.currentSystemAudioSinkId = undefined;
    this.currentCaptureMode = 'system';
    this.currentMonitorDeviceId = null;
    console.info('[Sokuji] [ModernBrowserAudio] System audio source disconnected');
  }

  /**
   * Check if a system audio source is currently connected
   */
  public isSystemAudioSourceConnected(): boolean {
    return this.systemAudioSourceConnected;
  }

  /**
   * Start recording from the system audio source
   * Called when session starts
   * All desktop platforms use electron-audio-loopback via getDisplayMedia
   * @param callback Function to receive audio data chunks
   */
  public async startSystemAudioRecording(callback: AudioRecordingCallback): Promise<void> {
    if (!this.systemAudioSourceConnected) {
      throw new Error('System audio source not connected. Connect a source first.');
    }

    // Stop any existing recording
    if (this.systemAudioRecordingActive) {
      await this.stopSystemAudioRecording();
    }

    if (this.currentCaptureMode === 'app' && this.currentSystemAudioSinkId) {
      try {
        await this.startAppAudioRecording(this.currentSystemAudioSinkId, callback);
        return;
      } catch (error) {
        // Helper missing or failed for whole-system capture: fall back to
        // getDisplayMedia so an unbuilt helper does not kill the session.
        if (!isApplicationSource(this.currentSystemAudioSinkId)) {
          console.warn(
            '[Sokuji] [ModernBrowserAudio] Application helper failed for system capture; falling back to loopback:',
            error
          );
          await this.startLoopbackRecording(callback);
          return;
        }
        throw error;
      }
    }

    if (this.currentMonitorDeviceId) {
      await this.startDeviceCaptureRecording(this.currentMonitorDeviceId, callback);
      return;
    }

    await this.startLoopbackRecording(callback);
  }

  /**
   * Start system audio recording using electron-audio-loopback (all desktop platforms)
   * @param callback Function to receive audio data chunks
   */
  private async startLoopbackRecording(callback: AudioRecordingCallback): Promise<void> {
    try {
      console.info(`[Sokuji] [ModernBrowserAudio] Starting system audio recording via electron-audio-loopback`);

      // Create loopback recorder (uses electron-audio-loopback library)
      this.systemAudioRecorder = new LoopbackRecorder(24000);

      // Store the callback
      this.systemAudioCallback = callback;

      // Start capture
      // begin() throws with the underlying reason on failure.
      await this.systemAudioRecorder.begin();

      // Start recording with callback
      await this.systemAudioRecorder.record((data: { mono: Int16Array; raw: Int16Array }) => {
        if (this.systemAudioCallback) {
          this.systemAudioCallback(data);
        }
      });

      this.systemAudioRecordingActive = true;
      console.info(`[Sokuji] [ModernBrowserAudio] System audio recording started successfully`);
    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Failed to start loopback recording:', error);
      // Clean up on failure
      await this.stopSystemAudioRecording();
      throw error;
    }
  }

  /**
   * Record participant audio from a specific input device (Linux per-application
   * capture records the tap sink's monitor).
   */
  private async startDeviceCaptureRecording(
    deviceId: string,
    callback: AudioRecordingCallback
  ): Promise<void> {
    try {
      console.info(`[Sokuji] [ModernBrowserAudio] Starting application capture from device ${deviceId}`);
      this.systemAudioRecorder = new DeviceCaptureRecorder(24000);
      this.systemAudioCallback = callback;

      await this.systemAudioRecorder.begin({ deviceId });

      await this.systemAudioRecorder.record((data: { mono: Int16Array; raw: Int16Array }) => {
        if (this.systemAudioCallback) {
          this.systemAudioCallback(data);
        }
      });

      this.systemAudioRecordingActive = true;
      console.info('[Sokuji] [ModernBrowserAudio] Device audio capture started');
    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Failed to start device capture:', error);
      await this.stopSystemAudioRecording();
      throw error;
    }
  }

  /**
   * Record participant audio pushed from the per-application capture helper.
   *
   * A helper that dies mid-session must not silently kill participant audio, so
   * onLost restarts capture as whole-system loopback.
   */
  private async startAppAudioRecording(
    deviceId: string,
    callback: AudioRecordingCallback
  ): Promise<void> {
    try {
      console.info(`[Sokuji] [ModernBrowserAudio] Starting application capture for ${deviceId}`);
      const recorder = new AppAudioRecorder(24000);
      this.systemAudioRecorder = recorder;
      this.systemAudioCallback = callback;

      recorder.onWarning = (code) => this.onParticipantWarning?.(code);

      recorder.onLost = () => {
        console.warn('[Sokuji] [ModernBrowserAudio] Capture helper lost; falling back to system audio');
        this.currentCaptureMode = 'system';
        // The user chose one application; this widens capture to everything the
        // machine plays, so audio they never meant to share starts reaching the
        // translation provider. That has to be visible, not just logged.
        this.onParticipantWarning?.('app_capture_lost_using_system_audio');
        this.startSystemAudioRecording(callback).catch((e) =>
          console.error('[Sokuji] [ModernBrowserAudio] Fallback to system audio failed:', e));
      };

      const success = await recorder.begin({ deviceId });
      if (!success) {
        throw new Error('Failed to begin application audio capture');
      }

      await recorder.record((data: { mono: Int16Array; raw: Int16Array }) => {
        if (this.systemAudioCallback) {
          this.systemAudioCallback(data);
        }
      });

      this.systemAudioRecordingActive = true;
      console.info('[Sokuji] [ModernBrowserAudio] Application capture started');
    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Failed to start application capture:', error);
      await this.stopSystemAudioRecording();
      throw error;
    }
  }

  /**
   * Switch the participant source without ending the session.
   *
   * Mirrors switchRecordingDevice for the microphone: the capture is rebuilt
   * around the new source while the client, the conversation and the callback
   * all stay put. Whole-system and per-application sources are interchangeable
   * here - each connect() decides which capture path it needs.
   *
   * @param sourceDeviceId 'desktop-audio-loopback' or 'app:pid:<n>'
   */
  public async switchParticipantSource(sourceDeviceId: string): Promise<void> {
    // Serialized: each switch tears capture down and builds it back up, so two
    // rapid selections could interleave and leave the earlier one running while
    // the UI reports the later one. A rejected switch must not block the next.
    const run = this.participantSwitchChain.then(
      () => this.applyParticipantSource(sourceDeviceId),
      () => this.applyParticipantSource(sourceDeviceId)
    );
    this.participantSwitchChain = run.catch(() => { /* failure is the caller's */ });
    return run;
  }

  private async applyParticipantSource(sourceDeviceId: string): Promise<void> {
    if (this.currentSystemAudioSinkId === sourceDeviceId) {
      console.debug(`[Sokuji] [ModernBrowserAudio] Participant source unchanged: ${sourceDeviceId}`);
      return;
    }

    console.info(
      `[Sokuji] [ModernBrowserAudio] Switching participant source from ` +
      `${this.currentSystemAudioSinkId} to ${sourceDeviceId}`
    );

    // stopSystemAudioRecording clears the callback, and it is the only thing
    // tying the captured audio to the live client - take it before teardown.
    const savedCallback = this.systemAudioCallback;
    const previousSourceId = this.currentSystemAudioSinkId;

    await this.stopSystemAudioRecording();
    await this.disconnectSystemAudioSource();

    try {
      await this.connectSystemAudioSource(sourceDeviceId);
    } catch (error) {
      // The chosen application can be gone by the time it is picked - the list
      // is seconds old and pids do not survive a restart - so this is an
      // expected failure, not an exceptional one. Teardown has already
      // happened; without putting the previous source back the session would
      // keep running with no participant audio at all.
      console.warn(
        `[Sokuji] [ModernBrowserAudio] Failed to connect ${sourceDeviceId}; ` +
        `restoring ${previousSourceId ?? 'whole-system capture'}`
      );
      const fallback = previousSourceId ?? 'desktop-audio-loopback';
      try {
        await this.connectSystemAudioSource(fallback);
        if (savedCallback) await this.startSystemAudioRecording(savedCallback);
      } catch (restoreError) {
        console.error('[Sokuji] [ModernBrowserAudio] Restore failed too:', restoreError);
      }
      throw error;
    }

    if (savedCallback) {
      await this.startSystemAudioRecording(savedCallback);
    }
  }

  /**
   * Stop recording from system audio (but keep connection)
   * Called when session ends
   */
  public async stopSystemAudioRecording(): Promise<void> {
    console.info('[Sokuji] [ModernBrowserAudio] Stopping system audio recording');

    if (this.systemAudioRecorder) {
      // Detach the fallback before ending: end() kills the capture helper, and
      // its exit must not be read as the helper dying under us. That restarted
      // whole-system capture after the session had already stopped, leaving the
      // waveform alive and the machine still being recorded.
      (this.systemAudioRecorder as { onLost?: (() => void) | null }).onLost = null;
      try {
        await this.systemAudioRecorder.end();
      } catch (error) {
        console.warn('[Sokuji] [ModernBrowserAudio] Error ending system audio recorder:', error);
      }
      this.systemAudioRecorder = null;
    }

    this.systemAudioCallback = null;
    this.systemAudioRecordingActive = false;
    console.info('[Sokuji] [ModernBrowserAudio] System audio recording stopped');
  }

  /**
   * Check if system audio recording is currently active
   */
  public isSystemAudioRecordingActive(): boolean {
    return this.systemAudioRecordingActive;
  }

  // ============================================
  // Loopback Stream Pre-acquisition (Windows/macOS)
  // ============================================

  /**
   * Check whether loopback capture may proceed.
   *
   * Do not pre-acquire a temporary getDisplayMedia stream here. The real
   * LoopbackRecorder starts immediately after this check; opening and stopping
   * a throwaway stream first leaves Chromium/macOS closing the previous stream
   * while the real one starts, producing intermittent "active stream" failures.
   * For an undecided permission, the real (single) capture request owns the
   * system prompt and keeps that stream if access is granted.
   */
  public async requestLoopbackAudioStream(): Promise<boolean> {

    // Check if running in Electron
    if (!ServiceFactory.isElectron() || !window.electron) {
      console.info('[Sokuji] [ModernBrowserAudio] requestLoopbackAudioStream: Not in Electron, skipping');
      return true;
    }

    try {
      console.info('[Sokuji] [ModernBrowserAudio] Checking screen recording permission...');

      // Check screen recording permission (macOS only, Windows always returns 'granted')
      const permissionResult = await window.electron.invoke('check-screen-recording-permission');
      console.info('[Sokuji] [ModernBrowserAudio] Screen recording permission check result:', permissionResult);

      // Permission already granted - no need to show dialog
      if (permissionResult.status === 'granted') {
        console.info('[Sokuji] [ModernBrowserAudio] Screen recording permission already granted');
        return true;
      }

      // Permission explicitly denied - user must manually enable in System Preferences
      // Don't try to call enable-loopback-audio because it will crash the app with unhandled rejection
      if (permissionResult.status === 'denied') {
        console.warn('[Sokuji] [ModernBrowserAudio] Screen recording permission denied. User must enable in System Preferences.');
        return false;
      }

      console.info(
        '[Sokuji] [ModernBrowserAudio] Screen recording permission is',
        permissionResult.status,
        '- deferring the one permission request to LoopbackRecorder',
      );
      return true;

    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Error checking screen recording permission:', error);
      return false;
    }
  }


  // ============================================
  // Tab Audio Capture Methods (Extension)
  // ============================================

  /**
   * Check if tab audio capture is supported (extension only)
   */
  public supportsTabAudioCapture(): boolean {
    return isExtension();
  }

  /**
   * Extension: list capturable tabs for the Tab picker (http/https only).
   */
  public async listBrowserTabs(): Promise<Array<{
    deviceId: string;
    label: string;
    audible?: boolean;
    active?: boolean;
    url?: string;
  }>> {
    if (!isExtension()) return [];
    try {
      const response = await new Promise<{
        success?: boolean;
        tabs?: Array<{
          id: number;
          title: string;
          url: string;
          audible?: boolean;
          active?: boolean;
        }>;
      } | undefined>((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
          resolve(undefined);
          return;
        }
        chrome.runtime.sendMessage({ type: 'LIST_BROWSER_TABS' }, (res: any) => {
          if (chrome.runtime.lastError) resolve(undefined);
          else resolve(res);
        });
      });
      if (!response?.success || !Array.isArray(response.tabs)) return [];
      return response.tabs.map((tab) => {
        const playing = tab.audible ? '🔊 ' : '';
        const active = tab.active ? '• ' : '';
        return {
          deviceId: String(tab.id),
          label: `${playing}${active}${tab.title || tab.url || `Tab ${tab.id}`}`,
          audible: !!tab.audible,
          active: !!tab.active,
          url: tab.url,
        };
      });
    } catch (error) {
      console.warn('[Sokuji] [ModernBrowserAudio] listBrowserTabs failed:', error);
      return [];
    }
  }

  public getTargetTabId(): number | null {
    return this.targetTabId;
  }

  /**
   * Extension: select which tab to capture. Restarts live tab capture if active.
   */
  public async setTargetTabId(tabId: number): Promise<void> {
    if (!isExtension()) {
      throw new Error('Tab selection is only available in the browser extension');
    }
    if (!Number.isFinite(tabId) || tabId <= 0) {
      throw new Error('Invalid tab id');
    }
    const previous = this.targetTabId;
    this.targetTabId = tabId;
    console.info('[Sokuji] [ModernBrowserAudio] Target tab set to', tabId, '(was', previous, ')');

    // Mid-session switch: tear down and re-acquire the new tab's audio.
    if (this.tabAudioRecordingActive && this.tabAudioCallback) {
      const callback = this.tabAudioCallback;
      const outputDeviceId = this.tabAudioOutputDeviceId;
      await this.startTabAudioRecording(callback, outputDeviceId);
    }
  }

  /**
   * Get the target tab ID for audio capture.
   * Prefers URL params set by background script when the side panel is opened
   * via the action icon; falls back to a background resolve if the panel was
   * opened without ?tabId= (stale default_path).
   */
  private async getTargetTabIdForCapture(): Promise<number | null> {
    // Use cached value if available (user picked a tab in the picker)
    if (this.targetTabId !== null) {
      return this.targetTabId;
    }

    // Try to get from URL params
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const tabIdParam = urlParams.get('tabId');
      if (tabIdParam) {
        const parsed = parseInt(tabIdParam, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          this.targetTabId = parsed;
          return this.targetTabId;
        }
      }
    } catch (error) {
      console.error('[Sokuji] [ModernBrowserAudio] Error getting tabId:', error);
    }

    // Side panel often loads as chrome-extension://…/fullpage.html without
    // query params when Chrome reuses a previously opened panel. Ask the
    // background for the last-focused capturable tab.
    try {
      const resolved = await new Promise<{ success?: boolean; tabId?: number } | undefined>((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
          resolve(undefined);
          return;
        }
        chrome.runtime.sendMessage({ type: 'RESOLVE_CAPTURE_TAB' }, (response: any) => {
          if (chrome.runtime.lastError) {
            resolve(undefined);
          } else {
            resolve(response);
          }
        });
      });
      if (resolved?.success && resolved.tabId) {
        this.targetTabId = resolved.tabId;
        return this.targetTabId;
      }
    } catch (error) {
      console.warn('[Sokuji] [ModernBrowserAudio] RESOLVE_CAPTURE_TAB failed:', error);
    }

    return null;
  }

  /**
   * Start recording from the current tab's audio
   * Called when session starts with tab audio enabled
   * @param callback Function to receive audio data chunks
   * @param outputDeviceId Optional output device ID for audio playback
   */
  public async startTabAudioRecording(callback: AudioRecordingCallback, outputDeviceId?: string): Promise<void> {
    if (!isExtension()) {
      throw new Error('Tab audio capture is only supported in browser extension');
    }

    // Stop any existing recording and give Chrome a beat to drop the tab
    // from getCapturedTabs before minting a new streamId.
    if (this.tabAudioRecordingActive || this.tabAudioRecorder) {
      await this.stopTabAudioRecording();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const maxAttempts = 3;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.info(
          `[Sokuji] [ModernBrowserAudio] Starting tab audio recording (attempt ${attempt}/${maxAttempts})`,
        );

        // Get the target tab ID (picker / URL param / background resolve)
        const tabId = await this.getTargetTabIdForCapture();
        if (!tabId) {
          throw new Error(
            'Could not determine which tab to capture. Open the video/meeting tab, click the MAO Chat icon on that tab, then Start again.',
          );
        }

        // Create a new TabAudioRecorder
        this.tabAudioRecorder = new TabAudioRecorder(24000); // 24kHz sample rate

        // Store the callback + output device so setTargetTabId can hot-switch.
        this.tabAudioCallback = callback;
        this.tabAudioOutputDeviceId = outputDeviceId;

        // Throws with a humanized reason on failure (see ParticipantRecorder.begin).
        await this.tabAudioRecorder.begin({ tabId, outputDeviceId });

        // Start recording with the callback
        await this.tabAudioRecorder.record((data) => {
          if (this.tabAudioCallback) {
            this.tabAudioCallback(data);
          }
        });

        this.tabAudioRecordingActive = true;
        console.info('[Sokuji] [ModernBrowserAudio] Tab audio recording started successfully');
        return;
      } catch (error) {
        lastError = error;
        console.error(
          `[Sokuji] [ModernBrowserAudio] Failed to start tab audio recording (attempt ${attempt}):`,
          error,
        );
        await this.stopTabAudioRecording();

        const msg = error instanceof Error ? error.message : String(error);
        const retryable = /still closing|wait a moment|stream expired|invalid|ended/i.test(msg);
        if (!retryable || attempt >= maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? 'Failed to start tab audio recording'));
  }

  /**
   * Stop recording from tab audio
   * Called when session ends
   */
  public async stopTabAudioRecording(): Promise<void> {
    console.info('[Sokuji] [ModernBrowserAudio] Stopping tab audio recording');

    if (this.tabAudioRecorder) {
      try {
        await this.tabAudioRecorder.end();
      } catch (error) {
        console.warn('[Sokuji] [ModernBrowserAudio] Error ending tab audio recorder:', error);
      }
      this.tabAudioRecorder = null;
    }

    this.tabAudioCallback = null;
    this.tabAudioRecordingActive = false;
    console.info('[Sokuji] [ModernBrowserAudio] Tab audio recording stopped');
  }

  /**
   * Check if tab audio recording is currently active
   */
  public isTabAudioRecordingActive(): boolean {
    return this.tabAudioRecordingActive;
  }

  // ============================================
  // Unified Participant Audio Methods
  // ============================================

  /**
   * Check if participant audio capture is available
   * Returns true if either system audio (Electron) or tab audio (Extension) is available
   */
  public supportsParticipantAudioCapture(): boolean {
    return this.supportsSystemAudioCapture() || this.supportsTabAudioCapture();
  }

  /**
   * Start recording participant audio (auto-detects environment)
   * - Extension: uses tab audio capture via Chrome tabCapture API
   * - Electron: uses system audio capture via PipeWire/PulseAudio loopback
   * @param callback Function to receive audio data chunks
   * @param options Optional configuration (outputDeviceId for passthrough)
   */
  public async startParticipantAudioRecording(
    callback: AudioRecordingCallback,
    options?: { outputDeviceId?: string }
  ): Promise<void> {
    // Extension environment: use tab audio capture
    if (isExtension()) {
      console.info('[Sokuji] [ModernBrowserAudio] Starting participant audio via tab capture');
      return this.startTabAudioRecording(callback, options?.outputDeviceId);
    }

    // Electron environment: use system audio capture
    if (this.systemAudioSourceConnected) {
      console.info('[Sokuji] [ModernBrowserAudio] Starting participant audio via system audio');
      return this.startSystemAudioRecording(callback);
    }

    throw new Error('No participant audio source available. Connect a system audio source or use in browser extension.');
  }

  /**
   * Stop participant audio recording
   */
  public async stopParticipantAudioRecording(): Promise<void> {
    // Stop whichever recording is active
    if (this.tabAudioRecordingActive) {
      console.info('[Sokuji] [ModernBrowserAudio] Stopping participant audio (tab capture)');
      return this.stopTabAudioRecording();
    }

    if (this.systemAudioRecordingActive) {
      console.info('[Sokuji] [ModernBrowserAudio] Stopping participant audio (system audio)');
      return this.stopSystemAudioRecording();
    }

    console.info('[Sokuji] [ModernBrowserAudio] No participant audio recording to stop');
  }

  /**
   * Check if participant audio recording is currently active
   */
  public isParticipantAudioRecordingActive(): boolean {
    return this.tabAudioRecordingActive || this.systemAudioRecordingActive;
  }

  /**
   * AnalyserNode for the participant audio capture stream. Returns null
   * when participant capture is not active. Used by MainPanel to drive
   * the participant waveform visualization.
   */
  public getParticipantAnalyser(): AnalyserNode | null {
    if (this.tabAudioRecordingActive) {
      return this.tabAudioRecorder?.getAnalyser() ?? null;
    }
    if (this.systemAudioRecordingActive) {
      return this.systemAudioRecorder?.getAnalyser() ?? null;
    }
    return null;
  }
}
