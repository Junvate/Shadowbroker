import { API_BASE } from '@/lib/api';

export type AiQaRole = 'user' | 'assistant';

export interface AiQaChatMessage {
  id: string;
  role: AiQaRole;
  content: string;
  createdAt: number;
  agentId?: string;
  traceId?: string;
}

export interface AiQaAgentConfig {
  id: string;
  label: string;
  description: string;
  systemPrompt: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
}

export interface AiQaTransportConfig {
  mode: 'mock' | 'http';
  endpoint: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  timeoutMs: number;
  includeHistoryByDefault: boolean;
}

export interface AiQaRequestPayload {
  message: string;
  history: AiQaChatMessage[];
  agent: AiQaAgentConfig;
  options: {
    temperature: number;
    maxTokens: number;
    includeHistory: boolean;
    executeMode?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface AiQaResponsePayload {
  text: string;
  traceId?: string;
  agentId?: string;
  raw?: unknown;
}

export interface AiQaPanelConfig {
  title: string;
  subtitle: string;
  welcomeMessage: string;
  placeholder: string;
  sendButtonLabel: string;
  storageKey: string;
  maxMessages: number;
  quickPrompts: string[];
  defaultAgentId: string;
  agents: AiQaAgentConfig[];
  transport: AiQaTransportConfig;
  requester?: (request: AiQaRequestPayload) => Promise<AiQaResponsePayload>;
}

export type AiQaConfigOverrides = Partial<
  Omit<AiQaPanelConfig, 'transport' | 'agents'>
> & {
  transport?: Partial<AiQaTransportConfig>;
  agents?: AiQaAgentConfig[];
};

const DEFAULT_AGENTS: AiQaAgentConfig[] = [
  {
    id: 'shadowbroker-ai',
    label: 'AI 助手',
    description: '通用情报问答与行动建议',
    systemPrompt:
      '你是 Shadowbroker AI 助手。请使用中文给出简洁、准确、可执行的分析与建议。',
    defaultTemperature: 0.25,
    defaultMaxTokens: 520,
  },
];

export const DEFAULT_AI_QA_CONFIG: AiQaPanelConfig = {
  title: 'AI 问答',
  subtitle: '情报分析与问答',
  welcomeMessage:
    'AI 问答模块已就绪。已接入本地技能上下文（flight-query / osint-query）。建议开启可执行模式，仅返回真实执行结果。',
  placeholder: '输入问题、任务指令或情报分析请求...',
  sendButtonLabel: '发送',
  storageKey: 'sb_ai_qa_v1',
  maxMessages: 48,
  quickPrompts: [
    '使用 $shadowbroker-osint-query，读取 /api/live-data/fast，给我 flights/ships/sigint 的关键概览与字段样例。',
    '使用 $shadowbroker-flight-query，按目的地关键词 tokyo 查询航班，返回前 20 条并按 match_score 排序。',
    '检查 backend/data 的核心数据集可用性，列出缺失文件和异常字段。',
    '读取 /api/health 与 /api/live-data/fast，输出当前系统健康状态和告警项。',
    '基于当前地图上下文，生成 60 秒行动简报（结论/风险/下一步）。',
  ],
  defaultAgentId: 'shadowbroker-ai',
  agents: DEFAULT_AGENTS,
  transport: {
    mode: 'http',
    endpoint: '/api/ai/qa',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    timeoutMs: 90000,
    includeHistoryByDefault: true,
  },
};

export function resolveAiQaConfig(overrides?: AiQaConfigOverrides): AiQaPanelConfig {
  const nextAgents = overrides?.agents && overrides.agents.length > 0
    ? overrides.agents
    : DEFAULT_AI_QA_CONFIG.agents;

  const merged: AiQaPanelConfig = {
    ...DEFAULT_AI_QA_CONFIG,
    ...overrides,
    agents: nextAgents,
    transport: {
      ...DEFAULT_AI_QA_CONFIG.transport,
      ...(overrides?.transport || {}),
      headers: {
        ...DEFAULT_AI_QA_CONFIG.transport.headers,
        ...(overrides?.transport?.headers || {}),
      },
    },
  };

  const hasDefaultAgent = merged.agents.some((agent) => agent.id === merged.defaultAgentId);
  if (!hasDefaultAgent) {
    merged.defaultAgentId = merged.agents[0]?.id || DEFAULT_AI_QA_CONFIG.defaultAgentId;
  }
  return merged;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function extractTextFromResponse(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const directKeys = ['answer', 'text', 'message', 'output_text'];
  for (const key of directKeys) {
    const value = asString(payload[key]);
    if (value) return value;
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) continue;
      const content = item.content;
      if (!Array.isArray(content)) continue;
      for (const chunk of content) {
        if (!isRecord(chunk)) continue;
        const value = asString(chunk.text);
        if (value) return value;
      }
    }
  }

  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (isRecord(first)) {
      const firstMessage = first.message;
      if (isRecord(firstMessage)) {
        const content = firstMessage.content;
        if (typeof content === 'string' && content.trim()) return content.trim();
      }
    }
  }

