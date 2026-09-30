import fs from 'node:fs';
import path from 'node:path';
import type { Repo } from '@overseer/shared';
import type { PreambleBatch } from '../orchestrator/orchestrator';

/** What a mocked tool call answers: a JSON value, or an error text the tool returns as a failed call. */
export type FixtureReply = { reply: unknown } | { error: string };
/** One listed reply: it answers a call of `tool` whose arguments hold every key of `args` (see `argsMatch`). */
export type Fixture = FixtureReply & { tool: string; args?: Record<string, unknown> };
export interface Fixtures { default: FixtureReply; calls: Fixture[] }

/** The checks graded in code, on the calls the mock recorded and the messages the session wrote. */
export type ExactAssertion =
  | { kind: 'called'; tool: string; args?: Record<string, unknown> }
  | { kind: 'not_called'; tool: string }
  | { kind: 'order'; before: string; after: string }
  | { kind: 'arg_contains'; tool: string; arg: string; phrase: string }
  | { kind: 'no_message' };
/** A line a judge session grades pass or fail against the run's transcript. */
export interface RubricAssertion { kind: 'rubric'; line: string }
export type Assertion = ExactAssertion | RubricAssertion;

/** What the fresh session's preamble names: the daemon's `sessionPreamble` renders it. */
export interface CaseState { repos: Repo[]; batches: PreambleBatch[] }
export interface EvalCase {
  id: string;
  /** The `docs/lessons.md` entry the case tests: its heading and the quoted rule. */
  source: { entry: string; quote: string };
  /** What the orchestrator receives after the preamble: a user message with its `[repo: <id>]` prefix, or an `[Overseer]` notice. */
  input: string;
  state: CaseState;
  fixtures: Fixtures;
  assertions: Assertion[];
}

/**
 * A tool call the mock received, in call order. `fixture` is the index of the listed reply it got, or `default`; a call its
 * tool's input schema refused (or that names no tool) is recorded too, with `rejected` saying why and `fixture` null.
 */
