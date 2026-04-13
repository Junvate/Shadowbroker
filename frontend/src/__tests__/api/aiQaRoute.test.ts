import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as proxyPost } from '@/app/api/[...path]/route';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

describe('/api/ai/qa route', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn<typeof process, 'cwd'>> | null = null;
  const originalEnv = {
    AI_QA_BASE_URL: process.env.AI_QA_BASE_URL,
    AI_QA_MODEL: process.env.AI_QA_MODEL,
    AI_QA_API_KEY: process.env.AI_QA_API_KEY,
    AI_QA_TIMEOUT_MS: process.env.AI_QA_TIMEOUT_MS,
    BACKEND_URL: process.env.BACKEND_URL,
    AI_QA_FLIGHT_MATCH_TIMEOUT_MS: process.env.AI_QA_FLIGHT_MATCH_TIMEOUT_MS,
  };

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/data/aYJC/Shadowbroker/frontend');
    process.env.AI_QA_BASE_URL = 'http://llm.test';
    process.env.AI_QA_MODEL = '';
    process.env.AI_QA_API_KEY = '';
    process.env.AI_QA_TIMEOUT_MS = '3000';
    process.env.BACKEND_URL = 'http://127.0.0.1:8000';
    process.env.AI_QA_FLIGHT_MATCH_TIMEOUT_MS = '750';
  });

  afterEach(() => {
    process.env.AI_QA_BASE_URL = originalEnv.AI_QA_BASE_URL;
    process.env.AI_QA_MODEL = originalEnv.AI_QA_MODEL;
    process.env.AI_QA_API_KEY = originalEnv.AI_QA_API_KEY;
    process.env.AI_QA_TIMEOUT_MS = originalEnv.AI_QA_TIMEOUT_MS;
    process.env.BACKEND_URL = originalEnv.BACKEND_URL;
    process.env.AI_QA_FLIGHT_MATCH_TIMEOUT_MS = originalEnv.AI_QA_FLIGHT_MATCH_TIMEOUT_MS;
    cwdSpy?.mockRestore();
    cwdSpy = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('forwards requests to the nanobot chat completions endpoint with session isolation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === 'http://llm.test/v1/chat/completions') {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '已收到请求' } }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url === 'http://127.0.0.1:8000/api/live-data/fast') {
        return new Response(
          JSON.stringify({
            commercial_flights: [],
            private_flights: [],
            private_jets: [],
            tracked_flights: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = new NextRequest('http://localhost/api/ai/qa', {
      method: 'POST',
      body: JSON.stringify({
        message: '给我东京方向的实时航班',
        history: [
          { role: 'user', content: '上一条用户消息' },
          { role: 'assistant', content: '上一条助手回复' },
        ],
        agent_id: 'mesh-analyst',
        session_id: 'my-session',
        agent: {
          id: 'mesh-analyst',
          systemPrompt: '请只用中文输出行动建议。',
        },
        options: {
          temperature: 99,
          maxTokens: 999999,
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await proxyPost(req, { params: Promise.resolve({ path: ['ai', 'qa'] }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(body.agent_id).toBe('mesh-analyst');
    expect(typeof body.trace_id).toBe('string');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some((call) => requestUrl(call[0] as RequestInfo | URL) === 'http://llm.test/v1/chat/completions')).toBe(true);

    const llmCall = fetchMock.mock.calls.find((call) => requestUrl(call[0] as RequestInfo | URL) === 'http://llm.test/v1/chat/completions');
    const requestInit = llmCall?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBeNull();

    const payload = JSON.parse(String(requestInit.body));
    expect(payload.model).toBeUndefined();
    expect(payload.session_id).toBe('my-session');
    expect(payload.messages).toEqual([{
      role: 'user',
      content: '给我东京方向的实时航班',
    }]);
  });

  it('rejects empty user messages before calling the upstream model', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = new NextRequest('http://localhost/api/ai/qa', {
      method: 'POST',
      body: JSON.stringify({ message: '   ' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await proxyPost(req, { params: Promise.resolve({ path: ['ai', 'qa'] }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('缺少用户消息内容');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps upstream failures to a 502 response and preserves the upstream detail', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: 'upstream model overloaded' },
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = new NextRequest('http://localhost/api/ai/qa', {
      method: 'POST',
      body: JSON.stringify({
        message: '测试上游报错',
        agent: { id: 'sentinel-ops', systemPrompt: '请简洁回答。' },
        options: {},
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await proxyPost(req, { params: Promise.resolve({ path: ['ai', 'qa'] }) });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(body.error).toBe('上游 AI 请求失败');
    expect(body.detail).toBe('upstream model overloaded');
  });

  it('falls back to normal chat completion when execute mode does not match any local skill', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '普通对话回退成功' } }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = new NextRequest('http://localhost/api/ai/qa', {
      method: 'POST',
      body: JSON.stringify({
        message: 'nihao',
        session_id: 'fallback-session',
        options: {
          executeMode: true,
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await proxyPost(req, { params: Promise.resolve({ path: ['ai', 'qa'] }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.execute_mode).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload.session_id).toBe('fallback-session');
    expect(payload.messages).toEqual([
      { role: 'user', content: 'nihao' },
    ]);
  });

  it('falls back to local flight skill when the nanobot upstream is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const req = new NextRequest('http://localhost/api/ai/qa', {
      method: 'POST',
      body: JSON.stringify({
        message: '调查一下去日本的飞机',
        session_id: 'nanobot-down-fallback',
        options: {
          includeHistory: true,
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await proxyPost(req, { params: Promise.resolve({ path: ['ai', 'qa'] }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.execute_mode).toBe(true);
    expect(body.text).toContain('上游 nanobot 当前不可用');
    expect(body.text).toContain('【航班查询】');
  });

  it('attaches structured flight matches for recognized flight queries', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === 'http://llm.test/v1/chat/completions') {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '已找到东京方向航班' } }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url === 'http://127.0.0.1:8000/api/live-data/fast') {
        return new Response(
          JSON.stringify({
            commercial_flights: [
              {
                callsign: 'ANA123',
                icao24: 'abc123',
                lat: 35.68,
                lng: 139.76,
                alt: 34000,
                speed_knots: 460,
                origin_name: 'LAX: Los Angeles',
                dest_name: 'NRT: Tokyo Narita',
              },
            ],
            private_flights: [],
            private_jets: [],
            tracked_flights: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = new NextRequest('http://localhost/api/ai/qa', {
      method: 'POST',
      body: JSON.stringify({
        message: '查询飞往东京的航班',
        session_id: 'flight-highlight-success',
        options: {},
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await proxyPost(req, { params: Promise.resolve({ path: ['ai', 'qa'] }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.flight_query).toBe(true);
    expect(Array.isArray(body.flight_matches)).toBe(true);
    expect(body.flight_matches).toEqual([
      {
        id: 'commercial_flights:abc123',
        callsign: 'ANA123',
        icao24: 'abc123',
        lat: 35.68,
        lng: 139.76,
        source_bucket: 'commercial_flights',
        match_reasons: ['dest_keyword'],
      },
    ]);
    expect(body.choices?.[0]?.message?.content).toBe('已找到东京方向航班');
  });
});
