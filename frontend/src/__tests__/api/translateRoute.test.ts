import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type TranslateRouteModule = typeof import('@/app/api/translate/route');

async function loadRoute(): Promise<TranslateRouteModule> {
  vi.resetModules();
  return import('@/app/api/translate/route');
}

describe('/api/translate route', () => {
  const originalEnv = {
    TRANSLATE_PROVIDER: process.env.TRANSLATE_PROVIDER,
    LOCAL_TRANSLATE_API_URL: process.env.LOCAL_TRANSLATE_API_URL,
    LOCAL_TRANSLATE_API_KEY: process.env.LOCAL_TRANSLATE_API_KEY,
    LOCAL_TRANSLATE_MODEL: process.env.LOCAL_TRANSLATE_MODEL,
    LOCAL_TRANSLATE_TIMEOUT_MS: process.env.LOCAL_TRANSLATE_TIMEOUT_MS,
    LOCAL_TRANSLATE_MAX_BATCH_SIZE: process.env.LOCAL_TRANSLATE_MAX_BATCH_SIZE,
    DEEPL_API_KEY: process.env.DEEPL_API_KEY,
    NIUTRANS_API_KEY: process.env.NIUTRANS_API_KEY,
    NIUTRANS_APP_KEY: process.env.NIUTRANS_APP_KEY,
    TRANSLATE_API_KEY: process.env.TRANSLATE_API_KEY,
  };

  beforeEach(() => {
    process.env.TRANSLATE_PROVIDER = 'local';
    process.env.LOCAL_TRANSLATE_API_URL = 'http://llm.test/v1/chat/completions';
    process.env.LOCAL_TRANSLATE_API_KEY = 'EMPTY';
    process.env.LOCAL_TRANSLATE_MODEL = 'local-model';
    process.env.LOCAL_TRANSLATE_TIMEOUT_MS = '3000';
    process.env.LOCAL_TRANSLATE_MAX_BATCH_SIZE = '8';
    process.env.DEEPL_API_KEY = '';
    process.env.NIUTRANS_API_KEY = '';
    process.env.NIUTRANS_APP_KEY = '';
    process.env.TRANSLATE_API_KEY = '';
  });

  afterEach(() => {
    process.env.TRANSLATE_PROVIDER = originalEnv.TRANSLATE_PROVIDER;
    process.env.LOCAL_TRANSLATE_API_URL = originalEnv.LOCAL_TRANSLATE_API_URL;
    process.env.LOCAL_TRANSLATE_API_KEY = originalEnv.LOCAL_TRANSLATE_API_KEY;
    process.env.LOCAL_TRANSLATE_MODEL = originalEnv.LOCAL_TRANSLATE_MODEL;
    process.env.LOCAL_TRANSLATE_TIMEOUT_MS = originalEnv.LOCAL_TRANSLATE_TIMEOUT_MS;
    process.env.LOCAL_TRANSLATE_MAX_BATCH_SIZE = originalEnv.LOCAL_TRANSLATE_MAX_BATCH_SIZE;
    process.env.DEEPL_API_KEY = originalEnv.DEEPL_API_KEY;
    process.env.NIUTRANS_API_KEY = originalEnv.NIUTRANS_API_KEY;
    process.env.NIUTRANS_APP_KEY = originalEnv.NIUTRANS_APP_KEY;
    process.env.TRANSLATE_API_KEY = originalEnv.TRANSLATE_API_KEY;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('falls through to the next provider when local model output is unusable', async () => {
    process.env.DEEPL_API_KEY = 'deepl-key';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'http://llm.test/v1/chat/completions') {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'not-json-at-all' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === 'https://api-free.deepl.com/v2/translate') {
        const params = new URLSearchParams(String(init?.body || ''));
        const texts = params.getAll('text');
        return new Response(
          JSON.stringify({
            translations: texts.map((text) => ({ text: `中:${text}` })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await loadRoute();
    const req = new NextRequest('http://localhost/api/translate', {
      method: 'POST',
      body: JSON.stringify({
        targetLang: 'ZH-HANS',
        texts: ['Fallback provider check'],
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.translations).toEqual(['中:Fallback provider check']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves response ordering when oversized strings are skipped for translation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== 'http://llm.test/v1/chat/completions') {
        throw new Error(`unexpected url: ${url}`);
      }
      const payload = JSON.parse(String(init?.body || '{}'));
      const texts = JSON.parse(String(payload.messages?.[1]?.content || '[]')) as string[];
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(texts.map((text) => `译:${text}`)) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const oversized = `oversized-${'x'.repeat(330)}`;
    const { POST } = await loadRoute();
    const req = new NextRequest('http://localhost/api/translate', {
      method: 'POST',
      body: JSON.stringify({
        targetLang: 'ZH-HANS',
        texts: ['Short alpha', oversized, 'Short beta'],
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.translations).toEqual(['译:Short alpha', oversized, '译:Short beta']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body || '{}'));
    expect(JSON.parse(String(payload.messages?.[1]?.content || '[]'))).toEqual(['Short alpha', 'Short beta']);
  });

  it('isolates server translation cache entries by target language', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      const targetPrompt = String(payload.messages?.[0]?.content || '');
      if (targetPrompt.includes('Simplified Chinese')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '["缓存隔离"]' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '["cache isolated"]' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await loadRoute();
    const zhReq = new NextRequest('http://localhost/api/translate', {
      method: 'POST',
      body: JSON.stringify({
        targetLang: 'ZH-HANS',
        texts: ['Cache key isolation probe'],
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const zhRes = await POST(zhReq);
    const zhBody = await zhRes.json();

    const enReq = new NextRequest('http://localhost/api/translate', {
      method: 'POST',
      body: JSON.stringify({
        targetLang: 'EN',
        texts: ['缓存隔离探针'],
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const enRes = await POST(enReq);
    const enBody = await enRes.json();

    expect(zhBody.translations).toEqual(['缓存隔离']);
    expect(enBody.translations).toEqual(['cache isolated']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
