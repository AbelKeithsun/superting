---
name: superting-cli
description: Operate the local SuperTing desktop app (listening notes, hotwords, replacement rules) through the `superting` CLI client.
---

# SuperTing Agent CLI

Use the `superting` CLI when a task should read or edit the user's local
SuperTing data: listening notes (听记笔记), dictation transcriptions, folders,
tags, dictionary hotwords (词典/热词), and hotword replacement rules (热词替换).
The CLI is the preferred agent channel — it is a local client for the desktop
app's loopback bridge (single fast HTTP round-trip per command, no MCP session
handshake), and writes flow through the app so the UI refreshes and vector
indexing still run.

## 严格禁止 (NEVER DO)

- Do not use MCP, curl, or the raw HTTP bridge when a CLI command exists.
- Never guess note/folder/transcription ids — always extract ids from command
  output (`notes list`, `notes search`, `folders list`, …).
- Never run destructive commands (`delete`, `dict replace`, `alias replace`,
  `dict remove`, `alias remove`) without user confirmation; only add `--yes`
  after the user agrees.
- Do not pass credentials anywhere: the bridge is loopback-only with a token
  from the local bridge file; there is no hosted service.

## 严格要求 (MUST DO)

- Start every session with `superting health` when in doubt about whether the
  app is running.
- All output is JSON by default; parse it, don't eyeball it.
- Prefer `notes list` / `notes search` (with content previews) before
  `notes get` to keep output small; use `--full` only when previews are cut.
- For note editing, `notes update --find ... --replace ...` performs literal
  all-occurrence replacement — check the printed resulting note afterwards.

## Preconditions

1. SuperTing desktop app is running (it writes the bridge file on launch).
2. `superting` is on PATH (`npm run install:cli` in the repo installs a
   symlink to `~/.local/bin`).

If the bridge file is missing the CLI errors with `bridge_not_running` —
tell the user to start the SuperTing app; do not retry in a loop.

## Command Reference

Run `superting --help` for the authoritative list. Summary:

| Area | Commands |
| --- | --- |
| Health | `health` |
| Notes | `notes list [--limit --type --folder-id --full]`, `notes get <id>`, `notes search <query>`, `notes create --title … [--content --type --folder-id --tags]`, `notes update <id> [--title --content --transcript --folder-id --tags --find --replace]`, `notes append <id> --text`, `notes delete <id> --yes` |
| Folders | `folders list`, `folders create --name` |
| Transcriptions | `transcriptions list [--limit]`, `transcriptions get <id>` |
| Tags | `tags list` |
| Dictionary (hotwords) | `dict list`, `dict add <word…>`, `dict remove <word…> --yes`, `dict replace --words a,b --yes` |
| Replacement rules | `alias list`, `alias add <from> <to>`, `alias remove <from…> --yes`, `alias replace --json '[{"from":"a","to":"b"}]' --yes` |

Semantics worth knowing:

- **Dictionary words** are passed to the ASR engine as hint context, improving
  recognition of names/jargon. Adds dedupe case-insensitively.
- **Replacement rules** (`alias`) rewrite transcription text after ASR
  (`from` → `to`). Adding a rule whose `from` already exists overwrites it.
- `notes update --find/--replace` only touches `content`; use `--transcript`
  to replace the raw transcript field.

## Example Session

```sh
superting health
superting notes search "funasr" --limit 5
superting notes update 3 --find "Fun ASR" --replace "FunASR"
superting dict add 超级听记 sherpa-onnx SenseVoice
superting alias add "super ting" "SuperTing"
superting alias list
```

## Error Handling

- Exit code 0 = success, 2 = usage error (bad flags/args), 1 = bridge or app
  error. Errors print `{"error":{"code","message"}}` to stderr.
- `bridge_not_running`: app not running or bridge file moved.
- `not_found` (HTTP 404): id doesn't exist — re-list, don't guess.
- `validation_error` (HTTP 400): malformed payload.

## Design Rules

- Keep all data local; never introduce hosted sync, telemetry, or logins.
- When no CLI command covers the need, the raw bridge routes in the
  `superting-api` skill are the fallback (same loopback bridge).
