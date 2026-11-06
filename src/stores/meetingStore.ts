// src/stores/meetingStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { MeetingSession, MeetingNotes, MeetingTranscriptLine } from '../types/meeting';
import { NotesEngine } from '../services/notes/NotesEngine';
import type { ConversationItem } from '../services/interfaces/IClient';
import useSettingsStore from './settingsStore';

function getTargetLanguageName(): string {
  try {
    const settings = useSettingsStore.getState();
    const current = settings.getCurrentProviderSettings?.();
    const target = current?.targetLanguage || 'zh';
    if (target === 'zh' || target === 'zh-CN' || target === 'zh_CN') {
      return 'Simplified Chinese (简体中文)';
    }
    if (target === 'en') return 'English';
    return target;
  } catch {
    return 'Simplified Chinese (简体中文)';
  }
}

const STORAGE_KEY = 'mao_chat_sessions_v1';

function loadPersistedSessions(): MeetingSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter out legacy sample sessions if any
    const realSessions = parsed.filter((s) => s && typeof s.id === 'string' && !s.id.startsWith('sample-session-'));
    return realSessions;
  } catch (e) {
    console.warn('[MeetingStore] Failed to load persisted sessions:', e);
    return [];
  }
}

function savePersistedSessions(sessions: MeetingSession[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, 50))); // keep up to 50 sessions
  } catch (e) {
    console.warn('[MeetingStore] Failed to persist sessions:', e);
  }
}

