import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PlainText } from './PlainText';
import fs from 'node:fs';
import path from 'node:path';

describe('PlainText', () => {
  it('renders inline code as <code> without the backticks and strips the other markers', () => {
    const { container } = render(<p><PlainText text={'## Done\nverify command `node -e "process.exit(1)"` **failed**; ```sh\n$ cat r2.txt\n```'} /></p>);
    const codes = [...container.querySelectorAll('code')].map((c) => c.textContent);
    expect(codes).toEqual(['node -e "process.exit(1)"']);
    expect(container.textContent).toBe('Done\nverify command node -e "process.exit(1)" failed; \n$ cat r2.txt\n');
  });

  it('never turns text into markup: tags stay literal inside and outside code spans', () => {
    const { container } = render(<p><PlainText text={'<script>alert(1)</script> and `<b>bold</b>` <img src=x onerror=alert(1)>'} /></p>);
    expect(container.querySelector('script, b, img')).toBeNull();
    expect(container.textContent).toBe('<script>alert(1)</script> and <b>bold</b> <img src=x onerror=alert(1)>');
    expect(container.querySelector('code')!.textContent).toBe('<b>bold</b>');
  });

  it('leaves an unclosed backtick alone', () => {
    const { container } = render(<p><PlainText text="a `b c" /></p>);
    expect(container.querySelector('code')).toBeNull();
    expect(container.textContent).toBe('a `b c');
  });

  it('renders a two-column table with header and body rows', () => {
    const { container } = render(<PlainText text={'| Check | Result |\n| --- | --- |\n| typecheck | pass |\n| test | pass |'} tables />);
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect([...container.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['Check', 'Result']);
    expect([...container.querySelectorAll('tbody tr')].map((row) => row.textContent)).toEqual(['typecheckpass', 'testpass']);
  });

  it('renders inline code in a cell', () => {
    const { container } = render(<PlainText text={'| Check | Result |\n| --- | --- |\n| `pnpm test` | pass |'} tables />);
    expect(container.querySelector('td code')?.textContent).toBe('pnpm test');
  });

  it('keeps pipes inside code and escaped pipes in their cells', () => {
    const { container } = render(<PlainText text={'| Check | Result |\n| --- | --- |\n| `a | b` | x \\| y |'} tables />);
    expect([...container.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['a | b', 'x | y']);
    expect(container.querySelector('td code')?.textContent).toBe('a | b');
  });

  it('splits after an unmatched backtick while leaving it literal', () => {
    const { container } = render(<PlainText text={'| Check | Result |\n| --- | --- |\n| `unclosed | pass |'} tables />);
    expect([...container.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['`unclosed', 'pass']);
    expect(container.querySelector('td code')).toBeNull();
  });

  it('keeps HTML-looking cell text literal', () => {
    const { container } = render(<PlainText text={'| Check | Result |\n| --- | --- |\n| <b>safe</b> | pass |'} tables />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('td')?.textContent).toBe('<b>safe</b>');
  });

  it('preserves prose before and after a table', () => {
    const { container } = render(<PlainText text={'Before `check`\n| Check | Result |\n| --- | --- |\n| test | pass |\nAfter **review**'} tables />);
    expect(container.textContent).toContain('Before check');
    expect(container.textContent).toContain('After review');
    expect(container.querySelector('span code')?.textContent).toBe('check');
  });

  it('leaves lines with pipes but no separator as text', () => {
    const { container } = render(<PlainText text={'| Check | Result |\n| test | pass |'} tables />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toBe('| Check | Result |\n| test | pass |');
  });

  it('applies separator colon alignment', () => {
    const { container } = render(<PlainText text={'| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |'} tables />);
    expect([...container.querySelectorAll('th, td')].map((cell) => (cell as HTMLElement).style.textAlign)).toEqual(['left', 'center', 'right', 'left', 'center', 'right']);
  });

  it('pads short rows and retains extra cells', () => {
    const { container } = render(<PlainText text={'| A | B |\n| --- | --- |\n| one |\n| one | two | three |'} tables />);
    expect([...container.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))).toEqual([['one', ''], ['one', 'two', 'three']]);
  });

  it('keeps an empty cell', () => {
    const { container } = render(<PlainText text={'| A | B |\n| --- | --- |\n| | value |'} tables />);
    expect([...container.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['', 'value']);
  });

  it('leaves tables off by default for Chat and other callers', () => {
    const { container } = render(<PlainText text={'| A | B |\n| --- | --- |\n| one | two |'} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('| one | two |');
  });

  it('keeps the table overflow rule in the stylesheet', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.plain-table-scroll\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/);
    expect(css).toMatch(/\.plain-table-scroll th, \.plain-table-scroll td\s*\{[^}]*min-width:\s*8rem;/);
    expect(css).toMatch(/\.plain-table-scroll th, \.plain-table-scroll td\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  });
});
