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
    id: 'sentinel-ops',
    label: 'Sentinel Ops',
    description: '偏战术态势和告警分析，适合快速研判',
    systemPrompt:
      'You are Sentinel Ops. Respond with concise tactical intelligence and concrete actions.',
    defaultTemperature: 0.25,
    defaultMaxTokens: 420,
  },
  {
    id: 'mesh-analyst',
    label: 'Mesh Analyst',
    description: '偏 Mesh / Wormhole / Agent 任务编排',
    systemPrompt:
      'You are Mesh Analyst. Focus on mesh-network operations, trust boundaries, and task routing.',
    defaultTemperature: 0.2,
    defaultMaxTokens: 520,
  },
  {
    id: 'briefing-copilot',
    label: 'Briefing Copilot',
    description: '偏简报生成，输出结构化结论',
    systemPrompt:
      'You are Briefing Copilot. Produce structured briefings with summary, risks, and next steps.',
    defaultTemperature: 0.35,
    defaultMaxTokens: 600,
  },
];

export const DEFAULT_AI_QA_CONFIG: AiQaPanelConfig = {
  title: 'AI 问答',
  subtitle: 'Agent-ready Console',
  welcomeMessage:
    'AI 问答模块已就绪。当前是前端壳体（可先用 mock），你后续可直接接入系统 Agent。',
  placeholder: '输入问题、任务指令或情报分析请求...',
  sendButtonLabel: '发送',
  storageKey: 'sb_ai_qa_v1',
  maxMessages: 48,
  quickPrompts: [
    '总结当前威胁态势并给出 3 条行动建议',
    '基于地图选中目标，给我一份 60 秒简报',
    '把这个任务拆分为可执行的 agent 子任务',
    '输出一份可复制到工单系统的行动清单',
  ],
  defaultAgentId: 'sentinel-ops',
  agents: DEFAULT_AGENTS,
  transport: {
    mode: 'mock',
    endpoint: '/api/ai/qa',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    timeoutMs: 25000,
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
  return `AI request failed (HTTP ${status})`;
}

function buildMockResponse(request: AiQaRequestPayload): string {
  const shortQuestion = request.message.length > 140
    ? `${request.message.slice(0, 140)}...`
    : request.message;
  return [
    `[${request.agent.label}] 收到请求：${shortQuestion}`,
    '',
    '这是前端 mock 回答。你后续接入系统 agent 时，只需改 `src/lib/aiQa.ts` 的 transport 或 requester。',
    '',
    '建议下一步：',
    '1. 接入真实接口并返回 `text` 字段',
    '2. 将 `agent.id` 映射到后端 agent router',
    '3. 在 metadata 里透传当前地图/实体上下文',
  ].join('\n');
}

async function requestViaHttp(
  config: AiQaPanelConfig,
  request: AiQaRequestPayload,
): Promise<AiQaResponsePayload> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), config.transport.timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${config.transport.endpoint}`, {
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
      throw new Error('AI response is missing text content');
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
      throw new Error(`AI request timed out after ${config.transport.timeoutMs}ms`);
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
