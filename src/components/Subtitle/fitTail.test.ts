import { describe, it, expect } from 'vitest';
import { fitTail, stringVisualLength } from './fitTail';

describe('fitTail utility', () => {
  it('returns short strings untouched', () => {
    expect(fitTail('Hello world', 50)).toBe('Hello world');
    expect(fitTail('你好世界', 20)).toBe('你好世界');
    expect(fitTail('', 20)).toBe('');
  });

  it('truncates leading text and retains the tail for long CJK strings', () => {
    const text = '这是第一句很长的话，这是第二句很长的话，这是最后刚说的重要内容';
    const result = fitTail(text, 26);
    expect(result.startsWith('…')).toBe(true);
    expect(result.endsWith('这是最后刚说的重要内容')).toBe(true);
    expect(stringVisualLength(result)).toBeLessThanOrEqual(28);
  });

  it('truncates leading text and snaps to word boundaries for Latin strings', () => {
    const text = 'We started this project six months ago and today we have reached our major milestone';
    const result = fitTail(text, 40);
    expect(result.startsWith('…')).toBe(true);
    expect(result.endsWith('reached our major milestone')).toBe(true);
  });
});
