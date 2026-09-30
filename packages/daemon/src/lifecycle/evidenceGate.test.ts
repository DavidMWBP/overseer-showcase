import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateEvidence as evaluateEvidenceAtPath, evidenceGateApplies } from './evidenceGate';

const headSha = '1234567890abcdef1234567890abcdef12345678';
const optedIn = 'Parity widths: 390, 430';
const worktreePath = findWorktreeRoot(process.cwd());

function findWorktreeRoot(start: string): string {
  let candidate = path.resolve(start);
  while (!fs.existsSync(path.join(candidate, '.git'))) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return path.resolve(start);
    candidate = parent;
  }
  return candidate;
}

function evaluateEvidence(input: Omit<Parameters<typeof evaluateEvidenceAtPath>[0], 'worktreePath'> & { worktreePath?: string }) {
  return evaluateEvidenceAtPath({ ...input, worktreePath: input.worktreePath ?? worktreePath });
}

function withTemporaryEvidenceDirectory(run: (directory: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-gate-'));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasGitAncestor(candidate: string): boolean {
  let current = path.resolve(candidate);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function parity(frame: string, width: number | string, locale = 'en', score: string | number = 8, sha = headSha): string {
  const widthField = typeof width === 'number' ? `${width}px` : width;
  return `Parity: ${frame} | ${widthField} | ${locale} | ${score} | ${sha}`;
}

describe('evaluateEvidence', () => {
  it('requires a Parity line when widths are declared', () => {
    const result = evaluateEvidence({ description: optedIn, finalText: 'All 17 frames pass.', headSha });

    expect(result).toEqual({ ok: false, problems: ['The opted-in report contains no Parity line.'] });
  });

  it('accepts short and full matching SHAs', () => {
    const result = evaluateEvidence({
      description: optedIn,
      finalText: [
        parity('Frame A', 390, 'en', 8, headSha.slice(0, 7)),
        parity('Frame A', 430, 'en', 8, headSha),
      ].join('\n'),
      headSha,
    });

    expect(result).toEqual({ ok: true });
  });

  it('accepts the head SHA as a short prefix of the reported full SHA', () => {
    expect(evaluateEvidence({
      description: 'Parity widths: 390',
      finalText: parity('Frame A', 390, 'en', 8, `${headSha}abcdef`),
      headSha: headSha.slice(0, 7),
    })).toEqual({ ok: true });
  });

  it('rejects a stale SHA and names the line and head', () => {
    const line = parity('Frame A', 390, 'en', 8, 'abcdef0123456789');
    const result = evaluateEvidence({ description: 'Parity widths: 390', finalText: line, headSha });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain(`Parity line "${line}" SHA "abcdef0123456789" does not match head "${headSha}" by a 7-character prefix.`);
  });

  it('requires every declared width for every reported frame, including a new placeholder frame', () => {
    const result = evaluateEvidence({
      description: optedIn,
      finalText: [
        parity('Frame A', 390),
        parity('Frame A', 430),
        parity('Frame TBD', 390),
      ].join('\n'),
      headSha,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('Frame "Frame TBD" is missing parity evidence for 430px.');
  });

  it('requires each declared width and locale pair', () => {
    const result = evaluateEvidence({
      description: `${optedIn}\nParity locales: en, fr`,
      finalText: [
        parity('Frame A', 390, 'en'),
        parity('Frame A', 430, 'en'),
        parity('Frame A', 390, 'fr'),
      ].join('\n'),
      headSha,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('Frame "Frame A" is missing parity evidence for 430px in locale "fr".');
  });

  it('matches declared locales without regard to case', () => {
    expect(evaluateEvidence({
      description: `${optedIn}\nParity locales: en`,
      finalText: [parity('Frame A', 390, 'EN'), parity('Frame A', 430, 'EN')].join('\n'),
      headSha,
    })).toEqual({ ok: true });
  });

  it('accepts widths with or without the px suffix', () => {
    expect(evaluateEvidence({
      description: optedIn,
      finalText: [parity('Frame A', '390'), parity('Frame A', 430)].join('\n'),
      headSha,
    })).toEqual({ ok: true });
  });

  it('allows any locale when Parity locales is absent and accepts score zero', () => {
    expect(evaluateEvidence({
      description: optedIn,
      finalText: [parity('Frame A', 390, 'nl-NL', 0), parity('Frame A', 430, 'en-US', 10)].join('\n'),
      headSha,
    })).toEqual({ ok: true });
  });

  it('accepts plain decimal and gap-count score formats', () => {
    expect(evaluateEvidence({
      description: optedIn,
      finalText: [
        parity('Frame A', 390, 'en', '0.97'),
        parity('Frame A', 430, 'en', '0 gaps, 1.00'),
      ].join('\n'),
      headSha,
    })).toEqual({ ok: true });
  });

  it.each(['0', '93', '93.0', '1e2'])('accepts plain numeric score %s', (score) => {
    expect(evaluateEvidence({
      description: 'Parity widths: 430',
      finalText: parity('Frame A', 430, 'EN', score),
      headSha,
    })).toEqual({ ok: true });
  });

  it.each(['88%', '100%', '97.5%', '93.0%', '0%'])('accepts percentage score %s', (score) => {
    expect(evaluateEvidence({
      description: 'Parity widths: 390',
      finalText: parity('Frame A', 390, 'en', score),
      headSha,
    }).ok).toBe(true);
  });

  it('accepts duplicate lines without creating missing pairs', () => {
    const line = parity('Frame A', 390);
    expect(evaluateEvidence({
      description: 'Parity widths: 390',
      finalText: `${line}\n${line}`,
      headSha,
    })).toEqual({ ok: true });
  });

  it('rejects a non-numeric score', () => {
    const result = evaluateEvidence({
      description: 'Parity widths: 390',
      finalText: parity('Frame A', 390, 'en', 'high'),
      headSha,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('Parity line "Parity: Frame A | 390px | en | high | 1234567890abcdef1234567890abcdef12345678" has an invalid score "high".');
  });

  it.each(['88 %', '%', 'high', '', 'NaN', 'Infinity', '1e309', '1e309%', '0 gaps, 1e309', '0 gaps, 93.0%'])('rejects invalid Parity score %s', (score) => {
    expect(evaluateEvidence({
      description: 'Parity widths: 390',
      finalText: parity('Frame A', 390, 'en', score),
      headSha,
    }).ok).toBe(false);
  });

  it('rejects a gap score without a numeric score value', () => {
    const line = parity('Frame A', 390, 'en', '0 gaps, many');
    const result = evaluateEvidence({ description: 'Parity widths: 390', finalText: line, headSha });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain(`Parity line "${line}" has an invalid score "0 gaps, many".`);
  });

  it('rejects a Parity line with fewer than five fields', () => {
    const line = 'Parity: Frame A | 390px | en | 8';
    const result = evaluateEvidence({ description: 'Parity widths: 390', finalText: line, headSha });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain(`Parity line "${line}" has fewer than five fields.`);
  });

  it('rejects a missing local path written like an upload fragment', () => {
    const line = 'Evidence: /uploads/abc123/frame.png - Frame A at 390px';
    const result = evaluateEvidence({ description: '', finalText: line, headSha });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain(`Evidence line "${line}" does not point to an existing file at gate time.`);
  });

  it('rejects an Evidence URL without a caption', () => {
    const line = 'Evidence: https://example.test/frame.png';
    const result = evaluateEvidence({ description: '', finalText: line, headSha });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain(`Evidence line "${line}" must be a valid HTTPS URL and include a caption.`);
  });

  it('accepts an existing absolute local evidence file outside the worktree and live data', () => {
    withTemporaryEvidenceDirectory((directory) => {
      const filePath = path.join(directory, 'frame capture.png');
      fs.writeFileSync(filePath, 'fixture image');
      const result = evaluateEvidence({
        description: '',
        finalText: `Evidence: ${filePath} - Frame at 390px - light theme`,
        headSha,
      });

      expect({
        result,
        outsideWorktree: !isWithin(directory, worktreePath),
        outsideLiveData: !isWithin(directory, path.join(os.homedir(), '.overseer')),
        outsideGitRepo: !hasGitAncestor(directory),
      }).toEqual({
        result: { ok: true },
        outsideWorktree: true,
        outsideLiveData: true,
        outsideGitRepo: true,
      });
    });
  });

  it('rejects a local evidence path inside the worktree and names the reason', () => {
    const filePath = path.join(worktreePath, 'package.json');
    const line = `Evidence: ${filePath} - Worktree package file`;
    const result = evaluateEvidence({ description: '', finalText: line, headSha });

    expect(result).toEqual({ ok: false, problems: [`Evidence line "${line}" points inside the bead worktree.`] });
  });

  it('rejects a missing local evidence file', () => {
    withTemporaryEvidenceDirectory((directory) => {
      const line = `Evidence: ${path.join(directory, 'missing capture.png')} - Frame at 390px`;
      const result = evaluateEvidence({ description: '', finalText: line, headSha });

      expect(result).toEqual({ ok: false, problems: [`Evidence line "${line}" does not point to an existing file at gate time.`] });
    });
  });

  it('rejects a local evidence path without a caption', () => {
    withTemporaryEvidenceDirectory((directory) => {
      const filePath = path.join(directory, 'frame capture.png');
      fs.writeFileSync(filePath, 'fixture image');
      const line = `Evidence: ${filePath}`;
      const result = evaluateEvidence({ description: '', finalText: line, headSha });

      expect(result).toEqual({ ok: false, problems: [`Evidence line "${line}" must include a caption.`] });
    });
  });

  it('rejects a relative local evidence path', () => {
    const line = 'Evidence: relative/frame.png - Frame at 390px';
    const result = evaluateEvidence({ description: '', finalText: line, headSha });

    expect(result).toEqual({ ok: false, problems: [`Evidence line "${line}" must use an absolute local path and include a caption.`] });
  });

  it('accepts list markers and bold labels on Parity and Evidence lines', () => {
    const result = evaluateEvidence({
      description: optedIn,
      finalText: [
        `- **Parity:** Frame A | 390px | en | 8 | ${headSha.slice(0, 7)}`,
        `* **Parity:** Frame A | 430px | en | 8 | ${headSha}`,
        '**Evidence:** https://example.test/frame.png - Frame A at 390px',
      ].join('\n'),
      headSha,
    });

    expect(result).toEqual({ ok: true });
  });

  it('does not require parity or upload evidence without opt-in', () => {
    expect(evaluateEvidence({ description: 'No parity widths are declared.', finalText: '', headSha })).toEqual({ ok: true });
  });

  it('skips checks only when there is no opt-in and no Parity or Evidence line', () => {
    expect(evidenceGateApplies('', '')).toBe(false);
    expect(evidenceGateApplies('No parity widths are declared.', 'The work is complete.')).toBe(false);
    expect(evidenceGateApplies(optedIn, '')).toBe(true);
    expect(evidenceGateApplies('', parity('Frame A', 390))).toBe(true);
    expect(evidenceGateApplies('', 'Evidence: https://example.test/frame.png - Frame A')).toBe(true);
  });

  it('reports an empty Parity widths declaration', () => {
    const result = evaluateEvidence({ description: 'Parity widths: ', finalText: parity('Frame A', 390), headSha });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('The Parity widths line declares no widths.');
  });

  it('reports an explicitly empty Parity locales declaration', () => {
    const result = evaluateEvidence({
      description: 'Parity widths: 390\nParity locales: ',
      finalText: parity('Frame A', 390),
      headSha,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('The Parity locales line declares no locales.');
  });
});
