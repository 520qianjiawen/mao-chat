import { describe, it, expect } from 'vitest';
import {
  DeepLTranslatorClient,
  isDeepLFreeAuthKey,
  resolveDeepLBaseUrl,
  splitForDeepL,
} from './DeepLTranslatorClient';
import {
  isSupportedByDeepL,
  mapToDeepLSourceCode,
  mapToDeepLTargetCode,
} from './languageMap';

describe('DeepL key / endpoint', () => {
  it('detects free keys ending with :fx', () => {
    expect(isDeepLFreeAuthKey('abc:fx')).toBe(true);
    expect(isDeepLFreeAuthKey('abc:FX')).toBe(false); // suffix is case-sensitive per DeepL
    expect(isDeepLFreeAuthKey('pro-key-without-suffix')).toBe(false);
  });

  it('routes free keys to api-free and pro to api.deepl.com', () => {
    expect(resolveDeepLBaseUrl('k:fx')).toBe('https://api-free.deepl.com');
    expect(resolveDeepLBaseUrl('pro-key')).toBe('https://api.deepl.com');
  });
});

describe('language map', () => {
  it('maps Chinese family to DeepL source/target codes', () => {
    expect(mapToDeepLSourceCode('zh')).toBe('ZH');
    expect(mapToDeepLTargetCode('zh')).toBe('ZH-HANS');
    expect(mapToDeepLTargetCode('zh-TW')).toBe('ZH-HANT');
  });

  it('maps English/Portuguese regional targets', () => {
    expect(mapToDeepLTargetCode('en')).toBe('EN-US');
    expect(mapToDeepLTargetCode('en-GB')).toBe('EN-GB');
    expect(mapToDeepLTargetCode('pt-BR')).toBe('PT-BR');
  });

  it('accepts common languages and rejects unknown', () => {
    expect(isSupportedByDeepL('ja')).toBe(true);
    expect(isSupportedByDeepL('de')).toBe(true);
    expect(isSupportedByDeepL('xx')).toBe(false);
  });
});

describe('splitForDeepL', () => {
  it('keeps short text as one chunk', () => {
    expect(splitForDeepL('Hello world.')).toEqual(['Hello world.']);
  });

  it('splits oversized text', () => {
    const long = `${'word '.repeat(200)}End. ${'more '.repeat(200)}Done.`;
    const chunks = splitForDeepL(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

type FetchCall = { url: string; method: string; body?: string };

function makeMockFetch() {
  const calls: FetchCall[] = [];
  const queue: Array<Response | Error> = [];
  const mock: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
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

describe('DeepLTranslatorClient', () => {
  it('requires an API key', () => {
    expect(() => new DeepLTranslatorClient({ apiKey: '' })).toThrow(/API key/i);
  });

  it('posts to free endpoint and returns translation', async () => {
    const mock = makeMockFetch();
    mock.queueJson({
      translations: [{ text: 'Hallo Welt', detected_source_language: 'EN' }],
    });
    const client = new DeepLTranslatorClient({
      apiKey: 'test:fx',
      fetchFn: mock.fetch,
      baseUrl: 'https://api-free.deepl.com',
    });
    const result = await client.translate('Hello world', 'en', 'de');
    expect(result.translatedText).toBe('Hallo Welt');
    expect(result.detectedLanguage?.language).toBe('en');
    expect(mock.calls[0].url).toBe('https://api-free.deepl.com/v2/translate');
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].body).toContain('"target_lang":"DE"');
    expect(mock.calls[0].body).toContain('"source_lang":"EN"');
  });

  it('rejects unsupported languages without network', async () => {
    const mock = makeMockFetch();
    const client = new DeepLTranslatorClient({ apiKey: 'k:fx', fetchFn: mock.fetch });
    await expect(client.translate('hi', 'xx', 'en')).rejects.toThrow(/not supported/i);
    expect(mock.calls).toHaveLength(0);
  });

  it('omits source_lang so DeepL can detect the source automatically', async () => {
    const mock = makeMockFetch();
    mock.queueJson({
      translations: [{ text: 'Hallo Welt', detected_source_language: 'EN' }],
    });
    const client = new DeepLTranslatorClient({
      apiKey: 'test:fx',
      fetchFn: mock.fetch,
      baseUrl: 'https://api-free.deepl.com',
    });

    const result = await client.translate('Hello world', 'auto', 'de');
    expect(result.detectedLanguage?.language).toBe('en');
    expect(mock.calls[0].body).not.toContain('source_lang');
    expect(mock.calls[0].body).toContain('"target_lang":"DE"');
  });

  it('maps auth failures', async () => {
    const mock = makeMockFetch();
    mock.queueJson({ message: 'Wrong auth' }, 403);
    const client = new DeepLTranslatorClient({ apiKey: 'bad:fx', fetchFn: mock.fetch });
    await expect(client.translate('hi', 'en', 'de')).rejects.toThrow(/invalid DeepL API key/i);
  });

  it('validateAuthKey hits /v2/usage', async () => {
    const mock = makeMockFetch();
    mock.queueJson({ character_count: 10, character_limit: 500000 });
    const client = new DeepLTranslatorClient({
      apiKey: 'k:fx',
      fetchFn: mock.fetch,
      baseUrl: 'https://api-free.deepl.com',
    });
    const usage = await client.validateAuthKey();
    expect(usage.characterCount).toBe(10);
    expect(mock.calls[0].url).toContain('/v2/usage');
  });
});
