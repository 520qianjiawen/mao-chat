import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ModePicker from './ModePicker';

describe('ModePicker', () => {
  it('renders three segments labeled by i18n keys (fallback to defaults)', () => {
    render(<ModePicker mode="speaker" locked={false} missingDeviceForMode={null} onSegmentClick={() => {}} />);
    expect(screen.getByRole('button', { name: /You|我/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Others|参会者/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Both|双向/ })).toBeInTheDocument();
  });

  it('marks the active segment with aria-pressed', () => {
    render(<ModePicker mode="participant" locked={false} missingDeviceForMode={null} onSegmentClick={() => {}} />);
    const active = screen.getByRole('button', { name: /Others|参会者/ });
    expect(active).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onSegmentClick with the segment key when an inactive segment is clicked', () => {
    const onSegmentClick = vi.fn();
    render(<ModePicker mode="speaker" locked={false} missingDeviceForMode={null} onSegmentClick={onSegmentClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Both|双向/ }));
    expect(onSegmentClick).toHaveBeenCalledWith('both', expect.any(HTMLElement));
  });

  it('calls onSegmentClick with the active segment key when the active segment is re-clicked', () => {
    const onSegmentClick = vi.fn();
    render(<ModePicker mode="both" locked={false} missingDeviceForMode={null} onSegmentClick={onSegmentClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Both|双向/ }));
    expect(onSegmentClick).toHaveBeenCalledWith('both', expect.any(HTMLElement));
  });

  it('does not fire onSegmentClick when locked', () => {
    const onSegmentClick = vi.fn();
    render(<ModePicker mode="speaker" locked={true} missingDeviceForMode={null} onSegmentClick={onSegmentClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Both|双向/ }));
    expect(onSegmentClick).not.toHaveBeenCalled();
  });

  it('adds a warn class on the segment indicated by missingDeviceForMode', () => {
    render(<ModePicker mode="both" locked={false} missingDeviceForMode="speaker" onSegmentClick={() => {}} />);
    const speakerSeg = screen.getByRole('button', { name: /You|我/ });
    expect(speakerSeg.className).toMatch(/warn/);
  });

  it('uses browser capture labels and puts the current tab first', () => {
    render(
      <ModePicker
        mode="participant"
        locked={false}
        missingDeviceForMode={null}
        extensionCaptureLabels
        onSegmentClick={() => {}}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveAccessibleName(/Tab|标签页/);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(buttons[1]).toHaveAccessibleName(/Mic|麦克风/);
    expect(buttons[2]).toHaveAccessibleName(/Both|双向/);
  });
});
