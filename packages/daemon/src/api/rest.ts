import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AccountUsage, BatchDetail, BatchSummary, ChatPage, ChatSendRequest, CostsResponse, DaemonStatus, DeleteRepoResponse, HarnessName, OrchestratorSettings, PreflightReport, ProgramBatchSummary, ProgramDetail, Repo, RepoCommand, StatusResponse, TaskDetail, TierName, TierSettings, UsageResponse } from '@overseer/shared';
import { supportsUltraEffort, TIER_NAMES } from '@overseer/shared';
import type { AppDeps } from '../app';
import { batchSummaries, buildBoard, coalesced, costOf } from './board';
import { usageQuery, usageReport } from './usage';
import { baseWorktreePath, diffAgainstBase, diffRefs, git, removeWorktreeRetry } from '../git/git';
import { LifecycleError, batchWorktreePath, setupLabel, verifyLabel } from '../lifecycle/lifecycle';
import { JobConflictError } from './jobs';
import { PlanConflictError, PlanError } from '../plans/plans';
import { NO_VERIFY_RUN } from '../lifecycle/verify';
import { MergeConflictError } from '../git/provider';
import { TierError } from '../routing/tiers';
import { DiscussionError } from '../discussions/discussions';
import { runDoctor } from '../doctor/doctor';
import { runCapture, spawnLines } from '../util/procs';
import { freshAccountEnv, isOpenCodeProvider } from '../accounts/env';
import { fetchAccountUsage } from '../accounts/usage';
import { accountLoggedIn, clearAuthHold } from '../accounts/status';
import { accountDisplayName } from '../accounts/display';
import { codexArgs } from '../harness/codex';
import { spawnOpencode } from '../harness/opencode';
import { log } from '../util/log';
import { browse, BrowseError } from '../fs/browse';
import { inspectRepo } from '../fs/inspect';
import { blockersOf } from '../beads/store';
import { randomIdSuffix } from '../db/db';
import { listRepoCommands } from './commands';
import { registerEvidenceRoutes } from './evidence';
import { RetryError } from '../orchestrator/orchestrator';


const repoFields = {
  base_branch: z.string().min(1).optional(),
  // An empty command is no command: stored as null, so `verifyLabel` and `runVerify` cannot disagree and a PATCH that clears it
  // this way does not announce a change from "no verify command configured" to itself (fix round 19 review NB-7).
  verify_command: z.string().nullable().optional().transform((v) => (v === '' ? null : v)),
  review_command: z.string().nullable().optional().transform((v) => (v === undefined ? undefined : v?.trim() || null)),
  setup_command: z.string().nullable().optional().transform((v) => (v === '' ? null : v)),
  merge_mode: z.enum(['local-merge', 'gitlab-mr']).optional(),
  batch_approver: z.enum(['user', 'orchestrator']).optional(),
  worker_limit: z.number().int().min(1).max(16).optional(),
  review_rounds: z.number().int().min(0).max(5).optional(),
  model_filter: z.object({
    harnesses: z.array(z.string()),
    models: z.array(z.string()),
    accounts: z.array(z.string()),
  }).strict().nullable().optional(),
};
const repoBody = z.object({
  path: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens only').optional(),
  beads: z.enum(['stealth', 'commit']).optional(),
  ...repoFields,
});
const repoPatch = z.object(repoFields).strict();
const normalizeRepoModelFilter = (
  value: z.infer<typeof repoFields.model_filter>,
  accounts: { id: string; harness: string }[],
): { filter: Repo['model_filter']; error?: string } => {
  if (!value) return { filter: null };
  const uniqueTrimmed = (values: string[]) => [...new Set(values.map((entry) => entry.trim()))];
  const blankModel = value.models.find((model) => !model.trim());
  if (blankModel !== undefined) return { filter: null, error: `model ${JSON.stringify(blankModel)} is blank` };
  const harnesses = uniqueTrimmed(value.harnesses);
  const models = uniqueTrimmed(value.models);
  const accountIds = uniqueTrimmed(value.accounts);
  const knownHarnesses = new Set(['claude', 'codex', 'opencode']);
  const unknownHarness = harnesses.find((harness) => !knownHarnesses.has(harness));
  if (unknownHarness !== undefined) return { filter: null, error: `unknown harness value ${JSON.stringify(unknownHarness)}` };
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const unknownAccount = accountIds.find((id) => !accountsById.has(id));
  if (unknownAccount !== undefined) return { filter: null, error: `unknown account id ${JSON.stringify(unknownAccount)}` };
  if (harnesses.length) {
    const incompatibleAccount = accountIds.map((id) => accountsById.get(id)!).find((account) => !harnesses.includes(account.harness));
    if (incompatibleAccount) return { filter: null, error: `account id ${JSON.stringify(incompatibleAccount.id)} uses harness ${JSON.stringify(incompatibleAccount.harness)}, which is not allowed by harnesses [${harnesses.join(', ')}]` };
  }
  const filter = { harnesses: harnesses as HarnessName[], models, accounts: accountIds };
  return { filter: harnesses.length || models.length || accountIds.length ? filter : null };
};
/** A gitlab-mr repository always approves with the user: the orchestrator value is offered only for local-merge, and never merges a merge request on its own. */
const approverProblem = (merge_mode: Repo['merge_mode'], batch_approver: Repo['batch_approver']): string | null =>
  merge_mode === 'gitlab-mr' && batch_approver === 'orchestrator' ? 'a gitlab-mr repository always approves with the user: the orchestrator never merges a merge request on its own' : null;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const isRawBase64 = (value: string): boolean => /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
const attachmentBody = z.array(z.object({ name: z.string().min(1), mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().min(1) })).max(4, 'at most 4 attachments').optional();
const decodeAttachments = (attachments: z.infer<typeof attachmentBody>) => {
  const decoded: { name: string; mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: Buffer }[] = [];
  for (const a of attachments ?? []) {
    if (!isRawBase64(a.data)) throw new LifecycleError(`attachment ${a.name} data must be raw base64 without a data URL prefix`);
    const data = Buffer.from(a.data, 'base64');
    if (data.length > MAX_ATTACHMENT_BYTES) throw new LifecycleError(`attachment ${a.name} exceeds 8 MB`);
    decoded.push({ ...a, data });
  }
  return decoded;
};

/** True while the bead's worktree is still a git worktree and both its branch and the branch it diffs against exist. */
async function liveWorktree(repoPath: string, wt: { path: string; branch: string; base_branch: string }): Promise<boolean> {
  if (!fs.existsSync(path.join(wt.path, '.git'))) return false;
  const branches = await git(repoPath, ['branch', '--list', wt.branch, wt.base_branch]);
  return branches.split('\n').filter(Boolean).length === 2;
}

