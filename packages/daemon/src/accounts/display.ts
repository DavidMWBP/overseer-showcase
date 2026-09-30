import type { Account } from '@overseer/shared';

export function accountDisplayName(account: (Pick<Account, 'name'> & { label?: string | null }) | null | undefined): string | null {
  if (!account) return null;
  return account.label ? `${account.name} (${account.label})` : account.name;
}
