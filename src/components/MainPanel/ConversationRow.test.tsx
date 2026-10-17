import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ConversationItem } from '../../services/interfaces/IClient';
import ConversationRow, { languageForItem } from './ConversationRow';
import { Provider } from '../../types/Provider';

const storeMocks = vi.hoisted(() => ({
  mode: 'speaker' as 'speaker' | 'participant' | 'both',
  provider: 'local_native' as Provider,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('../../stores/audioStore', () => ({
  useMode: () => storeMocks.mode,
}));

vi.mock('../../stores/settingsStore', () => ({
  useProvider: () => storeMocks.provider,
}));

type RowItem = ConversationItem & {
  source?: 'speaker' | 'participant';
  sourceLanguage?: string;
  targetLanguage?: string;
};

function makeItem(over: Partial<RowItem>): RowItem {
  return {
    id: 'i1',
    role: 'user',
    type: 'message',
    status: 'completed',
    formatted: { text: 'hello' },
    source: 'speaker',
    createdAt: 1700000000000,
    ...over,
  } as RowItem;
}

const baseProps = {
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  isPlaying: false,
  highlightedChars: 0,
};

describe('ConversationRow — expanded (default) mode', () => {
  it('uses the forward language pair for extension tab audio', () => {
    expect(languageForItem('participant', 'user', 'en', 'zh', true)).toBe('en');
    expect(languageForItem('participant', 'assistant', 'en', 'zh', true)).toBe('zh');
  });

  it('renders the row header when there is no previous item', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker' })}
        prevItem={null}
      />,
    );
    expect(container.querySelector('.row-header')).not.toBeNull();
  });

  it('renders the lang-badge', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker' })}
        prevItem={null}
      />,
    );
    expect(container.querySelector('.lang-badge')).not.toBeNull();
  });

  it('badge prefers the item\'s detectedLanguage over the configured mapping', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'user', detectedLanguage: 'de' })}
        prevItem={null}
      />,
    );
    expect(container.querySelector('.lang-badge')?.textContent).toBe('DE');
  });

  it('badge falls back to the configured mapping when detectedLanguage is absent', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'user' })}
        prevItem={null}
      />,
    );
    // speaker/user → sourceLanguage ('zh')
    expect(container.querySelector('.lang-badge')?.textContent).toBe('ZH');
  });

  it('uses source -> subtitle badges for Electron system audio', () => {
    window.electronAPI = {};
    storeMocks.mode = 'participant';
    storeMocks.provider = Provider.LOCAL_NATIVE;
    try {
      const { container } = render(
        <ConversationRow
          {...baseProps}
          sourceLanguage="en"
          targetLanguage="zh"
          item={makeItem({ source: 'participant', role: 'user' })}
          prevItem={null}
        />,
      );
      expect(container.querySelector('.lang-badge')?.textContent).toBe('EN');
    } finally {
      delete window.electronAPI;
      storeMocks.mode = 'speaker';
    }
  });

  it('uses meeting badges for desktop Both inbound subtitles', () => {
    window.electronAPI = {};
    storeMocks.mode = 'both';
    storeMocks.provider = Provider.LOCAL_NATIVE;
    try {
      const { container } = render(
        <ConversationRow
          {...baseProps}
          sourceLanguage="zh"
          targetLanguage="en"
          item={makeItem({ source: 'participant', role: 'user' })}
          prevItem={null}
        />,
      );
      // They speak the target language; original line is EN.
      expect(container.querySelector('.lang-badge')?.textContent).toBe('EN');
    } finally {
      delete window.electronAPI;
    }
  });

  it('renders the row play button on assistant rows when canPlay is true', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'assistant' })}
        prevItem={null}
        canPlay
        onPlay={() => {}}
      />,
    );
    const btn = container.querySelector('.row-play-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.disabled).toBe(false);
  });

  it('hides the play button entirely when replayEnabled is false', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'assistant' })}
        prevItem={null}
        canPlay
        onPlay={() => {}}
        replayEnabled={false}
      />,
    );
    expect(container.querySelector('.row-play-btn')).toBeNull();
  });

  it('shows the play button when replayEnabled is true (existing behavior)', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'assistant' })}
        prevItem={null}
        canPlay
        onPlay={() => {}}
        replayEnabled={true}
      />,
    );
    expect(container.querySelector('.row-play-btn')).not.toBeNull();
  });

  it('renders the play button as disabled on streaming assistant rows (layout stability)', () => {
    // The button slot must be reserved while the assistant item is still
    // streaming, otherwise text re-flows when it appears on completion.
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'assistant', status: 'in_progress' })}
        prevItem={null}
        canPlay={false}
        onPlay={() => {}}
      />,
    );
    const btn = container.querySelector('.row-play-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.disabled).toBe(true);
  });

  it('does not render a play button on user rows (no audio to play)', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'user' })}
        prevItem={null}
        canPlay
        onPlay={() => {}}
      />,
    );
    expect(container.querySelector('.row-play-btn')).toBeNull();
  });

  it('does not render a play button on participant rows (text-only channel, no audio)', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'participant', role: 'assistant' })}
        prevItem={null}
        canPlay
        onPlay={() => {}}
      />,
    );
    expect(container.querySelector('.row-play-btn')).toBeNull();
  });

  it('does not render the play button when onPlay is not provided', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'assistant' })}
        prevItem={null}
      />,
    );
    expect(container.querySelector('.row-play-btn')).toBeNull();
  });

  it('does not render a role dot in expanded mode', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker' })}
        prevItem={null}
      />,
    );
    expect(container.querySelector('.row-role-dot')).toBeNull();
  });

  it('tags the translation badge with source-speaker on speaker rows', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'assistant' })}
        prevItem={null}
      />,
    );
    const badge = container.querySelector('.lang-badge.tr');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('source-speaker')).toBe(true);
  });

  it('tags the translation badge with source-participant on participant rows', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'participant', role: 'assistant' })}
        prevItem={null}
      />,
    );
    const badge = container.querySelector('.lang-badge.tr');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('source-participant')).toBe(true);
  });

  it('tags the source badge with source-<role> too (for future theming)', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'participant', role: 'user' })}
        prevItem={null}
      />,
    );
    const badge = container.querySelector('.lang-badge.src');
    expect(badge?.classList.contains('source-participant')).toBe(true);
  });

  it('uses the language pair stored on the item over the live props', () => {
    // Props reflect *current* settings; the item carries the language pair
    // that was active when it was produced. The badge must follow the item.
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({
          source: 'speaker',
          role: 'user',
          sourceLanguage: 'ja',
          targetLanguage: 'ko',
        })}
        prevItem={null}
      />,
    );
    const badge = container.querySelector('.lang-badge.src');
    expect(badge?.textContent).toBe('JA');
  });

  it('falls back to props when the item has no language snapshot', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'user' })}
        prevItem={null}
      />,
    );
    const badge = container.querySelector('.lang-badge.src');
    expect(badge?.textContent).toBe('ZH');
  });

  it('renders extension captions as a clean source row without repeated chrome', () => {
    const originalChrome = window.chrome;
    storeMocks.mode = 'participant';
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { id: 'test-extension-id' } },
    });

    try {
      const { container } = render(
        <ConversationRow
          {...baseProps}
          item={makeItem({ source: 'participant', role: 'user' })}
          prevItem={null}
        />,
      );
      const root = container.querySelector('.conversation-row');
      expect(root?.classList.contains('extension-caption-row')).toBe(true);
      expect(root?.classList.contains('extension-caption-source')).toBe(true);
      expect(container.querySelector('.row-header')).toBeNull();
      expect(container.querySelector('.lang-badge')).toBeNull();
      expect(container.querySelector('.row-video-time')).toBeNull();
      expect(container.querySelector('.row-text')?.getAttribute('lang')).toBe('zh');
    } finally {
      storeMocks.mode = 'speaker';
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: originalChrome,
      });
    }
  });

  it('marks an extension assistant row as the translation half of a pair', () => {
    const originalChrome = window.chrome;
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { id: 'test-extension-id' } },
    });

    try {
      const { container } = render(
        <ConversationRow
          {...baseProps}
          item={makeItem({ source: 'participant', role: 'assistant' })}
          prevItem={makeItem({ source: 'participant', role: 'user' })}
        />,
      );
      const root = container.querySelector('.conversation-row');
      expect(root?.classList.contains('extension-caption-translation')).toBe(true);
      expect(container.querySelector('.row-header')).toBeNull();
      expect(container.querySelector('.lang-badge')).toBeNull();
    } finally {
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: originalChrome,
      });
    }
  });

  it('shows a video timestamp on YouTube caption source rows', () => {
    const originalChrome = window.chrome;
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { id: 'test-extension-id' } },
    });

    try {
      const { container } = render(
        <ConversationRow
          {...baseProps}
          item={makeItem({
            id: 'yt_src_140000',
            source: 'participant',
            role: 'user',
            formatted: { text: "that somehow we've lost the capacity for shock." },
          })}
          prevItem={null}
        />,
      );
      expect(container.querySelector('.row-video-time')?.textContent).toBe('2:20');
    } finally {
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: originalChrome,
      });
    }
  });
});

