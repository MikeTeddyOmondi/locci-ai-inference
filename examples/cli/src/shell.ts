// The client side of the API's `shell` tool: the model asks for a command,
// the user approves it, and it runs here, in the folder the CLI was started
// in, never on the API server. See BACKLOG.md "CLI agent".

import { signalGroup, spawnTied } from './procs.js';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/** Long enough for an install or a test run, short enough that a hung command comes back. */
const TIMEOUT_MS = Number(process.env.LOCCI_SHELL_TIMEOUT_MS) || 120_000;
/** What goes back to the model: a small model's window is 8k to 16k tokens. */
const MAX_CHARS = Number(process.env.LOCCI_SHELL_MAX_CHARS) || 8_000;


export interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  /** Killed because the user stopped it (Esc). */
  stopped?: boolean;
}

/** Keep the head and the tail: errors and summaries are usually at the end. */
function cap(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const head = Math.floor(MAX_CHARS * 0.3);
  const tail = MAX_CHARS - head;
  return `${text.slice(0, head)}\n[... ${text.length - MAX_CHARS} characters cut ...]\n${text.slice(-tail)}`;
}

/**
 * Run a command line in the user's shell in `cwd`. stdout and stderr are
 * read together, in order. stdin is closed so a command waiting for input
 * fails instead of hanging. A timeout, an abort or the CLI ending kills the
 * whole process group, so `npm run dev` and its children go too.
 */
export function runShell(command: string, cwd: string, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    // Its own process group, stopped with the CLI however that ends (src/procs.ts).
    const child = spawnTied(command, cwd);
    let output = '';
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      // Bounded while it runs too; cap() trims to the final size.
      output += chunk.toString('utf8');
      if (output.length > MAX_CHARS * 4) output = output.slice(0, MAX_CHARS) + output.slice(-MAX_CHARS * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const kill = () => signalGroup(child.pid, 'SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    signal?.addEventListener('abort', kill, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ exitCode: code, output: cap(output), timedOut, stopped: Boolean(signal?.aborted) });
    });
  });
}

/** The tool result the model reads. */
export function describeResult(r: ShellResult): string {
  const status = r.stopped
    ? 'stopped by the user before it finished'
    : r.timedOut
    ? `timed out after ${TIMEOUT_MS / 1000}s and was stopped`
    : r.exitCode === null
      ? 'failed to start'
      : `exit code ${r.exitCode}`;
  return `${status}\n${r.output.trim() || '(no output)'}`;
}

/**
 * A `!command` the user ran in the chat, for the model to read with their next
 * message (so "why did that fail?" has the output to go on).
 */
export function userRanNote(command: string, r: ShellResult): string {
  return `[I ran \`${command}\` in the folder myself: ${describeResult(r)}]`;
}

/** A package install, add or removal: these write to the nearest project's manifest. */
const PACKAGE_CHANGE = /(?:^|[;&|(]\s*)(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|update|up|upgrade|remove|rm|uninstall|un)\b/;

/**
 * Why a command would change a project outside `cwd`, or null. npm, pnpm, yarn
 * and bun install into the nearest folder up the tree with a package.json, so
 * `npm install express` in a folder without one rewrote the repo's root
 * package.json and node_modules (BACKLOG.md). A leading `cd dir &&` is
 * followed; other ways of picking a folder (a later cd, --prefix, -C, --dir)
 * and global installs are left alone.
 */
export function installsOutside(command: string, cwd: string): string | null {
  // `cd sub && npm install`: check from sub (quotes and ~ aside).
  const into = /^\s*cd\s+([^\s;&|'"]+)\s*&&/.exec(command);
  const from = into ? path.resolve(cwd, into[1]) : cwd;
  const rest = (into ? command.slice(into[0].length) : command).trim();
  if (!PACKAGE_CHANGE.test(rest) || /\bcd\s|--prefix|\s-C\s|--dir\b|\s-g\b|--global/.test(rest)) return null;
  const back = path.relative(cwd, from);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    return `Not run: that would change the project in ${from}, outside the folder you work in (${cwd}).`;
  }
  // `npm init -y && npm install x` makes the folder a project first.
  if (existsSync(path.join(from, 'package.json')) || /\b(?:npm|pnpm|yarn|bun)\s+init\b/.test(rest.split(PACKAGE_CHANGE)[0])) return null;
  for (let dir = path.dirname(from); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return (
        `Not run: this folder has no package.json, so the package manager would change the project in ${dir} ` +
        '(its package.json, lockfile and node_modules), outside the folder you work in. Do not ask the user: run ' +
        '"npm init -y" in this folder now (pnpm init for pnpm), then the same install again; it then stays in this folder.'
      );
    }
  }
  return null;
}
