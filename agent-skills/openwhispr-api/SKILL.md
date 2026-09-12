---
name: superting-api
description: Use SuperTing's local loopback API exposed by a running desktop app (fallback when no CLI command covers the need).
---

# SuperTing Local API

SuperTing exposes a local-only HTTP bridge for automation. It is the transport
behind the `superting` CLI (see the `superting-cli` skill) — prefer the CLI for
agent workflows. Reach for these raw routes only when no CLI command covers
the operation.

## Connection

The desktop app writes bridge metadata to:

```sh
~/.superting/cli-bridge.json
```

Read the current port and bearer token from that file:

```sh
bridge="${HOME}/.superting/cli-bridge.json"
port="$(jq -r .port "$bridge")"
token="$(jq -r .token "$bridge")"
base_url="http://127.0.0.1:${port}"
```

All requests must include:

```sh
Authorization: Bearer $token
```

The bridge only binds to `127.0.0.1` and is not a hosted service. It does not
require an SuperTing account.

## Routes

Notes:

- `GET /v1/notes/list?limit=100&folder_id=<id>&note_type=<type>`
- `GET /v1/notes/search?q=<query>&limit=20`
- `GET /v1/notes/<id>`
- `POST /v1/notes/create` (body: `title`, `content`, `note_type`, `folder_id`, `tags`)
- `PATCH /v1/notes/<id>` (body: any of `title`, `content`, `enhanced_content`, `transcript`, `folder_id`, `tags`)
- `DELETE /v1/notes/<id>`

Folders / tags:

- `GET /v1/folders/list`
- `POST /v1/folders/create` (body: `name`)
- `GET /v1/tags`

Transcriptions:

- `GET /v1/transcriptions/list?limit=50`
- `GET /v1/transcriptions/<id>`
- `DELETE /v1/transcriptions/<id>`
- `DELETE /v1/transcriptions/<id>/audio`

Dictionary (hotwords passed to the ASR as hints):

- `GET /v1/dictionary` → `{data: ["word", ...]}`
- `PUT /v1/dictionary` (body: `{"words": [...]}`) — full replace
- `POST /v1/dictionary/words` (body: `{"words": [...]}`) — add, case-insensitive dedupe → `{data: {added, dictionary}}`
- `DELETE /v1/dictionary/words?word=<w>[&word=<w2>]` — remove

Replacement rules (hotword replacement, applied to transcription text after ASR):

- `GET /v1/dictionary/aliases` → `{data: [{from, to}, ...]}`
- `PUT /v1/dictionary/aliases` (body: `{"aliases": [{"from","to"}, ...]}`) — full replace
- `POST /v1/dictionary/aliases` (body: `{"from","to"}`) — add or overwrite by `from`
- `DELETE /v1/dictionary/aliases?from=<text>[&from=<text2>]` — remove

All dictionary/alias mutations broadcast `dictionary-updated` /
`dictionary-aliases-updated` to the app windows, so the Settings UI refreshes
live. Note mutations broadcast `note-added`/`note-updated` and feed the
semantic vector index.

## Examples

Health check:

```sh
curl -sS \
  -H "Authorization: Bearer ${token}" \
  "${base_url}/v1/health"
```

Add a hotword:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d '{"words":["超级听记"]}' \
  "${base_url}/v1/dictionary/words"
```

Add a replacement rule:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d '{"from":"super ting","to":"SuperTing"}' \
  "${base_url}/v1/dictionary/aliases"
```

## Local Trust Boundary

- Read the bridge file at runtime; connect only to `127.0.0.1`.
- Pass the bearer token in memory; never log it.
- Do not add telemetry, remote synchronization, or hosted accounts.
- Surface `bridge_not_running` errors clearly so the user can start the app.
