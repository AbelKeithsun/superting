<p align="center">
  <img src="src/assets/logo.svg" alt="SuperTing" width="120" />
</p>

<h1 align="center">SuperTing</h1>

<p align="center">
  <a href="https://github.com/sysusugan/superting/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sysusugan/superting?style=flat" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat" alt="Platform" />
  <a href="https://github.com/sysusugan/superting/releases/latest"><img src="https://img.shields.io/github/v/release/sysusugan/superting?style=flat&sort=semver" alt="GitHub release" /></a>
  <a href="https://github.com/sysusugan/superting/releases"><img src="https://img.shields.io/github/downloads/sysusugan/superting/total?style=flat&color=blue" alt="Downloads" /></a>
  <a href="https://github.com/sysusugan/superting/stargazers"><img src="https://img.shields.io/github/stars/sysusugan/superting?style=flat" alt="GitHub stars" /></a>
</p>

<p align="center">
  The open-source and free alternative to WisprFlow and Granola.<br/>
  Privacy-first voice-to-text dictation with AI agents, meeting transcription, and notes. Cross-platform for macOS, Windows, and Linux.
</p>

<p align="center">
  <a href="https://github.com/sysusugan/superting#readme">Docs</a> &middot;
  <a href="https://github.com/sysusugan/superting/releases/latest">Download</a> &middot;
  <a href="https://github.com/sysusugan/superting/blob/main/CHANGELOG.md">Changelog</a>
</p>

---

SuperTing turns your voice into text, notes, and actions from your desktop. Press a hotkey, speak, and your words appear at your cursor. Choose fully private offline transcription with local speech-to-text engines like Whisper, NVIDIA Parakeet, and FunASR SenseVoice (best-in-class Chinese, see [FUNASR_SETUP.md](FUNASR_SETUP.md)), or bring your own provider API key. No data collection, no telemetry, fully open source.

## Download

