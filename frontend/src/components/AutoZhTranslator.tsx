'use client';

import { useEffect, useRef } from 'react';
import { useTheme, type UiLanguage } from '@/lib/ThemeContext';
import { lookupStaticUiText } from '@/lib/zhStaticDictionary';
import { TRANSLATION_MAX_TEXT_LENGTH } from '@/lib/translationConstants';

const CACHE_KEY = 'sb_auto_ui_cache_v1';
const MAX_SCAN_ITEMS = 1400;
const MAX_PENDING_API_TEXTS = 24;
const MAX_CACHE_ENTRIES = 5000;
const MUTATION_DELAY_MS = 180;
const VISIBILITY_RECHECK_MS = 1200;
const ERROR_COOLDOWN_MS = 6000;
const NO_RESULT_RETRY_MS = 60000;

type TranslateTask =
  | {
      kind: 'text';
      source: string;
      node: Text;
      current: string;
    }
  | {
      kind: 'attr';
      source: string;
      node: HTMLElement;
      attr: 'placeholder' | 'title' | 'aria-label' | 'value';
      current: string;
    };

type NodeTranslationState = {
  source: string;
  applied: Partial<Record<UiLanguage, string>>;
};

function shouldSkipElement(el: Element | null): boolean {
  if (!el) return true;
  if (el.closest('[data-no-auto-zh]')) return true;
  if (el.closest('[translate="no"]')) return true;
  if (el.closest('.notranslate')) return true;
  if (el.closest('[lang="en"]')) return true;
  const tag = el.tagName.toLowerCase();
  if (['script', 'style', 'code', 'pre', 'noscript', 'svg'].includes(tag)) return true;
  if (el.closest('script,style,code,pre,noscript,svg')) return true;
  if (el.closest('.maplibregl-canvas-container')) return true;
  return false;
}

function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

function shouldTranslateText(raw: string, uiLanguage: UiLanguage): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (text.length > TRANSLATION_MAX_TEXT_LENGTH) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[\d\s\-:/.]+$/.test(text)) return false;
  return uiLanguage === 'zh' ? /[A-Za-z]/.test(text) : /[\u4e00-\u9fff]/.test(text);
}

