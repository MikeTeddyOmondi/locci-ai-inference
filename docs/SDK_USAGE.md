# SDK usage (`@locci/ai-sdk`)

`@locci/ai-sdk` is the gateway's provider for the [Vercel AI SDK](https://ai-sdk.dev) (v7). Anything the AI SDK does with a model (`streamText`, `generateText`, `embed`, `useChat`) works with `locci(...)` models. The package source is in [`packages/ai-sdk`](../packages/ai-sdk).

For raw HTTP, see [API_USAGE.md](API_USAGE.md).

**How this was verified.** Each snippet below was copied into a fresh project that installs the package from its folder. They were typechecked together, and every server-side one was run against the local stack (`just up`, `just auth`, embeddings and vision pools on). The two browser components (React, Svelte) were typechecked only.

## Install

The package is not on npm yet. Build it, then depend on its folder:

```bash
just sdk-build    # in this repo: writes packages/ai-sdk/dist
```

```bash
pnpm add ai zod "@locci/ai-sdk@file:../locci-ai-inference/packages/ai-sdk"
```

`ai` and `zod` are peer dependencies, as with every AI SDK provider.

## Configure

| Env | Setting | Default |
| --- | --- | --- |
| `LOCCI_API_KEY` | `apiKey` | none; read on every request |
| `LOCCI_AI_BASE_URL` | `baseURL` | `http://localhost:8080/v1` (local stack; no public host yet) |
| `LOCCI_AUTH_URL` | `authURL` | `https://auth.locci.cloud` |

Against the local stack, point key exchange at the local locci-auth:

```bash
export LOCCI_API_KEY=...                     # a Locci API key
export LOCCI_AUTH_URL=http://localhost:8787
```

## Stream text

```ts
// file: quickstart.ts
import { streamText } from "ai";
import { locci } from "@locci/ai-sdk";

const result = streamText({
  model: locci("qwen3-1.7b"),
  prompt: "Write a Go function that reverses a string.",
  maxOutputTokens: 200,
});

for await (const delta of result.textStream) process.stdout.write(delta);
console.log("\nusage:", await result.usage);
```

`locci` is a default instance built from the environment. `usage` matches what the gateway meters for your tenant.

## Generate text

```ts
// file: generate.ts
import { generateText } from "ai";
import { locci } from "@locci/ai-sdk";

const { text, usage, finishReason } = await generateText({
  model: locci("qwen3-1.7b"),
  system: "You are terse.",
  prompt: "What does `defer` do in Go? One sentence.",
  maxOutputTokens: 60,
  temperature: 0.2,
});

console.log(text);
console.log(finishReason, usage.inputTokens, usage.outputTokens);
```

## A small CLI

```ts
// file: cli.ts
// Usage: tsx cli.ts "your prompt"   (needs LOCCI_API_KEY)
import { streamText } from "ai";
import { createLocci } from "@locci/ai-sdk";

const prompt = process.argv.slice(2).join(" ");
if (!prompt) {
  console.error('usage: cli "<prompt>"');
  process.exit(2);
}

const locci = createLocci(); // same as the default instance; pass options to override
const result = streamText({ model: locci("qwen3-1.7b"), prompt });
for await (const delta of result.textStream) process.stdout.write(delta);
process.stdout.write("\n");
```

The API key is exchanged once and cached; a long-running CLI re-exchanges before the hour is up without any code of yours.

## Embeddings

Needs the embeddings pool running.

```ts
// file: embeddings.ts
import { cosineSimilarity, embed, embedMany } from "ai";
import { locci } from "@locci/ai-sdk";

const model = locci.embeddingModel("embedding-nomic");

const { embeddings } = await embedMany({
  model,
  values: ["How do I reverse a slice in Go?", "Recipe for banana bread"],
});
const { embedding: query } = await embed({ model, value: "golang slices" });

console.log("dimensions:", query.length);
console.log("go question:", cosineSimilarity(query, embeddings[0]).toFixed(3));
console.log("banana bread:", cosineSimilarity(query, embeddings[1]).toFixed(3));
```

## Tool calling

`qwen3-1.7b` calls tools through the standard AI SDK API (`qwen2.5-coder-1.5b` cannot). `just tools-sdk` checks this end to end.

