// Background tasks: commands that keep running (servers, watchers) while the
// chat goes on. Started by the model (`shell` with background: true) or by
// the user (`!npm start &`); listed under the TUI's input, with /tasks and
// /kill in both chats, and the `tasks` tool for the model. Each runs in its
// own process group, stopped when the CLI ends, however it ends (procs.ts).

import { signalGroup, spawnTied } from './procs.js';

/** How much output a task keeps: the latest, where a server's errors are. */
const KEEP_CHARS = 16_000;
/** How long a new task runs before its first output goes back to the model. */
const FIRST_OUTPUT_MS = 3_000;

export interface Task {
  id: number;
  command: string;
  by: 'you' | 'model';
  pid?: number;
  startedAt: number;
  endedAt?: number;
  state: 'running' | 'exited' | 'stopped' | 'failed';
  exitCode: number | null;
  output: string;
}

const tasks: Task[] = [];
let nextId = 1;
/** Called with true when only output arrived, false when a task started, stopped or ended. */
const listeners = new Set<(outputOnly: boolean) => void>();
let pending: NodeJS.Timeout | null = null;

/** Tell the TUI: at once for a state change, at most every 300 ms while output streams in. */
function changed(now = false) {
  if (now) {
    if (pending) clearTimeout(pending);
    pending = null;
    for (const fn of listeners) fn(false);
  } else if (!pending) {
    pending = setTimeout(() => {
      pending = null;
      for (const fn of listeners) fn(true);
    }, 300);
  }
}

export function onTasksChange(fn: (outputOnly: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listTasks(): Task[] {
  return [...tasks];
}

export function findTask(id: number): Task | undefined {
  return tasks.find((t) => t.id === id);
}

export function startTask(command: string, cwd: string, by: Task['by']): Task {
  const task: Task = { id: nextId++, command, by, startedAt: Date.now(), state: 'running', exitCode: null, output: '' };
  // Its own process group, stopped with the CLI however that ends (src/procs.ts).
  const child = spawnTied(command, cwd);
  task.pid = child.pid;
  const collect = (chunk: Buffer) => {
    task.output = (task.output + chunk.toString('utf8')).slice(-KEEP_CHARS);
    changed();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', (err) => {
    task.state = 'failed';
    task.output += err.message;
    task.endedAt = Date.now();
    changed(true);
  });
  child.on('close', (code) => {
    if (task.state === 'running') task.state = 'exited';
    task.exitCode = code;
    task.endedAt = Date.now();
    changed(true);
  });
  tasks.push(task);
  changed(true);
  return task;
}

/** Stop a task's whole process group: TERM, then KILL if it is still there after 3 s. */
export function stopTask(task: Task): boolean {
  if (task.state !== 'running' || !task.pid) return false;
  task.state = 'stopped';
  const signal = (sig: NodeJS.Signals) => signalGroup(task.pid, sig);
  signal('SIGTERM');
  setTimeout(() => {
    if (task.endedAt === undefined) signal('SIGKILL');
  }, 3_000).unref();
  changed(true);
  return true;
}

/** Wait for a new task's first output (or its exit), for the model's first look. */
export async function firstOutput(task: Task, ms = FIRST_OUTPUT_MS): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && task.state === 'running') await new Promise((r) => setTimeout(r, 100));
}

function since(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

/** "running 2m", "exited 1 after 4s", "stopped". */
export function taskStatus(t: Task): string {
  if (t.state === 'running') return `running ${since(Date.now() - t.startedAt)}`;
  if (t.state === 'stopped') return 'stopped';
  if (t.state === 'failed') return 'failed to start';
  return `exited ${t.exitCode ?? '?'} after ${since((t.endedAt ?? Date.now()) - t.startedAt)}`;
}

/** The latest `chars` of a task's output. */
export function tail(t: Task, chars = 4_000): string {
  const out = t.output.trimEnd();
  return out.length > chars ? `[... earlier output cut]\n${out.slice(-chars)}` : out || '(no output yet)';
}

/** One line per task, for /tasks and the `tasks` tool. */
export function describeTasks(): string {
  if (tasks.length === 0) return 'No background tasks.';
  return tasks.map((t) => `#${t.id} ${t.command} (${taskStatus(t)}, started by ${t.by})`).join('\n');
}