function isAcceptableTranslation(source: string, candidate: string, uiLanguage: UiLanguage): boolean {
  const src = normalizeText(source);
  const out = normalizeText(candidate);
  if (!src || !out || src === out) return false;
  if (uiLanguage === 'zh') return /[\u4e00-\u9fff]/.test(out);
  return /[A-Za-z]/.test(out);
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
  const { uiLanguage } = useTheme();
  const cacheRef = useRef<Map<string, string>>(new Map());
  const retryAfterRef = useRef<Map<string, number>>(new Map());
  const textStateRef = useRef<WeakMap<Text, NodeTranslationState>>(new WeakMap());
  const attrStateRef = useRef<WeakMap<HTMLElement, Partial<Record<'placeholder' | 'title' | 'aria-label' | 'value', NodeTranslationState>>>>(new WeakMap());
  const runningRef = useRef(false);
  const apiCooldownUntilRef = useRef(0);
  const cooldownUntilRef = useRef(0);
  const observerRef = useRef<MutationObserver | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cacheRef.current = safeLoadCache();

    const getTargetLang = () => (uiLanguage === 'zh' ? 'ZH-HANS' : 'EN');
    const cacheKeyFor = (source: string) => `${uiLanguage}::${source}`;

    const resolveTextState = (node: Text, current: string): NodeTranslationState => {
      const existing = textStateRef.current.get(node);
      if (!existing) {
        const created = { source: current, applied: {} };
        textStateRef.current.set(node, created);
        return created;
      }
      const normalizedCurrent = normalizeText(current);
      const normalizedSource = normalizeText(existing.source);
      const appliedValues = Object.values(existing.applied).map((value) => normalizeText(value || ''));
      if (
        normalizedCurrent &&
        normalizedCurrent !== normalizedSource &&
        !appliedValues.includes(normalizedCurrent)
      ) {
        existing.source = current;
        existing.applied = {};
      }
      return existing;
    };

    const resolveAttrState = (
      node: HTMLElement,
      attr: 'placeholder' | 'title' | 'aria-label' | 'value',
      current: string,
    ): NodeTranslationState => {
      let existing = attrStateRef.current.get(node);
      if (!existing) {
        existing = {};
        attrStateRef.current.set(node, existing);
      }
      const attrState = existing[attr];
      if (!attrState) {
        const created = { source: current, applied: {} };
        existing[attr] = created;
        return created;
      }
      const normalizedCurrent = normalizeText(current);
      const normalizedSource = normalizeText(attrState.source);
      const appliedValues = Object.values(attrState.applied).map((value) => normalizeText(value || ''));
      if (
        normalizedCurrent &&
        normalizedCurrent !== normalizedSource &&
        !appliedValues.includes(normalizedCurrent)
      ) {
        attrState.source = current;
        attrState.applied = {};
      }
      return attrState;
    };

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
            const currentValue = textNode.nodeValue || '';
            if (!shouldSkipElement(parent)) {
              const state = resolveTextState(textNode, currentValue);
              const source = state.source.trim();
              if (source) {
                tasks.push({ kind: 'text', source, current: currentValue, node: textNode });
              }
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
            const state = resolveAttrState(el, attr, raw);
            const source = state.source.trim();
            if (!source) continue;
            tasks.push({ kind: 'attr', source, current: raw, node: el, attr });
            if (tasks.length >= MAX_SCAN_ITEMS) break;
          }
        }

        if (tasks.length === 0) return;

        const cache = cacheRef.current;
        for (const task of tasks) {
          const staticText = lookupStaticUiText(task.source, uiLanguage);
          if (staticText && staticText !== task.source) {
            cache.set(cacheKeyFor(task.source), staticText);
            cacheDirty = true;
          }
        }

        const pendingText = Array.from(new Set(tasks.map((t) => t.source)))
          .filter((source) => shouldTranslateText(source, uiLanguage))
          .filter((source) => {
            if (cache.has(cacheKeyFor(source))) return false;
            const retryAfter = retryAfterRef.current.get(cacheKeyFor(source)) || 0;
            return retryAfter <= Date.now();
          })
          .slice(0, MAX_PENDING_API_TEXTS);

        if (pendingText.length > 0 && Date.now() >= apiCooldownUntilRef.current) {
          const resp = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetLang: getTargetLang(),
              texts: pendingText,
            }),
          });
          if (resp.ok) {
            const data = (await resp.json()) as { translations?: string[]; fallback?: boolean };
            const isFallback = Boolean(data?.fallback);
            const translated = Array.isArray(data?.translations) ? data.translations : [];
            pendingText.forEach((src, idx) => {
              const out = normalizeText(translated[idx] || '');
              const cacheKey = cacheKeyFor(src);
              if (isAcceptableTranslation(src, out, uiLanguage)) {
                cache.set(cacheKeyFor(src), out);
                retryAfterRef.current.delete(cacheKey);
                cacheDirty = true;
                return;
              }
              if (!isFallback) {
                retryAfterRef.current.set(cacheKey, Date.now() + NO_RESULT_RETRY_MS);
              }
            });
          } else {
            const err = await resp.json().catch(() => ({}));
            if ((err as { error?: string })?.error === 'missing_translate_api_key') {
              console.warn(
                '[AutoZhTranslator] Missing translation provider config. Set LOCAL_TRANSLATE_API_URL + LOCAL_TRANSLATE_MODEL, or DEEPL_API_KEY, or NIUTRANS_API_KEY in the frontend server env (Docker: frontend.environment) or a local .env/backend/.env file.',
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
          const translated = cache.get(cacheKeyFor(task.source));
          const nextValue =
            shouldTranslateText(task.source, uiLanguage) && translated && translated !== task.source
              ? translated
              : task.source;
          if (task.kind === 'text') {
            if (task.node.isConnected) {
              if (task.current !== nextValue) {
                task.node.nodeValue = nextValue;
              }
              const state = textStateRef.current.get(task.node);
              if (!state) continue;
              state.applied[uiLanguage] = nextValue;
            }
          } else if (task.node.isConnected) {
            if (task.current !== nextValue) {
              task.node.setAttribute(task.attr, nextValue);
            }
            const attrStates = attrStateRef.current.get(task.node);
            const state = attrStates?.[task.attr];
            if (!state) continue;
            state.applied[uiLanguage] = nextValue;
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

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        schedule(VISIBILITY_RECHECK_MS);
      }
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
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      observerRef.current?.disconnect();
      observerRef.current = null;
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
    };
  }, [uiLanguage]);

  return null;
}
