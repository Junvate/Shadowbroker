import type { UiLanguage } from '@/lib/ThemeContext';
import { TRANSLATION_MAX_TEXT_LENGTH } from '@/lib/translationConstants';

export function normalizeAutoTranslateText(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function shouldAutoTranslateText(raw: string, uiLanguage: UiLanguage): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (text.length > TRANSLATION_MAX_TEXT_LENGTH) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[\d\s\-:/.]+$/.test(text)) return false;
  return uiLanguage === 'zh' ? /[A-Za-z]/.test(text) : /[\u4e00-\u9fff]/.test(text);
}

export function isAcceptableAutoTranslation(
  source: string,
  candidate: string,
  uiLanguage: UiLanguage,
): boolean {
  const src = normalizeAutoTranslateText(source);
  const out = normalizeAutoTranslateText(candidate);
  if (!src || !out || src === out) return false;
  if (uiLanguage === 'zh') return /[\u4e00-\u9fff]/.test(out);
  return /[A-Za-z]/.test(out);
}

export function resolveAutoTranslationValue({
  source,
  uiLanguage,
  translated,
  applied,
}: {
  source: string;
  uiLanguage: UiLanguage;
  translated?: string | null;
  applied?: string | null;
}): string {
  if (translated && shouldAutoTranslateText(source, uiLanguage) && translated !== source) {
    return translated;
  }

  if (applied && isAcceptableAutoTranslation(source, applied, uiLanguage)) {
    return applied;
  }

  return source;
}
