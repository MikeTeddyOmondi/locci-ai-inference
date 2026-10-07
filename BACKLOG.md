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