export interface RecordedCall { seq: number; tool: string; args: Record<string, unknown>; fixture: number | 'default' | null; rejected?: string }
/** What a run left to grade: the calls the mock recorded, and every non-empty text the session wrote (each one a chat message). */
export interface RunRecord { calls: RecordedCall[]; messages: string[] }
export interface AssertionResult { assertion: Assertion; pass: boolean; detail: string }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A case read from JSON, every field checked: a missing or mistyped one throws naming the file and the field's path. */
export function parseCase(raw: unknown, file: string): EvalCase {
  const fail = (msg: string): never => { throw new Error(`${file}: ${msg}`); };
  const get = (o: Obj, key: string, at: string, type: 'string' | 'object' | 'array' | 'number'): unknown => {
    const v = o[key];
    if (v === undefined || v === null) return fail(`missing field ${at}${key}`);
    const ok = type === 'array' ? Array.isArray(v) : type === 'object' ? isObj(v) : typeof v === type;
    if (!ok) fail(`field ${at}${key} must be ${type === 'array' || type === 'object' ? `an ${type}` : `a ${type}`}`);
    if (type === 'string' && !(v as string).trim()) fail(`field ${at}${key} is blank`);
    return v;
  };
  if (!isObj(raw)) return fail('a case must be a JSON object');
  const id = get(raw, 'id', '', 'string') as string;
  if (!/^[a-z0-9-]+$/.test(id)) fail(`field id must be lowercase letters, digits and dashes, got ${id}`);
  const source = get(raw, 'source', '', 'object') as Obj;
  const input = get(raw, 'input', '', 'string') as string;
  const state = get(raw, 'state', '', 'object') as Obj;
  const repos = (get(state, 'repos', 'state.', 'array') as unknown[]).map((r, i) => {
    const at = `state.repos[${i}].`;
    if (!isObj(r)) return fail(`field ${at.slice(0, -1)} must be an object`);
    get(r, 'id', at, 'string'); get(r, 'base_branch', at, 'string'); get(r, 'merge_mode', at, 'string');
    if (r.verify_command !== undefined && r.verify_command !== null && typeof r.verify_command !== 'string') fail(`field ${at}verify_command must be a string or null`);
    return { ...r, verify_command: r.verify_command ?? null } as unknown as Repo;
  });
  const batches = (get(state, 'batches', 'state.', 'array') as unknown[]).map((b, i) => {
    const at = `state.batches[${i}].`;
    if (!isObj(b)) return fail(`field ${at.slice(0, -1)} must be an object`);
    for (const k of ['id', 'title', 'branch', 'status']) get(b, k, at, 'string');
    for (const k of ['total', 'done']) get(b, k, at, 'number');
    return { ...b, waiting_on: (b.waiting_on as string | undefined) ?? null, closed: (b.closed as number | undefined) ?? 0 } as unknown as PreambleBatch;
  });
  const fixtures = get(raw, 'fixtures', '', 'object') as Obj;
  const reply = (o: Obj, at: string): FixtureReply => {
    if ('error' in o) return { error: get(o, 'error', at, 'string') as string };
    if (!('reply' in o)) return fail(`missing field ${at}reply (or ${at}error)`);
    return { reply: o.reply };
  };
  const dflt = reply(get(fixtures, 'default', 'fixtures.', 'object') as Obj, 'fixtures.default.');
  const calls = (get(fixtures, 'calls', 'fixtures.', 'array') as unknown[]).map((f, i): Fixture => {
    const at = `fixtures.calls[${i}].`;
    if (!isObj(f)) return fail(`field ${at.slice(0, -1)} must be an object`);
    const tool = get(f, 'tool', at, 'string') as string;
    if (f.args !== undefined && !isObj(f.args)) fail(`field ${at}args must be an object`);
    return { tool, ...(f.args ? { args: f.args as Obj } : {}), ...reply(f, at) };
  });
  const assertions = (get(raw, 'assertions', '', 'array') as unknown[]).map((a, i): Assertion => {
    const at = `assertions[${i}].`;
    if (!isObj(a)) return fail(`field ${at.slice(0, -1)} must be an object`);
    const kind = get(a, 'kind', at, 'string') as string;
    const s = (k: string) => get(a, k, at, 'string') as string;
    switch (kind) {
      case 'called': {
        if (a.args !== undefined && !isObj(a.args)) fail(`field ${at}args must be an object`);
        return { kind, tool: s('tool'), ...(a.args ? { args: a.args as Obj } : {}) };
      }
      case 'not_called': return { kind, tool: s('tool') };
      case 'order': return { kind, before: s('before'), after: s('after') };
      case 'arg_contains': return { kind, tool: s('tool'), arg: s('arg'), phrase: s('phrase') };
      case 'no_message': return { kind };
      case 'rubric': return { kind, line: s('line') };
      default: return fail(`field ${at}kind must be one of called, not_called, order, arg_contains, no_message, rubric; got ${kind}`);
    }
  });
  if (!assertions.length) fail('field assertions is empty');
  return {
    id, input,
    source: { entry: get(source, 'entry', 'source.', 'string') as string, quote: get(source, 'quote', 'source.', 'string') as string },
    state: { repos, batches },
    fixtures: { default: dflt, calls },
    assertions,
  };
}

/** Every `*.json` case in `dir`, in file-name order; a duplicate id is refused, and so is a directory with no case. */
export function loadCases(dir: string): EvalCase[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`${dir} holds no *.json case`);
  const cases = files.map((f) => {
    const file = path.join(dir, f);
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`${file}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`); }
    return parseCase(raw, file);
  });
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`case id ${c.id} is used twice in ${dir}`);
    seen.add(c.id);
  }
  return cases;
}

