'use client';

import { useEffect, useState } from 'react';
import type { UiLanguage } from '@/lib/ThemeContext';
import { lookupStaticUiText } from '@/lib/zhStaticDictionary';
import { sameStringRecord } from '@/lib/stringRecord';
import { TRANSLATION_MAX_TEXT_LENGTH } from '@/lib/translationConstants';

const CACHE_KEY = 'sb_ui_text_translation_cache_v1';
const CACHE_LIMIT = 5000;

function normalizeText(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function shouldTranslateText(text: string, uiLanguage: UiLanguage): boolean {
  if (!text) return false;
  if (text.length > TRANSLATION_MAX_TEXT_LENGTH) return false;
  if (/^https?:\/\//i.test(text)) return false;
  return uiLanguage === 'zh' ? /[A-Za-z]/.test(text) : /[\u4e00-\u9fff]/.test(text);
}

function storageKeyFor(uiLanguage: UiLanguage, source: string): string {
  return `${uiLanguage}::${source}`;
}

function safeLoadCache(): Map<string, string> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(parsed).slice(-CACHE_LIMIT));
  } catch {
    return new Map();
  }
}

function safeSaveCache(cache: Map<string, string>) {
  if (typeof window === 'undefined') return;
  try {
    const entries = Array.from(cache.entries()).slice(-CACHE_LIMIT);
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // ignore storage failures
  }
}

function isAcceptableTranslation(source: string, candidate: string, uiLanguage: UiLanguage): boolean {
  const src = normalizeText(source);
  const out = normalizeText(candidate);
  if (!src || !out || src === out) return false;
  if (uiLanguage === 'zh') return /[\u4e00-\u9fff]/.test(out);
  return /[A-Za-z]/.test(out);
}

export function useUiTranslations(
  values: Array<string | null | undefined>,
  uiLanguage: UiLanguage,
): Record<string, string> {
  const texts = Array.from(new Set(values.map((value) => normalizeText(value || '')).filter(Boolean)));
  const [translations, setTranslations] = useState<Record<string, string>>({});

  useEffect(() => {
    if (texts.length === 0) {
      setTranslations((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }

    let cancelled = false;
    const cache = safeLoadCache();
    const immediate: Record<string, string> = {};
    const pending: string[] = [];
    let cacheDirty = false;

    for (const text of texts) {
      const staticText = lookupStaticUiText(text, uiLanguage);
      if (staticText && staticText !== text) {
        cache.set(storageKeyFor(uiLanguage, text), staticText);
        immediate[text] = staticText;
        cacheDirty = true;
        continue;
      }

      const cached = cache.get(storageKeyFor(uiLanguage, text));
      if (cached && cached !== text) {
        immediate[text] = cached;
        continue;
      }

      if (shouldTranslateText(text, uiLanguage)) {
        pending.push(text);
      }
    }

    if (cacheDirty) {
      safeSaveCache(cache);
    }
    setTranslations((prev) => (sameStringRecord(prev, immediate) ? prev : immediate));

    if (pending.length === 0) return;

    void (async () => {
      try {
        const resp = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetLang: uiLanguage === 'zh' ? 'ZH-HANS' : 'EN',
            texts: pending,
          }),
        });
        if (!resp.ok) return;

        const data = (await resp.json().catch(() => ({}))) as { translations?: string[] };
        const translated = Array.isArray(data?.translations) ? data.translations : [];
        const mapped: Record<string, string> = { ...immediate };
        let dirty = false;

        pending.forEach((source, idx) => {
          const out = normalizeText(translated[idx] || '');
          if (!isAcceptableTranslation(source, out, uiLanguage)) return;
          cache.set(storageKeyFor(uiLanguage, source), out);
          mapped[source] = out;
          dirty = true;
        });

        if (dirty) {
          safeSaveCache(cache);
        }
        if (!cancelled) {
          setTranslations((prev) => (sameStringRecord(prev, mapped) ? prev : mapped));
        }
      } catch {
        // ignore client-side translation failures
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [texts, uiLanguage]);

  return translations;
}
