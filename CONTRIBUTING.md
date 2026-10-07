# Contributing

Thanks for helping with the Locci AI Gateway. This guide covers setting up the stack, the checks each kind of change needs, and the conventions the git hooks enforce. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md); security issues go through [SECURITY.md](SECURITY.md) (email [hi@mt0.dev](mailto:hi@mt0.dev)), not public issues.

## What's here

| Path | What | Language |
| --- | --- | --- |
| `locci-ai-gateway/` | Router: model registry, SSE proxy, per-tenant metering | Go |
| `krakend/`, `nginx/`, `compose.yaml` | Edge (JWT, rate limits), pools, the local stack | config |
| `packages/ai-sdk/` | `@locci/ai-sdk`, the Vercel AI SDK provider | TypeScript |
| `examples/` | Real apps on the SDK, used to catch regressions (`api`, `cli`, `web`) | TypeScript, Svelte |
| `scripts/` | Model downloads, token minting, checks, `gguf-info.py` | sh, Node, Python |
| `docs/` | API, SDK, llama-server and model docs | Markdown |

Start with the [README](README.md); `docs/` has the details.

## Prerequisites

- Docker with Compose (Colima or Docker Desktop). The local stack needs about 6.5 GiB of memory for the VM; see [docs/LLAMA_SERVER.md](docs/LLAMA_SERVER.md#measured-on-this-machine).
- Go 1.26, Node 22+, pnpm 10 (`corepack enable`), [just](https://github.com/casey/just), Python 3 (scripts), `curl`, `openssl`.
- [locci-auth](../locci-auth) checked out next to this repo; it issues the tokens the gateway validates.
- Optional: Bun, for the example TUI.

## Setup

```bash
git clone <this repo> && cd locci-ai-inference
git config core.hooksPath .githooks   # the commit hooks (done for you by `pnpm install` too)
pnpm install                          # workspace: packages/* and examples/*
just models                           # coder models (~2.3 GB); add --vision / --embed as needed
just auth                             # terminal 1: locci-auth on :8787
just up                               # the stack, waits until healthy
just smoke                            # sanity check
```

For the examples: `just examples-env` (builds their `.env` files and mints an API key), then `just examples-api` in another terminal.

## Making a change

Run the checks for what you touched before opening a pull request. Paste their output (or the PASS/FAIL lines) into the PR.

| You changed | Run |
| --- | --- |
| The router (`locci-ai-gateway/`) | `just check` (gofmt, vet, tests), then `just up-gateway` and `just smoke` |
| KrakenD, nginx or `compose.yaml` | `just krakend` (validates and restarts KrakenD) or `just up`, then `just smoke` and `just tools-api` |
| The SDK (`packages/ai-sdk/`) | `just sdk-test`, `just sdk-e2e`, `just tools-sdk`, and `just examples-check` (the examples run the current SDK source) |
| An example app | `just examples-check`; for web UI changes also try it in a browser (`just examples-web`) |
| A model, or llama-server flags | `just smoke`, `just tools-api`, `just tools-sdk`, `just examples-check`, and record memory (below) |
| OCR / the vision pool | `just ocr-api` |
| Docs | Run any command or snippet you added or changed; the docs say what they were verified against, so keep that true |

`just` with no arguments lists every recipe.

### Changing a model

- Model ids name what runs. If you swap the model behind an id, rename the id in **both** `ModelRegistry` (`locci-ai-gateway/main.go`) and `packages/ai-sdk/src/models.ts`; `just sdk-test` fails if they drift.
- Try a model without editing files first: `CODER_MODEL=<file>.gguf docker compose up -d --wait llama-coder-1` (see "Trying a candidate" in [docs/SLMS.md](docs/SLMS.md)).
- `scripts/gguf-info.py models/<file>.gguf` shows a model's KV cost per token and tool-call template before you run it.
- Measure memory after `just examples-check` with `docker compose exec llama-coder-1 grep RssAnon /proc/1/status` (not `docker stats`, which overstates right after a restart), and update the numbers in `docs/SLMS.md` and `docs/LLAMA_SERVER.md`.
- Add the download to `scripts/fetch-models.sh`; model files are git-ignored.

## Conventions

The hooks in `.githooks/` enforce most of these; a blocked commit tells you why.

- **Commit messages are one line**, subject only, no body. Explanations go in the PR description or the docs.
- **No AI attribution** in commits or PRs (no `Co-Authored-By` trailers for tools, no "Generated with" notes).
- **No em or en dashes** in anything committed (code, comments, docs, messages); use a period, comma, colon or parentheses. Straight quotes only.
- **Pin dependency versions exactly** in `package.json` (no `^` or `~`), then `pnpm install` so the lockfile matches.
- **Match the surrounding code**: comment density, naming, idiom. Go is `gofmt`ed.
- **Never commit secrets**: `.env` files, `examples/api/mcp.json` and model files are git-ignored. Each app has a committed `.env.example` instead.
- **Keep docs honest**: when behaviour, numbers or commands change, update the doc that describes them in the same PR, and say what was measured versus estimated.

## Pull requests

- One logical change per PR, on a branch off the default branch.
- Describe what changed and why, how you tested it (the checks above), and any numbers that moved (memory, tokens per second, prompt tokens).
- Note anything the checks can't cover (UI behaviour, a TUI interaction) and how you verified it by hand.

## License

This project is dual-licensed under either of

- [Apache License, Version 2.0](APACHE_LICENSE.md)
- [MIT License](MIT_LICENSE.md)

at your option. Unless you explicitly state otherwise, any contribution you intentionally submit for inclusion in this project, as defined in the Apache-2.0 license, is dual-licensed as above, without any additional terms or conditions.