interface MeetingState {
  sessions: MeetingSession[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  currentTab: 'notes' | 'transcript';
  transcriptViewMode: 'both' | 'src' | 'dst';
  showQuotesSideBySide: boolean;
  searchQuery: string;
  isUpdatingNotes: boolean;
  freshPoints: Set<string>;
  jumpToTimestamp: number | null;

  // Actions
  selectSession: (id: string | null) => void;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  setTab: (tab: 'notes' | 'transcript') => void;
  setTranscriptViewMode: (mode: 'both' | 'src' | 'dst') => void;
  setShowQuotesSideBySide: (show: boolean) => void;
  setSearchQuery: (query: string) => void;
  setJumpToTimestamp: (timestamp: number | null) => void;
  
  // Engine actions
  syncLiveSession: (args: {
    sessionId: string;
    sessionStartTime: number;
    combinedItems: ConversationItem[];
    isLive: boolean;
  }) => void;
  finishLiveSession: (sessionId: string) => Promise<void>;
  generateNotesForSession: (sessionId: string) => Promise<void>;
  createSampleSessionIfEmpty: () => void;
}

export function buildMeetingTranscriptLines(
  combinedItems: ConversationItem[],
  sessionStartTime: number
): MeetingTranscriptLine[] {
  const lines: MeetingTranscriptLine[] = [];
  const validItems = combinedItems.filter(
    (item) => item.type !== 'error' && (item.formatted?.transcript || item.formatted?.text)
  );

  for (let i = 0; i < validItems.length; i++) {
    const item = validItems[i];
    const source = (item as any).source ?? (item.role === 'user' ? 'speaker' : 'participant');
    const isMe = source === 'speaker';
    const speakerName = isMe ? '你' : '对方';
    const itemTime = item.createdAt || sessionStartTime;
    const relSeconds = Math.max(0, (itemTime - sessionStartTime) / 1000);

    const transcript = item.formatted?.transcript?.trim() || '';
    const text = item.formatted?.text?.trim() || '';

    // Case 1: Item already has both transcript (source) and text (translation) and they differ
    if (transcript && text && transcript !== text) {
      lines.push({
        id: item.id || `line-${i}`,
        t: relSeconds,
        speaker: isMe ? 'me' : 'other',
        speakerName,
        src: transcript,
        dst: text,
        isLive: item.status === 'in_progress',
      });
      continue;
    }

    // Case 2: User speech item followed by an assistant translation item with the same source
    if (item.role === 'user') {
      const srcText = transcript || text;
      const nextItem = validItems[i + 1];
      const nextSource = (nextItem as any)?.source ?? 'speaker';

      if (
        nextItem &&
        nextItem.role === 'assistant' &&
        nextSource === source &&
        (!item.segmentId || !nextItem.segmentId || item.segmentId === nextItem.segmentId)
      ) {
        const dstText = nextItem.formatted?.text?.trim() || nextItem.formatted?.transcript?.trim() || '';
        lines.push({
          id: item.id || `line-${i}`,
          t: relSeconds,
          speaker: isMe ? 'me' : 'other',
          speakerName,
          src: srcText,
          dst: dstText,
          isLive: item.status === 'in_progress' || nextItem.status === 'in_progress',
        });
        i++; // consumed nextItem as translation of this turn
        continue;
      }

      // Standalone user item (e.g. still transcribing or waiting for translation)
      lines.push({
        id: item.id || `line-${i}`,
        t: relSeconds,
        speaker: isMe ? 'me' : 'other',
        speakerName,
        src: srcText,
        dst: '',
        isLive: item.status === 'in_progress',
      });
      continue;
    }

    // Case 3: Assistant item without preceding user item
    if (item.role === 'assistant') {
      const prevLine = lines[lines.length - 1];
      if (prevLine && !prevLine.dst && prevLine.speaker === (isMe ? 'me' : 'other')) {
        prevLine.dst = text || transcript;
        if (item.status === 'in_progress') prevLine.isLive = true;
      } else {
        lines.push({
          id: item.id || `line-${i}`,
          t: relSeconds,
          speaker: isMe ? 'me' : 'other',
          speakerName,
          src: transcript || '',
          dst: text || transcript || '',
          isLive: item.status === 'in_progress',
        });
      }
      continue;
    }

    // Fallback for any other item
    lines.push({
      id: item.id || `line-${i}`,
      t: relSeconds,
      speaker: isMe ? 'me' : 'other',
      speakerName,
      src: transcript || text,
      dst: text || transcript,
      isLive: item.status === 'in_progress',
    });
  }

  return lines;
}

// Timer reference outside react state
let notesIntervalTimer: NodeJS.Timeout | null = null;
let lastNotesUpdateTime = 0;

export const useMeetingStore = create<MeetingState>()(
  subscribeWithSelector((set, get) => ({
    sessions: loadPersistedSessions(),
    activeSessionId: null,
    selectedSessionId: null,
    currentTab: 'notes',
    transcriptViewMode: 'both',
    showQuotesSideBySide: false,
    searchQuery: '',
    isUpdatingNotes: false,
    freshPoints: new Set<string>(),
    jumpToTimestamp: null,

    selectSession: (id) => set({ selectedSessionId: id }),

    renameSession: (id, title) => {
      set((state) => {
        const next = state.sessions.map((s) =>
          s.id === id ? { ...s, title, renamed: true } : s
        );
        savePersistedSessions(next);
        return { sessions: next };
      });
    },

    deleteSession: (id) => {
      set((state) => {
        const next = state.sessions.filter((s) => s.id !== id);
        savePersistedSessions(next);
        const selectedSessionId =
          state.selectedSessionId === id
            ? next[0]?.id || null
            : state.selectedSessionId;
        return { sessions: next, selectedSessionId };
      });
    },

    setTab: (tab) => set({ currentTab: tab }),
    setTranscriptViewMode: (mode) => set({ transcriptViewMode: mode }),
    setShowQuotesSideBySide: (show) => set({ showQuotesSideBySide: show }),
    setSearchQuery: (query) => set({ searchQuery: query }),
    setJumpToTimestamp: (timestamp) => set({ jumpToTimestamp: timestamp }),

    syncLiveSession: ({ sessionId, sessionStartTime, combinedItems, isLive }) => {
      const state = get();
      let sessions = [...state.sessions];
      let session = sessions.find((s) => s.id === sessionId);

      // Convert conversation items to MeetingTranscriptLine using paired turns
      const lines = buildMeetingTranscriptLines(combinedItems, sessionStartTime);

      if (!session) {
        session = {
          id: sessionId,
          title: '未命名会议',
          startedAt: sessionStartTime,
          duration: 0,
          lines,
          notes: {
            title: '未命名会议',
            summary: '',
            topics: [],
            conclusions: [],
            todos: [],
            terms: [],
            covered: 0,
            final: false,
          },
        };
        sessions = [session, ...sessions];
      } else {
        session = {
          ...session,
          lines,
          duration: Math.max(0, Math.round((Date.now() - sessionStartTime) / 1000)),
        };
        sessions = sessions.map((s) => (s.id === sessionId ? session! : s));
      }

      set({
        sessions,
        activeSessionId: isLive ? sessionId : null,
        selectedSessionId: state.selectedSessionId || sessionId,
      });

      // Check if we should trigger periodic notes update (~every 45s or when >= 3 lines for first time)
      const now = Date.now();
      const currentCovered = session.notes?.covered || 0;
      const shouldTrigger =
        isLive &&
        lines.length >= 3 &&
        (currentCovered === 0 || lines.length > currentCovered + 2) &&
        (now - lastNotesUpdateTime > 35000 || currentCovered === 0);

      if (shouldTrigger && !state.isUpdatingNotes) {
        lastNotesUpdateTime = now;
        void (async () => {
          set({ isUpdatingNotes: true });
          try {
            const currentNotes = session?.notes || {
              summary: '',
              topics: [],
              conclusions: [],
              todos: [],
              terms: [],
              covered: 0,
              final: false,
            };
            const updated = await NotesEngine.requestNotesUpdate({
              currentNotes,
              lines,
              language: getTargetLanguageName(),
              final: false,
            });

            // Find new points for fresh indicator
            const oldPoints = new Set(currentNotes.topics.flatMap((t) => t.points));
            const newFresh = new Set<string>();
            updated.topics.forEach((t) => {
              t.points.forEach((p) => {
                if (!oldPoints.has(p)) newFresh.add(p);
              });
            });

            set((curr) => {
              const nextSessions = curr.sessions.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      title: s.renamed ? s.title : (updated.title || s.title),
                      notes: updated,
                    }
                  : s
              );
              savePersistedSessions(nextSessions);
              return {
                sessions: nextSessions,
                freshPoints: newFresh,
                isUpdatingNotes: false,
              };
            });

            // Clear fresh points after 60s
            setTimeout(() => {
              set({ freshPoints: new Set() });
            }, 60000);
          } catch (e) {
            console.warn('[MeetingStore] Notes update error:', e);
            set({ isUpdatingNotes: false });
          }
        })();
      }
    },

    finishLiveSession: async (sessionId: string) => {
      const state = get();
      const session = state.sessions.find((s) => s.id === sessionId);
      if (!session) return;

      const endedAt = Date.now();
      const duration = Math.max(0, Math.round((endedAt - session.startedAt) / 1000));

      set({ isUpdatingNotes: true, activeSessionId: null });

      try {
        const finalNotes = await NotesEngine.requestNotesUpdate({
          currentNotes: session.notes || {
            summary: '',
            topics: [],
            conclusions: [],
            todos: [],
            terms: [],
            covered: 0,
            final: true,
          },
          lines: session.lines,
          language: getTargetLanguageName(),
          final: true,
        });

        finalNotes.final = true;

        set((curr) => {
          const next = curr.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  endedAt,
                  duration,
                  title: s.renamed ? s.title : (finalNotes.title || s.title),
                  notes: finalNotes,
                }
              : s
          );
          savePersistedSessions(next);
          return { sessions: next, isUpdatingNotes: false };
        });
      } catch (e) {
        console.warn('[MeetingStore] Finish session notes error:', e);
        set({ isUpdatingNotes: false });
      }
    },

    generateNotesForSession: async (sessionId: string) => {
      const state = get();
      const session = state.sessions.find((s) => s.id === sessionId);
      if (!session || session.lines.length === 0) return;

      set({ isUpdatingNotes: true });
      try {
        const finalNotes = await NotesEngine.requestNotesUpdate({
          currentNotes: session.notes || {
            summary: '',
            topics: [],
            conclusions: [],
            todos: [],
            terms: [],
            covered: 0,
            final: true,
          },
          lines: session.lines,
          language: getTargetLanguageName(),
          final: true,
        });

        set((curr) => {
          const next = curr.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  title: s.renamed ? s.title : (finalNotes.title || s.title),
                  notes: finalNotes,
                }
              : s
          );
          savePersistedSessions(next);
          return { sessions: next, isUpdatingNotes: false };
        });
      } finally {
        set({ isUpdatingNotes: false });
      }
    },

    createSampleSessionIfEmpty: () => {
      // No-op: sample sessions removed for clean initial installation
    },
  }))
);
