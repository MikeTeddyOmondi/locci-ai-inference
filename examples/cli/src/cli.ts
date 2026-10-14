#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { authHeaders, explain401, login, logout, whoami } from './auth.js';

// Ported from locci-chat-cli's src/cli.ts. A pure client of the example API
// (examples/api), which talks to the Locci AI Gateway through @locci/ai-sdk.
// Nothing here calls a model or an MCP server directly.

const API = process.env.API_URL ?? 'http://localhost:3939';

type Msg = { role: 'user' | 'assistant'; content: string };

/** One parsed NDJSON event from POST /chat?events=1. */
type ChatEvent =
  | { t: 'text'; v?: string }
  | { t: 'tool'; id: string; name?: string; title?: string }
  | { t: 'tool-input'; id: string; input?: unknown }
  | { t: 'tool-done'; id: string; output?: string; error?: string }
  | { t: 'finish'; reason?: string; usage?: Record<string, unknown> }
  | { t: 'error'; v?: string };

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/**
 * POST the conversation and call onEvent for each NDJSON line. Shared by
 * `chat` and `ask`, so both read the stream the same way.
 */
async function streamChat(
  messages: Msg[],
  system: string | undefined,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API}/chat?events=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ messages, system }),
    signal,
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${errText}${explain401(res.status)}`.trim());
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // NDJSON: whole lines only, keep the remainder for the next read.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as ChatEvent);
      } catch {
        // a malformed line shouldn't kill the stream
      }
    }
  }
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
      await streamChat([{ role: 'user', content: prompt }], opts.system, (event) => {
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
  .description('Interactive streaming chat, Claude-Code style')
  .option('-s, --system <prompt>', 'system prompt')
  .action(async (opts: { system?: string }) => {
    const rl = readline.createInterface({ input, output });
    const messages: Msg[] = [];

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
    process.once('SIGTERM', shutdown);

    console.log('locci-chat: type a message, /exit to quit (Ctrl+C also works).\n');

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

        messages.push({ role: 'user', content: line });

        stream = new AbortController();
        let assistant = '';
        const names = new Map<string, string>();
        output.write('AI Assistant > ');

        try {
          await streamChat(
            messages,
            opts.system,
            (event) => {
              if (closing) return;
              if (event.t === 'text') {
                assistant += event.v ?? '';
                output.write(event.v ?? '');
              } else if (event.t === 'tool') {
                // Muted so it reads as activity, not as part of the answer.
                names.set(event.id, event.title ?? event.name ?? 'tool');
                output.write(dim(`\n· using ${event.title ?? event.name}…`) + '\n');
              } else if (event.t === 'tool-done') {
                const label = names.get(event.id) ?? 'tool';
                output.write(dim(event.error ? `· ${label} failed: ${event.error}` : `· ${label} ok`) + '\n');
              } else if (event.t === 'finish' && event.reason === 'length') {
                output.write(dim('\n[cut off: hit the token limit]'));
              } else if (event.t === 'error') {
                output.write(dim(`\n⚠️  ${event.v}`) + '\n');
              }
            },
            stream.signal,
          );
        } catch (err) {
          if (closing || (err as Error).name === 'AbortError') break;
          console.error(`\n❌ ${(err as Error).message || `API unreachable at ${API}`}. Start it with: just examples-api\n`);
          messages.pop();
          stream = null;
          continue;
        }
        stream = null;
        if (closing) break;

        output.write('\n\n');
        messages.push({ role: 'assistant', content: assistant });
      }
    } finally {
      stream?.abort();
      rl.close();
      // Leave the cursor on a clean line whichever way we got here.
      output.write(closing ? 'interrupted.\n' : '\nbye.\n');
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
  .description('Launch the OpenTUI terminal chat (runs under Bun)')
  .option('-s, --system <prompt>', 'system prompt')
  .action((opts: { system?: string }) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tuiPath = path.join(here, 'tui.tsx');

    // The OpenTUI renderer needs Bun (or Node 26.4+ with --experimental-ffi).
    // If we're already under Bun, reuse this executable; otherwise spawn `bun`.
    const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
    const runtime = isBun ? process.execPath : 'bun';

    const child = spawn(runtime, [tuiPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(opts.system ? { SYSTEM_PROMPT: opts.system } : {}),
      },
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
