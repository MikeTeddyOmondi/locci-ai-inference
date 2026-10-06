/**
 * Tool calling through the gateway with the AI SDK and @locci/ai-sdk.
 *
 * Mirrors scripts/tool-calls-api.sh: it checks the protocol (a well-formed
 * tool call reaches `execute` with typed input, results flow back, streaming
 * emits tool-call parts), not the model's judgement. `toolChoice: "auto"` is
 * reported but never fails the run.
 *
 * Run from the repo root with `just tools-sdk`. Credentials: TOKEN (an access
 * token) if set, otherwise LOCCI_API_KEY. MODEL picks the gateway model id.
 */

import { generateText, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import { createLocci } from "../src/index.ts";

const locci = createLocci(process.env.TOKEN ? { accessToken: process.env.TOKEN } : {});
const model = locci(process.env.MODEL ?? "qwen3-1.7b");
const prompt = "What is the weather in Nairobi right now?";

let executed: { city: string }[] = [];
const tools = {
  getWeather: tool({
    description: "Get the current weather for a city",
    inputSchema: z.object({ city: z.string().describe("City name") }),
    execute: async ({ city }) => {
      executed.push({ city });
      return { city, tempC: 24, sky: "sunny" };
    },
  }),
};

let failed = false;
async function check(name: string, fn: () => Promise<string>) {
  try {
    console.log(`PASS ${name}: ${await fn()}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// 1. Forced call: the SDK parses tool_calls, validates input, runs execute.
await check("required tool call", async () => {
  executed = [];
  const r = await generateText({ model, tools, toolChoice: "required", prompt, maxOutputTokens: 128, temperature: 0, stopWhen: stepCountIs(1) });
  const call = r.toolCalls[0];
  assert(call, `no tool call; model said ${JSON.stringify(r.text.slice(0, 160))}`);
  assert(call.toolName === "getWeather", `unexpected tool ${call.toolName}`);
  assert(executed.length === 1 && executed[0].city, "execute was not called with a city");
  return `getWeather(${JSON.stringify(call.input)}) -> ${JSON.stringify(r.toolResults[0]?.output)}`;
});

// 2. Round trip: tool result goes back, the model answers in text.
await check("tool result round trip", async () => {
  executed = [];
  const first = await generateText({ model, tools, toolChoice: "required", prompt, maxOutputTokens: 128, temperature: 0, stopWhen: stepCountIs(1) });
  assert(first.toolCalls.length, "no tool call to answer");
  const second = await generateText({
    model,
    tools,
    toolChoice: "none",
    messages: [{ role: "user", content: prompt }, ...first.response.messages],
    maxOutputTokens: 64,
    temperature: 0,
  });
  assert(second.text.trim(), "no text after the tool result");
  return JSON.stringify(second.text.trim().replace(/\s+/g, " ").slice(0, 100));
});

// 3. Streaming: tool-call parts arrive through fullStream.
await check("streamed tool call", async () => {
  executed = [];
  const r = streamText({
    model, tools, toolChoice: "required", prompt, maxOutputTokens: 128, temperature: 0, stopWhen: stepCountIs(1),
    onError: () => {}, // failures are reported below; skip the SDK's default stderr dump
  });
  const calls: string[] = [];
  for await (const part of r.fullStream) {
    if (part.type === "tool-call") calls.push(`${part.toolName}(${JSON.stringify(part.input)})`);
  }
  assert(calls.length, `no tool-call parts; text was ${JSON.stringify((await r.text).slice(0, 160))}`);
  const usage = await r.usage;
  return `${calls.join(", ")}, usage total=${usage.totalTokens}`;
});

// 4. Auto: informational only.
try {
  const r = await generateText({ model, tools, toolChoice: "auto", prompt, maxOutputTokens: 128, temperature: 0, stopWhen: stepCountIs(1) });
  console.log(`INFO auto tool choice: ${r.toolCalls.length ? `called ${r.toolCalls[0].toolName}` : `answered in text: ${JSON.stringify(r.text.slice(0, 80))}`}`);
} catch (error) {
  console.log(`INFO auto tool choice errored: ${error instanceof Error ? error.message : String(error)}`);
}

process.exit(failed ? 1 : 0);
