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