  return null;
}

function extractErrorMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    const detail = asString(payload.detail);
    if (detail) return detail;
    const error = payload.error;
    if (isRecord(error)) {
      const message = asString(error.message);
      if (message) return message;
    }
    const message = asString(payload.message);
    if (message) return message;
  }
  return `AI 请求失败（HTTP ${status}）`;
}

function buildMockResponse(request: AiQaRequestPayload): string {
  const shortQuestion = request.message.length > 140
    ? `${request.message.slice(0, 140)}...`
    : request.message;
  return [
    `[${request.agent.label}] 收到请求：${shortQuestion}`,
    '',
    '这是前端模拟回答。你后续接入系统 Agent 时，只需改 `src/lib/aiQa.ts` 的 transport 或 requester。',
    '',
    '建议下一步：',
    '1. 接入真实接口并返回 `text` 字段',
    '2. 将 `agent.id` 映射到后端 agent router',
    '3. 在 metadata 里透传当前地图/实体上下文',
  ].join('\n');
}

function resolveTransportUrl(endpoint: string): string {
  const trimmed = String(endpoint || '').trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${API_BASE}${trimmed}`;
}

async function requestViaHttp(
  config: AiQaPanelConfig,
  request: AiQaRequestPayload,
): Promise<AiQaResponsePayload> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), config.transport.timeoutMs);
  try {
    const res = await fetch(resolveTransportUrl(config.transport.endpoint), {
      method: config.transport.method,
      headers: config.transport.headers,
      body: JSON.stringify({
        message: request.message,
        agent_id: request.agent.id,
        agent: request.agent,
        options: request.options,
        history: request.options.includeHistory ? request.history : [],
        metadata: request.metadata || {},
      }),
      signal: controller.signal,
    });
    const payload = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
      throw new Error(extractErrorMessage(payload, res.status));
    }
    const text = extractTextFromResponse(payload);
    if (!text) {
      throw new Error('AI 返回结果缺少文本内容');
    }
    const traceId = isRecord(payload) ? asString(payload.trace_id) : null;
    const agentId = isRecord(payload) ? asString(payload.agent_id) : null;
    return {
      text,
      traceId: traceId || undefined,
      agentId: agentId || request.agent.id,
      raw: payload,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`AI 请求超时（>${config.transport.timeoutMs}ms）`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function requestAiQaAnswer(
  config: AiQaPanelConfig,
  request: AiQaRequestPayload,
): Promise<AiQaResponsePayload> {
  if (config.requester) {
    return config.requester(request);
  }
  if (config.transport.mode === 'http') {
    return requestViaHttp(config, request);
  }
  await new Promise((resolve) => window.setTimeout(resolve, 420));
  return {
    text: buildMockResponse(request),
    agentId: request.agent.id,
  };
}
