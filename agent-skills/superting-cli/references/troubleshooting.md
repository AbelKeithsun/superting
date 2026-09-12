# 故障排查与版本核对

## 退出码

| 码  | 含义                                       |
| --- | ------------------------------------------ |
| 0   | 成功                                       |
| 1   | 桥接/应用错误（HTTP 错误、bridge 不可达）  |
| 2   | 用法错误（参数/flag 不合法、缺少 `--yes`） |

错误输出到 stderr，形如 `{"error": {"code": "...", "message": "..."}}`。

## 常见错误码

| code                           | 处置                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `bridge_not_running`           | 应用没启动或 bridge 文件丢失。让用户启动 SuperTing；**不要循环重试**                    |
| `bridge_timeout`               | 桥接请求 15s 超时，应用可能卡死；建议用户重启应用                                       |
| `not_found`（HTTP 404）        | id 不存在 —— 重新 `list`/`search`，不要猜 id。也可能是应用版本过旧（无该路由，见下）    |
| `validation_error`（HTTP 400） | 请求体/参数不合法，按 message 修正                                                      |
| `unauthorized`（HTTP 401）     | bridge 文件与运行中应用不匹配（常见于 dev 与安装版混用后过期），重启 SuperTing 应用即可 |

## bridge 诊断

bridge 元数据：`~/.superting/cli-bridge.json`（端口 + token，仅本机回环）。

```sh
bridge="${HOME}/.superting/cli-bridge.json"
port="$(jq -r .port "$bridge")"
token="$(jq -r .token "$bridge")"
curl -sS -H "Authorization: Bearer ${token}" "http://127.0.0.1:${port}/v1/health"
```

注意：dev 实例与安装版**共用同一个 bridge 文件**。dev 退出会删掉它，
导致安装版不可达 —— 重启安装版应用即恢复。

## 版本核对

skill 与 client 同版本发布。frontmatter 的 `cli_version` 声明兼容的最低 client：

```sh
superting --version          # 查 client 版本
superting-skills --check     # 比对已安装 skill 版本 vs 可用版本
```

若命令行为出现 404（如 `tags list`、`dict add`）而文档说该命令存在，
多半是安装版应用低于 2.0.3 —— 让用户升级应用，而不是换工具。
