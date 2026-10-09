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

Refreshing the web chat mid-reply loses the reply and the question just sent: the browser saves to IndexedDB only when a reply finishes, and the API's stream lives only as long as its HTTP response. The AI SDK has the client half (`chat.resumeStream()` calls `GET /api/chat/<id>/stream`, 204 when there is nothing to resume); the API records the UI message stream as it is sent and replays it. One interface (`examples/api/src/resumable/`), two stores, picked by `RESUMABLE_STREAMS=memory|ursula|off`. `off` keeps today's behaviour exactly, and requests without a `threadId` (CLI, temporary chats) are never recorded. Both stores, request ids and idempotency are done (see CHANGELOG.md and the examples README). What is left:

- [ ] Memory store: lost on API restart, and only works with one API instance.
- [ ] Stop only reaches the instance doing the generation (abort handles are local). With several instances behind Ursula, a stop marker in the stream would fix it.
- [ ] Ursula streams never expire, and the Ursula gateway has no DELETE, so every turn's reply stays. Add retention (Ursula-side or a gateway route) before real traffic.
- [ ] Tenant scoping lives in this repo's KrakenD only. The production Ursula gateway (events.locci.cloud, from docker-compose-templates/ursula) forwards `/{bucket}/{stream}` as-is, so any valid Locci token used directly there can read `chats/<sub>--<thread>` given both ids (thread ids are random UUIDs). Fix in the template next: `/chats/{stream}` routes that rewrite to `/chats/{JWT.sub}--{stream}`, after checking that the static route wins over `/{bucket}` and that KrakenD 2.7 substitutes `{JWT.sub}`; this repo's routes then drop their own prefix.
- [x] End-user sign-in behind `AUTH=locci|off`: the web app signs in through locci-auth (PKCE, one button, locci-auth's own sign-in page), the API verifies the bearer token, keeps threads and recordings per user, and sends the user's token to Ursula. See the examples README.
- [ ] `AUTH=locci` leaves `/chat` (the CLI protocol) open; it stores nothing, but it spends the API's model quota. Accept a bearer there and have the CLI send `LOCCI_ACCESS_TOKEN` or an exchanged `LOCCI_API_KEY`.
- [ ] Sign-in not yet clicked through in a browser: the browser tools were down. Verified so far: the build, the issuer accepting this client and redirect (and refusing a foreign redirect), and every API side with a key token.
- [ ] The search planning step before the first chunk is not replayed (there is nothing to show yet).
- [ ] KrakenD CE (2.13) held a streamed GET from Ursula until about 4 KB had built up, so the Ursula store reads with long-polls. Anything else that needs live SSE through KrakenD should be measured first; the chat endpoint is fine because a reply crosses 4 KB quickly, but its first tokens arrive in batches.
