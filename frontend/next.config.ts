import type { NextConfig } from 'next';
import { networkInterfaces } from 'os';
import { fileURLToPath } from 'url';

// /api/* requests are proxied to the backend by the catch-all route handler at
// src/app/api/[...path]/route.ts, which reads BACKEND_URL at request time.
// Do NOT add rewrites for /api/* here — next.config is evaluated at build time,
// so any URL baked in here ignores the runtime BACKEND_URL env var.

const skipTypecheck = process.env.NEXT_SKIP_TYPECHECK === '1';
const isDev = process.env.NODE_ENV !== 'production';
const frontendPort = String(process.env.FRONTEND_PORT || process.env.PORT || '6789');
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

function formatHostForOrigin(host: string): string {
  const normalized = String(host || '').trim();
  if (!normalized) return '127.0.0.1';
  if (normalized.includes(':') && !normalized.startsWith('[')) return `[${normalized}]`;
  return normalized;
}

function buildAllowedDevOrigins(): string[] {
  const origins = new Set<string>([
    `http://localhost:${frontendPort}`,
    `http://127.0.0.1:${frontendPort}`,
  ]);
  try {
    const interfaces = networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const item of entries || []) {
        if (!item || item.internal) continue;
        const family =
          typeof item.family === 'number'
            ? item.family === 4
              ? 'IPv4'
              : item.family === 6
                ? 'IPv6'
                : ''
            : item.family;
        if (family !== 'IPv4' && family !== 'IPv6') continue;
        const raw = String(item.address || '').split('%', 1)[0].trim();
        if (!raw) continue;
        origins.add(`http://${formatHostForOrigin(raw)}:${frontendPort}`);
      }
    }
  } catch {
    // Best-effort LAN origin detection for dev only.
  }

  const extra = String(process.env.NEXT_ALLOWED_DEV_ORIGINS || '').trim();
  if (extra) {
    for (const origin of extra.split(',')) {
      const trimmed = origin.trim();
      if (trimmed) origins.add(trimmed);
    }
  }
  return Array.from(origins);
}
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      isDev
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:"
        : "script-src 'self' 'unsafe-inline' blob:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https:",
      isDev
        ? "connect-src 'self' ws: wss: http://127.0.0.1:8000 http://127.0.0.1:8787 https:"
        : "connect-src 'self' ws: wss: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "object-src 'none'",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
  {
    key: 'Referrer-Policy',
    value: 'no-referrer',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
];

const nextConfig: NextConfig = {
  transpilePackages: ['react-map-gl', 'maplibre-gl'],
  output: 'standalone',
  devIndicators: false,
  allowedDevOrigins: buildAllowedDevOrigins(),
  turbopack: {
    // This repo lives under /data/aYJC, which also has an unrelated lockfile.
    // Without an explicit root, Turbopack can infer the wrong workspace root
    // and fail to resolve frontend-only deps like `tailwindcss`.
    root: projectRoot,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'upload.wikimedia.org' },
      { protocol: 'https', hostname: 'via.placeholder.com' },
      { protocol: 'https', hostname: 'services.sentinel-hub.com' },
      { protocol: 'https', hostname: 'data.sentinel-hub.com' },
      { protocol: 'https', hostname: 'sentinel-hub.com' },
      { protocol: 'https', hostname: 'dataspace.copernicus.eu' },
    ],
  },
  typescript: {
    ignoreBuildErrors: skipTypecheck,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
