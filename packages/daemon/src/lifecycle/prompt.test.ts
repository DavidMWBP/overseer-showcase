import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HarnessName } from '@overseer/shared';
import { render, boundedCriticPrompt, buildCriticPrompt, buildWorkerPrompt } from './prompt';

describe('render', () => {
  it('substitutes and toggles blocks', () => {
    const t = 'a={{a}}{{#b}} b={{b}}{{/b}}{{#c}} c={{c}}{{/c}}';
    expect(render(t, { a: '1', b: '2', c: '' })).toBe('a=1 b=2');
  });
});

describe('skill trigger descriptions', () => {
  const description = (name: string) => {
    const file = new URL(`../../../../.claude/skills/${name}/SKILL.md`, import.meta.url);
    const source = fs.readFileSync(fileURLToPath(file), 'utf8');
    const value = source.match(/^description:\s*(.*)$/m)?.[1];
    if (!value) throw new Error(`Missing description for ${name}`);
    return value;
  };

  it('separates Office art critique, generation and manual smoke from Playwright work', () => {
    expect(description('office-critic')).toContain('Not for generating or fitting art; use pixellab.');
    expect(description('pixellab')).toContain('Not for critiquing or gating captures; use office-critic.');
    expect(description('overseer-smoke')).toContain('Not for automated Playwright test authoring (use playwright-best-practices) or browser control (use playwright-cli).');
  });
});

describe('buildWorkerPrompt', () => {
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: 'Rejected: needs tests', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };
  it('includes every section that has content', () => {
    const p = buildWorkerPrompt('{{id}}|{{title}}|{{branch}}|{{#notes}}N:{{notes}}{{/notes}}|{{#conflicts}}C:{{conflicts}}{{/conflicts}}|{{#instructions}}I:{{instructions}}{{/instructions}}', { bead, branch: 'bead/ov-1', base: 'main', conflicts: ['a.ts', 'b.ts'], instructions: 'rebase' });
    expect(p).toBe('ov-1|Add login|bead/ov-1|N:Rejected: needs tests|C:- a.ts\n- b.ts|I:rebase');
  });
  it('omits empty sections', () => {
    const p = buildWorkerPrompt('{{#notes}}N{{/notes}}{{#conflicts}}C{{/conflicts}}{{#instructions}}I{{/instructions}}', { bead: { ...bead, notes: '' }, branch: 'b', base: 'main', conflicts: [], instructions: undefined });
    expect(p).toBe('');
  });
});

describe('worker.md commit format', () => {
  const template = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };
  const harnesses: HarnessName[] = ['claude', 'codex', 'opencode'];
  it.each(harnesses)('tells a %s worker to use Conventional Commits and never bypass hooks', () => {
    const p = buildWorkerPrompt(template, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('## Commit format');
    expect(p).toContain('`<type>(<scope>): <subject>`');
    expect(p).toContain('header at most 72 characters');
    expect(p).not.toContain('Bead:');
    expect(p).toContain('Never bypass hooks with `--no-verify`');
  });
});

describe('critic.md evidence rules', () => {
  const template = fs.readFileSync(fileURLToPath(new URL('../../prompts/critic.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: 'Round 1 asked to keep the timer visible.', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('loads the verdict tool before giving a verdict when it is not loaded', () => {
    const p = buildCriticPrompt(template, { bead, repoId: 'sample-site', branch: 'bead/ov-1', base: 'main', diff: 'diff', round: 1, limit: 2 });
    expect(p).toContain('If `submit_review` is not loaded yet, load it (for example with tool search) before giving the verdict.');
  });

  it('requires the verdict call before ending and its return before claiming a finding was recorded', () => {
    const p = buildCriticPrompt(template, { bead, repoId: 'sample-site', branch: 'bead/ov-1', base: 'main', diff: 'diff', round: 1, limit: 2 });
    expect(p).toContain('Never say you reported, submitted or recorded a finding unless the `submit_review` call returned, and never end your turn without that call.');
    expect(p).toContain('After the call returns, stop.');
  });

  it('judges Playwright captures independently of the entry point', () => {
    const p = buildCriticPrompt(template, { bead, repoId: 'overseer', branch: 'bead/ov-1', base: 'main', diff: 'diff', round: 1, limit: 2 });
    expect(p).toContain('Any Playwright entry point satisfies a `playwright-cli` requirement; judge the capture, not the tool.');
    expect(p).toContain('Read the bead notes for earlier rounds before finding issues.');
    expect(p).toContain('Do not reverse a decision an earlier round asked for');
    expect(p).toContain('check every other documentation surface named by the repo\'s `CLAUDE.md` in the same round');
    expect(p).toContain('and report them together, so one re-dispatch closes the class');
    expect(p).toContain('report it as a `must` finding that states, with the evidence, that the requested mechanism cannot work');
    expect(p).toContain('do not instruct the worker to implement a lesser fallback');
  });

  it('includes bead notes from earlier review rounds', () => {
    const p = buildCriticPrompt(template, { bead, repoId: 'overseer', branch: 'bead/ov-1', base: 'main', diff: 'diff', round: 2, limit: 3 });
    expect(p).toContain('## Notes from earlier rounds');
    expect(p).toContain('Round 1 asked to keep the timer visible.');
  });
});

describe('prescribed CLI command rules', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('keeps forbidden task-count commands out of worker descriptions and supplies an allowed source', () => {
    expect(orchestratorPrompt).toContain('Never tell a worker to run `bd` in a description, because workers are forbidden to run it. Give the counts yourself, or name a read-only source the worker may use.');
  });

  it('checks every prescribed CLI command and flag before dispatch', () => {
    expect(orchestratorPrompt).toContain('Verify each prescribed CLI command and flag with `<cli> <subcommand> --help` or a read-only dry run, and quote the flag you checked.');
    expect(orchestratorPrompt).toContain("Before beads scaffold a project on a framework named in a spec or handoff, check its current major version in Context7 or the framework's release notes. If the named version is older, `ask_user` which version to use before creating beads.");
    expect(orchestratorPrompt).toContain('Name an MCP tool (such as Context7 or Figma) in a description only if the bead goes to a harness that has that tool; otherwise name the documentation source directly, such as a URL.');
  });

  it('checks prescribed CLI flags and reports a wrong prescription with its working equivalent', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain("Before using a prescribed CLI command or flag, or a CLI invocation you add to code, check it against that installed CLI's `<cli> <subcommand> --help` or a read-only dry run");
    expect(workerPrompt).toContain('name the `--help` output you checked in your final message');
    expect(workerPrompt).toContain('report it as a wrong prescription with the working equivalent, not as a failure of the work');
    expect(workerPrompt).toContain('`Check: <prescribed command> - PASS - prescription wrong: <why>; ran <working command> instead`');
  });
});

describe('orchestrator.md repository model filter', () => {
  const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  it('scopes forced candidates to the repository filter and relays refusals', () => {
    expect(prompt).toContain("Alone, it takes that CLI's first usable candidate allowed by the repository's model filter.");
    expect(prompt).toContain("The repository's model filter in `list_repos` decides which harness, model and account its workers may use.");
    expect(prompt).toContain('Never force a harness outside it, and relay a filter refusal to the user.');
  });
});

describe('orchestrator.md account exhaustion rule', () => {
  it('tells the orchestrator that automatic account failover needs no action', () => {
    const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
    expect(prompt).toContain('Examples: an automatic re-dispatch after an exhausted account');
    expect(prompt).toContain('Lines under `[Overseer] Since your last turn:` need nothing.');
    expect(prompt).toContain('stopped leftover processes');
    expect(prompt).toContain("a round prompt too big for the critic's harness while that round runs");
    expect(prompt).toContain('(`waiting_on`, `status_label` starting with `waiting`) and is released by itself.');
  });
});

describe('orchestrator.md pipeline failure triage', () => {
  it('routes watcher pipeline-failure notices through the existing job triage', () => {
    const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
    expect(prompt).toContain('Pipeline failures and `behind the base` findings, whether from a note, a message or a watcher notice:');
  });
});

describe('orchestrator.md list_batches fields', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  it('tells the orchestrator the long fields are omitted and how to read one batch with them', () => {
    expect(orchestratorPrompt).toContain('Pass `batch_id` to also get `history` (earlier review notes and rejections) and `note`.');
  });
});

describe('orchestrator.md stacked batch bases', () => {
  it('passes a stack base only when the user names one in a gitlab-mr repository', () => {
    const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
    expect(prompt).toContain('Pass `base` only when the user names a branch to stack on, and only in a `gitlab-mr` repo.');
    expect(prompt).toContain('`create_batch(repo, title, branch?, base?)`');
  });

  it('only retargets a batch when the user asks for it', () => {
    const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
    expect(prompt).toContain('`retarget_batch(repo, batch_id, base)`');
    expect(prompt).toContain('`retarget_batch(repo, batch_id, base)` — only when the user asks.');
  });
});

