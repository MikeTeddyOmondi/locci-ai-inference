#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { login, logout, whoami } from './auth.js';
import {
  API,
  describeModel,
  editPreview,
  fetchModels,
  parseThink,
  pickModel,
  runTurn,
  streamChat,
  thinkFlag,
  THINK_NOTE,
  warmUp,
  type Action,
  type Msg,
  type ThinkSetting,
} from './agent.js';
import { runShell, userRanNote } from './shell.js';
import { findTask, listTasks, startTask, stopTask, tail, taskStatus } from './tasks.js';
import { isTrusted, trust, TRUST_QUESTION } from './trust.js';

// Ported from locci-chat-cli's src/cli.ts. A pure client of the example API
// (examples/api), which talks to the Locci AI Gateway through @locci/ai-sdk.
// Nothing here calls a model or an MCP server directly. The one thing it runs
// itself is the `shell` tool, in the folder it was started in (src/agent.ts).

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/**
 * The folder commands run in. A released `locci-chat` on the PATH runs where it
 * is typed; `just examples-cli` and `pnpm exec` move into examples/cli first,
 * so the recipes pass the folder they were run in as LOCCI_CWD.
 */
const START_DIR = process.env.LOCCI_CWD || process.cwd();

/**
 * The model `chat` and the TUI start with. gemma-4-e2b for now: on file edits
 * it did what was asked where qwen3-1.7b looped (BACKLOG.md). `ask` keeps the
 * API's MODEL.
 */
const AGENT_MODEL = process.env.LOCCI_MODEL || 'gemma-4-e2b';

/** Tools the CLI runs itself, shown its own way rather than as "using x...". */
const CLIENT_TOOL_NAMES = new Set(['shell', 'read_file', 'write_file', 'edit_file']);

/** The first lines of a result, muted, for the terminal. */
function preview(result: string, lines = 12): string {
  const all = result.split('\n');
  const shown = all.slice(0, lines).map((l) => `  ${l}`);
  if (all.length > lines) shown.push(`  ... ${all.length - lines} more lines`);
  return dim(shown.join('\n'));
}

const program = new Command();
program
  .name('locci-chat')
  .description('Chat CLI for the Locci AI Gateway: talks to the example API (examples/api)')
  .version('0.1.0');

