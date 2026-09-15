# 说话人识别 → 声纹 → 联系人：全链路复盘

本文复盘「会议转写里的说话人从哪来、怎么变成人名、怎么变成声纹、怎么跨会议复用」这条链路，
并记录 2026-09-15 这一轮排查发现的问题与修复。读完应能回答：为什么某场会议没有 speaker_N、
为什么联系人里只有名字没有声纹、为什么标记后下拉筛选里出现重复标签。

## 1. 先分清四个概念

| 概念 | 存储 | 例子 |
| --- | --- | --- |
| 会话说话人身份（session speaker id） | 转写片段的 `speaker` 字段 | `speaker_0`（分离产出）、`manual_stored-0`（手工标记产出）、`you` |
| 显示名 | 片段 `speakerName` + 表 `speaker_mappings` | `王浩` |
| 联系人 | 表 `people` | 王浩 (id=10) |
| 声纹 | 表 `speaker_profiles`（embedding 模板）+ `voiceprints`（按人绑定 512 维向量）+ `voiceprint_segments`（可点播的试听片段） | CAM++ 512 维质心 |

**关键约束：声纹是"按人的向量"，只有在存在 speaker embedding 时才会绑定。**
`set-speaker-mapping` 里创建 profile / voiceprint / 试听片段的整段逻辑都包在
`if (speakerEmbeddingBuffer)` 内 —— 没有 embedding 时，只写 `people` + `speaker_mappings` +
`speaker_names`（人名表），联系人看起来有名字，但没有声纹。

## 2. 端到端数据流（修复后）

```
录音（mic 轨 + system 轨）
  │
  ├─ 实时转写：逐段产出片段，分 mic / system 两种 source
  │
  └─ 停止录音
       ├─ ① 保存会议音频（meetingRetainedAudioWriter → webm），写 note_audio_files
       └─ ② 自动说话人分离 _startOrSkipDiarization
            ├─ 选择输入：系统音轨有可听语音 → 用系统音轨 PCM
            │            否则（线下会议）→ 用①保存的会议音频（mic+system 混音）
            ├─ diarizeAdaptive：按 300s/30s 窗口切分 → sherpa-onnx(pyannote+CAM++) → 稳定聚类 + 封顶
            ├─ 每个 speaker 取最长 3 段（≥1.5s）算 CAM++ embedding → 质心
            └─ mergeWithTranscript 按时间重叠把片段标成 speaker_0..N
                 └─ 发 meeting-diarization-complete → 渲染层 saveNoteSpeakerEmbeddings
                    （note_speaker_embeddings：note × speaker → 向量）
  │
标记说话人（转写里点说话人标签选/输入名字）
  └─ set-speaker-mapping
       ├─ 解析联系人：exact/ambiguous → 弹窗选【关联/新建/忽略】；否则自动新建
       ├─ 有 embedding → upsertSpeakerProfile（0.3 新 + 0.7 旧 混合）
       │                 → addVoiceprint（按人）
       │                 → _captureVoiceprintSegments（把该说话人的每段存成试听片段）
       └─ 写 speaker_mappings + 在线识别器映射（liveSpeakerIdentifier）
  │
无 embedding 的手工标记（未分离的笔记，或改判说话人）
  └─ enroll-speaker-voiceprint（本轮新增）
       ├─ 按标记片段取最长 3 段（≥1.5s）→ ffmpeg 转 16k wav → CAM++ embedding → 质心
       ├─ 写 note_speaker_embeddings
       └─ 复用 set-speaker-mapping 的绑定逻辑 → 联系人获得声纹 + 试听片段
  │
词典 → 联系人
  ├─ 人名 + 声纹列表 + 试听片段（ffmpeg 按片段时间切片 → superting-clip-audio:// 播放）
  └─ 跨会议复用：_retroactiveMapping 用 profile 质心与其它笔记的 speaker embedding 比对，
     超过阈值就自动回填名字（阈值见 src/constants/speakerThresholds.json）
```

## 3. 代码索引

