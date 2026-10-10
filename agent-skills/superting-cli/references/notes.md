# 笔记命令详解（notes / folders / tags / transcriptions）

所有命令输出 JSON：`{data: ...}`。id 永远从输出提取。

## 列出与查找

```sh
superting notes list [--limit N] [--type personal|meeting] [--folder-id ID] [--full]
superting notes search "关键词" [--limit N] [--full]
```

- 列表/搜索默认把 `content` 截断到 500 字（防止上下文爆炸）；`--full` 取消截断，但优先用 `notes get <id>` 拿单篇全文。
- 搜索是关键词全文匹配；命中后从输出里取 `id`。

## 读取

```sh
superting notes get <id>
```

返回全部字段：`content`、`enhanced_content`（AI 整理稿）、`transcript`（原始转写）、`tags`、`folder_id`、时间戳。

## 创建

```sh
superting notes create --title <标题> [--content <正文>] [--type personal|meeting] [--folder-id ID] [--tags a,b]
```

- 创建成功返回完整笔记对象，从中取 `id`。
- `--folder-id` 省略时进默认文件夹（personal → Personal，meeting → Meetings）。
- `folders list` 可查文件夹 id；`folders create --name <名称>` 新建。

## 编辑

```sh
superting notes update <id> [--title <t>] [--content <c>] [--transcript <t>] [--folder-id ID] [--tags a,b] [--find <文本> --replace <文本>]
superting notes append <id> --text <追加内容>
```

- `--find/--replace`：**字面量**（非正则）全量替换，只作用于 `content`。适合订正转写里的错词。
- `--tags` 是整体替换（空串清空标签）；`tags list` 可看现有标签。
- `--transcript` 替换原始转写字段（整段替换，不做查找替换）。
- 至少提供一个修改项，否则报用法错误（exit 2）。
- 编辑成功返回更新后的完整笔记 —— 必须核对返回内容再汇报。

## 删除（破坏性）

```sh
superting notes delete <id> --yes
```

先向用户确认，拿到同意才加 `--yes`。删除返回 `{data: {id, deleted: true}}`。

## 转写记录

```sh
superting transcriptions list [--limit N]
superting transcriptions get <id>
```

听写（dictation）的转写文本 + 音频元数据（不含音频本体）。

## 转写段落（会议录音的结构化转录）

会议笔记的 `transcript` 是结构化段落数组；下面的命令直接读写单段，用于改错别字、
指定发言人、删除噪声段。**段 id 每次读取都由应用重派生为 `stored-<index>`**，
所以要么用列表返回的 id，要么直接用 `index`，不要沿用自己写入的 id。

```sh
superting transcript segments --id 47 --limit 20          # {total, offset, count, has_more, segments[]}
superting transcript segment-update --id 47 --index 0 --text "修正后的文本"
superting transcript segment-update --id 47 --index 3 --speaker-name "张三" --speaker manual_1 --lock true
superting transcript segment-delete --id 47 --index 12 --count 2
```

- 改文本会标记 `edited_user: true` 并保留 `original_text`（与编辑器内联编辑一致）。
- `lock: true` 表示锁定发言人，之后的自动分离不会再覆盖。
- 纯文本转录（非结构化）会报错 `stores a plain-text transcript, not structured segments`，
  此时改用 `notes update <id> --find/--replace`。
- 列表默认 `limit 200`，长会议（上千段）务必分页，避免灌爆上下文。
- 参数用 snake_case 也会被接受（`--note_id` 与 `--note-id` 等价）；`true/false/数字/逗号列表` 由 CLI 自动转换。

## 回收站与永久删除

```sh
superting notes delete <id>          # 软删除（进回收站）
superting notes purge <id>           # 永久删除（清空回收站里的这一条，不可恢复）
```

## 导入与导出

```sh
superting notes import 47 --file-path /abs/path/notes.md --target note   # 或 --target transcript
superting notes export 47 --format md        # 直接返回文本（无对话框）
superting notes export-to-disk --note-ids 47 --format md --fields content   # 走应用保存对话框
```
