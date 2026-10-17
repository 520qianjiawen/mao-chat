export interface KokoroSpeechSegment {
  text: string;
  pauseMs: number;
  explicitPause?: boolean;
}

const PAUSE_TAG = /\[pause:(\d+(?:\.\d+)?)s\]/giu;

/**
 * Match the official hexgrad/Kokoro-TTS pipeline: ordinary text, punctuation and
 * line breaks are passed to KPipeline in one piece so Misaki can produce the
 * model's native rhythm. Only our explicit [pause:1.5s] extension creates a
 * separate segment and inserts silence.
 */
export function splitKokoroText(text: string): KokoroSpeechSegment[] {
  const segments: KokoroSpeechSegment[] = [];
  let cursor = 0;

  const appendText = (value: string) => {
    const normalized = value.trim();
    if (normalized) segments.push({ text: normalized, pauseMs: 0 });
  };

  for (const match of text.matchAll(PAUSE_TAG)) {
    const index = match.index ?? cursor;
    appendText(text.slice(cursor, index));
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      segments.push({ text: '', pauseMs: Math.min(seconds, 30) * 1_000, explicitPause: true });
    }
    cursor = index + match[0].length;
  }
  appendText(text.slice(cursor));

  return segments.filter((segment) => segment.text || segment.pauseMs > 0);
}

export function silenceForKokoroSegment(
  segment: Pick<KokoroSpeechSegment, 'pauseMs' | 'explicitPause'>,
  sampleRate: number,
  speed = 1,
): Float32Array {
  const scaledPauseMs = segment.explicitPause
    ? segment.pauseMs
    : segment.pauseMs / Math.max(0.1, speed);
  return new Float32Array(Math.max(0, Math.round(sampleRate * scaledPauseMs / 1_000)));
}
