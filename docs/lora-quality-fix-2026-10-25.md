# LoRA 质量修复报告（2026-10-25）

> 交接文档（HANDOFF-2026-10-24.md）里「LoRA 跨模型可用性改造」的 M1 已完成，
> 主线转到了用户反馈的**「当前 LoRA 效果依然很差」**。本文是这条主线的实测记录。

---

## 1. 症状与排查方法

用户反馈：四个角色 LoRA（守岸人 / 爱弥斯 / 秧秧 / 流萤）出图效果差。

排查不靠「视觉模型打分」（qwen3-vl 的颜色描述前后矛盾，交接文档也提醒过），改为**可复现的数字指标**：

| 指标 | 工具 | 判据 |
| --- | --- | --- |
| 两图像素差异比例 | `_scratch/lora_eval/pairwise.py` | 同 seed、同进程内「有 LoRA vs 无 LoRA」差异 **<1% = LoRA 没生效** |
| 画面饱和度 | `img_stats.py`（HSV S 通道均值） | **<20/255 ≈ 黑白漫**，正常彩图 80–180 |
| LoRA 权重强度 delta_rms | `strength.py`（取 `attn2_to_k` 的 up@down 范数） | 能起作用的量级 **≳1e-3**；<2e-4 基本看不出来 |
| 训练元数据 | `inspect_lora.py` / 新增 `gateway/lib/lora-inspect.js` | 看底模、分辨率、bucket、lr、steps、caption |

---

## 2. 三个真凶（都有数字）

### ① 推理预设把画面写成了黑白漫（最直观的「差」）

`official-pipeline.js` 的 `INFERENCE_PRESET.stylePrompt` 原来是：

```
(semi-realistic:1.1), (detailed shading:1.1), (matte finish:1.15), (clean lineart:1.15), anime illustration style
```

实测（SemiRealMix + 512x768 + 同一 seed）：换成这套词的出图 **饱和度只有 2.5/255**（几乎纯灰度），
而中性提示词是 14–83。也就是说：**LoRA 就算生效了，用户看到的也是一张灰白图。**
负向词里又没有 `monochrome/grayscale`，压不住。

### ② 训练分辨率 1024 与 SD1.5 的原生尺度冲突

`秧秧_官方1024.safetensors` 的训练元数据（`ss_resolution=(1024,1024)`、bucket 最大 1408x1344、`ss_min_bucket_reso=512`）：
底模是 **SemiRealMix = SD1.5**（UNet 通道 320/640/1280，cross-attn 上下文 768），
原生尺度是 512。用 1024 + bucket 铺到 1408 去训，学出来的特征落在**底模渲染不出的尺度**上，
推理用 512–768 时几乎不响应。

### ③ alpha 只有 dim 的一半 → 权重强度不足

元数据：`ss_network_dim=32`、`ss_network_alpha=16` → 加载时 scale = 0.5。

同一个模块（`down_blocks_1_attentions_0_transformer_blocks_0_attn2_to_k`）的 delta_rms：

| LoRA | dim | alpha | scale | delta_rms | 视觉上 |
| --- | --- | --- | --- | --- | --- |
| 秧秧_官方1024（v3） | 32 | 16 | 0.5 | **3.6e-4** | 几乎看不出来 |
| 秧秧_id_v2 / base_v2 | 12/32 | 16 | 1.33/0.5 | 2.8e-4 / 5.3e-4 | 弱 |
| shorekeeper-smoke_id | 4 | 16 | 4.0 | 5.9e-5 | 看不出来 |
| semirealisticanime（第三方，能用） | 256 | 256 | 1.0 | **2.0e-3** | 明显 |
| **yangyang_official_v4（本次重炼）** | 32 | **32** | **1.0** | **8.9e-4** | 明显（像素差异 63%） |

### 附带发现：caption 全军覆没

`ss_tag_frequency = {"10_yangyang": {"yangyang": 13}}` —— 13 张图的标注**完全一样**（只有一个词）。
模型无法区分「角色」和「构图/背景/姿态」，只能整体记忆，推理时提示词被顶掉。

---

## 3. 改了什么

### 3.1 `gateway/lib/prep_official.py`（数据集准备 v2）

