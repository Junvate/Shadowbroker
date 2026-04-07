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
import { spawn } from 'node:child_process';
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
const AI_QA_EXEC_DEFAULT_TIMEOUT_MS = 25000;
const AI_QA_EXEC_MAX_OUTPUT_CHARS = 12000;
const AI_QA_EXEC_MAX_ENDPOINTS = 3;
const AI_QA_EXEC_MAX_DEST_KEYWORDS = 6;

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

type ScriptExecutionPlan = {
  skillId: 'shadowbroker-flight-query' | 'shadowbroker-osint-query';
  label: string;
  scriptPath: string;
  args: string[];
};

type ScriptRunResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  command: string;
  spawnError?: string;
};

type ExecuteModeResult = {
  attempted: boolean;
  text: string;
  succeeded: number;
  failed: number;
};

function resolveRepoRootFromCwd(): string {
  const cwd = process.cwd();
  return cwd.endsWith(path.sep + 'frontend') ? path.resolve(cwd, '..') : cwd;
}

function truncateText(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n... [截断，原始输出过长]`;
}

function appendCapped(current: string, chunk: string, maxChars: number): string {
  if (current.length >= maxChars) return current;
  const remain = maxChars - current.length;
  if (chunk.length <= remain) return current + chunk;
  return current + chunk.slice(0, remain);
}

function sanitizeApiEndpoint(raw: string): string {
  const cleaned = raw.trim().replace(/[，。,.!?！？;；:：]+$/, '');
  if (!/^\/api\/[a-zA-Z0-9/_-]+$/.test(cleaned)) return '';
  return cleaned;
}

function extractApiEndpoints(userInput: string): string[] {
  const matches = userInput.match(/\/api\/[a-zA-Z0-9/_-]+/g) || [];
  const uniq = new Set<string>();
  for (const m of matches) {
    const endpoint = sanitizeApiEndpoint(m);
    if (!endpoint) continue;
    uniq.add(endpoint);
    if (uniq.size >= AI_QA_EXEC_MAX_ENDPOINTS) break;
  }
  return Array.from(uniq);
}

function sanitizeKeyword(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,24}$/.test(value)) return '';
  return value;
}

function collectFlightDestinationKeywords(userInput: string): string[] {
  const lowered = userInput.toLowerCase();
  const out = new Set<string>();
  const add = (candidate: string) => {
    const safe = sanitizeKeyword(candidate);
    if (safe) out.add(safe);
  };

  if (lowered.includes('日本') || lowered.includes('japan')) {
    add('japan');
    add('tokyo');
    add('osaka');
    add('narita');
    add('haneda');
  }
  if (lowered.includes('东京') || lowered.includes('tokyo')) add('tokyo');
  if (lowered.includes('大阪') || lowered.includes('osaka')) add('osaka');
  if (lowered.includes('札幌') || lowered.includes('sapporo')) add('sapporo');
  if (lowered.includes('福冈') || lowered.includes('fukuoka')) add('fukuoka');
  if (lowered.includes('冲绳') || lowered.includes('okinawa')) add('okinawa');
  if (lowered.includes('名古屋') || lowered.includes('nagoya')) add('nagoya');

  const toMatch = lowered.match(/\bto\s+([a-zA-Z][a-zA-Z0-9_-]{1,20})\b/);
  if (toMatch?.[1]) add(toMatch[1]);

  const cnMatch = userInput.match(/(?:飞往|前往|去往|去|到)\s*([^\s，。,；;！？!?]+)/);
  if (cnMatch?.[1]) {
    const token = cnMatch[1].trim();
    if (token.includes('日本')) add('japan');
    if (token.includes('东京')) add('tokyo');
    if (token.includes('大阪')) add('osaka');
  }

  return Array.from(out).slice(0, AI_QA_EXEC_MAX_DEST_KEYWORDS);
}

function buildExecutionPlans(userInput: string, repoRoot: string, backendBaseUrl: string): ScriptExecutionPlan[] {
  const plans: ScriptExecutionPlan[] = [];
  const lowered = userInput.toLowerCase();

  const hasFlightKeyword =
    /航班|飞机|flight|flights|aircraft|plane|planes|callsign|icao24/.test(lowered);
  const hasTravelIntent = /飞往|前往|去往|去|到/.test(userInput);
  const hasFlightLocationHint =
    /日本|东京|大阪|札幌|福冈|冲绳|名古屋|japan|tokyo|osaka|narita|haneda/.test(lowered);
  const flightHint =
    lowered.includes('$shadowbroker-flight-query') ||
    hasFlightKeyword ||
    (hasTravelIntent && hasFlightLocationHint);
  if (flightHint) {
    const scriptPath = path.join(
      repoRoot,
      'skills',
      'shadowbroker-flight-query',
      'scripts',
      'query_flights.py',
    );
    const args = ['--base-url', backendBaseUrl, '--limit', '50', '--json'];
    const destKeywords = collectFlightDestinationKeywords(userInput);
    for (const keyword of destKeywords) {
      args.push('--dest-keyword', keyword);
    }
    plans.push({
      skillId: 'shadowbroker-flight-query',
      label: '航班查询',
      scriptPath,
      args,
    });
    return plans;
  }

  const profileHint =
    lowered.includes('backend/data') ||
    lowered.includes('数据集') ||
    lowered.includes('profile_backend_data');
  if (profileHint) {
    plans.push({
      skillId: 'shadowbroker-osint-query',
      label: '数据目录盘点',
      scriptPath: path.join(
        repoRoot,
        'skills',
        'shadowbroker-osint-query',
        'scripts',
        'profile_backend_data.py',
      ),
      args: ['--data-dir', path.join(repoRoot, 'backend', 'data'), '--inspect-json-keys'],
    });
  }

  let endpoints = extractApiEndpoints(userInput);
  if (endpoints.length === 0 && /健康|health/.test(lowered)) {
    endpoints = ['/api/health'];
  }

  const wantsFastExtracts =
    /live-data\/fast/.test(lowered) &&
    (/flights|航班/.test(lowered) || /ships|船舶|船/.test(lowered) || /sigint|信号/.test(lowered));

  for (const endpoint of endpoints.slice(0, AI_QA_EXEC_MAX_ENDPOINTS)) {
    if (endpoint === '/api/live-data/fast' && wantsFastExtracts) {
      const extracts: Array<{ key: string; limit: number }> = [];
      if (/flights|航班/.test(lowered)) extracts.push({ key: 'commercial_flights', limit: 20 });
      if (/ships|船舶|船/.test(lowered)) extracts.push({ key: 'ships', limit: 20 });
      if (/sigint|信号/.test(lowered)) extracts.push({ key: 'sigint', limit: 20 });
      for (const item of extracts.slice(0, 3)) {
        plans.push({
          skillId: 'shadowbroker-osint-query',
          label: `API 查询 ${endpoint}#${item.key}`,
          scriptPath: path.join(
            repoRoot,
            'skills',
            'shadowbroker-osint-query',
            'scripts',
            'query_api.py',
          ),
          args: [
            '--base-url',
            backendBaseUrl,
            '--endpoint',
            endpoint,
            '--extract',
            item.key,
            '--limit',
            String(item.limit),
          ],
        });
      }
      continue;
    }
    plans.push({
      skillId: 'shadowbroker-osint-query',
      label: `API 查询 ${endpoint}`,
      scriptPath: path.join(repoRoot, 'skills', 'shadowbroker-osint-query', 'scripts', 'query_api.py'),
      args: ['--base-url', backendBaseUrl, '--endpoint', endpoint],
    });
  }

  if (plans.length === 0 && lowered.includes('$shadowbroker-osint-query')) {
    plans.push({
      skillId: 'shadowbroker-osint-query',
      label: 'API 查询 /api/health',
      scriptPath: path.join(repoRoot, 'skills', 'shadowbroker-osint-query', 'scripts', 'query_api.py'),
      args: ['--base-url', backendBaseUrl, '--endpoint', '/api/health'],
    });
  }

  return plans;
}