```ts
// file: tools.ts
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { locci } from "@locci/ai-sdk";

const { text, steps } = await generateText({
  model: locci("qwen3-1.7b"),
  tools: {
    getWeather: tool({
      description: "Get the current weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, tempC: 24, sky: "sunny" }),
    }),
  },
  stopWhen: stepCountIs(3), // call the tool, then answer with its result
  temperature: 0,
  prompt: "What is the weather in Nairobi right now?",
});

console.log(steps.flatMap((s) => s.toolCalls).map((c) => `${c.toolName}(${JSON.stringify(c.input)})`));
console.log(text);
```

Use `temperature: 0` when the call must happen reliably; at higher temperatures a 1.7B model occasionally opens with text instead of the call.

## Document OCR

`baidu-ocr-vision` (PaddleOCR-VL) takes an image plus a task prompt: `OCR:`, `Table Recognition:`, `Formula Recognition:`, `Chart Recognition:` or `Seal Recognition:`. Needs the vision pool running.

```ts
// file: ocr.ts
import { readFile } from "node:fs/promises";
import { generateText } from "ai";
import { locci } from "@locci/ai-sdk";

const { text } = await generateText({
  model: locci("baidu-ocr-vision"),
  temperature: 0,
  maxOutputTokens: 512,
  messages: [{
    role: "user",
    content: [
      { type: "file", data: await readFile(process.env.IMAGE ?? "ocr-text.png"), mediaType: "image/png" },
      { type: "text", text: "OCR:" },
    ],
  }],
});

console.log(text);
```

Images go in a `file` part with an image `mediaType` (AI SDK 7 deprecates the older `image` part). Tables come back as OTSL tokens (`<fcel>` cell, `<nl>` row end), not HTML. On the local CPU stack a new image takes two to three minutes, while the same image again returns in seconds because the node reuses its prompt cache; the SDK's fetch has no timeout of its own, but put long timeouts on anything in front of it (for example a serverless function limit).

## Choosing credentials

```ts
// file: credentials.ts
import { createLocci } from "@locci/ai-sdk";

// CLI or job: a Locci API key, exchanged for 1h access tokens automatically.
export const fromKey = createLocci({ apiKey: process.env.LOCCI_API_KEY });

// Server acting for a signed-in user: their locci-auth access token, sent as-is.
export const forUser = (accessToken: string) => createLocci({ accessToken });

// Server with its own refresh logic: called before every request.
export const refreshing = createLocci({
  getAccessToken: async () => (await fetch("http://localhost:9999/my-token")).text(),
});

// Another gateway or auth host.
export const custom = createLocci({
  baseURL: "https://ai.example.test/v1",
  authURL: "https://auth.example.test",
  apiKey: "...",
});
```

If more than one is given, `getAccessToken` wins over `accessToken`, which wins over `apiKey`. Only the `apiKey` path refreshes and retries on `401`.

## Errors

```ts
// file: errors.ts
import { APICallError, generateText } from "ai";
import { createLocci, LocciAuthError } from "@locci/ai-sdk";

function locciAuthError(error: unknown): LocciAuthError | undefined {
  // The SDK may wrap fetch errors; look through the cause chain.
  for (let e = error; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof LocciAuthError) return e;
  }
}

try {
  await generateText({ model: createLocci()("no-such-model"), prompt: "hi" });
} catch (error) {
  if (APICallError.isInstance(error)) console.log("gateway said", error.statusCode); // 400
}

try {
  await generateText({
    model: createLocci({ apiKey: "not-a-key" })("qwen3-1.7b"),
    prompt: "hi",
    maxRetries: 0,
  });
} catch (error) {
  console.log("auth failed with", locciAuthError(error)?.status); // 401
}
```

| Situation | What you get |
| --- | --- |
| Unknown model, invalid request | `APICallError`, `statusCode` 400 |
| Bad or revoked API key | `LocciAuthError`, `status` 401 (possibly as a `cause`) |
| Expired or invalid access token | `APICallError`, `statusCode` 401 |
| Rate limited | `APICallError`, `statusCode` 429 |
| Pool down | `APICallError`, `statusCode` 502 |

