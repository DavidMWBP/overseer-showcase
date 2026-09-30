import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BatchSummary, Bead, HarnessName, Program, ProgramDetail, ProgramEntryKind, SessionRole, TierName } from '@overseer/shared';
import type { Db } from '../db/db';
import type { Push } from '../push/push';
import type { TaskStore } from '../beads/store';
import { BD_READS, labelNames } from '../beads/beads';
import { BATCH_PREFIX, batchOf, columnFor, phaseOf } from '../beads/store';
import type { SessionManager } from '../sessions/manager';
import { batchStatusLabel, verifyLabel, type Lifecycle } from '../lifecycle/lifecycle';
import { beadRetrospective, compactRetrospective } from '../lifecycle/retrospective';
import type { Bus } from '../bus';
import type { Plans } from '../plans/plans';
import type { Servers } from '../servers/servers';
import { diffAgainstBase } from '../git/git';
import { batchSummaries, readySet } from '../api/board';
import { log } from '../util/log';

export interface McpDeps { db: Db; store: TaskStore; sessions: SessionManager; lifecycle: Lifecycle; bus: Bus; plans: Plans; servers: Servers; push?: Push; boardRefreshDelayMs?: number; originChatId?: (sessionId: string | undefined) => number | null }

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });
const guard = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => { try { return ok(await fn(a)); } catch (e) { return fail(e); } };

const harness = z.enum(['claude', 'codex', 'opencode']);
const tier = z.enum(['chore', 'standard', 'hard', 'critic']);
const filter = z.enum(['all', 'ready', 'open', 'in_progress', 'blocked', 'closed', 'review']);
/** A board refresh costs a `bd list` plus `bd ready` per repo, so a write that lands within this of the last one shares its refresh. */
export const BOARD_COALESCE_MS = 400;
/** A stream of writes never postpones the refresh beyond this: the Board stays live while the orchestrator keeps writing. */
export const BOARD_COALESCE_MAX_MS = 2000;
/** Keyed by the daemon's bus, because every MCP request gets its own server and its own `registerTools` call. */
const boardTimers = new WeakMap<Bus, { timer: NodeJS.Timeout; since: number }>();

/**
 * Schedule the Board refresh of a bd write instead of emitting it in place: writes that arrive together then cost one board build
 * instead of one each, the orchestrator's next write no longer queues behind the `bd list` of its predecessor's refresh, and a
 * listener that throws cannot turn a successful bd write into a reported tool error from inside `guard` (fix round 22 review M-1,
 * M-3). Five bd writes in a row cost five builds and took 2.9 s before this, one build and 1.3 s after (bd at the times round 23
 * measured: a write 250 ms, a build 800 ms).
 */
export function refreshBoard(bus: Bus, delayMs = BOARD_COALESCE_MS): void {
  const pending = boardTimers.get(bus);
  if (pending) {
    if (Date.now() - pending.since >= BOARD_COALESCE_MAX_MS) return;
    clearTimeout(pending.timer);
  }
  const timer = setTimeout(() => {
    boardTimers.delete(bus);
    try { bus.emit('board'); } catch (e) { log.error('mcp: a board listener threw', e); } // uncaught here it would end the daemon
  }, delayMs);
  timer.unref();
  boardTimers.set(bus, { timer, since: pending?.since ?? Date.now() });
}

/** The bead writes whose bd result is trimmed to the id, status and title (and, for `create`, the labels). */
const BD_COMPACT_BEAD = new Set(['note', 'update', 'close']);

function compactEntry(o: Record<string, unknown>, labels: boolean): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const id = o.id ?? o.issue_id;
  if (id !== undefined) c.id = id;
  if (o.status !== undefined) c.status = o.status;
  if (o.title !== undefined) c.title = o.title;
  if (labels) c.labels = labelNames(o.labels);
  return c;
}

/** `dep add`/`dep remove` name both ends and the relation: `bd dep add <child> <parent>` answers issue_id/depends_on_id/type. */
function compactDependency(o: Record<string, unknown>): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const from = o.issue_id ?? o.blocked_id;
  const to = o.depends_on_id ?? o.blocker_id;
  if (from !== undefined) c.issue_id = from;
  if (to !== undefined) c.depends_on_id = to;
  if (o.type !== undefined) c.type = o.type;
  return c;
}

/** Maps a compact over bd's object or array without changing which of the two it was; an unrecognised shape is returned whole. */
function mapBd(out: unknown, fn: (o: Record<string, unknown>) => Record<string, unknown>): unknown {
  const one = (v: unknown) => {
    if (!v || typeof v !== 'object') return v;
    const c = fn(v as Record<string, unknown>);
    return Object.keys(c).length ? c : v;
  };
  return Array.isArray(out) ? out.map(one) : one(out);
}