describe('orchestrator.md bd tool result', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  it('tells the orchestrator a write answers compact and to read a bead with show', () => {
    expect(orchestratorPrompt).toContain('write commands return only id, status and title');
    expect(orchestratorPrompt).toContain('Read with `["show", "<id>"]`');
  });
});

describe('orchestrator.md live evidence tier (lesson 2026-09-26 overseer-mirq)', () => {
  it('requires standard tier or above for beads with live evidence of driven or seeded scenes', () => {
    const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
    expect(prompt).toContain('A bead needing live evidence of a driven or seeded scene gets `standard` or above.');
  });
});

describe('orchestrator.md setup after batch deps (lesson 2026-09-26 overseer-b175-gvij)', () => {
  it('requires setup re-run when batch beads change package.json or lockfile', () => {
    const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
    expect(prompt).toContain('Re-run the setup command first when `package.json` or a lockfile changed.');
  });
});

describe('orchestrator.md PixelLab cleanup (lesson 2026-09-26 overseer-b183-fsh6)', () => {
  it('deletes only recorded unused art after merge or abandonment', () => {
    const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
    expect(prompt).toContain('After a batch with PixelLab art is merged or abandoned, delete only the characters, objects and animations');
    expect(prompt).toContain('whose ids `SOURCE.md` or the evidence notes record as not used.');
  });
});

describe('orchestrator.md questions use ask_user (lesson 2026-09-26 overseer-b185-bbur)', () => {
  it('routes every user question, including questions ending proposals, through ask_user', () => {
    const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
    expect(prompt).toContain('every question to the user goes through this, including "should I…?". Never ask a question in a chat reply.');
  });
});

describe('acme-portal-sample-014 prompt lessons', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('keeps internal vocabulary out of outward-facing text', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('- says what changed, why, and how it was verified;');
    expect(orchestratorPrompt).toContain('- never names Overseer or its internal vocabulary.');
    expect(workerPrompt).toContain('never name Overseer or its internal vocabulary');
    expect(workerPrompt).not.toContain('Bead:');
  });

  it('requires reproducing reported failures before edits', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('requires the worker to reproduce the failure before any edit');
    expect(workerPrompt).toContain('run the exact reported command before editing');
    expect(orchestratorPrompt).toContain('If the user already decided the change, the reproduction is a finding to report, not a gate.');
    expect(workerPrompt).toContain('stop only when the proposed change is derived from that failure');
    expect(workerPrompt).toContain('report the non-reproduction and make the change');
  });

  it('requires checks to cover changed files before they pass', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain('confirm that its typecheck project, linter scan paths, or test filter reads the files changed');
  });
});

