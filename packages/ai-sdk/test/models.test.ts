import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { LOCCI_CHAT_MODELS, LOCCI_EMBEDDING_MODELS } from "../src/models.ts";

/** Parse `ModelRegistry` out of the router so the two cannot drift silently. */
function registry(): Map<string, string> {
  const src = readFileSync(new URL("../../../locci-ai-gateway/main.go", import.meta.url), "utf8");
  const block = src.match(/var ModelRegistry = map\[string\]string\{([\s\S]*?)\n\}/);
  assert.ok(block, "ModelRegistry not found in main.go");
  return new Map([...block[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

test("package model ids match the gateway's ModelRegistry", () => {
  const reg = registry();
  const embed = [...reg].filter(([, pool]) => pool === "/embed").map(([id]) => id).sort();
  const chat = [...reg].filter(([, pool]) => pool !== "/embed").map(([id]) => id).sort();
  assert.deepEqual([...LOCCI_CHAT_MODELS].sort(), chat);
  assert.deepEqual([...LOCCI_EMBEDDING_MODELS].sort(), embed);
});
