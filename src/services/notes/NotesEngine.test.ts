// src/services/notes/NotesEngine.test.ts
import { describe, it, expect } from 'vitest';
import { NotesEngine } from './NotesEngine';
import type { MeetingNotes, MeetingTranscriptLine } from '../../types/meeting';

describe('NotesEngine', () => {
  const dummyLines: MeetingTranscriptLine[] = [
    { id: '1', t: 1.5, speaker: 'other', speakerName: '对方', src: 'Hello everyone, welcome.', dst: '大家好，欢迎大家。' },
    { id: '2', t: 4.2, speaker: 'me', speakerName: '你', src: 'Glad to be here.', dst: '很高兴来到这里。' },
    { id: '3', t: 10.0, speaker: 'other', speakerName: '对方', src: 'Today we discuss project roadmap.', dst: '今天我们讨论项目路线图。' },
  ];

  const emptyNotes: MeetingNotes = {
    title: '未命名会议',
    summary: '',
    topics: [],
    conclusions: [],
    todos: [],
    terms: [],
    covered: 0,
    final: false,
  };

  it('buildPrompt produces structured prompt matching Cicada guidelines', () => {
    const prompt = NotesEngine.buildPrompt({
      notes: emptyNotes,
      lines: dummyLines,
      from: 0,
      language: 'Simplified Chinese',
      final: false,
    });

    expect(prompt).toContain('You keep notes for a meeting that is still going on');
    expect(prompt).toContain('Write the notes in Simplified Chinese');
    expect(prompt).toContain('[L1 00:01 对方] 大家好，欢迎大家。 (Hello everyone, welcome.)');
    expect(prompt).toContain('[L2 00:04 你] 很高兴来到这里。 (Glad to be here.)');
    expect(prompt).toContain('"topics": [');
  });

  it('parseResponse correctly extracts topics, points, and maps evidence lines to timestamps', () => {
    const rawAiResponse = JSON.stringify({
      title: '项目路线图讨论',
      summary: '双方互致问候，并开始讨论今日的项目路线图规划。',
      topics: [
        {
          start: 1,
          title: '会议开场与问候',
          summary: '双方团队问候与确认到齐。',
          points: [
            { text: '对方欢迎参会人员', evidence: ['L1'] },
            { text: '我方表达参会喜悦', evidence: ['L2'] },
          ],
          evidence: ['L1'],
        },
        {
          start: 10,
          title: '路线图规划',
          summary: '正式进入核心路线图讨论。',
          points: [
            { text: '讨论路线图主要阶段', evidence: ['L3'] },
          ],
          evidence: ['L3'],
        },
      ],
      conclusions: [
        { text: '团队已全部就位并准备就绪', evidence: ['L1', 'L2'] },
      ],
      todos: [
        { text: '下周提交路线图初稿', owner: '你', evidence: ['L3'] },
      ],
      terms: [
        { name: 'Roadmap', note: '项目规划路线图', heard: ['load map'] },
      ],
    });

    const parsed = NotesEngine.parseResponse(rawAiResponse, dummyLines);
    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe('项目路线图讨论');
    expect(parsed?.summary).toContain('项目路线图规划');
    expect(parsed?.topics.length).toBe(2);

    // Topic 1
    expect(parsed?.topics[0].title).toBe('会议开场与问候');
    expect(parsed?.topics[0].points[0]).toBe('对方欢迎参会人员');
    expect(parsed?.topics[0].pointTimes?.[0]).toBe(1.5);
    expect(parsed?.topics[0].pointTimes?.[1]).toBe(4.2);

    // Conclusions & Todos
    expect(parsed?.conclusions[0].text).toBe('团队已全部就位并准备就绪');
    expect(parsed?.conclusions[0].support).toBe(2);
    expect(parsed?.conclusions[0].t).toBe(1.5);

    expect(parsed?.todos[0].text).toBe('下周提交路线图初稿');
    expect(parsed?.todos[0].owner).toBe('你');
    expect(parsed?.todos[0].t).toBe(10.0);

    // Terms
    expect(parsed?.terms[0].name).toBe('Roadmap');
    expect(parsed?.terms[0].heard).toContain('load map');
  });

  it('generateHeuristicNotes provides reliable notes without cloud LLM keys', () => {
    const notes = NotesEngine.generateHeuristicNotes(emptyNotes, dummyLines, true);
    expect(notes.final).toBe(true);
    expect(notes.topics.length).toBeGreaterThan(0);
    expect(notes.covered).toBe(3);
    expect(notes.summary).toBeDefined();
    expect(notes.topics[0].points.length).toBeGreaterThan(0);
  });
});
