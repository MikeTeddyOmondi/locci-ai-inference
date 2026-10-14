// The client side of the API's `shell` tool: the model asks for a command,
// the user approves it, and it runs here, in the folder the CLI was started
// in, never on the API server. See BACKLOG.md "CLI agent".

import { spawn } from 'node:child_process';

/** Long enough for an install or a test run, short enough that a hung command comes back. */
const TIMEOUT_MS = Number(process.env.LOCCI_SHELL_TIMEOUT_MS) || 120_000;
/** What goes back to the model: a small model's window is 8k to 16k tokens. */
const MAX_CHARS = Number(process.env.LOCCI_SHELL_MAX_CHARS) || 8_000;

/** Process groups still running, killed if the CLI exits first (Ctrl+C in the TUI). */
const running = new Set<number>();
process.on('exit', () => {
  for (const pid of running) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

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
 * fails instead of hanging. A timeout or an abort kills the whole process
 * group, so `npm run dev` and its children go too.
 */
export function runShell(command: string, cwd: string, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    const child = spawn(command, {
      cwd,
      shell: windows ? true : (process.env.SHELL ?? '/bin/sh'),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !windows,
      env: { ...process.env, CI: process.env.CI ?? '1' }, // fewer prompts and spinners
    });
    if (!windows && child.pid) running.add(child.pid);
    let output = '';
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      // Bounded while it runs too; cap() trims to the final size.
      output += chunk.toString('utf8');
      if (output.length > MAX_CHARS * 4) output = output.slice(0, MAX_CHARS) + output.slice(-MAX_CHARS * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const kill = () => {
      try {
        if (!windows && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
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
      if (child.pid) running.delete(child.pid);
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
