import { describe, expect, it } from 'vitest';
import {
  isAcceptableAutoTranslation,
  resolveAutoTranslationValue,
  shouldAutoTranslateText,
} from '@/lib/autoZhTranslation';

describe('autoZhTranslation helpers', () => {
  it('prefers cached translations for pending zh text', () => {
    expect(
      resolveAutoTranslationValue({
        source: 'Alpha Cache Probe',
        uiLanguage: 'zh',
        translated: '缓存命中',
      }),
    ).toBe('缓存命中');
  });

  it('preserves an already-applied zh translation when cache is temporarily unavailable', () => {
    expect(
      resolveAutoTranslationValue({
        source: 'React rerender probe',
        uiLanguage: 'zh',
        translated: '',
        applied: '已应用中文',
      }),
    ).toBe('已应用中文');
  });

  it('rejects same-language passthrough and only translates eligible text', () => {
    expect(shouldAutoTranslateText('12345', 'zh')).toBe(false);
    expect(shouldAutoTranslateText('https://example.com', 'zh')).toBe(false);
    expect(shouldAutoTranslateText('Threat Intercept', 'zh')).toBe(true);
    expect(isAcceptableAutoTranslation('Threat Intercept', 'Threat Intercept', 'zh')).toBe(false);
    expect(isAcceptableAutoTranslation('Threat Intercept', '威胁拦截', 'zh')).toBe(true);
  });
});