describe('worker.md rules from the #9310 run', () => {
  const template = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };
  const harnesses: HarnessName[] = ['claude', 'codex', 'opencode'];
  it.each(harnesses)('tells a %s worker where evidence goes, how to run long commands and to end with a results block', () => {
    const p = buildWorkerPrompt(template, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('Do not commit evidence, screenshots, probe dumps, temp scripts or build output');
    expect(p).toContain('Put evidence in your final message');
    expect(p).toContain('After taking a screenshot, open the image and describe only what it actually renders');
    expect(p).toContain('When a required state is missing, change the fixture or the capture and take it again');
    expect(p).toContain('Do not end the session while a long command is still running');
    expect(p).toContain('foreground with a bounded timeout');
    expect(p).toContain('Background commands are blocked for workers');
    expect(p).toContain('`run_in_background` is rejected');
    expect(p).toContain('End your final message with a short results block');
    expect(p).toContain('A `Check:` line for a test run quotes the runner\'s own summary line');
    expect(p).toContain('from the run at the final commit');
    expect(p).toContain('is `FAIL` or `NOT RUN` with its reason, never `PASS`');
    expect(p).toContain('cannot run for an environment reason');
    expect(p).toContain('A local toolchain failure (such as a native module that does not build or an unsupported runtime version) is an environment reason too. Report it with the exact error; do not change dependencies, `engines` or package-manager config to get past it unless the task asks for that change.');
    expect(p).toContain('do not describe it as a limitation of the work');
    expect(p).toContain('state explicitly that no commit is expected');
    // acme-portal-sample-037: evidence from a verification-only bead must survive the worktree
    expect(p).toContain('Your worktree is deleted when the session ends');
    expect(p).toContain('upload each file to the repo\'s GitLab project uploads API');
  });
  it.each(harnesses)('tells a %s worker that live proofs of harness changes run in git worktrees', () => {
    const p = buildWorkerPrompt(template, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('live proof of a harness, sandbox or tooling change');
    expect(p).toContain('`git worktree add` checkout of a temp repo');
    expect(p).toContain('exact command, exit code and output');
    expect(p).toContain('plain temp dir without git does not count');
  });
  it.each(harnesses)('tells a %s worker that browser proofs use playwright-cli, never in-app skills', () => {
    const p = buildWorkerPrompt(template, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('browser or screenshot proof');
    expect(p).toContain('`playwright-cli`');
    expect(p).toContain('`npx playwright`');
    expect(p).toContain('throwaway script');
    expect(p).toContain('Never use an IDE or in-app browser skill');
    expect(p).toContain('against a server you start with `start_server` in this worktree on a free port');
    expect(p).toContain("confirm the page shows this branch's change");
    expect(p).toContain('a capture that shows the old UI is a FAIL line, not evidence');
    expect(p).toContain('FAIL line in the results block naming what was missing');
    expect(p).toContain('picked explicitly (for Vite, `--port <n> --strictPort` with n from 5200 up) and never 5173, 5174 or 4400');
    // daemon-owned servers: the worker no longer stops what it started, the session end does
    expect(p).toContain('You do not have to stop the servers you started: each one is stopped when your session ends.');
    expect(p).not.toContain('Stop every server or watcher you started');
    expect(p).toContain('measure and screenshot the named worst-case states');
    expect(p).toContain('keep a test that would fail if the rule were deleted');
    expect(p).toContain('Measure a layout change at each breakpoint edge and inside each band, and report the measured numbers');
  });
  it.each(harnesses)('tells a %s worker that named tests are part of the deliverable', () => {
    const p = buildWorkerPrompt(template, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('Tests the task names are part of the deliverable');
    expect(p).toContain('`git diff --stat <base>...HEAD`');
    expect(p).toContain('every named test file is in the diff');
    expect(p).toContain("Before the final commit, grep the repo's `CLAUDE.md`");
    expect(p).toContain('list each surface in the final message as updated, or as not applicable with the reason');
  });
  it.each(harnesses)('tells a %s worker to enforce isolated harnesses and clock-based deadlines', () => {
    const p = buildWorkerPrompt(template, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('make the harness fail closed on the default');
    expect(p).toContain('assert that the resolved value is not the live default');
    expect(p).toContain('Compute a polling timeout or deadline from a clock reading taken before the loop');
    expect(p).toContain("test must make the loop's work consume time");
  });
  it.each(harnesses)('tells a %s worker to sweep removals and preserve meaningful assertions', () => {
    const p = buildWorkerPrompt(template, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('grep the whole repository for it, including comments, README, CLAUDE.md, specs and test names');
    expect(p).toContain('a comment or document that describes what no longer exists is a defect');
    expect(p).toContain('make each replacement assertion fail if the behaviour it names breaks');
    expect(p).toContain('an assertion true in every state, a query for something that no longer exists');
    expect(p).toContain('a test name that promises more than its body checks is worse than deleting the test');
  });
  it.each(harnesses)('tells a %s worker to compare references, restore safely and separate deployment reporting', () => {
    const p = buildWorkerPrompt(template, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('`git fetch` it and compare `origin/<branch>` blobs');
    expect(p).toContain('“Identical to X” means change what differs, keep what X also has');
    expect(p).toContain('`FAIL/blocked` line');
    expect(p).toContain('diff its keys and values against the replacement job variables');
    expect(p).toContain('list the live objects that claim both the old and new hosts');
    expect(p).toContain('MB=$(git merge-base origin/<base> HEAD)');
    expect(p).toContain('MB=$(git merge-base <base> HEAD)');
    expect(p).toContain('without a remote, `MB=$(git merge-base <base> HEAD)` against the local base branch');
    expect(p).toContain('never `git checkout <base> -- <file>`');
    expect(p).toContain('`git diff --name-only $MB...HEAD`');
    expect(p).toContain('When the task compares a pipeline or deploy config against a reference system');
    expect(p).toContain('operational risks separately');
    expect(p).toContain('grep for every caller of the setter or redirect before coding');
    expect(p).toContain('list each caller with the section it now lands on and the test covering it in the final message');
    expect(p).toContain('treat “every entry point” in a task as a request for that list');
  });
  it.each(harnesses)('tells a %s worker to preserve both sides of a conflict', () => {
    const p = buildWorkerPrompt(template, { bead, branch: 'bead/ov-1', base: 'main', conflicts: ['spec.md'] });
    expect(p).toContain("keep both sides' content unless the task says otherwise");
    expect(p).toContain('never replace it with invented wording');
    expect(p).toContain('`git diff <each parent> HEAD -- <file>`');
  });
});

describe('orchestrator.md safety and chat rules', () => {
  const prompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('requires named live-install harness guards in bead descriptions', () => {
    expect(prompt).toContain('A bead touching a path, port or process the user\'s live install uses requires a guard');
    expect(prompt).toContain('plus an assertion that it is not the live default');
  });

  it('limits user chat to actionable messages and summarises helpers', () => {
    expect(prompt).toContain("Reply briefly to the user's own messages.");
    expect(prompt).toContain('write only for a question, a decision, a failure the user must act on, or a finished request');
    expect(prompt).toContain('acknowledgements or recaps of running work');
    expect(prompt).toContain("A helper's full report reaches Chat");
    expect(prompt).toContain('look things up with your own search and read tools');
    expect(prompt).toContain('use a helper only for a search too wide to do yourself');
    expect(prompt).toContain('cap its report at about 100 words');
    expect(prompt).toContain('Progress lines between tool calls');
    expect(prompt).toContain('are status recaps too');
    expect(prompt).toContain("Rule 13's note before a call expected to take over a minute stays.");
    expect(prompt).toContain('Before a tool call expected to take over a minute, post one line saying what is running.');
    expect(prompt).toContain('never paste them');
  });

  it('answers a direct question before doing setup work', () => {
    expect(prompt).toContain('When a user message holds a direct question and also asks for work, answer the question first, in a line or two from what you already know, then do the setup work.');
  });
});

describe('2026-09-22 combined lessons', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const criticTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/critic.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Test', description: 'Test', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('pins the worker rules', () => {
    const prompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: ['x'] });
    expect(prompt).toContain('grep every count, file name and claim in each touched document or spec against the merged code');
    expect(prompt).toContain('compare it with the raw command for the same arguments and quote both file and test counts');
    expect(prompt).toContain("grep the repository for every caller, run each caller's spec");
    expect(prompt).toContain('Every Definition of Done covers the edge and negative states of each behaviour by name');
    expect(prompt).toContain('Never run an Agent tool or subagent in the background');
    expect(prompt).toContain('never end the turn to wait for a subagent, message reply or other event');
  });

  it('pins the critic rules', () => {
    const prompt = buildCriticPrompt(criticTemplate, { bead, repoId: 'overseer', branch: 'bead/ov-1', base: 'main', diff: 'diff', round: 1, limit: 2 });
    expect(prompt).toContain("Compare a wrapped test or build command's file and test counts with the raw command");
    expect(prompt).toContain('Try applicable blank, zero, new, removed, duplicate, maximum and user-visible count states');
    expect(prompt).toContain('grep the enum and check every switch and lookup');
    expect(prompt).toContain("each consumer needs an assertion of the new kind's effect");
    expect(prompt).toContain('Report wider authority to merge, approve, delete or publish as a user question');
    expect(prompt).toContain('Run checks in the foreground with bounded timeouts and never end the turn to wait');
    expect(prompt).toContain('the verdict contains only completed findings');
  });

  it('pins the orchestrator rules', () => {
    expect(orchestratorPrompt).toContain('prove the wrapped and raw commands select the same files and tests');
    expect(orchestratorPrompt).toContain("name every caller found by a repo grep, and require each caller's spec");
    expect(orchestratorPrompt).toContain('Every Definition of Done names the applicable edge states, with one assertion or read-back each');
    expect(orchestratorPrompt).toContain('Input fields that read, reformat or validate what the user enters: test each input path with real input events, starting from an empty value and from an already formatted value.');
    expect(orchestratorPrompt).toMatch(/typing key by key;\r?\n  - deleting;\r?\n  - inserting mid-value;\r?\n  - pasting and dropping, whole and partial;\r?\n  - replacing a selection;\r?\n  - each shipped locale's separators\./);
    expect(orchestratorPrompt).toContain('A new kind modelled as an existing enum value plus a flag');
    expect(orchestratorPrompt).toContain("Close each consumer entry only with an assertion of the new kind's effect on it.");
    expect(orchestratorPrompt).toContain('every export, download, template, import, summary or total path that uses the list');
    expect(orchestratorPrompt).toContain('An unreproduced defect gets a first bead that measures the named values, props, loop state or geometry without product changes.');
    expect(orchestratorPrompt).toContain('A finding that would widen autonomous authority to merge, approve, delete or publish (for example, publishing automatically with no human step): `ask_user`');
    expect(orchestratorPrompt).toContain('Walk the applicable blank, zero, new, removed, duplicate, maximum and count/label states, with one live read-back each.');
    expect(orchestratorPrompt).toContain('A changed file, message or payload goes through its real consuming screen.');
    expect(orchestratorPrompt).toContain('Re-run the setup command first when `package.json` or a lockfile changed.');
    expect(orchestratorPrompt).toContain('a malformed line, a bare status line ("I\'ll wait"), no final message, or an evidence-gate failure');
    expect(orchestratorPrompt).toContain('reopens as `verify_incomplete`');
    expect(orchestratorPrompt).toContain('`Check: <command> - PASS - <summary>`');
    expect(orchestratorPrompt).toContain('Add `verify_command: "<command>"` when one command decides pass or fail.');
    expect(orchestratorPrompt).toContain('Without it, a PASS `Check:` line and no non-PASS line closes the bead as worker-reported');
    expect(orchestratorPrompt).toContain('as worker-reported if the evidence gate passes; say so in review notes.');
    expect(orchestratorPrompt).toContain('says what makes a baseline comparison PASS');
    expect(orchestratorPrompt).toContain('greps touched doc counts, file names and claims against the merged code');
    expect(orchestratorPrompt).toContain('Orchestration and worker lessons join the open lessons batch, either in its bead or in one bead chained after it.');
    expect(orchestratorPrompt).toContain('If no lessons batch is open, create a batch on `overseer`');
    expect(orchestratorPrompt).toContain('re-runs setup when dependencies changed.');
    expect(orchestratorPrompt).toContain('On Windows, run `pnpm`, vitest and builds in PowerShell');
    expect(orchestratorPrompt).toContain('A corepack module-not-found error means the wrong shell.');
  });
});

describe('layout, evidence and review-process lessons', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const criticTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/critic.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('sizes a layout to the container the view actually gets', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('Measure the container, not the viewport.');
    expect(orchestratorPrompt).toContain("A layout's columns do not fit the container the view actually gets in that band, after menus and padding.");
    expect(workerPrompt).toContain('measure the width the container actually gets (after side menus and padding), not the viewport');
  });

  it('starts each capture attempt with a fresh evidence folder', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain('Before capturing, empty the evidence folder the task names, or write into a new subfolder for this attempt, so the reported folder holds only files this attempt made and checked.');
  });

  it('keeps review findings in the final submit_review call and out of a re-dispatch', () => {
    const criticPrompt = buildCriticPrompt(criticTemplate, { bead, repoId: 'overseer', branch: 'bead/ov-1', base: 'main', diff: 'diff', round: 1, limit: 2 });
    expect(criticPrompt).toContain('Findings live only in this `submit_review` call; never write a `[must]` or `[should]` marker in an interim message.');
    expect(orchestratorPrompt).toContain('a report with no defect) is not re-dispatched.');
  });

  it('does not interrupt a worker whose re-dispatched review round has no defect', () => {
    expect(orchestratorPrompt).toContain('A finding that is not a defect (a verdict the critic could not record');
    expect(orchestratorPrompt).toContain('If the daemon already re-dispatched on one, do not interrupt the worker.');
    expect(orchestratorPrompt).toContain('put the verdict to the user, and call `accept_review` on their word.');
    expect(orchestratorPrompt).toContain('Interrupting is only for work that should stop.');
  });

  it('verifies values copied from an external catalog', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain("copied from a vendor catalog is checked against the vendor's own documentation or catalog before it ships");
    expect(workerPrompt).toContain('the source is quoted in the final message');
  });

  it('starts servers through the start_server tool, never in its own shell', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain('Never start a server, daemon or browser in your shell');
    expect(workerPrompt).toContain('a shell call does not return while a process it started still holds its output');
    expect(workerPrompt).toContain('Use `start_server` instead');
    expect(workerPrompt).toContain('returns a `server_id`');
    expect(workerPrompt).toContain('Poll `server_logs` with a bounded wait until the ready line appears before you use the server');
    expect(workerPrompt).toContain('`stop_server` stops one early; you do not need to stop anything before your final message, because every server you started is stopped when your session ends.');
    // the shell recipes this replaced were dropped on purpose: reinstating either must fail here
    expect(workerPrompt).not.toContain('with none of its standard handles attached to the shell');
    expect(workerPrompt).not.toContain('-RedirectStandardOutput');
  });

  it('runs npm CLIs and builds in PowerShell from the start, ahead of the other shell rules', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    const rule = 'On Windows, run `pnpm`, `npm`, `npx`, `vitest`, `playwright`, `playwright-cli` and builds in PowerShell from the start, never in Bash';
    expect(workerPrompt).toContain(rule);
    expect(workerPrompt.indexOf(rule)).toBeLessThan(workerPrompt.indexOf('On Windows, write and resolve files'));
    expect(workerPrompt.indexOf(rule)).toBeLessThan(workerPrompt.indexOf('Background commands are blocked for workers'));
    expect(workerPrompt).toContain('run the same command from PowerShell instead of retrying it in Bash or reporting the check as blocked');
    // The merge retained the existing PowerShell fallback alongside the preflight command/flag check.
    expect(workerPrompt).toContain('When a `pnpm`, `npx` or `playwright-cli` call fails in Bash');
  });

  it('places a new document sentence in the section that already covers its topic', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain('Before adding a sentence to a document, grep that document for the facts it states');
    expect(workerPrompt).toContain('put the sentence in the section that already covers the topic, extending that text rather than repeating it, and never above the first heading');
  });
});

