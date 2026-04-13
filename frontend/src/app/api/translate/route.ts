import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import https from 'https';
import {
  TRANSLATION_MAX_REQUEST_ITEMS,
  TRANSLATION_MAX_TEXT_LENGTH,
} from '@/lib/translationConstants';

const DEEPL_URL = 'https://api-free.deepl.com/v2/translate';
const NIUTRANS_URL = 'https://api.niutrans.com/NiuTransServer/translation';
const DEEPL_MAX_BATCH_SIZE = 40;
const NIUTRANS_MIN_INTERVAL_MS = 230; // <= ~4.3 QPS, below free-tier 5 QPS limit
const SERVER_TRANSLATION_CACHE_LIMIT = 5000;
const LOCAL_TRANSLATE_DEFAULT_BATCH_SIZE = 8;
const LOCAL_TRANSLATE_DEFAULT_TIMEOUT_MS = 8000;
const LOCAL_TRANSLATE_MAX_BATCH_SIZE = 12;

type TranslateRequestBody = {
  texts?: unknown;
  targetLang?: unknown;
};

type TranslateProvider = 'auto' | 'deepl' | 'niutrans' | 'local';
type ResolvedTranslateProvider = Exclude<TranslateProvider, 'auto'>;
type LocalTranslateConfig = {
  apiUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  batchSize: number;
};

let niutransQueue: Promise<unknown> = Promise.resolve();
let niutransLastCallAt = 0;
let localTranslateQueue: Promise<unknown> = Promise.resolve();
const serverTranslationCache = new Map<string, string>();

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function enqueueNiuTransCall<T>(fn: () => Promise<T>): Promise<T> {
  const task = async () => {
    const now = Date.now();
    const waitMs = Math.max(0, NIUTRANS_MIN_INTERVAL_MS - (now - niutransLastCallAt));
    if (waitMs > 0) await sleep(waitMs);
    niutransLastCallAt = Date.now();
    return fn();
  };
  const next = niutransQueue.then(task, task) as Promise<T>;
  niutransQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function enqueueLocalTranslateCall<T>(fn: () => Promise<T>): Promise<T> {
  const next = localTranslateQueue.then(fn, fn) as Promise<T>;
  localTranslateQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function isTruthy(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function isFalsy(value: string): boolean {
  return ['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function isTlsCertError(err: unknown): boolean {
  const e = err as { message?: string; code?: string; cause?: { message?: string; code?: string } };
  const msg = String(e?.message || e?.cause?.message || '').toLowerCase();
  const code = String(e?.code || e?.cause?.code || '').toUpperCase();
  return (
    msg.includes('unable to get local issuer certificate') ||
    msg.includes('certificate verify failed') ||
    msg.includes('unable to verify the first certificate') ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  );
}

async function postFormWithHttps(
  urlString: string,
  params: URLSearchParams,
  options: { rejectUnauthorized: boolean; ca?: Buffer },
): Promise<{ status: number; body: string }> {
  const url = new URL(urlString);
  const body = params.toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        rejectUnauthorized: options.rejectUnauthorized,
        ca: options.ca,
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          out += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: out,
          });
        });
      },
    );

    req.setTimeout(20000, () => {
      req.destroy(new Error('https_request_timeout'));
    });
    req.on('error', (error) => reject(error));
    req.write(body);
    req.end();
  });
}

function parseDotEnvValue(rawLine: string): string {
  let value = rawLine.trim();
  if (!value) return '';
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    let out = '';
    let escaped = false;
    for (let i = 1; i < value.length; i += 1) {
      const ch = value[i];
      if (!escaped && ch === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && ch === quote) {
        return out.trim();
      }
      out += ch;
      escaped = false;
    }
    return out.trim();
  }
  const commentIdx = value.search(/\s#/);
  if (commentIdx >= 0) {
    value = value.slice(0, commentIdx);
  }
  return value.trim();
}

function resolveRepoRootFromCwd(): string {
  const cwd = process.cwd();
  return cwd.endsWith(path.sep + 'frontend') ? path.resolve(cwd, '..') : cwd;
}