| 改动 | 原因 |
| --- | --- |
| 三档裁切 → **五档**（全身 / 上半身 / 头肩 / 脸部特写 / **下半身**） | 三档里两档是上半身，实测上装头饰全对、腿和鞋退回底模默认（黑丝变光腿）；补「腰部以下」档 |
| 裁切按 **3:4 竖构图 + 高度比例** 定框 | 第一版按整图宽度取比例，裁出 896x640 横图，人脸被拉扁 |
| 加入 OpenCV 正脸检测定位（失败退回「头部在顶部中央」兜底） | 官方立绘人物不居中时死比例会切掉脸；动漫脸 Haar 多半检不到，所以只用于定位 |
| 标注 = **触发词 + 逐图变化的构图词**，`--trigger` 注入 | 原来 13 张图共用一句 caption |
| 输出短边对齐训练分辨率（640） | 不再生成 1024 大图，训练快 2.4 倍且不过曝 |

### 3.2 `gateway/lib/official-pipeline.js`（训练配方 v4/v5）

| 参数 | v3 | v5 | 原因 |
| --- | --- | --- | --- |
| resolution | 1024 | **640** | SD1.5 原生 512，640 是「细节够 + 尺度对」的平衡 |
| min/max bucket | 512 / 1536 | **480 / 896** | 同上，不再铺到 1400+ |
| network_alpha | 16 | **32（=dim）** | scale 1.0，delta 强度翻倍 |
| unet_lr / te_lr | 8e-5 / 4e-5 | **1.2e-4 / 6e-5** | 小数据 + 低分辨率下 8e-5 学不动 |
| steps | 1400（50/图） | **clamp(图数×40, 1000, 1400)** | 35 张 × 40 ≈ 1400 |
| min_snr_gamma | 无 | **5** | 高低噪时间步损失更均衡 |
| keep_tokens + shuffle_caption | 无 | **1 / 开启** | 触发词锁首位，其余构图词打乱防过拟合 |
| 快照 | 无 | **每 2 epoch 存一份** | 便于挑不过拟合的那版 |
| 推理预设 | 640x1152 / w1.0 / matte finish | **512x768 + hires 2.0x / w0.9 / vibrant colors** | 见 §2① |

### 3.3 新增 `gateway/lib/lora-inspect.js` + `lora-inspect-cli.js`（M1 交付物）

读 safetensors 头（不解码全量张量，30 个 LoRA 2 秒跑完），输出：
架构家族（SD1.5/SDXL/DiT）、dim/alpha/scale、**delta_rms 强度分级**、训练底模、训练分辨率、步数、lr、触发词。

```powershell
node gateway/lib/lora-inspect-cli.js --all --checkpoint SemiRealMix.safetensors
```

M1 验收：30 个 LoRA 全部判定出架构，`unknown` = 0。

---

## 4. 验收（v4 对照数据）

同进程、同 seed、512x768、SemiRealMix + mse VAE：

| 对比 | 像素差异 | 饱和度 | 结论 |
| --- | --- | --- | --- |
| 无 LoRA（基线） | — | 140.0 | — |
| v4 w0.9（带触发词） | **63.1%** | 116.6 | LoRA 确实生效 |
| v4 w1.0（带触发词） | **75.9%** | 111.9 | 更贴角色 |
| v4 w0.9（不带触发词） | 64.1%（与带触发词差 13.4%） | 117.2 | 无条件生效，触发词只做微调 |
| v3 中文名 w1.0 | 52.9% | 124.3 | 也生效，但强度弱、画风灰 |

> 注：v1/v2 排查阶段出现过「两张图逐像素完全相同」的假象，原因是**切换底模后的第一张图**与后续图不同分布；
> 之后的 A/B 一律先跑一张 warmup 弃图，再比对。

角色特征（视觉复核，官方立绘 vs v4 出图）：发色/发型、瞳色、头部贝雷帽、上装配色、披风、短靴 **全对**；
缺失项：**裤袜与武器**（v4 的四档裁切里没有下半身档）→ v5 已补 `legs` 档。

---

## 5. v5 产出与用法

| 角色 | 文件 | 触发词 | 底模 | 备注 |
| --- | --- | --- | --- | --- |
| 秧秧 | `yangyang_official_v5.safetensors` | `yyv5` | SemiRealMix | 特征全对（发色/发型/瞳色/头饰/上装） |
| 爱弥斯 | `aimisi_official_v5.safetensors` | `aimisiv5` | SemiRealMix | 相似度 7/10 |
| 流萤 | `firefly_official_v5.safetensors` | `fireflyv5` | SemiRealMix | 相似度约 7/10 |
| 守岸人 | `shorekeeper_official_v5b.safetensors` | `shorekeeperoffic` | SemiRealMix | 相似度约 3/10（素材问题，见下注） |