| Platform              | Download                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | [`.dmg`](https://github.com/sysusugan/superting/releases/latest)                                                                                                                                            |
| macOS (Intel)         | [`.dmg`](https://github.com/sysusugan/superting/releases/latest)                                                                                                                                            |
| Windows               | [`.exe`](https://github.com/sysusugan/superting/releases/latest)                                                                                                                                            |
| Linux                 | [`.AppImage`](https://github.com/sysusugan/superting/releases/latest) / [`.deb`](https://github.com/sysusugan/superting/releases/latest) / [`.rpm`](https://github.com/sysusugan/superting/releases/latest) |

## Features

- **Voice dictation** — global hotkey to dictate into any app with automatic pasting
- **AI agent** — talk to GPT-5, Claude, Gemini, Groq, or local models with a named voice assistant
- **Meeting transcription** — auto-detect Zoom, Teams, and FaceTime calls with live speaker diarization and voice fingerprinting
- **Local speaker diarization** — on-device speaker labelling with voice fingerprint recognition across meetings, no cloud required
- **Notes** — create, organize, and search notes with folders, local semantic search, and AI actions
- **Local or BYOK — your choice** — core features work with local models or user-configured providers

## Quick start

```bash
git clone https://github.com/sysusugan/superting.git
cd superting
npm install
npm run dev
```

Requires Node.js 24+. See this repository for setup guides, platform-specific instructions, and build details.

## Agent access (MCP / CLI / Skills)

The app exposes one capability surface, generated from a single main-process
registry (`src/helpers/appOperations/`) and projected onto both machine
interfaces — currently **87 capabilities**: notes, note actions (meeting
minutes), recording control, audio files, transcription and transcript-segment
editing, people/voiceprints, speaker labelling, dictionary, chat history,
settings and more.

### MCP

1. In the app: **Settings → Integrations → Local MCP access** → enable. You get a
   loopback URL and a bearer token (metadata in `~/.superting/mcp-server.json`,
   token can be rotated; the server only binds 127.0.0.1).
2. Paste this into your MCP client (`mcpServers`):

   ```json
   {
     "mcpServers": {
       "superting": {
         "type": "http",
         "url": "http://127.0.0.1:8220/mcp",
         "headers": { "Authorization": "Bearer <token>" }
       }
     }
   }
   ```

3. Tool names mirror the CLI capabilities (`list_notes`, `search_notes`,
   `run_note_action`, `list_jobs`, `update_transcript_segment`, `get_settings`, …).
   Call `list_operations` first for the full catalog with parameters.
4. Capabilities that need the UI (running an action, recording, export dialog,
   writing settings) wake the app window; if it is still unavailable the call
   fails with `renderer_unavailable` instead of returning stale data.

### CLI

```bash
npm run install:cli            # symlink into ~/.local/bin (SUPERTING_CLI_BIN_DIR, --copy)
superting health               # the app must be running (the app serves the bridge)
superting ops list             # all 87 capabilities: id / policy / route / MCP name / params
superting call <operation.id> --json '{"…"}'   # generic escape hatch for any capability
superting notes list --limit 5
superting transcript segments --id 47 --limit 20
superting actions list && superting actions run 1 --note-id 47
superting jobs list            # long tasks; wait:false returns a job id to poll
superting settings get --key uiLanguage
```

Exit codes: 0 ok, 1 bridge/app error, 2 usage. JSON by default (`--format text`
for humans). Destructive commands require `--yes`.

### Skills

`agent-skills/` ships `superting-cli` (drive the CLI) and `superting-api`
(HTTP/MCP fallback). The installer is released with the CLI and installs
**globally or into a project directory**:

```bash
npm run install:skills                              # current project: ./.claude/skills
npm run install:skills -- --global                  # ~/.agents/skills
npm run install:skills -- --project /path/to/repo   # <dir>/.claude/skills
npm run install:skills -- --target /some/dir        # verbatim directory
npm run install:skills -- --only cli                # one skill
npm run install:skills -- --list | --check | --remove | --force

# single remote command (version pinned by the release asset)
npx -p https://github.com/AbelKeithsun/superting/releases/download/v<ver>/superting-skills-<ver>.tgz superting-skills --global
```

Full capability reference (MCP tool names, CLI routes, parameters):
`agent-skills/superting-api/references/operations.md`.

## Documentation

Start with this README and the files in [`docs/`](docs/) for local development, platform notes, and troubleshooting.

## Tech stack

React 19, TypeScript, Tailwind CSS v4, Electron 41, better-sqlite3, whisper.cpp, sherpa-onnx (Parakeet + FunASR SenseVoice), shadcn/ui

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=sysusugan/superting&type=date&legend=top-left)](https://www.star-history.com/#sysusugan/superting&type=date&legend=top-left)

## Contributing

We welcome contributions. Fork the repo, create a feature branch, and open a pull request.

## License

[MIT](LICENSE) — free for personal and commercial use.

## Acknowledgments

- **[OpenWhispr](https://github.com/OpenWhispr/openwhispr)** — upstream MIT project this independent fork is based on
- **[OpenAI Whisper](https://github.com/openai/whisper)** — speech recognition model powering local and cloud transcription
- **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** — high-performance C++ implementation for local processing
- **[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** — fast multilingual ASR model
- **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** — cross-platform ONNX runtime for Parakeet / FunASR inference
- **[FunASR SenseVoice](https://github.com/modelscope/FunASR)** — high-accuracy Chinese/multilingual ASR with punctuation and ITN
- **[Hugging Face](https://huggingface.co/)** — model hub hosting Whisper, Parakeet, and embedding model weights
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** — local LLM inference for AI text processing
- **[Electron](https://www.electronjs.org/)** — cross-platform desktop framework
- **[React](https://react.dev/)** — UI component library
- **[shadcn/ui](https://ui.shadcn.com/)** — accessible components built on Radix primitives
