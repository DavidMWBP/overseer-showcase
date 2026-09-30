import type { HarnessName } from '@overseer/shared';
import type { Config } from '../config';
import type { HarnessAdapter } from './types';
import { ClaudeAdapter } from './claude';
import { CodexAdapter } from './codex';
import { OpencodeAdapter } from './opencode';

export function makeAdapters(config: Config): Record<HarnessName, HarnessAdapter> {
  return { claude: new ClaudeAdapter(config.claudeBin), codex: new CodexAdapter(config.codexBin), opencode: new OpencodeAdapter(config.opencodeBin) };
}
