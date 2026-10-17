import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseAudioRecorder } from './BaseAudioRecorder';

class TestTabRecorder extends BaseAudioRecorder {
  protected getLogPrefix(): string {
    return '[TestTabRecorder]';
  }

  protected shouldConnectToDestination(): boolean {
    return true;
  }

  async setup(stream: MediaStream, context: AudioContext): Promise<void> {
    this.stream = stream;
    this.audioContext = context;
    await this.setupRealtimeAudioProcessing();
  }
}

describe('BaseAudioRecorder tab capture graph', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the AudioWorklet processing branch connected while routing tab audio to speakers', async () => {
    const destination = {};
    const source = { connect: vi.fn() };
    const analyser = { fftSize: 0, disconnect: vi.fn() };
    const silentSink = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const worklet = {
      port: { onmessage: null, postMessage: vi.fn(), close: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    const AudioWorkletNodeMock = vi.fn(function AudioWorkletNodeMock() {
      return worklet;
    });
    vi.stubGlobal('AudioWorkletNode', AudioWorkletNodeMock);

    const context = {
      destination,
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      createGain: vi.fn(() => silentSink),
    } as unknown as AudioContext;

    const recorder = new TestTabRecorder(24000);
    await recorder.setup({} as MediaStream, context);

    expect(source.connect).toHaveBeenCalledWith(worklet);
    expect(worklet.connect).toHaveBeenCalledWith(silentSink);
    expect(silentSink.gain.value).toBe(0);
    expect(silentSink.connect).toHaveBeenCalledWith(destination);
    expect(source.connect).toHaveBeenCalledWith(destination);
  });
});
