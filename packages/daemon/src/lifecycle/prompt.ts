import type { Bead } from '@overseer/shared';

export function render(template: string, vars: Record<string, string>): string {
  const withBlocks = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, body: string) => (vars[key] ? body : ''));
  return withBlocks.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '');
}

export interface WorkerPromptInput { bead: Bead; branch: string; base: string; conflicts: string[]; instructions?: string }

export function buildWorkerPrompt(template: string, i: WorkerPromptInput): string {
  return render(template, {
    id: i.bead.id,
    title: i.bead.title,
    description: i.bead.description,
    branch: i.branch,
    base: i.base,
    notes: i.bead.notes.trim(),
    conflicts: i.conflicts.map((f) => `- ${f}`).join('\n'),
    instructions: i.instructions?.trim() ?? '',
  });
}

export interface CriticPromptInput { bead: Bead; repoId: string; branch: string; base: string; diff: string; instructions?: string | null; workerText?: string | null; round: number; limit: number }

export function buildCriticPrompt(template: string, i: CriticPromptInput): string {
  return render(template, {
    id: i.bead.id,
    title: i.bead.title,
    description: i.bead.description,
    notes: i.bead.notes.trim(),
    repo: i.repoId,
    branch: i.branch,
    base: i.base,
    diff: i.diff.trim() || '(no changes)',
    instructions: i.instructions?.trim() ?? '',
    worker_text: i.workerText?.trim() ?? '',
    round: String(i.round),
    limit: String(i.limit),
  });
}

/**
 * The longest prompt a harness accepts, per harness. codex refuses a turn above 1,048,576 characters
 * (`input_too_large`, measured 2026-09-21 on a review round whose prompt was 1,348,800). claude and opencode publish no
 * character limit, so they carry the one measured ceiling rather than none; the limit belongs to the harness and is never
 * raised by configuration.
 */
const HARNESS_INPUT_LIMIT: Record<string, number> = { codex: 1_048_576 };
const DEFAULT_INPUT_LIMIT = 1_048_576;
export const inputLimit = (harness: string): number => HARNESS_INPUT_LIMIT[harness] ?? DEFAULT_INPUT_LIMIT;

/**
 * The notice a dropped section leaves behind, so the critic reads in the section's own place that it is gone and what to
 * do about it. A section that was empty to begin with stays empty: nothing was dropped there.
 */
const omissionNotice = (original: string | null | undefined, what: string, how: string): string =>
  original?.trim() ? `(${what}: the prompt carrying it was too large for this harness. ${how}.)` : '';

export interface BoundedCriticPrompt {
  prompt: string;
  /** What the prompt leaves out, in the order it was dropped; empty when the whole prompt fit. */
  omitted: string[];
}

/**
 * The critic prompt, reduced in fixed steps until it fits `limit`: the diff becomes the file list `stat`, then the
 * optional context goes, then the file list itself is clipped to whole lines, and only in the last resort the task
 * description. The task title and the `submit_review` instructions are never cut, so a reduced prompt still asks for a
 * verdict; the review criteria, which the description carries, survive every step except that last resort, where the
 * description is replaced by a notice that they are unavailable. Every step names what it dropped twice over: in `omitted`, for the bead note, and as a notice rendered into
 * the prompt in the place the removed section used to occupy, so the critic reads what is gone and where.
 */
export function boundedCriticPrompt(template: string, i: CriticPromptInput, limit: number, stat: string): BoundedCriticPrompt {
  const full = buildCriticPrompt(template, i);
  if (full.length <= limit) return { prompt: full, omitted: [] };
  const omitted = [`the diff of \`${i.base}\`, which made the prompt ${full.length} characters against the ${limit} the harness accepts`];
  const body = (files: string) => `The diff itself is not included: the prompt carrying it was ${full.length} characters and the harness accepts ${limit}. Read the change yourself in this worktree, file by file, with \`git diff ${i.base} -- <file>\`. The files it touches:

${files}`;
  let input: CriticPromptInput = { ...i, diff: body(stat) };
  let prompt = buildCriticPrompt(template, input);
  if (prompt.length <= limit) return { prompt, omitted };

  omitted.push("the notes from earlier rounds, the orchestrator's instructions to the worker and the worker's final message");
  input = {
    ...input,
    bead: { ...i.bead, notes: omissionNotice(i.bead.notes, 'The notes from earlier rounds are not included', 'Judge the change itself instead') },
    instructions: omissionNotice(i.instructions, "The orchestrator's instructions to the worker are not included", 'Nothing here replaces them'),
    workerText: omissionNotice(i.workerText, "The worker's final message is not included", 'Judge the change itself instead'),
  };
  prompt = buildCriticPrompt(template, input);
  if (prompt.length <= limit) return { prompt, omitted };

  // The file list is the cheapest thing left and the only part that still scales with the change, so it is clipped,
  // whole lines at a time, before the task description goes: the description is the review criteria, and a critic
  // without it cannot review anything, whatever else it still holds.
  const lines = stat.split('\n');
  const cut = (n: number) => `(${n} of ${lines.length} lines of the file list are not shown either; list them yourself with \`git diff --stat ${i.base}\`.)`;
  const clip = (from: CriticPromptInput) => {
    const budget = limit - buildCriticPrompt(template, { ...from, diff: body(`${cut(lines.length)}\n`) }).length;
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > budget) break;
      kept.push(line);
      used += line.length + 1;
    }
    return { kept, diff: body(`${[...kept, cut(lines.length - kept.length)].join('\n')}\n`) };
  };

  const clipped = clip(input);
  if (clipped.kept.length > 0) {
    const withList = buildCriticPrompt(template, { ...input, diff: clipped.diff });
    if (withList.length <= limit) {
      omitted.push(`${lines.length - clipped.kept.length} of the ${lines.length} lines of the file list`);
      return { prompt: withList, omitted };
    }
  }

  // Last resort: not even a clipped file list fits beside the description. The description goes, and its notice says the
  // criteria are unavailable rather than naming a command the critic is not allowed to run.
  omitted.push("the task's description, which carries the review criteria");
  input = {
    ...input,
    bead: { ...input.bead, description: omissionNotice(i.bead.description, "The task's description is not included", 'The criteria for this review are unavailable here, so report that instead of reviewing the change against criteria you cannot read') },
  };
  const last = clip(input);
  omitted.push(`${lines.length - last.kept.length} of the ${lines.length} lines of the file list`);
  return { prompt: buildCriticPrompt(template, { ...input, diff: last.diff }), omitted };
}
