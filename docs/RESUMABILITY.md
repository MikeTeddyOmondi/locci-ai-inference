# Resumable replies and Ursula

How the example web chat keeps a reply alive when the browser goes away, how a
repeated request is answered without a second model call, and what Ursula (the
append-only stream store Locci Cloud already runs for build logs) adds on top
of the in-process store. Everything here is in `examples/api/src/resumable/`,
`examples/api/src/server.ts` (`/api/chat` and `/api/chat/:threadId/stream`) and
`examples/web/src/lib/components/Chat.svelte`.

Related: [API_USAGE.md](API_USAGE.md), [LLAMA_SERVER.md](LLAMA_SERVER.md), the
examples README (`examples/README.md`, sections "Resumable replies", "Ursula
store" and "Sign-in"), and `BACKLOG.md` ("Resumable chat streams").

## The problem

Inference on these nodes is slow. A first token after a long prompt can take
70 to 90 seconds on the CPU nodes, and a full reply with a web search and tool
calls takes longer. Without recording, that work is tied to one HTTP response:

- **A reload, a closed tab or a dropped connection lost the reply.** The browser
  saved a thread only when the reply finished, so the question disappeared too,
  and the API stopped generating when the response closed.
- **A retried send ran the model again.** A double submit or a client retry
  after a timeout meant a second, metered generation for the same question.
- **One API process held the only copy.** Nothing outside it knew a reply
  existed, so another instance could not serve it and a restart erased it.

## What changed, whatever the store

These hold with `RESUMABLE_STREAMS=memory` (the default) and `ursula`:

1. **Generation is detached from the browser.** `/api/chat` passes
   `consumeSseStream` to `pipeUIMessageStreamToResponse`, which tees the SSE text.
   When the browser disconnects only the response branch is cancelled; the
   recording branch keeps reading, so the model runs to the end.
2. **Every reply is recorded as it is sent**, byte for byte the SSE text the
   browser receives, under its thread id.
3. **The browser resumes.** The web app saves the question when it is sent and
   the thread only when a reply ends, so "the last saved message is the user's"
   means "a reply was in flight". On load it then calls the AI SDK's
   `chat.resumeStream()`, which asks `GET /api/chat/:threadId/stream`: the
   recording from its start, then live until it ends (`204` when there is none).
4. **Sends are idempotent.** Each send carries three ids: `threadId` (the chat),
   `messageId` (the user message being answered, from the SDK) and a fresh
   `requestId` (`crypto.randomUUID()` per send, or an `Idempotency-Key` header).
   The recording starts with `{requestId, messageId}`:
   - the same `requestId` again is answered from the recording, identical bytes,
     no model call;
   - the same `requestId` with a different `messageId` is `409`;
   - a new `requestId` starts a new turn.
   The assistant message id is fixed per request (`generateMessageId`), so a
   replay rebuilds the same message instead of a duplicate.
5. **Stop is explicit.** Closing the request no longer stops the model, so the
   web Stop button also calls `DELETE /api/chat/:threadId/stream`, which aborts
   the reply (an `abort` chunk ends the recording).
6. **Recording never breaks chat.** If the store cannot start a recording the
   reply goes out unrecorded and the log says so; a failing append stops the
   recording, not the reply.

Requests without a `threadId` (the CLI, temporary chats) are not recorded and
behave exactly as before. `RESUMABLE_STREAMS=off` turns all of it off.

## What Ursula adds

The memory store keeps recordings in the API process for 10 minutes after a
reply ends. That covers a reload, but the recording is gone if the process
restarts, and only the instance that generated a reply can replay it. With
`RESUMABLE_STREAMS=ursula` the recording lives in Ursula instead, which writes
to a disk WAL (`backend = "disk"`):

| Failure | memory | ursula |
| --- | --- | --- |
| Browser reload or disconnect mid-reply | replayed, then live | replayed, then live |
| Retried or double-submitted send | answered from the recording, no model call | same, and also after an API restart or on another instance |
| Reply generated on instance A, browser reconnects through instance B | `204` (B has no recording) | replayed live from Ursula |
| API process restarts after a reply finished | lost | replayed in full |
| API process dies mid-reply | lost | the part written so far replays; the replay ends after 2 minutes without new data |
| Ursula restarts | not involved | recordings survive (verified) |
| Ursula unreachable | not involved | chat still answers, unrecorded; resume returns `204` |

What Ursula does **not** do: it does not re-run inference. If the API or the
inference node dies mid-reply, the model work after that point is lost, and the
user sends again (a new `requestId`). Ursula guarantees that what was produced
is not lost and is never paid for twice, not that a generation always completes.
A node crashing mid-reply (the qwen3 node restarting under load, seen in
testing) ends the recorded reply with an error part, which a resume replays as
the same error.

## How it is integrated

```text
web (Chat.svelte)
  POST /api/chat {threadId, requestId, messages}     GET /api/chat/:threadId/stream
        |                                                        |
        v                                                        v
example API (server.ts)  -- tee -->  ResumableStreams.start / resume  (src/resumable/)
                                                  |
                              memory.ts (in process)  or  ursula.ts
                                                              |
                                  KrakenD /v1/streams  (token checked, stream named <sub>--<name>)
                                                              |
                                  Ursula :4437 (bucket `chats`, disk WAL, no published port)
```

### One interface, three settings

`src/resumable/index.ts` defines `ResumableStreams` with two calls:
`start({owner, threadId, requestId, messageId})`, which returns a new recorder, a
replay of an earlier identical request, or a conflict, and
`resume(owner, threadId)`, which returns the latest reply as a stream or null.
`RESUMABLE_STREAMS=memory|ursula|off` picks the implementation at start; the
server code is the same for both stores.

### Stream layout in Ursula

Production's Ursula gateway has no DELETE route, so the store only ever appends
and never replaces a stream. Per thread, in the `chats` bucket:

```text
<threadId>              index: one line per turn, {"requestId":"...","messageId":"..."}
<threadId>.<requestId>  that turn's reply: the SSE text, then `: locci-end`
```

- **Start:** read the index; a line with this `requestId` means replay (or `409`
  if its `messageId` differs). Otherwise create the reply stream, then append the
  index line, so a resume that finds the turn always finds its stream.
- **Record:** appends are batched (every 50 ms or 16 KB) into
  `POST` requests with `content-type: application/octet-stream`; `finish` appends
  the end marker `: locci-end` (an SSE comment, so it is harmless if ever sent).
- **Resume:** the last index line names the reply stream. One catch-up
  `GET ?offset=-1`, then long-polls (`?offset=<Stream-Next-Offset>&live=long-poll`,
  each returning within about a second) until the end marker, which is stripped,
  as is any partial marker split across two reads.
- **Dead writer:** if nothing new arrives for 120 seconds (longer than the slowest
  first token) the replay ends, because an API that died mid-reply never writes
  the end marker.

Thread ids (`[A-Za-z0-9_-]`) and request ids cannot contain a dot, so the two
kinds of stream names cannot collide.

### Why long-polls and not Ursula's live SSE

Ursula can push a stream as SSE (`live=sse`), and the console's build logs use
it. Through KrakenD CE (2.13 here) a streamed `GET` with `no-op` encoding was
held until about 4 KB had built up, so a short reply arrived in one lump at the
end. Each long-poll is a complete response, so it passes through KrakenD
unchanged, `Stream-Next-Offset` header included.

### Behind KrakenD, scoped per tenant

Ursula has no authentication of its own, and chat content is more sensitive than
build logs, so its port is never published. The only way in is this repo's
KrakenD:

| Endpoint | Ursula path |
| --- | --- |
| `PUT /v1/streams` | `/chats` (create the bucket) |
| `PUT`, `POST`, `GET /v1/streams/{stream}` | `/chats/{JWT.sub}--{stream}` |

Every route validates the Locci token (`auth/validator`) and forwards
`Authorization`, `GET` passes only `offset` and `live`, and the backend path is
built from the token's `sub` claim, so a caller can only ever name its own
streams. (`{JWT.properties.id}` is not substituted in a `url_pattern`; it came
through as a literal, which would have put every tenant in one namespace, so the
top-level `sub` is used.)

Whose token that is depends on sign-in (`AUTH`):

- `AUTH=off`: the API's own token (`LOCCI_API_KEY` exchanged at locci-auth's
  `/keys/token`, cached, refreshed on `401`). Everyone using one deployment
  shares that tenant; thread ids are random UUIDs.
