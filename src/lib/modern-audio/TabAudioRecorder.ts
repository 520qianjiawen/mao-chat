import { ParticipantRecorder } from './ParticipantRecorder';
import { ParticipantAudioOptions } from './IParticipantAudioRecorder';

/* global chrome */

/**
 * Tab Audio Recorder for browser extension
 * Captures audio from the current tab using Chrome's tabCapture API
 * Used for translating other meeting participants' voices in video conferencing
 */
export class TabAudioRecorder extends ParticipantRecorder {
  private tabId: number | null = null;
  private streamId: string | null = null;
  private outputDeviceId: string | null = null;

  protected getLogPrefix(): string {
    return '[TabAudioRecorder]';
  }

  protected shouldConnectToDestination(): boolean {
    return true; // Tab audio needs passthrough (play back to user)
  }

  /**
   * Configure AudioContext output device for tab audio passthrough.
   * Chrome tabCapture stops original tab audio, so we must manually route it to the output device.
   */
  protected async onAudioContextCreated(options?: ParticipantAudioOptions): Promise<void> {
    this.outputDeviceId = options?.outputDeviceId || null;

    // Set output device if specified (Chrome 110+ supports setSinkId)
    // Required for tab capture: Chrome stops original audio when tab is captured
    if (this.outputDeviceId && this.audioContext && 'setSinkId' in this.audioContext) {
      try {
        // @ts-expect-error setSinkId is not in TypeScript types yet
        await this.audioContext.setSinkId(this.outputDeviceId);
        console.info(`${this.getLogPrefix()} Set audio output device:`, this.outputDeviceId);
      } catch (sinkError) {
        console.warn(`${this.getLogPrefix()} Failed to set output device, using default:`, sinkError);
      }
    }
  }

  protected async acquireStream(options?: ParticipantAudioOptions): Promise<MediaStream> {
    // Get tab ID
    this.tabId = options?.tabId ?? await this.getTabIdFromContext();
    if (!this.tabId) {
      // Last resort: ask the background to resolve the last-focused capturable tab
      // (side panel may open without ?tabId= when setOptions path is stale).
      const resolved = await this.sendMessageToBackground({ type: 'RESOLVE_CAPTURE_TAB' });
      if (resolved.success && resolved.tabId) {
        this.tabId = resolved.tabId;
      }
    }
    if (!this.tabId) {
      throw new Error(
        'Could not determine which tab to capture. Open the meeting/video tab, click the MAO Chat icon on that tab, then Start again.',
      );
    }

    console.info(`${this.getLogPrefix()} Starting capture for tab:`, this.tabId);

    // Request a FRESH stream ID from the background. Chrome stream IDs are
    // single-use and expire within seconds if unused — never reuse a cached one.
    const response = await this.sendMessageToBackground({
      type: 'START_TAB_CAPTURE',
      tabId: this.tabId,
    });

    if (!response.success || !response.streamId) {
      throw new Error(humanizeTabCaptureError(response.error));
    }

    this.streamId = response.streamId;
    console.info(`${this.getLogPrefix()} Received streamId:`, this.streamId);

    // getUserMedia with the Chrome tab-capture constraints. Prefer the classic
    // `mandatory` form (stable across Chromium versions); fall back to the
    // flat form used by some newer builds if the first shape is rejected.
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          // @ts-expect-error Chrome-specific constraints
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: this.streamId,
          },
        },
        video: false,
      });
    } catch (firstError) {
      console.warn(`${this.getLogPrefix()} mandatory constraints failed, retrying flat form:`, firstError);
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: {
            // @ts-expect-error Chrome-specific constraints
            chromeMediaSource: 'tab',
            chromeMediaSourceId: this.streamId,
          } as MediaTrackConstraints,
          video: false,
        });
      } catch (secondError) {
        // Stream ID is spent after either attempt — clear so a retry mints a new one.
        const spentId = this.streamId;
        this.streamId = null;
        if (this.tabId) {
          await this.sendMessageToBackground({
            type: 'STOP_TAB_CAPTURE',
            tabId: this.tabId,
            streamId: spentId ?? undefined,
          });
        }
        const detail = secondError instanceof Error ? secondError.message : String(secondError);
        throw new Error(humanizeTabCaptureError(detail));
      }
    }
  }

  protected async onCleanup(): Promise<void> {
    // Notify background script to stop capture
    if (this.tabId) {
      await this.sendMessageToBackground({
        type: 'STOP_TAB_CAPTURE',
        tabId: this.tabId,
        streamId: this.streamId ?? undefined,
      });
    }
    this.tabId = null;
    this.streamId = null;
  }

  private async getTabIdFromContext(): Promise<number | null> {
    const urlParams = new URLSearchParams(window.location.search);
    const tabIdParam = urlParams.get('tabId');
    if (tabIdParam) {
      const parsed = parseInt(tabIdParam, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tabs.length > 0 && tabs[0].id) return tabs[0].id;
      } catch (error) {
        console.error(`${this.getLogPrefix()} Error querying tabs:`, error);
      }
    }
    return null;
  }

  private sendMessageToBackground(message: object): Promise<{
    success: boolean;
    streamId?: string;
    tabId?: number;
    error?: string;
  }> {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { success: false, error: 'No response from background' });
          }
        });
      } else {
        resolve({ success: false, error: 'Chrome runtime not available' });
      }
    });
  }
}

/**
 * Map raw Chrome / getUserMedia errors to an actionable, user-facing string.
 * Keep the original detail in parentheses so logs still diagnose edge cases.
 */
export function humanizeTabCaptureError(raw: string | undefined): string {
  const msg = (raw || '').trim();
  const lower = msg.toLowerCase();

  if (!msg) {
    return 'Failed to capture tab audio. Click the MAO Chat icon on the video tab, then press Start.';
  }

  if (
    lower.includes('not been invoked')
    || lower.includes('active tab')
    || lower.includes('activetab')
    || lower.includes('extension has not been invoked')
  ) {
    return 'Tab audio needs a fresh click on the MAO Chat toolbar icon for this tab (Chrome activeTab). Click the icon on the video/meeting tab, then Start again.';
  }

  if (lower.includes('permission') || lower.includes('not allowed') || lower.includes('denied')) {
    return `Tab audio permission denied: ${msg}. Click the MAO Chat icon on the tab and allow capture, then Start again.`;
  }

  if (lower.includes('tab not found') || lower.includes('no tab')) {
    return 'The video tab was closed or could not be found. Open the video tab, click the MAO Chat icon on it, then Start.';
  }

  if (lower.includes('stream') && (lower.includes('invalid') || lower.includes('ended') || lower.includes('empty'))) {
    return 'Tab audio stream expired. Press Start again (stream IDs are single-use).';
  }

  if (lower.includes('still closing') || lower.includes('wait a moment')) {
    return 'Previous tab audio is still releasing. Wait a second and press Start again (or re-enter subtitles).';
  }

  // Preserve original Chrome wording for anything we don't classify.
  return `Failed to capture tab audio: ${msg}`;
}