function valueMatches(want: unknown, got: unknown): boolean {
  if (Array.isArray(want)) return Array.isArray(got) && want.length <= got.length && want.every((w, i) => valueMatches(w, got[i]));
  if (isObj(want)) return isObj(got) && argsMatch(want, got);
  return want === got;
}

/**
 * Whether `args` holds every key of `want` with a matching value: objects match on the keys `want` names, an array matches as a
 * prefix (`["show", "ov-1"]` also answers `["show", "ov-1", "--long"]`), anything else must be equal. No `want` matches any call.
 */
export function argsMatch(want: Obj | undefined, args: Obj): boolean {
  return !want || Object.entries(want).every(([k, v]) => valueMatches(v, args[k]));
}

/** The flags of bd 1.2.2 `create --help` that take no value, so the token after one can be the positional title. */
const BD_CREATE_BOOLEAN_FLAGS = new Set([
  '--dry-run', '--ephemeral', '--force', '-h', '--help', '--no-history', '--no-inherit-labels', '--silent', '--stdin', '--validate',
  '--global', '--ignore-schema-skew', '--json', '--profile', '-q', '--quiet', '--readonly', '--sandbox', '-v', '--verbose',
]);

/** The title a `bd create` call names: `--title`, `--title=`, or the positional argument wherever it sits among the flags. */
function bdCreateTitle(args: Obj): string | undefined {
  const tokens = args.args;
  if (!Array.isArray(tokens) || tokens[0] !== 'create' || !tokens.every((token) => typeof token === 'string')) return undefined;
  let positional: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === '--title') return tokens[i + 1] as string | undefined;
    if (token.startsWith('--title=')) return token.slice('--title='.length);
    if (!token.startsWith('-')) positional ??= token;
    else if (!token.includes('=') && !BD_CREATE_BOOLEAN_FLAGS.has(token)) i++;
  }
  return positional;
}

function echoCreatedTitle(reply: unknown, title: string): unknown {
  const replace = (value: unknown) => isObj(value) ? { ...value, title } : value;
  return Array.isArray(reply) ? reply.map(replace) : replace(reply);
}

/** The title each earlier accepted `bd create` gave the bead id(s) its fixture reply names, so a later read shows that title. */
function createdTitles(fixtures: Fixtures, history: readonly Pick<RecordedCall, 'tool' | 'fixture' | 'args'>[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const c of history) {
    if (c.tool !== 'bd' || typeof c.fixture !== 'number') continue;
    const title = bdCreateTitle(c.args);
    const fixture = fixtures.calls[c.fixture];
    if (title === undefined || !fixture || !('reply' in fixture)) continue;
    for (const item of Array.isArray(fixture.reply) ? fixture.reply : [fixture.reply]) {
      if (isObj(item) && typeof item.id === 'string') titles.set(item.id, title);
    }
  }
  return titles;
}

function withCreatedTitles(reply: unknown, titles: Map<string, string>): unknown {
  const replace = (value: unknown) => isObj(value) && typeof value.id === 'string' && titles.has(value.id) ? { ...value, title: titles.get(value.id) } : value;
  return Array.isArray(reply) ? reply.map(replace) : replace(reply);
}

/**
 * The next unused matching reply in this call sequence, repeating the first match once the sequence is exhausted. A `bd create`
 * reply carries the submitted title, and any later reply naming a bead that create made carries it too, so a fixture's own
 * title never contradicts what the model just wrote.
 */
