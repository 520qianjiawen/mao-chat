import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TitleBar from './TitleBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../../utils/environment', () => ({
  isElectron: () => true,
  isExtension: () => false,
  isMacOS: () => true,
}));
vi.mock('../Subtitle/SubtitleEnterButton', () => ({ default: () => null }));

describe('TitleBar standalone tools', () => {
  it('keeps the standalone text-to-speech tool visible before a session starts', () => {
    const onToggleTextToSpeech = vi.fn();
    render(
      <TitleBar
        showSettings={false}
        showLogs={false}
        showTextToSpeech={false}
        showTextTranslation={false}
        onToggleSettings={vi.fn()}
        onToggleLogs={vi.fn()}
        onToggleTextToSpeech={onToggleTextToSpeech}
        onToggleTextTranslation={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '文本转语音' }));
    expect(onToggleTextToSpeech).toHaveBeenCalledOnce();
  });

  it('keeps the text translation tool visible and toggles it on click', () => {
    const onToggleTextTranslation = vi.fn();
    render(
      <TitleBar
        showSettings={false}
        showLogs={false}
        showTextToSpeech={false}
        showTextTranslation={false}
        onToggleSettings={vi.fn()}
        onToggleLogs={vi.fn()}
        onToggleTextToSpeech={vi.fn()}
        onToggleTextTranslation={onToggleTextTranslation}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '文本翻译' }));
    expect(onToggleTextTranslation).toHaveBeenCalledOnce();
  });
});