function buildEnvFileCandidates(): string[] {
  const cwd = process.cwd();
  const repoRoot = resolveRepoRootFromCwd();
  return Array.from(
    new Set([
      path.resolve(cwd, '.env.local'),
      path.resolve(cwd, '.env'),
      path.resolve(repoRoot, '.env.local'),
      path.resolve(repoRoot, '.env'),
      path.resolve(repoRoot, 'frontend', '.env.local'),
      path.resolve(repoRoot, 'frontend', '.env'),
      path.resolve(repoRoot, 'backend', '.env'),
    ]),
  );
}

function readEnvFileKey(key: string): string {
  for (const envPath of buildEnvFileCandidates()) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const k = trimmed.slice(0, eq).trim();
        if (k !== key) continue;
        const v = parseDotEnvValue(trimmed.slice(eq + 1));
        if (v) return v;
      }
    } catch {
      // fall through next candidate
    }
  }
  return '';
}

function readRuntimeEnvKey(key: string): string {
  const envValue = process.env[key];
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.trim();
  }
  return readEnvFileKey(key);
}

function normalizeTextList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, TRANSLATION_MAX_REQUEST_ITEMS)
    .map((item) => (typeof item === 'string' ? item.trim() : ''));
}

function sanitizeTargetLang(raw: unknown): string {
  if (typeof raw !== 'string') return 'ZH-HANS';
  const upper = raw.trim().toUpperCase();
  if (!upper) return 'ZH-HANS';
  return upper;
}

function normalizeTranslateProvider(raw: string): TranslateProvider {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'local' || value === 'llm' || value === 'openai') return 'local';
  if (value === 'deepl') return 'deepl';
  if (value === 'niutrans' || value === 'niu') return 'niutrans';
  return 'auto';
}

