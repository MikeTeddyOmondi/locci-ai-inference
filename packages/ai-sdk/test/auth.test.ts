import assert from "node:assert/strict";
import { test } from "node:test";

import { createAuthFetch, LocciAuthError } from "../src/auth.ts";

const AUTH = "https://auth.test";
const API = "https://gw.test/v1/chat/completions";

/** A fake network: counts exchanges, records the bearer each API call carried. */
function fakeNet(opts: { expiresIn?: number; rejectFirstApiCall?: boolean } = {}) {
  let minted = 0;
  const bearers: string[] = [];
  let apiCalls = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${AUTH}/keys/token`) {
      assert.equal(new Headers(init?.headers).get("x-locci-api-key"), "lk_test");
      minted++;
      return Response.json({ token: `tok-${minted}`, expiresIn: opts.expiresIn ?? 3600 });
    }
    apiCalls++;
    bearers.push(new Headers(init?.headers).get("authorization") ?? "");
    if (opts.rejectFirstApiCall && apiCalls === 1) return new Response("expired", { status: 401 });
    return Response.json({ ok: true });
  };
  return { fetch, bearers, minted: () => minted };
}

test("exchanges an API key once and reuses the token", async () => {
  const net = fakeNet();
  const f = createAuthFetch({ apiKey: "lk_test", authURL: AUTH, fetch: net.fetch });
  await f(API, { method: "POST", body: "{}" });
  await f(API, { method: "POST", body: "{}" });
  assert.equal(net.minted(), 1);
  assert.deepEqual(net.bearers, ["Bearer tok-1", "Bearer tok-1"]);
});

test("parallel first requests share one exchange", async () => {
  const net = fakeNet();
  const f = createAuthFetch({ apiKey: "lk_test", authURL: AUTH, fetch: net.fetch });
  await Promise.all([1, 2, 3, 4].map(() => f(API, { method: "POST", body: "{}" })));
  assert.equal(net.minted(), 1);
});

test("re-exchanges once the token is inside the expiry skew", async () => {
  // 30s lifetime is already inside the 60s skew, so every request re-exchanges.
  const net = fakeNet({ expiresIn: 30 });
  const f = createAuthFetch({ apiKey: "lk_test", authURL: AUTH, fetch: net.fetch });
  await f(API, { method: "POST", body: "{}" });
  await f(API, { method: "POST", body: "{}" });
  assert.equal(net.minted(), 2);
});

test("a 401 triggers one re-exchange and one retry", async () => {
  const net = fakeNet({ rejectFirstApiCall: true });
  const f = createAuthFetch({ apiKey: "lk_test", authURL: AUTH, fetch: net.fetch });
  const res = await f(API, { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.equal(net.minted(), 2);
  assert.deepEqual(net.bearers, ["Bearer tok-1", "Bearer tok-2"]);
});

test("an access token is sent as-is and never exchanged or retried", async () => {
  const net = fakeNet({ rejectFirstApiCall: true });
  const f = createAuthFetch({ accessToken: "user-tok", apiKey: "lk_test", authURL: AUTH, fetch: net.fetch });
  const res = await f(API, { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  assert.equal(net.minted(), 0);
  assert.deepEqual(net.bearers, ["Bearer user-tok"]);
});

test("getAccessToken is called per request", async () => {
  const net = fakeNet();
  let n = 0;
  const f = createAuthFetch({ getAccessToken: async () => `fresh-${++n}`, authURL: AUTH, fetch: net.fetch });
  await f(API, {});
  await f(API, {});
  assert.deepEqual(net.bearers, ["Bearer fresh-1", "Bearer fresh-2"]);
});

test("a lazily supplied API key is read at request time", async () => {
  const net = fakeNet();
  let key: string | undefined;
  const f = createAuthFetch({ apiKey: () => key, authURL: AUTH, fetch: net.fetch });
  await assert.rejects(f(API, {}), LocciAuthError);
  key = "lk_test";
  await f(API, {});
  assert.equal(net.minted(), 1);
});

test("a failed exchange surfaces as LocciAuthError with the status", async () => {
  const f = createAuthFetch({
    apiKey: "lk_bad",
    authURL: AUTH,
    fetch: async () => Response.json({ error: "Invalid API key" }, { status: 401 }),
  });
  await assert.rejects(f(API, {}), (e: unknown) => e instanceof LocciAuthError && e.status === 401);
});
