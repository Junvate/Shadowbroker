import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST as proxyPost } from '@/app/api/[...path]/route';

describe('/api/ai/qa route', () => {
  const originalEnv = {
    AI_QA_BASE_URL: process.env.AI_QA_BASE_URL,
    AI_QA_MODEL: process.env.AI_QA_MODEL,
    AI_QA_API_KEY: process.env.AI_QA_API_KEY,
    AI_QA_TIMEOUT_MS: process.env.AI_QA_TIMEOUT_MS,
  };

  beforeEach(() => {
    process.env.AI_QA_BASE_URL = 'http://llm.test';
    process.env.AI_QA_MODEL = 'qwen-test';
    process.env.AI_QA_API_KEY = 'test-key';
    process.env.AI_QA_TIMEOUT_MS = '3000';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.AI_QA_BASE_URL = originalEnv.AI_QA_BASE_URL;
    process.env.AI_QA_MODEL = originalEnv.AI_QA_MODEL;
    process.env.AI_QA_API_KEY = originalEnv.AI_QA_API_KEY;
    process.env.AI_QA_TIMEOUT_MS = originalEnv.AI_QA_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it('forwards requests to the upstream chat completions endpoint with local skill context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '已收到请求' } }],
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
        message: '给我东京方向的实时航班',
        history: [
          { role: 'user', content: '上一条用户消息' },
          { role: 'assistant', content: '上一条助手回复' },
        ],
        agent_id: 'mesh-analyst',
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://llm.test/v1/chat/completions');

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer test-key');

    const payload = JSON.parse(String(requestInit.body));
    expect(payload.model).toBe('qwen-test');
    expect(payload.temperature).toBe(2);
    expect(payload.max_tokens).toBe(20000);
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(payload.messages[0]?.role).toBe('system');
    expect(payload.messages[0]?.content).toContain('请只用中文输出行动建议。');
    expect(payload.messages[0]?.content).toContain('$shadowbroker-osint-query');
    expect(payload.messages[0]?.content).toContain('$shadowbroker-flight-query');
    expect(payload.messages[0]?.content).toContain('快速查询 Shadowbroker API 与后端数据文件');
    expect(payload.messages[payload.messages.length - 1]).toEqual({
      role: 'user',
      content: '给我东京方向的实时航班',
    });
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
});