program
  .command('login')
  .description('Sign in with Locci in the browser (for an API running AUTH=locci)')
  .action(async () => {
    try {
      await login();
    } catch (error) {
      console.error(`❌ Login failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program.command('logout').description('Forget the saved Locci login').action(logout);

program
  .command('whoami')
  .description('Show who requests are sent as, and which credential is used')
  .action(async () => {
    try {
      await whoami();
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('status')
  .alias('verify') // the command was called `verify` before it grew MCP reporting
  .description('Show model, tools and MCP servers, and check the gateway end to end')
  .action(async () => {
    let res: Response;
    try {
      res = await fetch(`${API}/status`);
    } catch (err) {
      console.error(`❌ Could not reach the API at ${API}. Start it with: just examples-api`);
      console.error(`   ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const data = (await res.json()) as any;

    console.log(`   provider: ${data.provider}`);
    console.log(`   model:    ${data.model}`);
    console.log(`   gateway:  ${data.gateway}`);

    const mcp = (data.mcp ?? []) as { name: string; ok: boolean; toolCount: number; error?: string }[];
    if (mcp.length === 0) {
      console.log('   mcp:      none configured');
    } else {
      for (const [i, server] of mcp.entries()) {
        const label = i === 0 ? '   mcp:     ' : '            ';
        console.log(
          server.ok
            ? `${label} ✓ ${server.name}: ${server.toolCount} tool(s)`
            : `${label} ✗ ${server.name}: ${server.error}`,
        );
      }
    }
    console.log(`   tools:    ${data.tools} merged`);

    if (data.ok) {
      console.log(`✅ Gateway works.  reply: ${JSON.stringify(data.text)}`);
      if (data.usage) console.log('   usage:', data.usage);
    } else {
      console.error(`❌ Gateway check failed${data.statusCode ? ` (status ${data.statusCode})` : ''}`);
      console.error(`   ${data.error}`);
      console.error('   → Check LOCCI_API_KEY in examples/api/.env and that the gateway stack is up (just up).');
      process.exitCode = 1;
    }
  });

program
  .command('ask')
  .description('One-shot question: prints the answer and exits (for scripts and regression runs)')
  .argument('<prompt...>', 'the question')
  .option('-s, --system <prompt>', 'system prompt')
  .option('--json', 'print one JSON summary instead of streaming text')
  .action(async (words: string[], opts: { system?: string; json?: boolean }) => {
    const prompt = words.join(' ');
    let text = '';
    let finish: string | undefined;
    let usage: Record<string, unknown> | undefined;
    const tools: { name: string; ok: boolean; error?: string }[] = [];
    const names = new Map<string, string>();
    const errors: string[] = [];

    try {
      // No shell here: commands need a person to approve them (chat and tui).
      await streamChat({ messages: [{ role: 'user', content: prompt }], system: opts.system }, (event) => {
        switch (event.t) {
          case 'text':
            text += event.v ?? '';
            if (!opts.json) output.write(event.v ?? '');
            break;
          case 'tool':
            names.set(event.id, event.title ?? event.name ?? 'tool');
            if (!opts.json) process.stderr.write(dim(`· using ${event.title ?? event.name}…`) + '\n');
            break;
          case 'tool-done':
            tools.push({ name: names.get(event.id) ?? 'tool', ok: !event.error, error: event.error });
            break;
          case 'finish':
            finish = event.reason;
            usage = event.usage;
            break;
          case 'error':
            errors.push(event.v ?? 'stream error');
            break;
        }
      });
    } catch (err) {
      errors.push((err as Error).message);
    }

    if (opts.json) {
      console.log(JSON.stringify({ ok: errors.length === 0 && text.length > 0, text, tools, finish, usage, errors }));
    } else {
      output.write('\n');
      if (finish === 'length') console.error(dim('[cut off: hit the token limit]'));
      for (const e of errors) console.error(`❌ ${e}`);
    }
    if (errors.length > 0 || !text) process.exitCode = 1;
  });

program
  .command('chat')
  .description('Interactive streaming chat, Claude-Code style; can run commands in this folder (asks before each one)')
  .option('-s, --system <prompt>', 'system prompt')
  .option('-m, --model <id>', 'a model from the API\'s /models (or set LOCCI_MODEL)', AGENT_MODEL)
  .option('--no-shell', "don't let the model run shell commands")
  .option('--no-think', "never let the model think first (default: the API decides per model)")
  .option('--yolo', 'run commands without asking (toggle in the chat with /auto)')
  .option('--cwd <dir>', 'folder commands run in (default: where you ran it)', START_DIR)
  .action(async (opts: { system?: string; model?: string; shell: boolean; think: boolean; yolo?: boolean; cwd: string }) => {
    const rl = readline.createInterface({ input, output });
    const messages: Msg[] = [];
    const cwd = path.resolve(opts.cwd);
    // `!command` output, sent along with the next message so the model sees it.
    let ran: string[] = [];
    // --model (default AGENT_MODEL), then what /model picked.
    let model = opts.model;
    // Thinking: left to the API per model, or forced with /think on|off (--no-think: off).
    let think: ThinkSetting = opts.think ? 'auto' : 'off';
    // YOLO mode: commands run without asking. Off unless --yolo or /auto.
    let yolo = Boolean(opts.yolo);

    // Ctrl+C has to unwind three things: the in-flight request, the readline
    // interface (which owns raw mode), and the prompt line we're sitting on.
    // Without this the process dies mid-stream and leaves the terminal dirty.
    let stream: AbortController | null = null;
    const session = new AbortController();
    let closing = false;

    const shutdown = () => {
      if (closing) process.exit(130); // impatient second Ctrl+C
      closing = true;
      stream?.abort();
      // A pending rl.question() never settles once the interface closes, so
      // abort it explicitly; otherwise cleanup below is simply skipped.
      session.abort();
      output.write('\n');
      rl.close();
      process.exitCode = 130; // conventional exit code for SIGINT
    };
    rl.on('SIGINT', shutdown);
    // Esc stops the reply or the command in progress (readline reports keys
    // on the terminal's input stream); the chat goes on.
    const onKey = (_: string, key?: { name?: string }) => {
      if (key?.name === 'escape') stream?.abort();
    };
    input.on('keypress', onKey);
    process.once('SIGTERM', shutdown);

    console.log('locci-chat: type a message. Esc stops a reply, !<command> runs a command here (end it with & for the background, /tasks lists those), /model switches models, /auto toggles YOLO mode, /think toggles thinking, /exit quits.');

    // A folder is asked about once, then remembered (src/trust.ts).
    let shell = opts.shell;
    if (shell && !(await isTrusted(cwd))) {
      let answer = '';
      try {
        answer = (await rl.question(`${TRUST_QUESTION(cwd)} [y/N] `, { signal: session.signal })).trim().toLowerCase();
      } catch {
        // Ctrl+C or end of input: no.
      }
      if (answer === 'y' || answer === 'yes') await trust(cwd);
      else shell = false;
    }
    console.log(
      dim(
        shell
          ? `Commands run in ${cwd}${yolo ? ' without asking (YOLO mode)' : ', after you approve each one'}.\n`
          : opts.shell
            ? 'No commands in this chat: the folder was not allowed.\n'
            : 'Shell commands are off (--no-shell).\n',
      ),
    );

    // The prompt-cache warm-up (agent.ts): again whenever the model, its
    // thinking or the tools change; a message waits for it.
    const warm = () => warmUp({ system: opts.system, model, reasoning: shell ? thinkFlag(think) : undefined, shell, cwd });
    let warming = warm();

    const approve = async (action: Action): Promise<boolean> => {
      if (action.kind === 'shell') {
        output.write(`\n${dim('$')} ${action.command}${action.background ? dim('  (in the background)') : ''}\n`);
      } else if (action.kind === 'stop') {
        output.write(`\n${dim('■')} Stop task #${action.id}: ${action.command}\n`);
      } else if (action.kind === 'edit') {
        const where = action.count > 1 ? ` (${action.count} places)` : '';
        output.write(`\n${dim('✎')} Edit ${action.path}${where}\n${dim(editPreview(action).map((l) => `  ${l}`).join('\n'))}\n`);
      } else {
        const lines = action.content.split('\n').length;
        output.write(`\n${dim('✎')} ${action.creates ? 'Create' : 'Replace'} ${action.path} (${lines} lines)\n${preview(action.content, 15)}\n`);
      }
      if (yolo) return true;
      // Each one gets its own answer, until `a` or /auto stops the asking.
      // a: yes, and YOLO mode from here on (as /auto).
      const question =
        action.kind === 'shell'
          ? `Run in ${cwd}? [y/N/a] `
          : action.kind === 'stop'
            ? 'Stop it? [y/N/a] '
            : action.kind === 'edit'
              ? 'Make this edit? [y/N/a] '
              : 'Write it? [y/N/a] ';
      // Esc at the question stops the turn too.
      const signal = stream ? AbortSignal.any([session.signal, stream.signal]) : session.signal;
      const answer = (await rl.question(question, { signal })).trim().toLowerCase();
      if (answer === 'a' || answer === 'all') {
        yolo = true;
        output.write(dim('YOLO mode on: the rest run without asking. /auto turns it off.\n'));
        return true;
      }
      return answer === 'y' || answer === 'yes';
    };

    try {
      while (!closing) {
        let line: string;
        try {
          line = (await rl.question('you > ', { signal: session.signal })).trim();
        } catch {
          break; // interface closed underneath us (Ctrl+C)
        }
        if (closing) break;
        if (!line) continue;
        if (line === '/exit' || line === '/quit') break;
        if (line === '/model' || line.startsWith('/model ')) {
          // `/model` lists, `/model <id>` switches; the history stays.
          try {
            const list = await fetchModels();
            const id = line.slice('/model'.length).trim();
            if (!id) {
              for (const m of list.models) console.log(describeModel(m, model ?? list.default));
              console.log(dim('Switch with /model <id>.\n'));
            } else {
              const pick = pickModel(list, id);
              if (!pick.ok) console.log(dim(`${pick.error}\n`));
              else {
                model = pick.model.id;
                warming = warm();
                console.log(dim(`Now using ${model}.${pick.warning ? ` ${pick.warning}` : ''}\n`));
              }
            }
          } catch (err) {
            console.log(dim(`Couldn't get the models: ${(err as Error).message}\n`));
          }
          continue;
        }
        if (line === '/think' || line.startsWith('/think ')) {
          const next = parseThink(line, think);
          if (next) {
            think = next;
            warming = warm();
          }
          console.log(dim(`${next ? THINK_NOTE[think] : 'Use /think on, /think off or /think auto.'}\n`));
          continue;
        }
        if (line === '/auto') {
          if (!shell) {
            console.log(dim('Shell commands are off in this chat.\n'));
            continue;
          }
          yolo = !yolo;
          console.log(dim(yolo ? 'YOLO mode on: commands run without asking. /auto again to turn it off.\n' : 'YOLO mode off: each command asks first.\n'));
          continue;
        }

        if (line === '/tasks') {
          for (const t of listTasks()) console.log(`#${t.id} ${t.command} ${dim(`(${taskStatus(t)}, by ${t.by})`)}\n${preview(tail(t, 600), 4)}`);
          console.log(dim(listTasks().length ? 'Stop one with /kill <n>.\n' : 'No background tasks. Start one with !<command> &.\n'));
          continue;
        }
        if (line === '/kill' || line.startsWith('/kill ')) {
          const task = findTask(Number(line.slice('/kill'.length).trim().replace(/^#/, '')));
          console.log(dim(!task ? 'Use /kill <n>, with a number from /tasks.\n' : stopTask(task) ? `Stopped #${task.id} ${task.command}.\n` : `#${task.id} is not running (${taskStatus(task)}).\n`));
          continue;
        }
        if (line.startsWith('!')) {
          // The user's own command: runs at once, no approval, even with
          // --no-shell (that flag is about the model).
          const command = line.slice(1).trim();
          if (!command) {
            console.log(dim(`Type a command after the !, e.g. !ls. It runs in ${cwd}.\n`));
            continue;
          }
          // `!npm start &`: a background task (/tasks lists them).
          if (/\s&$/.test(command) && !/&&$/.test(command)) {
            const task = startTask(command.replace(/\s*&$/, ''), cwd, 'you');
            console.log(dim(`Started #${task.id} in the background. /tasks lists them, /kill ${task.id} stops it.\n`));
            ran.push(`[I started \`${task.command}\` in the background myself as task #${task.id}.]`);
            continue;
          }
          stream = new AbortController();
          const result = await runShell(command, cwd, stream.signal);
          stream = null;
          if (closing) break;
          const out = result.output.trimEnd();
          if (out) console.log(out);
          if (result.timedOut || result.exitCode !== 0) {
            console.log(dim(result.stopped ? '[stopped]' : result.timedOut ? '[timed out and stopped]' : result.exitCode === null ? '[failed to start]' : `[exit code ${result.exitCode}]`));
          }
          console.log();
          ran.push(userRanNote(command, result));
          continue;
        }

        const start = messages.length;
        const notes = ran;
        ran = [];
        messages.push({ role: 'user', content: notes.length ? `${notes.join('\n')}\n\n${line}` : line });

        stream = new AbortController();
        const names = new Map<string, string>();
        output.write('AI Assistant > ');

        try {
          await warming;
          await runTurn(
            messages,
            {
              system: opts.system,
              model,
              reasoning: shell ? thinkFlag(think) : undefined,
              shell,
              cwd,
              approve,
              onToolResult: (call, result) =>
                output.write(
                  `${call.name === 'shell' ? preview(result) : dim(call.name === 'read_file' ? `· ${call.label}` : `· ${result.split('\n')[0]}`)}\n\nAI Assistant > `,
                ),
            },
            (event) => {
              if (closing) return;
              if (event.t === 'text') {
                output.write(event.v ?? '');
              } else if (event.t === 'tool' && !CLIENT_TOOL_NAMES.has(event.name ?? '')) {
                // Muted so it reads as activity, not as part of the answer.
                names.set(event.id, event.title ?? event.name ?? 'tool');
                output.write(dim(`\n· using ${event.title ?? event.name}…`) + '\n');
              } else if (event.t === 'tool-done') {
                const label = names.get(event.id) ?? 'tool';
                output.write(dim(event.error ? `· ${label} failed: ${event.error}` : `· ${label} ok`) + '\n');
              } else if (event.t === 'thinking') {
                output.write(dim('· thinking…') + '\n');
              } else if (event.t === 'finish' && event.reason === 'length') {
                output.write(dim('\n[cut off: hit the token limit]'));
              } else if (event.t === 'error') {
                output.write(dim(`\n⚠️  ${event.v}`) + '\n');
              }
            },
            stream.signal,
          );
        } catch (err) {
          // ERR_USE_AFTER_CLOSE: input ended (Ctrl+D) at a [y/N] prompt.
          if (closing || (err as { code?: string }).code === 'ERR_USE_AFTER_CLOSE') break;
          if ((err as Error).name === 'AbortError') {
            // Esc: runTurn kept what was said and done, so the chat goes on.
            output.write(dim('\n[stopped]') + '\n\n');
            stream = null;
            continue;
          }
          console.error(`\n❌ ${(err as Error).message || `API unreachable at ${API}`}. Start it with: just examples-api\n`);
          messages.length = start;
          ran = [...notes, ...ran];
          stream = null;
          continue;
        }
        stream = null;
        if (closing) break;

        output.write('\n\n');
      }
    } finally {
      stream?.abort();
      input.off('keypress', onKey);
      rl.close();
      // Leave the cursor on a clean line whichever way we got here.
      output.write(closing ? 'interrupted.\n' : '\nbye.\n');
      // A background task keeps the event loop alive: exit outright, which
      // stops every command and task (src/procs.ts).
      process.exit(process.exitCode ?? 0);
    }
  });

const mcp = program.command('mcp').description('Inspect the MCP servers the API connected to');

mcp
  .command('list')
  .description("Print each MCP server the API connected to, with its tools")
  .action(async () => {
    // The API owns MCP; the CLI only asks it, so it stays a pure client.
    let data: {
      enabled: boolean;
      config: string;
      servers: { name: string; ok: boolean; toolCount: number; error?: string; toolNames: string[] }[];
    };
    try {
      data = (await (await fetch(`${API}/mcp`)).json()) as typeof data;
    } catch (err) {
      console.error(`❌ Could not reach the API at ${API}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`config: ${data.config}${data.enabled ? '' : ' (MCP disabled on the API)'}\n`);
    if (data.servers.length === 0) {
      console.log('No MCP servers connected.');
      console.log('  → in examples/api: cp mcp.example.json mcp.json, or set MCP_COMMAND / MCP_ARGS.');
    }
    for (const server of data.servers) {
      if (server.ok) {
        console.log(`✅ ${server.name}: ${server.toolCount} tool(s)`);
        for (const tool of server.toolNames) console.log(`     ${tool}`);
      } else {
        console.log(`❌ ${server.name}: ${server.error}`);
        process.exitCode = 1;
      }
    }
  });

program
  .command('tui')
  .description('Launch the OpenTUI terminal chat (runs under Bun); can run commands in this folder (asks first)')
  .option('-s, --system <prompt>', 'system prompt')
  .option('-m, --model <id>', 'a model from the API\'s /models (or set LOCCI_MODEL)', AGENT_MODEL)
  .option('--no-shell', "don't let the model run shell commands")
  .option('--no-think', "never let the model think first (default: the API decides per model)")
  .option('--yolo', 'run commands without asking (toggle in the chat with /auto)')
  .option('--cwd <dir>', 'folder commands run in (default: where you ran it)', START_DIR)
  .action(async (opts: { system?: string; model?: string; shell: boolean; think: boolean; yolo?: boolean; cwd: string }) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tuiPath = path.join(here, 'tui.tsx');

    // The OpenTUI renderer needs Bun (or Node 26.4+ with --experimental-ffi).
    // If we're already under Bun, reuse this executable; otherwise spawn `bun`.
    const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
    const settings: Record<string, string> = {
      ...(opts.system ? { SYSTEM_PROMPT: opts.system } : {}),
      ...(opts.model ? { LOCCI_MODEL: opts.model } : {}),
      LOCCI_SHELL: opts.shell ? '1' : '0',
      LOCCI_THINK: opts.think ? '1' : '0',
      LOCCI_YOLO: opts.yolo ? '1' : '0',
      LOCCI_CWD: path.resolve(opts.cwd),
    };

    // Under Bun (bun src/cli.ts, or the binary from `pnpm build`, which has no
    // tui.tsx beside it) the TUI runs in this process; it reads its settings
    // from the environment when it loads.
    if (isBun) {
      Object.assign(process.env, settings);
      await import('./tui.js');
      return;
    }

    const child = spawn('bun', [tuiPath], {
      stdio: 'inherit',
      env: { ...process.env, ...settings },
    });

    // Forward termination signals so the child can restore the terminal and
    // tear down its own connections before exiting.
    const forward = (sig: NodeJS.Signals) => {
      if (!child.killed) child.kill(sig);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error('❌ Could not find `bun`. The TUI needs Bun (https://bun.sh).');
        console.error('   Install it, or run the client directly: bun src/tui.tsx');
      } else {
        console.error(`❌ Failed to launch TUI: ${err.message}`);
      }
      process.exitCode = 1;
    });

    child.on('exit', (code) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      process.exitCode = code ?? 0;
    });
  });

program.parseAsync();
