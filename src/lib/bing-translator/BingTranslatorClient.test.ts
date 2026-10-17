import { describe, it, expect, vi } from 'vitest';
import {
  BingTranslatorClient,
  parseMsTokenExpiryMs,
  parseTranslatorPage,
  unwrapBingTranslatePayload,
} from './BingTranslatorClient';
import {
  VALID_TRANSLATOR_HTML,
  HTML_MISSING_IG,
  HTML_MISSING_IID,
  HTML_MISSING_TOKEN,
  FIXTURE_IG,
  FIXTURE_IID,
  FIXTURE_KEY,
  FIXTURE_TOKEN,
} from './fixtures';

// Build a minimal JWT with a controllable exp (seconds).
function makeJwt(expSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: expSeconds }));
  return `${header}.${payload}.sig`;
}

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function makeMockFetch() {
  const calls: FetchCall[] = [];
  const queue: Array<Response | Error> = [];

  const mock: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    calls.push({ url, method, headers, body });

    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url} — no mock response queued`);
    if (next instanceof Error) throw next;
    return next;
  };

  return {
    fetch: mock,
    calls,
    queueResponse: (r: Response) => queue.push(r),
    queueError: (e: Error) => queue.push(e),
  };
}

function textResponse(body: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseMsTokenExpiryMs', () => {
  it('reads exp from a JWT payload', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(parseMsTokenExpiryMs(makeJwt(exp))).toBe(exp * 1000);
  });

  it('returns 0 for garbage', () => {
    expect(parseMsTokenExpiryMs('not-a-jwt')).toBe(0);
  });
});

describe('parseTranslatorPage (scrape helpers)', () => {
  it('extracts IG, IID, key, token from valid HTML', () => {
    const parsed = parseTranslatorPage(VALID_TRANSLATOR_HTML);
    expect(parsed.ig).toBe(FIXTURE_IG);
    expect(parsed.iid).toBe(FIXTURE_IID);
    expect(parsed.key).toBe(FIXTURE_KEY);
    expect(parsed.token).toBe(FIXTURE_TOKEN);
  });

  it('throws when IG is missing', () => {
    expect(() => parseTranslatorPage(HTML_MISSING_IG)).toThrow(/IG/);
  });

  it('throws when IID is missing', () => {
    expect(() => parseTranslatorPage(HTML_MISSING_IID)).toThrow(/IID/);
  });

  it('throws when AbusePreventionHelper is missing', () => {
    expect(() => parseTranslatorPage(HTML_MISSING_TOKEN)).toThrow(/token/i);
  });
});

describe('unwrapBingTranslatePayload', () => {
  it('accepts flat and nested arrays', () => {
    const flat = [{ translations: [{ text: 'a' }] }];
    const nested = [[{ translations: [{ text: 'b' }] }]];
    expect(unwrapBingTranslatePayload(flat)?.translations?.[0]?.text).toBe('a');
    expect(unwrapBingTranslatePayload(nested)?.translations?.[0]?.text).toBe('b');
  });
});

describe('BingTranslatorClient Edge path', () => {
  it('fetches Edge JWT then translates via cognitive.microsofttranslator.com', async () => {
    const mock = makeMockFetch();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt(exp);
    mock.queueResponse(textResponse(jwt));
    mock.queueResponse(jsonResponse([{
      translations: [{ text: 'こんにちは', to: 'ja' }],
      detectedLanguage: { language: 'en', score: 1 },
    }]));

    const client = new BingTranslatorClient({ fetchFn: mock.fetch, transport: 'edge' });
    const result = await client.translate('Hello', 'en', 'ja');

    expect(result.translatedText).toBe('こんにちは');
    expect(mock.calls[0].url).toBe('https://edge.microsoft.com/translate/auth');
    expect(mock.calls[1].url).toContain('api-edge.cognitive.microsofttranslator.com/translate');
    expect(mock.calls[1].headers['Authorization']).toBe(`Bearer ${jwt}`);
  });

  it('maps zh → zh-Hans on the wire', async () => {
    const mock = makeMockFetch();
    mock.queueResponse(textResponse(makeJwt(Math.floor(Date.now() / 1000) + 3600)));
    mock.queueResponse(jsonResponse([{ translations: [{ text: '你好', to: 'zh-Hans' }] }]));

    const client = new BingTranslatorClient({ fetchFn: mock.fetch, transport: 'edge' });
    await client.translate('Hello', 'en', 'zh');
    expect(mock.calls[1].url).toContain('to=zh-Hans');
  });

  it('omits the Edge source parameter for automatic detection', async () => {
    const mock = makeMockFetch();
    mock.queueResponse(textResponse(makeJwt(Math.floor(Date.now() / 1000) + 3600)));
    mock.queueResponse(jsonResponse([{
      translations: [{ text: '你好', to: 'zh-Hans' }],
      detectedLanguage: { language: 'en', score: 1 },
    }]));

    const client = new BingTranslatorClient({ fetchFn: mock.fetch, transport: 'edge' });
    await client.translate('Hello', 'auto', 'zh');
    const url = new URL(mock.calls[1].url);
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.get('to')).toBe('zh-Hans');
  });
});

describe('BingTranslatorClient scrape path (current production)', () => {
  it('scrapes translator HTML then posts ttranslatev3', async () => {
    const mock = makeMockFetch();
    mock.queueResponse(textResponse(VALID_TRANSLATOR_HTML, 200, 'text/html'));
    mock.queueResponse(jsonResponse([{
      translations: [{ text: '你好，世界', to: 'zh-Hans' }],
      usedLLM: true,
      detectedLanguage: { language: 'en', score: 1 },
    }]));

    const client = new BingTranslatorClient({
      fetchFn: mock.fetch,
      transport: 'scrape',
      scrapeHosts: ['https://www.bing.com'],
    });
    const result = await client.translate('Hello world', 'en', 'zh');

    expect(result.translatedText).toBe('你好，世界');
    expect(result.usedLLM).toBe(true);
    expect(mock.calls[0].url).toBe('https://www.bing.com/translator');
    expect(mock.calls[1].url).toContain('https://www.bing.com/ttranslatev3');
    expect(mock.calls[1].url).toContain(`IG=${FIXTURE_IG}`);
    expect(mock.calls[1].body).toContain('text=Hello');
    expect(mock.calls[1].body).toContain(`token=${encodeURIComponent(FIXTURE_TOKEN)}`);
    expect(mock.calls[1].body).toContain('to=zh-Hans');
  });

  it('auto transport uses scrape first (Edge JWT is currently down)', async () => {
    const mock = makeMockFetch();
    mock.queueResponse(textResponse(VALID_TRANSLATOR_HTML, 200, 'text/html'));
    mock.queueResponse(jsonResponse([{ translations: [{ text: 'ok', to: 'ja' }] }]));

    const client = new BingTranslatorClient({
      fetchFn: mock.fetch,
      transport: 'auto',
      scrapeHosts: ['https://www.bing.com'],
    });
    const result = await client.translate('hi', 'en', 'ja');
    expect(result.translatedText).toBe('ok');
    expect(mock.calls[0].url).toContain('/translator');
    expect(mock.calls[1].url).toContain('/ttranslatev3');
    expect(mock.calls.some((c) => c.url.includes('edge.microsoft.com'))).toBe(false);
  });

  it('uses Bing auto-detect on the scrape transport', async () => {
    const mock = makeMockFetch();
    mock.queueResponse(textResponse(VALID_TRANSLATOR_HTML, 200, 'text/html'));
    mock.queueResponse(jsonResponse([{
      translations: [{ text: '你好', to: 'zh-Hans' }],
      detectedLanguage: { language: 'en', score: 1 },
    }]));

    const client = new BingTranslatorClient({
      fetchFn: mock.fetch,
      transport: 'scrape',
      scrapeHosts: ['https://www.bing.com'],
    });
    await client.translate('Hello', 'auto', 'zh');
    expect(mock.calls[1].body).toContain('fromLang=auto-detect');
  });

  it('auto transport falls back to Edge when scrape fails', async () => {
    const mock = makeMockFetch();
    // Both scrape hosts fail page fetch
    mock.queueResponse(textResponse('', 503));
    mock.queueResponse(textResponse('', 503));
    // Edge still works in this scenario
    mock.queueResponse(textResponse(makeJwt(Math.floor(Date.now() / 1000) + 3600)));
    mock.queueResponse(jsonResponse([{ translations: [{ text: 'edge-ok', to: 'ja' }] }]));

    const client = new BingTranslatorClient({
      fetchFn: mock.fetch,
      transport: 'auto',
      scrapeHosts: ['https://www.bing.com', 'https://cn.bing.com'],
    });
    const result = await client.translate('hi', 'en', 'ja');
    expect(result.translatedText).toBe('edge-ok');
    expect(mock.calls.some((c) => c.url.includes('edge.microsoft.com/translate/auth'))).toBe(true);
  });

  it('tries the next scrape host when the first page fails', async () => {
    const mock = makeMockFetch();
    mock.queueResponse(textResponse('nope', 503, 'text/html'));
    mock.queueResponse(textResponse(VALID_TRANSLATOR_HTML, 200, 'text/html'));
    mock.queueResponse(jsonResponse([{ translations: [{ text: 'done', to: 'ja' }] }]));

    const client = new BingTranslatorClient({
      fetchFn: mock.fetch,
      transport: 'scrape',
      scrapeHosts: ['https://www.bing.com', 'https://cn.bing.com'],
    });
    const result = await client.translate('hi', 'en', 'ja');
    expect(result.translatedText).toBe('done');
    expect(mock.calls[0].url).toBe('https://www.bing.com/translator');
    expect(mock.calls[1].url).toBe('https://cn.bing.com/translator');
    expect(mock.calls[2].url).toContain('https://cn.bing.com/ttranslatev3');
  });

  it('rejects unsupported languages before any network call', async () => {
    const mock = makeMockFetch();
    const client = new BingTranslatorClient({ fetchFn: mock.fetch });
    await expect(client.translate('hi', 'xx', 'en')).rejects.toThrow(/not supported/i);
    expect(mock.calls).toHaveLength(0);
  });

  it('returns empty string for blank input without network', async () => {
    const mock = makeMockFetch();
    const client = new BingTranslatorClient({ fetchFn: mock.fetch });
    const result = await client.translate('   ', 'en', 'zh');
    expect(result.translatedText).toBe('');
    expect(mock.calls).toHaveLength(0);
  });
});
