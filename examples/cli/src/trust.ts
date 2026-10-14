// Folders the user has let `chat` and the TUI run commands in, asked once per
// folder at start (as Claude Code asks before working in a new folder). Each
// command still asks unless YOLO mode is on.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { aiFile } from './paths.js';

const TRUST_FILE = aiFile('trusted-folders.json');

async function load(): Promise<string[]> {
  try {
    const list = JSON.parse(await readFile(TRUST_FILE, 'utf8')) as { folders?: unknown };
    return Array.isArray(list.folders) ? list.folders.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether the user already allowed commands in this exact folder. */
export async function isTrusted(dir: string): Promise<boolean> {
  return (await load()).includes(path.resolve(dir));
}

/** Remember the folder, so the next start doesn't ask. */
export async function trust(dir: string): Promise<void> {
  const folders = await load();
  const resolved = path.resolve(dir);
  if (folders.includes(resolved)) return;
  await mkdir(path.dirname(TRUST_FILE), { recursive: true, mode: 0o700 });
  await writeFile(TRUST_FILE, JSON.stringify({ folders: [...folders, resolved] }, null, 2), { mode: 0o600 });
}

export const TRUST_QUESTION = (dir: string) =>
  `Let the AI run commands in ${dir}? It can read, change and delete files there.`;
