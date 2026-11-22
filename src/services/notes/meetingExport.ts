// src/services/notes/meetingExport.ts
import type { MeetingSession } from '../../types/meeting';
import { formatClock, formatSessionDuration } from '../../types/meeting';

const EXPORT_FOLDER_KEY = 'mao_notes_export_folder_v1';

export function getNotesExportFolder(): string {
  try {
    return localStorage.getItem(EXPORT_FOLDER_KEY) || '';
  } catch {
    return '';
  }
}

export function setNotesExportFolder(folder: string): void {
  try {
    if (folder.trim()) {
      localStorage.setItem(EXPORT_FOLDER_KEY, folder.trim());
    } else {
      localStorage.removeItem(EXPORT_FOLDER_KEY);
    }
  } catch {}
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(Math.min(ms, 999)).padStart(3, '0')}`;
}

function sanitizeFilename(name: string): string {
  return (name || 'meeting')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'meeting';
}

export function buildMeetingExportFilename(session: MeetingSession): string {
  const d = new Date(session.startedAt);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}_${hh}-${min}_${sanitizeFilename(session.title)}.md`;
}

/**
 * Formats a meeting session as Obsidian-friendly Markdown with YAML frontmatter.
 */
export function formatMeetingMarkdown(session: MeetingSession, includeFrontmatter = true): string {
  const notes = session.notes || {
    summary: '',
    topics: [],
    conclusions: [],
    todos: [],
    terms: [],
    covered: 0,
    final: false,
  };
  const lines = session.lines || [];

  let md = '';
  if (includeFrontmatter) {
    const iso = new Date(session.startedAt).toISOString();
    const escapedTitle = (session.title || '未命名会议').replace(/"/g, '\\"');
    md += `---\n`;
    md += `title: "${escapedTitle}"\n`;
    md += `date: ${iso}\n`;
    md += `duration: "${formatSessionDuration(session.duration)}"\n`;
    md += `lines: ${lines.length}\n`;
    md += `source: mao-chat\n`;
    md += `---\n\n`;
  }

  md += `# ${session.title}\n\n`;
  md += `*时间: ${new Date(session.startedAt).toLocaleString()} · 时长: ${formatSessionDuration(session.duration)}*\n\n`;

  if (notes.summary) {
    md += `## 总结\n\n${notes.summary}\n\n`;
  }

  if (notes.topics.length > 0) {
    md += `## 议题\n\n`;
    notes.topics.forEach((t) => {
      md += `### ${formatClock(t.start)} ${t.title}\n`;
      if (t.summary) md += `${t.summary}\n\n`;
      t.points.forEach((p, idx) => {
        const pt = t.pointTimes?.[idx];
        md += `- ${p}${pt !== null && pt !== undefined ? ` (${formatClock(pt)})` : ''}\n`;
      });
      md += `\n`;
    });
  }

  if (notes.conclusions.length > 0) {
    md += `## 结论\n\n`;
    notes.conclusions.forEach((c) => {
      md += `- ${c.text}\n`;
    });
    md += `\n`;
  }

  if (notes.todos.length > 0) {
    md += `## 待办事项\n\n`;
    notes.todos.forEach((td) => {
      md += `- [ ] ${td.text}${td.owner ? ` (@${td.owner})` : ''}\n`;
    });
    md += `\n`;
  }

  if (notes.terms && notes.terms.length > 0) {
    md += `## 人名和术语\n\n`;
    notes.terms.forEach((term) => {
      md += `- **${term.name}**${term.note ? `：${term.note}` : ''}\n`;
    });
    md += `\n`;
  }

  md += `## 文字记录\n\n`;
  lines.forEach((l) => {
    md += `**[${formatClock(l.t)}] ${l.speaker === 'me' ? '你' : (l.speakerName || '对方')}:**\n`;
    if (l.src) md += `${l.src}\n`;
    if (l.dst && l.dst !== l.src) md += `*${l.dst}*\n`;
    md += `\n`;
  });

  return md;
}

/**
 * Formats meeting notes as rich HTML suitable for pasting into Feishu, Notion, or Word.
 */
export function formatMeetingHtml(session: MeetingSession): string {
  const notes = session.notes || {
    summary: '',
    topics: [],
    conclusions: [],
    todos: [],
    terms: [],
    covered: 0,
    final: false,
  };

  const parts: string[] = [];
  parts.push(`<h1>${escapeHtml(session.title)}</h1>`);
  parts.push(`<p><em>${escapeHtml(new Date(session.startedAt).toLocaleString())} · ${escapeHtml(formatSessionDuration(session.duration))}</em></p>`);

  if (notes.summary) {
    parts.push(`<h2>总结</h2><p>${escapeHtml(notes.summary)}</p>`);
  }
  if (notes.topics.length > 0) {
    parts.push(`<h2>议题</h2>`);
    notes.topics.forEach((t) => {
      parts.push(`<h3>${escapeHtml(formatClock(t.start))} ${escapeHtml(t.title)}</h3>`);
      if (t.summary) parts.push(`<p>${escapeHtml(t.summary)}</p>`);
      if (t.points.length > 0) {
        parts.push(`<ul>${t.points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`);
      }
    });
  }
  if (notes.conclusions.length > 0) {
    parts.push(`<h2>结论</h2><ul>${notes.conclusions.map((c) => `<li>${escapeHtml(c.text)}</li>`).join('')}</ul>`);
  }
  if (notes.todos.length > 0) {
    parts.push(`<h2>待办事项</h2><ul>${notes.todos.map((td) => `<li>☐ ${escapeHtml(td.text)}${td.owner ? ` (${escapeHtml(td.owner)})` : ''}</li>`).join('')}</ul>`);
  }
  return parts.join('\n');
}

/**
 * Formats transcript lines as standard bilingual SRT subtitles.
 */
export function formatMeetingSrt(session: MeetingSession): string {
  const lines = session.lines || [];
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = Math.max(0, line.t);
    const nextStart = i + 1 < lines.length ? lines[i + 1].t : start + 4;
    const end = Math.max(start + 0.8, Math.min(nextStart, start + 8));
    const textLines: string[] = [];
    if (line.dst && line.dst.trim()) textLines.push(line.dst.trim());
    if (line.src && line.src.trim() && line.src.trim() !== line.dst?.trim()) {
      textLines.push(line.src.trim());
    }
    if (textLines.length === 0) continue;
    blocks.push(
      `${blocks.length + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${textLines.join('\n')}`
    );
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

/**
 * Copies notes as both rich HTML (for Notion/Feishu/Word) and Markdown plain text.
 */
export async function copyMeetingRichNotes(session: MeetingSession): Promise<void> {
  const md = formatMeetingMarkdown(session, false);
  const html = formatMeetingHtml(session);
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([md], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return;
    } catch {
      // Fallback to plain text below
    }
  }
  await navigator.clipboard.writeText(md);
}

/**
 * Automatically writes the session Markdown (with frontmatter) into the user's configured folder.
 */
export async function autoSaveMeetingToFolder(session: MeetingSession): Promise<boolean> {
  const folder = getNotesExportFolder();
  if (!folder) return false;
  if (typeof window === 'undefined' || !(window as any).electron?.invoke) return false;
  try {
    const filename = buildMeetingExportFilename(session);
    const content = formatMeetingMarkdown(session, true);
    const res = await (window as any).electron.invoke('notes:write-markdown', {
      folder,
      filename,
      content,
    });
    return Boolean(res?.ok);
  } catch (e) {
    console.warn('[MeetingExport] Auto-save to folder failed:', e);
    return false;
  }
}
