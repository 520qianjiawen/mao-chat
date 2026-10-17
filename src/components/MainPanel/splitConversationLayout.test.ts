import { describe, expect, it } from 'vitest';
import {
  MIN_SPLIT_PANEL_WIDTH,
  SPLIT_SCREEN_WIDTH_RATIO,
  shouldUseSplitConversationView,
} from './splitConversationLayout';

describe('shouldUseSplitConversationView', () => {
  it('keeps one column when the current conversation is not split-eligible', () => {
    expect(shouldUseSplitConversationView(1400, 1920, false)).toBe(false);
  });

  it('splits when the panel reaches 45% of the available screen', () => {
    const threshold = 1920 * SPLIT_SCREEN_WIDTH_RATIO;
    expect(shouldUseSplitConversationView(threshold, 1920, true)).toBe(true);
    expect(shouldUseSplitConversationView(threshold - 1, 1920, true)).toBe(false);
  });

  it('preserves a minimum useful width on small screens', () => {
    expect(shouldUseSplitConversationView(MIN_SPLIT_PANEL_WIDTH - 1, 1366, true)).toBe(false);
    expect(shouldUseSplitConversationView(MIN_SPLIT_PANEL_WIDTH, 1366, true)).toBe(true);
  });

  it('keeps the 45% ratio on ultrawide displays', () => {
    const threshold = 3440 * SPLIT_SCREEN_WIDTH_RATIO;
    expect(shouldUseSplitConversationView(threshold - 1, 3440, true)).toBe(false);
    expect(shouldUseSplitConversationView(threshold, 3440, true)).toBe(true);
  });
});