- `AUTH=locci`: the signed-in user's own bearer token is forwarded, so `sub` is
  that user (`user:<hash>`) and KrakenD, not the API, keeps users apart. The
  memory store and running replies are keyed by user id the same way.

### Locally and in production

- **Locally:** `just ursula-up` starts the `ursula` compose service (profile
  `ursula`, image `ghcr.io/tonbo-io/ursula:0.3.0`, config `ursula/single.toml`,
  volume `ursula-data`), and KrakenD's stream routes point at `ursula:4437`. Set
  `RESUMABLE_STREAMS=ursula` in `examples/api/.env`. `URSULA_URL` defaults to
  `http://localhost:8080/v1/streams` (KrakenD).
- **Production:** `events.locci.cloud` runs the same Ursula 0.3.0 behind its own
  KrakenD gateway, which checks tokens from `auth.locci.cloud`. This service
  needs no change there: point the stream routes' backend at
  `https://events.locci.cloud` (or the in-cluster `ursula` service), keep the
  `{JWT.sub}` prefix here, and the recordings land in their own `chats` bucket
  next to `builds`. Two caveats, both in `BACKLOG.md`: that gateway forwards
  `/{bucket}/{stream}` as-is, so the tenant prefix is enforced only by this
  repo's KrakenD until the template gains `/chats` routes; and production's
  Ursula has no S3 cold tier configured yet (disk WAL only).

## Verifying it

- `just examples-check` includes **web resume**: a reply dropped after its first
  chunk replays in full from `GET /api/chat/:threadId/stream`, the same
  `requestId` returns the identical reply, and another message with it gets
  `409`. It runs against whichever store the API has (skipped with `off`); with
  `AUTH=locci` it sends a Locci token.
- Verified by hand with the Ursula store: replay after a disconnect; an idempotent
  repeat for the latest and for an earlier turn; resume following the newest of
  two turns; a reply generated on one API instance resumed live from another;
  replay after restarting Ursula; with Ursula stopped, chat still answers and
  resume returns `204`; Stop ends the reply.
- In the browser: a reload mid-reply caught up on what was already written,
  followed the rest live, and the finished reply was saved.

## Not covered yet

From `BACKLOG.md`:

- No retention: every turn's reply stays in Ursula, and the gateway has no DELETE.
- Stop only reaches the instance generating the reply (abort handles are local).
- The search-planning step before the first chunk is not replayed (nothing has
  been sent yet).
- A generation cut short by a crash is not re-run; the user sends again.
