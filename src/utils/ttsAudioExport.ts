/**
 * Encode one or more mono PCM16 chunks as a standard little-endian WAV file.
 *
 * Local TTS audio is normalized to 24 kHz PCM16 before it reaches MainPanel,
 * so exporting the exact playback chunks avoids synthesizing the same text a
 * second time and also works for streaming voices.
 */
export function encodeMonoPcm16Wav(
  chunks: readonly Int16Array[],
  sampleRate = 24_000,
): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate must be a positive number');
  }

  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      view.setInt16(offset, chunk[i], true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}

/** Convert the renderer/native TTS Float32 output into saturating PCM16. */
export function float32ToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = sample < 0
      ? Math.round(sample * 32_768)
      : Math.round(sample * 32_767);
  }
  return pcm;
}

/** Encode the Float32 samples returned by NativeTtsClient as a WAV download. */
export function encodeMonoFloat32Wav(
  samples: Float32Array,
  sampleRate = 24_000,
): ArrayBuffer {
  return encodeMonoPcm16Wav([float32ToPcm16(samples)], sampleRate);
}
