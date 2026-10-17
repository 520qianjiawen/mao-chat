import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HelpSection from './HelpSection';

const startOnboarding = vi.fn();
vi.stubGlobal('__APP_VERSION__', '1.0.0');

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock('../../../contexts/OnboardingContext', () => ({
  useOnboarding: () => ({ startOnboarding }),
}));

describe('HelpSection', () => {
  it('keeps the local setup guide but removes external support and update links', () => {
    const toggleSettings = vi.fn();
    render(<HelpSection toggleSettings={toggleSettings} />);

    fireEvent.click(screen.getByText('Restart Setup Guide'));
    expect(startOnboarding).toHaveBeenCalledOnce();
    expect(toggleSettings).toHaveBeenCalledOnce();
    expect(screen.queryByText('Check for Updates')).toBeNull();
    expect(screen.queryByText('support@kizuna.ai')).toBeNull();
    expect(screen.queryByText('Discussions')).toBeNull();
  });
});