| 阶段 | 位置 |
| --- | --- |
| 采集 mic/system 音频、写入分离用 PCM | `src/helpers/ipcHandlers.js` → `sendMeetingAudio` |
| 分离输入选择（纯函数） | `src/helpers/diarizationInputPolicy.js` → `selectDiarizationInput` |
| 分离入口（含跳过与原因上报） | `src/helpers/ipcHandlers.js` → `_startOrSkipDiarization` |
| 分离引擎封装、窗口化、聚类稳定/封顶 | `src/helpers/diarization.js`（`diarizeAdaptive` / `stabilizeSpeakerClusters` / `capSpeakerClusters`）；窗口策略在 `src/helpers/diarizationAudioPolicy.js` |
| 分离结果合并回转写 | `src/helpers/diarization.js` → `mergeWithTranscript`（`assignMicSegments`） |
| 手工标记 → 身份解析 | `src/utils/speakerAssignment.ts` → `findTranscriptSpeakerIdByName` / `assignSegmentSpeakerName` / `getTranscriptSpeakerFilterKeyMap` |
| 标记 → 联系人/声纹绑定 | `src/helpers/ipcHandlers.js` → `_applySpeakerMapping`（`set-speaker-mapping` 与 `enroll-speaker-voiceprint` 共用） |
| 手工标记补算声纹 | `src/helpers/ipcHandlers.js` → `_extractSpeakerVoiceprint` / `_noteSpeakerAudioWindows` |
| 试听片段切取与播放 | `src/helpers/ipcHandlers.js` → `_captureVoiceprintSegments` / `get-voiceprint-segment-playback-url` |
| 说话人向量计算 | `src/helpers/speakerEmbeddings.js`（CAM++ `3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`，经 ONNX utility process） |
| 转写侧 UI | `src/components/notes/NoteEditor.tsx`、`src/components/notes/MeetingTranscriptChat.tsx` |
| 联系人/声纹 UI | `src/components/notes/PeopleManagerPanel.tsx`（词典 → 联系人） |

## 4. 本轮发现的问题与修复

### P1 自动分离只吃系统音轨 → 线下会议永远没有 speaker（已修）

`sendMeetingAudio` 只在 `source === "system"` 分支创建并写入 `meetingDiarizationStream`，
mic 分支从不写入。线下会议（大家共用一支麦克风、系统音轨静音）因此要么 `rawPcmPath` 为空被
直接跳过（`skipReason: "no-audio"`），要么对一段近乎静音的音频做分离 → 0 个 speaker。结果：
没有 `speaker_N`、没有 `note_speaker_embeddings`，也就没有声纹。手动「重新分离说话人」用的是
保存下来的会议音频，所以同一篇笔记手动分离是好的 —— 两条路径输入不一致就是根因。

修复：显式选择分离输入（`diarizationInputPolicy.js`）——系统音轨有可听语音就用它；否则回退到
保存的会议音频；时间基准跟着实际输入的音频走。跳过/失败原因现在会以 toast 呈现（`disabled`
是用户自己的选择，保持安静）。

### P2 手工标记只改名"块内首段"，且每次都新造说话人身份（已修）

最终转写视图把连续同源片段合并成一个说话人块（60s / 420 字上限），而标记回调只带块的
**第一个** stored 片段 id：块被切开后仍剩一个未命名块（看起来"名字没变"），且每次点击都新造
一个 `manual_*` 身份 → 筛选下拉里堆出多个同名标签（同名标签按 speaker id 分组）。

修复：说话人标签携带整块的 segmentIds（所见即所改）；同名标记并入已有身份；筛选键改为按
"解析后的说话人姓名"分组（历史遗留的重复身份也会合并成一个筛选标签）。

### P3 手工标记不产声纹（本轮新增能力）

手工标记的 `manual_*` 身份没有 embedding，绑定逻辑整段不执行。新增
`enroll-speaker-voiceprint`：从笔记音频里按标记片段提取声纹（最长 3 段 ≥1.5s → 质心），写入
`note_speaker_embeddings`，再复用既有绑定流程。标记成功后自动在后台触发（同一 note+speaker 只跑
一次；已有 embedding 直接跳过）。

### P4 诊断性缺失（已修）

`diarizationSkipped` / `skipReason` / `diarizationFailed` 到渲染层后没有任何处理，用户只看到
"没有 speaker" 而不知道原因；`diarization_enabled` 只在用户手动切分离开关时才写 1/0，
**NULL 不代表没跑过**（不能当运行状态用）。

## 5. 聚类质量：实测与结论（本轮补齐）

