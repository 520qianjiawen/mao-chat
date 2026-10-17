// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NativeAsrClient } from './NativeAsrClient';
import { FakeSidecarConnection } from './SidecarConnection.fake';

describe('NativeAsrClient', () => {
  it('init() sends asr_init with device override and returns device + rtf', async () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const p = c.init('en', 'granite-speech-4.1-2b', 24000, undefined, 'cuda');
    const sent = conn.sent[0];
    expect(sent).toMatchObject({ type: 'asr_init', language: 'en', model: 'granite-speech-4.1-2b', device: 'cuda' });
    conn.emit({ type: 'ready', id: sent.id, loadTimeMs: 2, device: 'cuda', rtf: 0.5 });
    await expect(p).resolves.toMatchObject({ loadTimeMs: 2, device: 'cuda', rtf: 0.5 });
  });

  it('init() forwards live-caption max speech so batch ASR is not a 6s recorder', async () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const p = c.init('ja', 'qwen3-asr-1.7b', 24000, {
      threshold: 0.28, minSilence: 0.45, minSpeech: 0.12, maxSpeech: 1.0,
    });
    expect(conn.sent[0]).toMatchObject({
      type: 'asr_init',
      vadThreshold: 0.28,
      vadMinSilenceDuration: 0.45,
      vadMinSpeechDuration: 0.12,
      vadMaxSpeechDuration: 1.0,
    });
    conn.emit({ type: 'ready', id: conn.sent[0].id, loadTimeMs: 1 });
    await p;
  });

  it('initializes and updates Hayamimi refinement mode without restarting ASR', async () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const init = c.init('auto', 'hayamimi-asr', 24000, undefined, undefined, undefined, false);
    expect(conn.sent[0]).toMatchObject({
      type: 'asr_init', model: 'hayamimi-asr', refinementEnabled: false,
    });
    conn.emit({ type: 'ready', id: conn.sent[0].id, loadTimeMs: 1 });
    await init;

    const update = c.setRefinementEnabled(true);
    expect(conn.sent[1]).toMatchObject({ type: 'asr_set_refinement', enabled: true });
    conn.emit({ type: 'ok', id: conn.sent[1].id });
    await expect(update).resolves.toBeUndefined();
  });

  it('feedAudio() sends the sample view as a binary frame (subarray boundaries preserved)', async () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const samples = new Int16Array(24000);
    c.feedAudio(samples, 24000);
    expect(conn.binarySent).toHaveLength(1);
    expect(conn.binarySent[0]).toBe(samples);
  });

  it('feedAudio() forwards a subarray view without over-sending the backing buffer', async () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const backing = new Int16Array(24000);
    const view = backing.subarray(100, 200);   // byteOffset 200, length 100
    c.feedAudio(view, 24000);
    const sent = conn.binarySent[0] as Int16Array;
    expect(sent.byteOffset).toBe(200);
    expect(sent.length).toBe(100);
  });

  it('routes id-less push messages to their callbacks', () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const partials: string[] = []; const finals: string[] = []; const languages: string[] = []; let starts = 0;
    c.onPartialResult = (t, language) => { partials.push(t); if (language) languages.push(language); };
    c.onResult = (r) => { finals.push(r.text); if (r.language) languages.push(r.language); };
    c.onSpeechStart = () => { starts++; };
    conn.emit({ type: 'speech_start' });
    conn.emit({ type: 'partial', text: 'he llo', language: 'en' });
    conn.emit({ type: 'result', text: 'hello world', language: 'en', durationMs: 1000, recognitionTimeMs: 50 });
    expect(starts).toBe(1);
    expect(partials).toEqual(['he llo']);
    expect(finals).toEqual(['hello world']);
    expect(languages).toEqual(['en', 'en']);
  });

  it('routes Hayamimi segment ids and second-pass refine groups', () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const finals: any[] = []; const refinements: any[] = [];
    c.onResult = (result) => finals.push(result);
    c.onRefine = (result) => refinements.push(result);

    conn.emit({
      type: 'result', text: 'fast one', language: 'en', segmentId: 7,
      startSample: 16000, durationMs: 1000, recognitionTimeMs: 20,
    });
    conn.emit({
      type: 'refine', text: 'refined sentence', language: 'en', segmentIds: [7, 8],
      startSample: 0, durationMs: 3000, recognitionTimeMs: 100,
    });

    expect(finals[0]).toMatchObject({ text: 'fast one', segmentId: 7 });
    expect(refinements[0]).toMatchObject({
      text: 'refined sentence', segmentIds: [7, 8], startSample: 0,
    });
  });

  it('fires onError for an id-less feeder error but not for a late id-carrying one', () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const errs: string[] = [];
    c.onError = (e) => errs.push(e);
    conn.emit({ type: 'error', message: 'feeder failed' });          // id-less push
    conn.emit({ type: 'error', id: 999, message: 'late init reply' }); // late reply to a timed-out request
    expect(errs).toEqual(['feeder failed']);
  });

  it('flush() resolves on the ok reply and rejects on an error reply', async () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const okP = c.flush();
    conn.emit({ type: 'ok', id: conn.sent[0].id });
    await expect(okP).resolves.toBeUndefined();
    const errP = c.flush();
    conn.emit({ type: 'error', id: conn.sent[1].id, message: 'flush-boom' });
    await expect(errP).rejects.toThrow('flush-boom');
  });

  it('dispose() rejects a pending flush', async () => {
    const conn = new FakeSidecarConnection();
    const c = new NativeAsrClient(conn);
    const p = c.flush();
    c.dispose();
    await expect(p).rejects.toThrow('native host disconnected');
  });
});
