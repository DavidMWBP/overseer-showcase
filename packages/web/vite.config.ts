import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The repository-root `.env` is shared with the daemon; a variable already in the shell wins.
const env = { ...loadEnv('', path.resolve(__dirname, '../..'), 'OVERSEER_'), ...process.env };
const daemonPort = Number(env.OVERSEER_PORT ?? 4400);
// Same cap as the daemon's vitest config: the box has 8 cores / 16 threads, so one run takes 4
// forks and leaves room for the other runs. Unlike OVERSEER_PORT above, OVERSEER_VITEST_MAX_FORKS
// is a shell-only override and is not read from the repo-root .env; it raises the cap for a lone run.
const DEFAULT_MAX_FORKS = 4;
function parseMaxForks(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_FORKS;
}
const maxForks = parseMaxForks(process.env.OVERSEER_VITEST_MAX_FORKS);

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true listens on every interface so a phone on the LAN or a tailnet can reach the app; Vite still refuses unknown Host
    // headers, so the hostnames you serve it under go in OVERSEER_WEB_HOSTS (comma-separated), e.g. a Tailscale `*.ts.net` name.
    host: true,
    port: Number(env.OVERSEER_WEB_PORT ?? 5173),
    allowedHosts: (env.OVERSEER_WEB_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    proxy: { '/api': { target: `http://127.0.0.1:${daemonPort}`, ws: true } },
  },
  // The 5 s default testTimeout is too tight: the slow case in App.test.tsx measured 287-298 ms idle and 414-574 ms under the 16-thread load recipe on 2026-09-27, but the whole web suite takes 427 s loaded against 173 s idle (docs/lessons.md) and that contention timed it out twice; 15 s leaves wide margin.
  test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], setupFiles: ['src/test/setup.ts'], testTimeout: 15000, poolOptions: { forks: { maxForks } } },
});
