'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Plane,
  RotateCcw,
  SendHorizontal,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react';
import {
  DEFAULT_AI_QA_CONFIG,
  type AiQaChatMessage,
  type AiQaConfigOverrides,
  type AiQaRole,
  requestAiQaAnswer,
  resolveAiQaConfig,
} from '@/lib/aiQa';
import type { FlightQueryMatch } from '@/types/dashboard';

interface AiQaPanelProps {
  config?: AiQaConfigOverrides;
  context?: Record<string, unknown>;
  onFlightMatches?: (matches: FlightQueryMatch[]) => void;
  onFlyToFlight?: (lat: number, lng: number) => void;
}

interface PersistedSettings {
  includeHistory: boolean;
  temperature: number;
  maxTokens: number;
}

interface FlightExecutionRow {
  idx: number;
  callsign: string;
  origin: string;
  destination: string;
  altitude: string;
  speed: string;
  reason: string;
}

interface ExecutionSection {
  title: string;
  status: string;
  command: string;
  notes: string[];
  flights: FlightExecutionRow[];
}

interface ParsedExecutionMessage {
  tasks: number;
  succeeded: number;
  failed: number;
  sections: ExecutionSection[];
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}

function isRole(value: unknown): value is AiQaRole {
  return value === 'user' || value === 'assistant';
}

function isValidMessage(value: unknown): value is AiQaChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    isRole(obj.role) &&
    typeof obj.content === 'string' &&
    typeof obj.createdAt === 'number'
  );
}

function trimMessages(messages: AiQaChatMessage[], maxMessages: number): AiQaChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  return messages.slice(-maxMessages);
}

function makeAssistantMessage(content: string, agentId?: string): AiQaChatMessage {
  return {
    id: createId(),
    role: 'assistant',
    content,
    createdAt: Date.now(),
    agentId,
  };
}

function modeLabel(mode: 'mock' | 'http'): string {
  return mode === 'http' ? '在线接口' : '模拟模式';
}

function parseFlightExecutionLine(line: string): FlightExecutionRow | null {
  const match = line.match(
    /^(\d+)\.\s*(.*?)\s*\|\s*(.*?)\s*->\s*(.*?)\s*\|\s*alt=([^\s]+)\s*speed=([^\s]+)(?:\s*\|\s*(.*))?$/,
  );
  if (!match) return null;
  return {
    idx: parseInt(match[1], 10),
    callsign: match[2].trim(),
    origin: match[3].trim(),
    destination: match[4].trim(),
    altitude: match[5].trim(),
    speed: match[6].trim(),
    reason: (match[7] || '').trim(),
  };
}

function parseExecutionMessage(content: string): ParsedExecutionMessage | null {
  if (!content.startsWith('执行模式已开启')) return null;
  const lines = content.split('\n');
  const summaryLine = lines.find((line) => line.includes('任务数:') && line.includes('成功:'));
  const summaryMatch = summaryLine?.match(/任务数:\s*(\d+)\s*，\s*成功:\s*(\d+)\s*，\s*失败:\s*(\d+)/);
  const tasks = summaryMatch ? parseInt(summaryMatch[1], 10) : 0;
  const succeeded = summaryMatch ? parseInt(summaryMatch[2], 10) : 0;
  const failed = summaryMatch ? parseInt(summaryMatch[3], 10) : 0;

  const sections: ExecutionSection[] = [];
  let current: ExecutionSection | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('【') && line.endsWith('】')) {
      if (current) sections.push(current);
      current = {
        title: line.slice(1, -1),
        status: '',
        command: '',
        notes: [],
        flights: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('状态:')) {
      current.status = line.replace(/^状态:\s*/, '').trim();
      continue;
    }
    if (line.startsWith('命令:')) {
      current.command = line.replace(/^命令:\s*/, '').trim();
      continue;
    }
    const parsedFlight = parseFlightExecutionLine(line);
    if (parsedFlight) {
      current.flights.push(parsedFlight);
      continue;
    }
    current.notes.push(line);
  }
  if (current) sections.push(current);

  return {
    tasks,
    succeeded,
    failed,
    sections,
  };
}

