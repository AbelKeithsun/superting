# 词典热词与替换规则详解（dict / alias）

两套机制独立工作，都在设置 → 词典界面可见，**任何写入都会实时刷新已打开的界面**。

## 词典热词（dict）

作用：作为提示上下文传给 ASR 引擎，提升人名、术语、品牌名的识别率。纯字符串列表。

```sh
superting dict list                      # 查看全部
superting dict add 超级听记 SenseVoice    # 追加（大小写不敏感去重）
superting dict remove 过时词 --yes        # 删除（破坏性）
superting dict replace --words a,b,c --yes   # 全量替换（破坏性）
```

- `add` 返回 `{data: {added: [...], dictionary: [...]}}`：`added` 是本次真正新增的词，`dictionary` 是结果全集 —— 用它核对。
- 已存在的词（忽略大小写）不会重复添加，`added` 里也不会出现。
- `replace` 是整体覆盖，源文件见 `--json '["a","b"]'` 或 `--words a,b,c`。

## 替换规则（alias）

作用：转写完成后把 `from` 替换为 `to`（纠错）。有序列表，每条 `{from, to}`。

```sh
superting alias list                          # 查看全部
superting alias add "fun asr" "FunASR"        # 新增或按 from 覆盖
superting alias remove "fun asr" --yes        # 按 from 删除（破坏性）
superting alias replace --json '[{"from":"a","to":"b"}]' --yes   # 全量替换（破坏性）
```

- `add` 同名 `from`（忽略大小写）时**静默覆盖**旧规则 —— 想改 `to` 直接再 add 即可；返回全量规则列表用于核对。
- `remove` / `replace` 返回 `{data: {removed|aliases}}`；删除不存在的 `from` 是空操作，不报错。

## 安全约定

- `add` 类操作可不经确认；`remove` / `replace` 是破坏性的，必须先获用户同意再 `--yes`。
- 批量操作一次命令里做完（参数列表），不要为 N 个词发 N 条命令。
