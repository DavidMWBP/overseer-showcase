export interface CheckLineResult {
  pass: boolean;
  checkLines: string[];
  nonPassLines: string[];
}

/** A verification result passes only when it reports at least one well-formed PASS check and no other Check line. */
export function parseCheckLines(text: string): CheckLineResult {
  const lines = text.split(/\r?\n/).map((line) => {
    const original = line.trim();
    const normalized = original
      .replace(/^[-*>]\s+/, '')
      .replace(/^\*\*check:\*\*/i, 'Check:');
    return { original, normalized };
  });
  const checks = lines.filter(({ normalized }) => /^check:/i.test(normalized));
  const checkLines = checks.map(({ original }) => original);
  const nonPassLines = checks
    .filter(({ normalized }) => !/^check:\s+.+\s+[-–—]\s+pass\s+[-–—]\s+.+$/i.test(normalized))
    .map(({ original }) => original);
  return { pass: checkLines.length > 0 && nonPassLines.length === 0, checkLines, nonPassLines };
}