describe('batch shape and worker coordination lessons', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('requires a shared component contract to become its own blocking bead', () => {
    expect(orchestratorPrompt).toContain("Beads sharing a component: read the component's contract first.");
    expect(orchestratorPrompt).toContain('Each requirement that needs shell-owned state becomes its own bead. That bead lands first, and the others are blocked by it.');
  });

  it('requires coordination that must outlive a turn to be written to the bead notes', () => {
    expect(orchestratorPrompt).toContain("Anything you tell a worker that must outlive the turn also goes in the bead's notes.");
  });
});

describe('silence-limit lessons', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('tells a worker that a silent long run is killed and must be split', () => {
    const p = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('killed on a harness with a silence limit however healthy it is');
    expect(p).toContain('split longer runs — a subset at a time, or per file with a bounded timeout');
    expect(p).toContain('so an interruption cannot cost the whole round');
  });

  it('forces a harness within a tier when both are passed, and relays the refusal instead of moving it', () => {
    expect(orchestratorPrompt).toContain("With `tier`, it takes that tier's candidate on that CLI, or returns a refusal that you relay.");
    expect(orchestratorPrompt).toContain("Add `tier` if the work needs that tier's strength.");
    expect(orchestratorPrompt).not.toContain('passing both lets the tier choose another harness');
  });

  it('chooses a CLI with headroom for adapter failures and long, silent commands', () => {
    expect(orchestratorPrompt).toContain('The bead fixes a harness adapter, or its notes show a harness failing before any work (startup crash, argument error, hang before any API call). Use another CLI with usage headroom that fits; `claude` only if sole fit.');
    expect(orchestratorPrompt).toContain('The Definition of Done is a long, silent command (slow suite, full build). Choose a fitting CLI with usage headroom; Codex waits for `turn.completed` or exit; `claude` only if sole fit, because opencode\'s adapter ends a turn that is silent for 20 minutes.');
    expect(orchestratorPrompt).toContain('Force `claude` only for a Claude-only MCP tool (Figma) or user rules; automatic retries keep the harness pinned.');
    expect(orchestratorPrompt).toMatch(/Pass `harness` only in these cases:\r?\n    - The user asks for a CLI\./);
    expect(orchestratorPrompt).toContain('A stall notice: check `worker_status` and the child processes.');
    expect(orchestratorPrompt).toContain('or whose process uses CPU, is working: leave it and write nothing.');
  });
});

describe('orchestrator.md merge-from-base serialization rule', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('serializes merges into the base while a merge-from-base bead is in flight', () => {
    expect(orchestratorPrompt).toContain('While a merge-from-base bead is in flight, merge nothing else into the base.');
    expect(orchestratorPrompt).toContain('Merge waiting batches one at a time, in a stated order.');
  });

  it('requires the merge-tree check of the batch branch to exit 0', () => {
    expect(orchestratorPrompt).toContain('`git merge-tree --write-tree <base> <branch>`');
    expect(orchestratorPrompt).not.toContain('`git merge-tree --write-tree <base> HEAD`');
    expect(orchestratorPrompt).toContain('<branch>` must exit 0.');
  });
});

describe('orchestrator.md review-finding premise check', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it("checks a relayed finding's factual claim against fixtures or logs before passing it on", () => {
    expect(orchestratorPrompt).toContain('A finding that prescribes a mechanism based on a factual claim about data');
    expect(orchestratorPrompt).toContain('check the claim against fixtures or logs.');
    expect(orchestratorPrompt).toContain('If not, say what the data shows and let the worker choose the mechanism.');
    expect(orchestratorPrompt).toContain('If it holds, relay it.');
  });
});

describe('orchestrator.md shared documentation surfaces rule', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('dispatches beads with documentation-only overlap in parallel', () => {
    expect(orchestratorPrompt).toContain('Overlap only in documentation (README, CLAUDE.md, specs, append-only logs like `docs/lessons.md`, non-prompt Markdown) does not chain.');
    expect(orchestratorPrompt).toContain("keep both sides' text");
    expect(orchestratorPrompt).not.toContain("chain the beads so each branches from a batch branch carrying the previous bead's documentation");
    expect(orchestratorPrompt).toContain('reread the sentences around each hunk and after any appended list entry.');
    expect(orchestratorPrompt).toContain('A bead that appends to a list in one of those documents rereads the sentences right after the list, since a list that gains entries can change what a following sentence refers to.');
  });
});

describe('acme-portal-sample-015 prompt lessons', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('runs the evidence gate before the critic and re-dispatches its first failure automatically', () => {
    expect(orchestratorPrompt).toContain('The evidence gate runs before a critic review for an opted-in code bead, and its first failed check automatically re-dispatches the same worker.');
  });

  it('reopens verification-only beads when the opted-in evidence gate fails', () => {
    expect(orchestratorPrompt).toContain('Unless a stop wins, the daemon evaluates an opted-in evidence report against the bead description, final message and worktree HEAD before either close. A failure reopens as `verify_incomplete`; the note and notice list every problem.');
    expect(orchestratorPrompt).toContain('If `verify_command` and the gate both fail, one reopen includes both reasons.');
    expect(orchestratorPrompt).toContain('a bare status line ("I\'ll wait"), no final message, or an evidence-gate failure.');
  });

  it('counts re-dispatches per bead and stops after the third', () => {
    expect(orchestratorPrompt).toContain('Count re-dispatches per bead, not per surface');
    expect(orchestratorPrompt).toContain('After the third re-dispatch of a bead, stop and `ask_user` with what is left');
  });

  it('does not re-dispatch a comment-only finding on its own', () => {
    expect(orchestratorPrompt).toContain('Findings that are only stale comments or doc sentences never get a round of their own.');
    expect(orchestratorPrompt).toContain('Findings with no `[must]` item: the bead lands, and its notice lists them under `review findings landed with (round N)`.');
  });

  it('checks the preconditions of a live-evidence bead before dispatching it', () => {
    expect(orchestratorPrompt).toContain('Before dispatching a live-evidence bead, check its preconditions and write them into the description or the instructions:');
    expect(orchestratorPrompt).toContain('the port the auth realm whitelists (a dev server on any other port cannot sign in)');
    expect(orchestratorPrompt).toContain('whether the backend needs the VPN;');
    expect(orchestratorPrompt).toContain('After a round blocked by one of these, wait until it holds. Then re-dispatch with all of them named.');
  });

  it('sends an unbuildable prescription to the user', () => {
    expect(orchestratorPrompt).toContain('the prescription itself cannot be built');
    expect(orchestratorPrompt).toContain('verify it once (`worker_diff`, the file). Then `ask_user`, explaining why it cannot be built and asking for a new prescription or a decision.');
    expect(orchestratorPrompt).toContain('Re-dispatch only with their answer.');
  });

  it('stays silent when nothing is needed', () => {
    expect(orchestratorPrompt).toContain('A notice you handle yourself gets no message');
    expect(orchestratorPrompt).toContain('End the turn silently after the tool calls.');
  });
});

