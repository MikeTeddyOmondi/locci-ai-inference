# Security Policy

## Supported versions

This project is pre-1.0. Only the latest commit on the default branch is supported; fixes are not backported.

## Scope

In scope:

- the router, `locci-ai-gateway/` (tenant handling, routing, metering, response rewriting)
- the edge configuration, `krakend/krakend.json` (JWT validation, claim propagation, rate limits)
- the load balancer configuration, `nginx/nginx.conf`
- `compose.yaml` and the scripts in `scripts/`
- the SDK, `packages/ai-sdk/` (token exchange, caching, credential handling)
- the example apps, `examples/` (API, CLI, web)

Out of scope, report upstream: llama.cpp / `llama-server`, KrakenD, nginx, locci-auth, and the models themselves (prompt injection or jailbreaks of a model are not vulnerabilities in this repo unless our code turns them into one, for example a tool that acts on model output without checks).

## Reporting a vulnerability

**Do not open a public issue.**

- If the repository is on GitHub, use **private vulnerability reporting**: the repository's *Security* tab, then *Report a vulnerability*.
- Otherwise, contact the maintainer, [MikeTeddyOmondi](https://github.com/MikeTeddyOmondi), privately and ask for a secure channel before sending details.

Include:

- the component and commit affected
- steps to reproduce, ideally against the local stack (`just up`, `just auth`)
- the impact you expect (for example: reading another tenant's usage, bypassing JWT validation, exposing an API key)
- any suggested fix

You will get an acknowledgement, then updates as the report is confirmed and fixed. Please allow a fix to land before disclosing publicly; credit is given in the fix's notes unless you ask otherwise.

## Known limitations (not vulnerabilities)

These are deliberate in the local setup and documented; production deployments must change them:

- KrakenD fetches the JWKS over plain HTTP with `disable_jwk_security`, there is no TLS, and the local issuer is `http://localhost:8787`. Production uses `https://auth.locci.cloud` as both issuer and JWKS origin, with TLS.
- KrakenD's `401` and `429` responses have empty bodies (a KrakenD Community Edition limit).
- Metering only logs (`LogSink`); there is no quota enforcement yet.
- The example API allows CORS from `CORS_ORIGIN` (local dev origins by default) and has no authentication of its own: it is a local test harness, not a service to expose.

## Security-relevant design notes

- **Tenant identity** comes only from the validated JWT: KrakenD propagates the `properties.id` claim as `X-Locci-Tenant` and overwrites any client-sent value (verified). If a valid token ever lacked `properties.id`, a client-supplied header would pass through; every locci-auth user token carries it today. A report showing a token without it is in scope.
- **Secrets** live in git-ignored files only: `.env` files, `examples/api/mcp.json`, and locci-auth's `.dev.vars`. A committed secret is in scope; report it privately so the key can be rotated.
- **The local example API key.** `just examples-env` mints a Locci API key named `locci-ai-inference-examples` into `examples/api/.env`. Revoke it in locci-auth if that file may have leaked.
- **Model files** are downloaded from Hugging Face, some from community quantizers (see `docs/SLMS.md`). Only load GGUF files from sources you trust, and pin the exact file.
