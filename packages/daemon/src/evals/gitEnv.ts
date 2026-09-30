import fs from 'node:fs';
import path from 'node:path';

/**
 * The Git part of a prompt-eval session's environment. System and global configuration and attributes are switched off, so
 * a helper configured there (Git for Windows ships `diff.astextplain.textconv astextplain` in its system gitconfig) can run
 * for no Git read and ordinary reads need no refusal; the guard hook refuses only a repository whose own configuration sets a
 * helper. Every inherited `GIT_*` variable is dropped (set to undefined, which spawn skips, since `spawnLines` merges this over
 * `process.env`), which removes `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_PARAMETERS` and any `GIT_DIR` the caller had.
 *
 * `GIT_CONFIG_NOSYSTEM=1` wins over a `GIT_CONFIG_SYSTEM` path; `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_GLOBAL` point at an empty
 * file in `dir` as well, and `core.attributesFile` at the same file replaces the default `$XDG_CONFIG_HOME/git/attributes`.
 * `diff.external` is not overridden with an empty value: Git then tries to spawn "" and every `git diff` fails.
 */
export function evalGitEnv(dir: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const empty = path.join(dir, 'empty-gitconfig');
  fs.writeFileSync(empty, '');
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(inherited)) if (/^GIT_/i.test(key)) env[key] = undefined;
  const config: [string, string][] = [['core.fsmonitor', 'false'], ['core.pager', 'cat'], ['core.attributesFile', empty]];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_GLOBAL: empty, GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat',
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
  });
  return env;
}

/** The environment `scripts/prompt-eval.ts` starts each eval session with: the account's variables, no shell startup file, and `evalGitEnv`. */
export function evalSessionEnv(accountEnv: NodeJS.ProcessEnv, dir: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...accountEnv, BASH_ENV: '', ENV: '', ...evalGitEnv(dir, inherited) };
}
