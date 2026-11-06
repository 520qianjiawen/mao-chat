// src/stores/meetingStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useMeetingStore } from './meetingStore';
import type { ConversationItem } from '../services/interfaces/IClient';

describe('meetingStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useMeetingStore.setState({
      sessions: [],
      activeSessionId: null,
      selectedSessionId: null,
      currentTab: 'notes',
      transcriptViewMode: 'both',
      showQuotesSideBySide: false,
      searchQuery: '',
      isUpdatingNotes: false,
      freshPoints: new Set(),
      jumpToTimestamp: null,
    });
  });

  it('syncLiveSession creates session and translates conversation items to transcript lines', () => {
    const items: ConversationItem[] = [
      {
        id: 'c1',
        role: 'assistant',
        status: 'completed',
        createdAt: 1000,
        formatted: { transcript: 'Good morning.', text: '早上好。' },
      },
      {
        id: 'c2',
        role: 'user',
        status: 'completed',
        createdAt: 3000,
        formatted: { transcript: 'How are you?', text: '你好吗？' },
      },
    ];

    useMeetingStore.getState().syncLiveSession({
      sessionId: 'test-session-123',
      sessionStartTime: 0,
      combinedItems: items,
      isLive: true,
    });

    const state = useMeetingStore.getState();
    expect(state.sessions.length).toBe(1);
    expect(state.activeSessionId).toBe('test-session-123');

    const session = state.sessions[0];
    expect(session.id).toBe('test-session-123');
    expect(session.lines.length).toBe(2);
    expect(session.lines[0].src).toBe('Good morning.');
    expect(session.lines[0].dst).toBe('早上好。');
    expect(session.lines[0].speaker).toBe('other');
    expect(session.lines[1].speaker).toBe('me');
  });

  it('correctly pairs user input item with assistant translation item in video / system audio mode', () => {
    // In video watching (participant mode), user speech item is the English audio,
    // and assistant item is the Chinese translation. Both have source: 'participant'.
    const videoItems = [
      {
        id: 'user-speech-1',
        role: 'user',
        status: 'completed',
        createdAt: 1000,
        source: 'participant',
        formatted: { transcript: 'Congratulations to the Democrats. They did a good job.' },
      },
      {
        id: 'asst-trans-1',
        role: 'assistant',
        status: 'completed',
        createdAt: 1200,
        source: 'participant',
        formatted: { text: '祝贺民主党人。他们做得很好。' },
      },
    ] as any[];

    useMeetingStore.getState().syncLiveSession({
      sessionId: 'video-session-1',
      sessionStartTime: 0,
      combinedItems: videoItems,
      isLive: true,
    });

    const session = useMeetingStore.getState().sessions[0];
    // Must be paired into ONE single line, labeled "other" (对方/视频), not two alternating "你" and "对方" lines!
    expect(session.lines.length).toBe(1);
    expect(session.lines[0].speaker).toBe('other');
    expect(session.lines[0].speakerName).toBe('对方');
    expect(session.lines[0].src).toBe('Congratulations to the Democrats. They did a good job.');
    expect(session.lines[0].dst).toBe('祝贺民主党人。他们做得很好。');
  });

  it('renameSession and deleteSession work correctly', () => {
    useMeetingStore.getState().syncLiveSession({
      sessionId: 'sess-1',
      sessionStartTime: 0,
      combinedItems: [],
      isLive: true,
    });

    useMeetingStore.getState().renameSession('sess-1', '每周例会');
    expect(useMeetingStore.getState().sessions[0].title).toBe('每周例会');
    expect(useMeetingStore.getState().sessions[0].renamed).toBe(true);

    useMeetingStore.getState().deleteSession('sess-1');
    expect(useMeetingStore.getState().sessions.length).toBe(0);
  });

  it('starts clean without injecting sample sessions', () => {
    useMeetingStore.getState().createSampleSessionIfEmpty();
    const sessions = useMeetingStore.getState().sessions;
    expect(sessions.length).toBe(0);
  });
});
