import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import SubtitleStream, {
  buildBilingualCues,
  compactCueHoldMs,
  COMPACT_CUE_HOLD_MS,
  COMPACT_CUE_MAX_HOLD_MS,
} from './SubtitleStream';
import { usePlaybackStore } from '../../stores/playbackStore';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

const items: any[] = [
  { id: '1', source: 'speaker',     role: 'user',      type: 'message', status: 'completed', formatted: { text: 'hello' },   sourceLanguage: 'en', targetLanguage: 'zh' },
  { id: '2', source: 'speaker',     role: 'assistant', type: 'message', status: 'completed', formatted: { text: '你好' },     sourceLanguage: 'en', targetLanguage: 'zh' },
  { id: '3', source: 'participant', role: 'user',      type: 'message', status: 'completed', formatted: { text: '再见' },    sourceLanguage: 'en', targetLanguage: 'zh' },
  { id: '4', source: 'participant', role: 'assistant', type: 'message', status: 'completed', formatted: { text: 'goodbye' },  sourceLanguage: 'en', targetLanguage: 'zh' },
];

describe('buildBilingualCues', () => {
  it('pairs consecutive user→assistant items per side', () => {
    const cues = buildBilingualCues(items);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      side: 'speaker',
      origin: { text: 'hello' },
      translation: { text: '你好' },
    });
    expect(cues[1]).toMatchObject({
      side: 'participant',
      origin: { text: '再见' },
      translation: { text: 'goodbye' },
    });
  });

  it('keeps only the last N cues per side', () => {
    const many = [
      { id: 'a', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'one' } },
      { id: 'b', source: 'speaker', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '一' } },
      { id: 'c', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'two' } },
      { id: 'd', source: 'speaker', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '二' } },
      { id: 'e', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'three' } },
      { id: 'f', source: 'speaker', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '三' } },
    ];
    const cues = buildBilingualCues(many, 2);
    expect(cues).toHaveLength(2);
    expect(cues[0].origin?.text).toBe('two');
    expect(cues[1].origin?.text).toBe('three');
  });
});

describe('compactCueHoldMs', () => {
  it('keeps short bilingual captions for at least eight seconds', () => {
    expect(compactCueHoldMs(buildBilingualCues(items)[0])).toBe(COMPACT_CUE_HOLD_MS);
  });

  it('extends long captions without leaving stale text indefinitely', () => {
    const longCue = buildBilingualCues([
      { id: 'long', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'word '.repeat(80) } },
    ])[0];
    expect(compactCueHoldMs(longCue)).toBe(COMPACT_CUE_MAX_HOLD_MS);
  });
});

