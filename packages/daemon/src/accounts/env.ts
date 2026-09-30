import type { StoredAccount } from '../db/db';
import type { Db } from '../db/db';
import type { Config } from '../config';
import { refreshClaudeOAuth } from './login';
import { opencodeLoginHasKey } from '../harness/opencode';

const OPENCODE_PROVIDER_ENV: Record<string, string> = { deepseek: 'DEEPSEEK_API_KEY' };

export const isOpenCodeProvider = (provider: string | null | undefined): provider is string => !!provider && provider in OPENCODE_PROVIDER_ENV;

/** Whether an opencode candidate without an account can run `model`: true for a provider Overseer holds no key variable for, else `opencodeLoginHasKey`. */
export function opencodeOwnLoginReaches(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = model.split('/')[0];
  return !isOpenCodeProvider(provider) || opencodeLoginHasKey(provider, OPENCODE_PROVIDER_ENV[provider]!, env);
}

/** Environment overrides are intentionally small: spawnLines merges them over the daemon environment. */
export function accountEnv(account: StoredAccount | null | undefined): NodeJS.ProcessEnv {
  if (!account) return {};
  if (account.harness === 'opencode') {
    const variable = isOpenCodeProvider(account.provider) ? OPENCODE_PROVIDER_ENV[account.provider] : undefined;
    if (!variable) throw new Error(`unknown OpenCode provider: ${account.provider ?? 'missing'}`);
    return { [variable]: account.secret ?? undefined };
  }
  if (account.kind === 'oauth_token') return { CLAUDE_CODE_OAUTH_TOKEN: account.secret ?? undefined, ANTHROPIC_API_KEY: undefined };
  if (account.kind === 'api_key') return { ANTHROPIC_API_KEY: account.secret ?? undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined };
  return account.home ? { CODEX_HOME: account.home } : {};
}

/** Refreshes expiring Claude OAuth credentials before constructing the environment for a new process; `force` refreshes a token outside the margin too. */
export async function freshAccountEnv(db: Db, config: Config, account: StoredAccount | null | undefined, force = false): Promise<NodeJS.ProcessEnv> {
  return accountEnv(account ? await refreshClaudeOAuth(db, config, account, force) : account);
}

/**
 * The expiry of the Claude OAuth token `freshAccountEnv` put in a session's environment, read from the account row after the
 * refresh it may have performed, so a session records the token its env carries rather than the row it started from (a restart
 * re-adopts the stored value). Null for an account with no OAuth token, a codex or opencode account, and the CLI's own login.
 */
export function envTokenExpiresAt(db: Db, account: StoredAccount | null | undefined): number | null {
  if (!account || account.kind !== 'oauth_token') return null;
  return db.accounts.get(account.id)?.token_expires_at ?? null;
}
