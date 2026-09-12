# SuperTing AI 助手技术参考

本文档面向参与本代码库工作的 AI 助手，提供 SuperTing 项目架构的完整技术细节。

## 项目概览

SuperTing 是一款基于 Electron 的桌面听写应用，使用 whisper.cpp 进行语音转文字。同时支持本地（隐私优先）与云端（OpenAI API）两种处理模式。

## 架构总览

### 核心技术栈

- **前端**: React 19、TypeScript、Tailwind CSS v4、Vite
- **桌面框架**: Electron 41（启用 context isolation）
- **数据库**: better-sqlite3，存储本地转写历史
- **UI 组件**: shadcn/ui + Radix 原语
- **语音处理**: whisper.cpp + NVIDIA Parakeet + FunASR SenseVoice（经 sherpa-onnx）+ OpenAI API
- **音频处理**: FFmpeg（通过 ffmpeg-static 打包内置）
- **Node.js**: 24（`.nvmrc` 锁定 — CI 使用 Node 24，切勿用其他大版本重新生成 `package-lock.json`）

### 关键架构决策

1. **双窗口架构**:
   - 主窗口：极简听写悬浮窗（可拖动、置顶）
   - 控制面板：完整设置界面（普通窗口）
   - 两者共用同一套 React 代码，通过 URL 路由区分

2. **进程隔离**:
   - 主进程：Electron main、IPC 处理器、数据库操作
   - 渲染进程：React 应用（context isolation）
   - Preload 脚本：进程间安全桥接
   - ONNX Utility Process：承载所有 `onnxruntime-node` 推理（文本嵌入、说话人嵌入、fbank）。首次使用时经 `src/helpers/onnxWorkerClient.js` → `src/workers/onnxWorker.js` 惰性拉起。原生崩溃（如 ORT `bad_alloc`）被限制在 worker 内；主进程拒绝在途请求并按退避策略重新拉起。在 `will-quit` 中停止。

3. **音频管线**:
   - MediaRecorder API → Blob → ArrayBuffer → IPC → 文件 → whisper.cpp
   - 处理完成后自动清理临时文件

## 文件结构与职责

### 主进程文件

- **main.js**: 应用入口，初始化所有管理器
- **preload.js**: 通过 window.api 向渲染进程暴露安全的 IPC 方法

### 原生资源（resources/）

