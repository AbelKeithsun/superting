# FunASR（SenseVoice）本地转写引擎使用说明

SuperTing 内置了第三个本地转写引擎：**FunASR**（引擎 ID 为 `funasr`），底层使用阿里达摩院开源的
**SenseVoice-Small** 模型（经 sherpa-onnx 的 ONNX 运行时推理），中文识别准确率与标点恢复效果出色，
是中文用户的推荐本地引擎。

与其他两个本地引擎的关系：

| 引擎 | provider 值 | 模型 | 强项 |
|---|---|---|---|
| whisper.cpp | `whisper`（默认） | GGML Whisper 系列 | 多语言（58 种）、生态成熟 |
| NVIDIA Parakeet | `nvidia` | parakeet-tdt-0.6b-v3 | 英文极强 |
| **FunASR** | `funasr` | **SenseVoice-Small（int8）** | **中文/中英混说、标点、数字规整（ITN）** |

三个引擎完全本地运行，音频不会离开你的设备。

## 快速开始

1. 打开设置 → 转录设置（或首次启动引导页）。
2. 本地引擎选择 **FunASR** 标签页。
3. 点击下载 **SenseVoice-Small** 模型（约 228 MB，int8 量化版）。
4. 下载完成后即可在热键听写、音频文件上传、口述预览、会议录音四条路径中使用 FunASR。

> 下载源默认走 `hf-mirror.com`（国内可达），失败时自动回退 GitHub Release / gh-proxy / HuggingFace 官方，
> 共四级回退，无需科学上网一般也能完成下载。

## 支持语言

SenseVoice-Small 原生支持：**中文（普通话）、英语、日语、韩语、粤语**，并带：

- **标点恢复**（中文逗号/句号直接可用）
- **ITN 逆文本规整**：把「二零二六年九月十一日」自动转成「2026年9月11日」（默认开启，可在设置中关闭）
- 语言选择支持 `auto` 自动检测

不在上述语言列表内的语种（如法语、德语）请继续使用 whisper 引擎。

## 工作原理

```text
录音 / 音频文件
   │  FFmpeg 统一转 16kHz 单声道
   v
funasrServer（主进程）
   │  ① RMS 静音短路（纯静音片段直接跳过）
   │  ② 30 秒窗口切分（远低于 ws-server 300 秒上限）
   v
sherpa-onnx-ws-{platform}-{arch}（本地 sidecar 进程，端口 6030–6053）
   │  --sense-voice-model=model.int8.onnx
   │  --tokens=tokens.txt --sense-voice-use-itn=true
   v
逐窗口识别 → 拼接文本 →（可选）AI 清洗/纪要
```

- 复用 SuperTing 已打包的 sherpa-onnx 二进制，**不引入 Python、不新增任何原生依赖**。
- sidecar 进程由 `sidecarPidFile` + `sidecarReaper` 托管，应用退出自动回收。
- 除文本外，引擎还返回 `lang / emotion / event / timestamps` 元数据（`<|...|>` 标签已在应用层剥离），
  供后续纪要增强使用。

## 环境要求

- 与 SuperTing 主程序一致（macOS 13+ / Windows 10+ / Linux x64·arm64），无额外要求。
- 磁盘：模型约 230 MB，下载时建议预留 600 MB 临时空间。
- 内存：int8 模型推理峰值约 500 MB，4 GB 以上内存机器均可流畅运行。

## 从源码运行

```bash
npm install            # Node 24（见 .nvmrc）
npm run dev            # 开发模式
```

在应用内按「快速开始」下载模型即可。如需命令行预先下载到用户缓存目录：

```bash
# 模型缓存目录（所有平台）
#   macOS/Linux: ~/.cache/superting/funasr-models/sensevoice-small/
#   Windows:     %LOCALAPPDATA%\superting\funasr-models\sensevoice-small\
```

目录下两个文件齐备且 `model.int8.onnx ≥ 200 MB` 即视为安装完成：

```text
sensevoice-small/
├── model.int8.onnx   # 228 MB
└── tokens.txt        # 312 KB
```

## 手动验证引擎（可选）

```bash
# 直接启动 sidecar 二进制（路径见 resources/bin/）
./resources/bin/sherpa-onnx-ws-darwin-arm64 \
  --sense-voice-model=~/.cache/superting/funasr-models/sensevoice-small/model.int8.onnx \
  --tokens=~/.cache/superting/funasr-models/sensevoice-small/tokens.txt \
  --sense-voice-language=auto --sense-voice-use-itn=true --port=6099
# 看到 "Listening on: 6099" 即启动成功
```

WebSocket 协议：发送 `[int32LE 采样率][int32LE 字节数][float32 PCM 样本]`，服务端先回 `Done`
再回 JSON 结果（`text` 字段即转写文本）。

## 故障排查

| 现象 | 处理 |
|---|---|
| 模型下载到一半失败 | 重新点击下载会先清理残留文件；也可切换网络后重试，四级下载源会自动回退 |
| 下载极慢 | 默认主源 hf-mirror 已是国内直连；如自定义过代理可检查环境变量 |
| 转写无结果 | 检查系统麦克风权限；纯静音会被 RMS 短路并提示「未检测到音频」 |
| 切换引擎后行为不对 | 设置页重新选择一次引擎并重启应用；`.env` 中 `LOCAL_TRANSCRIPTION_PROVIDER` 与 `FUNASR_MODEL` 互斥生效 |
| sidecar 端口冲突 | FunASR 固定使用 6030–6053 端口段，与 Parakeet（6006–6029）不冲突；如被占用会自动顺延 |

诊断信息可在设置 → 转录设置 → FunASR 引擎的「诊断」入口查看（二进制、模型、端口、进程状态）。

## 已知限制（v1）

- **长音频按 30 秒固定窗口切分**，边界处偶有词被截断（计划中的 v1.1 将引入应用侧 silero VAD 平滑切分）。
- 情感/事件元数据已解析但暂未在 UI 展示。
- 非中英日韩粤语种精度会退化，请按语言选择引擎。

## 隐私

FunASR 路径与其他本地引擎一致：音频仅在本地 sidecar 进程内推理，不出网、不留云端副本；
模型文件下载自公共 release，之后完全离线运行。

## 致谢与许可

- [FunASR](https://github.com/modelscope/FunASR)（Apache-2.0）与 SenseVoice-Small 模型（阿里达摩院，Apache-2.0）
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0）提供 ONNX 推理与 WebSocket 服务
- 模型目录结构与下载端点设计参考了 [SmartSub](https://github.com/jaaa7/SmartSub)（MIT, Copyright (c) 2024 Lin Xiaodong）
