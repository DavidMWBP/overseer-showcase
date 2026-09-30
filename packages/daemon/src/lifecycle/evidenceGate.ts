import fs from 'node:fs';
import path from 'node:path';

export interface EvidenceGateInput {
  description: string;
  finalText: string;
  headSha: string;
  worktreePath: string;
}

export type EvidenceGateResult = { ok: true } | { ok: false; problems: string[] };

interface ParityConfig {
  optedIn: boolean;
  widths: string[];
  locales: string[] | null;
}

interface ReportLine {
  original: string;
  normalized: string;
}

function directiveValue(description: string, name: 'Parity widths' | 'Parity locales'): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = description.split(/\r?\n/).map((line) => line.trim())
    .map((line) => new RegExp(`^${escapedName}:\\s*(.*?)\\s*$`, 'i').exec(line))
    .find((result) => result !== null);
  return match?.[1] ?? null;
}

function parseList(value: string, label: 'Parity widths' | 'Parity locales', problems: string[]): string[] {
  const entries = value.split(',').map((entry) => entry.trim());
  const values = entries.filter(Boolean);
  if (values.length === 0) {
    problems.push(`The ${label} line declares no ${label === 'Parity widths' ? 'widths' : 'locales'}.`);
  } else if (values.length !== entries.length) {
    problems.push(`The ${label} line contains an empty list entry.`);
  }
  return [...new Set(values)];
}

function parseConfig(description: string, problems: string[]): ParityConfig {
  const widthValue = directiveValue(description, 'Parity widths');
  if (widthValue === null) return { optedIn: false, widths: [], locales: null };

  const widths = parseList(widthValue, 'Parity widths', problems);
  const localeValue = directiveValue(description, 'Parity locales');
  const locales = localeValue === null ? null : parseList(localeValue, 'Parity locales', problems);
  return { optedIn: true, widths, locales };
}

function normalizeReportLines(text: string): ReportLine[] {
  return text.split(/\r?\n/).map((line) => {
    const original = line.trim();
    const normalized = original
      .replace(/^[-*>]\s+/, '')
      .replace(/^\*\*parity:\*\*/i, 'Parity:')
      .replace(/^\*\*evidence:\*\*/i, 'Evidence:');
    return { original, normalized };
  });
}

function hasMatchingShaPrefix(sha: string, headSha: string): boolean {
  const reported = sha.toLowerCase();
  const head = headSha.toLowerCase();
  return Math.min(reported.length, head.length) >= 7
    && (reported.startsWith(head) || head.startsWith(reported));
}

function pairKey(width: string, locale: string): string {
  return `${width}\0${locale.toLowerCase()}`;
}

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const PERCENTAGE_PATTERN = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)%$/i;
const GAP_SCORE_PATTERN = /^\d+\s+gaps,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i;

function isValidScore(score: string): boolean {
  const trimmed = score.trim();
  const gapScore = GAP_SCORE_PATTERN.exec(trimmed);
  const percentage = PERCENTAGE_PATTERN.exec(trimmed);
  const numericScore = gapScore?.[1] ?? percentage?.[1] ?? trimmed;
  return (gapScore !== null || percentage !== null || NUMBER_PATTERN.test(trimmed)) && Number.isFinite(Number(numericScore));
}

function isAbsoluteLocalPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isInsideWorktree(localPath: string, worktreePath: string): boolean | null {
  if (path.isAbsolute(localPath) && isPathInside(localPath, worktreePath)) return true;

  try {
    return isPathInside(fs.realpathSync.native(path.resolve(localPath)), fs.realpathSync.native(worktreePath));
  } catch {
    return null;
  }
}

function isExistingFile(localPath: string): boolean {
  if (!path.isAbsolute(localPath)) return false;
  try {
    return fs.statSync(localPath).isFile();
  } catch {
    return false;
  }
}

function localEvidenceParts(content: string): { localPath: string; caption: string } | null {
  const candidates: { localPath: string; caption: string }[] = [];
  const separator = /\s+-\s+/g;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(content)) !== null) {
    const localPath = content.slice(0, match.index).trimEnd();
    if (isAbsoluteLocalPath(localPath)) {
      candidates.push({ localPath, caption: content.slice(match.index + match[0].length).trim() });
    }
  }

  return candidates.find(({ localPath }) => isExistingFile(localPath)) ?? candidates[0] ?? null;
}