/**
 * bd echoes the whole bead it wrote — description, notes and every dependency — and the orchestrator re-pays that on every
 * later turn. These write subcommands are reported compact instead: the id(s), status and title, plus the labels on `create`
 * and the two ids and type on `dep add`/`dep remove`; `dep list` reports id, title and status per dependency. Anything else
 * (every read, and a write shape this does not know) is returned untouched, so `show` still hands over the full bead.
 */
function compactBd(args: string[], out: unknown): unknown {
  const [cmd, sub] = args;
  if (cmd === 'create') return mapBd(out, (o) => compactEntry(o, true));
  if (BD_COMPACT_BEAD.has(cmd!)) return mapBd(out, (o) => compactEntry(o, false));
  if (cmd === 'dep') {
    if (sub === 'add' || sub === 'remove') return mapBd(out, compactDependency);
    if (sub === 'list') return mapBd(out, (o) => compactEntry(o, false));
  }
  if (cmd === 'label' && (sub === 'add' || sub === 'remove')) return mapBd(out, (o) => compactEntry(o, false));
  return out;
}

/**
 * The bead a `note`, `update` or `dep add` write acts on, from bd's argument order (`bd note <id>`, `bd update <id>`,
 * `bd dep add <child> <parent>`): the bead whose `overseer:batch:<id>` label links the write to its batch. Null for any
 * other command, and for a leading flag, so a usage call costs no bead read.
 */
function bdWriteBead(args: string[]): string | null {
  const [cmd, sub] = args;
  const id = cmd === 'note' || cmd === 'update' ? args[1] : cmd === 'dep' && sub === 'add' ? args[2] : undefined;
  return id && !id.startsWith('-') ? id : null;
}

