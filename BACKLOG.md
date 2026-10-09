# Backlog

Known gaps and open work, so they are written down in one place rather than in commit messages. Done items move to [CHANGELOG.md](CHANGELOG.md).

## Tenant header and spoofing

KrakenD 2.13 only forwards a `propagate_claims` header when that header is also listed in `input_headers`. Without it, the router sees no tenant and answers 401. Listing it would normally let clients send their own value, but the validator overwrites it with the claim. This was verified: a valid token plus `X-Locci-Tenant: evil-tenant` was metered under the token's user id, and the same header without a token got 401 at the edge.

Remaining gap: if a valid token lacks `properties.id`, nothing overwrites the header and a client-supplied value would pass through. Every locci-auth user token carries `properties.id` today. Keep it that way, or have KrakenD strip the header first.

- [ ] Strip `X-Locci-Tenant` at KrakenD before claim propagation, so a token without `properties.id` cannot pass a client-supplied tenant through.

## Not production-ready yet

- [ ] OCR on CPU takes minutes per page: the vision pool wants a GPU before real traffic.
- [ ] KrakenD fetches the JWKS over plain HTTP (`disable_jwk_security`) and has no TLS. Production should use `https://auth.locci.cloud` as both `issuer` and JWKS origin, with `disable_jwk_security: false` and TLS.
- [ ] `LogSink` only logs. Implement `MeterSink` (Postgres, Redis, NATS) and the quota check at the marked hook in `proxyHandler`.

## Resumable chat streams

Refreshing the web chat mid-reply loses the reply and the question just sent: the browser saves to IndexedDB only when a reply finishes, and the API's stream lives only as long as its HTTP response. The AI SDK has the client half (`chat.resumeStream()` calls `GET /api/chat/<id>/stream`, 204 when there is nothing to resume); the API records the UI message stream as it is sent and replays it. One interface (`examples/api/src/resumable/`), two stores, picked by `RESUMABLE_STREAMS=memory|ursula|off`. The memory store, request ids and idempotency are done (see CHANGELOG.md and the examples README). `off` keeps today's behaviour exactly, and requests without a `threadId` (CLI, temporary chats) are never recorded.

- [ ] **B: Ursula store.** Chunks appended to Ursula, the append-only stream store Locci Cloud uses for build logs. Survives an API restart (what was written is replayed) and works with several API instances, where a resume can land on another instance. Ursula runs under a `ursula` compose profile with no published port, reached only through this repo's KrakenD with the same token check as the chat endpoints. Chat content is more sensitive than build logs: never publish 4437, and scope each stream to the caller's tenant at KrakenD (or in the API if KrakenD cannot template the claim into the path).

Caveats:

- [ ] Memory store: lost on API restart, and only works with one API instance.
- [ ] Stop only reaches the instance doing the generation (abort handles are local). With several instances behind Ursula, a stop marker in the stream would fix it.
- [ ] Ursula streams are replaced per thread but never expire; add a retention sweep before real traffic.
- [ ] The search planning step before the first chunk is not replayed (there is nothing to show yet).
