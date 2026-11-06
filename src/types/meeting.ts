// src/types/meeting.ts
// Data structures for Cicada-inspired Meeting Notes and Sessions

export interface NoteTopic {
  start: number; // in seconds from meeting start
  title: string;
  summary: string;
  points: string[];
  pointTimes?: (number | null)[]; // timestamps in seconds
  fishbone?: {
    question: string;
    branches: {
      label: string;
      detail: string;
      t?: number;
      support: number;
    }[];
  } | null;
}

export interface NoteItem {
  text: string;
  owner?: string | null;
  support: number;
  t?: number | null; // first evidence time in seconds
}

export interface NoteTerm {
  name: string;
  note: string;
  heard: string[];
}

export interface MeetingNotes {
  title?: string;
  summary: string;
  topics: NoteTopic[];
  conclusions: NoteItem[];
  todos: NoteItem[];
  terms: NoteTerm[];
  covered: number; // how many transcript lines these notes cover
  updatedAt?: number;
  final: boolean;
}

export interface MeetingTranscriptLine {
  id: string | number;
  t: number; // relative time in seconds from meeting start
  speaker: 'me' | 'other' | string;
  speakerName?: string;
  src: string;
  dst?: string;
  isLive?: boolean;
}

export interface MeetingSession {
  id: string;
  title: string;
  startedAt: number; // timestamp ms
  endedAt?: number;  // timestamp ms
  duration: number;  // duration in seconds
  lines: MeetingTranscriptLine[];
  notes?: MeetingNotes;
  renamed?: boolean;
}

/**
 * Format seconds into clock format "mm:ss" or "hh:mm:ss"
 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

/**
 * Format session duration text, e.g. "不到 1 分钟", "15 分钟", "1 小时 20 分"
 */
export function formatSessionDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  if (mins < 1) return '不到 1 分钟';
  if (mins < 60) return `${mins} 分钟`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hrs} 小时` : `${hrs} 小时 ${remMins} 分`;
}

/**
 * Format date group header for history sidebar
 */
export function getDateGroupTitle(dateMs: number): string {
  const d = new Date(dateMs);
  const now = new Date();
  
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return '今天';
  
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  
  // Check this week (within 7 days and same week)
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 3600 * 24));
  if (diffDays < 7 && d.getDay() <= now.getDay()) {
    return '本周';
  }
  
  // Month format: "11月" or "2026年11月"
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}
