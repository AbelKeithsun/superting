# Agent surfaces (MCP + CLI) 架构说明

> 状态：2026-10 · 分支 `codex/agent-surface-parity`（堆叠在 `codex/note-action-entry-unify` 之上）

## 一句话

应用**只声明一次**能力，MCP 工具与 CLI 路由都由它投影出来；需要 UI 的能力通过
主↔渲染桥执行，绝不静默返回旧数据。

## 分层

```
             ┌────────────────────────── src/helpers/appOperations/ ──────────────────────────┐
             │ registry.js      校验 + 参数归一 + policy(read/write/destructive)              │
             │ coreOperations   notes / folders / tags / dictionary / transcriptions / system │
             │ actionOperations 笔记动作 CRUD + 运行（会议纪要）                              │
             │ domainOperations 音频文件 / 存储 / 人名声纹 / 说话人 / 聊天 / 设置 / 录音       │
             │ mcpAdapter.js    参数 → zod 形状，policy → readOnly/destructiveHint            │
             │ cliAdapter.js    参数 → path/query/body，生成 cliBridge 路由表                  │
             │ rendererBridge   主→渲染往返（无窗口 → 打开面板后重试 → 否则 UNAVAILABLE）      │
             └────────────────────────────────────────────────────────────────────────────────┘
                       │                                 │                        │
                 MCP 工具（79）                    CLI 路由（79）            渲染层处理器
            src/helpers/mcpServerManager.js   src/helpers/cliBridge.js   src/stores/appOperationHandlers.ts
                                                                        （executeNoteAction / settings /
                                                                          recording / retry / export）
```

## 三类能力

| 类型 | 例子 | 实现位置 |
| --- | --- | --- |
| 主进程直做 | notes 读写、词典、文件夹、人名声纹、音频文件、聊天记录、`/v1/operations` 目录 | operation handler 直接调 `db` / `ipc.invokeChannel(...)` |
| 需要渲染层 | 运行笔记动作、`settings.*`、`recording.*`、`transcriptions.retry`、导出到磁盘 | `rendererRequired: true`，经 `rendererBridge` 派发 |
| 明确禁止 | 退出应用、安装更新、系统权限弹窗 | 不注册为 capability；任何带 `apiKey/token/secret` 的设置在 `settings.set` 中被拒绝 |

`ipc.invokeChannel(channel, ...)` 调用的是**渲染进程点同一个按钮时走的 handler**
（`IPCHandlers.setupHandlers` 注册时记录，见 `channelHandlers`），因此不存在第二份实现。

## 无窗口时的行为

- `settings.get`：读取 `~/.superting/settings-mirror.json`（渲染层每次变更后推送的**已脱敏**快照），
  返回 `source: "settings-mirror"`；没有快照则明确报错。
- 其他 UI 能力：桥会先尝试打开控制面板并重试一次；仍失败则返回
  `UNAVAILABLE`（CLI 侧 HTTP 503 `renderer_unavailable`），**不会**用旧数据顶替。

## 已知边界（后续工作）

1. **笔记动作的 LLM 编排仍在渲染进程**：`runNoteActionOnce` 依赖渲染层的 provider 注册表
   （openai/gemini/groq 由渲染进程直连）与 localStorage 配置。主进程要独立完成动作，
   需要把这些模块（prompt 构建、预算、provider 传输）迁到主进程——迁移会引入第二份实现，
   因此当前选择"渲染层执行 + 桥 + 打开面板"而不是复制逻辑。
2. **说话人标注**目前暴露的是映射读写（`speakers.*`），逐段编辑段落文本仍需
   `notes.update transcript` 或应用内操作。
3. **长任务（重新分离、批量压缩）**是同步等待式；后续可加 job 句柄 + 查询接口。

## 加一项能力

```js
// src/helpers/appOperations/domainOperations.js
ipcOperation({
  id: "notes.something",
  title: "…",
  description: "…",
  policy: "write",
  params: { id: int("Note ID.", { required: true }) },
  channel: "some-existing-ipc-channel",   // 复用应用已有实现
  args: ({ id }) => [id],
  mcp: "do_something",
  cli: { method: "POST", path: "/v1/notes/:id/something", command: "notes something", params: { id: "path" } },
})
```

然后：

```bash
node scripts/generate-app-operations-docs.js     # 更新 references/operations.md
node --test test/helpers/appOperations.test.js   # parity / 历史表面 / 文档时效
```

MCP 与 CLI 两侧若缺一边，注册表会要求写 `excludeReason`，测试也会失败——这就是防漂移的闸门。

## 验证入口

```bash
npm test                                        # 含 registry/parity/CLI-桥端到端测试
npm run typecheck && npm run lint && npm run i18n:check
bash docs/tasks/.../verify.sh                   # 任务包门禁（若有）
```
