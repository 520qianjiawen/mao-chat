import { beforeEach, describe, expect, it, vi } from 'vitest';
import useSessionStore from '../../stores/sessionStore';
import {
  SIDE_PANEL_CLOSE_UNSUPPORTED,
  startExtensionSubtitleTakeover,
} from './extensionSidePanelTakeover';

declare const globalThis: any;

describe('startExtensionSubtitleTakeover', () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useSessionStore.setState({
      isSessionActive: false,
      stopSessionVersion: 0,
      sessionStopCompletedVersion: 0,
    });
    sendMessage = vi.fn((message: { type: string }, callback: Function) => {
      callback({ success: true, type: message.type });
    });
    globalThis.chrome = {
      sidePanel: { close: vi.fn() },
      runtime: {
        sendMessage,
        lastError: undefined,
      },
    };
  });

  it('prepares the hidden host before asking it to start', async () => {
    await startExtensionSubtitleTakeover();
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'PREPARE_SUBTITLE_TAKEOVER',
      'START_SUBTITLE_TAKEOVER',
    ]);
  });

  it('waits for audio teardown completion before starting the hidden host', async () => {
    useSessionStore.setState({ isSessionActive: true });
    const takeover = startExtensionSubtitleTakeover();

    await vi.waitFor(() => {
      expect(useSessionStore.getState().stopSessionVersion).toBe(1);
    });
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'PREPARE_SUBTITLE_TAKEOVER',
    ]);

    useSessionStore.getState().markSessionStopCompleted();
    await takeover;
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'PREPARE_SUBTITLE_TAKEOVER',
      'START_SUBTITLE_TAKEOVER',
    ]);
  });

  it('classifies browsers that cannot close a side panel', async () => {
    globalThis.chrome.sidePanel.close = undefined;
    await expect(startExtensionSubtitleTakeover()).rejects.toMatchObject({
      code: SIDE_PANEL_CLOSE_UNSUPPORTED,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('preserves a classified background preparation failure', async () => {
    sendMessage.mockImplementationOnce((_message: unknown, callback: Function) => {
      callback({
        success: false,
        code: 'CONTENT_SCRIPT_UNAVAILABLE',
        error: 'Refresh the video tab',
      });
    });
    await expect(startExtensionSubtitleTakeover()).rejects.toMatchObject({
      code: 'CONTENT_SCRIPT_UNAVAILABLE',
    });
  });
});