export function registerRest(app: FastifyInstance, d: AppDeps): void {
  const commandCache = new Map<string, { expiresAt: number; entries: RepoCommand[] }>();
  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof MergeConflictError) return reply.code(409).send({ error: err.message, conflict_files: err.files });
    if (err instanceof JobConflictError) return reply.code(409).send({ error: err.message, job_id: err.job_id, action: err.action });
    if (err instanceof PlanConflictError) return reply.code(409).send({ error: err.message });
    if (err instanceof PlanError) return reply.code(400).send({ error: err.message });
    if (err instanceof LifecycleError) return reply.code(400).send({ error: err.message });
    if (err instanceof BrowseError) return reply.code(400).send({ error: err.message });
    if (err instanceof TierError) return reply.code(400).send({ error: err.message });
    if (err instanceof DiscussionError) return reply.code(400).send({ error: err.message });
    // Fastify's own logger is off; without this line a 500 leaves no trace in daemon.log (round 11).
    log.error('rest: unhandled error', { method: req.method, url: req.url, error: err.message, stack: err.stack });
    return reply.code(500).send({ error: err.message });
  });

  app.get('/api/health', async () => ({ ok: true }));
  registerEvidenceRoutes(app, d.config.dataDir);

  const accountLabel = z.string().trim().max(40).transform((label) => label || null);
  const accountBody = z.object({ name: z.string().min(1), label: accountLabel.optional(), harness: z.enum(['claude', 'codex', 'opencode']), kind: z.enum(['oauth_token', 'api_key', 'codex_home']), provider: z.string().min(1).optional(), secret: z.string().min(1).optional() }).superRefine((v, ctx) => {
    if (v.harness === 'claude' && v.kind === 'codex_home') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'codex_home requires codex' });
    if (v.harness === 'codex' && v.kind !== 'codex_home') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'codex requires codex_home' });
    if (v.harness === 'opencode' && v.kind !== 'api_key') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'opencode requires api_key' });
    if (v.harness === 'opencode' && !v.provider) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'opencode requires a provider' });
    if (v.harness === 'opencode' && !isOpenCodeProvider(v.provider)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown OpenCode provider: ${v.provider}` });
    if (v.harness !== 'opencode' && v.provider) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provider requires opencode' });
    if (v.kind === 'api_key' && !v.secret) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'api_key requires a secret' });
  });
  app.get('/api/accounts', async () => d.db.accounts.list());
  app.post('/api/accounts', async (req) => {
    const body = accountBody.parse(req.body);
    const id = `a-${randomIdSuffix()}${randomIdSuffix()}`;
    const home = body.kind === 'codex_home' ? path.join(d.config.dataDir, 'accounts', id) : null;
    if (home) {
      fs.mkdirSync(home, { recursive: true });
      const source = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex');
      if (fs.existsSync(path.join(source, 'config.toml'))) fs.copyFileSync(path.join(source, 'config.toml'), path.join(home, 'config.toml'));
      if (fs.existsSync(path.join(source, 'skills'))) fs.cpSync(path.join(source, 'skills'), path.join(home, 'skills'), { recursive: true });
    }
    const account = { id, name: body.name, label: body.label ?? null, harness: body.harness, kind: body.kind, provider: body.provider ?? null, secret: body.secret ?? null, home, created_at: new Date().toISOString(), last_login_at: null, last_verified_at: null };
    d.db.accounts.insert(account);
    return d.db.accounts.list().find((a) => a.id === id)!;
  });
  app.patch<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    const account = d.db.accounts.get(req.params.id);
    if (!account) return reply.code(404).send({ error: `account ${req.params.id} not found` });
    const body = z.object({ name: z.string().min(1).optional(), label: accountLabel.optional(), provider: z.string().min(1).optional(), secret: z.string().min(1).optional() }).superRefine((v, ctx) => {
      if (v.provider && account.harness !== 'opencode') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provider requires opencode' });
      if (v.provider && !isOpenCodeProvider(v.provider)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown OpenCode provider: ${v.provider}` });
    }).parse(req.body);
    if (!Object.keys(body).length) return reply.code(400).send({ error: 'nothing to update' });
    d.db.accounts.update(req.params.id, body);
    return d.db.accounts.list().find((a) => a.id === req.params.id)!;
  });
  app.post<{ Params: { id: string } }>('/api/accounts/:id/login', async (req, reply) => {
    const account = d.db.accounts.get(req.params.id);
    if (!account) return reply.code(404).send({ error: `account ${req.params.id} not found` });
    try { return d.logins.start(account); } catch (err) {
      const error = err as Error;
      if (error.message === 'login already pending') return reply.code(409).send({ error: error.message });
      log.error(`rest: account login start failed for ${account.id}`, error);
      return reply.code(500).send({ error: error.message });
    }
  });
  app.get<{ Params: { id: string } }>('/api/accounts/:id/login', async (req, reply) => {
    if (!d.db.accounts.get(req.params.id)) return reply.code(404).send({ error: `account ${req.params.id} not found` });
    return d.logins.get(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/accounts/:id/login/code', async (req, reply) => {
    const account = d.db.accounts.get(req.params.id);
    if (!account) return reply.code(404).send({ error: `account ${req.params.id} not found` });
    const { code } = z.object({ code: z.string().min(1) }).parse(req.body);
    try { return await d.logins.submitCode(account, code); } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });
  app.delete<{ Params: { id: string } }>('/api/accounts/:id/login', async (req, reply) => {
    if (!d.db.accounts.get(req.params.id)) return reply.code(404).send({ error: `account ${req.params.id} not found` });
    return d.logins.cancel(req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    const account = d.db.accounts.get(req.params.id);
    if (!account) return reply.code(404).send({ error: `account ${req.params.id} not found` });
    const tierRef = d.db.settings.tiers().tiers.some((t) => t.candidates.some((c) => c.account === account.id));
    const orchRef = d.db.settings.orchestrator().account === account.id;
    if (tierRef || orchRef) return reply.code(409).send({ error: `account ${account.id} is referenced by settings` });
    // A pending device-auth child would otherwise outlive its CODEX_HOME and recreate files under it.
    await d.logins.drop(account.id);
    if (account.home && fs.existsSync(account.home)) fs.rmSync(account.home, { recursive: true, force: true });
    d.db.accounts.remove(account.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/accounts/:id/usage', async (req, reply): Promise<AccountUsage | null> => {
    if (!d.db.accounts.get(req.params.id)) return reply.code(404).send({ error: `account ${req.params.id} not found` }) as never;
    return fetchAccountUsage(d.db, d.config, req.params.id, d.doctorRunner);
  });
  app.post<{ Params: { id: string } }>('/api/accounts/:id/verify', async (req, reply) => {
    const account = d.db.accounts.get(req.params.id);
    if (!account) return reply.code(404).send({ error: `account ${req.params.id} not found` });
    // Without its own credentials the harness would run on the machine login, exit 0 and mark the account verified (round 2 review).
    if (!accountLoggedIn(account)) return reply.code(400).send({ error: `account ${accountDisplayName(account)} is not logged in` });
    let env: NodeJS.ProcessEnv;
    try { env = await freshAccountEnv(d.db, d.config, account); }
    catch (err) { return reply.code(400).send({ error: `account ${accountDisplayName(account)} is not logged in: ${(err as Error).message}` }); }
    const cwd = fs.mkdtempSync(path.join(d.config.dataDir, 'verify-'));
    const candidate = d.db.settings.tiers().tiers.flatMap((t) => t.candidates).find((c) => c.harness === account.harness);
    const args = account.harness === 'claude'
      ? ['-p', 'reply with ok', '--max-turns', '1', '--output-format', 'json', ...(candidate?.model ? ['--model', candidate.model] : [])]
      : account.harness === 'codex' ? codexArgs(cwd, null, { model: candidate?.model })
        : null;
    const bin = account.harness === 'claude' ? d.config.claudeBin : d.config.codexBin;
    const p = args ? spawnLines(bin, args, { cwd, env }) : spawnOpencode(d.config.opencodeBin, cwd, null, 'reply with ok', { model: candidate?.model, effort: candidate?.effort ?? undefined, env });
    if (account.harness === 'codex') p.stdin?.end('ok');
    const lines: string[] = [];
    void (async () => { for await (const line of p.lines) lines.push(line); })();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<number>((resolve) => { timer = setTimeout(() => { timedOut = true; p.child?.kill(); resolve(-1); }, 20_000); });
    const code = await Promise.race([p.exit, timeout]);
    if (timer) clearTimeout(timer);
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* A timed-out Windows child may briefly retain the cwd. */ }
    if (code === 0) { d.db.accounts.update(account.id, { last_verified_at: new Date().toISOString(), ...clearAuthHold(account) }); return { ok: true }; }
    const stderr = String((p.child as { stderrText?: string }).stderrText ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1);
    return { ok: false, error: stderr ?? lines.at(-1) ?? (timedOut ? 'did not finish within 20 seconds' : `exited with code ${code}`) };
  });

  app.get('/api/daemon', async (): Promise<DaemonStatus> => {
    const source_head = await d.daemon.sourceHead();
    return {
      pid: d.daemon.pid,
      started_at: d.daemon.startedAt,
      commit: d.daemon.commit,
      source_head,
      restart_needed: d.daemon.commit !== null && source_head !== null && d.daemon.commit !== source_head,
      restart_in_progress: d.daemon.restarting,
      restart_failure: d.daemon.restartFailure ?? null,
      data_dir: d.config.dataDir,
      source_root: d.daemon.sourceRoot,
    };
  });

  app.post('/api/daemon/restart', async (_req, reply) => {
    if (d.daemon.restarting) return reply.code(409).send({ error: 'daemon restart already in progress' });
    d.daemon.restarting = true;
    reply.code(202).send({ ok: true, pid: d.daemon.pid });
    setImmediate(() => {
      void Promise.resolve().then(() => d.daemon.relaunch()).then(() => {
        d.daemon.restartFailure = null;
      }).catch((error) => {
        const reported = error && typeof error === 'object' ? error as { restartFailure?: { reason?: unknown; output?: unknown } } : undefined;
        const reason = typeof reported?.restartFailure?.reason === 'string'
          ? reported.restartFailure.reason
          : error instanceof Error ? error.message : String(error);
        const output = Array.isArray(reported?.restartFailure?.output)
          ? reported.restartFailure.output.filter((line): line is string => typeof line === 'string').slice(-20)
          : [];
        d.daemon.restartFailure = { reason, output };
        d.daemon.restarting = false;
        log.error('overseer daemon restart failed; the current daemon remains online', error);
        void d.orchestrator.systemMessage(`Daemon restart failed: ${reason}`, { wake: true, hint: 'Check Setup → General → Daemon for the command output.' })
          .catch((noticeError) => log.error('daemon restart failure notice could not be sent', noticeError));
      }).finally(() => { d.daemon.restarting = false; });
    });
    return reply;
  });

  app.get('/api/doctor', async () => runDoctor(d.config, d.doctorRunner ?? runCapture));

  app.get('/api/repos', async () => d.db.repos.all());

  app.get('/api/programs', async (req) => {
    const { repo } = z.object({ repo: z.string().min(1).optional() }).parse(req.query);
    return repo ? d.db.programs.forRepo(repo) : d.db.programs.all();
  });

  app.get<{ Params: { id: string } }>('/api/programs/:id', async (req, reply): Promise<ProgramDetail | void> => {
    const program = d.db.programs.get(req.params.id);
    if (!program) return reply.code(404).send({ error: `program ${req.params.id} not found` });
    const memberships = d.db.programBatches.forProgram(program.id);
    let summaryRows: BatchSummary[] = [];
    const repo = memberships.length ? d.db.repos.get(program.repo_id) : undefined;
    if (repo && await d.store.available()) summaryRows = batchSummaries(d.db, repo.id, await d.store.list(repo.path));
    const summaries = new Map<string, BatchSummary>();
    summaryRows.forEach((summary) => summaries.set(summary.id, summary));
    const batches: ProgramBatchSummary[] = memberships.map((membership) => {
      const batch = d.db.batches.get(membership.batch_id);
      const summary = summaries.get(membership.batch_id);
      return {
        ...membership,
        title: batch?.title ?? null,
        status: batch?.status ?? null,
        beads_total: summary?.beads_total ?? 0,
        beads_done: summary?.beads_done ?? 0,
        beads_closed: summary?.beads_closed ?? 0,
      };
    });
    return {
      ...program,
      batches,
      waits: d.db.batchWaits.forProgram(program.id),
      entries: d.db.programEntries.forProgram(program.id),
      merge_order: d.db.mergeOrder.forProgram(program.id),
    };
  });

  app.get<{ Params: { id: string } }>('/api/repos/:id/commands', async (req, reply): Promise<RepoCommand[] | void> => {
    const repo = d.db.repos.get(req.params.id);
    if (!repo) return reply.code(404).send({ error: `repo ${req.params.id} not found` });
    const cached = commandCache.get(repo.id);
    const requestedAt = Date.now();
    if (cached && cached.expiresAt > requestedAt) return cached.entries;
    const entries = listRepoCommands(repo.path, os.homedir());
    commandCache.set(repo.id, { expiresAt: Date.now() + 30_000, entries });
    return entries;
  });

  app.get('/api/fs/browse', async (req) => {
    const { path: p } = z.object({ path: z.string().optional() }).parse(req.query);
    return browse(p || undefined);
  });

  app.post('/api/repos/inspect', async (req) => {
    const { path: p } = z.object({ path: z.string().min(1) }).parse(req.body);
    return inspectRepo(p, d.db.repos.all());
  });

  app.post('/api/repos', async (req, reply) => {
    const b = repoBody.parse(req.body);
    const modelFilter = normalizeRepoModelFilter(b.model_filter, d.db.accounts.list());
    if (modelFilter.error) return reply.code(400).send({ error: modelFilter.error });
    const info = await inspectRepo(b.path, d.db.repos.all());
    if (info.problems.length) return reply.code(400).send({ error: info.problems.join('; ') });
    const id = b.id ?? info.suggested_id;
    if (d.db.repos.get(id)) return reply.code(409).send({ error: `repo ${id} already registered` });
    const mergeMode = b.merge_mode ?? 'local-merge';
    const approver = b.batch_approver ?? 'user';
    const problem = approverProblem(mergeMode, approver);
    if (problem) return reply.code(400).send({ error: problem });
    if (!info.has_beads) {
      try { await d.store.init(info.path, id, b.beads ?? 'stealth'); }
      catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    }
    const repo: Repo = { id, path: info.path, base_branch: b.base_branch ?? info.branch ?? 'HEAD', verify_command: b.verify_command ?? null, review_command: b.review_command ?? null, setup_command: b.setup_command ?? null, merge_mode: mergeMode, batch_approver: approver, worker_limit: b.worker_limit ?? 2, review_rounds: 2, model_filter: modelFilter.filter };
    d.db.repos.insert(repo);
    d.bus.emit('repos');
    d.bus.emit('board');
    if (repo.verify_command) void d.prober.probe(repo.id);
    return repo;
  });

  app.patch<{ Params: { id: string } }>('/api/repos/:id', async (req, reply) => {
    const p = repoPatch.parse(req.body ?? {});
    if (Object.keys(p).length === 0) return reply.code(400).send({ error: 'nothing to update' });
    const before = d.db.repos.get(req.params.id);
    if (!before) return reply.code(404).send({ error: `repo ${req.params.id} not found` });
    const patch = { ...p } as Partial<Repo>;
    if ('model_filter' in p) {
      const modelFilter = normalizeRepoModelFilter(p.model_filter, d.db.accounts.list());
      if (modelFilter.error) return reply.code(400).send({ error: modelFilter.error });
      patch.model_filter = modelFilter.filter;
    }
    // Validated against the state the patch leaves behind, so flipping merge_mode to gitlab-mr on an orchestrator row is refused
    // unless the same patch also sets the approver back to user.
    const problem = approverProblem(p.merge_mode ?? before.merge_mode, p.batch_approver ?? before.batch_approver);
    if (problem) return reply.code(400).send({ error: problem });
    d.db.repos.update(req.params.id, patch);
    d.bus.emit('repos');
    d.bus.emit('board');
    const after = d.db.repos.get(req.params.id)!;
    // The repo configuration travels with the session preamble, so a live orchestrator keeps announcing the command it was told
    // about: it narrated the old one while the daemon ran the new one (round 19). Informational, so it queues without a session.
    if (after.verify_command !== before.verify_command) {
      // Verification reads the repo row when the worker ends, so the bead of a worker running now is verified with the new command:
      // "Running workers keep the settings they started with" alone invited the orchestrator to say the opposite (fix round 19 review NB-3).
      const next = after.verify_command
        ? 'the next verification uses the new command, including the one that runs when a worker running now ends'
        : 'nothing is verified from now on, including when a worker running now ends';
      await d.orchestrator.systemMessage(`Repository ${after.id} now has ${verifyLabel(after)} (was ${verifyLabel(before)}), changed by the user in Setup. Running workers keep the prompt and settings they started with; ${next}.`)
        .catch((err) => log.error('rest: verify-command-changed notify failed', err));
    }
    if (after.setup_command !== before.setup_command) {
      await d.orchestrator.systemMessage(`Repository ${after.id} now has ${setupLabel(after)} (was ${setupLabel(before)}), changed by the user in Setup. It runs in every bead and batch worktree created from now on, and in an open batch's worktree before its next merge if it has not run there yet.`)
        .catch((err) => log.error('rest: setup-command-changed notify failed', err));
    }
    if (after.review_command !== before.review_command) {
      const label = (command: string | null | undefined) => command ? `review command \`${command}\`` : 'no review command configured';
      await d.orchestrator.systemMessage(`Repository ${after.id} now has ${label(after.review_command)} (was ${label(before.review_command)}), changed by the user in Setup. The daemon uses it before the next batch review request.`)
        .catch((err) => log.error('rest: review-command-changed notify failed', err));
    }
    if (after.verify_command !== before.verify_command || after.setup_command !== before.setup_command) void d.prober.probe(after.id);
    return after;
  });

  app.post<{ Params: { id: string } }>('/api/repos/:id/probe', async (req, reply) => {
    if (!d.db.repos.get(req.params.id)) return reply.code(404).send({ error: `repo ${req.params.id} not found` });
    void d.prober.probe(req.params.id);
    return reply.code(202).send({ started: true });
  });

  app.get<{ Params: { id: string } }>('/api/repos/:id/preflight', async (req, reply): Promise<PreflightReport | void> => {
    if (!d.db.repos.get(req.params.id)) return reply.code(404).send({ error: `repo ${req.params.id} not found` });
    return { runs: d.db.preflight.recent(req.params.id, 20), crashes: d.db.preflight.crashCounts(req.params.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/repos/:id', async (req, reply) => {
    const id = req.params.id;
    const repo = d.db.repos.get(id);
    if (!repo) return reply.code(404).send({ error: `repo ${id} not found` });
    const running = d.db.sessions.running().filter((s) => s.repo_id === id && s.role !== 'discussion');
    if (running.length) return reply.code(409).send({ error: `repo ${id} has running sessions`, sessions: running.map((s) => s.id) });
    // Overseer's worktrees and rows go; the branches stay in the user's repository, whatever their state: a batch in review or an
    // open bead may carry commits that landed nowhere else (round 8: Remove deleted a reviewed, unmerged branch).
    const warnings: string[] = [];
    const kept: string[] = [];
    // A running discussion of the repo is ended and its detached checkouts removed while the repo row still names the path.
    await d.discussions.stopForRepo(id, 'repository removed');
    // Every discussion of the repo keeps its participants and their final cost once its session rows go with the repo.
    d.discussions.snapshotForRepo(id);
    const keep = async (branch: string) => { if (await git(repo.path, ['branch', '--list', branch])) kept.push(branch); };
    for (const wt of d.db.worktrees.forRepo(id)) {
      try { await removeWorktreeRetry(repo.path, wt.path, null); }
      catch (e) { warnings.push(`${wt.bead_id}: ${(e as Error).message}`); }
      await keep(wt.branch);
      d.db.worktrees.delete(wt.bead_id);
    }
    const batches = d.db.batches.forRepo(id);
    for (const b of batches) {
      try { await removeWorktreeRetry(repo.path, batchWorktreePath(d.config.worktreesDir, id, b.id), null); }
      catch (e) { warnings.push(`${b.id}: ${(e as Error).message}`); }
      await keep(b.branch);
      d.db.batches.delete(b.id);
    }
    try { await removeWorktreeRetry(repo.path, baseWorktreePath(d.config.worktreesDir, repo.id), null); }
    catch (e) { warnings.push(`base: ${(e as Error).message}`); }
    // The worker sessions of the repo are task records too, and the rail sums them per repo: without this the same path added again
    // read "≥ $1.48" with no batch on the board, the whole spend of the registration the dialog said it had deleted (round 20 R20-4).
    d.db.sessions.deleteForRepo(id);
    d.db.repos.delete(id);
    d.bus.emit('repos');
    d.bus.emit('board');
    // A live orchestrator session still has the repo in its preamble; informational, so it queues without a session.
    // Each unfinished batch with its real status word (round 14: a batch in review was called "open").
    const open = batches.filter((b) => b.status === 'open' || b.status === 'review');
    const named = open.map((b) => `${b.id} (${b.status === 'review' ? 'in review' : 'in progress'}, ${b.branch})`).join(', ');
    const dropped = open.length === 0 ? '' : `; its unfinished ${open.length === 1 ? 'batch was' : 'batches were'} dropped: ${named}; the ${open.length === 1 ? 'branch stays' : 'branches stay'} in the repository`;
    await d.orchestrator.systemMessage(`Repository ${id} removed from Overseer by the user${dropped}.`).catch((err) => log.error('rest: repo-removed notify failed', err));
    const out: DeleteRepoResponse = { ok: true, warnings, kept_branches: kept };
    return out;
  });

  let boardChanges = 0;
  d.bus.on('board', () => { boardChanges++; });
  const board = coalesced(() => buildBoard(d.db, d.store, d.jobs), () => boardChanges);
  app.get('/api/board', async () => board());

  app.get('/api/status', async (): Promise<StatusResponse> => ({ bd_ok: await d.store.available(), orchestrator: d.orchestrator.status() }));

  app.post('/api/orchestrator/reset', async () => { await d.orchestrator.reset(); return { ok: true }; });

  app.get('/api/settings/orchestrator', async (): Promise<OrchestratorSettings> => ({ ...d.db.settings.orchestrator(), usageThresholdPercent: d.config.usageThresholdPercent }));

  const orchestratorSettingsBody = z.object({ model: z.string().nullable(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable(), promptOverride: z.string().nullable(), account: z.string().nullable().optional() });
  app.put('/api/settings/orchestrator', async (req, reply) => {
    const body: OrchestratorSettings = orchestratorSettingsBody.parse(req.body);
    if (body.account && !d.db.accounts.get(body.account)) return reply.code(400).send({ error: `unknown account ${body.account}` });
    if (body.account && d.db.accounts.get(body.account)!.harness !== 'claude') return reply.code(400).send({ error: `account ${body.account} does not match claude` });
    if (body.account && !accountLoggedIn(d.db.accounts.get(body.account)!)) return reply.code(400).send({ error: `account ${accountDisplayName(d.db.accounts.get(body.account)!)} is not logged in` });
    d.db.settings.set('orchestrator', body);
    return { ...body, applies_to: 'next-session' };
  });

  // Notification preferences; the question/review/decision pushes are always sent, this only adds the orchestrator's replies.
  app.get('/api/settings/push', async () => ({ on_reply: d.db.settings.pushOnReply() }));
  app.put('/api/settings/push', async (req) => {
    const body = z.object({ on_reply: z.boolean() }).parse(req.body);
    d.db.settings.set('push_on_reply', body.on_reply);
    return body;
  });

  app.get('/api/settings/tiers', async () => d.db.settings.tiers());

  // Web push: the public key the browser subscribes with, and the subscription it hands back. Sends happen in the daemon (push/push.ts).
  app.get('/api/push/key', async () => ({ key: d.push?.publicKey() ?? null, subscriptions: d.push?.count() ?? 0 }));
  const subscriptionBody = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) });
  app.post('/api/push/subscriptions', async (req, reply) => { d.push?.subscribe(subscriptionBody.parse(req.body)); return reply.code(204).send(); });
  // A test notification to every subscribed device, so a subscription can be checked from Setup without waiting for a real event.
  // The one send that is awaited: the answer carries one result per device so Setup can show which subscription failed and why.
  app.post('/api/push/test', async () => ({ results: (await d.push?.notify({ title: 'Overseer test notification', body: 'Push works on this device.', url: '#setup' })) ?? [] }));
  app.delete('/api/push/subscriptions', async (req, reply) => { d.push?.unsubscribe(z.object({ endpoint: z.string() }).parse(req.body).endpoint); return reply.code(204).send(); });

  // The worker tiers and `critic` must be present; `critic-chore` (a cheaper critic for chore beads) is optional and its
  // absence is a valid settings row, so it is accepted but not required.
  const REQUIRED_TIERS: TierName[] = ['chore', 'standard', 'hard', 'critic'];
  const tierCandidateBody = z.object({ harness: z.enum(['claude', 'codex', 'opencode']), model: z.string().min(1), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable(), account: z.string().nullable().optional() });
  const tierBody = z.object({ name: z.enum(TIER_NAMES), candidates: z.array(tierCandidateBody) });
  const tierSettingsBody = z.object({ tiers: z.array(tierBody), denyModels: z.array(z.string()) });
  app.put('/api/settings/tiers', async (req, reply) => {
    const body: TierSettings = tierSettingsBody.parse(req.body);
    const names = body.tiers.map((t) => t.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return reply.code(400).send({ error: `duplicate tier: ${dup}` });
    const missing = REQUIRED_TIERS.filter((n) => !names.includes(n));
    if (missing.length) return reply.code(400).send({ error: `missing tier(s): ${missing.join(', ')}` });
    const empty = body.tiers.filter((t) => t.candidates.length === 0).map((t) => t.name);
    if (empty.length) return reply.code(400).send({ error: `tier(s) with no candidates: ${empty.join(', ')}` });
    for (const t of body.tiers) {
      for (const c of t.candidates) {
        if (c.effort === 'ultra' && !supportsUltraEffort(c.harness, c.model)) return reply.code(400).send({ error: `${t.name} ${c.harness} candidate "${c.model}" does not support ultra` });
        if (c.account && !d.db.accounts.get(c.account)) return reply.code(400).send({ error: `unknown account ${c.account}` });
        if (c.account && d.db.accounts.get(c.account)!.harness !== c.harness) return reply.code(400).send({ error: `account ${c.account} does not match ${c.harness}` });
        if (c.account && !accountLoggedIn(d.db.accounts.get(c.account)!)) return reply.code(400).send({ error: `account ${accountDisplayName(d.db.accounts.get(c.account)!)} is not logged in` });
        if (body.denyModels.includes(c.model)) return reply.code(400).send({ error: `${c.model} is denied and cannot be used in tier ${t.name}` });
      }
    }
    d.db.settings.set('tiers', body);
    return { ...body, applies_to: 'next-session' };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const beadId = req.params.id;
    const wt = d.db.worktrees.get(beadId) ?? null;
    // The worktree row names the repo; a never-dispatched bead is looked for first in the repo whose id prefixes its bead id (bd's
    // prefix is the repo id when Overseer initialised beads), then in the others (round 15: the probe stopped at the first repo).
    const all = d.db.repos.all();
    const candidates = wt ? [d.db.repos.get(wt.repo_id)!] : [...all.filter((r) => beadId.startsWith(`${r.id}-`)), ...all.filter((r) => !beadId.startsWith(`${r.id}-`))];
    for (const repo of candidates) {
      const bead = await d.store.show(repo.path, beadId);
      if (!bead) continue;
      const sessions = d.db.sessions.forBead(beadId);
      const last = sessions[sessions.length - 1];
      // One extra bd read, and only for a bead that can be waiting: `bd list` carries the count alone, and the pane names the beads
      // (round 25 R25-4). A bd hiccup on it leaves the pane counting them, as it did before, instead of failing the whole detail.
      const blocked_by = bead.status === 'open' && bead.dependency_count > 0
        ? await d.store.blocked(repo.path).then((b) => blockersOf(b, beadId)).catch((err: unknown) => { log.error('rest: bd blocked failed for a task detail', err); return []; })
        : [];
      const detail: TaskDetail = {
        bead, repo, blocked_by, sessions, worktree: wt,
        last_assistant_text: last ? d.sessions.status(last.id).lastText : null,
        // Against the branch the bead was cut from (the batch branch for a batch bead), so the diff is this bead's own work.
        // A merged batch leaves the folder behind now and then (Windows holds a lock on it) after git forgot the worktree and
        // both branches went, so the folder alone proves nothing: its .git link and the branches have to be there too.
        diff: wt && await liveWorktree(repo.path, wt) ? await diffAgainstBase(wt.path, wt.base_branch) : null,
      };
      return detail;
    }
    return reply.code(404).send({ error: `task ${beadId} not found in any repo` });
  });

  // The action endpoints below answer 202 the moment their cheap checks pass, then run the lifecycle call as a
  // background job: one per target, reported on the target's board row and by an `action_result` socket message when
  // it ends. The checks here use only the daemon's rows and the filesystem — any bd or git work the action needs
  // happens inside the job and, if it refuses, travels as the result's `ok: false` message.
  const worktreeOf = (beadId: string) => {
    const wt = d.db.worktrees.get(beadId);
    if (!wt) throw new LifecycleError(`no worktree for ${beadId}`);
    return wt;
  };
  const batchOf = (batchId: string) => {
    const batch = d.db.batches.get(batchId);
    if (!batch) throw new LifecycleError(`batch ${batchId} not found`);
    return batch;
  };
  const batchInReview = (batchId: string) => {
    const batch = batchOf(batchId);
    if (batch.status !== 'review') throw new LifecycleError(`batch ${batchId} is not in review`);
    return batch;
  };
  const accept = (kind: 'bead' | 'batch', id: string, action: string, fn: () => Promise<unknown>, reply: FastifyReply) => {
    const job = d.jobs.start(kind, id, action, fn);
    return reply.code(202).send({ job_id: job.job_id, action: job.action, target: job.target });
  };

  app.post<{ Params: { id: string } }>('/api/tasks/:id/merge', async (req, reply) => {
    d.jobs.assertIdle('bead', req.params.id);
    worktreeOf(req.params.id);
    return accept('bead', req.params.id, 'merge', async () => ({ mr_url: (await d.lifecycle.merge(req.params.id)).mrUrl ?? null }), reply);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/reject', { bodyLimit: 48 * 1024 * 1024 }, async (req, reply) => {
    d.jobs.assertIdle('bead', req.params.id);
    const { note, attachments } = z.object({ note: z.string().min(1), attachments: attachmentBody }).parse(req.body ?? {});
    const decoded = decodeAttachments(attachments);
    worktreeOf(req.params.id);
    return accept('bead', req.params.id, 'reject', async () => { await d.lifecycle.reject(req.params.id, note, decoded); return null; }, reply);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/interrupt', async (req, reply) => {
    d.jobs.assertIdle('bead', req.params.id);
    const id = req.params.id;
    if (!d.db.sessions.forBead(id).some((s) => s.status === 'running')) throw new LifecycleError(`no running worker for ${id}`);
    return accept('bead', id, 'interrupt', async () => { await d.lifecycle.interruptBead(id); return null; }, reply);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/verify', async (req, reply) => {
    d.jobs.assertIdle('bead', req.params.id);
    const id = req.params.id;
    const wt = worktreeOf(id);
    if (!fs.existsSync(wt.path)) throw new LifecycleError(`the worktree of ${id} is gone; re-dispatch it instead`);
    // `reverify` reads this from the DB alone, so the refusal is the request's, not a job's `ok: false`.
    const batch = wt.batch_id ? d.db.batches.get(wt.batch_id) : null;
    if (wt.batch_id && batch?.status !== 'open') throw new LifecycleError(`batch ${wt.batch_id} is ${batch?.status ?? 'missing'}`);
    if (d.db.sessions.forBead(id).some((s) => s.status === 'running')) throw new LifecycleError(`bead ${id} has a running worker`);
    return accept('bead', id, 'verify', async () => {
      // The job follows the verify run itself, which outlives `reverify`: a failed verification is the job's failure.
      const failure = await (await d.lifecycle.reverify(id)).done;
      if (failure !== null) throw new Error(failure);
      return null;
    }, reply);
  });

  /** Close bead on the card: the bead is closed as won't do with an optional note for the orchestrator; its batch stays open. */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/close', async (req, reply) => {
    d.jobs.assertIdle('bead', req.params.id);
    const { note } = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    const id = req.params.id;
    // Whether the bead exists and its status are bd reads; a running session is the one refusal answered here.
    if (d.db.sessions.forBead(id).some((s) => s.status === 'running')) throw new LifecycleError(`bead ${id} is busy: a worker runs on it or its branch is being verified, integrated or removed`);
    return accept('bead', id, 'close', async () => { await d.lifecycle.closeBead(id, note); return null; }, reply);
  });

  /** Retry close on a `landed_unclosed` card: the bead landed on its batch branch, bd failed to record it; close it in bd now. */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/close-landed', async (req, reply) => {
    d.jobs.assertIdle('bead', req.params.id);
    const id = req.params.id;
    const wt = d.db.worktrees.get(id);
    if (!wt?.merged_at || !wt.batch_id) throw new LifecycleError(`${id} has not landed on a batch branch`);
    if (!d.db.batches.get(wt.batch_id) || !d.db.repos.get(wt.repo_id)) throw new LifecycleError(`batch ${wt.batch_id} not found`);
    const batch = d.db.batches.get(wt.batch_id)!;
    if (batch.status !== 'open') throw new LifecycleError(`batch ${batch.id} is ${batch.status}`);
    return accept('bead', id, 'close-landed', async () => { await d.lifecycle.closeLanded(id); return null; }, reply);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/redispatch', async (req, reply) => {
    d.jobs.assertIdle('bead', req.params.id);
    worktreeOf(req.params.id);
    return accept('bead', req.params.id, 'redispatch', async () => ({ session_id: await d.lifecycle.redispatch(req.params.id) }), reply);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/accept-review', async (req, reply) => {
    d.jobs.assertIdle('bead', req.params.id);
    const { note } = z.object({ note: z.string() }).parse(req.body ?? {});
    const beadId = req.params.id;
    const wt = d.db.worktrees.get(beadId);
    if (!wt) return reply.code(404).send({ error: `task ${beadId} not found` });
    if (!wt.review_findings) throw new LifecycleError(`${beadId} has no open review findings to accept`);
    if (!fs.existsSync(wt.path)) throw new LifecycleError(`the worktree of ${beadId} is gone; re-dispatch it instead`);
    if (d.db.sessions.forBead(beadId).some((s) => s.status === 'running')) throw new LifecycleError(`bead ${beadId} has a running session`);
    return accept('bead', beadId, 'accept-review', async () => { await d.lifecycle.acceptReview(wt.repo_id, beadId, note); return null; }, reply);
  });

  app.get<{ Params: { id: string } }>('/api/batches/:id', async (req, reply) => {
    const batch = d.db.batches.get(req.params.id);
    if (!batch) return reply.code(404).send({ error: `batch ${req.params.id} not found` });
    const repo = d.db.repos.get(batch.repo_id)!;
    const b = await board();
    const cards = b.repos.find((r) => r.repo.id === repo.id)?.cards.filter((c) => c.batch_id === batch.id) ?? [];
    const summary = b.repos.find((r) => r.repo.id === repo.id)?.batches.find((b) => b.id === batch.id);
    // No diff for a gitlab-mr batch once its MR exists: GitLab shows it, and `git diff` on a large branch is the slow part of this route.
    const diff = batch.status === 'merged' || batch.status === 'abandoned' || (repo.merge_mode === 'gitlab-mr' && batch.mr_url) ? null : await diffRefs(repo.path, batch.base_branch, batch.branch).catch(() => null);
    // What each landed bead's own run recorded, so a verify command cleared later does not relabel the header "not run" (fix round 8 review).
    const landedVerified = d.db.worktrees.forBatch(batch.id).filter((w) => w.merged_at && w.verify_status === 'pass' && w.verify_output !== NO_VERIFY_RUN).length;
    const detail: BatchDetail = { batch, repo, beads: cards, diff, cost: summary?.cost ?? 0, cost_unknown: summary?.cost_unknown ?? 0, landed_verified: landedVerified };
    return detail;
  });

  app.get<{ Params: { id: string } }>('/api/batches/:id/retrospective', async (req) => d.lifecycle.retrospective(req.params.id));

  app.post<{ Params: { id: string } }>('/api/batches/:id/merge', async (req, reply) => {
    d.jobs.assertIdle('batch', req.params.id);
    const id = req.params.id;
    const batch = batchInReview(id);
    if (batch.waiting_on) throw new LifecycleError(`batch ${id} is waiting on ${batch.waiting_on}: both change ${(batch.overlap_files ?? []).join(', ')}`);
    return accept('batch', id, 'merge', async () => ({ mr_url: (await d.lifecycle.mergeBatch(id)).mrUrl ?? null }), reply);
  });
  app.post<{ Params: { id: string } }>('/api/batches/:id/reject', { bodyLimit: 48 * 1024 * 1024 }, async (req, reply) => {
    d.jobs.assertIdle('batch', req.params.id);
    const { note, attachments } = z.object({ note: z.string().min(1), attachments: attachmentBody }).parse(req.body ?? {});
    const decoded = decodeAttachments(attachments);
    batchInReview(req.params.id);
    return accept('batch', req.params.id, 'reject', async () => { await d.lifecycle.rejectBatch(req.params.id, note, decoded); return null; }, reply);
  });
  app.post<{ Params: { id: string } }>('/api/batches/:id/abandon', async (req, reply) => {
    d.jobs.assertIdle('batch', req.params.id);
    const id = req.params.id;
    const batch = batchOf(id);
    if (batch.status === 'merged' || batch.status === 'abandoned') throw new LifecycleError(`batch ${id} is ${batch.status}`);
    return accept('batch', id, 'abandon', async () => { await d.lifecycle.abandonBatch(id); return null; }, reply);
  });

  const planSteps = z.array(z.object({ title: z.string(), description: z.string(), dependsOn: z.array(z.number()) }));
  app.get('/api/plans', async () => d.plans.drafts());
  app.get('/api/plans/all', async () => d.plans.all());
  app.get<{ Params: { id: string } }>('/api/plans/:id', async (req) => d.plans.get(req.params.id));
  app.put<{ Params: { id: string } }>('/api/plans/:id', async (req) => {
    const body = z.object({ title: z.string(), steps: planSteps, revision: z.number().int() }).parse(req.body ?? {});
    return d.plans.save(req.params.id, body);
  });
  app.post<{ Params: { id: string } }>('/api/plans/:id/approve', async (req) => {
    const { revision } = z.object({ revision: z.number().int() }).parse(req.body ?? {});
    return d.plans.approve(req.params.id, revision);
  });
  app.post<{ Params: { id: string } }>('/api/plans/:id/discard', async (req) => d.plans.discard(req.params.id));

  // Discussions: one question, up to three participants on the standard tier's model for their own harness. Each runs
  // read-only in its own throwaway worktree; the web refetches on the `discussion` socket ping.
  const discussionBody = z.object({
    question: z.string(),
    repo_id: z.string().min(1).nullable().optional(),
    participants: z.array(z.enum(['claude', 'codex', 'opencode'])).max(3).optional(),
    cost_cap: z.number().positive().optional(),
    attachments: attachmentBody,
  }).strict();
  app.get('/api/discussions', async () => d.discussions.list());
  app.get<{ Params: { id: string } }>('/api/discussions/:id', async (req, reply) => {
    const detail = d.discussions.detail(req.params.id);
    if (!detail) return reply.code(404).send({ error: `discussion ${req.params.id} not found` });
    return detail;
  });
  app.get<{ Params: { id: string; index: string } }>('/api/discussions/:id/attachments/:index', async (req, reply) => {
    const a = d.db.discussions.attachment(req.params.id, Number(req.params.index));
    if (!a || !fs.existsSync(a.path)) return reply.code(404).send({ error: 'attachment not found' });
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.type(a.mime);
    return reply.send(fs.createReadStream(a.path));
  });
  app.post('/api/discussions', { bodyLimit: 48 * 1024 * 1024 }, async (req, reply) => {
    const body = discussionBody.parse(req.body ?? {});
    let attachments;
    try { attachments = decodeAttachments(body.attachments); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    return d.discussions.create({ question: body.question, repoId: body.repo_id ?? null, participants: body.participants, costCap: body.cost_cap, attachments });
  });
  app.post<{ Params: { id: string } }>('/api/discussions/:id/stop', async (req, reply) => {
    if (!d.db.discussions.get(req.params.id)) return reply.code(404).send({ error: `discussion ${req.params.id} not found` });
    return d.discussions.stop(req.params.id);
  });

  app.get('/api/sessions', async (req) => {
    const q = z.object({ bead_id: z.string().optional(), repo: z.string().optional() }).parse(req.query ?? {});
    const rows = q.bead_id ? d.db.sessions.forBead(q.bead_id) : d.db.sessions.all();
    return q.repo ? rows.filter((s) => s.repo_id === q.repo) : rows;
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/events', async (req, reply) => {
    if (!d.db.sessions.get(req.params.id)) return reply.code(404).send({ error: `session ${req.params.id} not found` });
    // `after=<seq>` returns only the events newer than the caller's last one; without it the whole session, as before.
    const { after } = z.object({ after: z.coerce.number().int().optional() }).parse(req.query ?? {});
    return after === undefined ? d.db.events.forSession(req.params.id) : d.db.events.forSessionAfter(req.params.id, after);
  });

  app.get('/api/costs', async (): Promise<CostsResponse> => {
    const today = new Date().toISOString().slice(0, 10);
    const all = d.db.sessions.all();
    const repos = d.db.repos.all().map((r) => {
      const mine = all.filter((s) => s.repo_id === r.id);
      const { total, unknown } = costOf(mine);
      return { repo_id: r.id, total, today: costOf(mine.filter((s) => s.started_at.slice(0, 10) === today)).total, unknown };
    });
    const batches = d.db.batches.all().map((b) => ({ batch_id: b.id, ...costOf(d.db.worktrees.forBatch(b.id).flatMap((w) => d.db.sessions.forBead(w.bead_id))) }));
    return { repos, batches };
  });

  app.get('/api/usage', async (req): Promise<UsageResponse> => usageReport(d.db, usageQuery(req.query)));

  app.get('/api/chat', async (req): Promise<ChatPage> => {
    const query = z.object({
      limit: z.coerce.number().int().positive().default(100).transform((value) => Math.min(value, 500)),
      before: z.coerce.number().int().positive().optional(),
      since: z.coerce.number().int().positive().optional(),
    }).superRefine((value, ctx) => {
      if (value.before !== undefined && value.since !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'before and since cannot be used together' });
    }).parse(req.query);
    return d.db.chat.page(query);
  });

  const chatBody = z.object({
    text: z.string(),
    repo: z.string().optional(),
    attachments: attachmentBody,
    open_question_ids: z.array(z.number().int()).optional(),
  }) satisfies z.ZodType<ChatSendRequest>;

  app.post('/api/chat', { bodyLimit: 48 * 1024 * 1024 }, async (req, reply) => {
    const { text, repo, attachments, open_question_ids } = chatBody.parse(req.body);
    if (!text.trim() && !attachments?.length) return reply.code(400).send({ error: 'text or attachments required' });
    let decoded; try { decoded = decodeAttachments(attachments); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    void d.orchestrator.sendUser(repo ? `[repo: ${repo}] ${text}` : text, decoded, open_question_ids);
    return { ok: true };
  });

  // Retry on a failure row re-delivers its user message through Send's queue; it answers once the delivery is queued.
  app.post<{ Params: { id: string } }>('/api/chat/:id/retry', async (req, reply) => {
    try { void d.orchestrator.retryUser(Number(req.params.id)); } catch (e) {
      if (e instanceof RetryError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string; index: string } }>('/api/chat/:id/attachments/:index', async (req, reply) => {
    const a = d.db.chat.attachment(Number(req.params.id), Number(req.params.index));
    if (!a || !fs.existsSync(a.path)) return reply.code(404).send({ error: 'attachment not found' });
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.type(a.mime);
    return reply.send(fs.createReadStream(a.path));
  });

  app.post('/api/chat/answer', async (req, reply) => {
    const { question_id, text } = z.object({ question_id: z.number().int(), text: z.string().min(1) }).parse(req.body);
    const q = d.db.chat.get(question_id);
    if (!q || q.kind !== 'question') return reply.code(404).send({ error: `question ${question_id} not found` });
    await d.orchestrator.answer(question_id, text);
    return { ok: true };
  });

  /** The user closes a question without answering it (the orchestrator moved on, or it no longer applies). */
  app.post('/api/chat/dismiss', async (req, reply) => {
    const { question_id } = z.object({ question_id: z.number().int() }).parse(req.body);
    const q = d.db.chat.get(question_id);
    if (!q || q.kind !== 'question') return reply.code(404).send({ error: `question ${question_id} not found` });
    d.db.chat.supersede(question_id);
    d.bus.emit('chat');
    // The orchestrator otherwise keeps "waiting on your answer" as its last word (round 7); informational, so it queues without a live
    // session. The row is the thread's log; the instruction travels only to the model (round 8: it read as an order in the thread).
    // Guarded: the question is closed either way, so a failed notify must not turn the dismissal into a 500.
    await d.orchestrator.systemMessage(`Question "${q.text}" dismissed by the user without an answer.`, { hint: `(question #${question_id}; do not wait for an answer.)` }).catch((err) => log.error('rest: dismiss notify failed', err));
    return { ok: true };
  });
}
