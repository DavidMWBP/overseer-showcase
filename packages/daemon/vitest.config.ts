import { defineConfig } from 'vitest/config';

// Three files stay slow. beads.live makes about 25 real bd calls on one shared repo and cannot run its tests
// concurrently without breaking its exact `bd ready` assertion; daemon-restart waits out the busy-port retry
// window that index.ts hardcodes when it calls listenWithRetry; evidence.performance creates large file trees.
// This box has 8 cores / 16 threads and several test runs overlap, so cap one run at 4 forks:
// two runs use the physical cores and three runs use 12 of the 16 threads, instead of a single
// run spawning a fork per thread. OVERSEER_VITEST_MAX_FORKS (a shell-only override, never read
// from the repo-root .env) raises the cap for a lone run.
const DEFAULT_MAX_FORKS = 4;
function parseMaxForks(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_FORKS;
}
const maxForks = parseMaxForks(process.env.OVERSEER_VITEST_MAX_FORKS);

export const slowTestFiles = [
  'src/beads/beads.live.test.ts',
  'src/daemon-restart.integration.test.ts',
  'src/api/evidence.performance.test.ts',
];

export default defineConfig(({ mode }) => {
  const slow = mode === 'slow';

  return {
    test: {
      include: slow ? slowTestFiles : ['src/**/*.test.ts'],
      exclude: slow ? [] : slowTestFiles,
      // Must stay above the until() default (45000).
      testTimeout: 60000,
      // Hooks do not inherit testTimeout, and several spawn real git and bd: 10s (the default) expired in beforeAll under load.
      hookTimeout: 60000,
      poolOptions: { forks: { maxForks, execArgv: ['--disable-warning=ExperimentalWarning'] } },
    },
  };
});