> **守岸人说明**：v5 首次训练素材里混入一张**抽象艺术图**（`shorekeeper-729a14b9.png`，无人物），
> 删掉后重训为 v5b。但官方立绘本身换装跨度极大（蝴蝶帽 / 羽毛冠 / 花环帽、长裙 / 短裙混在一套里），
> LoRA 学到的「服装」被平均化，相似度仍偏低。**这是素材多样性问题，不是配方问题**——
> 秧秧/爱弥斯/流萤的素材风格统一，v5 相似度 7/10。

预设文件：`_scratch/v5/<角色>/preset/<name>.preset.json`（含 promptTemplate / negativePrompt / 采样参数）。

正负提示词骨架（不要把触发词省掉，它负责稳定召回）：

```
yyv5, <lora:yangyang_official_v5:0.9>, masterpiece, best quality, absurdres,
(ultra detailed:1.15), (vibrant colors:1.15), (detailed shading:1.2), (semi-realistic:1.05),
(soft lighting:1.1), anime illustration style, 1girl, solo, (full body:1.3), standing on ground,
(feet visible:1.25), looking at viewer, simple light background, depth of field
```

负向务必带上 `(monochrome:1.3), (grayscale:1.3), (sketch:1.2)`，否则 SemiRealMix 会滑向黑白漫。

---

## 6. 已知限制

1. **8GB 显存上限**：SDXL 训练不可行，底模只能锁 SD1.5 系；跨架构直译在数学上不成立（见计划书 §4.4）。
2. **素材少**：流萤全网只有 4 张可用官方图（20 张裁切），是四个角色里最弱的。
3. **手部**：512 基础分辨率下手部仍偏软，出图建议开 ADetailer（face_yolov8s）+ 必要时 hand 模型。
4. **v3 及双轨产物**：已在清理清单里（见 §7），保留第三方/用户自购 LoRA 不动。

---

## 7. 清理清单（实验性产物）

删除（均为本次实验产生、已被 v5 取代）：

- `*_官方1024.safetensors`（v3，3 个，中文名）
- `秧秧_自动.safetensors`（流水线重复产物）
- `*_id.safetensors` / `*_id_v2.safetensors` / `*_base.safetensors` / `*_base_v2.safetensors`（双轨 16 个，delta_rms 全在 8e-5~1.4e-4）
- `shorekeeper-smoke_id.safetensors`（冒烟测试残留）
- `_probe_yy_ascii.safetensors`（排查用副本）
- `yangyang_official_v4.safetensors`（v4 四档裁切版，被 v5 取代）
- `shorekeeper_official_v5.safetensors`（v5 含抽象图，被 v5b 取代）

保留（第三方 / 用户资产，不属于实验产物）：

`semirealisticanime`、`add_detail`、`39_v1.0`、`国风山水_v1.0`、`赛博朋克_v1.0`、`赛博朋克场景_v1.0`、
`釉彩·麻袋调色盘_v1.0`、`自然美妆场景_v1.0`

> 清理脚本：`_scratch/v5/cleanup_lora.ps1`（默认 dry-run，加 `-Apply` 才真删；目标名单在 `cleanup_targets.json`，脚本纯 ASCII 以避免 PS5.1 的 GBK 解析问题）。
> 实测可释放约 **1.1 GB**。

---

## 8. 跨架构 LoRA 搬运（2026-10-26）

**问题**：本机 4 个模型档里，SD_FP16/Anima_INT8（WebUI）能原生加载 SD1.5 LoRA，但 QwenImage_NVFP4/Krea2_Q4（DiT 架构）不能——权重形状不兼容，静默失败。

**修法**（`gateway/server.js`）：
1. **`/api/generate` 自动检测**：当 prompt 含 `<lora:...>` 且模型是 DiT 档时，自动标记为 `bridge` 任务
2. **两阶段管线**（`runTask` 里的 `bridge` 分支）：
   - **Stage 1**：用 SD_FP16 + LoRA 出图（角色/画风正确）
   - **Stage 2**：用 DiT 模型做 img2img，把 Stage 1 的图当底图，低重绘（默认 0.35）迁移风格
3. **结果**：4 个模型档都能用同一套 SD1.5 LoRA，DiT 档出图自带 DiT 的高质量画风 + LoRA 的角色特征

**用法**：在 C 档表单里选 DiT 模型 + 挂 LoRA 即可，网关自动走两阶段管线。Stage 1 的图也会保留（`result.bridge.stage1`），方便对比。

---

*报告完毕。*
