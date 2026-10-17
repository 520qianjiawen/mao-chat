import { describe, expect, it } from 'vitest';
import { BothModeEchoGate, pcmMeanAbs } from './bothModeEchoGate';

function tone(n: number, amp: number): Int16Array {
  const out = new Int16Array(n);
  const peak = Math.round(amp * 32767);
  for (let i = 0; i < n; i++) out[i] = peak;
  return out;
}

describe('BothModeEchoGate', () => {
  it('computes mean-abs in 0..1', () => {
    expect(pcmMeanAbs(tone(100, 0))).toBe(0);
    expect(pcmMeanAbs(tone(100, 1))).toBeCloseTo(1, 2);
  });

  it('drops the mic when computer audio is as loud as the mic', () => {
    const gate = new BothModeEchoGate();
    const now = 1_000_000;
    gate.noteSystemAudio(tone(480, 0.1), now);
    expect(gate.shouldDropMic(tone(480, 0.1), false, now + 10)).toBe(true);
    expect(gate.shouldDropMic(tone(480, 0.2), false, now + 10_000)).toBe(false);
  });

  it('keeps a louder near-field mic even if computer audio just played', () => {
    const gate = new BothModeEchoGate();
    const now = 1_000_000;
    gate.noteSystemAudio(tone(480, 0.04), now);
    expect(gate.shouldDropMic(tone(480, 0.2), false, now + 10)).toBe(false);
  });

  it('drops computer audio while our TTS is playing', () => {
    const gate = new BothModeEchoGate();
    expect(gate.shouldDropSystemAudio(true)).toBe(true);
    // A fresh gate with no recent TTS lets computer audio through.
    expect(new BothModeEchoGate().shouldDropSystemAudio(false)).toBe(false);
  });

  it('keeps dropping system audio for the echo-hold window after TTS stops', () => {
    const gate = new BothModeEchoGate();
    const now = 1_000_000;
    expect(gate.shouldDropSystemAudio(true, now)).toBe(true);
    // Just inside the hold: the loopback is still emitting the TTS tail.
    expect(gate.shouldDropSystemAudio(false, now + gate.ttsEchoHoldMs - 1)).toBe(true);
    // After the hold expires, real computer audio may pass again.
    expect(gate.shouldDropSystemAudio(false, now + gate.ttsEchoHoldMs)).toBe(false);
  });

  it('extends the hold while assistant audio keeps being enqueued', () => {
    const gate = new BothModeEchoGate();
    const now = 1_000_000;
    gate.noteTtsPlayback(now);
    // A streaming gap arrives mid-utterance; enqueueing extends the window.
    gate.noteTtsPlayback(now + gate.ttsEchoHoldMs - 200);
    // Inside the extended window (the second enqueue adds its own full hold).
    expect(gate.shouldDropSystemAudio(false, now + gate.ttsEchoHoldMs + 500)).toBe(true);
    // After the extended window fully expires.
    expect(gate.shouldDropSystemAudio(false, now + gate.ttsEchoHoldMs * 2)).toBe(false);
  });

  it('does not let our own TTS tail suppress the microphone', () => {
    const gate = new BothModeEchoGate();
    const now = 1_000_000;
    gate.noteTtsPlayback(now);                        // assistant just finished
    gate.noteSystemAudio(tone(480, 0.15), now);       // tail is loud in loopback
    // User starts speaking right after; the tail must not drop their mic.
    expect(gate.shouldDropMic(tone(480, 0.05), false, now + 10)).toBe(false);
    // After the hold expires, loud computer audio may suppress the mic again.
    expect(gate.shouldDropMic(tone(480, 0.05), false, now + gate.ttsEchoHoldMs)).toBe(false);
  });
});
