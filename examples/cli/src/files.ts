// The client side of the API's `read_file` and `write_file` tools, rooted at
// the folder `chat` or the TUI was started in: a path that leaves it (`..`, an
// absolute path elsewhere, a symlink out) is refused.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** What goes back to the model, as for `shell`. */
const MAX_CHARS = Number(process.env.LOCCI_SHELL_MAX_CHARS) || 8_000;

/** The nearest part of `p` that exists, resolved through symlinks. */
async function realExisting(p: string): Promise<string> {
  let probe = p;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const real = await realpath(probe);
  return path.join(real, path.relative(probe, p));
}

/** `rel` inside `root`, or an error saying why not. */
export async function inside(root: string, rel: string): Promise<string> {
  const realRoot = await realpath(root);
  const target = await realExisting(path.resolve(root, rel));
  const back = path.relative(realRoot, target);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(`${rel} is outside the project folder (${root}); only paths inside it can be used`);
  }
  return target;
}

export async function readTool(root: string, rel: string): Promise<string> {
  try {
    const file = await inside(root, rel);
    const info = await stat(file);
    if (info.isDirectory()) {
      const entries = await readdir(file, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join('\n') || '(empty folder)';
    }
    const text = await readFile(file, 'utf8');
    if (text.includes('\u0000')) return `${rel} is a binary file (${info.size} bytes)`;
    return text.length > MAX_CHARS
      ? `${text.slice(0, MAX_CHARS)}\n[... cut: the file is ${text.length} characters, ${text.split('\n').length} lines]`
      : text || '(empty file)';
  } catch (err) {
    return `Could not read ${rel}: ${(err as Error).message}`;
  }
}

/** Whether the write creates the file, for the approval prompt. */
export async function exists(root: string, rel: string): Promise<boolean> {
  try {
    return existsSync(await inside(root, rel));
  } catch {
    return false;
  }
}

/** What a file holds after a change, so the model can check its work against the request. */
function nowReads(text: string): string {
  const shown = text.length > 2_000 ? `${text.slice(0, 2_000)}\n[... ${text.length - 2_000} more characters]` : text;
  return `The file now reads:\n${shown}`;
}

/**
 * Why a write would change nothing, or null. Small models "fix" a file by
 * writing it back as it was and then say it is done; this tells them it isn't.
 */
export async function unchanged(root: string, rel: string, content: string): Promise<string | null> {
  try {
    const file = await inside(root, rel);
    if (!existsSync(file) || (await readFile(file, 'utf8')) !== content) return null;
    return `Nothing changed: that content is exactly what ${rel} already holds, so the request is not done yet. Write the file as it should read after the change.`;
  } catch {
    return null;
  }
}

export async function writeTool(root: string, rel: string, content: string): Promise<string> {
  try {
    const file = await inside(root, rel);
    const existed = existsSync(file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    return `${existed ? 'Replaced' : 'Created'} ${rel} (${lines} lines). ${nowReads(content)}`;
  } catch (err) {
    return `Could not write ${rel}: ${(err as Error).message}`;
  }
}

/** Where `find` occurs in `text`. */
function occurrences(text: string, find: string): number {
  return find ? text.split(find).length - 1 : 0;
}

/**
 * Check an edit before asking: the exact text has to be there, once (or `all`).
 * Returns the new content, or why the edit can't be made, for the model.
 */
export async function planEdit(
  root: string,
  rel: string,
  find: string,
  replace: string,
  all: boolean,
): Promise<{ ok: true; file: string; before: string; after: string; count: number } | { ok: false; error: string }> {
  try {
    const file = await inside(root, rel);
    if (!existsSync(file)) return { ok: false, error: `${rel} doesn't exist. Use write_file to create it.` };
    const before = await readFile(file, 'utf8');
    const count = occurrences(before, find);
    if (count === 0) {
      return {
        ok: false,
        error: `old_text was not found in ${rel}, so nothing was changed. Copy it exactly from the file (read_file shows it). ${nowReads(before)}`,
      };
    }
    if (count > 1 && !all) {
      return {
        ok: false,
        error: `old_text appears ${count} times in ${rel}, so nothing was changed. Set all to true to change every one, or include more of the surrounding text to pick one.`,
      };
    }
    const after = all ? before.split(find).join(replace) : before.replace(find, () => replace);
    if (after === before) {
      return { ok: false, error: `Nothing changed: new_text is the same as old_text, so the request is not done yet.` };
    }
    return { ok: true, file, before, after, count: all ? count : 1 };
  } catch (err) {
    return { ok: false, error: `Could not edit ${rel}: ${(err as Error).message}` };
  }
}

export async function applyEdit(rel: string, plan: { file: string; after: string; count: number }): Promise<string> {
  try {
    await writeFile(plan.file, plan.after);
    return `Edited ${rel}: ${plan.count} replacement${plan.count === 1 ? '' : 's'}. ${nowReads(plan.after)}`;
  } catch (err) {
    return `Could not write ${rel}: ${(err as Error).message}`;
  }
}
