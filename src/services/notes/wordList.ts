// src/services/notes/wordList.ts
export interface WordListEntry {
  canonical: string;
  heard: string[];
}

const WORD_LIST_STORAGE_KEY = 'mao_chat_word_list_v1';

export function loadWordList(): WordListEntry[] {
  try {
    const raw = localStorage.getItem(WORD_LIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e.canonical === 'string' && e.canonical.trim())
      .map((e) => ({
        canonical: String(e.canonical).trim(),
        heard: Array.isArray(e.heard)
          ? e.heard.map((h: unknown) => String(h || '').trim()).filter(Boolean)
          : [],
      }));
  } catch {
    return [];
  }
}

export function saveWordList(entries: WordListEntry[]): void {
  try {
    localStorage.setItem(WORD_LIST_STORAGE_KEY, JSON.stringify(entries));
  } catch {}
}

/**
 * Parses pasted text into WordListEntry items.
 * Supports:
 * - "误听词 => 正确词" or "误听词 -> 正确词" or "误听词=正确词"
 * - "正确词: 误听1, 误听2"
 * - Plain term lines ("正确词")
 */
export function parseWordListText(raw: string): WordListEntry[] {
  const map = new Map<string, Set<string>>();
  const lines = String(raw || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Form 1: heard -> canonical / heard => canonical / heard = canonical
    const arrowMatch = trimmed.match(/^(.+?)\s*(?:=>|->|→|=)\s*(.+)$/);
    if (arrowMatch) {
      const heardPart = arrowMatch[1].trim();
      const canonical = arrowMatch[2].trim();
      if (canonical && heardPart && canonical !== heardPart) {
        if (!map.has(canonical)) map.set(canonical, new Set());
        heardPart
          .split(/[,，、;；]/)
          .map((s) => s.trim())
          .filter((s) => s && s !== canonical)
          .forEach((h) => map.get(canonical)!.add(h));
      }
      continue;
    }

    // Form 2: canonical: heard1, heard2
    const colonMatch = trimmed.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
    if (colonMatch) {
      const canonical = colonMatch[1].trim();
      const heardList = colonMatch[2]
        .split(/[,，、;；]/)
        .map((s) => s.trim())
        .filter((s) => s && s !== canonical);
      if (canonical) {
        if (!map.has(canonical)) map.set(canonical, new Set());
        heardList.forEach((h) => map.get(canonical)!.add(h));
      }
      continue;
    }

    // Form 3: standalone term
    if (!map.has(trimmed)) map.set(trimmed, new Set());
  }

  return Array.from(map.entries()).map(([canonical, heardSet]) => ({
    canonical,
    heard: Array.from(heardSet),
  }));
}

export function formatWordListText(entries: WordListEntry[]): string {
  return entries
    .map((e) => (e.heard.length > 0 ? `${e.heard.join(', ')} -> ${e.canonical}` : e.canonical))
    .join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Applies all heard -> canonical replacements from the global word list.
 * English/ASCII terms match whole words (case-insensitive) so inner letters of
 * unrelated words are never corrupted (Cicada v1.8.0 safety rule).
 */
export function applyWordListCorrections(text: string, entries?: WordListEntry[]): string {
  const source = String(text || '');
  if (!source) return '';
  const list = entries ?? loadWordList();
  if (list.length === 0) return source;

  // Sort longer heard phrases first so multi-word phrases win over substrings
  const pairs: Array<{ heard: string; canonical: string }> = [];
  for (const entry of list) {
    for (const h of entry.heard) {
      if (h && h !== entry.canonical) {
        pairs.push({ heard: h, canonical: entry.canonical });
      }
    }
  }
  if (pairs.length === 0) return source;
  pairs.sort((a, b) => b.heard.length - a.heard.length);

  let out = source;
  for (const { heard, canonical } of pairs) {
    const isAsciiWord = /^[A-Za-z0-9][A-Za-z0-9\s._-]*[A-Za-z0-9]$/.test(heard) || /^[A-Za-z0-9]+$/.test(heard);
    const pattern = isAsciiWord
      ? new RegExp(`\\b${escapeRegExp(heard)}\\b`, 'gi')
      : new RegExp(escapeRegExp(heard), 'g');
    out = out.replace(pattern, canonical);
  }
  return out;
}

/**
 * Adds or merges a single heard -> canonical correction into the persisted global word list.
 */
export function learnWordCorrection(heard: string, canonical: string): WordListEntry[] {
  const h = heard.trim();
  const c = canonical.trim();
  if (!h || !c || h === c) return loadWordList();
  const current = loadWordList();
  const existing = current.find((e) => e.canonical === c);
  if (existing) {
    if (!existing.heard.includes(h)) {
      existing.heard = [...existing.heard, h];
    }
  } else {
    current.push({ canonical: c, heard: [h] });
  }
  saveWordList(current);
  return current;
}