- **windows-key-listener.c**: Windows 低级键盘钩子（Push-to-Talk）的 C 源码
- **windows-mic-listener.c**: WASAPI 麦克风会话监视器（事件驱动麦克风检测）的 C 源码
- **macos-mic-listener.swift**: CoreAudio 麦克风属性监听器（事件驱动麦克风检测）的 Swift 源码
- **globe-listener.swift**: macOS Globe/Fn 键检测的 Swift 源码
- **bin/**: 编译产出的原生二进制目录（whisper-cpp、nircmd、按键/麦克风监听器）

### 辅助模块（src/helpers/）

- **audioManager.js**: 音频设备管理
- **clipboard.js**: 跨平台剪贴板操作
  - macOS: 基于 AppleScript 的粘贴，带辅助功能权限检查
  - Windows: PowerShell SendKeys，nircmd.exe 兜底
  - Linux: 原生 XTest 二进制 + 按合成器自动回退（xdotool、wtype、ydotool）
- **database.js**: 转写历史的 SQLite 操作
- **debugLogger.js**: 调试日志系统，支持文件输出
- **devServerManager.js**: Vite 开发服务器集成
- **dragManager.js**: 窗口拖动
- **environment.js**: 环境变量与 OpenAI API 管理
- **hotkeyManager.js**: 全局快捷键注册与管理
  - 处理平台默认键（macOS 为 GLOBE，Windows/Linux 为反引号）
  - 默认快捷键不可用时自动回退 F8/F9
  - 注册失败时通过 IPC 通知渲染进程
  - 集成 GnomeShortcutManager 支持 GNOME Wayland
  - 集成 HyprlandShortcutManager 支持 Hyprland Wayland
- **gnomeShortcut.js**: GNOME Wayland 全局快捷键集成
  - 通过 D-Bus 服务接收快捷键切换命令
  - 经 gsettings 注册快捷键（在 GNOME 设置 → 键盘 → 快捷键中可见）
  - 将 Electron 快捷键格式转换为 GNOME keysym 格式
  - 仅在 Linux + Wayland + GNOME 桌面下生效
- **hyprlandShortcut.js**: Hyprland Wayland 全局快捷键集成
  - 通过 D-Bus 服务接收快捷键切换命令（同一个 `com.sysusugan.SuperTing` 服务）
  - 经 `hyprctl keyword bind` 注册快捷键（运行时键绑定）
  - 将 Electron 快捷键格式转换为 Hyprland bind 格式（`MODS, key`）
  - 仅在 Linux + Wayland + Hyprland 下生效（通过 `HYPRLAND_INSTANCE_SIGNATURE` 检测）
- **ipcHandlers.js**: 集中的 IPC 处理器注册
- **windowsKeyManager.js**: 基于原生按键监听器的 Windows Push-to-Talk 支持
  - 拉起原生 `windows-key-listener.exe` 二进制实现低级键盘钩子
  - 支持组合快捷键（如 `Ctrl+Shift+F11`、`CommandOrControl+Space`）
  - 发出 `key-down` / `key-up` 事件驱动按住说话
  - 二进制不可用时优雅回退
- **meetingDetectionEngine.js**: 统一编排来自各渠道的会议检测
  - 录音期间屏蔽通知（tap-to-talk 与 push-to-talk）
  - 录音结束后 2.5 秒冷却再展示排队中的通知
  - 基于优先级的合并（进程 > 音频）— 只弹一条通知，不是三条
- **meetingProcessDetector.js**: 检测正在运行的会议应用
  - macOS: 经 `systemPreferences.subscribeWorkspaceNotification` 事件驱动（零 CPU）
  - Windows/Linux: 共享 `processListCache` 轮询（30 秒间隔）
- **audioActivityDetector.js**: 检测计划外会议的麦克风占用
  - macOS: `macos-mic-listener` 二进制（CoreAudio 属性监听器）事件驱动
  - Windows: `windows-mic-listener.exe`（WASAPI 会话，排除自身 PID）
  - Linux: `pactl subscribe`（PulseAudio source-output 事件）
  - 全平台：原生方案失败时优雅回退到轮询
- **processListCache.js**: 共享单例进程列表缓存（TTL 5 秒，`ps-list` npm 包）
- **googleCalendarManager.js**: Google 日历同步，指数退避
  - API 请求 10 秒 socket 超时
  - 连续失败退避：2 分钟 → 4 分钟 → 8 分钟，上限 30 分钟
  - 任一次成功即恢复正常间隔
- **menuManager.js**: 应用菜单管理
- **tray.js**: 系统托盘图标与菜单
- **whisper.js**: 本地 whisper.cpp 集成与模型管理
- **parakeet.js**: 基于 sherpa-onnx 的 NVIDIA Parakeet 模型管理
- **parakeetServer.js**: sherpa-onnx CLI 转写封装
- **qdrantManager.js**: Qdrant 向量数据库 sidecar 进程生命周期（拉起、健康检查、关闭）
- **localEmbeddings.js**: 基于 ONNX Runtime + all-MiniLM-L6-v2 的本地文本嵌入（384 维向量）
- **vectorIndex.js**: Qdrant collection 管理 — upsert、删除、搜索、批量重建索引
- **windowConfig.js**: 集中的窗口配置
- **windowManager.js**: 窗口创建与生命周期管理
- **cliBridge.js**: 回环 HTTP 服务器，端口 8200–8219，Bearer token 认证（token 位于 `~/.superting/cli-bridge.json`），仅允许 127.0.0.1。供统一 CLI 与运行中的桌面应用通信。
- **postMigrationDetector.js**: 通过 userData 中的 `.bundle-migrated` 哨兵文件检测从旧 Gizmo bundle ID 迁移回来的用户；由 `ipcHandlers.js` 消费以触发 `PostMigrationOnboarding` 弹窗

### React 组件（src/components/）

- **App.jsx**: 主听写界面，含录音状态
- **ControlPanel.tsx**: 设置、历史、模型管理 UI
- **OnboardingFlow.tsx**: 8 步首次设置向导
- **PostMigrationOnboarding.tsx**: 面向旧 Gizmo bundle ID 迁移用户的一次性弹窗；复用 `PermissionsSection` 引导重新授权麦克风、辅助功能与系统音频。由 `postMigrationDetector.js` 触发（见辅助模块）
- **SettingsPage.tsx**: 综合设置界面
- **WhisperModelPicker.tsx**: 模型选择与下载 UI
- **ui/**: 可复用 UI 组件（按钮、卡片、输入框等）

### React Hooks（src/hooks/）

- **useAudioRecording.js**: MediaRecorder API 封装，含错误处理
- **useClipboard.ts**: 剪贴板操作 hook
- **useDialogs.ts**: Electron 对话框集成
- **useHotkey.js**: 快捷键状态管理
- **useLocalStorage.ts**: 类型安全的 localStorage 封装
- **usePermissions.ts**: 系统权限检查与设置跳转
  - `openMicPrivacySettings()`: 打开系统麦克风隐私设置
  - `openSoundInputSettings()`: 打开系统声音输入设备设置
  - `openAccessibilitySettings()`: 打开辅助功能隐私设置（仅 macOS）
- **useSettings.ts**: 应用设置管理
- **useWhisper.ts**: Whisper 二进制可用性检查

### 服务层

- **ReasoningService.ts**: 面向 agent 指令的 AI 处理
  - 检测用户呼出自定义 agent 名称，并从最终输出中移除该名称
  - Provider 实现注册在 `src/services/ai/inferenceProviders/index.ts`，覆盖 8 个 provider（`anthropic`、`enterprise`、`gemini`、`groq`、`lan`、`local`、`openai`、`superting`），各自实现 `types.ts` 中的 `InferenceProvider` 接口
  - 按作用域的 LLM 配置：4 个作用域（`dictationCleanup`、`dictationAgent`、`noteFormatting`、`chatIntelligence`），定义于 `src/config/inferenceScopes.ts`
  - `settingsStore.ts` 中的 `selectResolvedLLMConfig(state, scope)` 按作用域解析 provider/模型，带回退链

### whisper.cpp 集成

- **whisper.js**: 本地转写的原生二进制封装
  - 二进制打包于 `resources/bin/whisper-cpp-{platform}-{arch}`
  - 回退到系统安装（`brew install whisper-cpp`）
  - GGML 模型从 HuggingFace 下载
  - 模型存放于 `~/.cache/superting/whisper-models/`

### NVIDIA Parakeet 集成（经 sherpa-onnx）

- **parakeet.js**: NVIDIA Parakeet ASR 模型管理
  - 使用 sherpa-onnx 运行时做跨平台 ONNX 推理
  - 二进制打包于 `resources/bin/sherpa-onnx-{platform}-{arch}`
  - INT8 量化模型，CPU 推理高效
  - 模型存放于 `~/.cache/superting/parakeet-models/`
  - 设置 `LOCAL_TRANSCRIPTION_PROVIDER=nvidia` 时启动即预热服务
  - 服务启停时经 `saveAllKeysToEnvFile()` 将 provider 偏好持久化到 `.env`

- **可用模型**:
  - `parakeet-tdt-0.6b-v3`: 多语言（25 种），约 680MB
  - `parakeet-unified-en-0.6b`: 仅英语，约 631MB，英语准确率业界领先（Open ASR 榜单平均 WER 5.91%）

- **下载地址**: 模型来自 GitHub 上的 sherpa-onnx ASR models release

### FunASR SenseVoice 集成（经 sherpa-onnx）

- **funasr.js**: FunASR SenseVoice-Small ASR 模型管理
  - 复用与 Parakeet 相同的 sherpa-onnx WS server 二进制（无新运行时）
  - 模型存放于 `~/.cache/superting/funasr-models/`
  - 从 HuggingFace 镜像按文件下载（默认 `hf-mirror.com`，可用 `SUPERTING_FUNASR_HF_MIRROR` 覆盖），并以 GitHub release 压缩包 + `gh-proxy.com`（`SUPERTING_FUNASR_GH_PROXY`）和 HF 官方源作为回退
  - 设置 `LOCAL_TRANSCRIPTION_PROVIDER=funasr` 时启动即预热服务
- **funasrServer.js / funasrWsServer.js**: WS server 封装 + 30 秒分段，对应 `parakeetServer.js`/`parakeetWsServer.js`（端口范围 6030-6053）
- **可用模型**:
  - `sensevoice-small`: zh/en/ja/ko/yue，约 228MB int8，支持 ITN + 情绪/事件标签
- **Provider 环境变量**: `LOCAL_TRANSCRIPTION_PROVIDER=funasr`、`FUNASR_MODEL=sensevoice-small`

### 本地语义搜索（Qdrant + MiniLM）

常驻的离线语义搜索，按含义（而非仅关键词）检索笔记。供 AI agent 的 `search_notes` 工具使用。Qdrant 在应用启动时自动拉起；嵌入模型缺失时首次运行自动下载。

**架构**:

- **Qdrant sidecar**: Rust 二进制，以子进程方式拉起（`qdrantManager.js`），端口 6333–6350
- **嵌入模型**: `all-MiniLM-L6-v2`，经 ONNX Runtime（`localEmbeddings.js`），384 维向量
- **向量索引**: Qdrant collection 管理（`vectorIndex.js`），余弦距离
- **混合检索**: FTS5 + Qdrant 并行 → 倒数排名融合 RRF（K=60），余弦分阈值 0.3

**管线**:

1. 应用启动 → Qdrant 二进制拉起 → 创建 collection。嵌入模型缺失时自动下载（约 22MB）
2. 笔记增/改/删 → SQLite 写入 → 后台向量 upsert/删除（`_asyncVectorUpsert()`/`_asyncVectorDelete()`）
3. agent 检索 → `db-semantic-search-notes` IPC → FTS5 + 向量并行搜索 → RRF 合并 → 排序结果

**检索回退链**（`searchNotesTool.ts`）: 云端搜索 → 本地语义 → FTS5 关键词

**存储**:

- Qdrant 数据: `~/.cache/superting/qdrant-data/`
- Qdrant 二进制: `resources/bin/qdrant-{platform}-{arch}`（打包内置 — 在 `prebuild` / `predev` 期间下载）
- 嵌入模型: `~/.cache/superting/embedding-models/all-MiniLM-L6-v2/`（首次启动自动下载）

**依赖**: `@qdrant/js-client-rest`、`onnxruntime-node`

**开发环境**: Qdrant 二进制经 `predev`/`prestart` 自动下载。嵌入模型首次启动应用时自动下载。手动下载：`npm run download:qdrant` 与 `npm run download:embedding-model`。

### 构建脚本（scripts/）

- **download-whisper-cpp.js**: 从 GitHub releases 下载 whisper.cpp 二进制
- **download-llama-server.js**: 下载 llama.cpp server 供本地 LLM 推理
- **download-nircmd.js**: 下载 nircmd.exe 供 Windows 剪贴板操作
- **download-windows-key-listener.js**: 下载预编译的 Windows 按键监听器二进制
- **download-windows-mic-listener.js**: 下载预编译的 Windows 麦克风监听器二进制
- **download-sherpa-onnx.js**: 下载 sherpa-onnx 二进制以支持 Parakeet
- **download-qdrant.js**: 下载 Qdrant 向量数据库二进制以支持本地语义搜索
- **download-minilm.js**: 下载 all-MiniLM-L6-v2 ONNX 模型 + tokenizer 供本地嵌入
- **build-globe-listener.js**: 从 Swift 源码编译 macOS Globe 键监听器
- **build-macos-mic-listener.js**: 从 Swift 源码编译 macOS 麦克风监听器
- **build-windows-key-listener.js**: 编译 Windows 按键监听器（本地开发用）
- **run-electron.js**: 以正确环境启动 Electron 的开发脚本。macOS 上必须经 LaunchServices（`open -n -W`）启动 — 直接 spawn 的二进制拿不到 TCC 麦克风授权弹窗，录进去的是静音零样本
- **lib/download-utils.js**: 下载与解压的共享工具
  - `fetchLatestRelease(repo, options)`: 从 GitHub API 拉取最新 release
  - `downloadFile(url, dest)`: 带进度与重试的文件下载
  - `extractZip(zipPath, destDir)`: 跨平台 zip 解压
  - `parseArgs()`: 解析 CLI 参数，支持平台/架构定向
  - 支持 `GITHUB_TOKEN` 认证请求（更高速率限制）

## 关键实现细节

### 1. FFmpeg 集成

FFmpeg 随应用打包，无需系统安装：

```javascript
// FFmpeg 从 ASAR 解包到 app.asar.unpacked/node_modules/ffmpeg-static/
```

### 2. 录音流程

1. 用户按下快捷键 → MediaRecorder 开始
2. 音频分片收集到数组
3. 用户再次按下快捷键 → 录音停止
4. 由分片生成 Blob → 转换为 ArrayBuffer
5. 经 IPC 发送
6. 主进程写入临时文件
7. whisper.cpp 处理文件 → 返回结果
8. 删除临时文件

### 3. 本地 Whisper 模型（GGML 格式）

模型存放于 `~/.cache/superting/whisper-models/`：

- tiny: 约 75MB（最快，质量最低）
- base: 约 142MB（推荐的速度/质量平衡）
- small: 约 466MB（质量更好）
- medium: 约 1.5GB（高质量）
- large: 约 3GB（质量最佳）
- turbo: 约 1.6GB（速度快且质量好）

### 4. 数据库 Schema

```sql
CREATE TABLE transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  original_text TEXT NOT NULL,
  processed_text TEXT,
  is_processed BOOLEAN DEFAULT 0,
  processing_method TEXT DEFAULT 'none',
  agent_name TEXT,
  error TEXT
);
```

### 5. 设置存储

设置存储在 localStorage，键名如下：

- `whisperModel`: 所选 Whisper 模型
- `useLocalWhisper`: 本地/云端布尔开关
- `language`: 所选语言代码
- `agentName`: 用户自定义 agent 名称
- `reasoningModel`: 处理所用的 AI 模型
- `reasoningProvider`: AI provider（openai/anthropic/gemini/local）
- `hotkey`: 自定义快捷键配置
- `hasCompletedOnboarding`: 引导完成标志
- `customDictionary`: 用于提升转写准确率的词组 JSON 数组

机密环境变量（共 12 个：7 个 BYOK API key + 5 个企业云凭据 — 见 `environment.js` 的 `SECRET_KEYS`）通过 Electron `safeStorage` 静态加密，按 key 以文件形式存于 `userData/secure-keys/`。启动时由 `EnvironmentManager.init()` 装入 `process.env`。渲染进程经 IPC 读取（`get-*-key`）、经防抖 IPC 写入（`save-*-key`）。Linux 无钥匙环时机密退化为明文（Electron 默认行为）。

非机密环境变量持久化到 `.env`（经 `saveAllKeysToEnvFile()`）：

- `LOCAL_TRANSCRIPTION_PROVIDER`: 转写引擎（Parakeet 为 `nvidia`）
- `PARAKEET_MODEL`: 所选 Parakeet 模型名（如 `parakeet-tdt-0.6b-v3`）

### 6. 语言支持

支持 58 种语言（见 src/utils/languages.ts）：

- 每种语言有两位字母代码与显示名
- "auto" 为自动检测
- 经 -l 参数传给 whisper.cpp

### 7. Agent 命名系统

- 用户在引导流程（第 6/8 步）为 agent 命名
- 名称存储于 localStorage 与数据库
- ReasoningService 检测 "Hey [AgentName]" 模式
- AI 处理指令并从输出中移除 agent 呼出
- 支持多个 AI provider（所有模型定义于 `src/models/modelRegistryData.json`）：
  - **OpenAI**（Responses API）:
    - GPT-5.5（`gpt-5.5`）- 最新旗舰前沿模型，1M 上下文
    - GPT-5.2（`gpt-5.2`）- 强推理模型
    - GPT-5 Mini（`gpt-5-mini`）- 快速且高性价比
    - GPT-5 Nano（`gpt-5-nano`）- 极速、低延迟
    - GPT-4.1 系列（`gpt-4.1`、`gpt-4.1-mini`、`gpt-4.1-nano`）- 强基线，1M 上下文
  - **Anthropic**（经 IPC 桥接以规避 CORS）:
    - Codex Opus 4.7（`Codex-opus-4-7`）- 最强的 Codex 模型，1M 上下文
    - Codex Sonnet 4.6（`Codex-sonnet-4-6`）- 均衡之选
    - Codex Haiku 4.5（`Codex-haiku-4-5`）- 快速，接近前沿智能
    - Codex Opus 4.6（`Codex-opus-4-6`）- 上一代 Opus，1M 上下文
    - Codex Sonnet 4.5（`Codex-sonnet-4-5`）- 上一代 Sonnet
    - Codex Opus 4.5（`Codex-opus-4-5`）- 更早的 Opus
  - **Google Gemini**（直连 API）:
    - Gemini 3.1 Pro（`gemini-3.1-pro-preview`）- 最强的 Gemini 模型
    - Gemini 3 Flash（`gemini-3-flash-preview`）- 下一代极速高能力模型
    - Gemini 2.5 Flash Lite（`gemini-2.5-flash-lite`）- 最低延迟与成本
  - **本地**: 经 llama.cpp 的 GGUF 模型（Qwen、Llama、Mistral、GPT-OSS）

### 8. 模型注册架构

所有 AI 模型定义集中在 `src/models/modelRegistryData.json`，作为唯一事实来源：

```json
{
  "cloudProviders": [...],   // OpenAI、Anthropic、Gemini API 模型
  "localProviders": [...]    // 带下载地址的 GGUF 模型
}
```

**关键文件:**

- `src/models/modelRegistryData.json` - 所有模型的唯一事实来源
- `src/models/ModelRegistry.ts` - 带辅助方法的 TypeScript 封装
- `src/config/aiProvidersConfig.ts` - 从注册表派生 AI_MODES
- `src/utils/languages.ts` - 从注册表派生 REASONING_PROVIDERS
- `src/helpers/modelManagerBridge.js` - 处理本地模型下载

**本地模型特性:**

- 每个模型带 `hfRepo` 字段，用于拼装 HuggingFace 直链
- `promptTemplate` 定义对话格式（ChatML、Llama、Mistral）
- 下载地址构造规则：`{baseUrl}/{hfRepo}/resolve/main/{fileName}`

### 9. API 集成与更新

**OpenAI Responses API（2025 年 9 月）**:

- 从 Chat Completions 迁移到新的 Responses API
- 端点：`https://api.openai.com/v1/responses`
- 请求格式简化：用 `input` 数组替代 `messages`
- 新响应格式：`output` 数组包含带类型的条目
- 自动处理 GPT-5 与 o 系列模型的特殊要求
- 新模型（GPT-5、o 系列）不传 temperature 参数

**Anthropic 集成**:

- 经 IPC 处理器转发，规避渲染进程的 CORS 问题
- 主进程发起 API 调用，带完善错误处理
- 模型 ID 使用别名格式（如 `Codex-sonnet-4-6`，而非带日期后缀的版本）

**Gemini 集成**:

- 渲染进程直连 API
- 提高 Gemini 3.1 Pro 的 token 下限（最少 2000）
- 正确处理响应中的思考过程
- 处理 MAX_TOKENS 结束原因的错误

**API Key 持久化**:

- 所有 API key 正确持久化到 `.env`
- key 存于环境变量，应用启动时重新加载
- 集中的 `saveAllKeysToEnvFile()` 方法保证一致性

### 10. 系统设置集成

应用可打开 OS 级设置的麦克风权限、声音输入选择与辅助功能：

**IPC 处理器**（`ipcHandlers.js`）:

- `open-microphone-settings`: 打开麦克风隐私设置
- `open-sound-input-settings`: 打开声音/音频输入设备设置
- `open-accessibility-settings`: 打开辅助功能隐私设置（仅 macOS）

**平台专用 URL**:
| 平台 | 麦克风隐私 | 声音输入 | 辅助功能 |
|----------|-------------------|-------------|---------------|
| macOS | `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` | `x-apple.systempreferences:com.apple.preference.sound?input` | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` |
| Windows | `ms-settings:privacy-microphone` | `ms-settings:sound` | N/A |
| Linux | 手动（无 URL scheme） | 手动（如 pavucontrol） | N/A |

**UI 组件**（`MicPermissionWarning.tsx`）:

- 按平台显示对应的按钮与文案
- Linux 只显示"打开声音设置"（没有独立的隐私设置）
- macOS/Windows 同时显示声音与隐私按钮

### 11. 调试模式

以 `--log-level=debug` 或 `SUPERTING_LOG_LEVEL=debug` 启用（可写入 `.env`）：

- 日志保存到平台相关的应用数据目录
- 完整记录音频管线
- FFmpeg 路径解析细节
- 音频电平分析
- 完整推理管线调试，逐阶段日志

### 12. Windows Push-to-Talk

基于低级键盘钩子的 Windows 原生按住说话支持：

**架构**:

- `resources/windows-key-listener.c`: 使用 Windows `SetWindowsHookEx` 的原生 C 程序
- `src/helpers/windowsKeyManager.js`: 拉起并管理原生二进制的 Node.js 封装
- 目标键按下/松开时二进制向 stdout 输出 `KEY_DOWN` / `KEY_UP`

**组合快捷键支持**:

- 解析 `CommandOrControl+Shift+F11` 之类的快捷键字符串
- 修饰键映射：`CommandOrControl`/`Ctrl` → VK_CONTROL，`Alt`/`Option` → VK_MENU，`Shift` → VK_SHIFT
- 发出按键事件前校验所有必需修饰键处于按下状态

**二进制分发**:

- 预编译二进制从 GitHub releases 下载（`windows-key-listener-v*` tag）
- 下载脚本：`scripts/download-windows-key-listener.js`
- CI workflow：`.github/workflows/build-windows-key-listener.yml`
- 二进制不可用时回退点按模式

**IPC 事件**:

- `windows-key-listener:key-down`: 快捷键按下时触发（开始录音）
- `windows-key-listener:key-up`: 快捷键松开时触发（停止录音）

### 13. 自定义词典

提升特定词汇、人名或术语的转写准确率：

**工作方式**:

- 用户经 设置 → Custom Dictionary 添加词组
- 词组以 JSON 数组存于 localStorage（`customDictionary` 键）
- 转写时词组拼接后作为 `prompt` 参数传给 Whisper
- 本地 whisper.cpp 与云端 OpenAI Whisper API 均生效

**实现**:

- `src/hooks/useSettings.ts`: 管理 `customDictionary` 状态
- `src/components/SettingsPage.tsx`: 词典增删 UI
- `src/helpers/audioManager.js`: 读取词典并加入转写选项
- `src/helpers/whisperServer.js`: 将词典作为 `prompt` 放入 API 请求

**Whisper prompt 参数**:

- Whisper 将 prompt 作为转写的上下文/提示
- prompt 中的词更容易被正确识别
- 适用场景：生僻人名、行业术语、品牌名、领域专有词

### 14. GNOME Wayland 全局快捷键

在 GNOME Wayland 上，受 Wayland 安全模型限制，Electron 的 `globalShortcut` API 无法工作。SuperTing 改用 GNOME 原生快捷键：

**架构**:

1. `main.js` 为 Wayland 启用 `GlobalShortcutsPortal` feature flag
2. `hotkeyManager.js` 检测 GNOME + Wayland 并初始化 `GnomeShortcutManager`
3. `gnomeShortcut.js` 创建 D-Bus 服务 `com.sysusugan.SuperTing`
4. 快捷键经 `gsettings` 注册为 GNOME 自定义键绑定
5. GNOME 触发 `dbus-send` 命令，调用 D-Bus 的 `Toggle()` 方法

**关键常量**:

- D-Bus 服务：`com.sysusugan.SuperTing`
- D-Bus 路径：`/com/superting/App`
- gsettings 路径：`/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/superting/`

**IPC 集成**:

- `get-hotkey-mode-info`: 向渲染进程返回 `{ isUsingGnome, isUsingHyprland, isUsingNativeShortcut }`
- `isUsingNativeShortcut` 为 true 时 UI 隐藏激活模式选择器
- 强制 tap-to-talk 模式（不支持 push-to-talk）

**快捷键格式转换**:

- Electron 格式：`Alt+R`、`CommandOrControl+Shift+Space`
- GNOME 格式：`<Alt>r`、`<Control><Shift>space`
- 反引号（`）→ GNOME keysym 格式的 `grave`

### 15. Hyprland Wayland 全局快捷键

在 Hyprland（wlroots Wayland 合成器）上，Electron 的 `globalShortcut` API 与 `GlobalShortcutsPortal` feature 都不可靠。SuperTing 改用 Hyprland 原生键绑定：

**架构**:

1. `main.js` 为 Wayland 启用 `GlobalShortcutsPortal` feature flag（回退）
2. `hotkeyManager.js` 检测 Hyprland + Wayland 并初始化 `HyprlandShortcutManager`
3. `hyprlandShortcut.js` 创建 D-Bus 服务 `com.sysusugan.SuperTing`（与 GNOME 相同）
4. 快捷键经 `hyprctl keyword bind` 注册（运行时键绑定）
5. Hyprland 触发 `dbus-send` 命令，调用 D-Bus 的 `Toggle()` 方法

**检测**:

- 主要：`HYPRLAND_INSTANCE_SIGNATURE` 环境变量（Hyprland 设置）
- 回退：`XDG_CURRENT_DESKTOP` 含 "hyprland"

**快捷键格式转换**:

- Electron 格式：`Alt+R`、`CommandOrControl+Shift+Space`
- Hyprland 格式：`ALT, R`、`CTRL SHIFT, space`
- 纯修饰键组合（如 `Control+Super`）→ `CTRL, Super_L`

**绑定/解绑命令**:

- 注册：`hyprctl keyword bind "ALT, R, exec, dbus-send --session ..."`
- 解绑：`hyprctl keyword unbind "ALT, R"`
- 绑定是临时的（Hyprland 重启后失效），但应用启动时会重新注册

**限制**:

- 不支持 push-to-talk（Hyprland `bind` 只触发单次 exec，没有 key-down/key-up）
- 需要 PATH 上有 `hyprctl`（Hyprland 自带）

### 16. 会议检测（事件驱动）

由 `MeetingDetectionEngine` 统一编排，经三个独立来源检测会议：

**架构**:

- `MeetingDetectionEngine` 监听 `MeetingProcessDetector` 与 `AudioActivityDetector` 的事件
- `GoogleCalendarManager` 提供日历上下文（即将开始的会议、进行中的会议）
- 三个来源汇入统一的通知管线

**进程检测**（已知会议应用 — Zoom、Teams、Webex、FaceTime）:

- macOS: `systemPreferences.subscribeWorkspaceNotification` — 零 CPU，即时检测
- Windows/Linux: `processListCache` 共享轮询（30 秒间隔，`ps-list` npm 包）

**麦克风检测**（计划外/浏览器会议，如 Google Meet）:

- macOS: `macos-mic-listener` 二进制 — CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` 属性监听器，支持热插拔
- Windows: `windows-mic-listener.exe` — WASAPI `IAudioSessionManager2` 会话监视，`--exclude-pid` 排除自身麦克风
- Linux: `pactl subscribe` — PulseAudio source-output 事件
- 全平台：原生二进制/命令不可用时优雅回退到轮询

**UX 规则**:

- 录音期间（tap-to-talk 或 push-to-talk）：屏蔽所有通知
- 录音结束后：2.5 秒冷却再展示排队通知
- 多信号合并：进程 > 音频优先级，只显示一条通知
- 日历感知：存在即将开始的日历事件时，通知显示事件名
- 正在录制日历会议：屏蔽所有检测

**二进制分发**:

- macOS: `compile:native` 期间经 `scripts/build-macos-mic-listener.js` 从 Swift 源码编译
- Windows: `prebuild:win` 期间经 `scripts/download-windows-mic-listener.js` 下载预编译二进制
- CI workflow：`.github/workflows/build-windows-mic-listener.yml` 在 push 到 main 时自动构建

**日历同步韧性**:

- 所有 Google Calendar API 请求 10 秒 socket 超时
- 连续失败指数退避：2 分钟 → 4 分钟 → 8 分钟，上限 30 分钟
- 任一次成功同步即恢复正常 2 分钟间隔

## 开发规范

### Git 工作流

- 任何任务性代码修改、提交、构建或测试驱动实现之前，必须先过 worktree 闸门：
  1. 运行 `git worktree list --porcelain`。
  2. 在当前工作区运行 `git status --short --branch`。
  3. 如果当前工作区是主 `main` 检出，停下，先创建或切换到专用的干净 worktree 再动手。
  4. 严禁直接在 `main` 上做任务改动，除非用户明确说："允许直接在 main 上修改"。
  5. 如果 `main` 有未提交改动，或领先/落后 `origin/main`，停下，先报告状态再继续。
  6. 在第一次回复中、动手修改之前，声明选定的 worktree 路径与分支。
  7. 如果违反本闸门，立即停止，报告违规，并提出恢复方案后再继续。
- 所有提交必须符合 DCO。使用 `git commit -s` 或以其他方式带上有效的 `Signed-off-by:` trailer。
- 创建或修改提交前，在相关时核实 DCO 合规。
- 合入 `main` 只用 rebase merge。除非用户明确批准，不得使用 squash merge 或 merge commit。
- 创建新 worktree 前，先列出现有 worktree，优先选择干净的、明确闲置/空闲的 worktree。只有当 worktree 干净、且处于 detached 状态、已批准的可复用分支、或被用户明确标记为空闲时才可复用。未经确认不得复用以任务命名的分支。
- 复用闲置 worktree 时，先确认该 worktree 干净。基于 `main` 开展工作前，检查本地 `main` 检出：若 `main` 有未提交改动或未推送/未处理的本地提交，停下，请用户先处理 `main`。本地 `main` 干净且最新后，工作分支基于最新本地 `main` 创建。不得覆盖脏的或状态未知的 worktree 改动。

### 国际化（i18n）— 必须遵守

所有面向用户的文案**必须**走 i18n 系统。严禁在组件中硬编码 UI 文本。

**配置**: react-i18next（v15）+ i18next（v25）。翻译文件在 `src/locales/{lang}/translation.json`。

**支持语言**: en、es、fr、de、pt、it、ru、zh-CN、zh-TW

**用法**:

```tsx
import { useTranslation } from "react-i18next";

const { t } = useTranslation();
// 简单用法: t("notes.list.title")
// 带插值: t("notes.upload.using", { model: "Whisper" })
```

**规则**:

1. 每个新 UI 文案都必须在 `en/translation.json` 及所有其他语言文件中有对应 key
2. 组件与 hooks 中使用 `useTranslation()` hook
3. 动态值保持 `{{variable}}` 插值语法
4. 不翻译：品牌名（SuperTing、Pro）、技术术语（Markdown、Signal ID）、格式名（MP3、WAV）、AI system prompt
5. key 按功能域分组（如 `notes.editor.*`、`referral.toasts.*`）

### 新增功能

1. **新 IPC 通道**: 同时加到 ipcHandlers.js 和 preload.js
2. **新设置**: 更新 useSettings.ts 和 SettingsPage.tsx
3. **新 UI 组件**: 遵循 src/components/ui 中的 shadcn/ui 模式
4. **新管理器**: 在 src/helpers/ 中创建，在 main.js 中初始化
5. **新 UI 文案**: 向全部 10 个语言文件添加翻译 key（见上文 i18n 一节）
6. **新 Sidecar 二进制**: 在 `scripts/` 加下载脚本，加进 package.json 的 `prebuild*` 脚本，在 `src/helpers/` 加管理器，在 `main.js` 初始化。Unix 上以 `detached: process.platform !== "win32"` 拉起子进程，使其拥有独立进程组。spawn 后立即调用 `sidecarPidFile.write(name, child.pid)`，`close` 时调用 `sidecarPidFile.clear(name)`。把二进制名片段加入 `sidecarReaper.js` 的 `EXPECTED_BINARY_FRAGMENTS`。在 `registerSidecars()` 中经 `sidecarRegistry.register(name, () => manager.stop())` 注册停止函数 — 这一行注册取代旧的 `will-quit` 写法。

### 测试清单

- [ ] 本地与云端两种处理模式都要测
- [ ] 验证快捷键全局可用
- [ ] 全平台检查剪贴板粘贴
- [ ] 用不同音频输入设备测试
- [ ] 验证 whisper.cpp 二进制检测
- [ ] 测试所有 Whisper 模型
- [ ] 检查 agent 命名功能
- [ ] 用生僻词测试自定义词典
- [ ] 用组合快捷键验证 Windows Push-to-Talk
- [ ] 测试 GNOME Wayland 快捷键（GNOME + Wayland 环境）
- [ ] 测试 Hyprland Wayland 快捷键（Hyprland + Wayland 环境）
- [ ] 验证 GNOME Wayland 与 Hyprland Wayland 下激活模式选择器被隐藏
- [ ] 验证会议检测事件驱动模式生效（在调试日志中查 "event-driven"）
- [ ] 测试录音期间的会议通知屏蔽
- [ ] 测试录音后冷却（通知不应立刻闪现）
- [ ] 创建一篇关于"季度营收预测"的笔记，用 agent 搜索"财务预测" — 应语义命中
- [ ] 验证应用启动时 Qdrant 拉起（在调试日志中查 "qdrant started successfully"）
- [ ] 手动杀掉 Qdrant 进程 — 验证 FTS5 关键词搜索仍可作为回退

### 常见问题与解决

1. **检测不到音频**:
   - 检查 FFmpeg 路径解析
   - 核实麦克风权限
   - 查看调试日志中的音频电平

2. **转写失败**:
   - 确认 whisper.cpp 二进制可用
   - 确认模型已下载
   - 检查临时文件创建
   - 确认 FFmpeg 可执行

3. **剪贴板不可用**:
   - macOS: 检查辅助功能权限（AppleScript 粘贴必需）
   - Linux: 优先尝试原生 `linux-fast-paste` 二进制（XTest），对 X11 与 XWayland 应用有效
     - X11: 原生二进制不可用时回退 xdotool
     - GNOME/KDE Wayland: xdotool（XWayland 应用）→ ydotool（需要 ydotoold 守护进程）
     - wlroots Wayland（Sway、Hyprland）: wtype → xdotool → ydotool
   - Windows: PowerShell SendKeys（内置）或 nircmd.exe（打包内置）

4. **构建问题**:
   - 未签名构建用 `npm run pack`（CSC_IDENTITY_AUTO_DISCOVERY=false）
   - 签名需要 Apple Developer 账号
   - FFmpeg 需要 ASAR unpack
   - 打包前（当前平台）先运行 `npm run download:whisper-cpp`
   - 多平台打包用 `npm run download:whisper-cpp:all`
   - CSC_IDENTITY_AUTO_DISCOVERY=false 时 afterSign.js 自动跳过签名
   - **Lockfile**: 运行 `npm install` 必须用 Node 24（与 CI 一致）。本地 Node 版本不同时，用 `nvm exec 24 npm install`。用其他大版本运行 `npm install` 会生成不兼容的 `package-lock.json`，破坏 CI 的 `npm ci`。

5. **Windows Push-to-Talk 二进制**:
   - Windows 构建期间自动下载预编译二进制
   - 下载失败时按住说话回退为点按模式
   - 本地编译：安装 Visual Studio Build Tools 或 MinGW-w64
   - CI workflow（`.github/workflows/build-windows-key-listener.yml`）在 push 到 main 时自动构建

6. **会议检测不工作**:
   - 在调试日志中区分 "event-driven" 与 "polling" 模式
   - macOS: 确认 `resources/bin/` 中存在 `macos-mic-listener` 二进制（`npm run compile:native` 期间编译）
   - Windows: 确认 `resources/bin/` 中存在 `windows-mic-listener.exe`（`prebuild:win` 期间下载）
   - Linux: 确认已安装 `pactl`（`pulseaudio-utils` 或 `pipewire-pulse` 包）
   - 事件驱动二进制缺失时，检测自动回退到轮询

7. **本地语义搜索不工作**:
   - Qdrant 二进制应位于 `resources/bin/qdrant-{platform}-{arch}`（`predev`/`prebuild` 期间自动下载）
   - 嵌入模型应位于 `~/.cache/superting/embedding-models/all-MiniLM-L6-v2/model.onnx`（首次启动应用自动下载）
   - 缺失时手动运行 `npm run download:qdrant` 与 `npm run download:embedding-model`
   - 在调试日志中查 "qdrant" 条目（端口、健康检查、错误）
   - Qdrant 启动失败时，搜索仍可经 FTS5 关键词回退
   - 语义搜索仅通过 AI agent 的 `search_notes` 工具提供，手动搜索 UI 不使用

### 平台注意事项

**macOS**:

- 剪贴板（自动粘贴）需要辅助功能权限
- 需要麦克风权限（系统弹窗）
- 使用 AppleScript 实现可靠粘贴
- 分发需要公证
- 运行时在 Dock 显示指示点（LSUIElement: false）
- whisper.cpp 同时打包 arm64 与 x64
- 系统设置可经 `x-apple.systempreferences:` URL scheme 打开

**Windows**:

- 无需特殊辅助功能权限
- 麦克风隐私设置在 `ms-settings:privacy-microphone`
- 声音设置在 `ms-settings:sound`
- 分发用 NSIS 安装包
- whisper.cpp 打包 x64
- **Push-to-Talk**: 原生按键监听器二进制（`windows-key-listener.exe`）实现真正的按住说话
  - 使用 Windows 低级键盘钩子（`WH_KEYBOARD_LL`）
  - 支持组合快捷键（如 `Ctrl+Shift+F11`）
  - 预编译二进制从 GitHub releases 自动下载
  - 不可用时回退点按模式

**Linux**:

- 支持多种包管理器
- 标准 XDG 目录
- 分发用 AppImage
- whisper.cpp 打包 x64
- 系统设置无标准 URL scheme（用户需手动打开）
- UI 隐藏隐私设置按钮（Linux 不适用）
- 音频设备管理推荐 `pavucontrol`
- **剪贴板粘贴工具**（自动粘贴至少需要其一）:
  - **X11**: `xdotool`（推荐）
  - **Wayland**（非 GNOME）: `wtype`（需要虚拟键盘协议）或 `xdotool`（经 XWayland 生效，Electron 应用推荐）
  - **GNOME Wayland**: 仅 XWayland 应用可用 `xdotool`（原生 Wayland 应用需手动粘贴）
  - 终端检测: 自动识别终端模拟器并使用 Ctrl+Shift+V
  - 回退: 文本复制到剪贴板，并提示手动粘贴
- **GNOME Wayland 全局快捷键**:
  - 经 D-Bus 与 gsettings 使用 GNOME 原生快捷键（无需特殊权限）
  - 快捷键在 GNOME 设置 → 键盘 → 快捷键 → 自定义中可见
  - 默认快捷键：`Alt+R`（不支持反引号）
  - push-to-talk 不可用（GNOME 快捷键只触发单次 toggle 事件）
  - GNOME 集成失败时回退 X11/globalShortcut
  - D-Bus 通信使用 `dbus-next` npm 包

## 代码风格与约定

- 新 React 组件使用 TypeScript
- 遵循 helpers/ 中的既有模式
- 面向用户的错误信息要有描述性
- 完善的调试日志
- 清理资源（文件、监听器）
- 优雅处理边界情况

## 性能考量

- Whisper 模型大小与速度的权衡
- IPC 的音频 blob 大小上限（10MB）
- 临时文件清理
- 大模型的内存占用
- 进程超时保护（5 分钟）
- 会议检测使用事件驱动的 OS API（近零 CPU），以轮询兜底
- 检测器间共享进程列表缓存，避免重复 `tasklist`/`pgrep` 调用
- Google 日历同步使用指数退避，避免网络故障时打爆 API

## 安全考量

- API key 与企业云凭据（共 12 个机密）经 Electron `safeStorage` 静态加密 → OS 钥匙链（Keychain / DPAPI / libsecret），按 key 存于 `userData/secure-keys/`。Linux 无钥匙环时退化为明文（Electron 默认）。已在 #629 关闭。
- 启用 context isolation
- 无远程代码执行
- 文件路径净化
- 限定 IPC 暴露面

## 未来可考虑的增强

- 流式转写支持
- 自定义唤醒词检测
- ~~多语言 UI~~（已实现 — 经 react-i18next 支持 9 种语言）
- 云端模型选择
- 批量转写
- 剪贴板之外的导出格式
