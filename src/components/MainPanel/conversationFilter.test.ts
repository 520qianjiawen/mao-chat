import { describe, it, expect } from 'vitest';
import type { ConversationItem } from '../../services/interfaces/IClient';
import {
  hideSupersededRaw,
  rawFirstPassItems,
  refinedPassItems,
  shouldShowItem,
  supersededRawItems,
} from './conversationFilter';

const baseItem = (over: Partial<ConversationItem>): ConversationItem => ({
  id: 'i',
  role: 'user',
  type: 'message',
  status: 'completed',
  formatted: { text: 't' },
  ...over,
});

describe('shouldShowItem', () => {
  it('keeps speaker source when speakerMode=source', () => {
    const item = baseItem({ source: 'speaker', role: 'user' });
    expect(shouldShowItem(item, 'source', 'both')).toBe(true);
  });

  it('hides speaker translation when speakerMode=source', () => {
    const item = baseItem({ source: 'speaker', role: 'assistant' });
    expect(shouldShowItem(item, 'source', 'both')).toBe(false);
  });

  it('hides speaker source when speakerMode=translation', () => {
    const item = baseItem({ source: 'speaker', role: 'user' });
    expect(shouldShowItem(item, 'translation', 'both')).toBe(false);
  });

  it('keeps speaker translation when speakerMode=translation', () => {
    const item = baseItem({ source: 'speaker', role: 'assistant' });
    expect(shouldShowItem(item, 'translation', 'both')).toBe(true);
  });

  it('keeps both speaker roles when speakerMode=both', () => {
    expect(shouldShowItem(baseItem({ source: 'speaker', role: 'user' }), 'both', 'both')).toBe(true);
    expect(shouldShowItem(baseItem({ source: 'speaker', role: 'assistant' }), 'both', 'both')).toBe(true);
  });

  it('keeps participant source when participantMode=source', () => {
    const item = baseItem({ source: 'participant', role: 'user' });
    expect(shouldShowItem(item, 'both', 'source')).toBe(true);
  });

  it('hides participant translation when participantMode=source', () => {
    const item = baseItem({ source: 'participant', role: 'assistant' });
    expect(shouldShowItem(item, 'both', 'source')).toBe(false);
  });

  it('hides participant source when participantMode=translation', () => {
    const item = baseItem({ source: 'participant', role: 'user' });
    expect(shouldShowItem(item, 'both', 'translation')).toBe(false);
  });

  it('keeps participant translation when participantMode=translation', () => {
    const item = baseItem({ source: 'participant', role: 'assistant' });
    expect(shouldShowItem(item, 'both', 'translation')).toBe(true);
  });

  it('applies speaker mode to items without a source field (default speaker)', () => {
    const item = baseItem({ source: undefined, role: 'assistant' });
    expect(shouldShowItem(item, 'source', 'both')).toBe(false);
    expect(shouldShowItem(item, 'translation', 'both')).toBe(true);
  });

  it('always shows error items regardless of filter', () => {
    const item = baseItem({ type: 'error', role: 'assistant', source: 'speaker' });
    expect(shouldShowItem(item, 'source', 'source')).toBe(true);
  });

  it('always shows system-role items regardless of filter', () => {
    const item = baseItem({ role: 'system', source: 'speaker' });
    expect(shouldShowItem(item, 'source', 'source')).toBe(true);
  });

  it('always shows function_call items regardless of filter', () => {
    // Tool calls arrive with role='assistant' but type='function_call'; they
    // must NOT be filtered out when the user picks source-only or translation-only.
    const item = baseItem({ type: 'function_call', role: 'assistant', source: 'speaker' });
    expect(shouldShowItem(item, 'source', 'source')).toBe(true);
    expect(shouldShowItem(item, 'translation', 'translation')).toBe(true);
  });

  it('always shows function_call_output items regardless of filter', () => {
    const item = baseItem({ type: 'function_call_output', role: 'assistant', source: 'speaker' });
    expect(shouldShowItem(item, 'source', 'source')).toBe(true);
    expect(shouldShowItem(item, 'translation', 'translation')).toBe(true);
  });
});

describe('hideSupersededRaw / supersededRawItems (hayamimi split view)', () => {
  const base = (over: Partial<ConversationItem>): ConversationItem => ({
    id: 'x', role: 'user', type: 'message', status: 'completed',
    formatted: { transcript: 't' },
    ...over,
  });
  const raw1 = base({ id: 'u1', segmentId: 1, formatted: { transcript: 'raw one' } });
  const raw1T = base({ id: 'a1', role: 'assistant', segmentId: 1, formatted: { transcript: 'raw one T' } });
  const refined1 = base({
    id: 'ru1', segmentId: 100001, refined: true, refinedFor: [1],
    formatted: { transcript: 'polished one' },
  });
  const refined1T = base({
    id: 'ra1', role: 'assistant', segmentId: 100001, refined: true, refinedFor: [1],
    formatted: { transcript: 'polished one T' },
  });
  const untouched = base({ id: 'u2', segmentId: 2, formatted: { transcript: 'not yet refined' } });

  it('hides raw items a refined rewrite supersedes and keeps the rewrite', () => {
    const final = hideSupersededRaw([raw1, raw1T, refined1, refined1T, untouched]);
    expect(final.map((i) => i.id)).toEqual(['ru1', 'ra1', 'u2']);
  });

  it('keeps everything when no refined items exist', () => {
    expect(hideSupersededRaw([raw1, raw1T, untouched])).toHaveLength(3);
  });

  it('returns exactly the hidden raw items for the split column', () => {
    const rawCol = supersededRawItems([raw1, raw1T, refined1, refined1T, untouched]);
    expect(rawCol.map((i) => i.id)).toEqual(['u1', 'a1']);
  });

  it('matches refinedFor across multiple superseded segments', () => {
    const merged = base({
      id: 'rm', segmentId: 100002, refined: true, refinedFor: [1, 2],
      formatted: { transcript: 'merged' },
    });
    expect(hideSupersededRaw([raw1, untouched, merged]).map((i) => i.id)).toEqual(['rm']);
    expect(supersededRawItems([raw1, untouched, merged]).map((i) => i.id)).toEqual(['u1', 'u2']);
  });

  it('separates the complete raw stream from polished source and translation rows', () => {
    const all = [raw1, raw1T, refined1, refined1T, untouched];
    expect(rawFirstPassItems(all).map((i) => i.id)).toEqual(['u1', 'a1', 'u2']);
    expect(refinedPassItems(all).map((i) => i.id)).toEqual(['ru1', 'ra1']);
  });
});
