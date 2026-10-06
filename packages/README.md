# packages

Client libraries for the Locci AI Gateway. Each folder is a self-contained package with its own `package.json`, dependencies and tests; the gateway itself lives in [`../locci-ai-gateway`](../locci-ai-gateway).

| Folder | Package | What it does |
| --- | --- | --- |
| [`ai-sdk/`](ai-sdk) | `@locci/ai-sdk` | Provider for the [Vercel AI SDK](https://ai-sdk.dev). Lets CLIs, servers and web apps (React, Svelte) call the gateway with `streamText`, `generateText`, `embed` and `useChat`. |

## `ai-sdk/`: `@locci/ai-sdk`

A thin layer over `@ai-sdk/openai-compatible`, since the gateway speaks the OpenAI-compatible API. It adds:

- **Locci's model ids**, typed (`qwen3-1.7b`, `embedding-nomic`, ...), with a test that fails if they drift from the router's `ModelRegistry`.
- **Auth**: a Locci API key is exchanged at locci-auth's `/keys/token` for a one-hour access token, cached, and refreshed before expiry or after a `401`. Servers can pass a user's access token instead.
- **Usage**: always requests token usage, so `result.usage` matches what the gateway meters per tenant.

```ts
import { locci } from "@locci/ai-sdk";
import { streamText } from "ai";

const result = streamText({ model: locci("qwen3-1.7b"), prompt: "Reverse a string in Go" });
```

| Path | Contents |
| --- | --- |
| `src/` | `index.ts` (provider, `createLocci`, `locci`), `auth.ts` (token exchange and refresh), `models.ts` (model ids) |
| `test/` | Unit tests (auth, model drift) and an end-to-end test against the running stack |
| `scripts/` | `tool-calls.ts`, a tool-calling check through the gateway |

Not on npm yet (`private: true`); depend on the folder after `just sdk-build`. Full guide: [docs/SDK_USAGE.md](../docs/SDK_USAGE.md); package details: [ai-sdk/README.md](ai-sdk/README.md).

## Working on packages

From the repo root:

```bash
just sdk-install   # pnpm install in packages/ai-sdk
just sdk-test      # typecheck and unit tests
just sdk-build     # compile to packages/ai-sdk/dist
just sdk-e2e       # against the running stack (needs `just up` and `just auth`)
just tools-sdk     # tool-calling check with the AI SDK
```

Each package manages its own dependencies with pnpm; there is no workspace root yet. A new package goes in its own folder here with a row in the table above.