function clampInt(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function mapTargetForNiuTrans(targetLang: string): string {
  const t = String(targetLang || '').toUpperCase();
  if (t.startsWith('ZH')) return 'zh';
  if (t.startsWith('EN')) return 'en';
  if (t.startsWith('JA')) return 'ja';
  if (t.startsWith('KO')) return 'ko';
  if (t.startsWith('FR')) return 'fr';
  if (t.startsWith('DE')) return 'de';
  if (t.startsWith('RU')) return 'ru';
  if (t.startsWith('ES')) return 'es';
  return 'zh';
}

function extractNiuTranslatedText(
  data: unknown,
  source: string,
): { text: string; ok: boolean; code: string } {
  if (!data || typeof data !== 'object') return { text: source, ok: false, code: 'invalid_response' };
  const d = data as Record<string, unknown>;
  const code = d.error_code;
  const normalizedCode =
    typeof code === 'number' ? String(code) : typeof code === 'string' ? code : '0';
  if (typeof code === 'number' && code !== 0) {
    return { text: source, ok: false, code: normalizedCode };
  }
  if (typeof code === 'string' && code !== '0' && code !== '') {
    return { text: source, ok: false, code: normalizedCode };
  }
  if (typeof d.tgt_text === 'string' && d.tgt_text.trim()) return { text: d.tgt_text, ok: true, code: '0' };
  if (typeof d.target_text === 'string' && d.target_text.trim()) {
    return { text: d.target_text, ok: true, code: '0' };
  }
  if (typeof d.translation === 'string' && d.translation.trim()) {
    return { text: d.translation, ok: true, code: '0' };
  }
  return { text: source, ok: false, code: normalizedCode || 'empty' };
}

async function translateWithNiuTrans(
  apiKey: string,
  texts: string[],
  targetLang: string,
  tlsConfig: { allowInsecure: boolean; autoFallback: boolean; caFile?: string },
): Promise<string[]> {
  const to = mapTargetForNiuTrans(targetLang);
  const out = new Array<string>(texts.length).fill('');
  let caBuffer: Buffer | undefined;
  if (tlsConfig.caFile) {
    try {
      caBuffer = fs.readFileSync(tlsConfig.caFile);
    } catch {
      caBuffer = undefined;
    }
  }
  for (let idx = 0; idx < texts.length; idx += 1) {
    const src = texts[idx];
    const translated = await enqueueNiuTransCall(async () => {
      const params = new URLSearchParams();
      params.set('apikey', apiKey);
      params.set('from', 'auto');
      params.set('to', to);
      params.set('src_text', src);

      let httpResult: { status: number; body: string };
      try {
        httpResult = await postFormWithHttps(NIUTRANS_URL, params, {
          rejectUnauthorized: !tlsConfig.allowInsecure,
          ca: caBuffer,
        });
      } catch (error) {
        if (tlsConfig.allowInsecure || !tlsConfig.autoFallback || !isTlsCertError(error)) {
          throw error;
        }
        httpResult = await postFormWithHttps(NIUTRANS_URL, params, {
          rejectUnauthorized: false,
        });
      }

      if (httpResult.status < 200 || httpResult.status >= 300) {
        throw new Error(`niutrans_http_${httpResult.status}: ${httpResult.body.slice(0, 200)}`);
      }

      const data = (JSON.parse(httpResult.body || '{}') as unknown);
      const parsed = extractNiuTranslatedText(data, src);
      return parsed.text;
    }).catch(() => src);

    out[idx] = translated || src;
  }

  return out;
}

async function translateBatch(
  apiKey: string,
  texts: string[],
  targetLang: string,
): Promise<string[]> {
  const results: string[] = [];

  for (let i = 0; i < texts.length; i += DEEPL_MAX_BATCH_SIZE) {
    const chunk = texts.slice(i, i + DEEPL_MAX_BATCH_SIZE);
    const params = new URLSearchParams();
    params.set('auth_key', apiKey);
    params.set('target_lang', targetLang);
    params.set('preserve_formatting', '1');
    params.set('split_sentences', 'nonewlines');
    for (const text of chunk) {
      params.append('text', text);
    }

    const resp = await fetch(DEEPL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      cache: 'no-store',
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`deepl_error_${resp.status}: ${detail.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { translations?: Array<{ text?: string }> };
    const translated = Array.isArray(data?.translations) ? data.translations : [];
    for (const item of translated) {
      results.push(typeof item?.text === 'string' ? item.text : '');
    }
  }

  return results;
}

function stripMarkdownCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
}

function parseLocalTranslationArray(raw: string, expectedLength: number): string[] | null {
  const cleaned = stripMarkdownCodeFence(raw);
  const candidates = [cleaned];
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(cleaned.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length === expectedLength &&
        parsed.every((item) => typeof item === 'string')
      ) {
        return parsed.map((item) => item.trim());
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function estimateLocalMaxTokens(texts: string[]): number {
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
  return Math.min(768, Math.max(128, Math.ceil(totalChars * 1.15)));
}

function localTargetLanguageLabel(targetLang: string): string {
  const upper = String(targetLang || '').toUpperCase();
  if (upper.startsWith('ZH')) return 'Simplified Chinese';
  if (upper.startsWith('EN')) return 'English';
  return upper || 'English';
}

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function hasLatin(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

function isAcceptableTranslation(source: string, candidate: string, targetLang: string): boolean {
  const src = String(source || '').trim();
  const out = String(candidate || '').trim();
  if (!src || !out) return false;
  if (src === out) return false;
  const upper = String(targetLang || '').toUpperCase();
  if (upper.startsWith('ZH') && hasLatin(src)) {
    return hasCjk(out);
  }
  if (upper.startsWith('EN') && hasCjk(src)) {
    return hasLatin(out);
  }
  return true;
}

async function translateWithLocalModel(
  config: LocalTranslateConfig,
  texts: string[],
  targetLang: string,
): Promise<string[]> {
  const out: string[] = [];
  const targetLabel = localTargetLanguageLabel(targetLang);

  for (let idx = 0; idx < texts.length; idx += config.batchSize) {
    const chunk = texts.slice(idx, idx + config.batchSize);
    const translatedChunk = await enqueueLocalTranslateCall(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const resp = await fetch(config.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey || 'EMPTY'}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              {
                role: 'system',
                content:
                  `Translate each UI string into concise ${targetLabel}. ` +
                  'The source strings may be in English, Chinese, or mixed UI text. ' +
                  'Preserve brand names like Shadowbroker exactly. ' +
                  'Preserve code, URLs, coordinates, and acronyms. ' +
                  'Return only a raw JSON array of strings with the same length and order.',
              },
              {
                role: 'user',
                content: JSON.stringify(chunk),
              },
            ],
            temperature: 0,
            max_tokens: estimateLocalMaxTokens(chunk),
            chat_template_kwargs: {
              enable_thinking: false,
            },
          }),
          cache: 'no-store',
          signal: controller.signal,
        });

        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          throw new Error(`local_translate_error_${resp.status}: ${detail.slice(0, 200)}`);
        }

        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = String(data?.choices?.[0]?.message?.content || '').trim();
        const parsed = parseLocalTranslationArray(content, chunk.length);
        return parsed || chunk;
      } finally {
        clearTimeout(timeoutId);
      }
    }).catch(() => chunk);

    out.push(...translatedChunk);
  }

  return out;
}

function resolveProviderOrder(provider: TranslateProvider): ResolvedTranslateProvider[] {
  if (provider === 'local') return ['local', 'deepl', 'niutrans'];
  if (provider === 'deepl') return ['deepl', 'niutrans', 'local'];
  if (provider === 'niutrans') return ['niutrans', 'deepl', 'local'];
  return ['niutrans', 'deepl', 'local'];
}

function translationCacheKey(targetLang: string, text: string): string {
  return `${sanitizeTargetLang(targetLang)}::${text}`;
}

function shouldAttemptTranslation(text: string): boolean {
  return text.length > 0 && text.length <= TRANSLATION_MAX_TEXT_LENGTH;
}

export async function POST(req: NextRequest) {
  try {
    const niuApiKey = (
      readRuntimeEnvKey('NIUTRANS_API_KEY') ||
      readRuntimeEnvKey('NIUTRANS_APP_KEY') ||
      readRuntimeEnvKey('TRANSLATE_API_KEY')
    ).trim();
    const deeplApiKey = (
      readRuntimeEnvKey('DEEPL_API_KEY')
    ).trim();
    const localTranslateApiUrl = (
      readRuntimeEnvKey('LOCAL_TRANSLATE_API_URL') ||
      ''
    ).trim();
    const localTranslateApiKey = (
      readRuntimeEnvKey('LOCAL_TRANSLATE_API_KEY') ||
      'EMPTY'
    ).trim();
    const localTranslateModel = (
      readRuntimeEnvKey('LOCAL_TRANSLATE_MODEL') ||
      ''
    ).trim();
    const translateProvider = normalizeTranslateProvider(
      readRuntimeEnvKey('TRANSLATE_PROVIDER') ||
      '',
    );
    const localTranslateBatchSize = clampInt(
      readRuntimeEnvKey('LOCAL_TRANSLATE_MAX_BATCH_SIZE') ||
      '',
      LOCAL_TRANSLATE_DEFAULT_BATCH_SIZE,
      1,
      LOCAL_TRANSLATE_MAX_BATCH_SIZE,
    );
    const localTranslateTimeoutMs = clampInt(
      readRuntimeEnvKey('LOCAL_TRANSLATE_TIMEOUT_MS') ||
      '',
      LOCAL_TRANSLATE_DEFAULT_TIMEOUT_MS,
      1000,
      30000,
    );
    const localTranslateConfig: LocalTranslateConfig | null =
      localTranslateApiUrl && localTranslateModel
        ? {
            apiUrl: localTranslateApiUrl,
            apiKey: localTranslateApiKey || 'EMPTY',
            model: localTranslateModel,
            timeoutMs: localTranslateTimeoutMs,
            batchSize: localTranslateBatchSize,
          }
        : null;
    const niuAllowInsecureRaw = (
      readRuntimeEnvKey('NIUTRANS_TLS_ALLOW_INSECURE') ||
      ''
    ).trim();
    const niuAutoFallbackRaw = (
      readRuntimeEnvKey('NIUTRANS_TLS_AUTO_FALLBACK') ||
      'true'
    ).trim();
    const niuCaFile = (
      readRuntimeEnvKey('NIUTRANS_CA_CERT_FILE') ||
      ''
    ).trim();
    const niuTlsConfig = {
      allowInsecure: isTruthy(niuAllowInsecureRaw),
      autoFallback: !isFalsy(niuAutoFallbackRaw),
      caFile: niuCaFile || undefined,
    };

    if (!niuApiKey && !deeplApiKey && !localTranslateConfig) {
      return NextResponse.json(
        {
          ok: false,
          error: 'missing_translate_api_key',
          detail:
            'Set LOCAL_TRANSLATE_API_URL + LOCAL_TRANSLATE_MODEL, or DEEPL_API_KEY, or NIUTRANS_API_KEY in the frontend server runtime env (for Docker: frontend.environment) or a local .env/backend/.env file.',
        },
        { status: 503 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as TranslateRequestBody;
    const texts = normalizeTextList(body?.texts);
    const targetLang = sanitizeTargetLang(body?.targetLang);

    if (texts.length === 0) {
      return NextResponse.json({ ok: true, translations: [] as string[] });
    }

    const uniq = Array.from(new Set(texts));
    const translatable = uniq.filter(shouldAttemptTranslation);
    const missing = translatable.filter(
      (item) => !serverTranslationCache.has(translationCacheKey(targetLang, item)),
    );
    if (missing.length > 0) {
      let unresolved = [...missing];
      const providerOrder = resolveProviderOrder(translateProvider);

      for (const provider of providerOrder) {
        if (unresolved.length === 0) break;

        let translatedChunk: string[] | null = null;
        try {
          if (provider === 'local' && localTranslateConfig) {
            translatedChunk = await translateWithLocalModel(
              localTranslateConfig,
              unresolved,
              targetLang,
            );
          } else if (provider === 'deepl' && deeplApiKey) {
            translatedChunk = await translateBatch(deeplApiKey, unresolved, targetLang);
          } else if (provider === 'niutrans' && niuApiKey) {
            translatedChunk = await translateWithNiuTrans(
              niuApiKey,
              unresolved,
              targetLang,
              niuTlsConfig,
            );
          }
        } catch {
          translatedChunk = null;
        }

        if (!translatedChunk) continue;

        const nextUnresolved: string[] = [];
        for (let i = 0; i < unresolved.length; i += 1) {
          const source = unresolved[i];
          const candidate = translatedChunk[i] || '';
          if (isAcceptableTranslation(source, candidate, targetLang)) {
            serverTranslationCache.set(translationCacheKey(targetLang, source), candidate);
            continue;
          }
          nextUnresolved.push(source);
        }
        unresolved = nextUnresolved;
      }
      if (serverTranslationCache.size > SERVER_TRANSLATION_CACHE_LIMIT) {
        const overflow = serverTranslationCache.size - SERVER_TRANSLATION_CACHE_LIMIT;
        const keys = serverTranslationCache.keys();
        for (let i = 0; i < overflow; i += 1) {
          const first = keys.next();
          if (first.done) break;
          serverTranslationCache.delete(first.value);
        }
      }
    }

    const translatedUniq = uniq.map(
      (item) => serverTranslationCache.get(translationCacheKey(targetLang, item)) || item,
    );
    const map = new Map<string, string>();
    for (let i = 0; i < uniq.length; i += 1) {
      map.set(uniq[i], translatedUniq[i] || uniq[i]);
    }
    const mapped = texts.map((t) => map.get(t) || t);

    return NextResponse.json({
      ok: true,
      translations: mapped,
    });
  } catch (error) {
    const body = (await req.json().catch(() => ({}))) as TranslateRequestBody;
    const texts = normalizeTextList(body?.texts);
    return NextResponse.json(
      {
        ok: true,
        translations: texts,
        fallback: true,
        error: 'translate_failed_passthrough',
        detail: error instanceof Error ? error.message : 'unknown_error',
      },
      { status: 200 },
    );
  }
}
