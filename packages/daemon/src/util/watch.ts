import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { samePath } from '../fs/paths';

export const WATCH_WARNING =
  'This daemon runs under a file watcher from the checkout it manages; merging an overseer batch will restart it and kill running workers. Use `pnpm start` for the orchestrating daemon.';

/** The repository root this daemon's source is loaded from: this file is `packages/daemon/src/util/watch.ts`. */
export const SOURCE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

/**
 * tsx sets nothing a watched child can observe, so the daemon's `dev` script sets `OVERSEER_WATCH=1`. The warning applies
 * only when that marker is set AND a managed repository's checkout is this daemon's own source root: then every merge into
 * the base branch changes the files under the watcher and restarts the process mid-merge.
 */
export function watchWarning(env: NodeJS.ProcessEnv, repoPaths: string[], sourceRoot: string): string | null {
  if (env.OVERSEER_WATCH !== '1') return null;
  return repoPaths.some((p) => samePath(p, sourceRoot)) ? WATCH_WARNING : null;
}
