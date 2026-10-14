// Child processes that cannot outlive the CLI. Commands (src/shell.ts) and
// background tasks (src/tasks.ts) run in their own process group, so Ctrl+C,
// a closed terminal or a crash of the CLI does not reach them, and an exit
// handler alone missed every way the TUI can end (Ctrl+C, SIGTERM, SIGHUP,
// kill -9 all left a task running).
//
// So each command runs under a small sh wrapper whose stdin is a pipe from the
// CLI. However the CLI ends, even kill -9, the OS closes that pipe; the
// wrapper's watcher reads EOF and stops the whole group: TERM, then KILL after
// 3 s. The command itself still gets no stdin (</dev/null), as before.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const WATCHER = [
  // The watcher: stdin is the CLI's pipe (`<&0`: a background job would get
  // /dev/null otherwise). It ignores TERM so it can follow up with KILL.
  '( trap "" TERM; cat >/dev/null; kill -TERM 0 2>/dev/null; sleep 3; kill -KILL 0 2>/dev/null ) <&0 >/dev/null 2>&1 &',
  'w=$!',
  '"$LOCCI_RUN_SHELL" -c "$LOCCI_RUN_COMMAND" </dev/null',
  's=$?',
  // Finished on its own: the watcher goes; its cat ends when the CLI closes the pipe.
  'kill -KILL $w 2>/dev/null',
  'exit $s',
].join('\n');

/** Process groups still running, stopped when the CLI exits normally too. */
const groups = new Set<number>();

/** Run `command` in the user's shell in `cwd`, in its own process group, tied to this process. */
export function spawnTied(command: string, cwd: string): ChildProcessWithoutNullStreams {
  const windows = process.platform === 'win32';
  const env = { ...process.env, CI: process.env.CI ?? '1' }; // fewer prompts and spinners
  const child = windows
    ? spawn(command, { cwd, shell: true, env, stdio: 'pipe' })
    : spawn('/bin/sh', ['-c', WATCHER], {
        cwd,
        detached: true,
        stdio: 'pipe',
        env: { ...env, LOCCI_RUN_SHELL: process.env.SHELL ?? '/bin/sh', LOCCI_RUN_COMMAND: command },
      });
  const pid = child.pid;
  if (pid && !windows) groups.add(pid);
  child.on('exit', () => {
    if (pid) groups.delete(pid);
    child.stdin.end(); // lets the finished watcher's cat go
  });
  return child;
}

/** Signal a tied process's whole group. */
export function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch {
    // already gone
  }
}

/** On a normal exit, TERM every group at once; their watchers would get there anyway. */
process.on('exit', () => {
  for (const pid of groups) signalGroup(pid, 'SIGTERM');
});

// A closed terminal: nothing left to show, so end through 'exit' (above).
// SIGTERM is the TUI's and chat's own; the watchers cover anything missed.
process.on('SIGHUP', () => process.exit(129));
