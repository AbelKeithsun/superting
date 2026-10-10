---
name: superting-cli
description: Operate the local SuperTing desktop app (listening notes 听记笔记, meeting transcripts and segments, note actions such as 生成会议纪要, hotwords 词典热词, replacement rules, people/voiceprints, audio files, jobs, settings, recording) through the `superting` CLI client. Use whenever a task should read or edit the user's local SuperTing data — faster than MCP, writes refresh the app UI live.
cli_version: ">=2.0.12"
---

# SuperTing Agent CLI

`superting` 是本机桌面应用的本地客户端：每条命令一次回环 HTTP 调用（无 MCP 握手），
写入经应用广播，界面实时刷新。所有数据留在本机，无任何托管服务。

## 严格禁止 (NEVER)

- 有专用命令时禁止用 MCP / curl / 裸 HTTP；没有专用命令时用 `superting call <operation.id>`，不要手写 HTTP。
- 禁止猜测任何 id —— id 只能从命令输出提取（`notes list` / `notes search` / `actions list` / `people list`）。
- 破坏性命令（`delete` / `purge` / `audio delete-all` / `transcriptions clear` / `dict|alias remove|replace` / `people delete|merge`）必须先向用户确认，同意后才加 `--yes`。

## 严格要求 (MUST)

- 不确定应用是否在运行时，先 `superting health`；报 `bridge_not_running` 就让用户启动应用，不要循环重试。
- 先 `superting ops list` 确认能力与参数（87 项：id、策略、CLI 路由、MCP 工具名、参数位置），不确定的参数不要猜。
- 输出默认 JSON：解析它。列表默认截断预览，需要全文用 `notes get <id> --full`。
- 长任务（重新分离、合并音频、批量压缩、音频转写）加 `--wait false` 会立刻返回 `job_id`，再 `jobs get <job_id>` 轮询；不要同步干等几分钟。
- 需要界面的能力（`actions run`、`recording *`、`settings set`、导出到磁盘、`transcriptions retry`）要求应用窗口存在；返回 `renderer_unavailable` 时提示用户打开应用窗口，不要重试循环。

## 命令速查

| 领域     | 命令                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发现     | `ops list`、`call <operation.id> --json '{…}'`（通用兜底）、`health`                                                                                                 |
| 笔记     | `notes list / get <id> [--full] / search <q> / create / update <id> [--find --replace] / append <id> / delete <id> / purge <id>`                                     |
| 转写段落 | `transcript segments --id <n> [--offset --limit]`、`transcript segment-update --id <n> --index N --text …`、`transcript segment-delete --id <n> --index <i>`         |
| 笔记动作 | `actions list / get <id> / create / update / delete`、`actions run <id> --note-id <n>`（即「生成会议纪要」）                                                         |
| 长任务   | `jobs list`、`jobs get <job_id>`、`jobs cancel <job_id>`；各长命令加 `--wait false`                                                                                  |
| 音频     | `notes audio list --id <n>`、`notes audio compress / merge / rediarize`、`audio usage / retention / compress-all / delete-all`                                       |
| 转录     | `transcriptions list / get <id> / transcribe --file-path <f>`、`transcriptions retry <id>`、`transcriptions delete <id> / delete-audio <id>`、`transcriptions clear` |
| 录音     | `recording status`、`recording start --note-id <n>`、`recording stop`                                                                                                |
| 联系人   | `people list / get <id> / create / update / delete / merge`、`contacts search <q> / upsert`                                                                          |
| 说话人   | `speakers profiles / names / mappings --id <n>`、`speakers assign`、`speakers name-add / name-delete / email-attach`                                                 |
| 声纹     | `voiceprints segments [--person-id <n>]`、`voiceprints delete-all [--person-id <n>]`                                                                                 |
| 聊天记录 | `chats list / messages <id> / for-note --id <n> / create / archive / delete`                                                                                         |
| 设置     | `settings get [--key <k>]`、`settings set --key <k> --value <v>`（凭据类键被拒绝，需在应用内改）                                                                     |
| 文件夹   | `folders list / create / rename / delete / reorder`                                                                                                                  |
| 标签     | `tags list`                                                                                                                                                          |
| 词典     | `dict list / add / remove / replace`、`dict groups list / create / rename / move / delete`                                                                           |
| 替换规则 | `alias list / add <from> <to> / remove <from…> / replace --json '[{"from","to"}]'`                                                                                   |
| 导入导出 | `notes import <id> --file-path <f>`、`notes export-to-disk --note-ids 1 --format md`、`notes export <id> --format md`                                                |

破坏性命令需 `--yes`；退出码 0=成功、1=桥接/应用错误、2=用法错误；`--format text` 输出人类可读。

## 常用四例

```sh
superting notes search "funasr" --limit 5                     # 先找 id
superting transcript segments --id 47 --limit 10              # 看段落（用返回的 stored-N 或 index）
superting transcript segment-update --id 47 --index 0 --text "修正后的文本"
superting actions run 1 --note-id 47                          # 跑「生成会议纪要」
superting jobs list                                           # 长任务进度
```

参数名接受 snake_case 与 kebab-case 两种写法（`--note_id` = `--note-id`）；布尔/数字/逗号列表由 CLI 自动转换。

## 按需加载的详细参考（references/）

只在需要时读取，不要预读：

- 笔记增删改查、find/replace 语义、tags、文件夹、转写段落 → [references/notes.md](references/notes.md)
- 热词/替换规则的完整语义（去重、覆盖、全量替换、实时同步） → [references/dictionary.md](references/dictionary.md)
- 报错处理、bridge 诊断、jobs 与 renderer_unavailable、版本核对 → [references/troubleshooting.md](references/troubleshooting.md)

全量能力目录：`superting ops list`；静态版本见 `agent-skills/superting-api/references/operations.md`（由注册表生成）。
