import { describe, expect, it } from 'vitest';
import {
  audioSpanFullyCommitted,
  leadingTokenOverlap,
  spanEndSample,
  stripOverlappingPrefix,
  tokensShareStem,
} from './overlapDedup';

describe('stripOverlappingPrefix', () => {
  it('returns incoming unchanged when there is no published text', () => {
    expect(stripOverlappingPrefix('', 'hello world')).toBe('hello world');
  });

  it('drops an exact re-emit of committed text', () => {
    expect(stripOverlappingPrefix('hello world', 'hello world')).toBe('');
    expect(stripOverlappingPrefix('旅行を連れて。', '旅行を連れて。')).toBe('');
  });

  it('keeps only the new tail of a rolling English window', () => {
    expect(stripOverlappingPrefix('hello world', 'hello world today')).toBe('today');
    expect(stripOverlappingPrefix('there is something', 'there is something we need')).toBe('we need');
  });

  it('strips a CJK rolling window even when the first cut had a period', () => {
    expect(stripOverlappingPrefix('旅行を連れて。', '旅行を連れてきてもらって文句ばっかり')).toBe(
      'きてもらって文句ばっかり',
    );
  });

  it('dedupes a mid-window overlap that is not an exact prefix', () => {
    expect(stripOverlappingPrefix(
      '旅行を連れてきてもらって',
      '連れてきてもらって文句ばっかり',
    )).toBe('文句ばっかり');
    expect(stripOverlappingPrefix('consider this option', 'this option next')).toBe('next');
  });

  it('does not drop a later clause just because it appeared earlier as a substring', () => {
    expect(stripOverlappingPrefix('hello world today everyone', 'today we continue')).toBe(
      'today we continue',
    );
  });

  it('matches English rolling windows case-insensitively and ignores cut punctuation', () => {
    expect(stripOverlappingPrefix(
      'Regional officials say For now, the Navy.',
      'Regional officials say for now the naval blockade and economic pressure will continue.',
    )).toMatch(/naval blockade/i);
    expect(leadingTokenOverlap(
      'Regional officials say For now, the Navy.',
      'Regional officials say for now the naval blockade and economic pressure will continue.',
    )).toBeGreaterThanOrEqual(4);
  });

  it('revises Navy/naval at a streaming-tail boundary', () => {
    expect(stripOverlappingPrefix(
      'Regional officials say For now, the Navy.',
      'the naval blockade and economic pressure will continue.',
    )).toMatch(/^naval blockade/i);
    expect(tokensShareStem('navy', 'naval')).toBe(true);
  });
});

describe('audio span lock', () => {
  it('treats a 16 kHz span as fully committed when it ends at or before the cursor', () => {
    expect(spanEndSample({ startSample: 0, durationMs: 1000 })).toBe(16000);
    expect(audioSpanFullyCommitted({ startSample: 4000, durationMs: 200 }, 8000)).toBe(true);
    expect(audioSpanFullyCommitted({ startSample: 8000, durationMs: 500 }, 8000)).toBe(false);
    expect(audioSpanFullyCommitted({ startSample: 0, durationMs: 500 }, 0)).toBe(false);
  });

  it('does not lock later chunks that still report startSample 0', () => {
    expect(audioSpanFullyCommitted({ startSample: 0, durationMs: 500 }, 8000)).toBe(false);
  });
});
