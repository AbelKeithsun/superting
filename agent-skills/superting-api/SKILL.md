---
name: superting-api
description: Use SuperTing's local loopback HTTP bridge directly (fallback when no `superting` CLI command covers the need). Prefer the superting-cli skill for agent workflows.
cli_version: ">=2.0.3"
---

# SuperTing 本地回环 API（兜底通道）

桌面应用在本机回环地址暴露 HTTP bridge（`superting` CLI 的传输层）。
**仅当 CLI 无对应命令时**才用裸路由；认证、连接细节与 CLI 完全相同。

## 连接

bridge 元数据（端口 + token）在 `~/.superting/cli-bridge.json`：

```sh
bridge="${HOME}/.superting/cli-bridge.json"
port="$(jq -r .port "$bridge")"
token="$(jq -r .token "$bridge")"
base_url="http://127.0.0.1:${port}"
```

每个请求带 `Authorization: Bearer ${token}`。仅绑定 127.0.0.1，无托管服务、无需账号。

## 路由总览

| 域          | 路由                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| 健康        | `GET /v1/health`                                                                     |
| 笔记        | `GET /v1/notes/list`、`GET /v1/notes/search`、`GET/POST/PATCH/DELETE /v1/notes[...]` |
| 文件夹/标签 | `GET /v1/folders/list`、`POST /v1/folders/create`、`GET /v1/tags`                    |
| 转写        | `GET /v1/transcriptions/list`、`GET /v1/transcriptions/<id>`、`DELETE ...`           |
| 词典        | `GET/PUT /v1/dictionary`、`POST /v1/dictionary/words`、`DELETE /v1/dictionary/words` |
| 替换规则    | `GET/PUT/POST/DELETE /v1/dictionary/aliases[...]`                                    |

方法语义、请求体格式与实时刷新行为 → [references/routes.md](references/routes.md)（按需读取）。

## 红线

- 只连 127.0.0.1；token 用完即弃，不写入日志或文件。
- 不加遥测、远程同步或账号体系。
- 连不上时向用户说明"应用未运行"，不要重试循环。
