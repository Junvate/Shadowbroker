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
const AI_QA_DEFAULT_BASE_URL = 'http://127.0.0.1:8900';
const AI_QA_DEFAULT_MODEL = '';
const AI_QA_DEFAULT_KEY = '';
const AI_QA_DEFAULT_TIMEOUT_MS = 120000;
const AI_QA_EXEC_DEFAULT_TIMEOUT_MS = 25000;
const AI_QA_EXEC_CAPTURE_MAX_OUTPUT_CHARS = 200000;
const AI_QA_EXEC_MAX_ENDPOINTS = 3;
const AI_QA_EXEC_MAX_DEST_KEYWORDS = 6;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
  summaryHint?: string;
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

type FlightMatchPayload = {
  id: string;
  callsign: string;
  icao24: string;
  lat: number;
  lng: number;
  source_bucket: string;
  match_reasons: string[];
};

type ExecuteModeResult = {
  attempted: boolean;
  text: string;
  succeeded: number;
  failed: number;
};

function buildExecuteModeResponse(
  executeResult: ExecuteModeResult,
  agentId: string,
  fallbackDetail?: string,
  flightMatches?: FlightMatchPayload[],
  flightQuery = false,
): NextResponse {
  const prefix = fallbackDetail
    ? `上游 nanobot 当前不可用，已回退到本地技能执行。\n原因: ${fallbackDetail}\n\n`
    : '';
  const responseBody: UnknownRecord = {
    text: `${prefix}${executeResult.text}`,
    agent_id: agentId,
    execute_mode: true,
    execute_succeeded: executeResult.succeeded,
    execute_failed: executeResult.failed,
    trace_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };
  if (flightQuery) {
    responseBody.flight_query = true;
    responseBody.flight_matches = flightMatches || [];
  }
  return NextResponse.json(
    responseBody,
    { headers: NO_STORE_PROXY_HEADERS },
  );
}

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

function toFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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
  const value = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!value || value.length > 40) return '';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '';
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
  if (
    lowered.includes('朝鲜') ||
    lowered.includes('北韩') ||
    lowered.includes('北朝鲜') ||
    lowered.includes('north korea') ||
    lowered.includes('dprk')
  ) {
    add('north korea');
    add('dprk');
    add('pyongyang');
    add('fnj');
  }
  if (lowered.includes('东京') || lowered.includes('tokyo')) add('tokyo');
  if (lowered.includes('大阪') || lowered.includes('osaka')) add('osaka');
  if (lowered.includes('札幌') || lowered.includes('sapporo')) add('sapporo');
  if (lowered.includes('福冈') || lowered.includes('fukuoka')) add('fukuoka');
  if (lowered.includes('冲绳') || lowered.includes('okinawa')) add('okinawa');
  if (lowered.includes('名古屋') || lowered.includes('nagoya')) add('nagoya');
  if (lowered.includes('平壤') || lowered.includes('pyongyang')) add('pyongyang');

  const toMatch = lowered.match(/\bto\s+([a-zA-Z][a-zA-Z0-9_-]{1,20})\b/);
  if (toMatch?.[1]) add(toMatch[1]);

  const cnMatch = userInput.match(/(?:飞往|前往|去往|去|到)\s*([^\s，。,；;！？!?]+)/);
  if (cnMatch?.[1]) {
    const token = cnMatch[1]
      .trim()
      .replace(/的?(飞机|航班).*$/u, '')
      .trim();
    add(token);
    if (token.includes('日本')) add('japan');
    if (token.includes('东京')) add('tokyo');
    if (token.includes('大阪')) add('osaka');
    if (token.includes('朝鲜') || token.includes('北韩')) {
      add('north korea');
      add('dprk');
      add('pyongyang');
      add('fnj');
    }
    if (token.includes('平壤')) {
      add('pyongyang');
      add('fnj');
    }
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
    const destKeywords = collectFlightDestinationKeywords(userInput);
    if (hasTravelIntent && destKeywords.length === 0) {
      return plans;
    }
    const scriptPath = path.join(
      repoRoot,
      'skills',
      'shadowbroker-flight-query',
      'scripts',
      'query_flights.py',
    );
    const args = ['--base-url', backendBaseUrl, '--limit', '50', '--json'];
    for (const keyword of destKeywords) {
      args.push('--dest-keyword', keyword);
    }
    plans.push({
      skillId: 'shadowbroker-flight-query',
      label: '航班查询',
      scriptPath,
      args,
      summaryHint: destKeywords.join(' / '),
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
      stdout = appendCapped(stdout, chunk, AI_QA_EXEC_CAPTURE_MAX_OUTPUT_CHARS);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk, AI_QA_EXEC_CAPTURE_MAX_OUTPUT_CHARS);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
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
        stdout,
        stderr,
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

function summarizeTopCounts(rows: Array<Record<string, unknown>>, key: string, limit = 3): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = asString(row[key]).trim() || 'UNKNOWN';
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => `${name} x${count}`)
    .join('；');
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
    const destinationSummary = rows.length > 0 ? summarizeTopCounts(rows, 'dest_name') : '';
    const originSummary = rows.length > 0 ? summarizeTopCounts(rows, 'origin_name') : '';
    return [
      `【${plan.label}】`,
      `状态: 成功，匹配 ${rows.length} 条`,
      run.command ? `命令: ${run.command}` : '',
      rows.length > 0
        ? `结论: 当前命中 ${rows.length} 架与查询条件相关的航班${plan.summaryHint ? `（${plan.summaryHint}）` : ''}。`
        : `结论: 当前数据里没有命中与查询条件相关的航班${plan.summaryHint ? `（${plan.summaryHint}）` : ''}。`,
      destinationSummary ? `目的地分布: ${destinationSummary}` : '',
      originSummary ? `主要出发地: ${originSummary}` : '',
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
  precomputedPlans?: ScriptExecutionPlan[],
): Promise<ExecuteModeResult> {
  const message = asString(body.message).trim();
  const plans = precomputedPlans || buildExecutionPlans(message, repoRoot, backendBaseUrl);
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

function extractFlightMatches(value: unknown): FlightMatchPayload[] {
  if (!Array.isArray(value)) return [];
  const matches: FlightMatchPayload[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!isRecord(item)) continue;
    const icao24 = asString(item.icao24).trim().toLowerCase();
    const lat = toFiniteNumber(item.lat);
    const lng = toFiniteNumber(item.lng);
    if (!icao24 || lat === null || lng === null) continue;

    const sourceBucket = asString(item.source_bucket).trim() || 'commercial_flights';
    const id = `${sourceBucket}:${icao24}`;
    if (seen.has(id)) continue;
    seen.add(id);

    matches.push({
      id,
      callsign: asString(item.callsign).trim() || icao24.toUpperCase(),
      icao24,
      lat,
      lng,
      source_bucket: sourceBucket,
      match_reasons: Array.isArray(item.match_reasons)
        ? item.match_reasons.map((reason) => String(reason))
        : [],
    });
  }

  return matches;
}

async function runFlightHighlightProbe(
  plan: ScriptExecutionPlan | null,
  backendBaseUrl: string,
): Promise<FlightMatchPayload[]> {
  if (!plan || plan.skillId !== 'shadowbroker-flight-query') return [];

  const timeoutMs = clampInteger(
    process.env.AI_QA_FLIGHT_MATCH_TIMEOUT_MS,
    500,
    30000,
    4500,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(`${backendBaseUrl.replace(/\/+$/, '')}/api/live-data/fast`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!upstream.ok) return [];

    const parsed = await upstream.json().catch(() => null);
    if (!isRecord(parsed)) return [];

    const destKeywords = new Set<string>();
    const matchTerms = new Set<string>();
    let callsignPrefix = '';
    let icao24 = '';
    let limit = 50;

    for (let idx = 0; idx < plan.args.length; idx += 1) {
      const token = plan.args[idx];
      const value = plan.args[idx + 1];
      if (!value) continue;
      if (token === '--dest-keyword') destKeywords.add(String(value).trim().toLowerCase());
      if (token === '--match') matchTerms.add(String(value).trim().toLowerCase());
      if (token === '--callsign-prefix') callsignPrefix = String(value).trim().toUpperCase();
      if (token === '--icao24') icao24 = String(value).trim().toLowerCase();
      if (token === '--limit') limit = clampInteger(value, 1, 500, 50);
    }

    const flightBuckets = [
      'commercial_flights',
      'private_jets',
      'private_flights',
      'tracked_flights',
    ] as const;

    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const bucket of flightBuckets) {
      const entries = parsed[bucket];
      if (!Array.isArray(entries)) continue;
      for (const item of entries) {
        if (!isRecord(item)) continue;
        const callsign = asString(item.callsign).trim().toUpperCase();
        const itemIcao24 = asString(item.icao24).trim().toLowerCase();
        if (!itemIcao24) continue;
        const uniqueKey = `${bucket}:${itemIcao24}`;
        if (seen.has(uniqueKey)) continue;

        const searchable = [
          item.callsign,
          item.icao24,
          item.registration,
          item.type,
          item.model,
          item.origin_name,
          item.dest_name,
        ]
          .map((value) => String(value || '').toLowerCase())
          .join(' ');
        const destName = asString(item.dest_name).trim().toLowerCase();
        const originName = asString(item.origin_name).trim().toLowerCase();

        if (destKeywords.size > 0) {
          // Match against dest_name, origin_name, callsign and the full
          // searchable blob so flights with partial route data are not
          // silently dropped.
          const hit = Array.from(destKeywords).some(
            (kw) => destName.includes(kw) || originName.includes(kw) || searchable.includes(kw),
          );
          if (!hit) continue;
        }
        if (matchTerms.size > 0 && !Array.from(matchTerms).some((term) => searchable.includes(term))) {
          continue;
        }
        if (callsignPrefix && !callsign.startsWith(callsignPrefix)) continue;
        if (icao24 && itemIcao24 !== icao24) continue;

        seen.add(uniqueKey);
        const reasons: string[] = [];
        if (destKeywords.size > 0) {
          if (Array.from(destKeywords).some((kw) => destName.includes(kw))) reasons.push('dest_keyword');
          else if (Array.from(destKeywords).some((kw) => originName.includes(kw))) reasons.push('origin_keyword');
          else reasons.push('searchable_match');
        }
        if (matchTerms.size > 0) reasons.push('match');
        if (callsignPrefix) reasons.push('callsign_prefix');
        if (icao24) reasons.push('icao24');
        rows.push({
          ...item,
          source_bucket: bucket,
          match_reasons: reasons,
        });
      }
    }

    return extractFlightMatches(rows.slice(0, limit));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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
  const timeoutMs = clampInteger(process.env.AI_QA_TIMEOUT_MS, 1000, 300000, AI_QA_DEFAULT_TIMEOUT_MS);
  const baseUrl = String(process.env.AI_QA_BASE_URL || AI_QA_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const apiKey = String(process.env.AI_QA_API_KEY || AI_QA_DEFAULT_KEY).trim();
  const repoRoot = resolveRepoRootFromCwd();
  const backendBaseUrl = String(process.env.BACKEND_URL || 'http://127.0.0.1:8000').trim();
  const agent = isRecord(body.agent) ? body.agent : {};
  const agentId = asString(body.agent_id || agent.id).trim() || 'default';
  const sessionId = asString(body.session_id).trim() || `ai-qa-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const executionPlans = buildExecutionPlans(message, repoRoot, backendBaseUrl);
  const flightPlan = executionPlans.find((plan) => plan.skillId === 'shadowbroker-flight-query') || null;
  const flightQuery = Boolean(flightPlan);
  const flightProbePromise = flightQuery ? runFlightHighlightProbe(flightPlan, backendBaseUrl) : null;

  if (executeMode) {
    const executeResult = await runExecuteMode(body, repoRoot, backendBaseUrl, executionPlans);
    if (executeResult.attempted) {
      const flightMatches = flightProbePromise ? await flightProbePromise : [];
      return buildExecuteModeResponse(executeResult, agentId, undefined, flightMatches, flightQuery);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...(model ? { model } : {}),
        messages: [{ role: 'user', content: message }],
        session_id: sessionId,
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
      if (flightQuery) {
        out.flight_query = true;
        out.flight_matches = flightProbePromise ? await flightProbePromise : [];
      }
      return NextResponse.json(out, { headers: NO_STORE_PROXY_HEADERS });
    }
    const flightMatches = flightProbePromise ? await flightProbePromise : [];
    return NextResponse.json(
      {
        text: raw,
        agent_id: agentId,
        trace_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ...(flightQuery
          ? {
            flight_query: true,
            flight_matches: flightMatches,
          }
          : {}),
      },
      { headers: NO_STORE_PROXY_HEADERS },
    );
  } catch (error) {
    const fallbackExecuteResult = await runExecuteMode(body, repoRoot, backendBaseUrl, executionPlans);
    if (fallbackExecuteResult.attempted) {
      const detail = error instanceof Error ? error.message : '未知错误';
      const flightMatches = flightProbePromise ? await flightProbePromise : [];
      return buildExecuteModeResponse(
        fallbackExecuteResult,
        agentId,
        detail,
        flightMatches,
        flightQuery,
      );
    }
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