function resolvePythonCandidates(repoRoot: string): string[] {
  const candidates = [
    process.env.AI_QA_PYTHON || '',
    path.join(repoRoot, 'backend', 'venv', 'bin', 'python3'),
    path.join(repoRoot, 'backend', '.venv', 'bin', 'python3'),
    path.join(repoRoot, '.venv', 'bin', 'python3'),
    'python3',
    'python',
  ];
  return candidates.filter((item, index) => item && candidates.indexOf(item) === index);
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ScriptRunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const fullCommand = `${command} ${args.join(' ')}`.trim();
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk, AI_QA_EXEC_MAX_OUTPUT_CHARS);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk, AI_QA_EXEC_MAX_OUTPUT_CHARS);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout: truncateText(stdout, AI_QA_EXEC_MAX_OUTPUT_CHARS),
        stderr: truncateText(stderr, AI_QA_EXEC_MAX_OUTPUT_CHARS),
        timedOut,
        command: fullCommand,
        spawnError: error instanceof Error ? error.message : String(error),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        stdout: truncateText(stdout, AI_QA_EXEC_MAX_OUTPUT_CHARS),
        stderr: truncateText(stderr, AI_QA_EXEC_MAX_OUTPUT_CHARS),
        timedOut,
        command: fullCommand,
      });
    });
  });
}

