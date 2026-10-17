import useSessionStore from '../../stores/sessionStore';

declare const chrome: any;

export const SIDE_PANEL_CLOSE_UNSUPPORTED = 'SIDE_PANEL_CLOSE_UNSUPPORTED';
export const SESSION_HOST_UNAVAILABLE = 'SESSION_HOST_UNAVAILABLE';
export const SESSION_STOP_TIMEOUT = 'SESSION_STOP_TIMEOUT';

type ClassifiedError = Error & { code: string };

function errorWithCode(code: string, message: string): ClassifiedError {
  const error = new Error(message) as ClassifiedError;
  error.code = code;
  return error;
}

function runtimeMessage<T = any>(message: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: T) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'Extension background is unavailable'));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function waitForSessionCleanup(
  previousCompletedVersion: number,
  timeoutMs = 12_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(errorWithCode(
        SESSION_STOP_TIMEOUT,
        'Timed out while releasing the previous tab-audio stream',
      ));
    }, timeoutMs);

    const unsubscribe = useSessionStore.subscribe(
      (state) => state.sessionStopCompletedVersion,
      (completedVersion) => {
        if (completedVersion <= previousCompletedVersion) return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      },
    );
  });
}

/**
 * Move the live caption session out of the extension side panel, then ask the
 * background worker to close the browser panel. The hidden session host starts
 * only after MainPanel has released tabCapture, so Chrome never has two
 * consumers fighting over the same tab-audio stream.
 */
export async function startExtensionSubtitleTakeover(): Promise<void> {
  if (typeof chrome?.sidePanel?.close !== 'function') {
    throw errorWithCode(
      SIDE_PANEL_CLOSE_UNSUPPORTED,
      'Closing the side panel requires Chrome 141 or newer',
    );
  }

  const prepared = await runtimeMessage<{ success?: boolean; error?: string; code?: string }>({
    type: 'PREPARE_SUBTITLE_TAKEOVER',
  });
  if (!prepared?.success) {
    throw errorWithCode(
      prepared?.code || SESSION_HOST_UNAVAILABLE,
      prepared?.error || 'Could not prepare the hidden subtitle session',
    );
  }

  const session = useSessionStore.getState();
  if (session.isSessionActive) {
    const previousCompletedVersion = session.sessionStopCompletedVersion;
    session.requestSessionStop();
    await waitForSessionCleanup(previousCompletedVersion);
  }

  const started = await runtimeMessage<{ success?: boolean; error?: string; code?: string }>({
    type: 'START_SUBTITLE_TAKEOVER',
  });
  if (!started?.success) {
    throw errorWithCode(
      started?.code || SESSION_HOST_UNAVAILABLE,
      started?.error || 'Could not start the hidden subtitle session',
    );
  }
}