describe('ConversationRow — compact mode', () => {
  it('hides the row header', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker' })}
        prevItem={null}
        compact
      />,
    );
    expect(container.querySelector('.row-header')).toBeNull();
  });

  it('hides the lang-badge', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker' })}
        prevItem={null}
        compact
      />,
    );
    expect(container.querySelector('.lang-badge')).toBeNull();
  });

  it('hides the row play button even when canPlay is true', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', role: 'assistant' })}
        prevItem={null}
        canPlay
        onPlay={() => {}}
        compact
      />,
    );
    expect(container.querySelector('.row-play-btn')).toBeNull();
  });

  it('renders a speaker-colored role dot on the first row of a speaker run', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker' })}
        prevItem={null}
        compact
      />,
    );
    const dot = container.querySelector('.row-role-dot');
    expect(dot).not.toBeNull();
    expect(dot?.classList.contains('source-speaker')).toBe(true);
  });

  it('exposes the role dot to screen readers via role + aria-label', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker' })}
        prevItem={null}
        compact
      />,
    );
    const dot = container.querySelector('.row-role-dot');
    expect(dot?.getAttribute('role')).toBe('img');
    expect(dot?.getAttribute('aria-label')).toBe('Speaker');
  });

  it('renders a participant-colored role dot on the first row of a participant run', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'participant' })}
        prevItem={makeItem({ source: 'speaker' })}
        compact
      />,
    );
    const dot = container.querySelector('.row-role-dot');
    expect(dot).not.toBeNull();
    expect(dot?.classList.contains('source-participant')).toBe(true);
  });

  it('does NOT render a role dot when prevItem has the same source', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker', id: 'b' })}
        prevItem={makeItem({ source: 'speaker', id: 'a' })}
        compact
      />,
    );
    expect(container.querySelector('.row-role-dot')).toBeNull();
  });

  it('adds a compact class on the root element', () => {
    const { container } = render(
      <ConversationRow
        {...baseProps}
        item={makeItem({ source: 'speaker' })}
        prevItem={null}
        compact
      />,
    );
    const root = container.querySelector('.conversation-row');
    expect(root?.classList.contains('compact')).toBe(true);
  });
});