export function replyFor(fixtures: Fixtures, tool: string, args: Obj, history: readonly Pick<RecordedCall, 'tool' | 'fixture' | 'args'>[] = []): { reply: FixtureReply; fixture: number | 'default' } {
  const matching = fixtures.calls.map((f, i) => ({ f, i })).filter(({ f }) => f.tool === tool && argsMatch(f.args, args));
  const used = new Set(history.filter((c) => c.tool === tool && typeof c.fixture === 'number').map((c) => c.fixture));
  const at = (matching.find(({ i }) => !used.has(i)) ?? matching[0])?.i ?? -1;
  const fixture = at < 0 ? fixtures.default : fixtures.calls[at]!;
  if ('error' in fixture) return { reply: { error: fixture.error }, fixture: at < 0 ? 'default' : at };
  const title = tool === 'bd' ? bdCreateTitle(args) : undefined;
  const reply = title === undefined ? withCreatedTitles(fixture.reply, createdTitles(fixtures, history)) : echoCreatedTitle(fixture.reply, title);
  return { reply: { reply }, fixture: at < 0 ? 'default' : at };
}

/**
 * Grades one exact check on a run. `detail` says what was found, so a failure reads without the transcript. `called`, `order`
 * and `arg_contains` count only the calls the tool accepted, since a rejected call did nothing; `not_called` fails on any
 * attempt, rejected or not, since the attempt is the behaviour it forbids.
 */
export function checkExact(a: ExactAssertion, run: RunRecord): { pass: boolean; detail: string } {
  const of = (tool: string) => run.calls.filter((c) => c.tool === tool && !c.rejected);
  const seqs = (calls: RecordedCall[]) => calls.map((c) => `#${c.seq}${c.rejected ? ` (rejected: ${c.rejected})` : ''}`).join(', ');
  switch (a.kind) {
    case 'called': {
      const hits = of(a.tool).filter((c) => argsMatch(a.args, c.args));
      return hits.length
        ? { pass: true, detail: `${a.tool} called (${seqs(hits)})` }
        : { pass: false, detail: of(a.tool).length ? `${a.tool} called ${of(a.tool).length} time(s), none with ${JSON.stringify(a.args)}` : `${a.tool} not called` };
    }
    case 'not_called': {
      const hits = run.calls.filter((c) => c.tool === a.tool);
      return hits.length ? { pass: false, detail: `${a.tool} called (${seqs(hits)})` } : { pass: true, detail: `${a.tool} not called` };
    }
    case 'order': {
      const first = of(a.before)[0];
      const then = of(a.after)[0];
      if (!first || !then) return { pass: false, detail: [!first && `${a.before} not called`, !then && `${a.after} not called`].filter(Boolean).join('; ') };
      return first.seq < then.seq
        ? { pass: true, detail: `${a.before} #${first.seq} before ${a.after} #${then.seq}` }
        : { pass: false, detail: `${a.after} #${then.seq} came before ${a.before} #${first.seq}` };
    }
    case 'arg_contains': {
      const phrase = a.phrase.toLowerCase();
      const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
      const hit = of(a.tool).find((c) => text(c.args[a.arg]).toLowerCase().includes(phrase));
      if (hit) return { pass: true, detail: `${a.tool} #${hit.seq} ${a.arg} contains "${a.phrase}"` };
      return { pass: false, detail: of(a.tool).length ? `no ${a.tool} call has "${a.phrase}" in ${a.arg}` : `${a.tool} not called` };
    }
    case 'no_message':
      return run.messages.length
        ? { pass: false, detail: `${run.messages.length} message(s), the first: "${run.messages[0]!.slice(0, 200)}"` }
        : { pass: true, detail: 'no message' };
  }
}

/** How a run's orchestrator session ended, as the sessions layer recorded it. */
export interface SessionOutcome { events: readonly TranscriptEvent[]; status: string; endReason: string | null; timedOut: boolean }

/**
 * Why a run's turn does not count, or null when the session finished exactly what a run needs: a turn end, no error event (a
 * CLI failure, or the spending cap reached), a clean end, and no timeout. A run that never started or never finished its
 * turn would otherwise pass every `not_called` and `no_message` check by doing nothing.
 */