async function runPlanWithPython(
  plan: ScriptExecutionPlan,
  repoRoot: string,
  timeoutMs: number,
): Promise<ScriptRunResult> {
  if (!fs.existsSync(plan.scriptPath)) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: `技能脚本不存在：${plan.scriptPath}`,
      timedOut: false,
      command: '',
    };
  }
  const candidates = resolvePythonCandidates(repoRoot);
  let lastFailure: ScriptRunResult | null = null;
  for (const pythonCmd of candidates) {
    const run = await runCommand(pythonCmd, [plan.scriptPath, ...plan.args], repoRoot, timeoutMs);
    if (!run.spawnError || !run.spawnError.includes('ENOENT')) {
      return run;
    }
    lastFailure = run;
  }
  return (
    lastFailure || {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '未找到可用 Python 解释器（可设置 AI_QA_PYTHON）',
      timedOut: false,
      command: '',
    }
  );
}

function summarizeJson(value: unknown, maxChars = 2200): string {
  const text = JSON.stringify(value, null, 2);
  return truncateText(text, maxChars);
}

function summarizePlanOutput(plan: ScriptExecutionPlan, run: ScriptRunResult): string {
  if (!run.ok) {
    const errorInfo = [
      `状态: 失败${run.timedOut ? '（超时）' : ''}`,
      run.command ? `命令: ${run.command}` : '',
      run.spawnError ? `启动错误: ${run.spawnError}` : '',
      run.stderr ? `stderr:\n${truncateText(run.stderr, 1800)}` : '',
      run.stdout ? `stdout:\n${truncateText(run.stdout, 1200)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return `【${plan.label}】\n${errorInfo}`;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    parsed = null;
  }

  if (plan.skillId === 'shadowbroker-flight-query' && Array.isArray(parsed)) {
    const rows = parsed as Array<Record<string, unknown>>;
    const lines = rows.slice(0, 15).map((row, idx) => {
      const callsign = asString(row.callsign || '').trim() || 'UNKNOWN';
      const origin = asString(row.origin_name || '').trim() || 'UNKNOWN';
      const dest = asString(row.dest_name || '').trim() || 'UNKNOWN';
      const alt = row.alt ?? '-';
      const speed = row.speed_knots ?? '-';
      const reasons = Array.isArray(row.match_reasons)
        ? row.match_reasons.map((item) => String(item)).join(',')
        : '';
      return `${String(idx + 1).padStart(2, '0')}. ${callsign} | ${origin} -> ${dest} | alt=${alt} speed=${speed} ${reasons ? `| ${reasons}` : ''}`;
    });
    return [
      `【${plan.label}】`,
      `状态: 成功，匹配 ${rows.length} 条`,
      run.command ? `命令: ${run.command}` : '',
      lines.length > 0 ? lines.join('\n') : '无匹配结果',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (plan.skillId === 'shadowbroker-osint-query') {
    const summary = parsed !== null ? summarizeJson(parsed) : truncateText(run.stdout, 2200);
    return [
      `【${plan.label}】`,
      '状态: 成功',
      run.command ? `命令: ${run.command}` : '',
      `结果:\n${summary}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    `【${plan.label}】`,
    '状态: 成功',
    run.command ? `命令: ${run.command}` : '',
    `输出:\n${truncateText(run.stdout, 2200)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function runExecuteMode(
  body: UnknownRecord,
  repoRoot: string,
  backendBaseUrl: string,
): Promise<ExecuteModeResult> {
  const message = asString(body.message).trim();
  const plans = buildExecutionPlans(message, repoRoot, backendBaseUrl);
  if (plans.length === 0) {
    return { attempted: false, text: '', succeeded: 0, failed: 0 };
  }

  const timeoutMs = clampInteger(
    process.env.AI_QA_EXEC_TIMEOUT_MS,
    1000,
    180000,
    AI_QA_EXEC_DEFAULT_TIMEOUT_MS,
  );

  const sections: string[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const plan of plans) {
    const run = await runPlanWithPython(plan, repoRoot, timeoutMs);
    if (run.ok) succeeded += 1;
    else failed += 1;
    sections.push(summarizePlanOutput(plan, run));
  }

  const header = [
    '执行模式已开启：已尝试执行本地技能脚本。',
    `任务数: ${plans.length}，成功: ${succeeded}，失败: ${failed}`,
  ].join('\n');
  return {
    attempted: true,
    text: `${header}\n\n${sections.join('\n\n')}`,
    succeeded,
    failed,
  };
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
  const executeMode = Boolean(options.executeMode);
  const model = String(process.env.AI_QA_MODEL || AI_QA_DEFAULT_MODEL).trim();
  const temperature = clampNumber(options.temperature, 0, 2, 0.7);
  const maxTokens = clampInteger(options.maxTokens, 64, 20000, 2000);
  const timeoutMs = clampInteger(process.env.AI_QA_TIMEOUT_MS, 1000, 300000, AI_QA_DEFAULT_TIMEOUT_MS);
  const baseUrl = String(process.env.AI_QA_BASE_URL || AI_QA_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const apiKey = String(process.env.AI_QA_API_KEY || AI_QA_DEFAULT_KEY).trim();
  const repoRoot = resolveRepoRootFromCwd();
  const backendBaseUrl = String(process.env.BACKEND_URL || 'http://127.0.0.1:8000').trim();
  const agent = isRecord(body.agent) ? body.agent : {};
  const agentId = asString(body.agent_id || agent.id).trim() || 'default';

  if (executeMode) {
    const executeResult = await runExecuteMode(body, repoRoot, backendBaseUrl);
    if (!executeResult.attempted) {
      return NextResponse.json(
        {
          error: '执行模式未命中可执行技能',
          detail:
            '当前问题未匹配到可执行技能（flight-query/osint-query）。请明确写出查询目标，例如“飞往日本的航班”或“查询 /api/health”。',
        },
        { status: 422, headers: NO_STORE_PROXY_HEADERS },
      );
    }
    return NextResponse.json(
      {
        text: executeResult.text,
        agent_id: agentId,
        execute_mode: true,
        execute_succeeded: executeResult.succeeded,
        execute_failed: executeResult.failed,
        trace_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
      { headers: NO_STORE_PROXY_HEADERS },
    );
  }

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