export default function AiQaPanel({ config, context, onFlightMatches, onFlyToFlight }: AiQaPanelProps) {
  const resolvedConfig = useMemo(
    () => resolveAiQaConfig(config),
    [config],
  );

  const defaultAgent = useMemo(
    () => resolvedConfig.agents.find((agent) => agent.id === resolvedConfig.defaultAgentId)
      || resolvedConfig.agents[0]
      || DEFAULT_AI_QA_CONFIG.agents[0],
    [resolvedConfig],
  );

  const [isMinimized, setIsMinimized] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [input, setInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessionId, setSessionId] = useState(() => createId());
  const [messages, setMessages] = useState<AiQaChatMessage[]>([
    makeAssistantMessage(resolvedConfig.welcomeMessage, defaultAgent?.id),
  ]);
  const [includeHistory, setIncludeHistory] = useState(resolvedConfig.transport.includeHistoryByDefault);
  const [temperature, setTemperature] = useState(defaultAgent?.defaultTemperature ?? 0.25);
  const [maxTokens, setMaxTokens] = useState(defaultAgent?.defaultMaxTokens ?? 420);

  const hydratedRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const storageMessageKey = `${resolvedConfig.storageKey}:messages`;
  const storageSettingKey = `${resolvedConfig.storageKey}:settings`;
  const storagePanelKey = `${resolvedConfig.storageKey}:panel`;
  const storageSessionKey = `${resolvedConfig.storageKey}:session`;

  const selectedAgent = defaultAgent;

  useEffect(() => {
    try {
      const rawPanelState = window.localStorage.getItem(storagePanelKey);
      if (rawPanelState) {
        const parsed = JSON.parse(rawPanelState) as { minimized?: boolean; advanced?: boolean };
        setIsMinimized(Boolean(parsed.minimized));
        setShowAdvanced(Boolean(parsed.advanced));
      }
    } catch {
      /* ignore bad local state */
    }

    try {
      const rawSettings = window.localStorage.getItem(storageSettingKey);
      if (rawSettings) {
        const parsed = JSON.parse(rawSettings) as Partial<PersistedSettings>;
        if (typeof parsed.includeHistory === 'boolean') {
          setIncludeHistory(parsed.includeHistory);
        }
        if (typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)) {
          setTemperature(Math.max(0, Math.min(1.2, parsed.temperature)));
        }
        if (typeof parsed.maxTokens === 'number' && Number.isFinite(parsed.maxTokens)) {
          setMaxTokens(Math.max(64, Math.min(4096, Math.round(parsed.maxTokens))));
        }
      }
    } catch {
      /* ignore bad local state */
    }

    try {
      const rawSessionId = window.localStorage.getItem(storageSessionKey);
      if (rawSessionId && rawSessionId.trim()) {
        setSessionId(rawSessionId.trim());
      }
    } catch {
      /* ignore bad local state */
    }

    try {
      const rawMessages = window.localStorage.getItem(storageMessageKey);
      if (rawMessages) {
        const parsed = JSON.parse(rawMessages);
        if (Array.isArray(parsed)) {
          const next = parsed.filter(isValidMessage);
          if (next.length > 0) {
            setMessages(trimMessages(next, resolvedConfig.maxMessages));
          }
        }
      }
    } catch {
      /* ignore bad local state */
    }

    hydratedRef.current = true;
  }, [resolvedConfig.maxMessages, storageMessageKey, storagePanelKey, storageSessionKey, storageSettingKey]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    window.localStorage.setItem(storagePanelKey, JSON.stringify({
      minimized: isMinimized,
      advanced: showAdvanced,
    }));
  }, [isMinimized, showAdvanced, storagePanelKey]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const settings: PersistedSettings = {
      includeHistory,
      temperature,
      maxTokens,
    };
    window.localStorage.setItem(storageSettingKey, JSON.stringify(settings));
  }, [includeHistory, maxTokens, storageSettingKey, temperature]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    window.localStorage.setItem(
      storageMessageKey,
      JSON.stringify(trimMessages(messages, resolvedConfig.maxMessages)),
    );
  }, [messages, resolvedConfig.maxMessages, storageMessageKey]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    window.localStorage.setItem(storageSessionKey, sessionId);
  }, [sessionId, storageSessionKey]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isMinimized]);

  const submitPrompt = useCallback(
    async (promptOverride?: string) => {
      const prompt = String(promptOverride ?? input).trim();
      if (!prompt || isSubmitting || !selectedAgent) return;

      const userMessage: AiQaChatMessage = {
        id: createId(),
        role: 'user',
        content: prompt,
        createdAt: Date.now(),
        agentId: selectedAgent.id,
      };

      const pendingReply: AiQaChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '正在分析中...',
        createdAt: Date.now(),
        agentId: selectedAgent.id,
      };

      const requestHistoryBase = includeHistory
        ? messages.filter((msg) => msg.role === 'user' || msg.role === 'assistant')
        : [];
      const history = trimMessages(
        [...requestHistoryBase, userMessage],
        resolvedConfig.maxMessages,
      );

      setMessages((prev) => trimMessages([...prev, userMessage, pendingReply], resolvedConfig.maxMessages));
      setInput('');
      setIsSubmitting(true);

      try {
        const response = await requestAiQaAnswer(resolvedConfig, {
          message: prompt,
          history,
          agent: selectedAgent,
          sessionId: includeHistory ? sessionId : `${sessionId}:oneshot:${createId()}`,
          options: {
            includeHistory,
            temperature,
            maxTokens,
          },
          metadata: context,
        });
        const isFlightQuery = Boolean(response.flightQuery);
        const matchedFlights = isFlightQuery ? (response.flightMatches || []) : [];
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== pendingReply.id) return msg;
            return {
              ...msg,
              content: response.text,
              traceId: response.traceId,
              agentId: response.agentId || selectedAgent.id,
              flightQuery: isFlightQuery || undefined,
              flightMatches: matchedFlights.length > 0 ? matchedFlights : undefined,
            };
          }),
        );
        onFlightMatches?.(matchedFlights);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'AI 请求失败，请稍后重试';
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== pendingReply.id) return msg;
            return {
              ...msg,
              content: `请求失败：${message}`,
            };
          }),
        );
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      context,
      includeHistory,
      input,
      isSubmitting,
      maxTokens,
      messages,
      onFlightMatches,
      resolvedConfig,
      sessionId,
      selectedAgent,
      temperature,
    ],
  );

  const clearConversation = () => {
    const nextSessionId = createId();
    setInput('');
    setIsSubmitting(false);
    setSessionId(nextSessionId);
    setMessages([makeAssistantMessage(resolvedConfig.welcomeMessage, selectedAgent?.id)]);
    onFlightMatches?.([]);
    try {
      window.localStorage.removeItem(storageMessageKey);
      window.localStorage.setItem(storageSessionKey, nextSessionId);
    } catch {
      /* ignore storage failures */
    }
  };

  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="w-full max-w-full bg-[#0a0a0a]/90 backdrop-blur-sm border border-cyan-900/40 pointer-events-auto flex flex-col relative overflow-hidden"
    >
      <div
        className="px-3 py-2.5 border-b border-[var(--border-primary)]/50 flex items-center justify-between cursor-pointer hover:bg-[var(--hover-accent)] transition-colors"
        onClick={() => setIsMinimized((prev) => !prev)}
      >
        <div className="flex items-center gap-2">
          <Bot size={14} className="text-cyan-400" />
          <div className="flex flex-col leading-tight">
            <span className="text-[10px] font-mono tracking-[0.2em] text-[var(--text-primary)]">
              {resolvedConfig.title}
            </span>
            <span className="text-[8px] font-mono tracking-[0.15em] text-[var(--text-muted)]">
              {resolvedConfig.subtitle}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-[8px] font-mono border px-1.5 py-0.5 ${
              resolvedConfig.transport.mode === 'http'
                ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
                : 'text-amber-300 border-amber-500/40 bg-amber-500/10'
            }`}
          >
            {modeLabel(resolvedConfig.transport.mode)}
          </span>
          {isMinimized ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!isMinimized && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="p-3 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-[10px] font-mono text-[var(--text-primary)] px-2 py-1.5">
                  {selectedAgent?.label || 'AI 助手'}
                </div>
                <button
                  onClick={() => setShowAdvanced((prev) => !prev)}
                  className="px-2 py-1.5 border border-[var(--border-primary)] text-[9px] font-mono text-[var(--text-muted)] hover:text-cyan-300 hover:border-cyan-500/50 transition-colors"
                  title="参数配置"
                >
                  <Settings2 size={12} />
                </button>
                <button
                  onClick={clearConversation}
                  className="inline-flex items-center gap-1 px-2 py-1.5 border border-[var(--border-primary)] text-[9px] font-mono text-[var(--text-muted)] hover:text-cyan-300 hover:border-cyan-500/50 transition-colors"
                  title="清空聊天记录"
                >
                  <RotateCcw size={12} />
                  <span>清空记录</span>
                </button>
              </div>

              {selectedAgent && (
                <div className="text-[9px] text-[var(--text-muted)] font-mono border border-[var(--border-primary)]/40 bg-[var(--bg-secondary)]/20 px-2.5 py-2">
                  {selectedAgent.description}
                </div>
              )}

              <AnimatePresence initial={false}>
                {showAdvanced && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="border border-[var(--border-primary)]/50 bg-[var(--bg-secondary)]/20 p-2.5 space-y-2.5">
                      <div className="flex items-center gap-2 text-[9px] font-mono text-cyan-400 tracking-widest">
                        <SlidersHorizontal size={11} />
                        运行参数
                      </div>
                      <div className="space-y-2">
                        <label className="flex items-center justify-between text-[9px] font-mono text-[var(--text-secondary)]">
                          <span>温度</span>
                          <span>{temperature.toFixed(2)}</span>
                        </label>
                        <input
                          type="range"
                          min={0}
                          max={1.2}
                          step={0.05}
                          value={temperature}
                          onChange={(e) => setTemperature(parseFloat(e.target.value))}
                          className="w-full accent-cyan-500"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="flex items-center justify-between text-[9px] font-mono text-[var(--text-secondary)]">
                          <span>最大令牌数</span>
                          <span>{maxTokens}</span>
                        </label>
                        <input
                          type="range"
                          min={128}
                          max={2048}
                          step={32}
                          value={maxTokens}
                          onChange={(e) => setMaxTokens(parseInt(e.target.value, 10))}
                          className="w-full accent-cyan-500"
                        />
                      </div>
                      <label className="flex items-center justify-between text-[9px] font-mono text-[var(--text-secondary)]">
                        <span>携带历史上下文</span>
                        <input
                          type="checkbox"
                          checked={includeHistory}
                          onChange={(e) => setIncludeHistory(e.target.checked)}
                          className="accent-cyan-500"
                        />
                      </label>
                      <div className="text-[8px] font-mono text-emerald-300 border border-emerald-500/30 bg-emerald-950/20 px-2 py-1.5">
                        默认始终先走 nanobot 对话。模型会根据问题自行决定是否调用本地航班查询技能。
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex flex-wrap gap-1.5">
                {resolvedConfig.quickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => {
                      setInput(prompt);
                    }}
                    disabled={isSubmitting}
                    className="text-[8px] font-mono text-cyan-300/90 border border-cyan-500/30 bg-cyan-950/20 px-2 py-1 hover:bg-cyan-900/30 hover:border-cyan-400/50 transition-colors disabled:opacity-40"
                  >
                    {prompt}
                  </button>
                ))}
              </div>

              <div
                ref={messagesRef}
                className="h-[300px] overflow-y-auto styled-scrollbar border border-[var(--border-primary)]/40 bg-[var(--bg-secondary)]/10 p-2 space-y-2"
              >
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[92%] border px-2 py-1.5 ${
                        msg.role === 'user'
                          ? 'border-cyan-500/40 bg-cyan-950/25'
                          : 'border-emerald-500/35 bg-emerald-950/20'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <span
                          className={`text-[8px] font-mono tracking-widest ${
                            msg.role === 'user' ? 'text-cyan-300' : 'text-emerald-300'
                          }`}
                        >
                          {msg.role === 'user'
                            ? '你'
                            : selectedAgent?.label || 'AI 助手'}
                        </span>
                        <span className="text-[7px] text-[var(--text-muted)] font-mono">
                          {formatTime(msg.createdAt)}
                        </span>
                      </div>
                      {(() => {
                        const execution = msg.role === 'assistant' ? parseExecutionMessage(msg.content) : null;
                        if (!execution) {
                          return (
                            <pre className="text-[10px] text-[var(--text-primary)] font-mono whitespace-pre-wrap leading-relaxed">
                              {msg.content}
                            </pre>
                          );
                        }
                        return (
                          <div className="space-y-2">
                            <div className="grid grid-cols-3 gap-1">
                              <div className="border border-cyan-500/30 bg-cyan-950/20 px-1.5 py-1 text-[8px] font-mono text-cyan-300">
                                任务: {execution.tasks}
                              </div>
                              <div className="border border-emerald-500/30 bg-emerald-950/20 px-1.5 py-1 text-[8px] font-mono text-emerald-300">
                                成功: {execution.succeeded}
                              </div>
                              <div className="border border-red-500/30 bg-red-950/20 px-1.5 py-1 text-[8px] font-mono text-red-300">
                                失败: {execution.failed}
                              </div>
                            </div>

                            <div className="grid grid-cols-3 gap-1 text-[8px] font-mono">
                              <div className="border border-[var(--border-primary)]/40 px-1.5 py-1 text-[var(--text-secondary)]">
                                1. 解析问题
                              </div>
                              <div className="border border-[var(--border-primary)]/40 px-1.5 py-1 text-[var(--text-secondary)]">
                                2. 匹配技能
                              </div>
                              <div className="border border-[var(--border-primary)]/40 px-1.5 py-1 text-[var(--text-secondary)]">
                                3. 执行并汇总
                              </div>
                            </div>

                            {execution.sections.map((section, sectionIdx) => (
                              <div
                                key={`${section.title}-${sectionIdx}`}
                                className="border border-[var(--border-primary)]/50 bg-[var(--bg-secondary)]/20 p-2 space-y-1.5"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[9px] font-mono text-[var(--text-primary)]">
                                    {section.title}
                                  </span>
                                  <span className="text-[8px] font-mono text-emerald-300 border border-emerald-500/30 bg-emerald-950/20 px-1 py-0.5">
                                    {section.status || '完成'}
                                  </span>
                                </div>

                                {section.command && (
                                  <pre className="text-[8px] text-[var(--text-muted)] font-mono whitespace-pre-wrap break-all border border-[var(--border-primary)]/30 bg-[var(--bg-primary)]/30 px-1.5 py-1">
                                    {section.command}
                                  </pre>
                                )}

                                {section.flights.length > 0 && (
                                  <div className="overflow-x-auto border border-[var(--border-primary)]/30">
                                    <table className="min-w-full text-[8px] font-mono">
                                      <thead className="bg-[var(--bg-primary)]/60 text-[var(--text-secondary)]">
                                        <tr>
                                          <th className="text-left px-1.5 py-1">#</th>
                                          <th className="text-left px-1.5 py-1">航班</th>
                                          <th className="text-left px-1.5 py-1">航线</th>
                                          <th className="text-left px-1.5 py-1">高度</th>
                                          <th className="text-left px-1.5 py-1">速度</th>
                                          <th className="text-left px-1.5 py-1">命中</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {section.flights.map((row) => (
                                          <tr key={`${section.title}-${row.idx}`} className="border-t border-[var(--border-primary)]/20">
                                            <td className="px-1.5 py-1 text-[var(--text-muted)]">{row.idx}</td>
                                            <td className="px-1.5 py-1 text-[var(--text-primary)]">{row.callsign}</td>
                                            <td className="px-1.5 py-1 text-[var(--text-secondary)] whitespace-nowrap">
                                              {row.origin} → {row.destination}
                                            </td>
                                            <td className="px-1.5 py-1 text-[var(--text-primary)]">{row.altitude}</td>
                                            <td className="px-1.5 py-1 text-[var(--text-primary)]">{row.speed}</td>
                                            <td className="px-1.5 py-1 text-[var(--text-muted)]">{row.reason || '-'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}

                                {section.notes.length > 0 && (
                                  <pre className="text-[8px] text-[var(--text-secondary)] font-mono whitespace-pre-wrap leading-relaxed">
                                    {section.notes.join('\n')}
                                  </pre>
                                )}
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                      {msg.role === 'assistant' && msg.flightMatches && msg.flightMatches.length > 0 && (
                        <div className="mt-1.5 space-y-1">
                          <div className="text-[8px] font-mono text-red-300/80 tracking-widest">
                            已在地图上高亮 {msg.flightMatches.length} 架航班
                          </div>
                          <div className="grid gap-1">
                            {msg.flightMatches.map((fm) => (
                              <button
                                key={fm.id}
                                type="button"
                                className="flex items-center gap-1.5 w-full text-left border border-red-500/30 bg-red-950/20 hover:bg-red-950/40 px-1.5 py-1 transition-colors group"
                                onClick={() => onFlyToFlight?.(fm.lat, fm.lng)}
                              >
                                <Plane className="h-3 w-3 text-red-400 shrink-0 group-hover:text-red-300" />
                                <span className="text-[8px] font-mono text-red-300 tracking-wider truncate">
                                  {fm.callsign || fm.icao24.toUpperCase()}
                                </span>
                                <span className="ml-auto text-[7px] font-mono text-[var(--text-muted)] shrink-0">
                                  {fm.sourceBucket.replace('_', ' ')}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {msg.role === 'assistant' && msg.flightQuery && !msg.flightMatches?.length && (
                        <div className="mt-1.5 flex items-center gap-1 text-[8px] font-mono text-amber-400/80 tracking-widest">
                          <Plane className="h-3 w-3 shrink-0" />
                          未找到匹配的在线航班
                        </div>
                      )}
                      {msg.traceId && (
                        <div className="text-[7px] text-[var(--text-muted)] font-mono mt-1">
                          追踪: {msg.traceId}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void submitPrompt();
                    }
                  }}
                  rows={3}
                  placeholder={resolvedConfig.placeholder}
                  className="w-full resize-none bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-[10px] text-[var(--text-primary)] font-mono px-2.5 py-2 outline-none focus:border-cyan-400/60"
                />
                <div className="flex justify-between items-center">
                  <span className="text-[8px] text-[var(--text-muted)] font-mono flex items-center gap-1">
                    <Bot size={10} />
                    {resolvedConfig.transport.endpoint}
                  </span>
                  <button
                    onClick={() => void submitPrompt()}
                    disabled={isSubmitting || !input.trim()}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-[10px] font-mono border border-cyan-500/50 text-cyan-300 bg-cyan-950/25 hover:bg-cyan-900/35 transition-colors disabled:opacity-40"
                  >
                    <SendHorizontal size={11} />
                    {isSubmitting ? '发送中' : resolvedConfig.sendButtonLabel}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