拿真实笔记（note 10，1730s、343 段、线下会议）离线跑完整管线并做阈值标定：

| 实验 | 结果 |
| --- | --- |
| 引擎 `threshold=0.55`、`num-clusters=-1` | 72+ 原始簇；稳定+封顶后 **16 个说话人** |
| 引擎 `threshold=0.75` | 原始簇降到 **41 个**（仍远超真实人数）→ 单纯调阈值不是解 |
| 各簇声纹两两 cosine | 中位数 **0.58**、p90 **0.83**、最大 0.94（区分度差） |
| 按声纹"相似即合并"（并查集传递） | 阈值 0.35~0.70 **全部 16 簇并成 1 个** → 不可用 |

结论：这段音频（单麦克风房间录音 + mic/system 混音）上 CAM++ 的簇间相似度整体偏高，
**不能靠相似度自动合并**，否则会把整场会议并成一个人。因此改为三件事：

1. **有界碎片吸收**（`speakerClusterMerge.js`，常数 `clusterMergeThreshold=0.8`、
   `clusterMergeMaxFragmentSeconds=20`）：只有"短于 20 秒且不到最长簇一半"的碎片，才允许并入
   与其声纹最相似的**更长簇**；主力簇之间永不互相合并 → 结构上不可能塌成一个人。
2. **显式人数优先**：`重新分离说话人 → 固定人数` 会以 `--clustering.num-clusters=N` 做聚类，
   这是本录音上唯一稳定可控的解法；会议里设置过"预计人数"时自动分离也会沿用。
3. **可发现性**：转写工具栏在结果说话人数 > 8 时显示提示标签，并保留"把说话人并入正确说话人"
   的手工合并路径（说话人标签菜单选另一个会话说话人即并入）。

## 6. 本轮（续）其他改动

1. **`diarization_enabled` 语义**：新增 `notes.diarization_status`（`completed`/`skipped`/`failed`）、
   `diarization_skip_reason`、`diarization_speaker_count` 三列，自动分离与"重新分离"都会写入真实
   结果；工具条上用标签显示 skipped/failed（悬停看原因），`diarization_enabled` 保留为"用户偏好"。
2. **试听片段时长**：`_noteSpeakerAudioWindows` 现在优先用片段自带的 `endTime`；没有时以**下一句
   的起点**为界（夹在 1.5s~8s 之间），不再一律 `start + 3s` 而串到别人那句。分离合并时也会把
   解析出的 end 写回片段（`mergeWithTranscript` → `enriched.endTime`），转写序列化已带上
   `endTime`，供试听切片与定位复用。
3. **声纹重算入口**：说话人标签菜单新增"从本场音频重新提取声纹"（调用
   `enroll-speaker-voiceprint` 的 `force` 路径，会重新混合 profile 模板并刷新试听片段）。
4. **重新分离也会保存声纹**：`_rediarizeNoteAudio` 现在把簇质心写入 `note_speaker_embeddings`，
   因此手动重新分离之后，标记说话人即可直接绑定声纹（不再依赖补算）。

## 7. 仍然遗留

1. **一段 30 分钟的独白仍需逐块点**（60s 一块）；同名合并 + 整块改名已把成本降到"每块一点"。
2. **自动模式的人数推断**：没有日历参与人、也没有实时识别结果时，自动分离仍以 `num-clusters=-1`
   运行，线下会议会偏碎；后续可考虑按会议时长/首次分离结果给一个有界默认人数。
3. **跨会议自动回填**依赖 `notes_speaker_embeddings` 与 profile 质心的 cosine 阈值
   （`batchConfirmedThreshold=0.6`），在区分度差的录音上同样偏乐观，值得用更多真实会议标定。

## 8. 复现/验证手段

- 单测：`test/utils/speakerAssignment.test.ts`、`test/helpers/diarizationInputPolicy.test.js`
- 离线跑真实分离管线（不需要真的开会）：把笔记音频转成 16k wav 后跑
  `diarizeAdaptive` + `mergeWithTranscript`（本次用 note 10 的 1730s 音频验证：全 340 段 mic 都
  匹配到 speaker，0 段 unmatched）。
- 声纹向量链路（Electron 内）：加载 CAM++ 模型对指定时间段算 embedding 并做质心，
  本次验证输出 `dim 512 / norm 97.37 / 同段自相似 0.9679`。