export function turnProblem(o: SessionOutcome): string | null {
  if (o.timedOut) return 'timed out before the turn ended';
  const errors = o.events.filter((e) => e.type === 'error').map((e) => (e.payload as { message?: string } | null)?.message ?? 'error');
  if (errors.length) return `the session reported ${errors.join('; ')}`;
  if (!o.events.some((e) => e.type === 'turn_end')) return 'the session ended without finishing its turn';
  if (o.status !== 'ended') return `the session ${o.status}${o.endReason ? `: ${o.endReason}` : ''}`;
  return null;
}

/** A run passes when its turn completed cleanly and every assertion passed. */
export function runPassed(problem: string | null, results: readonly { pass: boolean }[]): boolean {
  return problem === null && results.every((r) => r.pass);
}

/** The share of a case's runs that passed; null when there were no runs, which is not a rate of 0. */
export function passRate(runs: readonly boolean[]): number | null {
  return runs.length ? runs.filter(Boolean).length / runs.length : null;
}

/** A prompt's score: the mean of its cases' pass rates; null with no case, so an empty case set never reads as a score. */
export function promptScore(rates: readonly number[]): number | null {
  return rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
}

/**
 * The folder the Claude CLI keeps for a working directory under `<claudeHome>/projects`, named by the CLI with every character
 * of the path other than a letter or digit replaced by `-`. With `--no-session-persistence` it still creates that folder, holding
 * only an empty `memory` folder, which the runner removes once the call has ended.
 */