export function registerTools(server: McpServer, d: McpDeps, callerSessionId?: string): void {
  /** The session that opened this MCP connection. Only the per-session URL carries one, so the orchestrator has none. */
  const requireSession = () => {
    const s = callerSessionId ? d.db.sessions.get(callerSessionId) : undefined;
    if (!s) throw new Error('this tool is available to a worker session only');
    return s;
  };
  const repoOf = (id: string) => {
    const r = d.db.repos.get(id);
    if (!r) throw new Error(`repo ${id} not found; call list_repos`);
    return r;
  };
  const latestSession = (beadId: string, role?: SessionRole) => {
    const rows = d.db.sessions.forBead(beadId).filter((r) => !role || r.role === role);
    const s = rows[rows.length - 1];
    if (!s) throw new Error(`no session for ${beadId}`);
    return s;
  };
  /** The chat message this call acts on; the orchestrator's live turn has one, a worker session and a notice turn do not. */
  const callerChatId = (): number | null => d.originChatId?.(callerSessionId) ?? null;
  /** Records the message a call acts on against the batch it touches; either missing records nothing. */
  const linkBatch = (batchId: string | null | undefined): void => {
    if (!batchId) return;
    const chatId = callerChatId();
    if (chatId !== null) d.db.chatLinks.link(chatId, batchId);
  };
  const programDetail = async (program: Program): Promise<ProgramDetail> => {
    const memberships = d.db.programBatches.forProgram(program.id);
    const repo = d.db.repos.get(program.repo_id);
    let summaries: BatchSummary[] = [];
    if (memberships.length && repo && await d.store.available()) {
      summaries = batchSummaries(d.db, repo.id, await d.store.list(repo.path));
    }
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    return {
      ...program,
      batches: memberships.map((membership) => {
        const batch = d.db.batches.get(membership.batch_id);
        const summary = byId.get(membership.batch_id);
        return {
          ...membership,
          title: batch?.title ?? null,
          status: batch?.status ?? null,
          beads_total: summary?.beads_total ?? 0,
          beads_done: summary?.beads_done ?? 0,
          beads_closed: summary?.beads_closed ?? 0,
        };
      }),
      waits: d.db.batchWaits.forProgram(program.id),
      entries: d.db.programEntries.forProgram(program.id),
      merge_order: d.db.mergeOrder.forProgram(program.id),
    };
  };
  /** Links a bead's write to its batch from the bead's `overseer:batch:<id>` label; a bead with none records nothing. */
  const linkBead = async (repo: string, beadId: string): Promise<void> => {
    if (callerChatId() === null) return; // no message to record; skip the bead read
    const bead = await d.store.show(repoOf(repo).path, beadId);
    if (bead) linkBatch(batchOf(bead));
  };

  // `verification` spells the configuration out, so the orchestrator never infers a verify command from bead notes (round 7).
  server.tool('list_repos', 'List the repositories Overseer manages, with base branch, merge mode (local-merge or gitlab-mr), batch approver (`batch_approver`: user = a finished batch waits for the user\'s Merge; orchestrator = the orchestrator merges finished batches on its own, only ever for a local-merge repository), worker limit, verify command (`verify_command`, null when none is configured: branches then land unverified), review command (`review_command`, null when none: the daemon skips the pre-review suite), and setup command (`setup_command`, null when none: the daemon runs it in every new bead and batch worktree right after creation, e.g. to install dependencies so commit hooks can run during merges). This is the only source of truth for these commands. The `model_filter` field restricts which harness, model and account dispatches for that repository may use; null means the global tiers, and review critics are not filtered.', {}, guard(async () => d.db.repos.all().map((r) => ({ ...r, verification: r.verify_command ? `runs ${verifyLabel(r)} in the bead's worktree after the worker ends` : 'no verify command configured: branches land without a check' }))));

  server.tool('list_tasks', 'List beads in a repo with their board column. filter: all | ready | open | in_progress | blocked | closed | review.', { repo: z.string(), filter: filter.default('all') }, guard(async ({ repo, filter: f }) => {
    const r = repoOf(repo);
    const beads = await d.store.list(r.path);
    const ready = await readySet(d.store, r.path, beads);
    const withCol = beads.map((b) => ({ ...b, column: columnFor(b, ready) }));
    const pick = (b: Bead & { column: string }) => {
      switch (f) {
        case 'all': return true;
        case 'ready': return b.column === 'ready';
        case 'review': return phaseOf(b) === 'review';
        case 'blocked': return b.column === 'blocked';
        default: return b.status === f;
      }
    };
    return withCol.filter(pick);
  }));

  // A bead created for a batch is labelled `overseer:batch:<id>` by the daemon (the orchestrator never writes overseer:* labels), so the
  // batch counts it from creation, before any dispatch (round 15: an undispatched bead of the batch was missing from its total).
  server.tool('bd', 'Run a bd command in a repo and return its JSON output. Overseer adds --json. A write command (create, note, update, close, dep add, dep remove, label add, label remove) returns only the bead id(s), status and title — plus the labels for create, and the two ids and dependency type for dep add/dep remove — so a long description or notes is never handed back again; dep list returns id, title and status per dependency. Every other command, including show, returns bd\'s full output, so show is how to read a bead\'s description and notes. A failing command returns bd\'s error text in full. Example args: ["create","Add login","-d","Use the auth lib","--deps","blocked-by:ov-3"] (the new bead depends on ov-3). When creating a bead for a batch, pass batch_id: Overseer labels the bead as part of that batch so the batch counts it before it is dispatched.', { repo: z.string(), args: z.array(z.string()).min(1), batch_id: z.string().optional() }, guard(async ({ repo, args, batch_id }) => {
    const r = repoOf(repo);
    if (batch_id !== undefined) {
      if (args[0] !== 'create') throw new Error('batch_id applies to bd create only');
      const b = d.db.batches.get(batch_id);
      if (!b || b.repo_id !== r.id) throw new Error(`batch ${batch_id} not found in ${repo}; call list_batches`);
      if (b.status !== 'open') throw new Error(`batch ${batch_id} is ${b.status}; create a new batch for new work`);
      args = [...args, '--labels', `${BATCH_PREFIX}${batch_id}`];
    }
    const out = await d.store.raw(r.path, args);
    // A write for a batch records the chat message it acts on: `create` from its `batch_id`, `note`/`update`/`dep add`
    // from the bead's `overseer:batch:<id>` label. A read records nothing.
    if (batch_id !== undefined) linkBatch(batch_id);
    else {
      const beadId = bdWriteBead(args);
      if (beadId) await linkBead(repo, beadId);
    }
    // A bd write changes what the Board shows (a bead created, closed, labelled, re-prioritised), so it refreshes the Board like
    // every other write does; a bd read does not. Round 22 R22-1: a bead the orchestrator created without dispatching it reached
    // the Board only at the next unrelated event, and until then the batch row counted 0 of n and the Board said no registered
    // repository had that bead. Every other write in this file goes through the lifecycle or the session manager, which emit it.
    if (!BD_READS.has(args[0]!)) refreshBoard(d.bus, d.boardRefreshDelayMs);
    return compactBd(args, out);
  }));

  server.tool('spawn_worker', "Dispatch a headless worker for a bead in its own worktree. Pass tier (chore, standard or hard; critic is internal to Overseer's review round) and Overseer picks the harness and model from the user's tier settings, preferring a model the bead has not tried yet; no tier means standard. Pass harness without tier to force that CLI: it runs on the first usable model and account configured for that harness in the standard, chore or hard tier, so a forced claude worker reaches the plugin MCP servers its account authorizes; without a repository model filter, with no usable candidate it keeps a retry's pinned model (else that CLI's own default) and any still-usable recorded account, falling back to the CLI's own login, a degraded session rather than a refusal. A repository with a model filter refuses instead when no allowed candidate is usable, and a forced harness outside the filter is refused. Pass harness with tier to force that CLI within that tier: it runs on that tier's first usable candidate of that harness, with its model, effort and account, and when the tier has none the dispatch is refused with the reason (for example no usable claude candidate in tier hard), never moved to another harness or tier; automatic retries keep both. Optional instructions are appended to the worker prompt (use them after a rejection or merge conflict). Pass batch_id so the worker branches from the batch's feature branch. Pass verify_only: true for a verification-only bead (run checks, commit nothing). Optional verify_command is valid only with verify_only: true; a re-dispatch with verify_only: true and no new verify_command keeps the saved command, while dispatch without verify_only clears it. The daemon runs the command in the bead worktree at session end and records its command, head, exit code and parsed counts. A passing command closes as verified; a failing command reopens as verify_incomplete with its output tail, even if the worker reported PASS for that same command. Without verify_command, a passing set of Check lines closes as worker-reported with an overseer:worker-reported label; a missing or non-PASS Check line reopens as verify_incomplete with the existing result in its note and notice. A Check: FAIL reopens even when the configured command passes. Pass needs_server: true when the task runs a server, a daemon or a browser (a dev server, a preview, Playwright, evidence or screenshot capture): harnesses whose shell tool cannot keep such a process alive are then skipped, and a forced harness that cannot, with or without a tier, is refused with the reason instead of started.", { repo: z.string(), bead_id: z.string(), tier: tier.optional(), harness: harness.optional(), instructions: z.string().optional(), batch_id: z.string().optional(), verify_only: z.boolean().optional(), verify_command: z.string().refine((value) => value.trim().length > 0, 'verify_command must not be blank').optional(), needs_server: z.boolean().optional() }, guard(async ({ repo, bead_id, tier: t, harness: h, instructions, batch_id, verify_only, verify_command, needs_server }) => {
    const id = await d.lifecycle.spawnWorker(repo, bead_id, { tier: t as TierName | undefined, harness: h as HarnessName | undefined, instructions, batchId: batch_id, verifyOnly: verify_only, verifyCommand: verify_command, needsServer: needs_server });
    const s = d.db.sessions.get(id)!;
    linkBatch(batch_id);
    return { session_id: id, bead_id, harness: s.harness, model: s.model, tier: s.tier, batch_id: batch_id ?? null };
  }));

  server.tool('message_worker', 'Send a follow-up message to the running worker of a bead.', { repo: z.string(), bead_id: z.string(), text: z.string().min(1) }, guard(async ({ repo, bead_id, text }) => {
    repoOf(repo);
    const s = latestSession(bead_id, 'worker'); // never the critic: during a review the latest session is the critic's
    if (s.status !== 'running') throw new Error(`worker for ${bead_id} is not running (status ${s.status})`);
    await d.sessions.send(s.id, text);
    await linkBead(repo, bead_id);
    return { delivered: true, session_id: s.id };
  }));

  // The daemon owns long-lived processes because no harness can hold one: opencode's shell tool blocks, codex's command
  // policy refuses Start-Process, and our own deny-background hook stops claude. See `servers/servers.ts`.
  server.tool('start_server', 'Start a long-lived process the daemon owns: a dev server, a preview server, a Playwright run, anything that must stay up across your turns. Use this instead of a background shell command, which no harness can keep alive. The process is detached from your session, so it cannot stall your turn, and it is stopped automatically when your session ends. Pass the command exactly as you would type it in a shell (e.g. "pnpm dev --port 5201"). Returns a server_id; read its output with server_logs and stop it early with stop_server. cwd defaults to your working directory.', { command: z.string().min(1), cwd: z.string().optional(), name: z.string().optional() }, guard(async ({ command, cwd, name }) => {
    const s = requireSession();
    const row = await d.servers.start({ sessionId: s.id, repoId: s.repo_id ?? '', beadId: s.bead_id ?? null, cwd: cwd ?? s.cwd, command, name: name ?? null });
    return { server_id: row.id, pid: row.pid, command: row.command, cwd: row.cwd, note: 'the server is starting; call server_logs to confirm it is ready before you use it' };
  }));

  server.tool('server_logs', 'Read the tail of a server started with start_server: use it to confirm the server is ready (its "listening on ..." line) or to read a stack trace after a failed request.', { server_id: z.string(), lines: z.number().int().min(1).max(500).default(50) }, guard(async ({ server_id, lines }) => ({ server_id, output: d.servers.logs(server_id, lines) })));

  server.tool('stop_server', 'Stop a server started with start_server, together with everything it spawned. You do not need to call this before finishing: every server your session started is stopped when the session ends.', { server_id: z.string() }, guard(async ({ server_id }) => {
    await d.servers.stop(server_id);
    return { server_id, status: 'stopped' };
  }));

  server.tool('list_servers', 'List the servers your session currently has running, with their id, command and working directory.', {}, guard(async () => d.servers.running(requireSession().id).map((r) => ({ server_id: r.id, name: r.name, command: r.command, cwd: r.cwd, pid: r.pid, started_at: r.started_at }))));

  server.tool('interrupt_worker', 'Stop the running worker of a bead, for example when the user asks you to stop or change course; pass the reason so it is recorded. The session-end rule then applies: commits → verify → merged into the batch branch (or review for a bead without a batch); no commits → the bead reopens with a "Stopped by the orchestrator" note (a stop, not a failure).', { repo: z.string(), bead_id: z.string(), reason: z.string().optional() }, guard(async ({ repo, bead_id, reason }) => {
    repoOf(repo);
    const s = latestSession(bead_id);
    if (s.status !== 'running') throw new Error(`worker for ${bead_id} is not running`);
    await d.lifecycle.interruptBead(bead_id, { by: 'orchestrator', ...(reason ? { reason } : {}) });
    await linkBead(repo, bead_id);
    return { interrupted: true, session_id: s.id };
  }));

  server.tool('worker_status', 'State, last assistant text, changed files, cost and, for an ended session, why it ended (end_reason: exit code or error, null for a clean end) for the latest worker session of a bead.', { repo: z.string(), bead_id: z.string() }, guard(async ({ repo, bead_id }) => {
    repoOf(repo);
    const s = latestSession(bead_id);
    const st = d.sessions.status(s.id);
    const wt = d.db.worktrees.get(bead_id);
    const account = s.account ? d.db.accounts.get(s.account) : null;
    return { session_id: s.id, harness: s.harness, account: s.account ?? null, account_name: account?.name ?? null, account_label: account?.label ?? null, state: st.state, last_text: st.lastText, end_reason: st.endReason, files: st.files, cost: st.cost, verify_status: wt?.verify_status ?? null, started_at: s.started_at, ended_at: s.ended_at };
  }));

  server.tool('worker_diff', 'Unified diff of the bead branch against its worktree base branch.', { repo: z.string(), bead_id: z.string() }, guard(async ({ repo, bead_id }) => {
    repoOf(repo);
    const wt = d.db.worktrees.get(bead_id);
    if (!wt) throw new Error(`no worktree for ${bead_id}`);
    return await diffAgainstBase(wt.path, wt.base_branch);
  }));

  server.tool('request_merge', 'Mark a verified task as ready for the user to merge, with a note that becomes the review summary and MR description.', { repo: z.string(), bead_id: z.string(), note: z.string().min(1) }, guard(async ({ repo, bead_id, note }) => {
    await d.lifecycle.requestMerge(repo, bead_id, note);
    return { queued_for_review: true, bead_id };
  }));

  server.tool('create_batch', 'Create a batch: one feature branch for one user request. Every bead of the request is dispatched with this batch_id and merges into the branch automatically once verified. Optional branch name, default feature/<slug of title>. Pass base only when the user names a branch to stack the work on, and only in a gitlab-mr repository.', { repo: z.string(), title: z.string().min(1), branch: z.string().optional(), base: z.string().optional() }, guard(async ({ repo, title, branch, base }) => {
    const chatId = callerChatId();
    const b = await d.lifecycle.createBatch(repoOf(repo).id, title, branch, chatId, base);
    if (chatId !== null) d.db.chatLinks.link(chatId, b.id);
    return { batch_id: b.id, branch: b.branch, base_branch: b.base_branch, ...(b.warning ? { warning: b.warning } : {}) };
  }));

  server.tool('propose_plan', "When the user asks to plan the work out, propose it here instead of calling create_batch. Each step is what would become one bead: a title, a description, and dependsOn, the indexes (from 0) of the steps in this same list that it waits on. The user reads and edits the plan on its own page; approving it creates the batch and all its beads with their blocked-by dependencies, and you get a notice with the ids. This creates nothing in git or bd. After calling it, tell the user in one line that the plan is waiting for them, and end your turn.", {
    repo: z.string(),
    title: z.string().min(1),
    steps: z.array(z.object({ title: z.string().min(1), description: z.string(), dependsOn: z.array(z.number().int()).default([]) })).min(1),
  }, guard(async ({ repo, title, steps }) => {
    repoOf(repo);
    const p = await d.plans.propose(repo, title, steps);
    return { plan_id: p.id, url: `#plan/${p.id}`, steps: p.steps.length };
  }));

  server.tool('list_batches', 'Batches of a repo with bead counts and status (open, review, merged, abandoned). beads_done are landed beads, beads_closed the ones the user closed as won\'t do from the Board (finished without landing); the batch is complete when beads_done + beads_closed = beads_total. "review" means awaiting the user\'s review, not merged, whatever the counts say; only "merged" means merged. Each row omits history and note (the previous review summaries and rejection notes, the long free text that can exceed the tool-result limit) and keeps the counts, the status, status_label and review_check (the review command, head, result, duration, output tail and parsed counts); pass batch_id to return that one batch with both, for example to read a previous review note before rewriting it.', { repo: z.string(), batch_id: z.string().optional() }, guard(async ({ repo, batch_id }) => {
    const r = repoOf(repo);
    // The same count the Board shows: worktree rows plus the beads labelled for the batch that were never dispatched.
    // bd down is no reason to hide the batches: the rows are the daemon's; only the never-dispatched members come from bd (fix round 15 review).
    const beads = await d.store.list(r.path).catch((err: unknown) => { log.error('mcp: bd list failed for list_batches; counting dispatched beads only', err); return []; });
    const row = (b: BatchSummary) => { const { cost: _c, cost_unknown: _u, ...rest } = b; return { ...rest, status_label: batchStatusLabel(b.status, b.waiting_on) }; };
    const rows = batchSummaries(d.db, r.id, beads);
    if (batch_id !== undefined) {
      const b = rows.find((x) => x.id === batch_id);
      if (!b) throw new Error(`batch ${batch_id} not found in ${repo}; call list_batches`);
      return row(b);
    }
    return rows.map(row).map(({ history: _h, note: _n, ...b }) => b);
  }));

  server.tool('create_program', 'Create a program to group batches for one multi-story request.', { repo: z.string(), title: z.string().trim().min(1) }, guard(async ({ repo, title }) => {
    const row: Program = { id: `program-${randomUUID()}`, repo_id: repoOf(repo).id, title, status: 'open', created_at: new Date().toISOString(), origin_chat_id: callerChatId() };
    d.db.programs.insert(row);
    return { program_id: row.id, repo_id: row.repo_id, title: row.title };
  }));

  server.tool('add_to_program', 'Add a batch to a program lane. Pass after_batch_id when this batch must wait for another batch; it must be in the same repo, and the wait cannot create a cycle.', { program_id: z.string(), batch_id: z.string(), lane: z.string().refine((value) => value.trim().length > 0, 'lane must not be blank'), after_batch_id: z.string().optional() }, guard(async ({ program_id, batch_id, lane, after_batch_id }) => {
    const program = d.db.programs.get(program_id);
    if (!program) throw new Error(`program ${program_id} not found`);
    const batch = d.db.batches.get(batch_id);
    if (!batch) throw new Error(`batch ${batch_id} not found`);
    if (batch.repo_id !== program.repo_id) throw new Error(`batch ${batch_id} belongs to repo ${batch.repo_id}, not program ${program_id} in repo ${program.repo_id}`);
    if (d.db.programBatches.forProgram(program_id).some((membership) => membership.batch_id === batch_id)) throw new Error(`batch ${batch_id} is already in program ${program_id}`);
    let prerequisiteId: string | undefined;
    if (after_batch_id !== undefined) {
      const prerequisite = d.db.batches.get(after_batch_id);
      if (!prerequisite) throw new Error(`batch ${after_batch_id} not found`);
      if (prerequisite.repo_id !== program.repo_id) throw new Error(`batch ${after_batch_id} belongs to repo ${prerequisite.repo_id}, not program ${program_id} in repo ${program.repo_id}`);
      const cycle = batch_id === after_batch_id || !!d.db.sql.prepare(`WITH RECURSIVE prerequisites(batch_id) AS (
        SELECT prerequisite_batch_id FROM batch_waits WHERE batch_id=?
        UNION
        SELECT w.prerequisite_batch_id FROM batch_waits w JOIN prerequisites p ON w.batch_id=p.batch_id
      ) SELECT 1 FROM prerequisites WHERE batch_id=? LIMIT 1`).get(after_batch_id, batch_id);
      if (cycle) throw new Error(`wait from batch ${batch_id} to ${after_batch_id} would create a cycle`);
      prerequisiteId = after_batch_id;
    }
    d.db.sql.exec('BEGIN IMMEDIATE');
    try {
      const position = (d.db.sql.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM program_batches WHERE program_id=? AND lane=?').get(program_id, lane) as { next: number }).next;
      d.db.programBatches.insert({ program_id, batch_id, lane, position });
      if (prerequisiteId !== undefined && !d.db.sql.prepare('SELECT 1 FROM batch_waits WHERE batch_id=? AND prerequisite_batch_id=?').get(batch_id, prerequisiteId)) {
        d.db.batchWaits.insert({ batch_id, prerequisite_batch_id: prerequisiteId });
      }
      d.db.sql.exec('COMMIT');
      return { added: true, program_id, batch_id, lane, position, after_batch_id: prerequisiteId ?? null };
    } catch (error) {
      d.db.sql.exec('ROLLBACK');
      throw error;
    }
  }));

  server.tool('log_program_entry', 'Record a decision, ownership note or note on a program. Text is preserved as written.', { program_id: z.string(), kind: z.enum(['decision', 'ownership', 'note']), text: z.string().refine((value) => value.trim().length > 0, 'text must not be blank') }, guard(async ({ program_id, kind, text }) => {
    if (!d.db.programs.get(program_id)) throw new Error(`program ${program_id} not found`);
    d.db.programEntries.insert({ program_id, kind: kind as ProgramEntryKind, text, created_at: new Date().toISOString(), source_chat_id: callerChatId() });
    return { logged: true, program_id, kind };
  }));

  server.tool('set_merge_order', 'Set a program merge order. Every named batch must already belong to the program; an empty list clears the order.', { program_id: z.string(), batch_ids: z.array(z.string()) }, guard(async ({ program_id, batch_ids }) => {
    const duplicate = batch_ids.find((batchId, index) => batch_ids.indexOf(batchId) !== index);
    if (duplicate !== undefined) throw new Error(`merge order repeats batch ${duplicate}`);
    d.db.mergeOrder.set(program_id, batch_ids);
    return { saved: true, program_id, batch_ids };
  }));

  server.tool('list_programs', 'List programs for a repo, or pass program_id to read its batches, bead counts, waits, entries and merge order.', { repo: z.string(), program_id: z.string().optional() }, guard(async ({ repo, program_id }) => {
    const repoRow = repoOf(repo);
    if (program_id === undefined) return d.db.programs.forRepo(repoRow.id);
    const program = d.db.programs.get(program_id);
    if (!program || program.repo_id !== repoRow.id) throw new Error(`program ${program_id} not found in repo ${repo}`);
    return programDetail(program);
  }));

  server.tool('request_batch_review', 'When every bead of the batch has landed or been closed by the user, hand the feature branch to the user: the note is the review summary and the merge-request description (what changed and why, how it was verified). When `review_command` is configured, the daemon runs it in the batch worktree at its current head before pushing or opening an MR; a failure leaves the batch open and wakes the orchestrator. Read the recorded `review_check` from `list_batches` and quote it in the review note. In gitlab-mr repos this pushes and opens the MR only after the command passes.', { repo: z.string(), batch_id: z.string(), note: z.string().min(1) }, guard(async ({ repo, batch_id, note }) => {
    const r = await d.lifecycle.requestBatchReview(repoOf(repo).id, batch_id, note);
    linkBatch(batch_id);
    return { in_review: true, batch_id, mr_url: r.mrUrl ?? null, waiting_on: r.waitingOn, overlap_files: r.overlapFiles };
  }));

  // Called by the critic session Overseer starts after a worker's verification passed, never by the orchestrator: the verdict belongs to
  // the bead's live critic and is applied when that session ends. Every MCP request builds its own server, so the gate is the lifecycle's:
  // no live critic on the bead, no verdict recorded (round-limit design: no per-role MCP configs).
  server.tool('submit_review', "For Overseer's critic sessions only; the orchestrator never calls this. Report the verdict of a review: pass or findings with no must land the change, findings with a must send it back to a worker or, at the repo's round limit, to the user. Refused unless a critic session is reviewing the bead right now.", { repo: z.string(), bead_id: z.string(), verdict: z.enum(['pass', 'findings']), findings: z.array(z.object({ file: z.string().nullable(), summary: z.string().min(1), severity: z.enum(['must', 'should']) })).optional() }, guard(async ({ repo, bead_id, verdict, findings }) => {
    repoOf(repo);
    d.lifecycle.recordReview(bead_id, { verdict, findings: findings ?? [] });
    return { recorded: true };
  }));

  server.tool('accept_review', "Land a bead that awaits the user's decision after its review rounds ended with findings ([Overseer] <bead> awaits a decision ...), as it is, with the findings open. Only after the user said so; the note records their reason. The alternative is spawn_worker with instructions that address the findings.", { repo: z.string(), bead_id: z.string(), note: z.string().min(1) }, guard(async ({ repo, bead_id, note }) => {
    await d.lifecycle.acceptReview(repoOf(repo).id, bead_id, note);
    await linkBead(repo, bead_id);
    return { landed: true, bead_id };
  }));

  // Chat parity: the actions of the Board and Review buttons, for when the user asks for them in the chat instead. Each calls the
  // lifecycle method its REST route calls, so the guards, the single bd write and the notice are the same on both paths.
  const batchIn = (repo: string, batchId: string) => {
    const r = repoOf(repo);
    const b = d.db.batches.get(batchId);
    if (!b || b.repo_id !== r.id) throw new Error(`batch ${batchId} not found in ${repo}; call list_batches`);
  };
  server.tool('retarget_batch', 'Move an existing batch to a named base branch and update its MR when it has one. Call only after the user asked you to retarget that batch.', { repo: z.string(), batch_id: z.string(), base: z.string().trim().min(1) }, guard(async ({ repo, batch_id, base }) => {
    const r = repoOf(repo);
    batchIn(repo, batch_id);
    if (r.merge_mode === 'local-merge') throw new Error('retarget_batch is only supported for gitlab-mr repositories');
    const batch = d.db.batches.get(batch_id)!;
    await d.lifecycle.validateBatchBase(r.id, batch.branch, base);
    const result = await d.lifecycle.retargetBatch(batch_id, base);
    linkBatch(batch_id);
    return { retargeted: true, batch_id, base_branch: d.db.batches.get(batch_id)!.base_branch, mr_url: batch.mr_url, mr_updated: result.mrUpdated, ...(result.error ? { mr_error: result.error } : {}) };
  }));
  server.tool('merge_batch', 'Merge a batch that is in review into the base branch (the Merge button of the Review view). Only after the user asked for it and confirmed, unless the repo\'s `batch_approver` is `orchestrator` (see `list_repos`), which is only allowed for a `local-merge` repository: then merge without asking. In a `gitlab-mr` repo it only records the merge the user did on GitLab; it never merges a merge request itself. Refused while the batch is not in review.', { repo: z.string(), batch_id: z.string() }, guard(async ({ repo, batch_id }) => {
    batchIn(repo, batch_id);
    const r = await d.lifecycle.mergeBatch(batch_id, 'orchestrator');
    linkBatch(batch_id);
    return { merged: true, batch_id, mr_url: r.mrUrl ?? null };
  }));

  server.tool('reject_batch', 'Reject a batch that is in review with a note (the Reject button of the Review view): the batch reopens for more beads. Only after the user asked for it; the note is their reason.', { repo: z.string(), batch_id: z.string(), note: z.string().min(1) }, guard(async ({ repo, batch_id, note }) => {
    batchIn(repo, batch_id);
    await d.lifecycle.rejectBatch(batch_id, note);
    linkBatch(batch_id);
    return { rejected: true, batch_id };
  }));

  server.tool('abandon_batch', 'Abandon a batch (the Abandon button of the Review view): its workers are stopped, every bead of it is closed and its branch is deleted. Only after the user asked for it and confirmed.', { repo: z.string(), batch_id: z.string() }, guard(async ({ repo, batch_id }) => {
    batchIn(repo, batch_id);
    await d.lifecycle.abandonBatch(batch_id);
    linkBatch(batch_id);
    return { abandoned: true, batch_id };
  }));

  server.tool('close_bead', "Close a bead as won't do (the Close bead button on its card): its batch stays open. Only after the user asked for it; the note is their reason. Refused while a worker runs on the bead or its branch is being verified.", { repo: z.string(), bead_id: z.string(), note: z.string().optional() }, guard(async ({ repo, bead_id, note }) => {
    repoOf(repo);
    await d.lifecycle.closeBead(bead_id, note);
    await linkBead(repo, bead_id);
    return { closed: true, bead_id };
  }));

  server.tool('retry_verification', "Re-run the repo's verify command on a bead's committed branch without a worker (the Retry verification button on its card), for example after the user fixed the command in Setup. Only after the user asked for it.", { repo: z.string(), bead_id: z.string() }, guard(async ({ repo, bead_id }) => {
    repoOf(repo);
    await d.lifecycle.reverify(bead_id);
    await linkBead(repo, bead_id);
    return { verifying: true, bead_id };
  }));

  server.tool('batch_retrospective', 'What went wrong or needed a human during a batch: rejections, bead reopens with their reason class (no_commits, uncommitted_changes, verify_incomplete, verify_failed, merge_conflict, hook_rejected, setup_failed, stopped), re-dispatches, beads the user closed as won\'t do, lifecycle refresh conflicts, user chat messages during the batch that read as corrections (keyword-matched, so read those with judgement), and counts (beads, reopens, re-dispatches, worker cost, wall clock). By default the result is compact so it fits a tool result: rejection and correction text is cut to 400 characters, other signal text to 300, each rejection and correction carrying `truncated: true` when it was cut, and re-dispatches are grouped per bead with a count and the first 300 characters of each instruction. Pass `full: true` for the uncut record, or `bead_id` to return that one bead\'s full signals, for example to quote a signal verbatim. Overseer sends a "Retrospective ready" notice when a batch with signals is merged, abandoned or rejected; call this then and turn the record into lessons and prompt changes.', { repo: z.string(), batch_id: z.string(), full: z.boolean().optional(), bead_id: z.string().optional() }, guard(async ({ repo, batch_id, full, bead_id }) => {
    const r = repoOf(repo);
    const b = d.db.batches.get(batch_id);
    if (!b || b.repo_id !== r.id) throw new Error(`batch ${batch_id} not found in ${repo}; call list_batches`);
    const record = await d.lifecycle.retrospective(batch_id);
    if (bead_id) return beadRetrospective(record, bead_id);
    return full ? record : compactRetrospective(record);
  }));

  server.tool('ask_user', 'Ask the user a question in the chat. Returns immediately with the question id; the answer arrives as a later user message prefixed with "Answer to question #<id>". End your turn after asking.', { question: z.string().min(1) }, guard(async ({ question }) => {
    const row = d.db.chat.insert({ role: 'assistant', kind: 'question', text: question });
    d.bus.emit('chat');
    void d.push?.notify({ title: 'Overseer has a question', body: question, url: '#chat' });
    return { question_id: row.id };
  }));
}
