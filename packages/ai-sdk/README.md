# @locci/ai-sdk

[Vercel AI SDK](https://ai-sdk.dev) provider for the Locci AI Gateway. The gateway speaks the OpenAI-compatible API, so this is a thin layer over `@ai-sdk/openai-compatible` that adds Locci's model ids, defaults and auth.

```ts
import { locci } from "@locci/ai-sdk";
import { streamText, embed } from "ai";

const result = streamText({ model: locci("qwen-coder-7b"), prompt: "Reverse a string in Go" });
for await (const delta of result.textStream) process.stdout.write(delta);

const { embedding } = await embed({ model: locci.embeddingModel("embedding-nomic"), value: "hello" });
```

## Auth

The gateway's edge accepts locci-auth access tokens. Pass whichever credential you hold:

| Caller | Setting | Behaviour |
| --- | --- | --- |
| CLI, script, backend job | `apiKey` or `LOCCI_API_KEY` | Exchanged at `${authURL}/keys/token`; the 1h token is cached, re-exchanged 60s before expiry, and once more after a 401 |
| Server acting for a signed-in user | `accessToken` | Sent as-is |
| Server with its own refresh logic | `getAccessToken()` | Called before every request |

```ts
import { createLocci } from "@locci/ai-sdk";

// CLI
const locci = createLocci({ apiKey: process.env.LOCCI_API_KEY });

// SvelteKit / Next route handler, on behalf of the signed-in user
const locci = createLocci({ accessToken: session.accessToken });
```

A failed key exchange throws `LocciAuthError` (with `.status`), possibly wrapped by the SDK in its own error's `cause`.

## Web apps (React, Svelte)

Call the model from your server and stream to the browser; do not ship tokens or API keys to the client. In a route handler:

```ts
// SvelteKit: src/routes/api/chat/+server.ts
import { streamText, convertToModelMessages } from "ai";
import { createLocci } from "@locci/ai-sdk";

export async function POST({ request, locals }) {
  const { messages } = await request.json();
  const locci = createLocci({ accessToken: locals.accessToken });
  return streamText({ model: locci("qwen-coder-7b"), messages: await convertToModelMessages(messages) })
    .toUIMessageStreamResponse();
}
```

On the client use `useChat` from `@ai-sdk/react` or `Chat` from `@ai-sdk/svelte`, pointed at that route.

## Settings

| Option | Env | Default |
| --- | --- | --- |
| `baseURL` | `LOCCI_AI_BASE_URL` | `http://localhost:8080/v1` (the local stack; there is no public host yet) |
| `authURL` | `LOCCI_AUTH_URL` | `https://auth.locci.cloud` |
| `apiKey` | `LOCCI_API_KEY` (read per request) | none |
| `accessToken`, `getAccessToken`, `headers`, `fetch` | | none |

## Models

`LOCCI_CHAT_MODELS` and `LOCCI_EMBEDDING_MODELS` list the ids; unknown ids still type-check and the gateway answers `400`. `test/models.test.ts` fails if the list drifts from `ModelRegistry` in `locci-ai-gateway/main.go`.

## Not supported yet

Tool calling works through this provider (`just tools-sdk` checks it), but only with a model trained to emit tool calls; the current local coder stand-in is not. See [docs/LLAMA_SERVER.md](../../docs/LLAMA_SERVER.md#tool-calling). `generateObject` is untested.

## Development

From the repo root: `just sdk-test` (typecheck and unit tests), `just sdk-build`, and `just sdk-e2e` (against the running stack and local locci-auth; creates and revokes a throwaway API key).
