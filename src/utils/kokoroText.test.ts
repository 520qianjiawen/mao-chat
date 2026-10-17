import { describe, expect, it } from 'vitest';
import { silenceForKokoroSegment, splitKokoroText } from './kokoroText';

describe('splitKokoroText', () => {
  it('passes punctuation to Kokoro as one utterance like the official pipeline', () => {
    expect(splitKokoroText('Hello, world! How are you?')).toEqual([
      { text: 'Hello, world! How are you?', pauseMs: 0 },
    ]);
  });

  it('preserves CJK punctuation and paragraphs for native model prosody', () => {
    expect(splitKokoroText('你好，世界。\n\n下一段')).toEqual([
      { text: '你好，世界。\n\n下一段', pauseMs: 0 },
    ]);
  });

  it('supports Kokoro-FastAPI pause tags without speaking the tag', () => {
    expect(splitKokoroText('Hello [pause:2.5s] world.')).toEqual([
      { text: 'Hello', pauseMs: 0 },
      { text: '', pauseMs: 2_500, explicitPause: true },
      { text: 'world.', pauseMs: 0 },
    ]);
  });

  it('does not split abbreviations or decimal numbers', () => {
    expect(splitKokoroText('Dr. Smith paid 2.5 dollars.')).toEqual([
      { text: 'Dr. Smith paid 2.5 dollars.', pauseMs: 0 },
    ]);
  });

  it('scales automatic gaps with speed but preserves explicit pause duration', () => {
    expect(silenceForKokoroSegment({ pauseMs: 410 }, 1_000, 2)).toHaveLength(205);
    expect(silenceForKokoroSegment({ pauseMs: 410, explicitPause: true }, 1_000, 2)).toHaveLength(410);
  });
});
