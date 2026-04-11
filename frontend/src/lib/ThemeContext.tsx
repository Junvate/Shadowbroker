'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

type Theme = 'dark' | 'light';
type HudColor = 'cyan' | 'matrix';
export type UiLanguage = 'zh' | 'en';

const ThemeContext = createContext<{
  theme: Theme;
  toggleTheme: () => void;
  hudColor: HudColor;
  cycleHudColor: () => void;
  uiLanguage: UiLanguage;
  setUiLanguage: (next: UiLanguage) => void;
  toggleUiLanguage: () => void;
}>({
  theme: 'dark',
  toggleTheme: () => {},
  hudColor: 'cyan',
  cycleHudColor: () => {},
  uiLanguage: 'zh',
  setUiLanguage: () => {},
  toggleUiLanguage: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [hudColor, setHudColor] = useState<HudColor>('cyan');
  const [uiLanguage, setUiLanguageState] = useState<UiLanguage>('zh');

  useEffect(() => {
    const saved = localStorage.getItem('sb-theme') as Theme | null;
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved);
      document.documentElement.setAttribute('data-theme', saved);
    }
    const savedHud = localStorage.getItem('sb-hud-color') as HudColor | null;
    if (savedHud === 'cyan' || savedHud === 'matrix') {
      setHudColor(savedHud);
      document.documentElement.setAttribute('data-hud', savedHud);
    }
    const savedLanguage = localStorage.getItem('sb-ui-language') as UiLanguage | null;
    if (savedLanguage === 'zh' || savedLanguage === 'en') {
      setUiLanguageState(savedLanguage);
      document.documentElement.setAttribute('data-ui-language', savedLanguage);
      document.documentElement.lang = savedLanguage === 'zh' ? 'zh-CN' : 'en';
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('sb-theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };

  const cycleHudColor = () => {
    const next = hudColor === 'cyan' ? 'matrix' : 'cyan';
    setHudColor(next);
    localStorage.setItem('sb-hud-color', next);
    document.documentElement.setAttribute('data-hud', next);
  };

  const setUiLanguage = (next: UiLanguage) => {
    setUiLanguageState(next);
    localStorage.setItem('sb-ui-language', next);
    document.documentElement.setAttribute('data-ui-language', next);
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  };

  const toggleUiLanguage = () => {
    setUiLanguage(uiLanguage === 'zh' ? 'en' : 'zh');
  };

  return (
    <ThemeContext.Provider
      value={{
        theme,
        toggleTheme,
        hudColor,
        cycleHudColor,
        uiLanguage,
        setUiLanguage,
        toggleUiLanguage,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
