import type { Metadata } from 'next';
import DesktopBridgeBootstrap from '@/components/DesktopBridgeBootstrap';
import AutoZhTranslator from '@/components/AutoZhTranslator';
import { ThemeProvider } from '@/lib/ThemeContext';
import './globals.css';

export const metadata: Metadata = {
  title: '全球态势 // 轨道追踪',
  description: '高级地缘风险仪表盘（中文界面）',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased bg-[var(--bg-primary)]" suppressHydrationWarning>
        <ThemeProvider>
          <DesktopBridgeBootstrap />
          <AutoZhTranslator />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
