import type { StoredAccount } from '../db/db';

/**
 * The live opencode account whose environment the discussion eval's opencode participant and probe get, chosen without any
 * install-specific id in tracked files. `--opencode-account <id>` names one; otherwise the live database's rows decide:
 * exactly one opencode account is used, none stops with what to pass or create, and two or more ask for the flag so no
 * ordering picks silently. The caller reads the rows; nothing here writes or starts a process.
 */
export function chooseOpencodeAccount(accounts: readonly StoredAccount[], explicitId?: string): StoredAccount {
  if (explicitId !== undefined) {
    if (!explicitId) throw new Error('--opencode-account needs an account id');
    const named = accounts.find((a) => a.id === explicitId);
    if (!named || named.harness !== 'opencode') throw new Error(`live account ${explicitId} is missing or not an opencode account`);
    return named;
  }
  const opencode = accounts.filter((a) => a.harness === 'opencode');
  if (!opencode.length) throw new Error('the live database has no opencode account; pass --opencode-account <id> or create one in Setup');
  if (opencode.length > 1) throw new Error(`the live database has ${opencode.length} opencode accounts; pass --opencode-account <id> to choose one`);
  return opencode[0]!;
}