export function evidenceGateApplies(description: string, finalText: string): boolean {
  const config = parseConfig(description, []);
  const reportLines = normalizeReportLines(finalText);
  return config.optedIn || reportLines.some(({ normalized }) => /^(?:parity|evidence):/i.test(normalized));
}

/** Checks parity rows against a task's optional declared widths and validates every evidence line. */
export function evaluateEvidence({ description, finalText, headSha, worktreePath }: EvidenceGateInput): EvidenceGateResult {
  const problems: string[] = [];
  const config = parseConfig(description, problems);
  const reportLines = normalizeReportLines(finalText);
  const parityLines = reportLines.filter(({ normalized }) => /^parity:/i.test(normalized));
  const evidenceLines = reportLines.filter(({ normalized }) => /^evidence:/i.test(normalized));

  if (config.optedIn && parityLines.length === 0) {
    problems.push('The opted-in report contains no Parity line.');
  }

  const frames = new Set<string>();
  const reportedWidths = new Map<string, Set<string>>();
  const reportedPairs = new Map<string, Set<string>>();

  for (const { original, normalized } of parityLines) {
    const fields = normalized.slice(normalized.indexOf(':') + 1).split('|').map((field) => field.trim());
    const [frame = '', widthField = '', locale = '', score = '', sha = ''] = fields;

    if (fields.length < 5) {
      problems.push(`Parity line "${original}" has fewer than five fields.`);
    }
    if (!frame) {
      problems.push(`Parity line "${original}" has an empty frame field.`);
    } else {
      frames.add(frame);
    }
    if (!locale) {
      problems.push(`Parity line "${original}" has an empty locale field.`);
    }
    if (fields.length >= 4 && !isValidScore(score)) {
      problems.push(`Parity line "${original}" has an invalid score "${score}".`);
    }
    if (fields.length >= 5 && !hasMatchingShaPrefix(sha, headSha)) {
      problems.push(`Parity line "${original}" SHA "${sha}" does not match head "${headSha}" by a 7-character prefix.`);
    }

    const width = widthField.replace(/px$/i, '').trim();
    if (frame && locale && width) {
      const frameWidths = reportedWidths.get(frame) ?? new Set<string>();
      const framePairs = reportedPairs.get(frame) ?? new Set<string>();
      frameWidths.add(width);
      framePairs.add(pairKey(width, locale));
      reportedWidths.set(frame, frameWidths);
      reportedPairs.set(frame, framePairs);
    }
  }

  for (const frame of frames) {
    const frameWidths = reportedWidths.get(frame) ?? new Set<string>();
    const framePairs = reportedPairs.get(frame) ?? new Set<string>();
    for (const width of config.widths) {
      if (config.locales === null) {
        if (!frameWidths.has(width)) {
          problems.push(`Frame "${frame}" is missing parity evidence for ${width}px.`);
        }
        continue;
      }
      for (const locale of config.locales) {
        if (!framePairs.has(pairKey(width, locale))) {
          problems.push(`Frame "${frame}" is missing parity evidence for ${width}px in locale "${locale}".`);
        }
      }
    }
  }

  for (const { original, normalized } of evidenceLines) {
    const content = normalized.slice(normalized.indexOf(':') + 1).trim();
    const httpsMatch = /^(https:\/\/\S+)\s+-\s+(.+?)\s*$/.exec(content);
    if (content.startsWith('https://')) {
      if (!httpsMatch || !httpsMatch[2]?.trim()) {
        problems.push(`Evidence line "${original}" must be a valid HTTPS URL and include a caption.`);
      }
      continue;
    }

    const localEvidence = localEvidenceParts(content);
    if (!localEvidence) {
      const noCaptionPath = /^(.+?)\s+-\s*$/.exec(content)?.[1] ?? content;
      if (isAbsoluteLocalPath(noCaptionPath)) {
        problems.push(`Evidence line "${original}" must include a caption.`);
      } else {
        problems.push(`Evidence line "${original}" must use an absolute local path and include a caption.`);
      }
      continue;
    }

    const insideWorktree = isInsideWorktree(localEvidence.localPath, worktreePath);
    if (!localEvidence.caption) {
      problems.push(`Evidence line "${original}" must include a caption.`);
    } else if (insideWorktree === true) {
      problems.push(`Evidence line "${original}" points inside the bead worktree.`);
    } else if (!isExistingFile(localEvidence.localPath)) {
      problems.push(`Evidence line "${original}" does not point to an existing file at gate time.`);
    } else if (insideWorktree === null) {
      problems.push(`Evidence line "${original}" could not be confirmed outside the bead worktree.`);
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
