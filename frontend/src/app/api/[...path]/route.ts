/**
 * Catch-all proxy route — forwards /api/* requests from the browser to the
 * backend server. BACKEND_URL is a plain server-side env var (not NEXT_PUBLIC_),
 * so it is read at request time from the runtime environment, never baked into
 * the client bundle or the build manifest.
 *
 * Set BACKEND_URL in docker-compose `environment:` (e.g. http://backend:8000)
 * to use Docker internal networking. Defaults to http://127.0.0.1:8000 for
 * local development where both services run on the same host.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { resolveAdminSessionToken } from '@/lib/server/adminSessionStore';

// Headers that must not be forwarded to the backend.
const STRIP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'x-admin-key',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

// Headers that must not be forwarded back to the browser.
// content-encoding and content-length are stripped because Node.js fetch()
// automatically decompresses gzip/br responses — forwarding these headers
// would cause ERR_CONTENT_DECODING_FAILED in the browser.
const STRIP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

const ADMIN_COOKIE = 'sb_admin_session';
const NO_STORE_PROXY_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
};
const AI_QA_PATH = 'ai/qa';
const AI_QA_DEFAULT_BASE_URL = 'http://10.24.116.25:8888';
const AI_QA_DEFAULT_MODEL = '/data/dify/Qwen3.5-35B-A3B';
const AI_QA_DEFAULT_KEY = 'EMPTY';
const AI_QA_DEFAULT_TIMEOUT_MS = 120000;
const AI_QA_MAX_HISTORY_MESSAGES = 12;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function parseSkillFrontmatter(raw: string): { name: string; description: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { name: '', description: '' };
  const lines = match[1]?.split('\n') || [];
  const values: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) values[key] = value;
  }
  return {
    name: values.name || '',
    description: values.description || '',
  };
}

function extractPrimarySkillCommand(raw: string): string {
  const block = raw.match(/```bash\s*\n([\s\S]*?)```/);
  if (!block?.[1]) return '';
  const lines = block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (lines.length === 0) return '';
  return lines.slice(0, 2).join(' ');
}

function extractSkillSnippet(raw: string): string {
  const body = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
  return body.replace(/`/g, '').replace(/\s+/g, ' ').trim().slice(0, 900);
}

let skillContextCache: { value: string; expiresAt: number } | null = null;

function loadSkillContext(repoRoot: string): string {
  const now = Date.now();
  if (skillContextCache && skillContextCache.expiresAt > now) {
    return skillContextCache.value;
  }
  const skillsDir = path.join(repoRoot, 'skills');
  if (!fs.existsSync(skillsDir)) {
    const fallback = 'No local skills directory found.';
    skillContextCache = { value: fallback, expiresAt: now + 30_000 };
    return fallback;
  }

  const summaries: string[] = [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    try {
      const raw = fs.readFileSync(skillPath, 'utf8');
      const frontmatter = parseSkillFrontmatter(raw);
      const name = frontmatter.name || entry.name;
      const description = frontmatter.description || 'No description.';
      const command = extractPrimarySkillCommand(raw);
      const snippet = extractSkillSnippet(raw);
      const commandPart = command ? ` Primary command: ${command}` : '';
      const snippetPart = snippet ? ` Workflow snippet: ${snippet}` : '';
      summaries.push(`- $${name}: ${description}${commandPart}${snippetPart}`);
    } catch {
      summaries.push(`- $${entry.name}: unreadable skill file.`);
    }
  }

  const value = summaries.length > 0
    ? summaries.join('\n')
    : 'No skills discovered in local skills directory.';
  skillContextCache = { value, expiresAt: now + 30_000 };
  return value;
}

function extractAiUpstreamError(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const detail = asString(payload.detail).trim();
  if (detail) return detail;
  const message = asString(payload.message).trim();
  if (message) return message;
  const error = payload.error;
  if (isRecord(error)) {
    const errorMessage = asString(error.message).trim();
    if (errorMessage) return errorMessage;
  }
  return fallback;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { text: raw };
  }
}

function buildAiQaMessages(body: UnknownRecord, repoRoot: string): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const userInput = asString(body.message).trim();
  const agent = isRecord(body.agent) ? body.agent : {};
  const agentPrompt = asString(agent.systemPrompt).trim() || 'You are a helpful assistant.';

  let metadataSummary = '';
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  if (Object.keys(metadata).length > 0) {
    try {
      metadataSummary = `\n\nRuntime context (JSON): ${JSON.stringify(metadata).slice(0, 5000)}`;
    } catch {
      metadataSummary = '\n\nRuntime context (JSON): [unserializable metadata]';
    }
  }

  const systemPrompt = [
    agentPrompt,
    '',
    'Available local skills from this repository:',
    loadSkillContext(repoRoot),
    '',
    'When relevant, select one or more skills explicitly and align your answer with their workflows.',
    metadataSummary,
  ].join('\n');

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  const historyRaw = Array.isArray(body.history) ? body.history : [];
  const history = historyRaw.slice(-AI_QA_MAX_HISTORY_MESSAGES);
  for (const item of history) {
    if (!isRecord(item)) continue;
    const role = asString(item.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const content = asString(item.content).trim();
    if (!content) continue;
    messages.push({ role, content });
  }
  if (userInput) {
    messages.push({ role: 'user', content: userInput });
  }
  return messages;
}

async function handleAiQa(req: NextRequest): Promise<NextResponse> {
  if (req.method !== 'POST') {
    return NextResponse.json(
      { error: '仅支持 POST 请求' },
      { status: 405, headers: NO_STORE_PROXY_HEADERS },
    );
  }
  const body = (await req.json().catch(() => ({}))) as UnknownRecord;
  const message = asString(body.message).trim();
  if (!message) {
    return NextResponse.json(
      { error: '缺少用户消息内容' },
      { status: 400, headers: NO_STORE_PROXY_HEADERS },
    );
  }

  const options = isRecord(body.options) ? body.options : {};
  const model = String(process.env.AI_QA_MODEL || AI_QA_DEFAULT_MODEL).trim();
  const temperature = clampNumber(options.temperature, 0, 2, 0.7);
  const maxTokens = clampInteger(options.maxTokens, 64, 20000, 2000);
  const timeoutMs = clampInteger(process.env.AI_QA_TIMEOUT_MS, 1000, 300000, AI_QA_DEFAULT_TIMEOUT_MS);
  const baseUrl = String(process.env.AI_QA_BASE_URL || AI_QA_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const apiKey = String(process.env.AI_QA_API_KEY || AI_QA_DEFAULT_KEY).trim();
  const repoRoot = process.cwd().endsWith(path.sep + 'frontend') ? path.resolve(process.cwd(), '..') : process.cwd();
  const agent = isRecord(body.agent) ? body.agent : {};
  const agentId = asString(body.agent_id || agent.id).trim() || 'default';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || AI_QA_DEFAULT_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: buildAiQaMessages(body, repoRoot),
        temperature,
        max_tokens: maxTokens,
        chat_template_kwargs: { enable_thinking: false },
      }),
      cache: 'no-store',
      signal: controller.signal,
    });
    const raw = await upstream.text();
    const parsed = safeJsonParse(raw);
    if (!upstream.ok) {
      return NextResponse.json(
        {
          error: '上游 AI 请求失败',
          detail: extractAiUpstreamError(parsed, `上游 AI 返回异常状态（HTTP ${upstream.status}）`),
        },
        { status: 502, headers: NO_STORE_PROXY_HEADERS },
      );
    }
    if (isRecord(parsed)) {
      const out: UnknownRecord = { ...parsed };
      if (!asString(out.agent_id).trim()) out.agent_id = agentId;
      if (!asString(out.trace_id).trim()) out.trace_id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return NextResponse.json(out, { headers: NO_STORE_PROXY_HEADERS });
    }
    return NextResponse.json(
      {
        text: raw,
        agent_id: agentId,
        trace_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
      { headers: NO_STORE_PROXY_HEADERS },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: '调用上游 AI 失败',
        detail: error instanceof Error ? error.message : '未知错误',
      },
      { status: 502, headers: NO_STORE_PROXY_HEADERS },
    );
  } finally {
    clearTimeout(timer);
  }
}

function isSensitiveProxyPath(pathSegments: string[]): boolean {
  const joined = pathSegments.join('/');
  if (!joined) return false;
  if (pathSegments[0] === 'wormhole') return true;
  if (joined === 'refresh') return true;
  if (joined === 'debug-latest') return true;
  if (joined === 'system/update') return true;
  if (pathSegments[0] === 'settings') return true;
  if (joined === 'mesh/infonet/ingest') return true;
  return false;
}

async function proxy(req: NextRequest, pathSegments: string[]): Promise<NextResponse> {
  try {
    const joinedPath = pathSegments.join('/');
    if (joinedPath === AI_QA_PATH) {
      return handleAiQa(req);
    }

    const isMesh = pathSegments[0] === 'mesh';
    const meshSegments = pathSegments.slice(1);
    const isSensitiveMeshPath = isMesh && meshSegments[0] === 'dm';
    const isAnonymousMeshWritePath =
      isMesh &&
      !isSensitiveMeshPath &&
      ['POST', 'PUT', 'DELETE'].includes(req.method.toUpperCase()) &&
      (meshSegments.join('/') === 'send' ||
        meshSegments.join('/') === 'vote' ||
        meshSegments.join('/') === 'report' ||
        meshSegments.join('/') === 'gate/create' ||
        (meshSegments[0] === 'gate' && meshSegments[2] === 'message') ||
        meshSegments.join('/') === 'oracle/predict' ||
        meshSegments.join('/') === 'oracle/resolve' ||
        meshSegments.join('/') === 'oracle/stake' ||
        meshSegments.join('/') === 'oracle/resolve-stakes');
    const backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000';
    let targetBase = backendUrl;

    if (isMesh) {
      const envEnabled = (process.env.WORMHOLE_ENABLED || '').toLowerCase();
      let wormholeEnabled = ['1', 'true', 'yes'].includes(envEnabled);
      let privacyProfile = (process.env.WORMHOLE_PRIVACY_PROFILE || '').toLowerCase();
      let anonymousMode = ['1', 'true', 'yes'].includes(
        (process.env.WORMHOLE_ANONYMOUS_MODE || '').toLowerCase(),
      );
      let wormholeReady = false;
      let effectiveTransport = '';

      if (!wormholeEnabled || !privacyProfile || !anonymousMode) {
        try {
          const cwd = process.cwd();
          const repoRoot = cwd.endsWith(path.sep + 'frontend') ? path.resolve(cwd, '..') : cwd;
          const wormholeFile = path.join(repoRoot, 'backend', 'data', 'wormhole.json');
          if (fs.existsSync(wormholeFile)) {
            const raw = fs.readFileSync(wormholeFile, 'utf8');
            const data = JSON.parse(raw);
            if (!wormholeEnabled) {
              wormholeEnabled = Boolean(data && data.enabled);
            }
            privacyProfile = privacyProfile || String(data?.privacy_profile || '').toLowerCase();
            if (!anonymousMode) {
              anonymousMode = Boolean(data?.anonymous_mode);
            }
          }
          const wormholeStatusFile = path.join(repoRoot, 'backend', 'data', 'wormhole_status.json');
          if (fs.existsSync(wormholeStatusFile)) {
            const raw = fs.readFileSync(wormholeStatusFile, 'utf8');
            const data = JSON.parse(raw);
            wormholeReady = Boolean(data?.running) && Boolean(data?.ready);
            effectiveTransport = String(data?.transport_active || data?.transport || '').toLowerCase();
          }
        } catch {
          wormholeEnabled = false;
        }
      }

      if (privacyProfile === 'high' && !wormholeEnabled && isSensitiveMeshPath) {
        return new NextResponse(
          JSON.stringify({
            ok: false,
            detail: 'High privacy requires Wormhole. Enable it in Settings and restart.',
          }),
          { status: 428, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (wormholeEnabled && isSensitiveMeshPath) {
        if (!wormholeReady) {
          return new NextResponse(
            JSON.stringify({
              ok: false,
              detail: 'Wormhole is enabled but not connected yet. Start Wormhole to use secure DM features.',
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        }
        targetBase = process.env.WORMHOLE_URL ?? 'http://127.0.0.1:8787';
      }

      if (anonymousMode && isAnonymousMeshWritePath) {
        if (!wormholeEnabled) {
          return new NextResponse(
            JSON.stringify({
              ok: false,
              detail: 'Anonymous mode requires Wormhole to be enabled before public posting.',
            }),
            { status: 428, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const hiddenReady = wormholeReady && ['tor', 'i2p', 'mixnet'].includes(effectiveTransport);
        if (!hiddenReady) {
          return new NextResponse(
            JSON.stringify({
              ok: false,
              detail: 'Anonymous mode requires Wormhole hidden transport (Tor/I2P/Mixnet) to be ready.',
            }),
            { status: 428, headers: { 'Content-Type': 'application/json' } },
          );
        }
        targetBase = process.env.WORMHOLE_URL ?? 'http://127.0.0.1:8787';
      }
    }

    const targetUrl = new URL(`/api/${pathSegments.join('/')}`, targetBase);
    targetUrl.search = req.nextUrl.search;

    const forwardHeaders = new Headers();
    req.headers.forEach((value, key) => {
      if (!STRIP_REQUEST.has(key.toLowerCase())) {
        forwardHeaders.set(key, value);
      }
    });
    if (isSensitiveProxyPath(pathSegments)) {
      const cookieToken = req.cookies.get(ADMIN_COOKIE)?.value || '';
      const injectedAdmin = process.env.ADMIN_KEY || resolveAdminSessionToken(cookieToken) || '';
      if (injectedAdmin) {
        forwardHeaders.set('X-Admin-Key', injectedAdmin);
      }
    }

    const isBodyless = req.method === 'GET' || req.method === 'HEAD';
    let upstream: Response;
    const requestInit: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers: forwardHeaders,
      cache: 'no-store',
    };
    if (!isBodyless) {
      requestInit.body = req.body;
      // Required for streaming request bodies in Node.js fetch
      requestInit.duplex = 'half';
    }
    try {
      upstream = await fetch(targetUrl.toString(), requestInit);
    } catch {
      return new NextResponse(JSON.stringify({ error: 'Backend unavailable' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });
    if (isSensitiveProxyPath(pathSegments) || isSensitiveMeshPath) {
      Object.entries(NO_STORE_PROXY_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });
    }

    if (upstream.status === 304) {
      return new NextResponse(null, { status: 304, headers: responseHeaders });
    }

    // Stream the upstream body directly instead of buffering the full response.
    // This reduces TTFB and memory pressure for large payloads (flights, ships).
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('api proxy unexpected error', {
      pathSegments,
      method: req.method,
      error,
    });
    return new NextResponse(
      JSON.stringify({
        error: 'Proxy failed',
        detail: error instanceof Error ? error.message : 'unknown_error',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...NO_STORE_PROXY_HEADERS,
        },
      },
    );
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxy(req, (await params).path);
}
