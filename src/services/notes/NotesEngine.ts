// src/services/notes/NotesEngine.ts
import type { MeetingNotes, MeetingTranscriptLine, NoteTopic, NoteItem, NoteTerm } from '../../types/meeting';
import { formatClock } from '../../types/meeting';
import useSettingsStore from '../../stores/settingsStore';
import { Provider } from '../../types/Provider';

export interface NotesEngineConfig {
  language?: string;
}

export class NotesEngine {
  private static parseEvidenceLineNumbers(evidence: unknown, totalLines: number): number[] {
    if (!Array.isArray(evidence)) return [];
    const numbers: number[] = [];
    for (const item of evidence) {
      if (typeof item === 'string') {
        const match = item.match(/L?(\d+)/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num >= 1 && num <= totalLines) {
            numbers.push(num);
          }
        }
      } else if (typeof item === 'number' && item >= 1 && item <= totalLines) {
        numbers.push(item);
      }
    }
    return numbers;
  }

  /**
   * Builds the prompt following Cicada's specification for incremental & final meeting notes.
   */
  public static buildPrompt(args: {
    notes: MeetingNotes;
    lines: MeetingTranscriptLine[];
    from: number;
    language: string;
    final: boolean;
  }): string {
    const { notes, lines, from, language, final } = args;

    const formatLine = (l: MeetingTranscriptLine, idx: number) => {
      const speakerName = l.speaker === 'me' ? '你' : (l.speakerName || '对方');
      // If translated text (dst) is available, prioritize dst so the AI summarizes in the user's target language
      const mainText = (l.dst && l.dst.trim().length > 0) ? l.dst.trim() : (l.src ? l.src.trim() : '');
      const altText = (l.dst && l.src && l.dst.trim() !== l.src.trim()) ? ` (${l.src.trim()})` : '';
      return `[L${idx + 1} ${formatClock(l.t)} ${speakerName}] ${mainText}${altText}`;
    };

    const currentNotesJson = notes && (!notes.summary.trim() && notes.topics.length === 0)
      ? '{}'
      : JSON.stringify({
          title: notes.title,
          summary: notes.summary,
          topics: notes.topics.map((t) => ({
            start: t.start,
            title: t.title,
            summary: t.summary,
            points: t.points,
          })),
          conclusions: notes.conclusions.map((c) => c.text),
          todos: notes.todos.map((t) => t.text),
          terms: notes.terms,
        });

    const contextStart = Math.max(0, from - 2);
    let prompt = `You keep notes for a meeting ${
      final
        ? 'that has just ended. Rewrite them from the whole transcript'
        : 'that is still going on. Update them with the new lines'
    }.\nWrite the notes in ${language}. Return JSON only.\n\n`;

    if (!final && currentNotesJson !== '{}') {
      prompt += `Current notes (JSON):\n${currentNotesJson}\n\n`;
    }

    if (contextStart < from) {
      prompt += 'Already covered (context only):\n';
      prompt += lines.slice(contextStart, from).map((l, i) => formatLine(l, contextStart + i)).join('\n');
      prompt += '\n\n';
    }

    prompt += `${final ? 'Transcript' : 'New lines'} (id, mm:ss, speaker [对方=the other party / 你=me], text):\n`;
    prompt += lines.slice(from).map((l, i) => formatLine(l, from + i)).join('\n');

    if (final && lines.length > 0) {
      const first = lines[0].t;
      const last = lines[lines.length - 1].t;
      const most = Math.max(1, Math.min(8, Math.floor((last - first) / 180) + 1));
      prompt += `\n\nThis meeting ran ${formatClock(last - first)}: use at most ${most} topic(s).`;
    } else if (!final && notes.topics.length > 0) {
      const lastTopic = notes.topics[notes.topics.length - 1];
      const newest = lines[lines.length - 1]?.t ?? 0;
      if (newest - lastTopic.start < 120) {
        prompt += `\n\nThe current topic "${lastTopic.title}" started at ${formatClock(
          lastTopic.start
        )}, under 2 minutes ago: do not start a new topic in this update; add the new lines to it.`;
      }
    } else if (!final && notes.topics.length === 0) {
      prompt += '\n\nThese are the first lines: make one topic.';
    }

    prompt += `\n\nReturn the full notes as one JSON object with exactly these keys:
{
  "title": "the meeting's name: what it is about, a few words (at most 15 chars)",
  "summary": "2-3 concise sentences on the whole meeting so far",
  "topics": [
    {
      "start": 0,
      "title": "short topic title",
      "summary": "one sentence overview",
      "points": [{"text": "key point", "evidence": ["L1"]}],
      "evidence": ["L1"]
    }
  ],
  "conclusions": [{"text": "conclusion description", "evidence": ["L2"]}],
  "todos": [{"text": "action item", "owner": "对方 or 你 or null", "evidence": ["L3"]}],
  "terms": [{"name": "correct term", "note": "brief definition", "heard": ["misheard form"]}]
}

Rules:
- Write strictly valid JSON, no markdown codeblocks, no text outside JSON.
- CRITICAL LANGUAGE RULE: All title, summary, topic titles, points, conclusions, and todos MUST be written in ${language} (中文).
- STRICT PROHIBITION: NEVER output raw untranslated foreign-language sentences (such as English) in points or summary. Every point must be summarized or translated into ${language}.
- Every topic, point, conclusion, todo MUST have evidence with line IDs (e.g. ["L1"]).
`;

    return prompt;
  }

  /**
   * Lenient JSON parser mapping evidence lines to timestamps.
   */
  public static parseResponse(
    rawText: string,
    lines: MeetingTranscriptLine[],
    fallbackTitle?: string
  ): MeetingNotes | null {
    try {
      let text = rawText.trim();
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        text = text.substring(firstBrace, lastBrace + 1);
      }

      const root = JSON.parse(text);
      const totalLines = lines.length;

      const getFirstLineTime = (evidence: unknown): number | null => {
        const nums = NotesEngine.parseEvidenceLineNumbers(evidence, totalLines);
        if (nums.length === 0) return null;
        const minNum = Math.min(...nums);
        return lines[minNum - 1]?.t ?? null;
      };

      const title = typeof root.title === 'string' && root.title.trim().length > 0
        ? root.title.trim()
        : fallbackTitle;

      const summary = typeof root.summary === 'string' ? root.summary.trim() : '';

      const topics: NoteTopic[] = (Array.isArray(root.topics) ? root.topics : []).map((t: any) => {
        const rawPoints = Array.isArray(t.points) ? t.points : [];
        const pointTexts: string[] = [];
        const pointTimes: (number | null)[] = [];

        for (const p of rawPoints) {
          if (typeof p === 'string') {
            pointTexts.push(p);
            pointTimes.push(null);
          } else if (p && typeof p === 'object') {
            pointTexts.push(p.text || '');
            pointTimes.push(getFirstLineTime(p.evidence));
          }
        }

        const topicStart = typeof t.start === 'number'
          ? t.start
          : (getFirstLineTime(t.evidence) ?? (lines[0]?.t || 0));

        return {
          start: topicStart,
          title: typeof t.title === 'string' ? t.title : '讨论',
          summary: typeof t.summary === 'string' ? t.summary : '',
          points: pointTexts,
          pointTimes,
          fishbone: t.fishbone || null,
        };
      });

      const conclusions: NoteItem[] = (Array.isArray(root.conclusions) ? root.conclusions : []).map((c: any) => {
        if (typeof c === 'string') {
          return { text: c, support: 1, t: null };
        }
        const nums = NotesEngine.parseEvidenceLineNumbers(c.evidence, totalLines);
        return {
          text: c.text || '',
          owner: c.owner || null,
          support: nums.length || 1,
          t: getFirstLineTime(c.evidence),
        };
      });

      const todos: NoteItem[] = (Array.isArray(root.todos) ? root.todos : []).map((item: any) => {
        if (typeof item === 'string') {
          return { text: item, support: 1, t: null };
        }
        const nums = NotesEngine.parseEvidenceLineNumbers(item.evidence, totalLines);
        return {
          text: item.text || '',
          owner: item.owner || null,
          support: nums.length || 1,
          t: getFirstLineTime(item.evidence),
        };
      });

      const terms: NoteTerm[] = (Array.isArray(root.terms) ? root.terms : []).map((term: any) => ({
        name: term.name || '',
        note: term.note || '',
        heard: Array.isArray(term.heard) ? term.heard : [],
      }));

      return {
        title,
        summary,
        topics,
        conclusions,
        todos,
        terms,
        covered: lines.length,
        updatedAt: Date.now(),
        final: false,
      };
    } catch (e) {
      console.warn('[NotesEngine] Failed to parse notes response:', e);
      return null;
    }
  }

  /**
   * Generates heuristic / fallback notes if no cloud API is configured or available.
   * This guarantees that live meeting notes always work smoothly!
   */
  public static generateHeuristicNotes(
    currentNotes: MeetingNotes,
    lines: MeetingTranscriptLine[],
    final: boolean
  ): MeetingNotes {
    if (lines.length === 0) {
      return {
        ...currentNotes,
        covered: 0,
        final,
      };
    }

    const firstTime = lines[0]?.t || 0;
    const lastTime = lines[lines.length - 1]?.t || 0;

    // Pick key sentences from the transcript (prefer translated lines if available)
    const keyLines = lines.filter((l) => (l.dst || l.src).trim().length > 4);
    const summaryText = keyLines.slice(-4).map((l) => (l.dst && l.dst.trim().length > 0 ? l.dst.trim() : l.src.trim())).join('。');

    // Divide lines into topics by ~120s or 6 lines
    const topics: NoteTopic[] = [];
    const chunkSize = 6;
    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunk = lines.slice(i, i + chunkSize);
      const start = chunk[0]?.t || 0;
      const firstLineText = ((chunk[0]?.dst && chunk[0].dst.trim()) || chunk[0]?.src || '').slice(0, 15);
      const title = firstLineText ? `讨论: ${firstLineText}...` : `议题 ${Math.floor(i / chunkSize) + 1}`;
      
      const points = chunk
        .slice(0, 4)
        .map((l) => (l.dst && l.dst.trim().length > 0 ? l.dst.trim() : (l.src ? l.src.trim() : '')));
      const pointTimes = chunk.slice(0, 4).map((l) => l.t);

      topics.push({
        start,
        title,
        summary: chunk
          .map((l) => (l.dst && l.dst.trim().length > 0 ? l.dst.trim() : (l.src ? l.src.trim() : '')))
          .slice(0, 2)
          .join('，'),
        points,
        pointTimes,
      });
    }

    const firstValid = lines[0] ? ((lines[0].dst && lines[0].dst.trim()) || lines[0].src || '').slice(0, 12) : '';
    const title = currentNotes.title || (firstValid ? `会议: ${firstValid}` : '会议纪要');

    return {
      title,
      summary: summaryText ? `${summaryText}。` : '会议正在进行中，已开始实时记录发言内容。',
      topics: topics.length > 0 ? topics : [
        {
          start: firstTime,
          title: '会议讨论',
          summary: '实时发言记录',
          points: lines.slice(0, 4).map((l) => (l.dst && l.dst.trim().length > 0 ? l.dst.trim() : (l.src ? l.src.trim() : ''))),
          pointTimes: lines.slice(0, 4).map((l) => l.t),
        }
      ],
      conclusions: currentNotes.conclusions || [],
      todos: currentNotes.todos || [],
      terms: currentNotes.terms || [],
      covered: lines.length,
      updatedAt: Date.now(),
      final,
    };
  }

  /**
   * Invokes an LLM call or fallback to generate meeting notes.
   */
  public static async requestNotesUpdate(args: {
    currentNotes: MeetingNotes;
    lines: MeetingTranscriptLine[];
    language?: string;
    final?: boolean;
  }): Promise<MeetingNotes> {
    const { currentNotes, lines, language = 'Simplified Chinese', final = false } = args;
    const from = final ? 0 : Math.min(currentNotes.covered, lines.length);

    // If no new lines and not a final pass, return existing notes
    if (!final && lines.length <= currentNotes.covered && currentNotes.topics.length > 0) {
      return currentNotes;
    }

    const prompt = NotesEngine.buildPrompt({
      notes: currentNotes,
      lines,
      from,
      language,
      final,
    });

    const settings = useSettingsStore.getState();
    const provider = settings.provider;

    // Check if we can call OpenAI / OpenAI-Compatible (Ling) / Gemini
    let aiResponseText: string | null = null;
    try {
      const antLingKey = settings.antLing?.apiKey;
      const openAICompatibleKey = settings.openaiCompatible?.apiKey;
      const openAIKey = settings.openaiSettings?.apiKey || settings.openaiTranslate?.apiKey;
      const geminiKey = settings.geminiSettings?.apiKey;

      if (provider === Provider.ANT_LING || (antLingKey && !openAIKey && !geminiKey)) {
        const slice = settings.antLing;
        const apiKey = slice?.apiKey;
        const endpoint = (slice?.customEndpoint || 'https://api.ant-ling.com/v1').replace(/\/+$/, '');
        const model = slice?.chatModel || 'Ling-3.1-flash';
        if (apiKey) {
          const res = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: `You are an expert meeting note keeper. Respond with JSON in ${language}.` },
                { role: 'user', content: prompt },
              ],
              response_format: { type: 'json_object' },
              temperature: 0.2,
              thinking: { type: 'disabled' },
            }),
          });
          if (res.ok) {
            const data = await res.json();
            aiResponseText = data?.choices?.[0]?.message?.content || null;
          }
        }
      } else if (provider === Provider.OPENAI_COMPATIBLE || (openAICompatibleKey && !openAIKey && !geminiKey)) {
        const slice = settings.openaiCompatible;
        const apiKey = slice?.apiKey;
        const endpoint = (slice?.customEndpoint || 'https://api.ant-ling.com/v1').replace(/\/+$/, '');
        const model = slice?.model || 'Ling-3.1-flash';
        if (apiKey) {
          const res = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: `You are an expert meeting note keeper. Respond with JSON in ${language}.` },
                { role: 'user', content: prompt },
              ],
              response_format: { type: 'json_object' },
              temperature: 0.2,
              thinking: { type: 'disabled' },
            }),
          });
          if (res.ok) {
            const data = await res.json();
            aiResponseText = data?.choices?.[0]?.message?.content || null;
          }
        }
      } else if (provider === Provider.OPENAI || provider === Provider.OPENAI_TRANSLATE || (openAIKey && !geminiKey)) {
        const apiKey = openAIKey;
        if (apiKey) {
          const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: `You are an expert meeting note keeper. Respond with JSON in ${language}.` },
                { role: 'user', content: prompt },
              ],
              response_format: { type: 'json_object' },
              temperature: 0.2,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            aiResponseText = data?.choices?.[0]?.message?.content || null;
          }
        }
      } else if (provider === Provider.GEMINI || geminiKey) {
        const apiKey = geminiKey;
        if (apiKey) {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                  responseMimeType: 'application/json',
                  temperature: 0.2,
                },
              }),
            }
          );
          if (res.ok) {
            const data = await res.json();
            aiResponseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
          }
        }
      }
    } catch (e) {
      console.warn('[NotesEngine] AI request failed, falling back to heuristic note generator:', e);
    }

    if (aiResponseText) {
      const parsed = NotesEngine.parseResponse(aiResponseText, lines, currentNotes.title);
      if (parsed) {
        parsed.final = final;
        return parsed;
      }
    }

    // Heuristic generator fallback
    return NotesEngine.generateHeuristicNotes(currentNotes, lines, final);
  }
}
