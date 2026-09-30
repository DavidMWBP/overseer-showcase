import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessName, Repo, SessionRow, TierSettings } from '@overseer/shared';
import { openDb, type Db } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import type { SessionHandle } from '../harness/types';
import { SessionManager } from '../sessions/manager';
import { loadConfig, type Config } from '../config';
import { commitFile, mkTmpRepo, sh, type TmpRepo } from '../test/tmpgit';
import * as gitApi from '../git/git';
import { until } from '../test/until';
import { assertNotPrimaryCheckout, buildRoundPrompt, changedLine, DiscussionError, Discussions } from './discussions';
import { inputLimit, render } from '../lifecycle/prompt';
import { sweepIdleEnds } from '../lifecycle/idle-end';
import { sweepStalls } from '../lifecycle/stall';
import { buildBoard } from '../api/board';
import { MemoryTaskStore } from '../beads/memory';
import { Office } from '../office/office';
import { accountUsable } from '../accounts/usage';

const MINUTE = 60_000;
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const REPO_ID = 'r1';
const HARNESSES: HarnessName[] = ['claude', 'codex', 'opencode'];

/** The standard tier with one candidate per harness, which every test's discussions run on. */
const THREE_STANDARD: TierSettings = {
  tiers: [{ name: 'standard', candidates: [
    { harness: 'claude', model: 'sonnet', effort: null },
    { harness: 'codex', model: 'gpt-5.6-terra', effort: null },
    { harness: 'opencode', model: 'deepseek/deepseek-flash', effort: null },
  ] }],
  denyModels: [],
};

interface Ctx {
  db: Db;
  bus: Bus;
  sessions: SessionManager;
  discussions: Discussions;
  adapters: Record<HarnessName, FakeAdapter>;
  config: Config;
  t: TmpRepo;
  repo: Repo;
}

function setup(overrides: { prepare?: (discussionId: string, harness: HarnessName) => Promise<void>; usageGate?: typeof accountUsable } = {}): Ctx {
  const t = mkTmpRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-discussions-'));
  expect(dataDir).not.toBe(loadConfig({}).dataDir); // never the live data dir
  const db = openDb(':memory:');
  const bus = new Bus();
  const adapters = { claude: new FakeAdapter('claude'), codex: new FakeAdapter('codex'), opencode: new FakeAdapter('opencode') };
  const sessions = new SessionManager(db, adapters, bus, path.join(dataDir, 'sessions'));
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0, worktreesDir: t.worktreesDir };
  const repo: Repo = { id: REPO_ID, path: t.path, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 0, model_filter: null };
  db.repos.insert(repo);
  db.settings.set('tiers', THREE_STANDARD);
  const discussions = new Discussions({ db, sessions, bus, config, prepare: overrides.prepare, usageGate: overrides.usageGate });
  return { db, bus, sessions, discussions, adapters, config, t, repo };
}

