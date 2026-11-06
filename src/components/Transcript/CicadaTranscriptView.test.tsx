// src/components/Transcript/CicadaTranscriptView.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CicadaTranscriptView from './CicadaTranscriptView';
import type { MeetingTranscriptLine } from '../../types/meeting';

describe('CicadaTranscriptView', () => {
  const dummyLines: MeetingTranscriptLine[] = [
    {
      id: 'l1',
      t: 1,
      speaker: 'other',
      speakerName: '对方',
      src: 'All right, Hayley Stevens got the hat.',
      dst: '好的，海莉·史蒂文斯拿到了帽子。',
    },
    {
      id: 'l2',
      t: 3,
      speaker: 'me',
      speakerName: '你',
      src: 'Glad to hear that.',
      dst: '很高兴听到这个。',
    },
  ];

  it('renders transcript lines with timestamps and bilingual texts', () => {
    render(<CicadaTranscriptView lines={dummyLines} isLive={false} viewMode="both" />);

    expect(screen.getByText('00:01')).toBeInTheDocument();
    expect(screen.getByText('All right, Hayley Stevens got the hat.')).toBeInTheDocument();
    expect(screen.getByText('好的，海莉·史蒂文斯拿到了帽子。')).toBeInTheDocument();

    expect(screen.getByText('00:03')).toBeInTheDocument();
    expect(screen.getByText('Glad to hear that.')).toBeInTheDocument();
  });

  it('renders live pin indicator with live speech when session is active', () => {
    render(
      <CicadaTranscriptView
        lines={dummyLines}
        isLive={true}
        liveSource="This is currently being spoken"
        liveTranslation="这是此刻正在说的内容"
      />
    );

    expect(screen.getByText('此刻')).toBeInTheDocument();
    expect(screen.getByText('This is currently being spoken')).toBeInTheDocument();
    expect(screen.getByText('这是此刻正在说的内容')).toBeInTheDocument();
  });
});
