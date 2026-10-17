import { describe, expect, it } from 'vitest';
import type { ConversationItem } from '../../services/interfaces/IClient';
import { orderConversationItems } from './conversationOrdering';

function item(
  id: string,
  role: ConversationItem['role'],
  createdAt: number,
  segmentId?: number,
  source: ConversationItem['source'] = 'speaker',
): ConversationItem {
  return {
    id,
    role,
    source,
    segmentId,
    createdAt,
    type: 'message',
    status: 'completed',
    formatted: { transcript: id },
  };
}

describe('orderConversationItems', () => {
  it.each([
    'ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko',
    'nl', 'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh',
  ])('keeps %s source and translation paired', (language) => {
    const source = {
      ...item(`${language}-source`, 'user', 100, 1),
      detectedLanguage: language,
    };
    const laterSource = {
      ...item(`${language}-source-2`, 'user', 200, 2),
      detectedLanguage: language,
    };
    const translation = {
      ...item(`${language}-translation`, 'assistant', 800, 1),
      detectedLanguage: 'zh',
    };

    expect(orderConversationItems([source, laterSource, translation]).map(({ id }) => id)).toEqual([
      `${language}-source`,
      `${language}-translation`,
      `${language}-source-2`,
    ]);
  });

  it('places delayed translations directly after their matching transcripts', () => {
    const input = [
      item('source-1', 'user', 100, 1),
      item('source-2', 'user', 200, 2),
      item('source-3', 'user', 300, 3),
      item('translation-1', 'assistant', 1000, 1),
      item('translation-2', 'assistant', 1100, 2),
      item('translation-3', 'assistant', 1200, 3),
    ];

    expect(orderConversationItems(input).map(({ id }) => id)).toEqual([
      'source-1',
      'translation-1',
      'source-2',
      'translation-2',
      'source-3',
      'translation-3',
    ]);
  });

  it('keeps different audio channels separate when segment ids overlap', () => {
    const input = [
      item('speaker-source', 'user', 100, 1, 'speaker'),
      item('participant-source', 'user', 150, 1, 'participant'),
      item('participant-translation', 'assistant', 250, 1, 'participant'),
      item('speaker-translation', 'assistant', 300, 1, 'speaker'),
    ];

    expect(orderConversationItems(input).map(({ id }) => id)).toEqual([
      'speaker-source',
      'speaker-translation',
      'participant-source',
      'participant-translation',
    ]);
  });

  it('renders source before translation even if a partial translation arrived first', () => {
    const input = [
      item('translation', 'assistant', 100, 8),
      item('source', 'user', 110, 8),
    ];

    expect(orderConversationItems(input).map(({ id }) => id)).toEqual([
      'source',
      'translation',
    ]);
  });

  it('preserves chronological ordering for providers without segment ids', () => {
    const input = [
      item('late', 'assistant', 300),
      item('early', 'user', 100),
      item('middle', 'assistant', 200),
    ];

    expect(orderConversationItems(input).map(({ id }) => id)).toEqual([
      'early',
      'middle',
      'late',
    ]);
    expect(input.map(({ id }) => id)).toEqual(['late', 'early', 'middle']);
  });
});
