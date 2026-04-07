'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bot,
  ChevronDown,
  ChevronUp,
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

interface AiQaPanelProps {
  config?: AiQaConfigOverrides;
  context?: Record<string, unknown>;
}

interface PersistedSettings {
  selectedAgentId: string;
  includeHistory: boolean;
  temperature: number;
  maxTokens: number;
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

export default function AiQaPanel({ config, context }: AiQaPanelProps) {
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
  const [requestError, setRequestError] = useState('');
  const [messages, setMessages] = useState<AiQaChatMessage[]>([
    makeAssistantMessage(resolvedConfig.welcomeMessage, defaultAgent?.id),
  ]);
  const [selectedAgentId, setSelectedAgentId] = useState(defaultAgent?.id || resolvedConfig.defaultAgentId);
  const [includeHistory, setIncludeHistory] = useState(resolvedConfig.transport.includeHistoryByDefault);
  const [temperature, setTemperature] = useState(defaultAgent?.defaultTemperature ?? 0.25);
  const [maxTokens, setMaxTokens] = useState(defaultAgent?.defaultMaxTokens ?? 420);

  const hydratedRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const storageMessageKey = `${resolvedConfig.storageKey}:messages`;
  const storageSettingKey = `${resolvedConfig.storageKey}:settings`;
  const storagePanelKey = `${resolvedConfig.storageKey}:panel`;

  const selectedAgent = useMemo(
    () => resolvedConfig.agents.find((agent) => agent.id === selectedAgentId) || defaultAgent,
    [resolvedConfig.agents, selectedAgentId, defaultAgent],
  );

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
        if (typeof parsed.selectedAgentId === 'string' && parsed.selectedAgentId) {
          setSelectedAgentId(parsed.selectedAgentId);
        }
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
  }, [resolvedConfig.maxMessages, storageMessageKey, storagePanelKey, storageSettingKey]);

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
      selectedAgentId,
      includeHistory,
      temperature,
      maxTokens,
    };
    window.localStorage.setItem(storageSettingKey, JSON.stringify(settings));
  }, [includeHistory, maxTokens, selectedAgentId, storageSettingKey, temperature]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    window.localStorage.setItem(
      storageMessageKey,
      JSON.stringify(trimMessages(messages, resolvedConfig.maxMessages)),
    );
  }, [messages, resolvedConfig.maxMessages, storageMessageKey]);

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
      setRequestError('');
      setIsSubmitting(true);

      try {
        const response = await requestAiQaAnswer(resolvedConfig, {
          message: prompt,
          history,
          agent: selectedAgent,
          options: {
            includeHistory,
            temperature,
            maxTokens,
          },
          metadata: context,
        });
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== pendingReply.id) return msg;
            return {
              ...msg,
              content: response.text,
              traceId: response.traceId,
              agentId: response.agentId || selectedAgent.id,
            };
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'AI 请求失败，请稍后重试';
        setRequestError(message);
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
      resolvedConfig,
      selectedAgent,
      temperature,
    ],
  );

  const clearConversation = () => {
    setMessages([makeAssistantMessage(resolvedConfig.welcomeMessage, selectedAgent?.id)]);
    setRequestError('');
    window.localStorage.removeItem(storageMessageKey);
  };

  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="w-full bg-[#0a0a0a]/90 backdrop-blur-sm border border-cyan-900/40 pointer-events-auto flex flex-col relative overflow-hidden"
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
                <select
                  value={selectedAgent?.id || ''}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setSelectedAgentId(nextId);
                    const nextAgent = resolvedConfig.agents.find((agent) => agent.id === nextId);
                    if (nextAgent) {
                      setTemperature(nextAgent.defaultTemperature ?? 0.25);
                      setMaxTokens(nextAgent.defaultMaxTokens ?? 420);
                    }
                  }}
                  className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-[10px] font-mono text-[var(--text-primary)] px-2 py-1.5 outline-none focus:border-cyan-400/60"
                >
                  {resolvedConfig.agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setShowAdvanced((prev) => !prev)}
                  className="px-2 py-1.5 border border-[var(--border-primary)] text-[9px] font-mono text-[var(--text-muted)] hover:text-cyan-300 hover:border-cyan-500/50 transition-colors"
                  title="参数配置"
                >
                  <Settings2 size={12} />
                </button>
                <button
                  onClick={clearConversation}
                  className="px-2 py-1.5 border border-[var(--border-primary)] text-[9px] font-mono text-[var(--text-muted)] hover:text-cyan-300 hover:border-cyan-500/50 transition-colors"
                  title="清空会话"
                >
                  <RotateCcw size={12} />
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
                      void submitPrompt(prompt);
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
                className="h-[230px] overflow-y-auto styled-scrollbar border border-[var(--border-primary)]/40 bg-[var(--bg-secondary)]/10 p-2 space-y-2"
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
                            : resolvedConfig.agents.find((agent) => agent.id === msg.agentId)?.label
                              || msg.agentId
                              || '助手'}
                        </span>
                        <span className="text-[7px] text-[var(--text-muted)] font-mono">
                          {formatTime(msg.createdAt)}
                        </span>
                      </div>
                      <pre className="text-[10px] text-[var(--text-primary)] font-mono whitespace-pre-wrap leading-relaxed">
                        {msg.content}
                      </pre>
                      {msg.traceId && (
                        <div className="text-[7px] text-[var(--text-muted)] font-mono mt-1">
                          追踪: {msg.traceId}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {requestError && (
                <div className="text-[9px] text-red-400 border border-red-500/40 bg-red-950/20 p-2 font-mono">
                  {requestError}
                </div>
              )}

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
