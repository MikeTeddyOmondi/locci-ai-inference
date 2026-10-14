// What the user sent in the TUI, for Up/Down recall, kept across sessions as
// a shell keeps its history. Owner-only, like the login session file.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { aiFile } from './paths.js';

const HISTORY_FILE = aiFile('history.json');
const KEEP = 100;

export async function loadHistory(): Promise<string[]> {
  try {
    const data = JSON.parse(await readFile(HISTORY_FILE, 'utf8')) as { entries?: unknown };
    return Array.isArray(data.entries) ? data.entries.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

/** Add an entry (not twice in a row) and keep the newest KEEP. */
export async function remember(entries: string[], text: string): Promise<string[]> {
  const next = entries.at(-1) === text ? entries : [...entries, text].slice(-KEEP);
  try {
    await mkdir(path.dirname(HISTORY_FILE), { recursive: true, mode: 0o700 });
    await writeFile(HISTORY_FILE, JSON.stringify({ entries: next }, null, 2), { mode: 0o600 });
  } catch {
    // Recall still works for this session.
  }
  return next;
}
