// src/components/MainPanel/ListenPill.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ListenPill from './ListenPill';
import useSessionStore from '../../stores/sessionStore';
import useSettingsStore from '../../stores/settingsStore';

describe('ListenPill', () => {
  beforeEach(() => {
    useSessionStore.setState({
      isSessionActive: false,
      isInitializing: false,
      sessionStartTime: null,
      startSessionVersion: 0,
      stopSessionVersion: 0,
      startGate: { canStart: true, reason: null },
    });
  });

  it('renders idle pill with logo, brand and 开始听 ⌘R', () => {
    render(<ListenPill />);
    expect(screen.getByText('MAO Chat')).toBeInTheDocument();
    expect(screen.getByText('开始听')).toBeInTheDocument();
    expect(screen.getByText('⌘R')).toBeInTheDocument();
  });

  it('clicking idle pill triggers requestSessionStart', () => {
    render(<ListenPill />);
    const btn = screen.getByRole('button', { name: '开始听' });
    fireEvent.click(btn);
    expect(useSessionStore.getState().startSessionVersion).toBe(1);
  });

  it('renders active pill when isSessionActive is true and clicking 结束 triggers requestSessionStop', () => {
    useSessionStore.setState({
      isSessionActive: true,
      sessionStartTime: Date.now() - 5000,
    });

    render(<ListenPill />);
    expect(screen.getByText('正在听')).toBeInTheDocument();
    const stopBtn = screen.getByRole('button', { name: '结束' });
    expect(stopBtn).toBeInTheDocument();

    fireEvent.click(stopBtn);
    expect(useSessionStore.getState().stopSessionVersion).toBe(1);
  });

  it('Cmd+R / Ctrl+R keyboard shortcut toggles session', () => {
    const { rerender } = render(<ListenPill />);
    // Press Cmd+R to start
    fireEvent.keyDown(window, { key: 'r', metaKey: true });
    expect(useSessionStore.getState().startSessionVersion).toBe(1);

    // Active session
    useSessionStore.setState({ isSessionActive: true });
    rerender(<ListenPill />);

    // Press Cmd+R to stop
    fireEvent.keyDown(window, { key: 'r', metaKey: true });
    expect(useSessionStore.getState().stopSessionVersion).toBe(1);
  });

  it('navigates to settings when startGate has a blocker', () => {
    const navigateSpy = vi.fn();
    useSettingsStore.setState({ navigateToSettings: navigateSpy });
    useSessionStore.setState({
      startGate: { canStart: false, reason: 'api-key-invalid' },
    });

    render(<ListenPill />);
    const btn = screen.getByRole('button', { name: '开始听' });
    fireEvent.click(btn);

    // Instead of requesting start, it guides the user to the provider settings
    expect(useSessionStore.getState().startSessionVersion).toBe(0);
    expect(navigateSpy).toHaveBeenCalledWith('provider');
  });
});
