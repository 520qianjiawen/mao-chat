// src/components/Settings/sections/SpeakSection.test.tsx
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpeakSection } from './SpeakSection';
import { useSpeakStore } from '../../../stores/speakStore';

vi.mock('../../../lib/analytics', () => ({
  useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: string) => fallback || key,
    }),
  };
});

describe('SpeakSection', () => {
  beforeEach(() => {
    localStorage.clear();
    useSpeakStore.setState({
      speakShortcut: 'RightOption',
      speakTo: 'room',
      speakVoices: {
        en: 'ming:US_Emma',
        zh: 'ming:灵小雅',
      },
      voiceClone: null,
      previewingVoiceId: null,
      activeLanguageTab: 'en',
    });
  });

  it('renders all key rows matching Cicada speak section', () => {
    render(<SpeakSection />);

    // Header
    expect(screen.getByText('说话')).toBeInTheDocument();

    // Row 1: 按住说话
    expect(screen.getByText('按住说话')).toBeInTheDocument();
    expect(screen.getByText('右 ⌥')).toBeInTheDocument();

    // Row 2: 说中文，对方听到
    expect(screen.getByText('说中文，对方听到')).toBeInTheDocument();

    // Row 3: 声音
    expect(screen.getByText('声音')).toBeInTheDocument();
  });

  it('toggles voice picker panel when voice chip is clicked', () => {
    render(<SpeakSection />);

    // Initially picker is closed
    expect(screen.queryByText('每种语言各记一个声音')).not.toBeInTheDocument();

    // Click voice chip
    const chipText = screen.getByText('Emma');
    fireEvent.click(chipText);

    // Panel should now be open
    expect(screen.getByText('每种语言各记一个声音')).toBeInTheDocument();
    expect(screen.getByText('Ling 不可用时自动换成本机声音')).toBeInTheDocument();
    expect(screen.getByText('我自己的声音')).toBeInTheDocument();
    expect(screen.getByText('录 15 秒原声，对方听到你的音色，晚约 3 秒')).toBeInTheDocument();
  });

  it('allows selecting a voice from the list', () => {
    render(<SpeakSection />);

    // Open picker
    fireEvent.click(screen.getByText('Emma'));

    // Select George
    const georgeRow = screen.getByText('George');
    fireEvent.click(georgeRow);

    expect(useSpeakStore.getState().speakVoices.en).toBe('ming:UK_George');
  });

  it('renders speak health card and opens Speak Test modal on click', () => {
    render(<SpeakSection />);

    expect(screen.getByText('对方听得到你')).toBeInTheDocument();
    const testBtn = screen.getByText('试一句');
    expect(testBtn).toBeInTheDocument();

    fireEvent.click(testBtn);

    expect(screen.getByText('走一遍真实流程，录下对方会听到的声音，再放给你听')).toBeInTheDocument();
    expect(screen.getByText('用示例句子')).toBeInTheDocument();
    expect(screen.getByText('我说一句')).toBeInTheDocument();
  });
});
