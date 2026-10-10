---
name: superting-api
description: Connect an agent to SuperTing directly — the local MCP server (for Claude Desktop / Cursor / Codex style MCP clients) or the loopback HTTP bridge (fallback when no `superting` CLI command covers the need). Prefer the superting-cli skill for shell workflows.
cli_version: ">=2.0.12"
---

# SuperTing 本地机器接口（MCP + HTTP bridge）

桌面应用在**本机**暴露两套接口，二者由同一份操作注册表生成，能力集合一致
（当前 87 项：笔记、会议纪要动作、录音、音频文件、转录与段级编辑、联系人/声纹、
说话人、词典、聊天、设置等）：

- **MCP**（推荐给 MCP 客户端）：回环 streamable-HTTP，进程内服务，工具名与 CLI 能力一一对应。
- **HTTP bridge**（兜底）：`superting` CLI 的传输层；CLI 没覆盖的细节用裸路由。

## MCP

1. 应用内 **设置 → 集成 → 本地 MCP 访问** → 启用。生成 URL + Bearer token，
   元数据在 `~/.superting/mcp-server.json`（`enabled` / `url` / `port` / `token`，可一键轮换）。
   端口默认 8220，区间 8220–8239，被占用时顺延；仅监听 127.0.0.1。
2. 客户端配置（`mcpServers` 形式）：

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

3. 先调 `list_operations` 拿全量目录（id、策略、参数、MCP 工具名、CLI 路由），
   再调具体工具。只读工具带 `readOnlyHint`，删除类带 `destructiveHint`，客户端据此确认。
4. 需要界面的工具（`run_note_action`、`start_recording`/`stop_recording`、
   `set_setting`、`export_notes`、`retry_transcription`）会经主↔渲染桥执行：没有窗口时
   应用会先打开面板；仍不可用则返回 `success:false` 且 message 含 `window`，不要当成功处理。
5. 长任务（`rediarize_note_audio`、`merge_note_audio`、`compress_all_audio`、
   `transcribe_audio_file`）传 `wait:false` 立刻拿 `job_id`，再用 `get_job` / `list_jobs` /
   `cancel_job` 跟踪；取消是协作式的（底层不可中止，完成后丢弃结果）。

## HTTP bridge

元数据（端口 + token）在 `~/.superting/cli-bridge.json`：

```sh
bridge="${HOME}/.superting/cli-bridge.json"
port="$(jq -r .port "$bridge")"
token="$(jq -r .token "$bridge")"
base_url="http://127.0.0.1:${port}"
```

每个请求带 `Authorization: Bearer ${token}`。仅绑定 127.0.0.1，无托管服务、无需账号。
`GET /v1/operations` 返回与 MCP 相同的能力目录（含每个能力的 path/query/body 参数位置）。

| 域          | 路由                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------- |
| 健康/目录   | `GET /v1/health`、`GET /v1/operations`                                                             |
| 笔记        | `GET /v1/notes/list·search`、`GET/POST/PATCH/DELETE /v1/notes[...]`、`DELETE /v1/notes/<id>/purge` |
| 转写段落    | `GET/PATCH/DELETE /v1/notes/<id>/transcript/segments`                                              |
| 笔记动作    | `GET /v1/actions[...]`、`POST /v1/actions/<id>/run`（= 生成会议纪要）                              |
| 长任务      | `GET /v1/jobs`、`GET /v1/jobs/<id>`、`POST /v1/jobs/<id>/cancel`                                   |
| 文件夹/标签 | `GET /v1/folders/list`、`POST /v1/folders/create`、`GET /v1/tags`                                  |
| 转写        | `GET /v1/transcriptions/list`、`POST /v1/transcriptions/transcribe`、`DELETE /v1/transcriptions`   |
| 音频        | `GET /v1/audio/usage`、`POST /v1/notes/<id>/audio/{compress,merge,rediarize}`                      |
| 人名声纹    | `GET/POST/PATCH/DELETE /v1/people[...]`、`GET/DELETE /v1/voiceprints[...]`                         |
| 词典        | `GET/PUT /v1/dictionary`、`POST/DELETE /v1/dictionary/words`、`/v1/dictionary/aliases[...]`        |
| 设置/录音   | `GET/PUT /v1/settings`、`GET /v1/recording`、`POST /v1/recording/{start,stop}`                     |

方法语义、请求体格式与实时刷新行为 → [references/routes.md](references/routes.md)（按需读取）。
全量能力目录（由注册表生成，勿手改）→ [references/operations.md](references/operations.md)。

## 红线

- 只连 127.0.0.1；token 用完即弃，不写入日志或文件、不贴进聊天记录。
- 凭据类设置（`*ApiKey` / `*Token` / `*Secret`）读出来是 `<redacted>`，写会被拒绝——让用户在应用内改。
- 不加遥测、远程同步或账号体系。
- 连不上时向用户说明"应用未运行"，不要重试循环；`renderer_unavailable` 说明需要打开应用窗口。
