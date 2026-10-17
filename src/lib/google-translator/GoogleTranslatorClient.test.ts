import { describe, it, expect } from 'vitest';
import {
  GoogleTranslatorClient,
  splitForGoogle,
} from './GoogleTranslatorClient';
import { mapToGoogleCode, isSupportedByGoogle } from './languageMap';

describe('mapToGoogleCode', () => {
  it('maps zh family to Google codes', () => {
    expect(mapToGoogleCode('zh')).toBe('zh-CN');
    expect(mapToGoogleCode('zh-CN')).toBe('zh-CN');
    expect(mapToGoogleCode('zh-TW')).toBe('zh-TW');
  });

  it('passes through common ISO codes', () => {
    expect(mapToGoogleCode('en')).toBe('en');
    expect(mapToGoogleCode('ja')).toBe('ja');
  });
});

describe('isSupportedByGoogle', () => {
  it('accepts common languages', () => {
    expect(isSupportedByGoogle('en')).toBe(true);
    expect(isSupportedByGoogle('zh')).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isSupportedByGoogle('xx')).toBe(false);
    expect(isSupportedByGoogle('')).toBe(false);
  });
});

describe('splitForGoogle', () => {
  it('keeps short text as one chunk', () => {
    expect(splitForGoogle('Hello world.')).toEqual(['Hello world.']);
  });

  it('splits oversized text on sentence boundaries', () => {
    const long = `${'word '.repeat(200)}End. ${'more '.repeat(200)}Done.`;
    const chunks = splitForGoogle(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 220)).toBe(true);
  });
});

type FetchCall = { url: string; method: string };

function makeMockFetch() {
  const calls: FetchCall[] = [];
  const queue: Array<Response | Error> = [];
  const mock: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? 'GET' });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    fetch: mock,
    calls,
    queueJson: (data: unknown, status = 200) =>
      queue.push(new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      })),
  };
}

describe('GoogleTranslatorClient', () => {
  it('calls gtx endpoint and joins sentence fragments', async () => {
    const mock = makeMockFetch();
    mock.queueJson({
      sentences: [
        { trans: '你好', orig: 'Hello' },
        { trans: '世界', orig: ' world' },
      ],
      src: 'en',
    });

    const client = new GoogleTranslatorClient({ fetchFn: mock.fetch });
    const result = await client.translate('Hello world', 'en', 'zh');

    expect(result.translatedText).toBe('你好世界');
    expect(result.detectedLanguage?.language).toBe('en');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain('translate.googleapis.com/translate_a/single');
    expect(mock.calls[0].url).toContain('client=gtx');
    expect(mock.calls[0].url).toContain('sl=en');
    expect(mock.calls[0].url).toContain('tl=zh-CN');
    expect(mock.calls[0].url).toContain('q=Hello');
  });

  it('rejects unsupported languages without network', async () => {
    const mock = makeMockFetch();
    const client = new GoogleTranslatorClient({ fetchFn: mock.fetch });
    await expect(client.translate('hi', 'xx', 'en')).rejects.toThrow(/not supported/i);
    expect(mock.calls).toHaveLength(0);
  });

  it('passes automatic source detection to Google', async () => {
    const mock = makeMockFetch();
    mock.queueJson({ sentences: [{ trans: '你好', orig: 'Hello' }], src: 'en' });
    const client = new GoogleTranslatorClient({ fetchFn: mock.fetch });

    const result = await client.translate('Hello', 'auto', 'zh');
    expect(result.translatedText).toBe('你好');
    expect(new URL(mock.calls[0].url).searchParams.get('sl')).toBe('auto');
  });

  it('returns empty for blank input', async () => {
    const mock = makeMockFetch();
    const client = new GoogleTranslatorClient({ fetchFn: mock.fetch });
    const r = await client.translate('  ', 'en', 'zh');
    expect(r.translatedText).toBe('');
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces HTTP failures', async () => {
    const mock = makeMockFetch();
    mock.queueJson({ error: 'nope' }, 429);
    const client = new GoogleTranslatorClient({ fetchFn: mock.fetch });
    await expect(client.translate('hi', 'en', 'zh')).rejects.toThrow(/HTTP 429/);
  });
});