describe('acme-portal-sample-017 and acme-portal-sample-016 prompt lessons', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('puts a removed or degraded behaviour to the user before review, and checks an unavailable-tool claim', () => {
    expect(orchestratorPrompt).toContain('A behaviour the previous release had that this change removes or degrades');
    expect(orchestratorPrompt).toContain('removes or degrades: `ask_user` for a decision before requesting review.');
    expect(orchestratorPrompt).toContain('Never record a gate as Unverified on an unchecked claim');
    expect(orchestratorPrompt).toContain('if a worker says a tool was unavailable, call the tool yourself.');
  });

  it("names a persisted value's old rule and the keys it shadows", () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('A change to the precedence or meaning of a persisted value');
    expect(orchestratorPrompt).toContain('State what happens to values written under the old rule: kept, migrated or reset once.');
    expect(workerPrompt).toContain('run the Definition-of-Done check once with a value already written under the old rule present');
  });

  it('runs every test that writes shared state together with the new one', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('Moving state from browser-local to account-wide or onto a shared fixture');
    expect(orchestratorPrompt).toContain("register the state in the repo's shared-state guard.");
    expect(workerPrompt).toContain('run every existing test that writes that state together with the new one');
    expect(workerPrompt).toContain("register the state in the repo's shared-state guard where one exists");
  });

  it('dispatches a tool-gated task to a harness that has the tool', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('The Definition of Done needs an MCP tool only some harnesses have (Figma, PixelLab: `claude`).');
    expect(orchestratorPrompt).toContain('A gate that needs an MCP tool names that tool in the description (for example Figma `get_design_context`) and goes to a harness that has it (`claude`).');
    expect(workerPrompt).toContain('A gate your task says needs a specific tool is not recorded as Unverified on an assumption');
  });

  it('counts changed pixels without a fuzzy ImageMagick total', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain('Evidence that counts changed pixels does not use `magick compare -metric AE`');
    expect(workerPrompt).toContain('use a strict difference composite and report the diff bounding box');
  });
});

describe('acme-portal-sample-018 worker delegation rule', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };
  const harnesses: HarnessName[] = ['claude', 'codex', 'opencode'];

  it.each(harnesses)('tells a %s worker to wait for delegated work and never end a turn on a promise', () => {
    const p = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('you wait for the delegated result inside your own turn, verify it and commit it yourself');
    expect(p).toContain('never end a turn while work you started is still running elsewhere');
    expect(p).toContain('never end with a promise to report later');
    expect(p).toContain('commit what exists in stages and report what is unfinished');
    expect(p).toContain('delegate work to a foreground agent or subagent, never a background one');
    expect(p).not.toContain('delegate work to a background agent'); // would contradict the no-background-subagent rule
    expect(p).toContain('Never run an Agent tool or subagent in the background');
  });
});

describe('overseer-b80-s45y prompt lessons', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('measures a wall-clock Definition of Done alone and reports the load with a timing', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('Beads whose Definition of Done is a wall clock (timing target, performance floor, stability run)');
    expect(orchestratorPrompt).toContain('are chained with `blocked-by:` and run one at a time, even when their files are disjoint.');
    expect(orchestratorPrompt).toContain('Each description says it measures with no other worker on the machine.');
    expect(workerPrompt).toContain('A `Check:` line that quotes a timing carries the machine load it was measured under');
    expect(workerPrompt).toContain('Every check is one `Check:` line');
    expect(workerPrompt).toContain('`Check: <command> - PASS|FAIL - <summary>`');
    expect(workerPrompt).toContain('a measurement taken while other workers ran is not evidence the target is met');
  });

  it('reads a test duration from its reporter line, not the run Duration line', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt.match(/- Test time: own reporter line/g)).toHaveLength(1);
    expect(orchestratorPrompt).toContain("- Test time: own reporter line (`--reporter verbose`), not run `Duration`.");
    expect(workerTemplate.match(/- Test time: its reporter line/g)).toHaveLength(1);
    expect(workerPrompt).toContain("- Test time: its reporter line (`--reporter verbose`), not the run's `Duration` (adds startup, transform, setup, collection).");
  });

  it('scores a score or critic-verdict Definition of Done on the committed head and quotes its sha', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('- Score or verdict Definition of Done (audit grade, `OFFICE-CRITIC` counts): last run on the committed head, quoted with its sha.');
    expect(orchestratorPrompt).toContain('- When the user states a target, any round or re-audit cap is a cost stop: if reached below the target, report what remains and what it cost to the user; never report the task as done.');
    expect(workerPrompt).toContain('- Score or verdict Definition of Done (audit grade, `OFFICE-CRITIC` counts): run it last on the committed head and quote that run with its sha.');
  });

  it('fails a visual gate whose capture does not render production assets', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('- Visual gates (screenshots, critic, parity) pass only when captures show production assets without fallback, placeholder art or asset 404s in console.');
    expect(workerPrompt).toContain('A visual gate (screenshots, a critic, parity) first proves the capture renders production assets: no fallback or placeholder art and no asset 404 in the console, or the capture fails.');
  });

  it('scopes a critic or score gate to what the bead may change', () => {
    expect(orchestratorPrompt).toContain('- Critic/score gates cover permitted changes; list documented unchanged areas and do not count findings there.');
  });

  it('merges a moved deployed base into the batch branch before a suite and repeats a remote suite run with network errors', () => {
    expect(orchestratorPrompt.match(/Deployed-base suite:/g)).toHaveLength(1);
    expect(orchestratorPrompt).toContain("- Deployed-base suite: fetch base; if moved, merge it into the batch branch first, or base changes fail as the branch's.");
    expect(orchestratorPrompt.match(/Long remote suite:/g)).toHaveLength(1);
    expect(orchestratorPrompt).toContain("- Long remote suite: watch the network all run (each host every 30 s, logged 10 s timeout), count connection errors in the run log; rerun on any, don't diagnose.");
  });

  it('re-verifies an account-exhausted or crashed review round instead of re-dispatching it', () => {
    expect(orchestratorPrompt).toContain('A reopen for an unavailable account or a crashed critic is not a work failure');
    expect(orchestratorPrompt).toContain('Call `retry_verification` and never re-dispatch.');
    expect(orchestratorPrompt).toContain('Re-dispatch only for missing commits, a failed check or a merge conflict.');
  });

  it("quotes a sibling's decisive results in a bead description instead of pointing at its notes", () => {
    expect(orchestratorPrompt).toContain("Never tell the worker to read another bead's notes.");
    expect(orchestratorPrompt).toContain('read their notes and quote the decisive results verbatim in the description.');
  });
});

describe('measurement and test-subject prompt lessons', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };
  const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });

  it('closes a measured gap on the side the task names', () => {
    expect(workerPrompt).toContain('close it by changing the one the task names');
    expect(workerPrompt).toContain('a placeholder, a reserve or a fixture moves to fit the product, and the product never moves to fit them');
    expect(workerPrompt).toContain('a regression wearing a passing measurement');
    expect(workerPrompt).toContain('report the residual as a `FAIL` line instead');
  });

  it('drives the real entry point instead of reproducing its side effects', () => {
    expect(workerPrompt).toContain('When the property under test belongs to a real entry point, the test calls that entry point');
    expect(workerPrompt).toContain('proves only that your reproduction works');
    expect(workerPrompt).toContain('proves the exemption, not the requirement');
    expect(workerPrompt).toContain('Seed the state the real path needs and drive it');
  });
});

describe('overseer-b120-xflu prompt lessons: focused tests per bead, full suite once per batch', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const criticTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/critic.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it("names focused test files and typecheck as an ordinary bead's Definition of Done, never the full suite or a wall-clock/two-green-runs requirement", () => {
    expect(orchestratorPrompt).toContain('An ordinary Definition of Done names the focused test files (`vitest run <file>` in the right mode) and `pnpm typecheck`. It never names the full suite, a wall clock or two green runs.');
  });

  it('uses the daemon review check or runs the full suite once before requesting review', () => {
    expect(orchestratorPrompt).toContain('With a `review_command`, quote `review_check` from `list_batches`.');
    expect(orchestratorPrompt).toContain('Otherwise run the full suite once yourself, with no worker on the machine, and quote the result.');
    expect(orchestratorPrompt).toContain('Investigate a failure on the idle machine.');
  });

  it('has a reviewer run only the touched files and treat an untouched timeout as an environment observation', () => {
    expect(criticTemplate).toContain('If you run tests to judge the change, run the files it touches, not the whole suite');
    expect(criticTemplate).toContain('a timeout in a file the change did not touch is an environment observation, not a finding');
  });

  it("does not let a worker run the full suite on its own initiative when the task names only focused files", () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain('When the task names only focused test files, run those; do not run the full suite on your own initiative');
  });
});

describe('CI variables, stale Definition-of-Done commands and unchanged cases', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it("runs a check that also gates a pipeline job with that job's variables", () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain("Run a check that gates a pipeline job with that job's variables from `.gitlab-ci.yml`.");
    expect(workerPrompt).toContain("A check that also gates a pipeline job (a build, a budget, a lint) runs with that job's variables read from `.gitlab-ci.yml`");
    expect(workerPrompt).toContain('a local run under other variables is not evidence the job passes');
  });

  it('checks that each Definition-of-Done command still selects what it names', () => {
    expect(orchestratorPrompt).toContain('Check that each command still selects what it names.');
  });

  it('describes a case the new rule leaves as it is as unchanged', () => {
    expect(orchestratorPrompt).toContain('A case that a new rule leaves as it is gets written as "unchanged: <today\'s behaviour>".');
  });
});

