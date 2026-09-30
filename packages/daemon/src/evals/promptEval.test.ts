import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotLiveDb } from '../discussions/eval';
import { sessionPreamble } from '../orchestrator/orchestrator';
import { DENY_EVAL_SIDE_EFFECTS_HOOK, evalSandboxSettings } from '../harness/claude';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openDb } from '../db/db';
import { batchStatusLabel } from '../lifecycle/lifecycle';
import { registerTools, type McpDeps } from '../mcp/tools';
import { overseerToolDefs } from './mockMcp';
import { evalGitEnv } from './gitEnv';
import { argsMatch, assertNotLivePort, checkExact, claudeProjectDir, loadCases, messagesOf, parseCase, parseJudge, passRate, promptScore, renderTranscript, replyFor, runPassed, turnProblem, type RunRecord } from './promptEval';

const CASES_DIR = fileURLToPath(new URL('../../evals/orchestrator/cases', import.meta.url));

/**
 * The fields the registered `list_repos` and `list_batches` handlers answer, read by calling those handlers from
 * `registerTools` on a real in-memory database holding one repo and one batch, so a fixture reply is checked against what
 * the daemon returns rather than against a hand-kept list.
 */
async function handlerShapes(): Promise<{ repo: string[]; batchRow: string[]; batchOne: string[] }> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>>();
  const capture = { tool: (name: string, _description: string, _schema: unknown, handler: never) => { handlers.set(name, handler); } };
  const db = openDb(':memory:');
  db.repos.insert({ id: 'web', path: path.join(os.tmpdir(), 'prompt-eval-shape-web'), base_branch: 'main', verify_command: 'pnpm test', setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2 });
  db.batches.insert({ id: 'web-b1', repo_id: 'web', title: 'Shape', branch: 'feature/shape', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: '2026-09-26T00:00:00.000Z', updated_at: '2026-09-26T00:00:00.000Z', merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
  registerTools(capture as unknown as McpServer, { db, store: { list: async () => [] } } as unknown as McpDeps);
  const read = async (tool: string, args: Record<string, unknown>) => {
    const result = await handlers.get(tool)!(args);
    if (result.isError) throw new Error(`${tool}: ${result.content[0]!.text}`);
    return JSON.parse(result.content[0]!.text) as unknown;
  };
  const repos = await read('list_repos', {}) as Record<string, unknown>[];
  const rows = await read('list_batches', { repo: 'web' }) as Record<string, unknown>[];
  const one = await read('list_batches', { repo: 'web', batch_id: 'web-b1' }) as Record<string, unknown>;
  db.sql.close();
  return { repo: Object.keys(repos[0]!).sort(), batchRow: Object.keys(rows[0]!).sort(), batchOne: Object.keys(one).sort() };
}

function lessonSection(lessons: string, entry: string): string | undefined {
  return lessons.split(/(?=^## )/m).find((section) => section.startsWith(`## ${entry}\n`));
}

function lessonQuoteMatches(lessons: string, entry: string, quote: string): boolean {
  return lessonSection(lessons, entry)?.includes(quote) ?? false;
}

const valid = () => ({
  id: 'sample-case',
  source: { entry: '2026-09-18 — sample', quote: 'A notice that needs no action gets no message at all.' },
  input: '[repo: web] Add a button',
  state: { repos: [{ id: 'web', base_branch: 'main', merge_mode: 'local-merge', verify_command: 'pnpm test' }], batches: [] },
  fixtures: { default: { reply: { ok: true } }, calls: [{ tool: 'list_tasks', args: { repo: 'web' }, reply: [] }] },
  assertions: [{ kind: 'not_called', tool: 'merge_batch' }, { kind: 'rubric', line: 'It says what it did.' }],
});

describe('case loading', () => {
  it('loads a complete case', () => {
    const c = parseCase(valid(), 'sample.json');
    expect(c.id).toBe('sample-case');
    expect(c.state.repos[0]).toMatchObject({ id: 'web', verify_command: 'pnpm test' });
    expect(c.assertions).toHaveLength(2);
  });

  it.each([
    ['input', (c: ReturnType<typeof valid>) => { delete (c as Partial<typeof c>).input; }, 'missing field input'],
    ['source.quote', (c: ReturnType<typeof valid>) => { delete (c.source as Partial<typeof c.source>).quote; }, 'missing field source.quote'],
    ['fixtures.default', (c: ReturnType<typeof valid>) => { delete (c.fixtures as Partial<typeof c.fixtures>).default; }, 'missing field fixtures.default'],
    ['assertions[1].line', (c: ReturnType<typeof valid>) => { delete (c.assertions[1] as { line?: string }).line; }, 'missing field assertions[1].line'],
    ['state.repos[0].base_branch', (c: ReturnType<typeof valid>) => { delete (c.state.repos[0] as { base_branch?: string }).base_branch; }, 'missing field state.repos[0].base_branch'],
  ])('refuses a case missing %s, naming the field', (_name, drop, message) => {
    const c = valid();
    drop(c);
    expect(() => parseCase(c, 'sample.json')).toThrow(`sample.json: ${message}`);
  });

  it('refuses a blank input, an empty assertion list and an unknown assertion kind', () => {
    expect(() => parseCase({ ...valid(), input: '  ' }, 'x.json')).toThrow('field input is blank');
    expect(() => parseCase({ ...valid(), assertions: [] }, 'x.json')).toThrow('field assertions is empty');
    expect(() => parseCase({ ...valid(), assertions: [{ kind: 'maybe' }] }, 'x.json')).toThrow(/assertions\[0\]\.kind must be one of/);
  });

  it('loads the two splits: 20 train and 10 holdout cases, each quoting its own lessons entry, with silence and ask_user in both', async () => {
    const train = loadCases(path.join(CASES_DIR, 'train'));
    const holdout = loadCases(path.join(CASES_DIR, 'holdout'));
    const lessons = fs.readFileSync(new URL('../../../../docs/lessons.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(train).toHaveLength(20);
    expect(holdout).toHaveLength(10);
    const all = [...train, ...holdout];
    for (const c of all) {
      expect(lessonSection(lessons, c.source.entry), c.id).toBeDefined();
      expect(lessonQuoteMatches(lessons, c.source.entry, c.source.quote), c.id).toBe(true);
    }
    // No lessons entry, and no case id, is used twice across the two splits.
    expect(new Set(all.map((c) => c.source.entry)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    const silent = (cs: typeof all) => cs.filter((c) => c.assertions.some((a) => a.kind === 'no_message'));
    const asks = (cs: typeof all) => cs.filter((c) => c.assertions.some((a) => a.kind === 'called' && a.tool === 'ask_user'));
    // Four silence cases: critic-crash-retry-verification lost its no_message check, since its lesson says nothing about silence
    // and the retry_verification contract lets the model tell the user; no case was invented to refill the count.
    expect(silent(train).length).toBeGreaterThanOrEqual(2);
    expect(asks(train).length).toBeGreaterThanOrEqual(3);
    expect(silent(holdout).length).toBeGreaterThanOrEqual(2);
    expect(asks(holdout).length).toBeGreaterThanOrEqual(2);
    expect(silent(all).length).toBeGreaterThanOrEqual(4);
    expect(asks(all).length).toBeGreaterThanOrEqual(5);
    // A silent case still asserts a tool call it expects or forbids, so a run that does nothing cannot pass it on silence alone.
    for (const c of silent(all)) expect(c.assertions.some((a) => a.kind === 'called' || a.kind === 'not_called'), c.id).toBe(true);
    // Every tool a case answers or checks is one `registerTools` serves, so a misspelt name cannot leave a fixture unmatched.
    const tools = new Set(overseerToolDefs().map((d) => d.name));
    for (const c of all) {
      const named = [...c.fixtures.calls.map((f) => f.tool), ...c.assertions.flatMap((a) => a.kind === 'order' ? [a.before, a.after] : 'tool' in a ? [a.tool] : [])];
      for (const t of named) expect(tools.has(t), `${c.id}: ${t}`).toBe(true);
      for (const fixture of c.fixtures.calls.filter((f) => f.tool === 'list_tasks')) {
        if (!('reply' in fixture) || !Array.isArray(fixture.reply)) throw new Error(`${c.id}: list_tasks fixture must reply with an array`);
        for (const bead of fixture.reply) {
          for (const field of ['id', 'title', 'description', 'status', 'priority', 'labels', 'notes', 'assignee', 'closed_at', 'dependency_count', 'column']) {
            expect(bead as Record<string, unknown>, `${c.id}: list_tasks ${field}`).toHaveProperty(field);
          }
          expect(['ready', 'blocked', 'running', 'verifying', 'review', 'done'], `${c.id}: list_tasks column`).toContain((bead as Record<string, unknown>).column);
        }
      }
      const expectsAsk = c.assertions.some((a) => a.kind === 'called' && a.tool === 'ask_user');
      const askFixtures = c.fixtures.calls.filter((f) => f.tool === 'ask_user');
      if (expectsAsk) expect(askFixtures.length, `${c.id}: ask_user fixture`).toBeGreaterThan(0);
      for (const fixture of askFixtures) {
        if (!('reply' in fixture)) throw new Error(`${c.id}: ask_user fixture must reply with a value`);
        expect(fixture.reply, `${c.id}: ask_user reply`).toMatchObject({ question_id: expect.any(Number) });
      }
    }
    // list_repos and list_batches replies carry exactly the fields the registered handlers return: an array of repos, an
    // array of batch rows for a repo, and one batch with its history and note when batch_id is given.
    const shapes = await handlerShapes();
    for (const c of all) {
      for (const fixture of c.fixtures.calls.filter((f) => f.tool === 'list_repos')) {
        if (!('reply' in fixture) || !Array.isArray(fixture.reply)) throw new Error(`${c.id}: list_repos fixture must reply with an array`);
        for (const repo of fixture.reply as Record<string, unknown>[]) expect(Object.keys(repo).sort(), `${c.id}: list_repos fields`).toEqual(shapes.repo);
      }
      for (const fixture of c.fixtures.calls.filter((f) => f.tool === 'list_batches')) {
        if (!('reply' in fixture)) throw new Error(`${c.id}: list_batches fixture must reply with a value`);
        const one = fixture.args?.batch_id !== undefined;
        if (one === Array.isArray(fixture.reply)) throw new Error(`${c.id}: list_batches ${one ? 'with batch_id must reply with one batch' : 'must reply with an array'}`);
        for (const batch of (one ? [fixture.reply] : fixture.reply) as Record<string, unknown>[]) {
          expect(Object.keys(batch).sort(), `${c.id}: list_batches fields`).toEqual(one ? shapes.batchOne : shapes.batchRow);
          expect(batch.repo_id, `${c.id}: list_batches repo_id`).toBe(fixture.args?.repo);
          expect(batch.status_label, `${c.id}: list_batches status_label`).toBe(batchStatusLabel(batch.status as never, batch.waiting_on as string | null));
        }
      }
    }
    // Each case's preamble renders from its state with the daemon's own wording.
    for (const c of all) expect(sessionPreamble(c.state.repos, c.state.batches, 'UTC+02:00')).toContain(`Repositories: ${c.state.repos[0]!.id} (base `);
  });

  it('keeps every case in a split: the cases directory itself holds none, which is why the runner defaults to train', () => {
    expect(() => loadCases(CASES_DIR)).toThrow('holds no *.json case');
  });

  it('refuses an empty split directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-eval-empty-split-'));
    try {
      expect(() => loadCases(dir)).toThrow(`${dir} holds no *.json case`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a lessons quote copied from a different entry', () => {
    const train = loadCases(path.join(CASES_DIR, 'train'));
    const holdout = loadCases(path.join(CASES_DIR, 'holdout'));
    const lessons = fs.readFileSync(new URL('../../../../docs/lessons.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const first = train[0]!;
    const other = [...train, ...holdout].find((c) => c.source.entry !== first.source.entry && !lessonQuoteMatches(lessons, first.source.entry, c.source.quote));
    if (!other) throw new Error('no second lesson entry has a distinct quote');
    expect(lessonQuoteMatches(lessons, first.source.entry, first.source.quote)).toBe(true);
    expect(lessonQuoteMatches(lessons, first.source.entry, other.source.quote)).toBe(false);
  });
});

describe('fixture replies', () => {
  const fixtures = {
    default: { reply: 'default' },
    calls: [
      { tool: 'bd', args: { repo: 'web', args: ['show', 'web-1'] }, reply: 'bead web-1' },
      { tool: 'bd', args: { repo: 'web' }, error: 'unlisted bd call' },
    ],
  };
  it('matches listed arguments, an array as a prefix, and falls back to the default', () => {
    expect(replyFor(fixtures, 'bd', { repo: 'web', args: ['show', 'web-1', '--long'] })).toEqual({ reply: { reply: 'bead web-1' }, fixture: 0 });
    expect(replyFor(fixtures, 'bd', { repo: 'web', args: ['list'] })).toEqual({ reply: { error: 'unlisted bd call' }, fixture: 1 });
    expect(replyFor(fixtures, 'list_tasks', { repo: 'web' })).toEqual({ reply: { reply: 'default' }, fixture: 'default' });
    expect(argsMatch({ args: ['show', 'web-1'] }, { args: ['show'] })).toBe(false);
  });

  it('echoes each submitted title in the compact bd create reply', () => {
    const createFixtures = {
      default: { reply: { ok: true } },
      calls: [{ tool: 'bd', args: { args: ['create'] }, reply: [{ id: 'web-1', status: 'open', title: 'fixed fixture title', labels: ['overseer:batch:web-b1'] }] }],
    };
    const submissions = [
      { args: ['create', '--title', 'WelcomeCard: match frame 1425:19961'], title: 'WelcomeCard: match frame 1425:19961' },
      { args: ['create', '--title=Persisted value follows OS theme'], title: 'Persisted value follows OS theme' },
      { args: ['create', 'A different positional title'], title: 'A different positional title' },
      { args: ['create', '--description', 'Match the frame.', 'Title after the description'], title: 'Title after the description' },
      { args: ['create', '-d', 'desc', '--silent', 'Title after a boolean flag', '-p', '1'], title: 'Title after a boolean flag' },
      { args: ['create', '--description=inline', '--labels', 'a,b', 'Title after an inline flag'], title: 'Title after an inline flag' },
    ];
    for (const { args, title } of submissions) {
      expect(replyFor(createFixtures, 'bd', { repo: 'web', args })).toEqual({
        reply: { reply: [{ id: 'web-1', status: 'open', title, labels: ['overseer:batch:web-b1'] }] },
        fixture: 0,
      });
    }
    // A create that names no title (only flags and their values) keeps the fixture's own title.
    expect(replyFor(createFixtures, 'bd', { repo: 'web', args: ['create', '-d', 'only a description'] }).reply).toEqual({
      reply: [{ id: 'web-1', status: 'open', title: 'fixed fixture title', labels: ['overseer:batch:web-b1'] }],
    });
  });

  it('shows the echoed create title in every later read of that bead, and leaves other beads alone', () => {
    const fixtures = {
      default: { reply: { ok: true } },
      calls: [
        { tool: 'bd', args: { args: ['create'] }, reply: [{ id: 'web-1', status: 'open', title: 'fixed fixture title' }] },
        { tool: 'bd', args: { args: ['show', 'web-1'] }, reply: [{ id: 'web-1', title: 'fixed fixture title', description: 'd' }] },
        { tool: 'list_tasks', reply: [{ id: 'web-1', title: 'fixed fixture title' }, { id: 'web-2', title: 'other bead' }] },
      ],
    };
    const created = { tool: 'bd', args: { repo: 'web', args: ['create', '--description', 'd', 'Submitted title'] } };
    expect(replyFor(fixtures, 'bd', { repo: 'web', args: ['show', 'web-1'] }).reply).toEqual({ reply: [{ id: 'web-1', title: 'fixed fixture title', description: 'd' }] });
    const history = [{ ...created, fixture: 0 as const }];
    expect(replyFor(fixtures, 'bd', { repo: 'web', args: ['show', 'web-1'] }, history).reply).toEqual({ reply: [{ id: 'web-1', title: 'Submitted title', description: 'd' }] });
    expect(replyFor(fixtures, 'list_tasks', { repo: 'web' }, history).reply).toEqual({ reply: [{ id: 'web-1', title: 'Submitted title' }, { id: 'web-2', title: 'other bead' }] });
    // A rejected create (no fixture) made nothing, so the read keeps the fixture title.
    expect(replyFor(fixtures, 'bd', { repo: 'web', args: ['show', 'web-1'] }, [{ ...created, fixture: null }]).reply).toEqual({ reply: [{ id: 'web-1', title: 'fixed fixture title', description: 'd' }] });
  });
});

describe('exact checks', () => {
  const run: RunRecord = {
    calls: [
      { seq: 1, tool: 'create_batch', args: { repo: 'web', title: 'Copy link' }, fixture: 0 },
      { seq: 2, tool: 'bd', args: { repo: 'web', args: ['create', 'Copy link button'] }, fixture: 1 },
      { seq: 3, tool: 'spawn_worker', args: { repo: 'web', bead_id: 'web-1', needs_server: true }, fixture: 2 },
    ],
    messages: [],
  };
  const talked: RunRecord = { calls: [], messages: ['Nothing needed from you.'] };

  it('called: passes on a call with matching arguments, fails when absent or when the arguments differ', () => {
    expect(checkExact({ kind: 'called', tool: 'spawn_worker', args: { needs_server: true } }, run).pass).toBe(true);
    expect(checkExact({ kind: 'called', tool: 'ask_user' }, run)).toEqual({ pass: false, detail: 'ask_user not called' });
    expect(checkExact({ kind: 'called', tool: 'spawn_worker', args: { needs_server: false } }, run).pass).toBe(false);
  });

  it('not called: passes when the tool is absent, fails naming the call when present', () => {
    expect(checkExact({ kind: 'not_called', tool: 'merge_batch' }, run).pass).toBe(true);
    expect(checkExact({ kind: 'not_called', tool: 'spawn_worker' }, run)).toEqual({ pass: false, detail: 'spawn_worker called (#3)' });
  });

  it('order: passes when the first call comes first, fails when reversed or when one is missing', () => {
    expect(checkExact({ kind: 'order', before: 'create_batch', after: 'spawn_worker' }, run).pass).toBe(true);
    expect(checkExact({ kind: 'order', before: 'spawn_worker', after: 'create_batch' }, run)).toEqual({ pass: false, detail: 'create_batch #1 came before spawn_worker #3' });
    expect(checkExact({ kind: 'order', before: 'ask_user', after: 'spawn_worker' }, run)).toEqual({ pass: false, detail: 'ask_user not called' });
  });

  it('argument contains: matches a phrase case-insensitively in a string or an array argument, fails otherwise', () => {
    expect(checkExact({ kind: 'arg_contains', tool: 'create_batch', arg: 'title', phrase: 'COPY link' }, run).pass).toBe(true);
    expect(checkExact({ kind: 'arg_contains', tool: 'bd', arg: 'args', phrase: 'button' }, run).pass).toBe(true);
    expect(checkExact({ kind: 'arg_contains', tool: 'create_batch', arg: 'title', phrase: 'share' }, run)).toEqual({ pass: false, detail: 'no create_batch call has "share" in title' });
    expect(checkExact({ kind: 'arg_contains', tool: 'ask_user', arg: 'question', phrase: 'x' }, run).pass).toBe(false);
  });

  it('no message: passes on a silent run, fails quoting the first message', () => {
    expect(checkExact({ kind: 'no_message' }, run).pass).toBe(true);
    expect(checkExact({ kind: 'no_message' }, talked)).toEqual({ pass: false, detail: '1 message(s), the first: "Nothing needed from you."' });
  });

  it('a call the tool rejected fails not_called, but does not count as called, first in order, or for its arguments', () => {
    const rejected: RunRecord = {
      calls: [
        { seq: 1, tool: 'spawn_worker', args: { bead_id: 'web-1', instructions: 'merge it' }, fixture: null, rejected: 'repo: Required' },
        { seq: 2, tool: 'ask_user', args: { question: 'Merge?' }, fixture: 'default' },
      ],
      messages: [],
    };
    expect(checkExact({ kind: 'not_called', tool: 'spawn_worker' }, rejected)).toEqual({ pass: false, detail: 'spawn_worker called (#1 (rejected: repo: Required))' });
    expect(checkExact({ kind: 'called', tool: 'spawn_worker' }, rejected).pass).toBe(false);
    expect(checkExact({ kind: 'order', before: 'spawn_worker', after: 'ask_user' }, rejected).pass).toBe(false);
    expect(checkExact({ kind: 'arg_contains', tool: 'spawn_worker', arg: 'instructions', phrase: 'merge' }, rejected).pass).toBe(false);
  });
});

describe('turn completion', () => {
  const turnEnd = { type: 'turn_end', payload: { nativeSessionId: 'n', cost: 0.4 } };
  const clean = { events: [{ type: 'assistant_text', payload: { text: 'x' } }, turnEnd], status: 'ended', endReason: null, timedOut: false };
  const allPass = [{ pass: true }, { pass: true }];

  it('counts a clean, completed turn and nothing else', () => {
    expect(turnProblem(clean)).toBeNull();
    expect(turnProblem({ ...clean, events: [] })).toBe('the session ended without finishing its turn');
    expect(turnProblem({ ...clean, events: [{ type: 'error', payload: { message: 'error_max_budget_usd' } }, turnEnd] })).toBe('the session reported error_max_budget_usd');
    expect(turnProblem({ ...clean, timedOut: true })).toBe('timed out before the turn ended');
    expect(turnProblem({ ...clean, status: 'failed', endReason: 'claude exited with code 1' })).toBe('the session failed: claude exited with code 1');
  });

  it('fails a run whose turn did not complete even when every assertion passed', () => {
    expect(runPassed(null, allPass)).toBe(true);
    expect(runPassed(turnProblem({ ...clean, events: [] }), allPass)).toBe(false);
    expect(runPassed(null, [{ pass: true }, { pass: false }])).toBe(false);
  });
});

describe('scoring', () => {
  it('turns K runs into a pass rate', () => {
    expect(passRate([true, false, true])).toBeCloseTo(2 / 3);
    expect(passRate([false, false, false])).toBe(0);
    expect(passRate([])).toBeNull();
  });
  it('averages the case pass rates into the prompt score, and has no score for zero cases', () => {
    expect(promptScore([1, 2 / 3, 0, 1 / 3, 1])).toBeCloseTo(0.6);
    expect(promptScore([0])).toBe(0);
    expect(promptScore([])).toBeNull();
  });
});

describe('judge grading', () => {
  const events = [
    { type: 'tool_call', payload: { name: 'mcp__overseer__ask_user', input: { question: 'The 68px rail cannot render; which width should it use?' } } },
    { type: 'tool_result', payload: { output: [{ type: 'text', text: '{\n  "question_id": 7\n}' }] } },
    { type: 'assistant_text', payload: { text: '  ' } },
  ];
  const transcript = renderTranscript('[Overseer] web-1 awaits a decision', events);
  it('keeps a pass whose quote is in the transcript, fails one whose quote is not, and fails a line left out', () => {
    const reply = '[{"line":1,"pass":true,"quote":"The 68px rail cannot render","reason":"asked"},{"line":2,"pass":true,"quote":"I will re-dispatch","reason":"made up"}]';
    const grades = parseJudge(reply, 3, transcript);
    expect(grades.map((g) => [g.pass, g.valid])).toEqual([[true, true], [false, false], [false, false]]);
    expect(grades[1]!.reason).toMatch(/^the judge passed it on a quote that is not in the transcript/);
    expect(grades[2]!.reason).toBe('the judge gave no grade for this line');
  });
  it('checks a fail\'s evidence too: a quote must be in the transcript, and only a fail marked missing may have none', () => {
    const reply = JSON.stringify([
      { line: 1, pass: false, missing: false, quote: 'which width should it use', reason: 'asks about width, not the prescription' },
      { line: 2, pass: false, missing: false, quote: 'I dispatched it again', reason: 'made up' },
      { line: 3, pass: false, missing: false, quote: '', reason: 'no evidence' },
      { line: 4, pass: false, missing: true, quote: '', reason: 'never names the cost' },
    ]);
    const grades = parseJudge(reply, 4, transcript);
    expect(grades.map((g) => [g.pass, g.valid])).toEqual([[false, true], [false, false], [false, false], [false, true]]);
    expect(grades[1]!.reason).toMatch(/^the judge failed it on a quote that is not in the transcript/);
    expect(grades[2]!.reason).toMatch(/^the judge failed it without a quote and without marking it as resting on something missing/);
  });
  it('reads a bare grade object as the one line of a one-line rubric, as a judge replied on 2026-09-25', () => {
    const reply = '{"line":1,"pass":true,"missing":false,"quote":"The 68px rail cannot render; which width should it use?","reason":"asks for a decision [must] cited"}';
    expect(parseJudge(reply, 1, transcript)).toEqual([{ line: 1, pass: true, valid: true, quote: 'The 68px rail cannot render; which width should it use?', reason: 'asks for a decision [must] cited' }]);
  });
  it('normalizes a literal control character inside judge JSON strings before parsing', () => {
    const control = String.fromCharCode(1);
    const reply = `[{"line":1,"pass":true,"missing":false,"quote":"The 68px rail${control}cannot render","reason":"asks${control}for a decision"}]`;
    expect(parseJudge(reply, 1, transcript)).toEqual([{ line: 1, pass: true, valid: true, quote: 'The 68px rail cannot render', reason: 'asks for a decision' }]);
  });
  it('accepts a quote shortened with an ellipsis only when every piece is in the transcript', () => {
    const grade = (quote: string) => parseJudge(JSON.stringify([{ line: 1, pass: true, missing: false, quote, reason: 'r' }]), 1, transcript)[0]!;
    expect(grade('The 68px rail ... which width should it use?')).toMatchObject({ pass: true, valid: true });
    expect(grade('The 68px rail … which width should it use?')).toMatchObject({ pass: true, valid: true });
    expect(grade('The 68px rail ... so I dispatched it again')).toMatchObject({ pass: false, valid: false });
  });
  it('matches a quote that drops the transcript\'s inline-code backticks, as a judge quoted on 2026-09-26', () => {
    const coded = renderTranscript('[Overseer] web-1', [{ type: 'assistant_text', payload: { text: '`document-upload.spec.ts:88` and `avatar-upload.spec.ts:41` fail because of CORS' } }]);
    const grade = (quote: string) => parseJudge(JSON.stringify([{ line: 1, pass: true, missing: false, quote, reason: 'r' }]), 1, coded)[0]!;
    expect(grade('document-upload.spec.ts:88 and avatar-upload.spec.ts:41 fail because of CORS')).toMatchObject({ pass: true, valid: true });
    expect(grade('`document-upload.spec.ts:88` and `avatar-upload.spec.ts:41` fail')).toMatchObject({ pass: true, valid: true });
    expect(grade('document-upload.spec.ts:88 and settings.spec.ts:12 fail')).toMatchObject({ pass: false, valid: false });
  });
  it('renders tool calls without the MCP prefix, an MCP result as its text, and counts no blank text as a message', () => {
    expect(transcript).toContain('[tool call ask_user] {"question":"The 68px rail');
    expect(transcript).toContain('[tool result] {\n  "question_id": 7\n}');
    expect(messagesOf(events)).toEqual([]);
  });
});

describe('Claude project folder', () => {
  it('names the folder the CLI created for a run cwd, as observed on 2026-09-25', () => {
    const home = path.join('C:\\Workspace\\dev', '.claude');
    expect(claudeProjectDir('C:\\Workspace\\dev\\AppData\\Local\\Temp\\prompt-eval-autonomy-finding-to-user-1-ddSkup\\cwd', home))
      .toBe(path.join(home, 'projects', 'C--Workspace-dev-AppData-Local-Temp-prompt-eval-autonomy-finding-to-user-1-ddSkup-cwd'));
  });
});

describe('live-install guards', () => {
  it('refuses the live daemon port and serves any other', () => {
    expect(() => assertNotLivePort(4400, [4400])).toThrow(/the live daemon's/);
    expect(() => assertNotLivePort(51234, [4400])).not.toThrow();
  });
  it('refuses the live database as a run database and accepts a temp one', () => {
    const live = path.join(os.homedir(), '.overseer');
    expect(() => assertNotLiveDb(path.join(live, 'overseer.db'), live)).toThrow(/live database/);
    expect(() => assertNotLiveDb(path.join(os.tmpdir(), 'prompt-eval-x', 'data', 'overseer.db'), live)).not.toThrow();
  });
});

describe('prompt-eval side-effect guard', () => {
  const cwd = path.join(os.tmpdir(), 'prompt-eval-guard-cwd');
  // The hook runs inside the session the runner starts, so it gets the runner's Git environment (system and global config off).
  const env = { ...process.env, ...evalGitEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-eval-guard-env-'))) };
  const run = (tool_name: string, tool_input: Record<string, unknown>) => spawnSync(process.execPath, [DENY_EVAL_SIDE_EFFECTS_HOOK], {
    input: JSON.stringify({ tool_name, tool_input, cwd }), encoding: 'utf8', env,
  });

  it('refuses network and local-port commands before an eval Bash call can run', () => {
    const settings = evalSandboxSettings() as { hooks: { PreToolUse: { matcher: string }[] } };
    expect(settings.hooks.PreToolUse.map((hook) => hook.matcher)).toContain('Bash');
    for (const command of ['glab api projects', 'curl http://127.0.0.1:4400/health', 'git fetch origin dev', 'git push origin dev', 'nc -z 127.0.0.1 4400']) {
      const result = run('Bash', { command });
      expect(result.status, command).toBe(2);
      expect(result.stderr).toMatch(/blocked in prompt-eval sessions/);
    }
    for (const command of ['cat notes & rm -rf ../outside', 'cat < ../outside.txt', 'cat < /dev/tcp/127.0.0.1/4400', 'cat \\\\server\\share\\secret.txt']) {
      expect(run('Bash', { command }).status, command).toBe(2);
    }
    expect(run('Bash', { command: 'git status --short' }).status).toBe(0);
    expect(run('Read', { file_path: '\\\\server\\share\\secret.txt' }).status).toBe(2);
    expect(run('Grep', { path: '//server/share' }).status).toBe(2);
  });

  it('blocks shell writes and file writes outside the eval cwd', () => {
    expect(run('Bash', { command: 'printf x > ../outside.txt' }).status).toBe(2);
    expect(run('Bash', { command: 'rm -rf ../outside' }).status).toBe(2);
    expect(run('Write', { file_path: path.join(cwd, '..', 'outside.txt') }).status).toBe(2);
    expect(run('Edit', { file_path: path.join(cwd, '..', 'outside.txt') }).status).toBe(2);
    expect(run('Write', { file_path: path.join(cwd, 'inside.txt') }).status).toBe(0);
    expect(run('WebSearch', { query: 'gitlab' }).status).toBe(2);
    expect(run('WebFetch', { url: 'https://gitlab.com' }).status).toBe(2);
  });

  it.each([
    ['the e command alone', "sed -n 'e' notes"],
    ['the e command with an argument', "sed -n 'e date' notes"],
    ['an addressed e command in a -e script', "sed -e '1e date' notes"],
    ['an e command in a clustered -ne script', "sed -ne '/x/e date' notes"],
    ['an e command in an --expression script', "sed --expression='$!e date' notes"],
    ['an e command after a semicolon', "sed -n 'p;e date' notes"],
    ['an e command inside a block', "sed -n '1{p;e date\n}' notes"],
    ['an e command in a second -e fragment', "sed -n -e p -e 'e date' notes"],
    ['an e command after a label', "sed -n ':a;e date' notes"],
    ['an e command after an a text line', "sed 'a text\ne date' notes"],
    ['a quoted e command joined to unquoted text', "sed -n 1'e date' notes"],
    ['a script file', 'sed -f script.sed notes'],
    ['a clustered script file', 'sed -nf script.sed notes'],
    ['a --file script file', 'sed --file=script.sed notes'],
    ['the e flag of s', "sed 's/x/date/e' notes"],
    ['the e flag of s after other flags', "sed 's|x|date|ge' notes"],
    ['the w flag of s', "sed -n 's/x/y/w ../out.txt' notes"],
    ['the w command', "sed -n 'w ../out.txt' notes"],
    ['the W command', "sed -n '1W ../out.txt' notes"],
    ['the r command', "sed '1r ../secret.txt' notes"],
    ['the R command', "sed 'R ../secret.txt' notes"],
    ['an in-place edit', "sed -i 's/x/y/' notes"],
    ['an in-place edit with a suffix', "sed -i.bak 's/x/y/' notes"],
    ['an abbreviated long option', "sed --expr='e date' notes"],
    ['an unknown command', "sed -n 'k' notes"],
    ['an unterminated s command', "sed 's/x/date' notes"],
    ['rg with a preprocessor', 'rg --pre ./run.sh foo'],
    ['rg with an = preprocessor', 'rg --pre=./run.sh foo'],
    ['sort writing an output file', 'sort -o ../out.txt notes'],
    ['sort writing an output file in a short cluster', 'sort -uo../out.txt notes'],
    ['sort writing through an abbreviated --output', 'sort --o=../out.txt notes'],
    ['sort with a compress program', 'sort --compress-program=./run.sh notes'],
    ['sort with an abbreviated compress program', 'sort --com=./run.sh notes'],
    ['git grep with a pager command', 'git grep -O./run.sh foo'],
    ['git grep with a long pager option', 'git grep --open-files-in-pager=./run.sh foo'],
    ['file compiling a magic file', 'file -C -m magic'],
    ['uniq writing an output file', 'uniq notes ../out.txt'],
    ['uniq writing an output file after --', 'uniq -- notes ../out.txt'],
    ['find running a command', 'find . -exec date ;'],
    ['find running a command per directory', 'find . -execdir date +'],
    ['find asking to run a command', 'find . -okdir date ;'],
    ['find writing a file list', 'find . -fprint ../out.txt'],
    ['find deleting files', 'find . -delete'],
    ['awk, which is not allowed at all', "awk 'BEGIN { system(\"date\") }'"],
    ['xargs, which is not allowed at all', 'ls | xargs date'],
  ])('refuses %s', (_name, command) => {
    const result = run('Bash', { command });
    expect(result.status, command).toBe(2);
    expect(result.stderr).toMatch(/in prompt-eval sessions/);
  });

  it.each([
    "sed -n '1,5p' notes",
    'sed -n 1,5p notes',
    "sed -E 's/(a|b)/c/g' notes",
    "sed -n '/^Check:/p' notes",
    "sed -n '$=' notes",
    "sed 's/w/e/' notes",
    "sed -n 's/x/y/gp' notes",
    "sed -n '/begin/,/end/{/x/!p}' notes",
    "sed '/^#/d;s/  */ /g' notes",
    'rg -n foo notes',
    'sort -u notes',
    'git grep -n foo',
    'file notes',
    'uniq -c notes',
    'find . -name "*.md"',
  ])('allows %s', (command) => {
    expect(run('Bash', { command }).status, command).toBe(0);
  });

  it('fails closed when a hook call cannot be read', () => {
    const result = spawnSync(process.execPath, [DENY_EVAL_SIDE_EFFECTS_HOOK], { input: '{', encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('could not read prompt-eval guard input');
  });
});
