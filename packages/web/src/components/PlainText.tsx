import type { ReactNode } from 'react';

/** Fences, bold and headings go; inline code is handled by the component, which keeps it as a span. */
const stripMarkers = (s: string) => s.replace(/```\w*/g, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '');

const inline = (text: string): ReactNode => text.split(/`([^`\n]+)`/).map((s, i) => (i % 2 ? <code key={i}>{s}</code> : s));
const cells = (line: string) => {
  const content = line.trim().slice(1, -1);
  const result: string[] = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    if (char === '\\' && content[i + 1] === '|') { cell += '|'; i++; }
    else if (char === '`') {
      // An unmatched opening backtick is literal, so later pipes still separate cells.
      if (inCode || content.indexOf('`', i + 1) !== -1) inCode = !inCode;
      cell += char;
    } else if (char === '|' && !inCode) { result.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  result.push(cell.trim());
  return result;
};
const tableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const separator = (line: string, count: number) => tableRow(line) && cells(line).length === count &&
  cells(line).every((cell) => /^:?-+:?$/.test(cell));

/** Strip markdown markers; optionally render review tables. Cell content stays in React text nodes. */
export function PlainText(p: { text: string; tables?: boolean }): ReactNode {
  const text = stripMarkers(p.text);
  if (!p.tables) return <>{inline(text)}</>;

  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let plain: string[] = [];
  const flush = () => { if (plain.length) blocks.push(<span key={blocks.length}>{inline(plain.join('\n'))}</span>); plain = []; };
  for (let i = 0; i < lines.length;) {
    if (i + 2 < lines.length && tableRow(lines[i]!) && separator(lines[i + 1]!, cells(lines[i]!).length) && tableRow(lines[i + 2]!)) {
      flush();
      const heads = cells(lines[i]!);
      const aligns = cells(lines[i + 1]!).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && tableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push(<div className="plain-table-scroll" key={blocks.length}><table><thead><tr>{heads.map((head, column) => <th key={column} style={{ textAlign: aligns[column] as 'left' | 'center' | 'right' }}>{inline(head)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{Array.from({ length: Math.max(heads.length, row.length) }, (_, column) => <td key={column} style={{ textAlign: aligns[column] as 'left' | 'center' | 'right' }}>{inline(row[column] ?? '')}</td>)}</tr>)}</tbody></table></div>);
    } else {
      plain.push(lines[i++]!);
    }
  }
  flush();
  return <>{blocks}</>;
}
