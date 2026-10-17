import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

import { ModelGroup, RecommendedOthers } from './ModelManagementControls';

describe('RecommendedOthers', () => {
  it('lifts downloaded models above recommended and others', () => {
    const items = [
      { id: 'rec-absent', recommended: true, ready: false },
      { id: 'other-ready', recommended: false, ready: true },
      { id: 'rec-ready', recommended: true, ready: true },
      { id: 'other-absent', recommended: false, ready: false },
    ];
    render(
      <RecommendedOthers
        items={items}
        isRecommended={(m) => m.recommended}
        isDownloaded={(m) => m.ready}
        renderItem={(m) => <div key={m.id}>{m.id}</div>}
      />,
    );

    const labels = Array.from(document.querySelectorAll('.model-subgroup__label'))
      .map((el) => el.textContent);
    expect(labels[0]).toBe('Downloaded');
    expect(labels[1]).toBe('Recommended');
    expect(labels[2]).toBe('Others');

    const ids = Array.from(document.querySelectorAll('.model-subgroup')).map((group) =>
      Array.from(group.querySelectorAll('div'))
        .map((el) => el.textContent)
        .filter((t) => t && !['Downloaded', 'Recommended', 'Others'].includes(t!)),
    );
    // Downloaded band: recommended-ready before other-ready (stable priority)
    expect(ids[0]).toEqual(['rec-ready', 'other-ready']);
    expect(ids[1]).toEqual(['rec-absent']);
    expect(ids[2]).toEqual(['other-absent']);
  });
});

describe('ModelGroup', () => {
  it('is collapsed by default and expands when its header is clicked', () => {
    const { container } = render(
      <ModelGroup title="Speech Synthesis (TTS)">
        <div>Voice models</div>
      </ModelGroup>,
    );

    expect(screen.queryByText('Voice models')).toBeNull();
    fireEvent.click(container.querySelector('.model-group__header') as HTMLElement);
    expect(screen.getByText('Voice models')).toBeTruthy();
  });

  it('still supports an explicitly expanded group', () => {
    render(
      <ModelGroup title="ASR" defaultExpanded>
        <div>Speech models</div>
      </ModelGroup>,
    );

    expect(screen.getByText('Speech models')).toBeTruthy();
  });
});
