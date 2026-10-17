import { describe, expect, it } from 'vitest';
import { encodeMonoFloat32Wav, encodeMonoPcm16Wav, float32ToPcm16 } from './ttsAudioExport';

function ascii(view: DataView, offset: number, length: number): string {
  return Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('');
}

describe('encodeMonoPcm16Wav', () => {
  it('writes a mono PCM16 WAV header and joins streaming chunks', () => {
    const wav = encodeMonoPcm16Wav([
      new Int16Array([0, 1]),
      new Int16Array([-1, 32767, -32768]),
    ], 24_000);
    const view = new DataView(wav);

    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect(wav.byteLength).toBe(54);
    expect(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true)))
      .toEqual([0, 1, -1, 32767, -32768]);
  });

  it('rejects invalid sample rates', () => {
    expect(() => encodeMonoPcm16Wav([], 0)).toThrow('sampleRate');
  });

  it('converts Float32 samples to saturating PCM16', () => {
    expect(Array.from(float32ToPcm16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]))))
      .toEqual([-32768, -32768, -16384, 0, 16384, 32767, 32767]);
  });

  it('encodes native Float32 TTS output as WAV', () => {
    const wav = encodeMonoFloat32Wav(new Float32Array([-1, 0, 1]), 16_000);
    const view = new DataView(wav);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(6);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)])
      .toEqual([-32768, 0, 32767]);
  });
});