describe('SubtitleStream — compact bilingual cues', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the current and upcoming cue on the same side', () => {
    const two = [
      { id: 'yt_src_1000', source: 'participant', role: 'user', type: 'message', status: 'completed', formatted: { text: 'now' } },
      { id: 'yt_tr_1000', source: 'participant', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '现在' } },
      { id: 'yt_src_2000', source: 'participant', role: 'user', type: 'message', status: 'completed', formatted: { text: 'next' } },
      { id: 'yt_tr_2000', source: 'participant', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '下一句' } },
    ];
    const { container } = render(
      <SubtitleStream
        items={two}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    const cues = container.querySelectorAll('.subtitle-cue');
    expect(cues.length).toBe(2);
    expect(cues[1].classList.contains('subtitle-cue--ahead')).toBe(true);
  });

  it('shows only the active YouTube cues when the transcript has history', () => {
    const history = [
      { id: 'yt_src_1000', source: 'participant', role: 'user', type: 'message', status: 'completed', active: false, formatted: { text: 'old' } },
      { id: 'yt_tr_1000', source: 'participant', role: 'assistant', type: 'message', status: 'completed', active: false, formatted: { text: '旧' } },
      { id: 'yt_src_2000', source: 'participant', role: 'user', type: 'message', status: 'completed', active: true, formatted: { text: 'now' } },
      { id: 'yt_tr_2000', source: 'participant', role: 'assistant', type: 'message', status: 'completed', active: true, formatted: { text: '现在' } },
      { id: 'yt_src_9000', source: 'participant', role: 'user', type: 'message', status: 'completed', active: false, formatted: { text: 'later' } },
      { id: 'yt_tr_9000', source: 'participant', role: 'assistant', type: 'message', status: 'completed', active: false, formatted: { text: '稍后' } },
    ];
    const { container } = render(
      <SubtitleStream
        items={history}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    const cues = container.querySelectorAll('.subtitle-cue');
    expect(cues.length).toBe(1);
    expect(container.querySelector('.subtitle-stream__line--source')!.textContent).toBe('now');
    expect(container.querySelector('.subtitle-stream__line--translation')!.textContent).toBe('现在');
  });

  it('renders only the latest bilingual cue across both channels', () => {
    const { container } = render(
      <SubtitleStream
        items={items}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    const cues = container.querySelectorAll('.subtitle-cue');
    expect(cues.length).toBe(1);
    expect(container.querySelector('.subtitle-cue--speaker')).toBeNull();
    expect(container.querySelector('.subtitle-cue--participant .subtitle-stream__line--source')!.textContent).toBe('再见');
    expect(container.querySelector('.subtitle-cue--participant .subtitle-stream__line--translation')!.textContent).toBe('goodbye');
  });

  it('hides translation when participantMode is "source"', () => {
    const { container } = render(
      <SubtitleStream
        items={items}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="source"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    // Participant translation item filtered out → unpaired origin-only cue.
    expect(container.querySelector('.subtitle-cue--participant .subtitle-stream__line--translation')).toBeNull();
    expect(container.querySelector('.subtitle-cue--participant .subtitle-stream__line--source')!.textContent).toBe('再见');
    // Older speaker history is not retained in the live caption surface.
    expect(container.querySelector('.subtitle-cue--speaker')).toBeNull();
  });

  it('renders only speaker cues when there are no participant items', () => {
    const speakerOnly = items.filter((i) => i.source === 'speaker');
    const { container } = render(
      <SubtitleStream
        items={speakerOnly}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    expect(container.querySelectorAll('.subtitle-cue').length).toBe(1);
    expect(container.querySelector('.subtitle-cue--participant')).toBeNull();
  });

  it('shows the newest speaker pair when history grows', () => {
    const many: any[] = [
      ...items,
      { id: '5', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'world' }, sourceLanguage: 'en', targetLanguage: 'zh' },
      { id: '6', source: 'speaker', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '世界' }, sourceLanguage: 'en', targetLanguage: 'zh' },
    ];
    const { container } = render(
      <SubtitleStream
        items={many}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    // The newest cue wins globally, even though participant history is newer
    // than the first speaker pair.
    const speakerCues = container.querySelectorAll('.subtitle-cue--speaker');
    expect(speakerCues.length).toBe(1);
    expect(speakerCues[0].querySelector('.subtitle-stream__line--source')!.textContent).toBe('world');
    expect(speakerCues[0].querySelector('.subtitle-stream__line--translation')!.textContent).toBe('世界');
  });

  it('marks live in-progress lines', () => {
    const live = [
      { id: '1', source: 'speaker', role: 'user', type: 'message', status: 'in_progress', formatted: { text: 'hello there' } },
    ];
    const { container } = render(
      <SubtitleStream
        items={live}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    expect(container.querySelector('.subtitle-stream__line--source.is-live')).not.toBeNull();
    expect(container.querySelector('.subtitle-stream__item--live')).not.toBeNull();
  });

  it('clears a completed cue after the bilingual reading window', () => {
    vi.useFakeTimers();
    const { container } = render(
      <SubtitleStream
        items={items.slice(0, 2)}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    expect(container.querySelector('.subtitle-cue')).not.toBeNull();
    act(() => vi.advanceTimersByTime(COMPACT_CUE_HOLD_MS + 100));
    expect(container.querySelector('.subtitle-cue')).toBeNull();
  });

  it('does not expire an in-progress cue', () => {
    vi.useFakeTimers();
    const live = [
      { id: 'live', source: 'speaker', role: 'user', type: 'message', status: 'in_progress', formatted: { text: 'still speaking' } },
    ];
    const { container } = render(
      <SubtitleStream
        items={live}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    act(() => vi.advanceTimersByTime(10000));
    expect(container.querySelector('.subtitle-cue')).not.toBeNull();
  });
});

describe('SubtitleStream — settled-cue freeze (refine churn)', () => {
  const renderStream = (items: any[]) => render(
    <SubtitleStream
      items={items}
      compact
      fontSize={24}
      speakerMode="both"
      participantMode="both"
      sourceLanguage="en"
      targetLanguage="zh"
    />,
  );

  it('keeps the settled bilingual pair visible while the next cue is still forming', () => {
    const forming = [
      { id: 'u1', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'hello' } },
      { id: 'a1', source: 'speaker', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '你好' } },
      { id: 'u2', source: 'speaker', role: 'user', type: 'message', status: 'in_progress', formatted: { text: 'world' } },
    ];
    const { container } = renderStream(forming);
    const cues = container.querySelectorAll('.subtitle-cue');
    expect(cues.length).toBe(2);
    // Frozen settled pair stays on screen — the band must not degrade to a
    // bare source line while the next utterance is awaiting its translation.
    expect(cues[0].querySelector('.subtitle-stream__line--source')!.textContent).toBe('hello');
    expect(cues[0].querySelector('.subtitle-stream__line--translation')!.textContent).toBe('你好');
    expect(cues[1].querySelector('.subtitle-stream__line--source')!.textContent).toBe('world');
    expect(cues[1].querySelector('.subtitle-stream__line--translation')).toBeNull();
  });

  it('does not rewrite a settled cue while the refine re-translates it', () => {
    const initial = [
      { id: 'u1', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'hello' } },
      { id: 'a1', source: 'speaker', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '你好' } },
    ];
    const { container, rerender } = renderStream(initial);
    expect(container.querySelector('.subtitle-stream__line--source')!.textContent).toBe('hello');

    // hayamimi refine: transcript rewritten, translation removed pending re-run.
    const refined = [
      { id: 'u1', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'hello everyone' } },
    ];
    rerender(
      <SubtitleStream
        items={refined}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    expect(container.querySelector('.subtitle-stream__line--source')!.textContent).toBe('hello');
    expect(container.querySelector('.subtitle-stream__line--translation')!.textContent).toBe('你好');

    // Refined translation lands — the band updates quietly.
    const refinedDone = [
      { id: 'u1', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'hello everyone' } },
      { id: 'a2', source: 'speaker', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '大家好' } },
    ];
    rerender(
      <SubtitleStream
        items={refinedDone}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    expect(container.querySelectorAll('.subtitle-cue').length).toBe(1);
    expect(container.querySelector('.subtitle-stream__line--source')!.textContent).toBe('hello everyone');
    expect(container.querySelector('.subtitle-stream__line--translation')!.textContent).toBe('大家好');
  });

  it('does not fall back to a frozen pair when the modes hide the missing line', () => {
    const initial = [
      { id: 'p1', source: 'participant', role: 'user', type: 'message', status: 'completed', formatted: { text: '再见' } },
      { id: 'p2', source: 'participant', role: 'assistant', type: 'message', status: 'completed', formatted: { text: 'goodbye' } },
    ];
    const { container } = render(
      <SubtitleStream
        items={initial}
        compact
        fontSize={24}
        speakerMode="both"
        participantMode="translation"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    // Participant source rows are filtered: the origin-only cue is permanent,
    // not a translation in flight — no frozen fallback may resurrect history.
    expect(container.querySelectorAll('.subtitle-cue').length).toBe(1);
    expect(container.querySelector('.subtitle-stream__line--source')).toBeNull();
    expect(container.querySelector('.subtitle-stream__line--translation')!.textContent).toBe('goodbye');
  });
});

