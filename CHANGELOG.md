# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every entry ends with the short hash of the commit that made it. `scripts/changelog.sh`
and the git hooks keep the list complete; see [CONTRIBUTING.md](CONTRIBUTING.md#changelog).

## [Unreleased]

### Added

- Initial working stack: KrakenD edge with locci-auth JWTs, the Go/Gin router with per-tenant metering, Nginx pools and llama-server, fixed up from REFERENCE.md so it runs (`9ab2f42`)
- Add a justfile for dev commands (`3b38679`)
- Add build and run recipes for the gateway binary (`1337ca7`)
- Add @locci/ai-sdk, a Vercel AI SDK provider for the gateway (`af32365`)
- Add verified API and SDK usage docs (`8dfe8a6`)
- Add llama-server and SLM docs, tool-calling checks for the API and SDK (`ed24b2f`)
- Document which model id to use for each endpoint (`0c914e4`)
- Add api, cli and web example apps on @locci/ai-sdk in a pnpm workspace (`de0da8a`)
- Document Qwen candidate models with resource estimates and add gguf-info (`cded830`)
- Add code of conduct, contributing guide, security policy and MIT/Apache-2.0 licenses (`f828cac`)
- Add hi@mt0.dev as the security and conduct contact (`3fd65b1`)
- Add listModels to @locci/ai-sdk for model pickers (`2f01802`)
- Let the example API serve /models, pick a model per chat and run web search itself (`5dae9aa`)
- Turn long pastes into previewable files and collapse long messages in the web UI (`267f914`)
- Add a Keep a Changelog CHANGELOG.md kept in step by git hooks (`856e0a6`)

### Changed

- Rename docker-compose.yml to compose.yaml (`8e0c4d6`)
- Rename LOCCI to LOCCI_AI_GATEWAY in API docs and ignore .DS_Store (`1d0c81e`)
- Swap in Qwen3-1.7B and PaddleOCR-VL 1.6, pin llama.cpp, add OCR checks and docs (`ffcf99e`)
- Split coder ids into qwen3-1.7b and qwen2.5-coder-1.5b pools (`c96a80c`)
- Show the CLI's output when the examples ask check fails (`2d9851d`)
- Rename example packages to @locci/example-ai-* (`81f0b72`)
- Ignore Python bytecode caches (`1e22fa5`)
- Redesign the web example as the Locci AI chat UI on shadcn-svelte (`cf1d692`)
- Show the thinking indicator as shimmering text with a typing-dot ellipsis (`d3a5674`)
- Use canonical Tailwind classes in the chat view (`c260baf`)
- Move the reference fixes into REFERENCE.md and open issues into BACKLOG.md (`0ca9cd0`)
- Show the loccibox MCP server's env settings in the example config (`a27ef33`)

### Fixed

- Return JSON for unavailable pools and the requested model id in responses (`33dcdba`)
- Cap llama-server prompt cache RAM to stop OOM kills under tool load (`a3246a9`)
- Trim web search results to fit the model's context window (`5928f1e`)
- Fit web chats into the model's context and keep attachments readable to it (`91997f2`)
- Stop pnpm's npm_config variables reaching npx-based MCP servers (`82cda7a`)