export function claudeProjectDir(cwd: string, claudeHome: string): string {
  return path.join(claudeHome, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** Refuses the live daemon's port, so a mock can never stand in for, or be mistaken for, the user's own daemon. */
export function assertNotLivePort(port: number, livePorts: readonly number[]): void {
  if (livePorts.includes(port)) throw new Error(`refusing to serve the mock on port ${port}, the live daemon's`);
}

/** A harness event as the sessions layer stores it. */
export interface TranscriptEvent { type: string; payload: unknown }
const MCP_PREFIX = 'mcp__overseer__';
const RESULT_LIMIT = 2000;

/** The run as a judge reads it: the input, then each text, tool call and tool result in order, long results cut. */
export function renderTranscript(input: string, events: readonly TranscriptEvent[]): string {
  const lines = [`[input]\n${input}`];
  for (const e of events) {
    const p = (e.payload ?? {}) as { text?: string; name?: string; input?: unknown; output?: unknown; message?: string };
    if (e.type === 'assistant_text' && p.text?.trim()) lines.push(`[orchestrator message]\n${p.text.trim()}`);
    else if (e.type === 'tool_call') lines.push(`[tool call ${String(p.name ?? '').replace(MCP_PREFIX, '')}] ${JSON.stringify(p.input ?? {})}`);
    else if (e.type === 'tool_result') {
      // An MCP result is a list of content blocks; its text blocks read as the tool's reply rather than as escaped JSON.
      const blocks = Array.isArray(p.output) ? (p.output as { type?: string; text?: string }[]) : null;
      const out = typeof p.output === 'string' ? p.output
        : blocks?.every((b) => b?.type === 'text') ? blocks.map((b) => b.text ?? '').join('\n') : JSON.stringify(p.output ?? '');
      lines.push(`[tool result] ${out.length > RESULT_LIMIT ? `${out.slice(0, RESULT_LIMIT)} … (${out.length - RESULT_LIMIT} more characters)` : out}`);
    } else if (e.type === 'error') lines.push(`[error] ${p.message ?? ''}`);
  }
  return lines.join('\n\n');
}

/** Every non-empty text the session wrote at the top level: each one is a chat message (and a push) in the daemon. */
export function messagesOf(events: readonly TranscriptEvent[]): string[] {
  return events.filter((e) => e.type === 'assistant_text' && !(e.payload as { parentId?: string }).parentId)
    .map((e) => ((e.payload as { text?: string }).text ?? '').trim()).filter(Boolean);
}

/** The judge's instructions: the transcript and the rubric lines only, never the prompt under test or which prompt ran. */
export function judgePrompt(transcript: string, lines: readonly string[]): string {
  return `You are grading one run of an AI coordinator that manages coding work for a user. It received the input below and could call tools; every tool reply was a fixed test fixture. Grade each rubric line on what the run actually did, not on what it should have done otherwise.

For each line, answer pass or fail, with a reason, and a quote copied verbatim from the transcript that shows it (a sentence of a message or a tool call's argument). A pass needs a quote, and so does a fail that rests on something the run did. Only a fail that rests on something the run never did or said has no quote: set "missing" to true and quote "". Otherwise "missing" is false.

Reply with JSON only, no prose and no code fence, in this shape:
[{"line":1,"pass":true,"missing":false,"quote":"...","reason":"..."}, ...one entry per line]

## Rubric
${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}

## Transcript
${transcript}
`;
}

/** One rubric line's grade; `valid` is false when the judge broke its evidence contract, which always fails the line. */
export interface RubricGrade { line: number; pass: boolean; valid: boolean; quote: string; reason: string }
// Backticks go too: a judge quoting chat prose often drops the inline-code marks around a file or command name.
const squash = (s: string) => s.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The judge's reply as one grade per rubric line, in line order, each checked against the evidence contract of `judgePrompt`:
 * a supplied quote must be in the transcript (compared case- and whitespace-insensitively; a quote the judge shortened with
 * `...` or `…` counts when every piece is), a pass needs one, and a fail needs one unless the judge marked it `missing`. A grade
 * that breaks the contract, or a line the reply leaves out, is invalid and fails, with the reason naming the broken rule, so no
 * pass or fail stands on evidence the run does not contain. The reply is the outermost JSON array, or for a one-line rubric a
 * bare grade object, which judges send in place of a one-element array.
 */
export function parseJudge(text: string, count: number, transcript: string): RubricGrade[] {
  type Raw = { line?: unknown; pass?: unknown; missing?: unknown; quote?: unknown; reason?: unknown };
  const arrayAt = text.indexOf('[');
  const objectAt = text.indexOf('{');
  const isObject = objectAt >= 0 && (arrayAt < 0 || objectAt < arrayAt);
  const json = isObject ? text.slice(objectAt, text.lastIndexOf('}') + 1) : text.slice(arrayAt, text.lastIndexOf(']') + 1);
  const parsed = JSON.parse(sanitizeJudgeJson(json)) as Raw | Raw[];
  const raw: Raw[] = Array.isArray(parsed) ? parsed : [parsed];
  const haystack = squash(transcript);
  const inTranscript = (quote: string) => quote.split(/\.\.\.|…/).map(squash).filter(Boolean).every((piece) => haystack.includes(piece));
  return Array.from({ length: count }, (_, i) => {
    const g = raw.find((r) => r.line === i + 1);
    if (!g) return { line: i + 1, pass: false, valid: false, quote: '', reason: 'the judge gave no grade for this line' };
    const quote = typeof g.quote === 'string' ? g.quote.trim() : '';
    const reason = typeof g.reason === 'string' ? g.reason : '';
    const pass = g.pass === true;
    const broken = quote && !inTranscript(quote) ? `the judge ${pass ? 'passed' : 'failed'} it on a quote that is not in the transcript`
      : !quote && pass ? 'the judge passed it without a quote'
      : !quote && g.missing !== true ? 'the judge failed it without a quote and without marking it as resting on something missing'
      : null;
    if (broken) return { line: i + 1, pass: false, valid: false, quote, reason: `${broken} (${reason})` };
    return { line: i + 1, pass, valid: true, quote, reason };
  });
}

/** Literal control bytes can appear in judge text blocks even though JSON strings must escape them. Normalize them before parsing. */
function sanitizeJudgeJson(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    const code = ch.codePointAt(0)!;
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) { out += ' '; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') { out += ch; inString = true; continue; }
    if ((code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') || (code >= 0x7f && code <= 0x9f)) { out += ' '; continue; }
    out += ch;
  }
  return out;
}
