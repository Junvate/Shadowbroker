'use client';

import { useEffect, useRef } from 'react';
import { lookupStaticZh } from '@/lib/zhStaticDictionary';

const TARGET_LANG = 'ZH-HANS';
const CACHE_KEY = 'sb_auto_zh_cache_v2';
const MAX_TEXT_LENGTH = 240;
const MAX_SCAN_ITEMS = 1400;
const MAX_PENDING_API_TEXTS = 64;
const MAX_CACHE_ENTRIES = 5000;
const PASS_INTERVAL_MS = 650;
const MUTATION_DELAY_MS = 80;
const ERROR_COOLDOWN_MS = 6000;

type TranslateTask =
  | {
      kind: 'text';
      source: string;
      node: Text;
    }
  | {
      kind: 'attr';
      source: string;
      node: HTMLElement;
      attr: 'placeholder' | 'title' | 'aria-label' | 'value';
    };

function shouldSkipElement(el: Element | null): boolean {
  if (!el) return true;
  if (el.closest('[data-no-auto-zh]')) return true;
  const tag = el.tagName.toLowerCase();
  if (['script', 'style', 'code', 'pre', 'noscript', 'svg'].includes(tag)) return true;
  if (el.closest('script,style,code,pre,noscript,svg')) return true;
  if (el.closest('.maplibregl-canvas-container')) return true;
  return false;
}

function shouldTranslateText(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (text.length > MAX_TEXT_LENGTH) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[\d\s\-:/.]+$/.test(text)) return false;
  return true;
}

function safeLoadCache(): Map<string, string> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return new Map();
    const data = JSON.parse(raw) as Record<string, string>;
    const entries = Object.entries(data).slice(-MAX_CACHE_ENTRIES);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function safeSaveCache(cache: Map<string, string>) {
  try {
    const entries = Array.from(cache.entries()).slice(-MAX_CACHE_ENTRIES);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // ignore persistence failures
  }
}

export default function AutoZhTranslator() {
  const cacheRef = useRef<Map<string, string>>(new Map());
  const noChangeRef = useRef<Set<string>>(new Set());
  const runningRef = useRef(false);
  const apiCooldownUntilRef = useRef(0);
  const cooldownUntilRef = useRef(0);
  const observerRef = useRef<MutationObserver | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    cacheRef.current = safeLoadCache();

    const applyTasks = async () => {
      if (runningRef.current) return;
      if (Date.now() < cooldownUntilRef.current) return;
      runningRef.current = true;
      try {
        const tasks: TranslateTask[] = [];
        let cacheDirty = false;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let current: Node | null = walker.nextNode();
        while (current && tasks.length < MAX_SCAN_ITEMS) {
          if (current.nodeType === Node.TEXT_NODE) {
            const textNode = current as Text;
            const parent = textNode.parentElement;
            const value = textNode.nodeValue || '';
            if (!shouldSkipElement(parent) && shouldTranslateText(value)) {
              tasks.push({ kind: 'text', source: value.trim(), node: textNode });
            }
          }
          current = walker.nextNode();
        }

        const attrNodes = document.querySelectorAll<HTMLElement>(
          'input[placeholder], textarea[placeholder], [title], [aria-label], button[value]',
        );
        for (const el of attrNodes) {
          if (tasks.length >= MAX_SCAN_ITEMS) break;
          if (shouldSkipElement(el)) continue;
          const attrs: Array<'placeholder' | 'title' | 'aria-label' | 'value'> = [
            'placeholder',
            'title',
            'aria-label',
            'value',
          ];
          for (const attr of attrs) {
            const raw = el.getAttribute(attr);
            if (!raw) continue;
            const value = raw.trim();
            if (!shouldTranslateText(value)) continue;
            tasks.push({ kind: 'attr', source: value, node: el, attr });
            if (tasks.length >= MAX_SCAN_ITEMS) break;
          }
        }

        if (tasks.length === 0) return;

        const cache = cacheRef.current;
        for (const task of tasks) {
          const staticZh = lookupStaticZh(task.source);
          if (staticZh && staticZh !== task.source) {
            cache.set(task.source, staticZh);
            cacheDirty = true;
          }
        }

        const pendingText = Array.from(new Set(tasks.map((t) => t.source)))
          .filter((source) => !cache.has(source) && !noChangeRef.current.has(source))
          .slice(0, MAX_PENDING_API_TEXTS);

        if (pendingText.length > 0 && Date.now() >= apiCooldownUntilRef.current) {
          const resp = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetLang: TARGET_LANG,
              texts: pendingText,
            }),
          });
          if (resp.ok) {
            const data = (await resp.json()) as { translations?: string[]; fallback?: boolean };
            const isFallback = Boolean(data?.fallback);
            const translated = Array.isArray(data?.translations) ? data.translations : [];
            pendingText.forEach((src, idx) => {
              const out = translated[idx];
              if (out && out !== src) {
                cache.set(src, out);
                cacheDirty = true;
                return;
              }
              if (!isFallback) {
                noChangeRef.current.add(src);
              }
            });
          } else {
            const err = await resp.json().catch(() => ({}));
            if ((err as { error?: string })?.error === 'missing_translate_api_key') {
              console.warn(
                '[AutoZhTranslator] Missing NIUTRANS_API_KEY in backend/.env (or DEEPL_API_KEY fallback).',
              );
            }
            cooldownUntilRef.current = Date.now() + 30_000;
            return;
          }
        }

        if (cacheDirty) {
          safeSaveCache(cache);
        }

        for (const task of tasks) {
          const translated = cache.get(task.source);
          if (!translated || translated === task.source) continue;
          if (task.kind === 'text') {
            if (task.node.isConnected) {
              task.node.nodeValue = translated;
            }
          } else if (task.node.isConnected) {
            task.node.setAttribute(task.attr, translated);
          }
        }
      } catch (error) {
        console.warn('[AutoZhTranslator] translate pass failed', error);
        apiCooldownUntilRef.current = Date.now() + ERROR_COOLDOWN_MS;
      } finally {
        runningRef.current = false;
      }
    };

    const schedule = (delay = MUTATION_DELAY_MS) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void applyTasks();
      }, delay);
    };

    schedule();
    observerRef.current = new MutationObserver(() => schedule(MUTATION_DELAY_MS));
    observerRef.current.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label', 'value'],
    });
    intervalRef.current = setInterval(() => {
      void applyTasks();
    }, PASS_INTERVAL_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  return null;
}
