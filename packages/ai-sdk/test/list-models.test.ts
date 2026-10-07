import assert from "node:assert/strict";
import { test } from "node:test";

import { listModels } from "../src/index.ts";

test("lists the gateway's models with the access token", async () => {
  let seen: { url: string; auth: string | null } | undefined;
  const models = await listModels({
    baseURL: "https://gw.test/v1/",
    accessToken: "tok",
    fetch: async (input, init) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
      return Response.json({
        object: "list",
        data: [{ id: "qwen3-1.7b", object: "model", owned_by: "locci", pool: "/coder" }],
      });
    },
  });
  assert.deepEqual(seen, { url: "https://gw.test/v1/models", auth: "Bearer tok" });
  assert.deepEqual(models, [{ id: "qwen3-1.7b", pool: "/coder" }]);
});

test("throws on a non-2xx response", async () => {
  await assert.rejects(
    listModels({
      baseURL: "https://gw.test/v1",
      accessToken: "tok",
      fetch: async () => new Response("nope", { status: 401, statusText: "Unauthorized" }),
    }),
    /401/,
  );
});
