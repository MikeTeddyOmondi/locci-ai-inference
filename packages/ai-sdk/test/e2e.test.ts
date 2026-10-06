/**
 * End to end through the running stack: KrakenD on :8080, locci-auth on :8787.
 * Run with `just sdk-e2e`, which supplies LOCCI_TEST_ACCESS_TOKEN.
 *
 * The API-key path is exercised for real: a throwaway key is created with the
 * access token, used through the provider, and revoked afterwards.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { generateText, streamText } from "ai";

import { createLocci, LocciAuthError } from "../src/index.ts";

const AUTH_URL = process.env.LOCCI_AUTH_URL ?? "http://localhost:8787";
const BASE_URL = process.env.LOCCI_AI_BASE_URL ?? "http://localhost:8080/v1";
const ACCESS = process.env.LOCCI_TEST_ACCESS_TOKEN;

const KEY_NAME = "ai-sdk-e2e";
let apiKey = "";

async function authCall(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${ACCESS}`);
  return fetch(`${AUTH_URL}${path}`, { ...init, headers });
}

before(async () => {
  assert.ok(ACCESS, "LOCCI_TEST_ACCESS_TOKEN is not set; run via `just sdk-e2e`");
  const res = await authCall("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: KEY_NAME }),
  });
  assert.equal(res.status, 201, `creating a test API key failed: ${await res.clone().text()}`);
  apiKey = ((await res.json()) as { key: string }).key;
});

after(async () => {
  if (!ACCESS) return;
  const list = (await (await authCall("/keys")).json()) as { keys?: { id: string; name: string }[] } | { id: string; name: string }[];
  const keys = Array.isArray(list) ? list : (list.keys ?? []);
  for (const k of keys.filter((k) => k.name === KEY_NAME)) {
    await authCall(`/keys/${k.id}`, { method: "DELETE" });
  }
});

test("streamText with an API key streams tokens and reports usage", async () => {
  const locci = createLocci({ baseURL: BASE_URL, authURL: AUTH_URL, apiKey });
  const result = streamText({
    model: locci("qwen-coder-7b"),
    prompt: "Reply with exactly: hello from locci",
    maxOutputTokens: 16,
  });

  let chunks = 0;
  let text = "";
  for await (const delta of result.textStream) {
    chunks++;
    text += delta;
  }
  const usage = await result.usage;

  assert.ok(chunks > 1, `expected a streamed response, got ${chunks} chunk(s)`);
  assert.ok(text.trim().length > 0, "empty completion");
  assert.ok((usage.inputTokens ?? 0) > 0, `no input tokens in usage: ${JSON.stringify(usage)}`);
  assert.ok((usage.outputTokens ?? 0) > 0, `no output tokens in usage: ${JSON.stringify(usage)}`);
});

test("generateText with a user's access token", async () => {
  const locci = createLocci({ baseURL: BASE_URL, accessToken: ACCESS });
  const { text, usage } = await generateText({
    model: locci("qwen-coder-7b"),
    prompt: "Say hi in three words.",
    maxOutputTokens: 12,
  });
  assert.ok(text.trim().length > 0);
  assert.ok((usage.totalTokens ?? 0) > 0);
});

test("an unknown model is a 400 from the gateway, surfaced as an API error", async () => {
  const locci = createLocci({ baseURL: BASE_URL, accessToken: ACCESS });
  await assert.rejects(
    generateText({ model: locci("not-a-model"), prompt: "hi" }),
    (e: unknown) => (e as { statusCode?: number }).statusCode === 400,
  );
});

test("a bad API key fails at exchange with LocciAuthError", async () => {
  const locci = createLocci({ baseURL: BASE_URL, authURL: AUTH_URL, apiKey: "not-a-real-key" });
  await assert.rejects(
    generateText({ model: locci("qwen-coder-7b"), prompt: "hi", maxRetries: 0 }),
    (e: unknown) => {
      // The SDK may wrap fetch errors; find ours in the cause chain.
      for (let cur: unknown = e; cur; cur = (cur as { cause?: unknown }).cause) {
        if (cur instanceof LocciAuthError) return cur.status === 401;
      }
      return false;
    },
  );
});