function useClaudeDiscussionAccount(x: Ctx): void {
  x.db.accounts.insert({ id: 'discussion-account', name: 'Demo Claude', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
  const tiers = structuredClone(x.db.settings.tiers());
  for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = tier.candidates.map((candidate) => candidate.harness === 'claude' ? { ...candidate, account: 'discussion-account' } : candidate);
  x.db.settings.set('tiers', tiers);
}

function addOrigin(x: Ctx): { bare: string; other: string } {
  const bare = path.join(x.t.root, 'origin.git');
  const other = path.join(x.t.root, 'other');
  sh(x.repo.path, ['clone', '-q', '--bare', x.repo.path, bare]);
  sh(x.repo.path, ['remote', 'add', 'origin', bare]);
  sh(x.repo.path, ['clone', '-q', bare, other]);
  return { bare, other };
}

function pushMain(other: string): void {
  sh(other, ['push', '-q', 'origin', 'main']);
}

function participantHeads(x: Ctx, discussionId: string): string[] {
  return x.db.sessions.forDiscussion(discussionId)
    .filter((s) => s.discussion_kind !== 'synthesis')
    .map((s) => sh(s.cwd, ['rev-parse', 'HEAD']));
}

/** The participant session of one harness in a discussion, never the closing synthesis session. */
const sessionOf = (x: Ctx, discussionId: string, harness: HarnessName): SessionRow => {
  const found = x.db.sessions.forDiscussion(discussionId).find((s) => s.harness === harness && s.discussion_kind !== 'synthesis');
  if (!found) throw new Error(`no ${harness} session for ${discussionId}`);
  return found;
};

/** The closing synthesis session, once one has started. */
const synthesisOf = (x: Ctx, discussionId: string): SessionRow | undefined =>
  x.db.sessions.forDiscussion(discussionId).find((s) => s.discussion_kind === 'synthesis');

/** The fake harness's handle for one participant, captured while it is live. */
const handleOf = (x: Ctx, discussionId: string, harness: HarnessName): SessionHandle => {
  const handle = x.sessions.handleOf(sessionOf(x, discussionId, harness).id);
  if (!handle) throw new Error(`the ${harness} session is not live`);
  return handle;
};

/** The prompts the fake harness received on one session's handle, oldest first; works after the session ended too. */
const promptsOn = (x: Ctx, harness: HarnessName, handle: SessionHandle): string[] => x.adapters[harness].sent(handle);

const imageAttachments = (count: number) => Array.from({ length: count }, (_, i) => ({
  name: `image-${i}.png`,
  mime: 'image/png',
  data: Buffer.from(`image-${i}`),
}));

const copiedImagePath = (cwd: string, index: number, name: string) =>
  path.join(cwd, '.discussion-attachments', `${index}-${name}`);

function expectImagePrompt(cwd: string, prompt: string, attachments: ReturnType<typeof imageAttachments>): void {
  const files = attachments.map((a, i) => copiedImagePath(cwd, i, a.name));
  expect(files.every((file) => fs.existsSync(file))).toBe(true);
  expect(files.map((file) => fs.readFileSync(file))).toEqual(attachments.map((a) => a.data));
  expect(prompt.split(/\r?\n/).filter((line) => line.startsWith('[attached image: ')))
    .toEqual(files.map((file) => `[attached image: ${file}]`));
  expect(prompt).toContain('Before answering, open each attached image with your file or image tool and refer to what it shows.');
}

const NO_IMAGE_ROUND1_PROMPT = [
  'You are one of the participants in a discussion. The question is:',
  '',
  'Q',
  '',
  'You run in your own throwaway git worktree, detached at the latest base commit selected when this discussion starts (fetched from origin for merge-request repositories, or the local base for local-merge repositories; a failed fetch uses the resolver\'s fallback). Every participant and the synthesis reads this same commit. If no repository was chosen, you run in an empty directory. You may read and search the repository and the web, and run read-only commands. Never edit or create files, never commit, never switch branches and never push: anything you write here is thrown away, and the repository itself must not be touched.',
  '',
  '',
  'Answer the question on your own, from your own reading and reasoning. You have not seen any other participant\'s answer in this round. State your position and the reasoning behind it, and keep it focused: this answer is handed to the other participants verbatim in the next round.',
  '',
  '',
  '',
].join('\n');

const NO_IMAGE_SYNTHESIS_PROMPT = [
  'You are closing a multi-model discussion. The question was:',
  '',
  'Q',
  '',
  'The participants\' final answers follow, each labelled with the harness that wrote it and quoted verbatim.',
  '',
  '### claude',
  'Answer',
  'Changed: no',
  '',
  'Write the closing synthesis, in this order:',
  '1. What the participants agree on.',
  '2. What they still disagree on, naming each side and the reason it gives.',
  '3. Your recommendation, and why.',
  '',
  'You run in your own throwaway directory. You may read and search the repository and the web, and run read-only commands. Never edit or create files, never commit, never switch branches and never push. Keep the synthesis focused and do not add new claims of your own beyond what the answers support.',
  '',
].join('\n');

/** Emits one participant's turn end with an assistant text and, optionally, the turn's reported cost. */
const answer = (x: Ctx, discussionId: string, harness: HarnessName, text: string, cost?: number): void => {
  const s = sessionOf(x, discussionId, harness);
  const handle = x.sessions.handleOf(s.id)!;
  x.adapters[harness].emit(handle, { type: 'assistant_text', text });
  x.adapters[harness].emit(handle, { type: 'turn_end', nativeSessionId: `n-${harness}`, ...(cost !== undefined ? { cost } : {}) });
};

/** Emits a participant's error then turn end: the failure a codex or opencode CLI exit reports. */
const fail = (x: Ctx, discussionId: string, harness: HarnessName, message = 'exited with code 1'): void => {
  const s = sessionOf(x, discussionId, harness);
  const handle = x.sessions.handleOf(s.id)!;
  x.adapters[harness].emit(handle, { type: 'error', message });
  x.adapters[harness].emit(handle, { type: 'turn_end', nativeSessionId: `n-${harness}` });
};

describe('discussions', () => {
  let x: Ctx;
  const dirs: string[] = [];
  beforeEach(() => { x = setup(); dirs.push(x.t.root, x.config.dataDir); });
  afterEach(() => {
    x.db.sql.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  async function three(): Promise<string> {
    const d = await x.discussions.create({ question: 'Which storage engine should we use?', repoId: REPO_ID });
    await until(() => x.db.sessions.forDiscussion(d.id).length === 3, 10_000, 'three participants');
    return d.id;
  }

  describe('validation', () => {
    it('refuses an empty question', async () => {
      await expect(x.discussions.create({ question: '   ', repoId: REPO_ID })).rejects.toThrow(/question must not be empty/);
    });

    it('refuses zero participants', async () => {
      await expect(x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: [] })).rejects.toThrow(/at least one participant/);
    });

    it('refuses more than three participants', async () => {
      await expect(x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['claude', 'codex', 'opencode', 'claude'] })).rejects.toThrow(/at most 3 participants/);
    });

    it('refuses a duplicate harness', async () => {
      await expect(x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['claude', 'claude'] })).rejects.toThrow(/claude is listed twice/);
    });

    it('refuses an unknown repo', async () => {
      await expect(x.discussions.create({ question: 'Q', repoId: 'nope' })).rejects.toThrow(/repo nope not found/);
    });

    it('refuses a non-positive cost cap', async () => {
      await expect(x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['claude'], costCap: 0 })).rejects.toThrow(/cost cap must be greater than 0/);
    });

    it('refuses a harness with no standard-tier candidate, naming the harness', async () => {
      x.db.settings.set('tiers', { tiers: [{ name: 'standard', candidates: [{ harness: 'claude', model: 'sonnet', effort: null }] }], denyModels: [] });
      await expect(x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['codex'] })).rejects.toThrow(/no standard-tier model is configured for codex/);
    });

    it('leaves no discussion row behind after a refused participant', async () => {
      x.db.settings.set('tiers', { tiers: [{ name: 'standard', candidates: [{ harness: 'claude', model: 'sonnet', effort: null }] }], denyModels: [] });
      await x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['codex'] }).catch(() => undefined);
      expect(x.db.discussions.all()).toEqual([]);
    });
  });

  describe('isolation', () => {
    it('starts every participant in its own detached worktree, never the primary checkout', async () => {
      const id = await three();
      const rows = x.db.sessions.forDiscussion(id);
      expect(rows).toHaveLength(3);
      const cwds = rows.map((s) => path.resolve(s.cwd));
      expect(new Set(cwds).size).toBe(3);
      for (const cwd of cwds) {
        expect(cwd).not.toBe(path.resolve(x.repo.path));
        expect(cwd.startsWith(path.resolve(x.config.worktreesDir))).toBe(true);
        expect(fs.existsSync(path.join(cwd, '.git'))).toBe(true);
        expect(sh(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD'); // detached
      }
      const listed = sh(x.repo.path, ['worktree', 'list', '--porcelain']);
      for (const cwd of cwds) expect(listed).toContain(path.resolve(cwd).replace(/\\/g, '/'));
    });

    it('starts gitlab-mr participants at the fetched origin base, not the stale local base', async () => {
      const { other } = addOrigin(x);
      const originHead = commitFile(other, 'remote.txt', 'from origin\n', 'remote commit');
      pushMain(other);
      const localHead = sh(x.repo.path, ['rev-parse', 'main']);
      x.db.sql.prepare('UPDATE repos SET merge_mode = ? WHERE id = ?').run('gitlab-mr', REPO_ID);
      const baseResolver = vi.spyOn(gitApi, 'resolveNewWorkBase');
      try {
        const d = await x.discussions.create({ question: 'Read the latest code?', repoId: REPO_ID });

        expect(originHead).not.toBe(localHead);
        expect(participantHeads(x, d.id)).toEqual([originHead, originHead, originHead]);
        expect(baseResolver).toHaveBeenCalledTimes(1);
      } finally {
        baseResolver.mockRestore();
      }
    });

    it('starts local-merge participants at a local base that is ahead of origin', async () => {
      const { bare } = addOrigin(x);
      const localHead = commitFile(x.repo.path, 'local.txt', 'merged locally\n', 'local commit');

      const d = await x.discussions.create({ question: 'Read the base?', repoId: REPO_ID });

      expect(sh(bare, ['rev-parse', 'main'])).not.toBe(localHead);
      expect(participantHeads(x, d.id)).toEqual([localHead, localHead, localHead]);
    });

    it('keeps the local-merge base when origin is ahead and logs the missing commit count', async () => {
      const { other } = addOrigin(x);
      commitFile(other, 'a.txt', 'a\n', 'remote a');
      commitFile(other, 'b.txt', 'b\n', 'remote b');
      pushMain(other);
      const localHead = sh(x.repo.path, ['rev-parse', 'main']);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const d = await x.discussions.create({ question: 'Read the base?', repoId: REPO_ID });
        expect(warning.mock.calls[0]?.[0]).toMatch(/^discussions: origin\/main has 2 commits that the local main lacks/);
        expect(participantHeads(x, d.id)).toEqual([localHead, localHead, localHead]);
      } finally {
        warning.mockRestore();
      }
    });

    it('uses the local base without an origin remote', async () => {
      const localHead = sh(x.repo.path, ['rev-parse', 'main']);

      const d = await x.discussions.create({ question: 'Read the local base?', repoId: REPO_ID });

      expect(participantHeads(x, d.id)).toEqual([localHead, localHead, localHead]);
    });

    it('uses a previously fetched origin base when fetching fails', async () => {
      addOrigin(x);
      sh(x.repo.path, ['fetch', '-q', 'origin', 'main']);
      const staleOriginHead = sh(x.repo.path, ['rev-parse', 'origin/main']);
      const localHead = commitFile(x.repo.path, 'local.txt', 'local\n', 'local commit');
      sh(x.repo.path, ['remote', 'set-url', 'origin', path.join(x.t.root, 'missing.git')]);
      x.db.sql.prepare('UPDATE repos SET merge_mode = ? WHERE id = ?').run('gitlab-mr', REPO_ID);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const d = await x.discussions.create({ question: 'Read the last fetched base?', repoId: REPO_ID });
        expect(warning.mock.calls[0]?.[0]).toMatch(/could not fetch origin\/main; using the last fetched origin\/main/);
        expect(staleOriginHead).not.toBe(localHead);
        expect(participantHeads(x, d.id)).toEqual([staleOriginHead, staleOriginHead, staleOriginHead]);
      } finally {
        warning.mockRestore();
      }
    });

    it('falls back to the local base when fetching fails before any origin base was fetched', async () => {
      sh(x.repo.path, ['remote', 'add', 'origin', path.join(x.t.root, 'missing.git')]);
      const localHead = sh(x.repo.path, ['rev-parse', 'main']);
      x.db.sql.prepare('UPDATE repos SET merge_mode = ? WHERE id = ?').run('gitlab-mr', REPO_ID);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const d = await x.discussions.create({ question: 'Read the local fallback?', repoId: REPO_ID });
        expect(warning.mock.calls[0]?.[0]).toMatch(/could not fetch origin\/main; the branch was cut from the local main/);
        expect(participantHeads(x, d.id)).toEqual([localHead, localHead, localHead]);
      } finally {
        warning.mockRestore();
      }
    });

    it('uses the participants’ pinned SHA for synthesis after origin advances', async () => {
      const { other } = addOrigin(x);
      const originHead = commitFile(other, 'first.txt', 'first\n', 'first remote commit');
      pushMain(other);
      x.db.sql.prepare('UPDATE repos SET merge_mode = ? WHERE id = ?').run('gitlab-mr', REPO_ID);
      const d = await x.discussions.create({ question: 'Read one base?', repoId: REPO_ID, participants: ['claude'] });
      const participantHead = sh(sessionOf(x, d.id, 'claude').cwd, ['rev-parse', 'HEAD']);
      const newerOriginHead = commitFile(other, 'second.txt', 'second\n', 'second remote commit');
      pushMain(other);

      const handle = handleOf(x, d.id, 'claude');
      answer(x, d.id, 'claude', 'The base is pinned.\nChanged: yes');
      await until(() => promptsOn(x, 'claude', handle).length === 2, 10_000, 'the second round');
      answer(x, d.id, 'claude', 'Changed: no');
      await until(() => !!synthesisOf(x, d.id), 10_000, 'the synthesis session');

      expect(participantHead).toBe(originHead);
      expect(newerOriginHead).not.toBe(participantHead);
      expect(sh(synthesisOf(x, d.id)!.cwd, ['rev-parse', 'HEAD'])).toBe(participantHead);
    });

    it('uses an empty temp directory with no repository and does not resolve a git base', async () => {
      const baseResolver = vi.spyOn(gitApi, 'resolveNewWorkBase');
      try {
        const d = await x.discussions.create({ question: 'Read without a repo?', participants: ['claude'] });
        const cwd = sessionOf(x, d.id, 'claude').cwd;
        expect(path.resolve(cwd)).toBe(path.resolve(x.config.dataDir, 'discussions', d.id, 'claude'));
        expect(fs.existsSync(cwd)).toBe(true);
        expect(fs.existsSync(path.join(cwd, '.git'))).toBe(false);
        expect(baseResolver).not.toHaveBeenCalled();
      } finally {
        baseResolver.mockRestore();
      }
    });

    it('copies question images into a no-repository discussion temp directory', async () => {
      const attachments = imageAttachments(1);
      const discussion = await x.discussions.create({ question: 'Read this image?', participants: ['claude'], attachments });
      const session = sessionOf(x, discussion.id, 'claude');
      const handle = x.sessions.handleOf(session.id)!;
      expect(path.resolve(session.cwd)).toBe(path.resolve(x.config.dataDir, 'discussions', discussion.id, 'claude'));
      expect(fs.existsSync(path.join(session.cwd, '.git'))).toBe(false);
      expectImagePrompt(session.cwd, promptsOn(x, 'claude', handle)[0]!, attachments);
    });

    it('keeps same-named question images as separate indexed files', async () => {
      const attachments = [
        { name: 'same.png', mime: 'image/png', data: Buffer.from('first image') },
        { name: 'same.png', mime: 'image/png', data: Buffer.from('second image') },
      ];
      const discussion = await x.discussions.create({ question: 'Compare these images?', repoId: REPO_ID, participants: ['claude'], attachments });
      const session = sessionOf(x, discussion.id, 'claude');
      const handle = x.sessions.handleOf(session.id)!;
      const files = [0, 1].map((i) => copiedImagePath(session.cwd, i, 'same.png'));
      expect(files.every((file) => fs.existsSync(file))).toBe(true);
      expect(files.map((file) => fs.readFileSync(file))).toEqual(attachments.map((a) => a.data));
      expect(promptsOn(x, 'claude', handle)[0]!.split(/\r?\n/).filter((line) => line.startsWith('[attached image: ')))
        .toEqual(files.map((file) => `[attached image: ${file}]`));
    });

    it.each([1, 4])('copies %i question images into every participant and synthesis cwd', async (count) => {
      const attachments = imageAttachments(count);
      const discussion = await x.discussions.create({ question: 'Review the attached images?', repoId: REPO_ID, attachments });
      const participants = HARNESSES.map((harness) => {
        const session = sessionOf(x, discussion.id, harness);
        const handle = x.sessions.handleOf(session.id)!;
        return { harness, session, handle };
      });
      for (const participant of participants) {
        expectImagePrompt(participant.session.cwd, promptsOn(x, participant.harness, participant.handle)[0]!, attachments);
      }

      for (const harness of HARNESSES) answer(x, discussion.id, harness, `${harness} round 1\nChanged: yes`);
      await until(() => participants.every((p) => promptsOn(x, p.harness, p.handle).length === 2), 10_000, 'round 2 prompts');
      for (const harness of HARNESSES) answer(x, discussion.id, harness, `${harness} round 2\nChanged: no`);
      await until(() => !!synthesisOf(x, discussion.id), 10_000, 'synthesis session');
      const synthesis = synthesisOf(x, discussion.id)!;
      const synthesisHandle = x.sessions.handleOf(synthesis.id)!;
      expectImagePrompt(synthesis.cwd, promptsOn(x, 'claude', synthesisHandle)[0]!, attachments);
    });

    it('refuses a cwd that is the primary checkout or inside it', () => {
      expect(() => assertNotPrimaryCheckout(x.repo.path, x.repo.path)).toThrow(/primary checkout/);
      expect(() => assertNotPrimaryCheckout(x.repo.path, path.join(x.repo.path, 'src'))).toThrow(/primary checkout/);
      expect(() => assertNotPrimaryCheckout(x.repo.path, path.join(x.config.worktreesDir, REPO_ID, 'disc-x', 'claude'))).not.toThrow();
    });

    it('starts the participants in parallel', async () => {
      let entered = 0;
      let concurrent = 0;
      let peak = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const parallel = setup({ prepare: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        if (++entered === 3) release();
        await gate; // sequential starts deadlock here, so only a genuinely parallel run returns
        concurrent--;
      } });
      dirs.push(parallel.t.root, parallel.config.dataDir);
      try {
        const d = await parallel.discussions.create({ question: 'Q', repoId: REPO_ID });
        expect(peak).toBe(3);
        expect(parallel.db.sessions.forDiscussion(d.id)).toHaveLength(3);
      } finally {
        parallel.db.sql.close();
      }
    });
  });

  describe('round 1', () => {
    it('renders the original participant and synthesis prompts and creates no image directories without attachments', async () => {
      const discussion = await x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['claude'] });
      const participant = sessionOf(x, discussion.id, 'claude');
      const participantHandle = x.sessions.handleOf(participant.id)!;
      const participantPrompt = promptsOn(x, 'claude', participantHandle)[0]!;
      expect(participantPrompt.replace(/\r\n/g, '\n')).toBe(NO_IMAGE_ROUND1_PROMPT);
      expect(participantPrompt).toBe(render(fs.readFileSync(path.join(x.config.promptsDir, 'discussion.md'), 'utf8'), { question: 'Q', round1: '1', attachments: '' }));
      expect(fs.existsSync(path.join(participant.cwd, '.discussion-attachments'))).toBe(false);

      answer(x, discussion.id, 'claude', 'Answer\nChanged: yes');
      await until(() => promptsOn(x, 'claude', participantHandle).length === 2, 10_000, 'round 2 prompt');
      answer(x, discussion.id, 'claude', 'Answer\nChanged: no');
      await until(() => !!synthesisOf(x, discussion.id), 10_000, 'synthesis session');
      const synthesis = synthesisOf(x, discussion.id)!;
      const synthesisHandle = x.sessions.handleOf(synthesis.id)!;
      const synthesisPrompt = promptsOn(x, 'claude', synthesisHandle)[0]!;
      expect(synthesisPrompt.replace(/\r\n/g, '\n')).toBe(NO_IMAGE_SYNTHESIS_PROMPT);
      expect(synthesisPrompt).toBe(render(fs.readFileSync(path.join(x.config.promptsDir, 'discussion-synthesis.md'), 'utf8'), {
        question: 'Q', answers: '### claude\nAnswer\nChanged: no', attachments: '',
      }));
      expect(fs.existsSync(path.join(synthesis.cwd, '.discussion-attachments'))).toBe(false);
    });

    it('does not resend the attached image paths in a later round', async () => {
      const attachments = imageAttachments(1);
      const discussion = await x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['claude'], attachments });
      const session = sessionOf(x, discussion.id, 'claude');
      const handle = x.sessions.handleOf(session.id)!;
      expectImagePrompt(session.cwd, promptsOn(x, 'claude', handle)[0]!, attachments);
      answer(x, discussion.id, 'claude', 'First answer\nChanged: yes');
      await until(() => promptsOn(x, 'claude', handle).length === 2, 10_000, 'round 2 prompt');
      const laterPrompt = promptsOn(x, 'claude', handle)[1]!;
      expect(laterPrompt).not.toContain('[attached image: ');
      expect(laterPrompt).not.toContain('Before answering, open each attached image');
    });

    it('records one turn per participant from its turn end', async () => {
      const id = await three();
      answer(x, id, 'claude', 'Claude says Postgres.');
      answer(x, id, 'codex', 'Codex says SQLite.');
      answer(x, id, 'opencode', 'OpenCode says DuckDB.');
      await until(() => x.db.discussions.turns(id).length === 3, 10_000, 'three turns');
      const turns = x.db.discussions.turns(id);
      expect(turns.map((t) => t.round)).toEqual([1, 1, 1]);
      expect(turns.map((t) => t.harness).sort()).toEqual(['claude', 'codex', 'opencode']);
      expect(turns.find((t) => t.harness === 'claude')?.text).toBe('Claude says Postgres.');
      expect(turns.every((t) => t.session_id.length > 0)).toBe(true);
    });

    it('records a crashed participant as failed while the others continue', async () => {
      const id = await three();
      const codex = sessionOf(x, id, 'codex');
      x.adapters.codex.emit(x.sessions.handleOf(codex.id)!, { type: 'error', message: 'connection reset' });
      await x.sessions.end(codex.id);
      await until(() => x.db.sessions.get(codex.id)?.status === 'failed', 10_000, 'codex failed');
      answer(x, id, 'claude', 'Claude says Postgres.');
      answer(x, id, 'opencode', 'OpenCode says DuckDB.');
      await until(() => x.db.discussions.turns(id).length === 2, 10_000, 'the two survivors');
      const detail = x.discussions.detail(id)!;
      expect(detail.participants.find((p) => p.harness === 'codex')).toMatchObject({ status: 'failed' });
      expect(detail.participants.filter((p) => p.status === 'running').map((p) => p.harness).sort()).toEqual(['claude', 'opencode']);
      expect(detail.turns.map((t) => t.harness).sort()).toEqual(['claude', 'opencode']);
    });

    it('treats a turn that ended after an error as a failed participant: no turn, session ended failed, the others go on', async () => {
      const id = await three();
      const codex = sessionOf(x, id, 'codex');
      const h = x.sessions.handleOf(codex.id)!;
      // A codex or opencode CLI exiting nonzero: the adapter pump emits the error, then the turn end.
      x.adapters.codex.emit(h, { type: 'assistant_text', text: 'half an answer' });
      x.adapters.codex.emit(h, { type: 'error', message: 'codex exited with code 1' });
      x.adapters.codex.emit(h, { type: 'turn_end', nativeSessionId: 'n-codex' });
      await until(() => x.db.sessions.get(codex.id)?.status === 'failed', 10_000, 'codex failed');
      expect(x.db.sessions.get(codex.id)?.end_reason).toBe('turn failed: codex exited with code 1');
      expect(x.sessions.isLive(codex.id)).toBe(false);
      expect(x.db.discussions.turns(id)).toEqual([]);
      answer(x, id, 'claude', 'Claude says Postgres.');
      answer(x, id, 'opencode', 'OpenCode says DuckDB.');
      await until(() => x.db.discussions.turns(id).length === 2, 10_000, 'the two survivors');
      expect(x.db.discussions.turns(id).map((t) => t.harness).sort()).toEqual(['claude', 'opencode']);
      expect(x.db.discussions.get(id)?.status).toBe('running');
    });

    it('treats a turn end with no answer text and no error as a failed participant too', async () => {
      const id = await three();
      const opencode = sessionOf(x, id, 'opencode');
      x.adapters.opencode.emit(x.sessions.handleOf(opencode.id)!, { type: 'turn_end', nativeSessionId: 'n-opencode' });
      await until(() => x.db.sessions.get(opencode.id)?.status === 'failed', 10_000, 'opencode failed');
      expect(x.db.sessions.get(opencode.id)?.end_reason).toBe('turn ended with no answer');
      expect(x.db.discussions.turns(id)).toEqual([]);
      answer(x, id, 'claude', 'Claude says Postgres.');
      await until(() => x.db.discussions.turns(id).length === 1, 10_000, 'claude recorded');
      expect(x.db.sessions.get(sessionOf(x, id, 'codex').id)?.status).toBe('running');
    });

    it('pings the discussion when a lone participant exits after an error with no turn end', async () => {
      const d = await x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['claude'] });
      const claude = sessionOf(x, d.id, 'claude');
      const pings: string[] = [];
      x.bus.on('discussion', (p) => pings.push(p.id));
      // A real codex or opencode exit emits the error and then the stream ends, with no `turn_end`: the manager marks the row
      // failed itself, so only the session-end listener can tell the open page to refetch that participant.
      x.adapters.claude.emit(x.sessions.handleOf(claude.id)!, { type: 'error', message: 'claude exited with code 1' });
      await x.sessions.end(claude.id);
      await until(() => pings.includes(d.id), 10_000, 'a discussion ping for the failed participant');
      expect(x.db.sessions.get(claude.id)?.status).toBe('failed');
      expect(x.db.discussions.turns(d.id)).toEqual([]);
      expect(x.discussions.detail(d.id)!.participants).toEqual([expect.objectContaining({ harness: 'claude', status: 'failed' })]);
    });
  });

  describe('rounds, stop rule and synthesis', () => {
    /** Emits one round's answers for every harness and waits for the round to be recorded. */
    const playRound = async (id: string, round: number, texts: Partial<Record<HarnessName, string>>): Promise<void> => {
      for (const [harness, text] of Object.entries(texts) as [HarnessName, string][]) answer(x, id, harness, text);
      await until(() => x.db.discussions.turns(id).filter((t) => t.round === round).length === Object.keys(texts).length, 10_000, `round ${round} recorded`);
    };
    /** Waits until the harnesses named have been prompted for the given round. */
    const prompted = async (id: string, harnesses: HarnessName[], count: number): Promise<void> => {
      await until(() => harnesses.every((h) => promptsOn(x, h, handleOf(x, id, h)).length >= count), 10_000, `round ${count} prompts`);
    };
    /** Answers the synthesis session and waits for the discussion to be done. */
    const closeSynthesis = async (id: string, text: string): Promise<void> => {
      await until(() => !!synthesisOf(x, id) && x.sessions.isLive(synthesisOf(x, id)!.id), 10_000, 'synthesis session');
      const synth = synthesisOf(x, id)!;
      x.adapters.claude.emit(x.sessions.handleOf(synth.id)!, { type: 'assistant_text', text });
      x.adapters.claude.emit(x.sessions.handleOf(synth.id)!, { type: 'turn_end', nativeSessionId: 'n-synth' });
      await until(() => x.db.discussions.get(id)?.status === 'done', 10_000, 'discussion done');
    };

    it('runs three rounds, then a claude synthesis quoting every final answer', async () => {
      const id = await three();
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      // Every round-2 prompt quotes the others' round-1 answers verbatim, and never its own.
      const claudeRound2 = promptsOn(x, 'claude', handleOf(x, id, 'claude'))[1]!;
      expect(claudeRound2).toContain('codex one');
      expect(claudeRound2).toContain('opencode one');
      expect(claudeRound2).not.toContain('claude one');
      expect(claudeRound2).toContain('Changed: yes');

      await playRound(id, 2, { claude: 'claude two\nChanged: yes', codex: 'codex two\nChanged: yes', opencode: 'opencode two\nChanged: yes' });
      await prompted(id, HARNESSES, 3);
      await playRound(id, 3, { claude: 'claude three\nChanged: yes', codex: 'codex three\nChanged: yes', opencode: 'opencode three\nChanged: yes' });

      await until(() => !!synthesisOf(x, id), 10_000, 'the synthesis starts after round 3');
      const synthesisPrompt = promptsOn(x, 'claude', x.sessions.handleOf(synthesisOf(x, id)!.id)!)[0]!;
      for (const harness of HARNESSES) expect(synthesisPrompt).toContain(`${harness} three`);

      await closeSynthesis(id, 'The closing synthesis.');
      const row = x.db.discussions.get(id)!;
      expect(row.status).toBe('done');
      expect(row.synthesis).toBe('The closing synthesis.');
      const turns = x.db.discussions.turns(id);
      expect(turns).toHaveLength(9);
      expect(turns.filter((t) => t.harness === 'claude').map((t) => t.round)).toEqual([1, 2, 3]);
      expect(turns.filter((t) => t.harness === 'codex').map((t) => t.round)).toEqual([1, 2, 3]);
      expect(x.db.sessions.forDiscussion(id).every((s) => s.status !== 'running' && !x.sessions.isLive(s.id))).toBe(true);
    });

    it('stops after round 2 when every participant says its answer did not change', async () => {
      const id = await three();
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      await playRound(id, 2, { claude: 'claude two\nChanged: no', codex: 'codex two\nChanged: no', opencode: 'opencode two\nChanged: no' });

      await until(() => !!synthesisOf(x, id), 10_000, 'an early synthesis after round 2');
      await closeSynthesis(id, 'Nothing changed.');
      expect(x.db.discussions.get(id)?.status).toBe('done');
      expect(x.db.discussions.turns(id).map((t) => t.round)).toEqual([1, 1, 1, 2, 2, 2]);
    });

    it('treats a missing or malformed Changed line as yes and runs another round', async () => {
      const id = await three();
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      await playRound(id, 2, { claude: 'claude two\nChanged: no', codex: 'codex two\nChanged: maybe', opencode: 'opencode two\nChanged: no' });
      await prompted(id, HARNESSES, 3);
      expect(x.db.discussions.turns(id).filter((t) => t.round === 2)).toHaveLength(3);
      expect(changedLine('codex two\nChanged: maybe')).toBe('yes');
      expect(changedLine('anything at all')).toBe('yes');
      expect(changedLine('done\nChanged: NO')).toBe('no');
    });

    it('reads only the final non-empty line for the Changed verdict', () => {
      expect(changedLine('answer\nChanged: no\nChanged: maybe')).toBe('yes'); // an earlier valid line under a malformed ending
      expect(changedLine('answer\nChanged: no\nmore text')).toBe('yes');
      expect(changedLine('answer')).toBe('yes'); // missing
      expect(changedLine('')).toBe('yes'); // blank
      expect(changedLine('answer\n  Changed: no  \n\n  \n')).toBe('no'); // trailing blank lines
      expect(changedLine('answer\r\nchanged: No\r\n')).toBe('no');
      expect(changedLine('answer\nChanged: yes')).toBe('yes');
    });

    it('fails a participant whose round-2 turn emits no new text instead of re-recording its round-1 answer', async () => {
      const id = await three();
      const codexHandle = handleOf(x, id, 'codex');
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      x.adapters.codex.emit(codexHandle, { type: 'turn_end', nativeSessionId: 'n-codex' }); // blank round-2 turn
      await until(() => x.db.sessions.get(sessionOf(x, id, 'codex').id)?.status !== 'running', 10_000, 'codex ended');
      await playRound(id, 2, { claude: 'claude two\nChanged: yes', opencode: 'opencode two\nChanged: yes' });

      await prompted(id, ['claude', 'opencode'], 3);
      expect(x.db.discussions.turns(id).filter((t) => t.harness === 'codex').map((t) => t.round)).toEqual([1]);
      expect(promptsOn(x, 'codex', codexHandle)).toHaveLength(2); // never prompted for round 3
      expect(x.discussions.detail(id)!.participants.find((p) => p.harness === 'codex')).toMatchObject({ status: 'failed' });
    });

    it('drops a participant that fails in round 2 from round 3, keeping its last answer as its final answer', async () => {
      const id = await three();
      const codexHandle = handleOf(x, id, 'codex');
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      fail(x, id, 'codex', 'connection reset');
      await until(() => x.db.sessions.get(sessionOf(x, id, 'codex').id)?.status === 'failed', 10_000, 'codex failed');
      await playRound(id, 2, { claude: 'claude two\nChanged: yes', opencode: 'opencode two\nChanged: yes' });

      await prompted(id, ['claude', 'opencode'], 3);
      expect(promptsOn(x, 'codex', codexHandle)).toHaveLength(2); // never prompted for round 3
      const claudeRound3 = promptsOn(x, 'claude', handleOf(x, id, 'claude'))[2]!;
      expect(claudeRound3).toContain('codex one');
      expect(claudeRound3).toContain('codex (final answer)');
      expect(claudeRound3).not.toContain('opencode one'); // only the others' latest, not an older round
      expect(claudeRound3).toContain('opencode two');

      await playRound(id, 3, { claude: 'claude three\nChanged: yes', opencode: 'opencode three\nChanged: yes' });
      await until(() => !!synthesisOf(x, id), 10_000, 'the synthesis after round 3');
      const synthesisPrompt = promptsOn(x, 'claude', x.sessions.handleOf(synthesisOf(x, id)!.id)!)[0]!;
      expect(synthesisPrompt).toContain('codex one'); // the failed participant's last answer is still quoted
      expect(synthesisPrompt).toContain('claude three');
      expect(synthesisPrompt).toContain('opencode three');
      expect(x.discussions.detail(id)!.participants.find((p) => p.harness === 'codex')).toMatchObject({ status: 'failed' });
    });

    it('drops a participant whose session exits mid-round with no turn end, and the others take the next round', async () => {
      const id = await three();
      const codexHandle = handleOf(x, id, 'codex');
      // The process is gone with no `turn_end` at all: a killed CLI, or claude's `error` then exit.
      x.adapters.codex.emit(codexHandle, { type: 'error', message: 'codex exited with code 1' });
      await x.sessions.end(sessionOf(x, id, 'codex').id);
      await until(() => x.db.sessions.get(sessionOf(x, id, 'codex').id)?.status === 'failed', 10_000, 'codex failed');

      await playRound(id, 1, { claude: 'claude one', opencode: 'opencode one' });
      await prompted(id, ['claude', 'opencode'], 2);
      expect(promptsOn(x, 'codex', codexHandle)).toHaveLength(1); // only the round-1 prompt; never taken into round 2
      const claudeRound2 = promptsOn(x, 'claude', handleOf(x, id, 'claude'))[1]!;
      expect(claudeRound2).toContain('opencode one');
      expect(claudeRound2).not.toContain('codex'); // it never answered, so there is nothing of its own to quote
      expect(x.db.sessions.get(sessionOf(x, id, 'claude').id)?.status).toBe('running');
    });

    it('lists rounds so far: a finished round, a partial round and a failed participant', async () => {
      const id = await three();
      const summary = () => x.discussions.list().find((d) => d.id === id)!;
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      expect(summary()).toMatchObject({ turns: 3, rounds: 1, round_in_progress: false });
      await playRound(id, 2, { claude: 'claude two' });
      expect(summary()).toMatchObject({ turns: 4, rounds: 2, round_in_progress: true });
      fail(x, id, 'codex');
      await until(() => x.db.sessions.get(sessionOf(x, id, 'codex').id)?.status === 'failed', 10_000, 'codex failed');
      expect(summary()).toMatchObject({ turns: 4, rounds: 2, round_in_progress: true }); // opencode still owes round 2
      answer(x, id, 'opencode', 'opencode two');
      await until(() => x.db.discussions.turns(id).filter((t) => t.round === 2).length === 2, 10_000, 'round 2 recorded');
      expect(summary()).toMatchObject({ rounds: 2, round_in_progress: false });
    });

    it('counts the running synthesis cost in the discussion total, without counting it twice once stored', async () => {
      const id = await three();
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      await playRound(id, 2, { claude: 'claude two\nChanged: no', codex: 'codex two\nChanged: no', opencode: 'opencode two\nChanged: no' });
      await until(() => !!synthesisOf(x, id) && x.sessions.isLive(synthesisOf(x, id)!.id), 10_000, 'the synthesis session');
      const synth = synthesisOf(x, id)!;
      x.db.sessions.update(synth.id, { cost: 0.4 });
      expect(x.db.discussions.get(id)?.cost_cap).toBe(5);
      expect(x.discussions.detail(id)!.cost).toBeCloseTo(0.4);
      expect(x.discussions.list().find((d) => d.id === id)?.cost).toBeCloseTo(0.4);

      const handle = x.sessions.handleOf(synth.id)!;
      x.adapters.claude.emit(handle, { type: 'assistant_text', text: 'The synthesis.' });
      x.adapters.claude.emit(handle, { type: 'turn_end', nativeSessionId: 'n-synth', cost: 0.4 });
      await until(() => x.db.discussions.get(id)?.status === 'done', 10_000, 'discussion done');
      expect(x.db.discussions.get(id)?.synthesis_cost).toBeCloseTo(0.4);
      expect(x.discussions.detail(id)!.cost).toBeCloseTo(0.4); // the stored cost is not added on top of the session's
    });

    it('fails the discussion with no synthesis when every participant fails', async () => {
      const id = await three();
      fail(x, id, 'claude');
      await until(() => x.db.sessions.get(sessionOf(x, id, 'claude').id)?.status === 'failed', 10_000, 'claude failed');
      fail(x, id, 'codex');
      await until(() => x.db.sessions.get(sessionOf(x, id, 'codex').id)?.status === 'failed', 10_000, 'codex failed');
      fail(x, id, 'opencode');
      await until(() => x.db.discussions.get(id)?.status === 'failed', 10_000, 'discussion failed');
      expect(x.db.discussions.get(id)?.stop_reason).toBe('all participants failed after round 1');
      expect(x.db.discussions.get(id)?.synthesis).toBeNull();
      expect(synthesisOf(x, id)).toBeUndefined();
      expect(x.db.discussions.turns(id)).toEqual([]);
    });

    it('fails the discussion when the synthesis session crashes without an answer', async () => {
      const id = await three();
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      await playRound(id, 2, { claude: 'claude two\nChanged: no', codex: 'codex two\nChanged: no', opencode: 'opencode two\nChanged: no' });
      await until(() => !!synthesisOf(x, id) && x.sessions.isLive(synthesisOf(x, id)!.id), 10_000, 'the synthesis session');
      const synth = synthesisOf(x, id)!;
      x.adapters.claude.emit(x.sessions.handleOf(synth.id)!, { type: 'error', message: 'claude exited with code 1' });
      await x.sessions.end(synth.id);
      await until(() => x.db.discussions.get(id)?.status === 'failed', 10_000, 'the failed synthesis');
      expect(x.db.discussions.get(id)?.stop_reason).toBe('synthesis failed: claude exited with code 1');
      expect(x.db.discussions.get(id)?.synthesis).toBeNull();
    });

    it('stops at the cost cap after the turn that crossed it, keeping the turns and running no synthesis', async () => {
      const id = await three();
      const claudeHandle = handleOf(x, id, 'claude');
      answer(x, id, 'claude', 'claude one', 5);
      await until(() => x.db.discussions.get(id)?.status === 'stopped', 10_000, 'the cap stop');
      const row = x.db.discussions.get(id)!;
      expect(row.stop_reason).toBe('cost cap $5 reached after round 1');
      expect(row.synthesis).toBeNull();
      expect(synthesisOf(x, id)).toBeUndefined();
      expect(x.db.discussions.turns(id)).toHaveLength(1);
      expect(x.db.discussions.turns(id)[0]!.text).toBe('claude one');
      expect(promptsOn(x, 'claude', claudeHandle)).toHaveLength(1); // no round-2 prompt was sent
    });

    it('stops at the cap when the synthesis turn crosses it, storing no synthesis', async () => {
      const id = await three();
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      await playRound(id, 2, { claude: 'claude two\nChanged: no', codex: 'codex two\nChanged: no', opencode: 'opencode two\nChanged: no' });
      await until(() => !!synthesisOf(x, id) && x.sessions.isLive(synthesisOf(x, id)!.id), 10_000, 'the synthesis session');
      const synth = synthesisOf(x, id)!;
      const handle = x.sessions.handleOf(synth.id)!;
      x.adapters.claude.emit(handle, { type: 'assistant_text', text: 'The synthesis.' });
      x.adapters.claude.emit(handle, { type: 'turn_end', nativeSessionId: 'n-synth', cost: 5 });
      await until(() => x.db.discussions.get(id)?.status === 'stopped', 10_000, 'the cap stop');
      const row = x.db.discussions.get(id)!;
      expect(row.stop_reason).toBe('cost cap $5 reached after round 2');
      expect(row.synthesis).toBeNull();
      expect(x.db.sessions.get(synth.id)?.status).toBe('ended');
      expect(x.db.discussions.turns(id)).toHaveLength(6); // the rounds' turns are kept
      expect(x.db.discussions.turns(id).filter((t) => t.round === 2)).toHaveLength(3);
    });

    it('keeps a Stop final when it races a synthesis turn end', async () => {
      const id = await three();
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      await playRound(id, 2, { claude: 'claude two\nChanged: no', codex: 'codex two\nChanged: no', opencode: 'opencode two\nChanged: no' });
      await until(() => !!synthesisOf(x, id) && x.sessions.isLive(synthesisOf(x, id)!.id), 10_000, 'the synthesis session');
      const synth = synthesisOf(x, id)!;
      const realEnd = x.sessions.end.bind(x.sessions);
      let releaseEnd!: () => void;
      const endGate = new Promise<void>((resolve) => { releaseEnd = resolve; });
      let gated = false;
      // Hold the synthesis's own end in flight, so a Stop can land after onSynthesisEnd passed its entry checks.
      x.sessions.end = async (sid: string) => {
        if (sid === synth.id && !gated) { gated = true; await endGate; }
        return realEnd(sid);
      };
      try {
        const handle = x.sessions.handleOf(synth.id)!;
        x.adapters.claude.emit(handle, { type: 'assistant_text', text: 'The synthesis.' });
        x.adapters.claude.emit(handle, { type: 'turn_end', nativeSessionId: 'n-synth' });
        await until(() => gated, 10_000, 'the synthesis end is in flight');
        const stopped = await x.discussions.stop(id);
        expect(stopped.status).toBe('stopped');
        releaseEnd();
        await new Promise((resolve) => setTimeout(resolve, 50)); // give the continuation every chance to overwrite the stop
        expect(x.db.discussions.get(id)?.status).toBe('stopped');
        expect(x.db.discussions.get(id)?.synthesis).toBeNull();
      } finally {
        x.sessions.end = realEnd;
      }
    });

    it('keeps a Stop final when it lands during the synthesis cleanup, storing no synthesis', async () => {
      const id = await three();
      await playRound(id, 1, { claude: 'claude one', codex: 'codex one', opencode: 'opencode one' });
      await prompted(id, HARNESSES, 2);
      await playRound(id, 2, { claude: 'claude two\nChanged: no', codex: 'codex two\nChanged: no', opencode: 'opencode two\nChanged: no' });
      await until(() => !!synthesisOf(x, id) && x.sessions.isLive(synthesisOf(x, id)!.id), 10_000, 'the synthesis session');
      const synth = synthesisOf(x, id)!;
      const runner = x.discussions as unknown as { cleanup: (d: unknown) => Promise<void> };
      const realCleanup = runner.cleanup.bind(runner);
      const gates: Array<() => void> = [];
      let cleaned = 0;
      // Hold both cleanups: the synthesis's, then the Stop's, so the Stop is in flight (status still running) when the synthesis's returns.
      runner.cleanup = async (d: unknown) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        try { return await realCleanup(d); } finally { cleaned++; }
      };
      try {
        const handle = x.sessions.handleOf(synth.id)!;
        x.adapters.claude.emit(handle, { type: 'assistant_text', text: 'The synthesis.' });
        x.adapters.claude.emit(handle, { type: 'turn_end', nativeSessionId: 'n-synth' });
        await until(() => gates.length === 1, 10_000, 'the synthesis cleanup is in flight');
        const stopping = x.discussions.stop(id);
        await until(() => gates.length === 2, 10_000, 'the Stop cleanup is in flight');
        expect(x.db.discussions.get(id)?.status).toBe('running');
        gates[0]!();
        await until(() => cleaned === 1, 10_000, 'the synthesis cleanup finished');
        await new Promise((resolve) => setTimeout(resolve, 50)); // give the synthesis continuation every chance to write done
        expect(x.db.discussions.get(id)?.synthesis).toBeNull();
        gates[1]!();
        const stopped = await stopping;
        expect(stopped.status).toBe('stopped');
        expect(x.db.discussions.get(id)?.status).toBe('stopped');
        expect(x.db.discussions.get(id)?.synthesis).toBeNull();
      } finally {
        runner.cleanup = realCleanup;
      }
    });

    it('cuts every quoted answer from the middle when the round prompt exceeds the harness input limit', () => {
      const limit = inputLimit('codex');
      const long = 'HEAD' + 'x'.repeat(700_000) + 'TAIL';
      const template = fs.readFileSync(path.join(x.config.promptsDir, 'discussion.md'), 'utf8');
      const prompt = buildRoundPrompt(template, { question: 'Q', round: 2, limit, answers: [
        { harness: 'claude', text: long, final: false },
        { harness: 'opencode', text: long, final: false },
      ] });
      expect(prompt.length).toBeLessThanOrEqual(limit);
      expect(prompt).toContain('characters omitted');
      expect(prompt).toContain('HEAD');
      expect(prompt).toContain('TAIL');
      expect(prompt).toContain('### claude');
      expect(prompt).toContain('### opencode');
    });

    it('keeps a quoted answer whole when the prompt fits under the limit', () => {
      const template = fs.readFileSync(path.join(x.config.promptsDir, 'discussion.md'), 'utf8');
      const prompt = buildRoundPrompt(template, { question: 'Q', round: 2, limit: inputLimit('codex'), answers: [
        { harness: 'codex', text: 'a short answer', final: true },
      ] });
      expect(prompt).toContain('### codex (final answer)\na short answer');
      expect(prompt).not.toContain('characters omitted');
    });
  });

  describe('start and teardown', () => {
    const discDir = (c: Ctx, id: string) => path.join(c.config.worktreesDir, REPO_ID, `disc-${id}`);

    it('usage-gates account-backed participants before starting them', async () => {
      const usageGate = vi.fn<typeof accountUsable>(async () => ({ usable: false, reason: 'account Demo Claude: session 83% >= 83% (85% - 1 running x 2%)' }));
      const c = setup({ usageGate });
      dirs.push(c.t.root, c.config.dataDir);
      try {
        useClaudeDiscussionAccount(c);
        await expect(c.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['claude'] })).rejects.toThrow('account Demo Claude: session 83%');
        const discussion = c.db.discussions.all()[0]!;
        expect(discussion.status).toBe('failed');
        expect(c.db.sessions.forDiscussion(discussion.id)).toEqual([]);
        expect(usageGate).toHaveBeenCalledWith(c.db, c.config, 'discussion-account', 'sonnet');
      } finally {
        c.db.sql.close();
      }
    });

    it('usage-gates the account-backed synthesis session too', async () => {
      const usageGate = vi.fn<typeof accountUsable>()
        .mockResolvedValueOnce({ usable: true })
        .mockResolvedValueOnce({ usable: false, reason: 'account Demo Claude: session 83% >= 83% (85% - 1 running x 2%)' });
      const c = setup({ usageGate });
      dirs.push(c.t.root, c.config.dataDir);
      try {
        useClaudeDiscussionAccount(c);
        const discussion = await c.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['claude'] });
        const participant = sessionOf(c, discussion.id, 'claude');
        const handle = c.sessions.handleOf(participant.id)!;
        answer(c, discussion.id, 'claude', 'Answer one\nChanged: yes');
        await until(() => c.db.discussions.turns(discussion.id).length === 1, 10_000, 'first discussion answer');
        await until(() => promptsOn(c, 'claude', handle).length >= 2, 10_000, 'second discussion round');
        answer(c, discussion.id, 'claude', 'Answer two\nChanged: no');
        await until(() => c.db.discussions.get(discussion.id)?.status === 'failed', 10_000, 'synthesis refused by usage gate');

        expect(usageGate.mock.calls.map((call) => [call[2], call[3]])).toEqual([['discussion-account', 'sonnet'], ['discussion-account', 'sonnet']]);
        expect(synthesisOf(c, discussion.id)).toBeUndefined();
        expect(c.db.sessions.forDiscussion(discussion.id).filter((session) => session.discussion_kind === 'synthesis')).toEqual([]);
      } finally {
        c.db.sql.close();
      }
    });

    it('waits for a delayed participant before tearing down after an early failure, so nothing it made survives', async () => {
      let late!: () => void;
      const lateGate = new Promise<void>((resolve) => { late = resolve; });
      const c = setup({ prepare: async (_id, harness) => {
        if (harness === 'codex') throw new Error('codex could not start');
        if (harness === 'opencode') { setTimeout(late, 300); await lateGate; }
      } });
      dirs.push(c.t.root, c.config.dataDir);
      try {
        await expect(c.discussions.create({ question: 'Q', repoId: REPO_ID })).rejects.toThrow(/codex could not start/);
        const row = c.db.discussions.all()[0]!;
        expect(row.status).toBe('failed');
        const rows = c.db.sessions.forDiscussion(row.id);
        expect(rows.map((s) => s.harness).sort()).toEqual(['claude', 'opencode']); // the late one did start before teardown
        expect(rows.every((s) => s.status !== 'running' && !c.sessions.isLive(s.id))).toBe(true);
        expect(fs.existsSync(discDir(c, row.id))).toBe(false);
        expect(sh(c.repo.path, ['worktree', 'list', '--porcelain'])).not.toContain(`disc-${row.id}`);
      } finally {
        c.db.sql.close();
      }
    });

    it('lets a Stop during a delayed start wait for it, so no session or worktree survives', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const c = setup({ prepare: async (_id, harness) => { if (harness === 'opencode') await gate; } });
      dirs.push(c.t.root, c.config.dataDir);
      try {
        const creating = c.discussions.create({ question: 'Q', repoId: REPO_ID });
        await until(() => c.db.discussions.all().length === 1 && c.db.sessions.forDiscussion(c.db.discussions.all()[0]!.id).length === 2, 10_000, 'two started');
        const id = c.db.discussions.all()[0]!.id;
        const stopping = c.discussions.stop(id);
        release();
        const [stopped] = await Promise.all([stopping, creating]);
        expect(stopped.status).toBe('stopped');
        const rows = c.db.sessions.forDiscussion(id);
        expect(rows).toHaveLength(3);
        expect(rows.every((s) => s.status === 'ended' && !c.sessions.isLive(s.id))).toBe(true);
        expect(fs.existsSync(discDir(c, id))).toBe(false);
        expect(sh(c.repo.path, ['worktree', 'list', '--porcelain'])).not.toContain(`disc-${id}`);
      } finally {
        c.db.sql.close();
      }
    });
  });

  describe('stop', () => {
    it('ends every session, removes the worktrees and marks the discussion stopped', async () => {
      const id = await three();
      const cwds = x.db.sessions.forDiscussion(id).map((s) => s.cwd);
      for (const cwd of cwds) expect(fs.existsSync(cwd)).toBe(true);
      const stopped = await x.discussions.stop(id);
      expect(stopped.status).toBe('stopped');
      expect(stopped.stop_reason).toBe('stopped by the user');
      expect(x.db.sessions.forDiscussion(id).every((s) => s.status === 'ended')).toBe(true);
      for (const cwd of cwds) expect(fs.existsSync(cwd)).toBe(false);
      expect(x.db.sessions.running().some((s) => s.discussion_id === id)).toBe(false);
    });
  });

  describe('sweeps', () => {
    it('never idle-ends or stall-sweeps a discussion session, while a worker in the same state is swept', async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-disc-sweep-'));
      dirs.push(cwd);
      const seed = (id: string, role: SessionRow['role']) => {
        x.db.sessions.insert({
          id, harness: 'claude', role, bead_id: role === 'worker' ? 'ov-1' : null, repo_id: REPO_ID, native_session_id: null,
          pid: null, pid_started_at: null, start_commit: null, cwd, status: 'running', started_at: at(30 * MINUTE),
          ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: 'standard', model: 'sonnet',
          discussion_id: role === 'discussion' ? 'd-x' : null,
        });
        for (const [type, payload] of [['assistant_text', { text: 'My answer.' }], ['turn_end', { nativeSessionId: 'n' }]] as const) {
          const row = x.db.events.append(id, type, payload);
          x.db.sql.prepare('UPDATE events SET ts=? WHERE id=?').run(at(21 * MINUTE), row.id);
        }
      };
      seed('s-disc', 'discussion');
      seed('s-worker', 'worker');

      const ended: string[] = [];
      await sweepIdleEnds({ db: x.db, idleEndMs: 3 * MINUTE, end: async (id) => { ended.push(id); } });
      expect(ended).toEqual(['s-worker']); // the discussion session is left alone

      const notified: string[] = [];
      await sweepStalls({ db: x.db, stallMs: 15 * MINUTE, notify: async (text) => { notified.push(text); } }, new Map());
      expect(notified).toHaveLength(1);
      expect(notified[0]).toContain('worker');
      expect(notified.some((t) => t.includes('discussion'))).toBe(false);
    });
  });

  describe('restart recovery', () => {
    it('marks a running discussion failed with "daemon restarted" and removes its worktrees', async () => {
      const id = await three();
      const cwds = x.db.sessions.forDiscussion(id).map((s) => s.cwd);
      await x.discussions.recover();
      const row = x.db.discussions.get(id)!;
      expect(row.status).toBe('failed');
      expect(row.stop_reason).toBe('daemon restarted');
      expect(row.ended_at).not.toBeNull();
      for (const cwd of cwds) expect(fs.existsSync(cwd)).toBe(false);
    });
  });

  describe('cost', () => {
    it('sums the reported cost when present and the estimate otherwise, per participant', async () => {
      const id = await three();
      const claude = sessionOf(x, id, 'claude');
      const codex = sessionOf(x, id, 'codex');
      const opencode = sessionOf(x, id, 'opencode');
      x.db.sessions.update(claude.id, { cost: 1.5, estimated_cost: 0.9 });
      x.db.sessions.update(codex.id, { cost: null, estimated_cost: 0.4 });
      x.db.sessions.update(opencode.id, { cost: null, estimated_cost: null });
      const detail = x.discussions.detail(id)!;
      const cost = (harness: HarnessName) => detail.participants.find((p) => p.harness === harness)!.cost;
      expect(cost('claude')).toBe(1.5);
      expect(cost('codex')).toBe(0.4);
      expect(cost('opencode')).toBe(0);
      expect(detail.cost).toBeCloseTo(1.9, 10);
      expect(x.discussions.list().find((d) => d.id === id)?.cost).toBeCloseTo(1.9, 10);
    });

    it('defaults the cap to five dollars', async () => {
      const id = await three();
      expect(x.db.discussions.get(id)?.cost_cap).toBe(5);
    });

    it('stores the cost cap the request names', async () => {
      const d = await x.discussions.create({ question: 'Q', repoId: REPO_ID, participants: ['claude'], costCap: 2.5 });
      expect(x.db.discussions.get(d.id)?.cost_cap).toBe(2.5);
    });
  });

  describe('board and office', () => {
    it('shows a discussion session on neither the Board nor the Office', async () => {
      const id = await three();
      const store = new MemoryTaskStore();
      store.add(x.repo.path, { id: 'ov-1', title: 'A bead' });
      // Worst case: a discussion row that names a bead, so only the role filter can keep it off the card.
      x.db.sessions.update(sessionOf(x, id, 'claude').id, { bead_id: 'ov-1' });
      const board = await buildBoard(x.db, store);
      const cards = board.repos.flatMap((r) => r.cards);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.session_id).toBeNull();
      expect(cards[0]!.harness).toBeNull();
      expect(cards[0]!.state).toBe('idle');

      const office = new Office(x.db, x.bus);
      expect(office.snapshot()).toEqual([]);
      const seen: string[] = [];
      x.bus.on('office', (s) => seen.push(s.session_id));
      x.bus.emit('session:started', x.db.sessions.get(sessionOf(x, id, 'claude').id)!);
      expect(seen).toEqual([]);
    });
  });
});
