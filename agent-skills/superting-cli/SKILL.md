---
name: superting-cli
description: Operate the local SuperTing desktop app (listening notes 听记笔记, hotwords 词典热词, replacement rules 热词替换, transcriptions, folders, tags) through the `superting` CLI client. Use whenever a task should read or edit the user's local SuperTing data — faster than MCP, writes refresh the app UI live.
cli_version: ">=2.0.3"
---

# SuperTing Agent CLI

`superting` 是本机桌面应用的本地客户端：每条命令一次回环 HTTP 调用（无 MCP 握手），
写入经应用广播，设置/笔记界面实时刷新。所有数据留在本机，无任何托管服务。

## 严格禁止 (NEVER)

- 有 CLI 命令时禁止用 MCP / curl / 裸 HTTP。
- 禁止猜测任何 id —— id 只能从命令输出提取（`notes list` / `notes search` / `folders list`）。
- 破坏性命令（`delete`、`dict|alias remove|replace`）必须先向用户确认，同意后才加 `--yes`。

## 严格要求 (MUST)

- 不确定应用是否在运行时，先 `superting health`。
- 输出默认 JSON：解析它，不要目测。列表场景先用预览（默认截断 500 字），需要全文再 `notes get` / `--full`。
- 做过编辑后，检查命令返回的最终内容再向用户汇报。

## 前置条件

1. SuperTing 桌面应用正在运行（启动时自动写 bridge 文件）。
2. `superting` 在 PATH 上。报 `bridge_not_running` 时让用户启动应用，不要循环重试。

## 命令速查

| 领域             | 命令                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| 健康             | `superting health`                                                                      |
| 笔记             | `notes list / get <id> / search <q> / create / update <id> / append <id> / delete <id>` |
| 文件夹           | `folders list`、`folders create --name <n>`                                             |
| 转写             | `transcriptions list / get <id>`                                                        |
| 标签             | `tags list`                                                                             |
| 词典（热词）     | `dict list / add <词…> / remove <词…> / replace --words a,b`                            |
| 替换规则（纠错） | `alias list / add <from> <to> / remove <from…> / replace --json '[{"from","to"}]'`      |

破坏性命令需 `--yes`；退出码 0=成功、1=桥接/应用错误、2=用法错误。

## 常用三例

```sh
superting notes search "funasr" --limit 5          # 找到 id 再操作
superting notes update 3 --find "Fun ASR" --replace "FunASR"   # 字面量全量替换 content
superting alias add "super ting" "SuperTing"       # 转写纠错规则，UI 实时生效
```

## 按需加载的详细参考（references/）

只在需要时读取，不要预读：

- 笔记增删改查、find/replace 语义、tags、文件夹 → [references/notes.md](references/notes.md)
- 热词/替换规则的完整语义（去重、覆盖、全量替换、实时同步） → [references/dictionary.md](references/dictionary.md)
- 报错处理、bridge 诊断、版本核对 → [references/troubleshooting.md](references/troubleshooting.md)

CLI 无对应命令时，回退到 `superting-api` skill 的裸路由（同一个 bridge）。
