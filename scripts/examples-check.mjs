#!/usr/bin/env node
// Regression checks for the examples (examples/api, cli, web) against the
// running stack: gateway (`just up`), locci-auth (`just auth`) and the example
// API (`just examples-api`). Each check prints PASS / FAIL / SKIP; the exit code
// is non-zero if anything failed.
//
// Usage: node scripts/examples-check.mjs [--no-static]
//   API_URL default http://localhost:3939
//   --no-static skips typecheck and the web build (just the live checks)

import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const API = (process.env.API_URL ?? 'http://localhost:3939').replace(/\/+$/, '');
const WEB_ORIGIN = 'http://localhost:5173';
const NAIROBI = 'What is the weather in Nairobi (latitude -1.29, longitude 36.82) right now?';

let failed = 0;
const pass = (name, detail = '') => console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
const skip = (name, why) => console.log(`SKIP ${name}: ${why}`);
const fail = (name, detail) => {
  failed++;
  console.log(`FAIL ${name}: ${detail}`);
};

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    if (detail === undefined) return;
    pass(name, `${detail} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** POST /chat?events=1 and collect the NDJSON events. */
async function events(messages) {
  const res = await fetch(`${API}/chat?events=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  assert(res.ok, `HTTP ${res.status}`);
  const lines = (await res.text()).trim().split('\n').filter(Boolean);
  const evs = lines.map((l) => JSON.parse(l));
  const text = evs.filter((e) => e.t === 'text').map((e) => e.v).join('');
  const errors = evs.filter((e) => e.t === 'error').map((e) => e.v);
  const tools = evs.filter((e) => e.t === 'tool').map((e) => e.name);
  const done = evs.filter((e) => e.t === 'tool-done');
  const finish = evs.find((e) => e.t === 'finish');
  return { text, errors, tools, done, finish };
}

// --- static: typecheck + web build ------------------------------------------
if (!process.argv.includes('--no-static')) {
  for (const pkg of ['@locci/example-api', '@locci/example-cli', '@locci/example-web']) {
    await check(`typecheck ${pkg}`, async () => {
      execFileSync('pnpm', ['--filter', pkg, 'run', '-s', 'typecheck'], { cwd: root, stdio: 'pipe' });
      return 'clean';
    });
  }
  await check('web build', async () => {
    execFileSync('pnpm', ['--filter', '@locci/example-web', 'run', '-s', 'build'], { cwd: root, stdio: 'pipe' });
    return 'static build written';
  });
}

// --- the API itself ------------------------------------------------------------
let info;
try {
  info = await (await fetch(`${API}/info`)).json();
  pass('api /info', `model ${info.model}, ${info.tools} tools, mcp ${info.mcp.map((m) => `${m.name}:${m.ok ? 'ok' : 'down'}`).join(' ') || 'none'}`);
} catch (err) {
  fail('api /info', `API unreachable at ${API} (start it with: just examples-api)`);
  process.exit(1);
}
const hasTool = (name) => info.toolNames.includes(name);

await check('api /status (gateway end to end)', async () => {
  const s = await (await fetch(`${API}/status`)).json();
  assert(s.ok, `${s.error ?? 'not ok'}${s.statusCode ? ` (HTTP ${s.statusCode})` : ''}`);
  return `reply ${JSON.stringify(s.text)}`;
});

// --- CLI protocol: POST /chat?events=1 ------------------------------------------
if (hasTool('weather')) {
  await check('cli protocol: weather tool call', async () => {
    const r = await events([{ role: 'user', content: NAIROBI }]);
    assert(r.errors.length === 0, `stream errors: ${r.errors.join('; ')}`);
    assert(r.tools.includes('weather'), `no weather call; tools: [${r.tools}] text: ${JSON.stringify(r.text.slice(0, 120))}`);
    assert(r.done.every((d) => !d.error), `tool failed: ${r.done.map((d) => d.error).join('; ')}`);
    assert(r.text.includes('°C'), `answer lacks a temperature: ${JSON.stringify(r.text.slice(0, 120))}`);
    assert(r.finish?.reason === 'stop', `finish ${r.finish?.reason}`);
    return `answered with ${r.finish.usage?.inputTokens} prompt tokens`;
  });
} else skip('cli protocol: weather tool call', 'weather tool not registered (OPENWEATHERMAP_API_KEY)');

await check('cli protocol: multi-turn memory', async () => {
  const r = await events([
    { role: 'user', content: 'My name is Ada. Reply with just: noted.' },
    { role: 'assistant', content: 'noted.' },
    { role: 'user', content: 'What is my name? Reply with one word.' },
  ]);
  assert(r.errors.length === 0, `stream errors: ${r.errors.join('; ')}`);
  assert(/ada/i.test(r.text), `expected "Ada", got ${JSON.stringify(r.text.slice(0, 80))}`);
  return JSON.stringify(r.text.trim().slice(0, 40));
});

if (hasTool('list_directory')) {
  await check('cli protocol: MCP tool (filesystem list_directory)', async () => {
    const r = await events([{ role: 'user', content: 'List the files in /tmp using your tools.' }]);
    assert(r.errors.length === 0, `stream errors: ${r.errors.join('; ')}`);
    assert(r.done.length > 0 && r.done.every((d) => !d.error), `tools: [${r.tools}] ${r.done.map((d) => d.error).join('; ')}`);
    return `called ${r.tools.join(', ')}`;
  });
} else skip('cli protocol: MCP tool', 'no filesystem MCP server connected');

// --- web protocol: POST /api/chat (UI message stream) ---------------------------
await check('web protocol: /api/chat UI stream + CORS', async () => {
  const res = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: hasTool('weather') ? NAIROBI : 'Say hello in five words.' }] }],
    }),
  });
  assert(res.ok, `HTTP ${res.status}`);
  assert(res.headers.get('access-control-allow-origin') === WEB_ORIGIN, `CORS header ${res.headers.get('access-control-allow-origin')}`);
  const parts = (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data: {'))
    .map((l) => JSON.parse(l.slice(6)));
  const types = new Set(parts.map((p) => p.type));
  const err = parts.find((p) => p.type === 'error');
  assert(!err, `error part: ${err?.errorText}`);
  assert(types.has('text-delta') && types.has('finish'), `part types: ${[...types]}`);
  if (hasTool('weather')) assert(types.has('tool-output-available'), `no tool output; part types: ${[...types]}`);
  return `${parts.length} parts${types.has('tool-output-available') ? ', tool output included' : ''}`;
});

// --- the CLI binary itself --------------------------------------------------------
await check('cli ask --json', async () => {
  const out = execFileSync('pnpm', ['--filter', '@locci/example-cli', 'run', '-s', 'ask', '--json', 'Reply with exactly: pong'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, API_URL: API },
  });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert(r.ok, `errors: ${r.errors.join('; ')} text: ${JSON.stringify(r.text)}`);
  return JSON.stringify(r.text.trim().slice(0, 40));
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