describe('overseer-b88-lcla prompt lessons', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('commits finished work as it stands and reports a clean worktree', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain('Commit each finished piece of work as soon as it stands on its own, and never end a turn with changes in the worktree');
    expect(workerPrompt).toContain('an uncommitted edit passes its checks and is then dropped at the merge');
    expect(workerPrompt).toContain('Run `git status` before the final message and report it clean');
  });

  it('seeds a live board only after the daemon is up, with the reaper off', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(orchestratorPrompt).toContain('Seeded-board evidence: seed only after the daemon is up.');
    expect(orchestratorPrompt).toContain('Run with `OVERSEER_REAP_MIN=0` and a stall threshold longer than the run.');
    expect(orchestratorPrompt).toContain('Assert that the seeded state is on screen before capturing.');
    expect(workerPrompt).toContain('When the evidence needs a seeded board, seed it only after the daemon is up');
    expect(workerPrompt).toContain('run with `OVERSEER_REAP_MIN=0` and a stall threshold larger than the run');
    expect(workerPrompt).toContain('assert the seeded state is on screen before any capture');
    expect(workerPrompt).toContain('rows written before the daemon starts are ended by recovery, so a capture taken then shows an empty install');
  });
});

describe('overseer-b118-dq6f prompt lessons', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('does not demand a live proof from a worker for behaviour only the daemon can exhibit', () => {
    expect(orchestratorPrompt).toContain('In the overseer repo, behaviour only observable in a session the daemon starts');
    expect(orchestratorPrompt).toContain('A daemon fix merged into overseer `main` is live only after a manual restart.');
    expect(orchestratorPrompt).toContain('is proven by unit tests plus a probe outside the daemon.');
    expect(orchestratorPrompt).toContain('Live confirmation follows the merge and a restart; say so in the note.');
  });

  it('checks present-day behaviour claims against their producing code before dispatch', () => {
    expect(orchestratorPrompt).toContain("Before dispatch, check each claim a description makes about today's behaviour against the code that produces it, and quote the file and line.");
  });

  it('lists every place user-facing copy lives, including generated-file sources and reasons to leave a place unchanged', () => {
    expect(orchestratorPrompt).toContain("Changing user-facing copy: grep the repo for the old text's distinctive phrases, including sources of generated files such as a PDF or an image. The task description lists every place the copy lives, or says why a place stays unchanged.");
  });

  it('produces the list of places to correct by grepping for the claim, not from a review finding', () => {
    expect(orchestratorPrompt).toContain('Correcting a statement about behaviour: grep the repo for the claim');
    expect(orchestratorPrompt).toContain("the claim's distinctive phrases (in docs, comments and test names)");
    expect(orchestratorPrompt).toContain('fix every hit, not only the hits a reviewer named.');
    expect(orchestratorPrompt).toContain('List the phrases grepped');
  });
});

