# 全路由参考（请求体与语义）

所有变更类路由会向应用窗口广播对应事件，设置/笔记界面实时刷新（无需重载）。

## 笔记

| 路由                                              | 说明                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /v1/notes/list?limit=&folder_id=&note_type=` | 列表（不截断内容）                                                             |
| `GET /v1/notes/search?q=&limit=`                  | 关键词全文搜索；空 q 返回 400                                                  |
| `GET /v1/notes/<id>`                              | 单篇全文                                                                       |
| `POST /v1/notes/create`                           | body: `{title, content, note_type, folder_id, tags}` → 201 + 完整笔记          |
| `PATCH /v1/notes/<id>`                            | body 任意子集：`title, content, enhanced_content, transcript, folder_id, tags` |
| `DELETE /v1/notes/<id>`                           | 204；广播 `note-added`/`note-updated`/…，并同步向量索引                        |

## 文件夹 / 标签

| 路由                      | 说明                 |
| ------------------------- | -------------------- |
| `GET /v1/folders/list`    | 全部文件夹           |
| `POST /v1/folders/create` | body: `{name}` → 201 |
| `GET /v1/tags`            | 笔记在用标签         |

## 转写

| 路由                                   | 说明                  |
| -------------------------------------- | --------------------- |
| `GET /v1/transcriptions/list?limit=50` | 转写文本 + 音频元数据 |
| `GET /v1/transcriptions/<id>`          | 单条                  |
| `DELETE /v1/transcriptions/<id>`       | 删除记录              |
| `DELETE /v1/transcriptions/<id>/audio` | 仅删音频文件          |

## 词典热词

| 路由                                        | 说明                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /v1/dictionary`                        | → `{data: ["word", ...]}`                                                          |
| `PUT /v1/dictionary`                        | 全量替换，body: `{"words": [...]}`                                                 |
| `POST /v1/dictionary/words`                 | 追加（大小写不敏感去重），body: `{"words": [...]}` → `{data: {added, dictionary}}` |
| `DELETE /v1/dictionary/words?word=a&word=b` | 按词删除                                                                           |

## 替换规则（纠错）

| 路由                                          | 说明                                                     |
| --------------------------------------------- | -------------------------------------------------------- |
| `GET /v1/dictionary/aliases`                  | → `{data: [{from, to}, ...]}`                            |
| `PUT /v1/dictionary/aliases`                  | 全量替换，body: `{"aliases": [{"from","to"}, ...]}`      |
| `POST /v1/dictionary/aliases`                 | 新增或按 `from`（忽略大小写）覆盖，body: `{"from","to"}` |
| `DELETE /v1/dictionary/aliases?from=a&from=b` | 按 from 删除                                             |

词典/别名变更广播 `dictionary-updated` / `dictionary-aliases-updated`。

## 错误约定

- 校验失败：HTTP 400 `{"error":{"code":"validation_error","message":...}}`
- id 不存在：HTTP 404 `{"error":{"code":"not_found",...}}`
- 未认证：HTTP 401；非回环来源：HTTP 403

## 示例：加一条纠错规则

```sh
curl -sS -X POST \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d '{"from":"super ting","to":"SuperTing"}' \
  "${base_url}/v1/dictionary/aliases"
```