describe('SubtitleStream — new item highlight', () => {
  beforeEach(() => {
    usePlaybackStore.setState({ playingItemId: null, progress: null } as any);
  });

  it('tags newly arrived items with --new after first paint', () => {
    const { container, rerender } = render(
      <SubtitleStream
        items={items.slice(0, 2)}
        compact
        fontSize={20}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
      />,
    );
    // First paint: existing items are not --new.
    expect(container.querySelectorAll('.subtitle-stream__item--new').length).toBe(0);

    const next = [
      ...items.slice(0, 2),
      { id: '5', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'later' } },
      { id: '6', source: 'speaker', role: 'assistant', type: 'message', status: 'completed', formatted: { text: '稍后' } },
    ];
    act(() => {
      rerender(
        <SubtitleStream
          items={next}
          compact
          fontSize={20}
          speakerMode="both"
          participantMode="both"
          sourceLanguage="en"
          targetLanguage="zh"
        />,
      );
    });
    // New pair should carry --new on its lines.
    expect(container.querySelectorAll('.subtitle-stream__item--new').length).toBeGreaterThan(0);
  });

  it('does not add --new when newItemHighlightEnabled is false', () => {
    const { container, rerender } = render(
      <SubtitleStream
        items={items.slice(0, 2)}
        compact
        fontSize={20}
        speakerMode="both"
        participantMode="both"
        sourceLanguage="en"
        targetLanguage="zh"
        newItemHighlightEnabled={false}
      />,
    );
    act(() => {
      rerender(
        <SubtitleStream
          items={[
            ...items.slice(0, 2),
            { id: '9', source: 'speaker', role: 'user', type: 'message', status: 'completed', formatted: { text: 'x' } },
          ]}
          compact
          fontSize={20}
          speakerMode="both"
          participantMode="both"
          sourceLanguage="en"
          targetLanguage="zh"
          newItemHighlightEnabled={false}
        />,
      );
    });
    expect(container.querySelectorAll('.subtitle-stream__item--new').length).toBe(0);
  });
});