describe('boundedCriticPrompt', () => {
  const template = fs.readFileSync(fileURLToPath(new URL('../../prompts/critic.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'D'.repeat(400), status: 'open' as const, priority: 1, labels: [], notes: 'N'.repeat(400), assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };
  const input = { bead, repoId: 'r1', branch: 'bead/ov-1', base: 'main...HEAD', diff: 'x'.repeat(20000), instructions: 'I'.repeat(400), workerText: 'W'.repeat(400), round: 1, limit: 2 };
  const stat = Array.from({ length: 200 }, (_, n) => ` src/file-${n}.ts | 12 ++++----`).join('\n');

  it('sends the whole prompt when it fits', () => {
    const { prompt, omitted } = boundedCriticPrompt(template, input, 1_048_576, '');
    expect(omitted).toEqual([]);
    expect(prompt).toContain('x'.repeat(20000));
  });

  it('replaces the diff with the file list and names the size, the limit and the refs', () => {
    const { prompt, omitted } = boundedCriticPrompt(template, input, 12000, stat);
    expect(prompt.length).toBeLessThanOrEqual(12000);
    expect(prompt).not.toContain('x'.repeat(20000));
    expect(prompt).toContain('src/file-199.ts');
    expect(prompt).toContain('N'.repeat(400)); // the optional context still fits, so it is kept
    expect(omitted).toEqual([expect.stringContaining('the diff of `main...HEAD`, which made the prompt ')]);
    expect(omitted[0]).toContain('against the 12000 the harness accepts');
  });

  it('keeps the review and verdict instructions when the reduced prompt still exceeds the limit', () => {
    const { prompt, omitted } = boundedCriticPrompt(template, input, 5000, stat);
    expect(prompt.length).toBeLessThanOrEqual(5000);
    // Every mandatory part survives: what to judge, how to finish, and the identifiers submit_review needs.
    expect(prompt).toContain('## What to look for');
    expect(prompt).toContain('calling the `submit_review` tool once, with repo `r1`, bead_id `ov-1`');
    expect(prompt).toContain('verdict: "findings"');
    expect(prompt).toContain('Add login');
    expect(prompt).toContain('D'.repeat(400)); // the description carries the review criteria and outlives the file list
    // And everything it dropped is named to the critic and in `omitted`, which the bead note carries.
    expect(prompt).not.toContain('N'.repeat(400));
    expect(omitted[1]).toContain("the notes from earlier rounds, the orchestrator's instructions");
    expect(omitted[2]).toMatch(/^\d+ of the 200 lines of the file list$/);
    expect(prompt).toContain('lines of the file list are not shown either');
    expect(prompt).toContain('src/file-0.ts'); // what did fit is still shown
  });
});

describe('boundedCriticPrompt omission notices', () => {
  const template = fs.readFileSync(fileURLToPath(new URL('../../prompts/critic.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'D'.repeat(400), status: 'open' as const, priority: 1, labels: [], notes: 'N'.repeat(400), assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };
  const input = { bead, repoId: 'r1', branch: 'bead/ov-1', base: 'main...HEAD', diff: 'x'.repeat(20000), instructions: 'I'.repeat(400), workerText: 'W'.repeat(400), round: 1, limit: 2 };
  const stat = Array.from({ length: 200 }, (_, n) => ` src/file-${n}.ts | 12 ++++----`).join('\n');
  const at = (limit: number) => boundedCriticPrompt(template, input, limit, stat);

  it('tells the critic in the prompt that the notes, the instructions and the final message are gone', () => {
    const { prompt, omitted } = at(11000);
    expect(omitted).toHaveLength(2); // the diff and the optional context only
    expect(prompt).toContain('The notes from earlier rounds are not included');
    expect(prompt).toContain("The orchestrator's instructions to the worker are not included");
    expect(prompt).toContain("The worker's final message is not included");
    expect(prompt).toContain('D'.repeat(400)); // the description still fits and is kept
  });

  it('clips the file list before it drops the task description, which carries the review criteria', () => {
    const { prompt, omitted } = at(9500);
    expect(prompt).toContain('D'.repeat(400)); // the criteria survive
    expect(omitted[2]).toMatch(/^\d+ of the 200 lines of the file list$/);
    expect(prompt).toContain('lines of the file list are not shown either');
  });

  it('drops the task description only in the last resort, and tells the critic to report the missing criteria', () => {
    const { prompt, omitted } = at(4800);
    expect(prompt.length).toBeLessThanOrEqual(4800);
    expect(prompt).not.toContain('D'.repeat(400));
    expect(omitted[2]).toContain("the task's description, which carries the review criteria");
    expect(omitted[3]).toMatch(/^\d+ of the 200 lines of the file list$/);
    expect(prompt).toContain("The task's description is not included");
    expect(prompt).toContain('report that instead of reviewing the change against criteria you cannot read');
  });

  it('never renders an instruction the prompt itself forbids', () => {
    // The critic prompt ends with "Do not run `bd`", so no reduced prompt may point the critic at a `bd` command.
    for (const limit of [1_048_576, 12000, 10000, 9500, 8000, 4200, 3600, 3000]) {
      const { prompt } = at(limit);
      expect(prompt).toContain('Do not run `bd`');
      expect(prompt).not.toMatch(/`bd [^`]*`/);
    }
  });

  it('leaves a section that was empty to begin with empty, claiming nothing was dropped there', () => {
    const bare = { ...input, bead: { ...bead, notes: '' }, instructions: null, workerText: null };
    const { prompt } = boundedCriticPrompt(template, bare, 8000, stat);
    expect(prompt).not.toContain('The notes from earlier rounds are not included');
    expect(prompt).not.toContain("The worker's final message is not included");
  });
});

describe('acme-portal-sample-020 prompt lessons', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it("checks a bead's user-visible rule against principles the user already stated", () => {
    expect(orchestratorPrompt).toContain('A user-visible counting or behaviour rule contradicts a principle the user already stated on that subject in this batch or a sibling batch.');
    expect(orchestratorPrompt).toMatch(/Call `ask_user` before dispatch when:\r?\n- A user-visible counting or behaviour rule contradicts a principle/);
  });

  it('seeds a fixture with the value the real caller passes', () => {
    const p = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain("uses the value grepped from that component's call site");
    expect(p).toContain('a value the real caller never produces is not coverage even when the test passes');
  });

  it('accounts for every assertion a test-file rewrite removes', () => {
    const p = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('A worker that edits an existing test file diffs it against the merge base before finishing');
    expect(p).toContain('every assertion the diff removes is restored or named in the final message with the reason it no longer applies');
  });
});

describe('overseer-b132-dimb transient UI state rule', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('requires a transient UI state to name its start, its end and the event orders its tests cover', () => {
    expect(orchestratorPrompt).toMatch(/A transient UI state \(pending, loading, optimistic\) names:\r?\n  - the event that starts it;/);
    expect(orchestratorPrompt).toContain("the event that ends it (the job's result, not the HTTP acknowledgement);");
    expect(orchestratorPrompt).toContain('what the user sees when it ends in failure');
    expect(orchestratorPrompt).toContain('the tested event orders: result before acknowledgement, result before refresh, a failed refresh, a reload while pending.');
  });
});

describe('overseer-b137-zfnw automatic recovery rule', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('requires an automatic recovery to name its event orders before dispatch', () => {
    expect(orchestratorPrompt).toContain('An automatic recovery (retry, resume, replay) states all of the following');
    expect(orchestratorPrompt).toContain('the session and account it recovers on');
    expect(orchestratorPrompt).toContain('where its once-only guard lives, so the guard survives a daemon restart and re-adoption;');
    expect(orchestratorPrompt).toContain('a stop from the user or the orchestrator wins over it');
    expect(orchestratorPrompt).toContain('- the first-turn case;');
    expect(orchestratorPrompt).toContain('what happens to pending work in a process it restarts.');
    expect(orchestratorPrompt).toContain('and its tests cover each event order:');
  });
});

describe('reachable data state rule', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('checks that a data state is reachable before building or changing behaviour for it', () => {
    expect(orchestratorPrompt).toContain('A behaviour targets a data state (0 total, empty list, missing field) that the product cannot produce.');
    expect(orchestratorPrompt).toContain('Check the validation schema, API or import path, and quote what you found.');
  });

  it('keeps the reachable-state sentence after the principles sentence it must not split', () => {
    const principles = orchestratorPrompt.indexOf('A user-visible counting or behaviour rule contradicts a principle the user already stated');
    const reachable = orchestratorPrompt.indexOf('A behaviour targets a data state (0 total, empty list, missing field)');
    expect(principles).toBeGreaterThan(-1);
    expect(reachable).toBeGreaterThan(principles);
  });
});

describe('acme-portal-sample-021 acceptance-criteria check', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('checks every touched story\'s acceptance criteria before requesting review', () => {
    expect(orchestratorPrompt).toContain("Fetch the batch's story and every story whose code the branch changes.");
    expect(orchestratorPrompt).toContain("Give each current acceptance criterion a verdict and its covering test, reusing the workers' AC tables in the review note.");
    expect(orchestratorPrompt).toContain('A contradiction goes to the user as a decision.');
    expect(orchestratorPrompt).toContain('Criteria verified in an earlier note stay in the rewritten one.');
  });
});

describe('overseer-9ipk parity and story report formats', () => {
  const workerPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('opts Figma parity and live-capture beads into width and locale reporting', () => {
    expect(orchestratorPrompt).toContain('A bead asking for Figma parity or live captures puts `Parity widths: <comma list>` in its description and, when locales matter, `Parity locales: <comma list>`; a story bead that names acceptance criteria asks the worker to end its results with an AC table.');
  });

  it('requires final-head parity lines and upload or local evidence before parity lines', () => {
    const reportRule = 'If the task description includes `Parity widths:`, re-measure every in-scope frame/width/locale combination after the last commit on final `HEAD`; report every upload first as `Evidence: <full https URL> - <caption>`, or, when the task says the repo has no upload target, as `Evidence: <absolute path> - <caption>` with a path outside the worktree, one line per file, then report one `Parity: <frame> | <width>px | <locale> | <score> | <sha>` line per combination; `<score>` may be a number, a percentage, or `<n> gaps, <number>`.';
    expect(workerPrompt).toContain(reportRule);
    expect(workerPrompt.indexOf('Evidence: <full https URL> - <caption>')).toBeLessThan(workerPrompt.indexOf('Parity: <frame> | <width>px | <locale> | <score> | <sha>'));
    expect(workerPrompt.indexOf('Evidence: <absolute path> - <caption>')).toBeLessThan(workerPrompt.indexOf('Parity: <frame> | <width>px | <locale> | <score> | <sha>'));
    expect(orchestratorPrompt).toContain("Without a GitLab project, the evidence bead's description names a path outside the worktree, the worker copies the files there, and reports each file as `Evidence: <absolute path> - <caption>`.");
  });

  it('ends story results with one verdict row per acceptance criterion', () => {
    expect(workerPrompt).toContain('For a story task that names acceptance criteria, end the results block with a table headed `AC | verdict | covering test or read-back`, one row per criterion, using `Covered`, `Not covered` or `Blocked` (with the reason).');
  });
});

describe('overseer-b140-ft5s harness CLI probe rule', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('requires a bead that runs a harness CLI outside the daemon to name its credentials and require a non-blank probe per harness', () => {
    expect(orchestratorPrompt).toContain('Running a harness CLI outside the daemon: state where its credentials and model come from');
    expect(orchestratorPrompt).toContain('require a one-line probe per harness that answers non-blank before the real run.');
    expect(orchestratorPrompt).toContain('A bead that runs a harness CLI repeatedly (evals, probes, benchmarks) states the call budget, runs per query and model, and requires the worker to count calls and stop at the budget.');
  });
});

describe('overseer-b160-s2cz code-produced probe strings', () => {
  const workerPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('requires probes to use and report the exact string produced by code', () => {
    expect(workerPrompt).toContain('A live probe of code that builds a command, URL or query runs the exact string the code produces, printed from the code path itself rather than hand-written; quote that string in the final message. A unit test for a built external path checks it against a real sample of the external API route, not just the code\'s output.');
    expect(orchestratorPrompt).toContain('A probe of code that builds a command, URL or query prints and uses the exact string the code produces, and the worker quotes it.');
  });
});

describe('review note evidence and repository instruction rules', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Test', description: 'Test', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('captures the whole destination screen a new link, button or route opens', () => {
    expect(orchestratorPrompt).toContain('A new way into another screen: capture the whole destination');
    expect(orchestratorPrompt).toContain('as the user lands on it, at each checked width.');
  });

  it('stores user-supplied references and names the evidence check in each gate', () => {
    expect(orchestratorPrompt).toContain('A reference the user supplies in chat (a portrait, a screenshot, a design export) is copied at once to a named path outside the repository under the evidence folder. Every bead whose gate compares against it names that path. A gate that says "keep" a likeness or palette names the check that proves it (a side-by-side against the reference, or colour values per region).');
  });

  it('uses repository-owned review guidance and keeps repository rules with that repo', () => {
    expect(orchestratorPrompt).toContain("- follows the repo's MR/PR skill or template;");
    expect(orchestratorPrompt).toMatch(/The review note:\r?\n(- [^\r\n]*\r?\n)*- follows the repo's MR\/PR skill or template;/);
    expect(orchestratorPrompt).toContain("Before dispatching an evidence bead in a repo whose MR/PR skill defines an evidence layout, read that layout and have the bead capture and upload every item it needs, including Figma exports and every width and locale column. Write the review note from the repo's MR template, not from memory.");
    expect(orchestratorPrompt).toContain('A lesson about how a managed repo works');
    expect(orchestratorPrompt).toContain("goes into that repo's instruction files, through a bead in that repo.");
  });

  it('requires workers to read repository instructions and matching skills', () => {
    const workerPrompt = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(workerPrompt).toContain("Before starting, read the repository's root");
    expect(workerPrompt).toContain('`CLAUDE.md` and `AGENTS.md`');
    expect(workerPrompt).toContain('in directories you touch');
    expect(workerPrompt).toContain('.claude/skills/');
    expect(workerPrompt).toContain('read the name and description of each skill');
    expect(workerPrompt).toContain('follow every skill whose description matches the task');
    expect(workerPrompt).toContain('as a Claude session in that repository would');
    expect(workerPrompt).toContain('This applies whatever harness you run on');
    expect(workerPrompt.indexOf('Before starting, read the repository')).toBeLessThan(workerPrompt.indexOf('Do not run'));
  });

  it('describes what the capture shows and names a destination the change does not build', () => {
    expect(orchestratorPrompt).toContain('- describes what each evidence capture shows;');
    expect(orchestratorPrompt).toContain('- names any destination this change does not build, and what the user sees there today;');
  });
});

describe('overseer-b187-gh45 merge marker rule', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Resolve merge', description: 'Resolve conflict markers', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('greps the whole tree for merge markers before commit and reports the empty result', () => {
    const p = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain("Before committing a merge, run `git grep -n -E '^(<<<<<<<|=======|>>>>>>>)'`, fix every hit, and quote the empty result.");
  });
});

describe('overseer-7yrh Windows merge encoding rule', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('writes files as UTF-8 and checks a merge resolution for mis-decoded sequences', () => {
    const p = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('never PowerShell `Set-Content`/`Out-File`/`>` without an explicit UTF-8 (no BOM) encoding');
    expect(p).toContain('After a merge conflict, grep touched files for mis-decoded sequences with `\\x{00D4}\\x{00C7}|\\x{00D4}\\x{00E5}|\\x{252C}\\x{00C0}` and require zero hits.');
    expect(p).toContain('and require zero hits');
  });
});

describe('overseer-b149-m7fd undrivable measurement and jsdom layout rules', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const bead = { id: 'ov-1', title: 'Add login', description: 'Use the auth lib', status: 'open' as const, priority: 1, labels: [], notes: '', assignee: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, dependency_count: 0 };

  it('records a case the tool cannot drive as a finding, not a reopen', () => {
    expect(orchestratorPrompt).toContain('says a case the tool cannot drive is reported as `Check: <case> - PASS - not drivable: <tool error>`.');
  });

  it('requires a real-browser layout test for scroll-position and geometry logic', () => {
    const p = buildWorkerPrompt(workerTemplate, { bead, branch: 'bead/ov-1', base: 'main', conflicts: [] });
    expect(p).toContain('Scroll-position or geometry logic (at-bottom checks, `scrollTop`, element sizes)');
    expect(p).toContain('is not covered by jsdom unit tests alone, since jsdom reports 0 for every layout value');
    expect(p).toContain("adds or extends a real-browser layout test (this repo's `test:*-layout` scripts) and asserts the measured values");
  });
});

describe('orchestrator.md programs for related stories (lesson 2026-09-28 overseer-lmtk)', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const toolsSource = fs.readFileSync(fileURLToPath(new URL('../mcp/tools.ts', import.meta.url)), 'utf8');

  it('opens a program for three or more related stories or a cross-batch dependency, with lanes, owners and merge order', () => {
    expect(orchestratorPrompt).toContain('- Three or more related stories, or any cross-batch dependency, get a program (`create_program`): use `add_to_program` to add each batch with its lane, log each shared-work owner as `ownership`, and call `set_merge_order`.');
  });

  it('logs every user decision about the program verbatim', () => {
    expect(orchestratorPrompt).toContain('- Log each user decision on the program verbatim as a `decision`.');
  });

  it('creates a dependent batch at once with a wait instead of holding it in memory, and dispatches on the release notice', () => {
    expect(orchestratorPrompt).toContain('- Create dependent batches immediately with `after_batch_id`, instead of holding them in memory; dispatch their beads when the release notice arrives.');
  });

  it('follows the merge order and names the program in the review note', () => {
    expect(orchestratorPrompt).toContain("Merge waiting batches one at a time, in a stated order. Follow a program's merge order.");
    expect(orchestratorPrompt).toContain("- names the batch's program, if any;");
  });

  it('names only program tools, parameters and entry kinds the MCP server registers', () => {
    for (const tool of ['create_program', 'add_to_program', 'set_merge_order']) {
      expect(orchestratorPrompt).toContain(`\`${tool}\``);
      expect(toolsSource).toContain(`server.tool('${tool}'`);
    }
    expect(toolsSource).toContain('after_batch_id: z.string().optional()');
    expect(toolsSource).toContain("kind: z.enum(['decision', 'ownership', 'note'])");
  });
});

describe('2026-09-28 prompt description and shortening rules', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');

  it('requires cache descriptions to identify file changes the key must detect', () => {
    expect(orchestratorPrompt).toContain('A description that prescribes a cache or freshness key names each change the key must detect (a file added, removed, or rewritten in place), with a test for each.');
  });

  it('preserves the scope of each rule when shortening a prompt', () => {
    expect(workerTemplate).toContain("A worker that shortens a prompt keeps each rule's subject, object and scope, never adds a second version of a rule beside the original, and quotes every changed sentence before and after in its final message.");
  });
});

describe('2026-09-29 issue authorship prompt rules', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');

  it("keeps another author's issue description and closes the new story", () => {
    expect(orchestratorPrompt).toContain("A bead that writes a story for an existing issue checks the issue's author.");
    expect(orchestratorPrompt).toContain("If the user did not author it, create a new story linked with `relates_to` (or comment on the original), never replace its description, and have the MR close the new story.");
  });

  it('stops when asked to rewrite a description written by someone else', () => {
    expect(workerTemplate).toContain('Never replace or rewrite an issue or MR description written by someone else; add a comment or a linked issue instead, and stop and report if the task says otherwise.');
  });
});

describe('2026-09-29 independent server port rules', () => {
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('requires each worker server and browser run to use its own checked port', () => {
    expect(workerTemplate).toContain('A dev, preview or static server you start uses a free port or the port the task names, never a fixed shared default; run tests and captures only against a server this worktree started.');
    expect(workerTemplate).toContain("If the repo's test config pins a port or reuses a running server, override it with its port variable or a config copy outside the repo, then report the port and confirm nothing listened on it before the run.");
  });

  it('requires a per-run port bead before parallel browser work', () => {
    expect(orchestratorPrompt).toContain("When a repo's test config pins one port or reuses a running server, create a bead in that repo to give each run its own port before browser work runs there in parallel.");
    expect(orchestratorPrompt).toContain("Until that change lands, name the port override in each browser bead's description.");
  });
});

describe('repository privacy rule and lesson signal handling', () => {
  const privacyRule = "Nothing committed to this repository may name the user, their employer, or a managed repository's host, or contain product or customer text, account names, email addresses, home paths, or likeness references. Replace those details with fictional stand-ins.";
  const rootRules = fs.readFileSync(fileURLToPath(new URL('../../../../CLAUDE.md', import.meta.url)), 'utf8');
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');
  const workerTemplate = fs.readFileSync(fileURLToPath(new URL('../../prompts/worker.md', import.meta.url)), 'utf8');

  it('sets the same privacy rule in repository and worker guidance', () => {
    expect(rootRules).toContain(privacyRule);
    expect(orchestratorPrompt).toContain(privacyRule);
    expect(workerTemplate).toContain(privacyRule);
  });

  it('replaces personal and employer details in retrospective signals with stand-ins', () => {
    expect(orchestratorPrompt).toContain('the signal quoted with personal or employer details replaced by fictional stand-ins, preserving the rest of the wording');
    expect(orchestratorPrompt).toContain('quotes each signal with personal or employer details replaced by fictional stand-ins, preserving the rest of the wording');
    expect(orchestratorPrompt).not.toContain('the signal verbatim');
    expect(orchestratorPrompt).not.toContain('quotes the signals verbatim');
  });

  it('uses portrait and likeness for generic user-supplied references', () => {
    expect(orchestratorPrompt).toContain('A reference the user supplies in chat (a portrait, a screenshot, a design export)');
    expect(orchestratorPrompt).toContain('A gate that says "keep" a likeness or palette');
  });
});

describe('acme-portal-sample-032 prompt lessons', () => {
  const orchestratorPrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/orchestrator.md', import.meta.url)), 'utf8');

  it('covers every state of a view across a breakpoint change, in both directions', () => {
    expect(orchestratorPrompt).toContain('A criterion that a view survives a breakpoint change names every state the view can be in when the width crosses — the entry chooser or sheet, each page kind, open prompts, busy, error and success — in both directions, each with a test.');
    expect(orchestratorPrompt).toContain('A step page alone does not cover a view whose entry chooser opens before any step.');
  });

  it('counts a Figma evidence matrix and splits it before dispatch', () => {
    expect(orchestratorPrompt).toContain('Before dispatching Figma evidence, count the captures (frames or states times the live columns); above about 50, ask the user the scope with the count and the cost of the last comparable pass, then split into tasks of bounded size (for example one per flow).');
    expect(orchestratorPrompt).toContain("Each description names the fixture data that reproduces each frame's state, and captures run in a verification-only task after the last code commit, so the parity SHA is the head.");
  });
});
