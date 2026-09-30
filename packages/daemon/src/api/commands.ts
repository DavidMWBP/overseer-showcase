import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { RepoCommand } from '@overseer/shared';

type CommandSource = RepoCommand['source'];
type Frontmatter = Record<string, unknown>;

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function directoryAt(parent: string, name: string): string | undefined {
  const target = path.join(parent, name);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  return stat.isDirectory() && !stat.isSymbolicLink() ? target : undefined;
}

function fileAt(parent: string, name: string): string | undefined {
  const target = path.join(parent, name);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  return stat.isFile() && !stat.isSymbolicLink() ? target : undefined;
}

function readFrontmatter(contents: string): Frontmatter | undefined {
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 0) return undefined;
  try {
    const document = parseDocument(lines.slice(1, closing).join('\n'));
    if (document.errors.length) return undefined;
    const value = document.toJS();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Frontmatter : undefined;
  } catch {
    return undefined;
  }
}

function descriptionOf(frontmatter: Frontmatter | undefined): string {
  const description = frontmatter?.description;
  return typeof description === 'string' ? (description.split(/\r?\n/, 1)[0] ?? '').trim() : '';
}

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return ''; }
}

function commandFiles(directory: string, parts: string[] = []): RepoCommand[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const commands: RepoCommand[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const child = directoryAt(directory, entry.name);
      if (child) commands.push(...commandFiles(child, [...parts, entry.name]));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = fileAt(directory, entry.name);
    if (!file) continue;
    const frontmatter = readFrontmatter(readText(file));
    const stem = entry.name.slice(0, -'.md'.length);
    commands.push({ name: [...parts, stem].join(':'), description: descriptionOf(frontmatter), kind: 'command', source: 'repo' });
  }
  return commands;
}

function skillFiles(directory: string, source: CommandSource): RepoCommand[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const skills: RepoCommand[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const folder = directoryAt(directory, entry.name);
    const file = folder && fileAt(folder, 'SKILL.md');
    if (!file) continue;
    const frontmatter = readFrontmatter(readText(file));
    const name = frontmatter?.name;
    skills.push({
      name: typeof name === 'string' && name.trim() ? name.trim() : entry.name,
      description: descriptionOf(frontmatter),
      kind: 'skill',
      source,
    });
  }
  return skills;
}

function commandsAt(base: string, source: CommandSource): RepoCommand[] {
  const claude = directoryAt(base, '.claude');
  if (!claude) return [];
  const commands = directoryAt(claude, 'commands');
  const skills = directoryAt(claude, 'skills');
  return [
    ...(commands ? commandFiles(commands).map((entry) => ({ ...entry, source })) : []),
    ...(skills ? skillFiles(skills, source) : []),
  ];
}

function precedence(entry: RepoCommand): number {
  return (entry.source === 'repo' ? 2 : 0) + (entry.kind === 'skill' ? 1 : 0);
}

export function listRepoCommands(repoPath: string, homeDir = os.homedir()): RepoCommand[] {
  const entries = [...commandsAt(repoPath, 'repo'), ...commandsAt(homeDir, 'global')];
  const byName = new Map<string, RepoCommand>();
  for (const entry of entries) {
    const previous = byName.get(entry.name);
    if (!previous || precedence(entry) > precedence(previous)) byName.set(entry.name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