The SDK retries 429 and 5xx responses itself (`maxRetries`, default 2) before throwing, so a down pool takes three attempts to fail; pass `maxRetries: 0` to fail fast.

## Web apps

Call the model on your server and stream to the browser. Never send an API key or access token to the client.

### Next.js route handler

```ts
// file: next-route.ts
// app/api/chat/route.ts
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { createLocci } from "@locci/ai-sdk";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // Wherever your app keeps the signed-in user's locci-auth access token.
  const accessToken = req.headers.get("cookie")?.match(/access_token=([^;]+)/)?.[1];
  if (!accessToken) return new Response("Unauthorized", { status: 401 });

  const locci = createLocci({ accessToken });
  const result = streamText({
    model: locci("qwen3-1.7b"),
    messages: await convertToModelMessages(messages),
  });
  return result.toUIMessageStreamResponse();
}
```

### SvelteKit endpoint

```ts
// file: sveltekit-route.ts
// src/routes/api/chat/+server.ts
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { error, type RequestHandler } from "@sveltejs/kit";
import { createLocci } from "@locci/ai-sdk";

export const POST: RequestHandler = async ({ request, cookies }) => {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const accessToken = cookies.get("access_token");
  if (!accessToken) error(401, "Unauthorized");

  const locci = createLocci({ accessToken });
  const result = streamText({
    model: locci("qwen3-1.7b"),
    messages: await convertToModelMessages(messages),
  });
  return result.toUIMessageStreamResponse();
};
```

### React client

```tsx
// file: Chat.tsx
"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";

export function Chat() {
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const [input, setInput] = useState("");

  return (
    <div>
      {messages.map((m) => (
        <p key={m.id}>
          <b>{m.role}:</b> {m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
        </p>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage({ text: input });
          setInput("");
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} disabled={status !== "ready"} />
      </form>
    </div>
  );
}
```

### Svelte client

```svelte
<!-- src/lib/Chat.svelte -->
<script lang="ts">
  import { Chat } from "@ai-sdk/svelte";
  import { DefaultChatTransport } from "ai";

  const chat = new Chat({ transport: new DefaultChatTransport({ api: "/api/chat" }) });
  let input = $state("");

  function submit(e: SubmitEvent) {
    e.preventDefault();
    chat.sendMessage({ text: input });
    input = "";
  }
</script>

{#each chat.messages as m (m.id)}
  <p><b>{m.role}:</b> {m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</p>
{/each}
<form onsubmit={submit}>
  <input bind:value={input} disabled={chat.status !== "ready"} />
</form>
```

## Models

```ts
// file: models.ts
import { LOCCI_CHAT_MODELS, LOCCI_EMBEDDING_MODELS, type LocciChatModelId } from "@locci/ai-sdk";

const pick: LocciChatModelId = "qwen3-1.7b"; // autocompletes; other strings still allowed
console.log(LOCCI_CHAT_MODELS, LOCCI_EMBEDDING_MODELS, pick);
```

| Id | Kind | Running locally |
| --- | --- | --- |
| `qwen3-1.7b` | chat, code, tools | Qwen3-1.7B |
| `qwen2.5-coder-1.5b` | code generation; **no tool calling** | Qwen2.5-Coder-1.5B |
| `baidu-ocr-vision` | document OCR (image in, text out) | PaddleOCR-VL 1.6; vision pool off by default |
| `embedding-nomic` | embeddings | nomic-embed-text v1.5, 768 dimensions |

To ask the gateway what it serves right now (for a model picker), call `listModels()`. It reads `GET /v1/models` with the same settings and auth as model calls:

```ts
// file: list-models.ts
import { listModels } from "@locci/ai-sdk";

const models = await listModels(); // [{ id: "qwen3-1.7b", pool: "/coder" }, ...]
console.log(models.map((m) => m.id));
```

It throws on a non-2xx response. The example API wraps it as `GET /models` for the web client: [examples/README.md](../examples/README.md#api).

Which models and why: [SLMS.md](SLMS.md). Which id to use for which call (and what a wrong one returns): [README](../README.md#which-model-for-what).

## Not supported yet

- **`generateObject`.** Untested.
- **Browser-direct calls.** The edge has no CORS config; go through your server as above.
