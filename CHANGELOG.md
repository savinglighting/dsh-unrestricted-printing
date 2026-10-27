# Changelog

## v0.0.1（2026-10-27：改名为 dsh-unrestricted-printing，独立仓库 + npm 首发测试版）

- **包名 / 仓库改名**：`dsh-sd-bridge-guard` → **`dsh-unrestricted-printing`**（目录、`package.json`、`cordis.patch.yml` 的 `name`、skill `source`、完整性检测的 raw 基址、发布脚本、README/INSTALL 全部同步，共 105 处）。
- **新地址**：仓库 <https://github.com/savinglighting/dsh-unrestricted-printing>，npm 包 `dsh-unrestricted-printing`。
- **版本号 0.0.1（测试版首发）**：功能基线直接承接旧包 v1.3.0 —— 十二件套工具、调度网关、一键炼制 LoRA（ID/Base 双轨解耦）、A 档 / C 档分流协议全部保留；`sd-bridge` 这个 cordis 组件 id 保持不变，已有 profile 配置无需改动。测试稳定后再按正常语义化版本推进。
- **CI 修正**：`publish-npm.yml` / `release.yml` 里的测试入口改到 `tests/` 目录（旧写法会找不到文件）。
- 功能行为与 v1.3.0 完全一致：十二件套工具、调度网关、一键炼制 LoRA（ID/Base 双轨解耦）、A 档 / C 档分流协议全部保留；`sd-bridge` 这个 cordis 组件 id 保持不变，已有 profile 配置无需改动。

## v1.3.0（2026-10-26：C 档 LoRA 真正跑通 —— 三个环境级根因）

用户反馈「还是用不了 lora，比如要一张守岸人的 C 档图，出来的是无关的人」。逐层排查后确认**不是 LoRA 质量差，是环境和链路三处断点**：

### ① SD WebUI 切模型必 500：CLIP tokenizer 找不到

**证据**（`sd_manual.log.err`）：
```
OSError: Can't load tokenizer for 'openai/clip-vit-large-patch14'
```
**根因**：tokenizer 缓存其实在 `D:\SD.4.8\.cache\huggingface`，但 **`HF_HOME` 环境变量没设**（为空），transformers 去默认的 `~/.cache/huggingface` 找不到 → 联网拉 → 网络不通 → 失败。
后果：**每次切 checkpoint / 重载权重都 500**，LoRA 根本没被加载，出的是内存里旧模型的残留脸。

**修法**：启动 SD 时注入
```
HF_HOME=D:\SD.4.8\.cache\huggingface
HUGGINGFACE_HUB_CACHE=D:\SD.4.8\.cache\huggingface\hub
TRANSFORMERS_OFFLINE=1
HF_HUB_OFFLINE=1
```

### ② 网关显存准入线把每一单都拦进队列

**证据**：`/api/generate` 返回 `admission: {admit:false, level:"block", vramFreeGb:0.24}`，任务永远 `queued`。
**根因**：8GB 卡常驻 SD 后剩余显存通常 0.2–1GB，而准入线是 **1.5GB** → 每单都被判定「显存不足」。

**修法**（`gateway.config.json`）：
```json
"vramMinFreeGb": 0.15,
"vramWarnFreeGb": 0.5,
"strictAdmission": false
```
只拦真正没显存的情况，其余交给 OOM 阶梯自愈。

### ③ 触发词权威性：kohya 的 `ss_tag_frequency` 记的是目录名，不是标注首词

**证据**：标注文件里写的是 `shorekeeperoffic, full body, ...`（正确），但 safetensors 头里 `ss_tag_frequency = {"10_shorekeeper_official_v6": {"shorekeeper_official_v6": 36}}` —— **记录的是 concept 目录名**。

**决定性对照**（同 seed / 同底模 / 同提示词，只改触发词）：

| 触发词 | 视觉模型相似度 |
| --- | --- |
| `shorekeeperoffic`（标注首词） | **9.5 / 10** |
| `shorekeeper_official_v6`（目录名） | **10 / 10** |
| 不写触发词 | **9 / 10** |

结论：三个都能召回，但**必须写一个**。新增 `resolveTrigger()` 统一权威值，`writePreset` 把触发词写进 `promptTemplate` 最前面。

### ④ 新增：触发词自动注入（`sd-inject.ps1`）

```powershell
function Get-LoraTrigger   # 从 safetensors 头读 ss_tag_frequency 第一个 token
```
表单选 LoRA 后**自动把触发词拼到 LoRA 片段前面**，用户不需要记触发词。

### 端到端验收

经网关 `/api/generate`（SD_FP16 + `shorekeeper_official_v6` + 触发词）：
- 出图成功：`gw_lora_ok_001_*.png`
- 视觉复核：「浅蓝长发、白蓝渐变短裙、蝶饰帽，**相似度 8/10**」
- 对比修复前：同样是守岸人提示词，出来的是无关角色（相似度 0–2）

### 顺带修好

- ComfyUI 的 `extra_model_paths.yaml` 中文注释乱码（PS 写入时按 GBK）→ 改纯 ASCII 注释，ComfyUI 现在能看到 **29 个 LoRA**（含 4 个 v6）。
- 网关入口是 `gateway/index.js`（不是 `server.js`），文档已更正。

### ⑤ 补充：`sd-direct.ps1` 的离线判定过严（2026-10-26 定位并修）

修好 ① 之后仍会偶发 500，深挖发现 `sd-direct.ps1` 要求 **CLIP 权重文件 >100MB** 才启用离线模式：

```powershell
# 旧逻辑
if ($w.Length -gt 100MB) { $clipWeightsOk = $true }
```

但本机缓存里只有 tokenizer 三件套（`vocab.json` / `merges.txt` / `tokenizer_config.json`），
那 1.7G 的 `pytorch_model.bin` **在 A1111 的加载路径里根本不读**（SD1.5 用 checkpoint 自带的 CLIP 权重）。
→ 判成「未命中」→ 联网 → 不通 → 切模型时 500。

**修法**：新增 `$clipTokenizerOk`（vocab.json + merges.txt 齐了就够），
离线条件从 `$clipWeightsOk` 放宽为 `($clipWeightsOk -or $clipTokenizerOk)`，并补上 `HUGGINGFACE_HUB_CACHE`。

**验证**：重启后日志显示「HF 环境: …（tokenizer 命中 → 离线加载）」，切模型 + 挂 LoRA 不再 500。

### 实测数据汇总（守岸人，同 seed / SemiRealMix / 512x768）

| 场景 | 结果 |
| --- | --- |
| 修复前（HF 500 / 准入拦截） | 出来是无关角色，相似度 0–2 |
| 修复后 · 经网关 SD_FP16 + LoRA + 触发词 | 浅蓝长发 + 白蓝渐变短裙 + 蝶饰帽，**相似度 8/10** |
| 三个触发词变体（标注首词 / 目录名 / 不写） | 9.5 / 10 / 9 —— 都能召回，但必须写一个 |

---

## v1.2.0（2026-10-25：LoRA 效果返修 —— 从「看不出效果」到「特征全对」）

用户反馈「当前 LoRA 效果依然很差」，排查后确认是**三个独立缺陷叠加**，全部用可复现的数字定位：

| # | 缺陷 | 证据 | 修法 |
| --- | --- | --- | --- |
| ① | 推理预设把画面写成黑白漫 | SemiRealMix + 旧 `stylePrompt`（matte finish / clean lineart）出图**饱和度 2.5/255**，中性提示词 83 | 画风词改彩色向 + 负向补 `monochrome/grayscale/sketch` |
| ② | SD1.5 用 1024 训练 | 元数据 `ss_resolution=(1024,1024)`、bucket 至 1408x1344，而底模原生 512 | 训练分辨率 → **640**，bucket 480–896 |
| ③ | alpha 只有 dim 一半 → 权重太弱 | `dim=32 alpha=16`（scale 0.5），`attn2_to_k` 的 delta_rms **3.6e-4**；能起作用的 LoRA 是 2e-3 | `alpha = dim = 32`（scale 1.0）+ unet lr 8e-5→1.2e-4 |
| 附 | caption 全军覆没 | `ss_tag_frequency={"10_yangyang":{"yangyang":13}}` —— 13 张图标注完全一样 | 标注改「触发词 + 逐图构图词」，`keep_tokens=1` |

### 新增

- **`gateway/lib/lora-inspect.js` + `lora-inspect-cli.js`（M1 交付）**：读 safetensors 头判定架构家族（SD1.5 / SDXL / DiT）、dim/alpha/scale、**delta_rms 强度分级**、训练底模/分辨率/步数/lr/触发词。
  `node gateway/lib/lora-inspect-cli.js --all --checkpoint SemiRealMix.safetensors` —— 30 个 LoRA 全部判定，`unknown` = 0。
- **数据集准备 v2（`prep_official.py`）**：三档 → **五档裁切**（全身/上半身/头肩/脸部特写/**下半身**），3:4 竖构图定框，OpenCV 正脸定位（动漫脸检不到时退回「头部在顶部中央」兜底），`--trigger` 注入触发词。
  修掉 v1 的两个裁切 bug：按整图宽度取比例会裁出 896x640 **横图**（人脸被拉扁）；下半身档起点太低会切掉腰臀（裙摆变成孤立布料）。
- **训练配方 v5**：`min_snr_gamma=5`、`keep_tokens=1 + shuffle_caption`、每 2 epoch 存快照、推理预设改 512x768 + hires 2.0x（R-ESRGAN Anime6B / denoise 0.4）。
- `docs/lora-quality-fix-2026-10-25.md`：完整实测记录（症状 / 三个真凶 / 改动 / 验收数字 / 已知限制）。

### 验收（同进程、同 seed、512x768）

| 对比 | 像素差异 | 饱和度 |
| --- | --- | --- |
| 无 LoRA 基线 | — | 140.0 |
| v4 w0.9（带触发词） | **63.1%** | 116.6 |
| v4 w1.0 | **75.9%** | 111.9 |
| v3 中文名 w1.0（旧） | 52.9% | 124.3（画风偏灰） |

角色特征复核：发色发型 / 瞳色 / 头部配饰 / 上装配色 / 披风 / 短靴 **全部对上**；v4 缺失的裤袜与武器由 v5 新增的 `legs` 档补齐。

### 排查中踩到的假象（记下来省下一次）

- 切换底模后的**第一张图**与后续图分布不同，用它做 A/B 会得出「两张图逐像素完全相同 = LoRA 没生效」的错误结论。之后的 A/B 一律先跑一张 warmup 弃图。

### C 档 LoRA 生效保障（2026-10-25 用户反馈「C 档生图没遵循我使用 lora 的指令」）

**根因**：C 档默认模型是 `QwenImage_NVFP4`（DiT 架构），而本机所有角色 LoRA 都是 **SD1.5** 的。
SD1.5 LoRA 的 UNet 权重（`down_blocks` / `attn2_to_k` shape `[320,768]`）与 DiT 架构完全不兼容——
网关虽会把 `<lora:name:weight>` 翻译成 ComfyUI 的 LoraLoader 节点，但权重形状对不上，**静默失败**（不出图、不报错）。

**修法**（`sd-inject.ps1` 5406-5418 行）：
- 检测正向提示词里是否含 `<lora:...>` 语法（用户手写的或画风档注入的）
- 或表单 LoRA 栏是否选了非「不用 LoRA」
- 若命中且当前模型是 DiT 档（QwenImage_NVFP4 / Krea2_Q4）→ **自动切到 SD_FP16**（WebUI 路由，A1111 原生解析 `<lora:...>`，SD1.5 LoRA 才能真正生效）
- 控制台打一行黄色提示说明为什么切

### 跨架构 LoRA 搬运管线（2026-10-26 用户要求「所有模型都能用同一套 LoRA」）

**问题**：本机 4 个模型档里，SD_FP16/Anima_INT8（WebUI）能原生加载 SD1.5 LoRA，但 QwenImage_NVFP4/Krea2_Q4（DiT 架构）不能——权重形状不兼容，静默失败。

**修法**（`gateway/server.js`）：
1. **`/api/generate` 自动检测**：当 prompt 含 `<lora:...>` 且模型是 DiT 档时，自动标记为 `bridge` 任务
2. **两阶段管线**（`runTask` 里的 `bridge` 分支）：
   - **Stage 1**：用 SD_FP16 + LoRA 出图（角色/画风正确）
   - **Stage 2**：用 DiT 模型做 img2img，把 Stage 1 的图当底图，低重绘（默认 0.35）迁移风格
3. **结果**：4 个模型档都能用同一套 SD1.5 LoRA，DiT 档出图自带 DiT 的高质量画风 + LoRA 的角色特征

**用法**：在 C 档表单里选 DiT 模型 + 挂 LoRA 即可，网关自动走两阶段管线。Stage 1 的图也会保留（`result.bridge.stage1`），方便对比。

### LoRA 拟合加强 + Bridge 管线优化（2026-10-26 用户反馈「脸部崩溃」）

**问题**：v5 LoRA delta_rms 只有 5.7e-4（weak），训练步数 1400 不够，脸部特写占比只有 20%，Bridge 管线 denoise 0.35 对脸部破坏太大。

**修法**：

1. **训练配方加强**（`gateway/lib/official-pipeline.js`）：
   - LR 1.2e-4 → **1.8e-4**，text encoder LR 6e-5 → **9e-5**
   - steps/图 40 → **70**，上限 1400 → **2400**
   - 脸部特写从 1 档 → **2 档**（`face` + `face_tight`），占比 20% → **33%**

2. **Bridge 管线优化**（`gateway/server.js`）：
   - Stage 1 分辨率 512x768 → **640x960**（脸部细节更足）
   - Stage 2 denoise 0.35 → **0.25**（保脸）
   - 结果里记录 Stage 1 尺寸，方便对比

3. **数据集**：6 档裁切（full/upper/portrait/face/face_tight/legs），7 源 = 42 张/角色

**验证**（yangyang 秧秧，视觉模型复核）：
- v5 w1.0 相似度 5-5.5/10，脸部崩
- v6 w1.0 相似度 **7.5/10**，脸部未崩，五官完整、表情自然
- delta_rms 从 5.7e-4（weak）→ **1.3e-3**（normal），强度翻倍
- 像素差异 v6 vs v5 = 64%（确实更强）

**清理**：v5 及更早实验性产物已删除（释放约 1.3 GB），保留 v6 + 第三方资产。

---

## v1.1.0（2026-10-21 晚 ⑤：一键炼制 LoRA —— 双轨解耦 / 名字可自定义 / 全链闭环）

用户要求「给 sd 插件加入一键炼制 lora 功能」→ 从 P1 到 P6 全部落地，**全量测试 164 → 176 项全绿**。

### 新增三个工具

| 工具 | 作用 |
| --- | --- |
| `sd_train_lora` | 一键炼制：本地路径 / 网址 / 参考图 → 采集去重 → 自动标注 → 自动拆双轨 → 串行训练 → 投递 LoRA 目录。`preview:true` 只出计划（不下载/不落盘/不耗显存） |
| `sd_train_status` | 进度与结果：阶段 / 产物 / 失败分类 + 训练日志尾部 |
| `sd_lora_list` | 成品清单 + 调用语法 + 双轨权重策略（ID 1.0 只读 / Base 0.3–0.7） |

### 名字可自定义（用户点名要求）

- `name` 公共名 → 两轨自动得到 `xxx_id` / `xxx_base`；`idName` / `baseName` 可单独指定某一轨；中文名保留可用。
- 名字里的 `:` `,` `<` `>` 会被清洗 —— 这几个字符会把 `<lora:名字:权重>` 语法直接撕开。
- 与已有产物重名 → 自动版本化 `_v2` / `_v3`，**绝不覆盖别人的 LoRA**；两轨被指定成同名 → 直接拒（推理时无法分别控权）。
- 命名回传四件套：`outputName`（kohya）/ `fileName`（落盘）/ `displayName`（参数表显示名）/ `callSyntax`（调用模板）。

### 双 LoRA 解耦（标准落地）

| 标准项 | ID-LoRA | Base-LoRA |
| --- | --- | --- |
| 模块 | 标准 LoRA `networks.lora` | LyCORIS LoCon `lycoris.kohya`（`conv_dim=4` / `conv_alpha=2`） |
| dim / alpha | 8 / 16 | 32 / 16 |
| 学习率 / 步数 | 4e-5 / 500 | 7e-5 / 800 |
| 数据配比 | 脸部特写 ≥ 60% | 脸部特写 ≤ 25%（**超限硬拦**） |
| 推理权重 | 固定 1.0 | 0.3–0.7（硬上限 0.7） |

### 修掉三处会直接挡住这件事的老问题

1. **`--network_dim=4` 曾被当强制注入项** → 与 ID=8 / Base=32 正面冲突。改为三层裁决：硬底线（优化器/精度/显存/分桶/保存格式，不可覆盖）→ 档位标准值 → 用户参数按护栏**钳制并记账**（ID 传 32 被钳到 12，回传「原值 → 新值」）。
2. **训练脚本只搜 `sdxl_train_network.py`** → SD1.5 永远发现不到脚本。改为按基础模型排序的双候选（SD1.5 → `train_network.py`）。
3. **`taskkill /T` 在本机会先报「整棵树超时」并卡 ~15 秒**，目标进程是否真被杀取决于树结构（用备份原件复现确认与本次改动无关）。改为：只对本管理器登记过的 PID 先做直接强杀，`taskkill` 退化为清理子树的尽力而为，其超时不会把结果判成失败 —— 训练中止从 15 秒降到即时。

### 数据层的硬规矩

- 训练前硬校验，不通过**不开训**：图片↔标注配对、空标注、疑似身份 token（覆盖 100% 标注的非通用词）、最短边 512、脸部特写占比、两轨素材下限。
- 自动标注直连本机 `qwen3-vl:8b`（与出图质检同一套），标注铁律写进指令层且输出**再净化一遍**；视觉模型不可用时**不拿通用模板糊过去**，而是如实要求补同名 `.txt`。
- 采集三源统一：格式白名单 + 精确去重 + 短边标记 + `sources.json` 来源留痕；HTML 错误页冒充图片会被拒收。

### 交付到 `LoRA/`

`README.md`（标准与流程）· `configs/`（id/base/pipeline 三份参数标准，与代码同源并由测试钉住）· `templates/`（kohya 目录与标注示例）· `acceptance/`（可勾选验收清单）· `scripts/sd-lora-pack.ps1`（打包到 `LoRA/packs/`，已实测出 zip）。

### 工程细节

- 训练日志改落 `logDir`（不再随临时目录被清）——否则失败分类永远读不到日志尾部。
- 单轨超时（默认 2 小时）会**主动收回独占锁**，不会让后续生图被 409 永久拦住。
- 刷新失败（SD 没运行）不算炼制失败：产物已落盘，SD 下次启动自然扫到。
- 新增 `gateway/lib/num.js`：`Number(null) === 0` 这个坑在本项目里踩了三次（档位步数被写成 0、参数校验误判越界、登记表步数归零），统一从这里走。
- `.lora-train/` 与 `LoRA/packs/` 不进完整性清单（否则每次炼制都会让基线过期）。

## 未发布（2026-10-21 晚 ④：把 A1111 的底模/VAE/embeddings/ControlNet 也共享给 ComfyUI）

用户看完 ③ 之后答复「要，加入」→ 把 `extra_model_paths.yaml` 从「只加 loras」扩成整份共享：

```yaml
a1111_sd48:
    base_path: D:/SD.4.8/
    loras: models/Lora
    checkpoints: models/Stable-diffusion
    vae: models/VAE
    embeddings: embeddings
    controlnet: models/ControlNet
```

- 该文件存一份到插件里：`gateway/comfy-extra-model-paths.yaml`（换机器/重装 ComfyUI 时照放一份到 ComfyUI 根目录即可）。
- 顺手清掉重复：③ 里为了免重启加的 `models\loras\sd_lora` junction **已移除**（extra paths 重启后生效，正式名更好看）——
  LoRA 列表从「48 项（含 24 个别名）」回到 **24 项干净名字**。
- 实测（重启后 `/object_info`）：
  | 类别 | 可见数 | 例 |
  | --- | --- | --- |
  | LoRA | **24** | `add_detail` · `semirealisticanime` · `国风.大漆` … |
  | 底模 Checkpoint | **7** | `AWPainting_v1.2` · `SemiRealMix` · `anything-v5-PrtRE` · `wai光辉Illustrious_v17` · `majicMIX realistic` … |
  | VAE | **5** | `animevae.pt` · `vae-ft-mse-840000` · `pixel_space` + ComfyUI 自带的 `krea2-vae` / `qwen_image_2.1_vae` |
  | ControlNet | **19** | — |
- 边界（技术上要说清）：这一步是**让 ComfyUI 读得到**这些模型；网关当前出图走 `UNETLoaderGGUF / QwenImageModelLoader`，
  所以「用 SD 底模在 ComfyUI 出图」还需要一条 `CheckpointLoaderSimple` 路由（下一步可选，等用户确认）。

## 未发布（2026-10-21 晚 ③：让 ComfyUI 也能**读取并真正使用** LoRA（用户要求））

用户要求「让 comfy 也能读取并正常使用 lora」。原先 ComfyUI 路由下 `<lora:…>` 只是提示词里的死字符
（ComfyUI 文本节点不解析 A1111 语法），而 ComfyUI 的 `models\loras` 目录**还是空的** —— 两个坑一起堵上：

### ① 让 ComfyUI「读得到」LoRA 文件

- 本机 LoRA 都在 A1111 那边（`D:\SD.4.8\models\Lora`，24 个），ComfyUI 的 `models\loras` 只有占位文件。两条路都做了：
  · **目录 junction**（立即生效、不用重启）：`D:\ComfyUI\models\loras\sd_lora` → `D:\SD.4.8\models\Lora`；
  · **`D:\ComfyUI\extra_model_paths.yaml`**（重启后生效）：`a1111_lora: base_path: D:/SD.4.8/ loras: models/Lora`
    （该文件原先不存在，是**新增**的；示例文件 `extra_model_paths.yaml.example` 未动）。
- 实测：ComfyUI 的 `LoraLoader.lora_name` 列表从 **0 → 48** 项（`add_detail.safetensors` 与 `sd_lora\add_detail.safetensors` 两种写法都在）。

### ② 让网关把 `<lora:名:权重>` **翻译成真正的 ComfyUI 节点**

- `gateway/lib/engines.js` 的 `comfyGenerate` 新增 LoRA 段：
  · 按 ComfyUI 的 `lora_name` 列表解析名字（精确 / 去扩展名 / 模糊包含三种匹配），解析不到只记一条 note 并跳过
    （**绝不因为一个 LoRA 名字把整张图搞失败**）；
  · 注入节点并改写引用：**Qwen/Krea2 这类 DiT 用 `LoraLoaderModelOnly`**（只打 model 补丁，避免 CLIP 键不匹配报错），
    **SD/SDXL 系（UNETLoader 路由）用 `LoraLoader`**（model+clip 一起打）；
  · 提示词里送进 `CLIPTextEncode` 的文本会**去掉** `<lora:…>` 标签（不然它会被当正文画出来）；
  · 结果 note 会随任务结果返回，脚本现在会打印：`[网关] LoRA 已加载：add_detail 0.6 → add_detail.safetensors（model+clip）`。
- 脚本侧：**取消**上一版「ComfyUI 路由剔除 `<lora:…>`」的做法（P18），改为**原样透传**给网关；
  控制台会打 `[LoRA] 提示词含 N 个 <lora:…> → 交由网关翻译成 ComfyUI 的 LoRA 节点…`。

### ③ 顺手：那个 `HostBuffer.read_file_slice failed` 有了可执行提示

- 用户贴的报错（`CLIPTextEncode` 节点、`HostBuffer.read_file_slice failed` = safetensors 读片失败）现在会附上人话建议：
  **重跑一次 → 重启 ComfyUI（网关 `POST /api/engines/comfy/restart`）→ 再不行重下那个权重/文本编码器文件**。
- 复现情况：同一模型同一条路（QwenImage_NVFP4 / 768x1024）**随后就连跑两次成功**（其中一次带 LoRA，90s 出图）→
  判断是偶发（文件被占用/磁盘瞬时读错）而不是稳定故障；提示已加上，下次遇到照着做即可。

### 实测证据（都留了可复现命令）

- 网关单测：提交 `prompt` 含 `<lora:add_detail:0.6>` → 任务 **success**，`result.notes = LoRA 已加载：add_detail 0.6 → add_detail.safetensors（model+clip）`。
- ComfyUI 侧反查已执行的工作流（`/history`）：节点 **30 = `LoraLoader`，`lora_name=add_detail.safetensors`，`strength_model=0.6`** ✓ 真进工作流了。
- ComfyUI 日志：`Adding extra search path loras D:\SD.4.8\models\Lora` ✓。
- 回归：`node --check gateway/lib/engines.js` OK · `test-addtext-flow.ps1` 90+ 断言全绿 · smoke 21 项 OK · manifest 75 文件对得上。

## 未发布（2026-10-21 晚 ②：修「不管选哪档，LoRA 与模型下拉都是空的」）

用户反馈：**不管选哪个模型，LoRA 和模型选项都是空的**。

- **根因**：两个下拉的列表以前**只从 A1111 WebUI API 拉**（`127.0.0.1:7860/sdapi/v1/loras`、`/sd-models`）——
  而现在出图基本走「网关 + ComfyUI」，WebUI 常常是 offline → 两个列表恒空（表单只显示「（不用 LoRA）」/「（当前模型）」）。
  这还连带一个副作用：**画风依赖检查也跟着瞎报**（`写实二次元·东亚脸` 明明有 LoRA 也会说「半写实 LoRA 与 SemiRealMix 都没有」）。
- **修法（多路来源，换机器也能用）**：
  · 新增 `Get-ModelScanRoots` —— 扫描根**不是写死的**：先从网关 `/api/health` 的引擎 cmdline 反推 ComfyUI 根
    （`D:\ComfyUI\venv\Scripts\python.exe main.py` → 往上找带 `models` 的那层），再兜底 `$env:COMFY_DIR`、`D:\ComfyUI`、`$SdDir`；
  · 新增 `Get-LorasFromDisk` / `Get-CheckpointsFromDisk` —— 扫 A1111 的 `models\Lora`、`models\Stable-diffusion`
    与 ComfyUI 的 `models\loras`、`models\checkpoints`、`models\unet`、`models\diffusion_models`；
  · `Get-SdLoras` / `Get-SdCheckpoints` 改成「API 拿得到就用 API，**并补目录里 API 没有的**；API 拿不到就整份用目录扫描」，
    日志会写清来源（`LoRA 列表：API 20 个 + 目录补充 3 个` / `模型列表：A1111 未运行 → 改为扫本机目录，共 9 个`）。
- **实测**（`tmp\list-test.ps1`，两条路径都跑）：
  · WebUI 在线：**LoRA 23 个**（API 20 + 目录 3）· **模型 16 个**；
  · 把端口指向死端口模拟 WebUI 离线：**LoRA 20 个 · 模型 9 个**（全部来自目录扫描）→ **离线时列表照样非空 ✅**
  · 顺带确认本机确实有 `semirealisticanime` LoRA 与 `SemiRealMix` 底模 → 画风依赖检查从此不再误报。
- 表单提示同步更新：不再说「SD 未运行，拉不到列表」，改成「本机没扫到 LoRA 文件；可手填『名称 权重』，或把 LoRA 放进 models\Lora / ComfyUI\models\loras」。

## 未发布（2026-10-21 晚：修「换了画风没用 / 加字把画面重画了」—— 两条根因 + 一个潜伏 bug）

用户反馈（附了两张成品图）：**表单最后出图不符合提示词/画风**，判断是「强行拉取参考图，而不是换画风后重新生成符合提示词的图」。
逐条查证（全部可复现，不是玄学）：

### ① 加字那一步「整张重画」：实测 93% 像素被改

- **取证**（`vision_pixel_diff`）：预生成图 vs 表单出图 **diffRatio 0.9972**（表单确实重新生成了，不是复制预生成）；
  但 **表单出图 vs 最终成品 diffRatio 0.9314**（底部区域 97% 全变）→
  **加字（另一档模型 Krea2 img2img @denoise 0.65）把整张画面重画了一遍** —— 用户要的画风/提示词符合度就是在这步被洗掉的，
  观感自然是「它拿我的成品重画，而不是按我的提示词出图」。
- **修法（不阉功能）**：新增 `sd-addtext-composite.py` + `-AddTextKeepBase`（默认开）——
  **AI 只负责写出那行字**，再把「文字所在的那一块」从 AI 版贴回**原图**，框外像素级保持原图（边缘羽化）。
  同一对图实测：整图变化 **93% → 21.7%**，框外只剩 3~7%。
  要旧行为（完整 AI 重绘版）加 `-NoAddTextKeepBase`；AI 原版仍另存 `原名_文字_NNN_AI.png`（**一个产物都不丢**）。

### ② 换画风「跟没换一样」：画风词在当前模型路由下不生效 + 缺依赖只有控台一行

- **取证**（用户那次运行的日志）：所选画风 `写实二次元·东亚脸` 注入的是 A1111 语法
  `<lora:semirealisticanime:0.6>, (modern anime style:1.25), …`，而出图走的是 **QwenImage_NVFP4（ComfyUI 路由）**：
  ComfyUI 文本节点**不解析 `<lora:...>`**（A1111 特性）→ LoRA 完全不生效，标签还成了提示词里的垃圾字符；
  而日志只有一行 `半写实 LoRA 与 SemiRealMix 都没有，用当前模型` —— 用户在表单里根本看不见。
- **修法**：
  · **路由清洗**（`Remove-LoraTags`，做进 `New-GatewayTask`，一次覆盖所有提交路径）：ComfyUI 路由下自动剔除 `<lora:...>`
    并提示「要真正挂 LoRA 请把模型切到 SD_FP16 / Anima_INT8」；
  · **表单里直接看得见**：画风下面新增提示行（红/绿字）——本档缺什么、当前路由生不生效
    （例：`（ComfyUI 路由：本档的 LoRA/底模切换不生效，只会注入风格词；本机还缺 LoRA semirealisticanime、底模 SemiRealMix → …）`）。

### ③ 顺带挖出潜伏很久的变量名撞车 bug（合成脚本找不到的真因）

- `foreach ($root in $iterCandidates)`（脚本**顶层**）—— PowerShell 变量名**大小写不敏感**，顶层 `$root` 与第 107 行的
  `$Root`（`= $script:Root`，脚本目录）**是同一个变量** → 循环跑完 `$script:Root` 变成「最后一个迭代候选目录」（常是系统 temp 那份）。
  实测现场：加字合成脚本被找成 `C:\Users\...\Temp\sd-inject-iter\sd-addtext-composite.py`（存在=False）→ 静默跳过。
  **同一处也影响网关入口查找**（`Find-GatewayEntry` 用 `$script:Root` 拼候选，只是另有兜底才没暴露）。
- 修法：循环变量改 `$iterRootScan`；SD 根探测的 `$root =` 改 `$sdRootLocal`；
  合成脚本定位改成**四候选**（`$PSScriptRoot` → `$script:Root` → `$script:SdRoot` → `OutDir 父目录`），谁在就用谁。
- 加了两条**回归断言**（禁止顶层 `foreach ($root …)` 与新的 `$root =` 赋值），并把合成分支改成**不再静默跳过**
  （缺脚本/缺 python 都打「跳过区域合成 → 用整张 AI 版。脚本=…（存在=False） python=…」）。

### 测试

- `tmp\stage-test.ps1`：单独抽 `Invoke-AddTextStage` 跑（桩掉网关），秒级验证合成分支与 python 传参。
- 真机复测：路由清洗 / 加字（步数·位置·字号·风格）/ 合成日志与产物（`_文字` + `_文字_AI`）全部到位。
- `tmp\test-addtext-flow.ps1` 扩到 90+ 条断言全绿（含 BOM/CRLF、变量撞名、合成多候选定位）。

## 未发布（2026-10-21 夜：适配性 / 加速 / 体积 三项优化，功能一件没减）

用户要求：「对**所有电脑、所有环境**都能适配」「**加速生图**」「**减小插件体积**」「**绝对不能阉割功能**」
「完成后用**模拟键鼠**测试所有技术性功能」「**严禁动任何可能造成系统崩溃的动作**」「动有风险的东西前**备份**」。
全部照办：动手前先把 424 个插件文件（含安装副本）备份到 `tmp\backup-20261021-optimize\`（附 SHA256 清单）。

### ① 适配所有电脑/环境（新增「适配层」，全部 try/catch 兜底）

- **环境自检**：启动第一件事就探 PowerShell 版本 / OS / 是否 64 位 / CPU 核数 / 屏幕与工作区 / 是否交互桌面，
  一行打进日志 —— 换台机器出问题，一眼能看出「这台是什么环境」。实测输出：
  `环境：PS 5.1.26100.7920 · OS Microsoft Windows NT 10.0.26200.0 · 屏幕 1920x1080（工作区 1920x1080）· 16 核 · DPI 感知=True`
- **高 DPI 感知**：Win8.1+ 走 `shcore.SetProcessDpiAwareness`，失败退 `user32.SetProcessDPIAware`，再失败就静默放弃 ——
  高 DPI 屏上界面不再被系统整体拉伸成糊图。
- **字体兜底**：不同区域/精简版 Windows 未必装了雅黑/宋体/楷体。新增 `Get-UiFontFamily` / `Resolve-FontFamily`：
  从本机真实字体族里挑第一个可用的（雅黑→黑体→Segoe UI→Arial→系统默认），楷体/宋体/衬线这些预览字体也逐个探；
  **一个都没有就用系统默认族**，界面照样有字，绝不因缺字体崩。实测：`界面字体：微软雅黑（本机共 330 个字体族）`。
- **窗口按屏幕收进来**：参数表（1024×914）与选位器（1010×650）改成「先量工作区，装不下就等比收小 + `AutoScroll`」
  —— 1366×768 / 带任务栏的小屏也不会「确定按钮跑到屏幕外」。内容一个不少，超出部分滚动可见。
- **非交互桌面**（服务/无桌面会话）：探测到就明确提示「弹窗会自动跳过，出图照常」，弹窗失败一律降级不中断。

### ② 加速生图（实测数据）

- **加字那一步砍步数**（新增 `-AddTextSteps`，默认 0 = 自动取「该档默认步数」与 16 的较小者）：
  同一底图、同一提示词、Krea2_Q4/768×1024/denoise 0.65 实测 —— **24 步 153s / 16 步 105s / 12 步 81s**，
  三档都用本机视觉模型逐字核对「图上写了什么」，**都只写出目标文字（无假字）** → 默认取 16，**省 31%**；
  想更快可显式 `-AddTextSteps 12`（也验过，省 47%）。
- **参数没改就复用预生成成品**（新增 `-NoReusePreGen` 可关）：以前用户「打开表单看一眼就点确定」会**再出一张**（2-3 分钟）
  **再加一遍字**（1.7-2.5 分钟）。现在表单里记一份「预生成时的参数指纹」，点确定时逐项比对
  （提示词/尺寸/模型/denoise/比例画质/轮数/LoRA/蒙版/底图/模式/加字四项），**一模一样就直接复用预生成那张**，秒级结束。
- 端到端实测：加了加字步数优化后，「是/否窗 → 生图+加字 → 参数表」从 **284.3s 降到 197.1s**（同一套参数与底图）。

### ③ 减小体积：17.4 MB → **2.37 MB（-86%）**

- 仓库目录与安装副本原先都是 **17.4 MB / 86 文件**，其中 90% 是**非插件内容**：
  用户文档 `你们要学，我便教.docx`（6.44 MB）、测试产物 `SD-Picture\*.png`（≈5 MB）、
  打包产物 `dist\*.zip`/`*.tgz`（2.2 MB）、`__pycache__`（26 KB）。
- 处理方式：**不删**，全部**移到** `tmp\attic-20261021\`（可随时搬回），仓库与安装副本都做同样处理。
  处理后两边都是 **2.37 MB / 74 文件**，插件全部功能文件（脚本/网关/文档/测试）一个不少。
- 另外确认：npm 打包白名单（`package.json` 的 `files`）本来就**不含**这些垃圾 —— 也就是说发布包里一直是干净的，
  只有本地目录被撑大了；打包产物由 `pack-github.ps1` 随时可重建。

### 回归与保护（这次踩到的坑，都加了护栏）

- **`edit` 类工具会掉 UTF-8 BOM**：掉了 BOM 的 `.ps1` 被 PS5.1 按 GBK 读 → 实测直接 **391 个解析错误**（整脚本报废）。
  现在测试套件里加了三条硬断言：**有 BOM / 全 CRLF / 无替换字符**，掉一个就红。
  改脚本一律走 `tmp\apply-patch.ps1`（读字节→按行替换→按原编码写回，BOM 与 CRLF 都保）。
- **PS5.1 的数组 splat 是「位置传参」**：`& 脚本 @数组` 会把 `-BasePrompt` 当成第一个位置参数（实测参数全错位、
  报 ValidateSet 错）。所有自动化脚本统一改用 **hashtable splat**（`@h` 名字=值），switch 传 `$true`。
- **模态子窗口在 UIA 里挂在父窗体子树下**：选位器（表单的 owned window）不在桌面根节点的顶层窗口列表里，
  自动化要**在表单子树里找**才能定位（否则误判成「没弹出来」）。

### 顺手抓到的真 bug（不是优化，是原来就错的）

- **选位器里「取消」被「用这个位置」压住**：`$btnOk` 是 16..292、`$btnCancel` 是 160..292 —— 完全重叠，
  且 WinForms 里**先加的控件 z-order 在上** → 用户点「取消」实际会点到「用这个位置」，**位置+字号+风格会被强行回填**。
  实测就是这么暴露的：自动化点「取消」后，表单「加字位置」从「右下」变成了「BR」（原始码）。已改成 `取消 @ x=304 宽 118`，零重叠。
- 选位器补上 **回车 = 用这个位置 / Esc = 取消**（顺手也方便键鼠自动化）。
- 参数指纹不一致时，日志会打出**具体哪一项变了**（实测用它一眼定位到上面那个 bug）：
  `[复用] 参数有改动 → 正常出图（#16 预生成=[右下] 现在=[BR]）`。

### 键鼠实测（全部真鼠标 `mouse_event` + 真按键 `keybd_event`）

- `tmp\selfcheck-all.ps1`：是/否窗 **3.34s** 出现 → 点「是」→ 参数表 **197.1s**（生图+加字完成之后）→
  表单三行齐全、预填「DeepSeek / 深度求索 / 右下 / 中」→ 心跳 `pregenerate-done … texted=yes` →
  新产物 `uicheck_picker_002.png` + `uicheck_picker_文字_002.png` → **成品自动打开**（新窗口 `WPS图片 :: uicheck_picker_文字_002.png`）。
- `tmp\picker-drive.ps1`：选位器**自动弹出**（表单子树里找到）→ 控件 19 个（九宫格 9 + 随机 + 用这个位置 + 取消 + 字号/风格下拉）；
  真鼠标点「左上」→ 读数从「九宫格：右下」变成 **「九宫格：左上」**；点字号下拉按 **上方向键 → 变「小」**（不展开下拉，避开坑64）；
  点「用这个位置」→ **表单回填「左上」「小」** 全部通过。
- `tmp\reuse-check.ps1` / `tmp\reuse-check2.ps1`：**复用加速路径实测通过** ——
  是/否窗 3.58s → 参数表 86.1s（这次不传 `-AddText`，只有生图）→ 一个参数都不改直接点「确定出图」→
  日志 `[复用] 参数与预生成完全一致 → 直接采用预生成成品（省一次出图+加字）` → **子进程 31 秒结束**
  （原来这条路径要再出一次图 + 再加一遍字，实测 4-5 分钟）。
- 静态回归：`tmp\test-addtext-flow.ps1` 80+ 条断言全绿；插件自带 `node smoke-skill.mjs` **21 项 SMOKE 全 OK**；PS5.1 解析 0 错误。

## 未发布（2026-10-21：加字位置 / 字号 / 字体风格都能选）

用户要求：「文字位置要可以调整（自由决定位置，弹窗出来的时候在最右边打开缩略图，自由选择位置），
或者由对话发送到脚本中」+「字号和字体风格也要能选」。两条都做完了，键鼠自检 + 真机出图都验过。

### 加字位置（对话侧 + 用户侧两个入口）

- **对话侧**：`sd_inject` 新增 `addTextPos` → 脚本 `-AddTextPos`：`random`（默认）/ `TL TC TR ML MC MR BL BC BR` / `"x,y"`（自由点，0-1）。
  不传 = **脚本开始时随机挑一格**加字（就是用户说的「开始时就加入随机位置」），随机结果写进日志与心跳。
- **用户侧**：参数表新增两行 —— 「加字位置」（可编辑 + 「缩略图选位置…」按钮）与「字号/风格」。
  点按钮弹出**选位器**：**右侧是成品缩略图**（在图上点任意处 = 自由点，画红叉 + 实时文字预览），
  左侧是九宫格（左上…右下）+ 随机 + 字号/字体风格下拉 + 位置读数（如 `自由点 0.25,0.2（左起 25% / 上起 20%）`）。
  「用这个位置」把位置 + 字号 + 风格一起回填进参数表。
- **改了就重加**：预生成那张已经加过字 → 用户在表单里改了位置（或字号/风格），出图阶段会**从未加字的原图重加一遍**
  （`$script:PreGenResult.Original`），绝不把新字叠在旧字上；没改就跳过
  （`PreGenTexted` / `PreGenTextPos` / `PreGenTextSize` / `PreGenTextStyle` 四个标记）。
- 方位短语进提示词**前段**（`with the title in the bottom right corner` / `…about 25% from the left and 20% from the top`），
  目标文字仍留在**最末尾** —— 与 10-20 的实测定稿同一种结构（虚词不外溢）。

### 字号 / 字体风格（用户侧 + 对话侧）

- 参数：`-AddTextSize`（小 / 中（默认）/ 大 / 特大）、`-AddTextStyle`（粗体无衬线（白，默认）/ 细体无衬线 / 衬线体 / 手写楷体 / 霓虹发光 / 描边黑体 / 中文书法）。
- 选位器里改字号/风格，**预览立刻跟着变**：字号按图高比例（3.5% / 5.5% / 7.5% / 10%），
  字体分别用雅黑粗 / 雅黑细 / 宋体 / 楷体；霓虹发光画青色光晕、描边黑体走 `GraphicsPath` 描边；
  预览还会**自动缩到最多两行**（特大字号塞进小框不会溢出）。
- 对话侧对应 `addTextSize` / `addTextStyle`（不传即默认档）。
- **默认档 = 逐字不变的实测定稿模板**（`… crisp white sans-serif title, …, exact text: "文字"`），
  只有选了非默认档才追加短语。

### 实测踩到的坑（已修）

- **带名词的短语会被当成正文画进图里**（三轮实测，每次都用本机视觉模型逐字核对图上写了什么）：
  1. `very large poster title size` → 图中央被画出 `Poster` / `Pioster` 两坨假字（定稿模板自带的 `high quality poster design` 反而不漏）；
  2. 改成 `massive title`（与风格段的 `title` 重复出现）→ 被画出 `Tinle`（Title 糊掉）；
  3. 定稿做法：**字号只出一个形容词**（`small` / `big` / `huge`），紧跟实测定稿的那一段
     （`crisp white sans-serif title` → `huge glowing neon white sans-serif title` 这类替换），
     全句**只有一个名词 title**、结构与验过的模板同构 → 复测 `huge + 描边` 与 `huge + 霓虹` 都只写出目标文字，无假字。
  默认档（中 + 粗体无衬线）下提示词与 10-20 验过的那段**逐字一致**（仅多一个方位短语）。
- 表单新增两行 → 高度 838 → **914**，右栏整体下移；控件名（`txtAddTextPos` / `btnPickTextPos` / `cboAddTextSize` /
  `cboAddTextStyle` / `pbPosPreview` / `btnPosTL…BR` / `btnPosOk`）都留了 Name/AccessibleName 供键鼠自动化定位。
- 测试：`tmp/test-addtext-flow.ps1` 扩到 70+ 条断言全绿（位置/字号/风格助手逻辑、选位器控件、四条加字出口、提示词结构锚点）；
  新增 `tmp/diag-picker.ps1`（用 `SD_POS_PICKER_DUMP` 钩子在**不弹窗**的情况下导出 6 组选位器预览图核对排版）
  与 `tmp/vlm-textcheck.ps1`（让本机视觉模型逐字报出图上文字，用来判定有没有假字外溢）。

## 未发布（2026-10-20：C 档定稿「先弹是/否 → 生图(含加字) → 打开成品 → 参数表」）

用户实测报的两件事，都从**根因**上修：① C 档一开始没有任何弹窗；② C 档里要的图上文字没给他。
（10-20 晚用户把顺序说全了，于是定稿为：**脚本一启动先弹「是否开启视觉审查」是/否窗 → 生图 + 有加字要求就加字
→ 自动打开成品 → 最后才弹参数表**。）

### ⓪ 定稿：开头先弹「是/否」小窗，参数表放到最后（2026-10-20 晚，用户口述需求）

- **脚本第一个窗口就是「是否开启视觉审查」是/否窗**（放在 Add-Type 之后、任何阻塞步骤之前）：
  · 【是】开启视觉审查 = 跑完整生图（素体自检迭代 + 脸/手质检迭代）· 【否】关闭视觉审查 = 按正常生图流程出一轮。
  两侧后续完全一致：**生图（有加字要求就加字）→ 自动打开成品 → 弹参数表**。
  `-StartDialog ask|yes|no` 可跳过弹窗直接定档（自动化/无人值守用）。
- **预生成恢复为默认执行**（`-NoPreGenerate` 可退回「先弹参数表、点了才出图」；`-PreGenerate` 保留兼容）：
  开头的选择窗把 10-18 那版「先出图后弹窗」的体验问题解决了（选完窗就出图，控制台有 7 步进度），
  所以不必再靠「砍掉预生成」来换弹窗速度。
- **预生成阶段就把字加上**：`-AddText` 非空时，出完图立刻换另一档模型写字；
  自动打开的那张、状态栏显示的、`-PreGenPath` 引用的都是**带字成品**。
  再加 `$script:PreGenTexted` 双份字保护：预生成已加字的图，后面任何出口都不会再加第二遍。
- **键鼠实测**（`tmp/selfcheck-dialog.ps1`，真鼠标点「是」）：
  是/否窗 **4.1 秒**出现 → 心跳 `23:35:37 pregenerate-start` → `23:40:16 pregenerate-done path=…uicheck2_文字_001.png texted=yes`
  → 新产物 `uicheck2_002.png`（原图）+ `uicheck2_文字_001.png`（带字）→ **参数表在点「是」后 284.3 秒才弹出**（图先出、先打开、表单最后）。

### ① 根因：预生成排在表单前面，把弹窗推迟了 2 分 42 秒

- **证据**（本机心跳文件 `.sd-inject-iter/iter-ed7608da/status.txt`）：
  `[01:10:26] start` → `[01:10:30] pregenerate-start model=QwenImage_NVFP4` →
  `[01:13:12] pregenerate-done path=SD-Picture\1girl_solo_full_012.png`。
  即：脚本先跑「网关就绪 → 引擎就绪（拉起略有 240s 上限）→ 提交 → 等出图 → 落盘」，
  **窗口要等这 2-3 分钟才出现**；中间任何一步卡住（引擎拉起 / 任务等待上限 1800s）就等于「永远没有弹窗」。
  同一份脚本的注释里早写过这个坑（坑49：表单之前不允许有任何同步网络/模型操作），10-18 的「C 档新流程」把它改回来了。
- **修法**：预生成改为**可选开关 `-PreGenerate`**（默认不跑），表单回到「脚本一启动就弹」。
  表单之前的网关探测从「等 30 秒」降到 **3 秒快探**（探不到也不挡弹窗，4 档模型照常全列）。
  真正的引擎 ensure/加载留在用户点「确定出图」之后。
- 键鼠自检实测：**窗口 7.81 秒出现**（`tmp/selfcheck-live.ps1`），且本次 `status.txt` 里**没有** `pregenerate-*` 行。

### ② 根因：加字只能靠对话传参（表单没地方填）+ 有一条成功出口直接 `exit 0` 跳过加字

- **表单新增「加字」行**：文本框（预填 `-AddText`）+ 「加字模型」下拉（默认 `自动（换另一档）`）。
  C 档是用户在表单里自己填内容的流程，加字却只能由对话传 `-AddText` —— 漏传就永远没有字（实测那次 launcher
  里确实没有 `-AddText`）。现在表单里能直接填、能改、能留空。
- **加字改成统一收尾 `Invoke-AddTextStage`，三条成功出口全都走它**：
  ①「追加为空 → 直接收尾」捷径（以前是 `exit 0`，加字整段被跳过）
  ②最终出图正常出口 ③质检模型不可用（`VlmDown`）出口（只对保留的第 1 张加字）。
- **加字固定换「另一档模型」**（用户要求「生图后用另一个模型加上去」）：新增 `Resolve-AddTextModel` ——
  生图档 = 表单选的档（默认 `QwenImage_NVFP4`），加字档自动挑**与它不同**的一档（Krea2 优先，它的中英文最准），
  下拉里也可以手动指定；只有全机只剩一档可用时才会同档并明确提示。
- 产物：`<原名>_文字.png`（原图保留），控制台打印「`=== 加字：生图档 X → 加字档 Y（另一档） ===`」。

### ③ 加字写不出来：denoise 0.42 在 ComfyUI 路由上「基本不动」

- 端到端自检第一跑（Qwen 生图 → Krea2 加字）**跑通了流程**，产物 `*_文字.png` 也生成了，
  但看图一眼发现：**图上一个字都没有**。原因不是流程，是参数——
  脚本自己的注释里就写着「Comfy 的 denoise 语义比 A1111 更敏感，低了不动、高了换人」，
  而加字默认 `-AddTextDenoise 0.42` 正好落在「不动」区间（图片几乎原样返回）。
- **扫档实测**（本机 ComfyUI / Krea2_Q4，底图 768×1024，同一提示词，共六轮）：
  | denoise / 提示词 | 结果 |
  | --- | --- |
  | 0.42 | 字**完全没写上去**（用户报的「文字没有给我」） |
  | 0.60 | 有字但排版崩：`DeepSeek` 被顶出画面、笔画断裂、末尾多一个逗号 |
  | **0.65** | **DeepSeek + 深度求索 都写准、排版干净**（默认值） |
  | 0.78 | 字能写，但把连接词也画进去了（多一个 `the`），人物/画风明显漂移 |
- **提示词收敛（第六轮定稿）**：把要写的字夹在散文中间时，紧邻的虚词会被一起画进图里
  （实测被画进过 `as a`、`the`、末尾一个逗号）。解法：**目标文字用双引号括住、并放到提示词最末尾** ——
  `… high quality poster design, exact text: "DeepSeek / 深度求索"`，实测中英文都写准且无外溢
  （对比图：`tmp/addtext-tune/` 下 `at5_F_final.png`（定稿模板，干净）vs `atune_d078_final.png`（0.78，多一个 the））。
  负面补 `textless, blank poster, no typography` 逼模型必须把字写出来。
- 默认 `-AddTextDenoise` **0.42 → 0.65**（可调，建议 0.60-0.70）。

### 顺带修：宽×高首次沿用命令行尺寸

- 表单「宽×高」以前**总是**被默认档位（9:16 + 1024p = 576×1024）覆盖，命令行 `-Width/-Height`
  （C 档命令里的 1216×1536 / 768×1024）等于白传。现在表单**首次**弹出时用命令行尺寸，
  超出本档长边上限（本机 1024）就按比例收进来（如 1216×1536 → 808×1024），不会拿一个会报错的尺寸去提交；
  之后用户改比例/画质/换模型仍是「档位最后说话」（坑63 不受影响）。

### 测试

- `tmp/test-addtext-flow.ps1`：静态 + 逻辑 32 条断言全绿（含 6 条 `Resolve-AddTextModel` 换档用例、
  7 条 `Invoke-AddTextStage` 行为用例（mock IO）：换档/透传文字/产物命名/原图保留/空文字跳过/底图缺失跳过）。
- `tmp/selfcheck-live.ps1`：**真实键鼠**（user32 `mouse_event`）驱动 —— 启动脚本 → 计时等窗口 →
  读控件 → 真鼠标点「确定出图（走网关）」→ 等子进程跑完 → 报告新产物（含 `*_文字.png`）。
- PS5.1（`powershell.exe`）`[Parser]::ParseFile` 0 错误；UTF-8 with BOM + CRLF 保持（坑3/坑13 不回退）。

## 1.0.5（架构升级：本地 AIGC 调度网关 · 2026-10-18）

把「脚本串联式生图插件」重构成「带资源治理与高可用容灾能力的本地 AIGC 调度网关」。
前端只跟网关说话，不再直连 WebUI(7860) / ComfyUI(8188)。

### 后台出图进度 + 参数表两栏（用户 2026-10-19 要求）

- **进度条与步骤清单**：`sd-inject.ps1` 的后台预生成阶段改为 7 步清单 + 双进度条：
  ①检查参数与目录 ②网关就绪 ③引擎就绪（必要时拉起 SD/ComfyUI）④提交任务 ⑤出图 ⑥落盘 ⑦弹出参数窗口；
  控制台按「`采样 26% · 预计剩 5s`」滚动，PowerShell 进度条同步（`Write-Progress` Id1=总步骤 / Id2=采样）。
- 新增网关只读接口 **`GET /api/progress/{task_id}`**（进度条唯一数据源，前端依旧不直连引擎）：
  · WebUI → 读 A1111 `/sdapi/v1/progress`（真实百分比 + ETA + "采样 n/m 步"）
  · ComfyUI → 读 `/queue` 判断排队/在跑，跑起来后按 `elapsed/expectedSec` 估算并标 `estimated: true`
  · 排队/训练/完成/失败各阶段都给 `stage` + `percent`；探测失败退化为时间估算，绝不抛
  · `models.js` 为 4 个模型补 `expectedSec`（仅估算用）；ComfyUI 提交后立刻把 `prompt_id` 记进任务（队列判定用）
  · 新增 1 条集成测试（mock WebUI 固定 62% / ETA 8s）→ 网关测试 **70 项全绿**
- **参数表左右两栏**：左栏 = 正向/负向两个大提示词框（556×312，可滚动 + 底部编辑提示）；
  右栏 = 模型档位/模式/底图/蒙版/Denoising/迭代次数/比例/画风/画质/LoRA/checkpoint/命名/宽×高
  + 进度条 + 状态栏 + 按钮；表单尺寸 350×862 → **1024×764**。
  控件名 / AccessibleName / 定位规则未动 —— 键鼠自动化脚本无需修改（已实测通过：SD_FP16 文生图 45s PASS）。
- 表单内新增进度条 `pbGen`，计时器轮询 `/api/progress` 时同步更新。

### C 档流程改为「后台先生成 → 落盘 → 再弹窗」（用户 2026-10-18 要求）

- `sd-inject.ps1` 启动后**先把图生成好**（默认 `-Model SD_FP16`，也可指定另外三个枚举），
  按命名规则写进 `-OutDir`（插件调用时 = 对话工作区 `SD-Picture`），**然后**才弹出参数表单窗口。
  用户打开窗口时成品已在磁盘上（状态栏绿字显示 `已后台生成：<文件名>`）；直接关窗口也不丢图。
- 预生成失败/超时不会挡住表单（照常弹出可手动重出）；`-NoPreGenerate` 退回旧顺序。
- 表单宽高默认跟随预生成尺寸，避免"预生成 512×768、点确定变 264×480"。
- 预生成期间控制台持续打印进度（`[网关] running…`），不再是"窗口不出来、也不知道在干什么"。
- **图生图 Denoising 默认值改为 0.65**（用户指定；切换模式/初始 -Mode 图生图/后台预生成/一致分支兜底 四处统一为 0.65，
  下拉档位里也补了 `0.65` 一项）。

### 安装引导与 GitHub 打包（用户 2026-10-18 要求）

- 新增 **`INSTALL.md`**：把「需要下载/准备的一切」列成清单 —— 插件本体、Node、SD WebUI、checkpoint/VAE/LoRA、
  **CLIP 文本编码器 1.59G**、Python pin（transformers 4.30.2 等）、ADetailer、ComfyUI、venv、ComfyUI-GGUF、
  **Qwen 三件套 13.6G**、Krea2、Ollama 视觉质检、ROS2。每项含：用途 / 大小 / 国内镜像下载地址 / 落盘路径 / 校验方式，
  外加分步安装、装完自检清单、故障对照表（坑 56-66）、目录结构、卸载回滚。
- 新增 **`gateway/tools/check-deps.ps1`**：依赖体检（逐项 ✓/⚠/✗ + 路径 + 大小 + 缺失项的现成命令，可 `-Markdown` 出报告）。
  本机实测：23 项 → OK 21 / WARN 2 / MISSING 0。
- 新增 **`gateway/tools/bootstrap-downloads.ps1`**：引导下载（默认 dry-run 打印计划；`-Apply` 真下载，
  curl 断点续传 + 下载后大小校验；`-Only/-Skip` 精确控制；HF/pip 走国内镜像可覆盖）。
- 新增 **`pack-github.ps1`** + **`.github/workflows/release.yml`**：GitHub 打包格式 —— 推 tag 自动跑门禁
  （manifest/完整性/69 项测试/冒烟/全量 .ps1 语法）→ 生成 `dsh-unrestricted-printing-<ver>.zip`（解包即用）与 `.tgz`（npm）
  → 创建 Release 并挂产物（含 deps-report.md）。本地 `npm run pack:github` 可复刻同一套产物。
- `package.json`：`files` 增补 `INSTALL.md`；新增脚本 `deps:check` / `deps:bootstrap` / `pack:github`。
- `gen-manifest.mjs`：把 `dist/`、`.sd-inject-iter/`、`SD-Picture/`、`__pycache__/` 排除出清单（打包产物不该影响完整性基线）。

### 新增：`gateway/`（Node，零第三方依赖）

- `gateway/index.js`：启动入口（`--check` 自检 / 幂等防重复启动）
- `gateway/server.js`：HTTP 收口 —— `/api/generate`、`/api/status/{id}`、`/api/tasks`、`/api/queue`、
  `/api/training/{start,end,status}`、`/api/models`、`/api/monitor`、`/api/engines`、`/api/engines/{engine}/{restart,ensure}`、
  `/api/breaker`、`/api/health`、`/api/logs`、`/api/config`
- `gateway/lib/models.js`：4 枚举（`SD_FP16`/`Anima_INT8`/`QwenImage_NVFP4`/`Krea2_Q4`）+ 路由 + 尺寸规则 + 可用性探测
- `gateway/lib/store.js`：任务表 + 状态机（queued/training/running/success/failed）+ 单车道排队锁 + 训练互斥 + 状态落盘
- `gateway/lib/engine-manager.js`：进程台账（PID/参数/健康/重启次数）+ `taskkill /PID /F /T` 强杀 + OOM 阶梯重启（每级 1 次）
- `gateway/lib/engines.js`：WebUI / ComfyUI 双引擎客户端（硬超时、错误分类、`extra` 透传、二进制安全取图）
- `gateway/lib/ros2.js`：手写 RFC6455 WebSocket 客户端 + rosbridge 订阅（零依赖）
- `gateway/lib/monitor.js`：ROS2 优先、断连降级 `nvidia-smi`、准入提示与 OOM 预警（默认不硬拦）
- `gateway/lib/training.js`：训练独占 + 强制参数注入 + 结束/异常/重启释放锁与清理临时文件
- `gateway/lib/breaker.js`：超时熔断（closed → open → half-open）
- `gateway/tools/fix-bom.ps1`：改完 `.ps1` 补 UTF-8 BOM（PS5.1 无 BOM 会把中文按 GBK 读成语法错）
- `gateway/tools/ui-gateway-verify.ps1`：真实键鼠 × 逐档位 × 逐模式的出图验证脚本

### 改造：`sd-inject.ps1`

- 模型下拉严格限定 4 枚举（可用性来自网关 `/api/models`，离线/缺模型直接标出来）
- 新增「宽×高（网关）」+ 状态栏 + 「提交出图（网关·异步）」
- 提交后 `System.Windows.Forms.Timer(Interval=2000)` 异步轮询 `/api/status`，状态栏配色 queued 黄 / training 橙 / running 蓝 / success 绿 / failed 红
- 连续 3 次请求失败 → 停表 + 「与网关断开连接」；任务结束或 `FormClosing` 一律 `Stop()` + `Dispose()`
- `Krea2_Q4` 宽或高 > 1024 → 弹窗报错并 `return`；宽高 `[int]::TryParse()`；`$form.AcceptButton = $btnSubmit`
- 素体自检迭代与最终出图统一经网关；引擎预热改为 `POST /api/engines/{engine}/ensure`
- `-NoGatewayAutoStart` / `-LocalBackendFallback` / `-NoGateway` 三个开关控制网关依赖程度

### 改造：`sd-direct.ps1`

- 新增 `-VramFlag`（白名单校验：`--medvram`/`--medvram-sdxl`/`--lowvram`/…），供网关 OOM 阶梯重启注入
- HF 离线判定修正：**必须确认文本编码器权重（`pytorch_model.bin`/`model.safetensors`）真的存在**，
  否则不设 `HF_HUB_OFFLINE`，避免"缓存目录在、权重缺失"导致 txt2img 500

### 修复（本轮真机坑 56-61）

- 56 SD `txt2img` 500 `ExceptionGroup`：HF 缓存缺 CLIP 权重却被判为"缓存命中" → 改判据（见上）；环境侧补齐权重并按 A1111 原始 pin 恢复 `transformers==4.30.2 / tokenizers==0.13.3 / huggingface_hub==0.23.5`
- 57 `Init-Observability` 命令找不到：PowerShell 不做函数前向引用 → 定义上移到调用之前
- 58 网关拉起的引擎"有 PID 却什么都没发生"：`detached: true` 在带文件沙箱的宿主里写盘被静默拒绝 → 默认非 detached
- 59 低显存任务永久卡队列：准入硬闸误判 → 默认只预警放行（`GW_VRAM_STRICT=1` 才排队）
- 60 UI 自动化下拉按 Enter 提前出图：`AcceptButton=提交出图` 导致 Enter 穿透 → 自动化改用 Tab
- 61 编辑 `.ps1` 丢 BOM 导致 PS5.1 语法错乱 → `fix-bom.ps1`

### 用户实测反馈修复（2026-10-18 晚）

- **两次都没出图**（根因）：ComfyUI 路由收到 A1111 的采样器名 `DPM++ 2M` → 400
  `value_not_in_list: sampler_name`。网关现在按引擎分流采样器（A1111 名 → `dpmpp_2m` / `euler_ancestral` …，
  映射不到回落模型推荐值），`sd-inject` 只对 WebUI 档位透传采样器；ComfyUI 的 `node_errors` 也会翻译成
  「节点 9 KSampler.sampler_name 非法」这种人话。真机复现：同一份 payload 修前 400、修后 65s 出图。
- **两个出图按钮重复**：「提交出图（网关·异步）」与「确定出图」合并成**一个**「确定出图（走网关）」，
  它同时是 `AcceptButton`（回车即提交）。
- **提示词框疑似被固定画风**：默认画风档由「二次元」改为「保持画风」——默认不再把
  `anime style / cel shading / (3d:1.2) …` 写进正负提示词框；模式切换也不再劫持画风档。
- 点一次「确定」不再出两张：表单已出图 → 跳过素体自检迭代。
- 表单提交时控制台留痕（模型/尺寸/底图/蒙版 + 两个提示词框原文），便于自证与排障。
### 测试

- `npm run test:gateway`：67 项 Node 单测/集成测试（假 WebUI/假 ComfyUI/假 rosbridge）
- `npm run test:gateway:ui`：真实键鼠逐档位 × 逐模式验证（参考图随机取自 `SD-Picture` 与 `D:\截图`）

## 1.0.4（脚本路径自适应 + 抠图诊断分流 · 2026-10-16）

真机实测两处故障回填，都属「用户照命令跑却跑不通 / 看不懂」。

### ① 脚本路径自适应（根因：模型自造路径）

**故障现场**：用户粘贴命令后报
```
无法将 "D:\...\skills\dsh-unrestricted-printing\scripts\sd-direct.ps1" 识别为 cmdlet、函数、脚本文件或可运行程序的名称。
+ CategoryInfo : ObjectNotFound: (D:\...\sd-direct.ps1:String) [], CommandNotFoundException
```
那条路径是**模型自己臆造**的 —— `skills\` 下根本没有 `scripts\` 子目录（插件只把脚本同步到
工作区根目录与 SD 目录两处）。同一故障在 `sd-bridge.js` 注释里已记录过一次，这是第二次踩。

**修法（三层）**：
1. **影子路径同步**（根因修复）：`syncDirectScripts()` 往 4 条高频自造形态各放一份**内容完全一致**
   的真脚本 —— `skills\dsh-unrestricted-printing\scripts\`、`skills\sd-paint\scripts\`、
   `skills\sd-paint\`、`.dsh\skills\dsh-unrestricted-printing\scripts\`。模型猜哪条都能跑，
   不再依赖它记对路径。写失败静默跳过，不影响主路径。
2. **`sd-direct.ps1` 自身路径自适应**：新增 `$ScriptDir`（`$PSScriptRoot` → `$MyInvocation.MyCommand.Path`
   → 当前目录 三级兜底），同目录资源一律以**脚本自身位置**为基准；新增 `-ResolveOnly` 开关
   （只打印自身位置后退出，不碰 SD），供自检用。
3. **技能文案加路径硬规则**：明确禁止臆造 `skills\...\scripts\` 路径、禁止 `& "..."` 形式
   （会被执行策略拦「未数字签名」），并给出两种报错的原文作为识别特征。

### ② 自动抠图「换词没用」误导（根因：参考图不是人物图）

**故障现场**：用户把一张**终端报错截图**（1112×340，纵横比 3.27:1）当参考图传进来，
自动抠图零命中，黄字提示却是
```
对话侧：自动抠图没成功（YOLO-World 试过 ['dress','sleeves',...] 都没命中，没抠出任何区域（换词或用手工框/区域蒙版））
```
用户照着「换词」试多少词都不可能成功 —— **图里根本没有人物**。零命中 ≠ 词不对。

**修法（三层）**：
1. **`sd-auto-mask.py` 加人物确认**：零命中时调 `_count_person()` 跑 person-seg 确认画面里有没有人。
   返回人数写进 JSON 的 `persons` 字段。诊断分流：
   - `persons == 0` → 「这张图里没检测到人物……换词不会有帮助，请改用几何区域蒙版或手绘蒙版」
   - `persons > 0` → 「图里有 N 人但词没命中（可能是画风/遮挡）→ 换词或用手工框/区域蒙版」
2. **`sd-inject.ps1` 提示按诊断分流**：命中「没检测到人物」特征时，额外两行明确告诉用户
   「换检测词不会有用」+「请换一张人物图，或把蒙版栏改成具体区域」，不再让用户对着黄字猜。
3. **`sd-direct.ps1` 参考图体检**：出图前若参考图纵横比 ≥ 2.2:1，先用黄字提醒「极端比例通常不是
   完整人物图（更像截图/裁片）→ 自动抠图会零命中，出图也会偏离预期」，**不阻断**（用户可能确实想改裁片）。

### 回归验证

- `sd-auto-mask.py` 对失败图（终端截图）：`ok=false, persons=0`，注释为「没检测到人物……换词不会有帮助」✅
- 对正常人物图（`shorekeeper1.jpg`）：`ok=true, persons=-1`（未触发零命中分支），
  `engine=YOLO-World(词：dress/detached sleeves/shawl)+SAM`，覆盖 9.23% —— **无回归** ✅
- 三个文件语法检查全绿（`sd-direct.ps1` / `sd-inject.ps1` PS ParseFile，`sd-auto-mask.py` py_compile）✅
- BOM 校验：全部 7 份副本均为 UTF-8 with BOM ✅

## 1.0.3（manifest 基线清理 · 2026-10-16）

**纯清理版本** —— 1.0.2 的 manifest.json 把两个**不属于插件**的东西算进了基线，
用户跑 `verify-integrity.mjs` 会看到一堆无关条目：

- `你们要学，我便教/`（误落进仓库目录的 6.7MB 无关 docx）
- `~$要学，我便教.docx`（Office 打开文档时生成的锁文件）

修法：`gen-manifest.mjs` 的 `ignored()` 增加两条排除规则（目录前缀 + `~$` 前缀）。
基线回到 **38 个干净文件**（原来 40）。

功能与 1.0.2 完全一致，只是清单干净了。

## 1.0.2（手绘蒙版修复 + 蒙版不再锁定 + 显存自愈降级 + 1.0.1 真机报告五连修 · 2026-10-16）

### ④ 显存自愈三级降级（用户要求：「重试三次清理显存，失败走 CPU / 核显出图」）

**背景**：8G 卡上只要别的程序（游戏 / 浏览器 / 视频）吃掉大半显存，SD 起来后剩余不足 → txt2img 直接 500：
```
Not enough memory, use lower resolution (max approx. 768x768). Need: 0.4GB free, Have:0.2GB free
RuntimeError: Expected all tensors to be on the same device, but found ... cpu and cuda:0!
```
以前这里只会把错误抛给用户，没有任何自愈动作。

**三级递进（全自动）**：

| 级别 | 动作 | 实测耗时 |
| --- | --- | --- |
| ① 清显存 | 最多 **3 轮**「同时清 SD checkpoint + 本地模型服务 → 等 1.5s×轮次 → 复测」 | 每轮 1.5-4.5s |
| ② CPU 推理 | 仍不够 → `--use-cpu all --no-half --precision full --disable-nan-check --skip-torch-cuda-test --opt-split-attention` 重启 SD | 就绪 **25s**；出图 512×512/12 步 **144s** |
| ③ 核显 | CPU 起不来 → 核显模式（`--use-ipex`，探测到 Intel/AMD iGPU 时才试） | 就绪上限 180s |
| ④ 全败 | 抛带诊断的错误：当前剩余显存 + 「谁在占显存」的处理建议 | — |

**两个触发点**：
1. **启动前**（`ensureServer` → `startServerWithVramFallback`）：先跑三级决策，再按建议模式启动；
2. **出图时**（`apiPostWithVramHeal` 包住 txt2img/img2img）：撞上显存类 500 → 3 轮清理重试 → 仍失败则切 CPU → 再不行切核显 → 全程失败才抛错。

**新增配置**：`vramAutoFallback`（默认 true，关掉则走老路径、失败直接抛错便于排查）。

**踩坑**：`--threads N` **不在** A1111 v1.10.1 的 `cmd_args` 里（实测 `error: unrecognized arguments: --threads 16`
直接启动失败），CPU 线程数交给 torch 自己按核数决定，插件不干预。

**真机验证**（本机 RTX 5060 8G，显存被 WarThunder 吃到只剩 328 MiB）：
```
① 显存读取：nvidia-smi "1863" → 1.82G ✅
② 错误判定：Not enough memory / CUDA out of memory / 设备分裂 全部命中；正常错误不误判 ✅
③ CPU 参数：--use-cpu all --no-half --precision full ...（无 --threads）✅
④ 核显探测：识别出 Intel(R) UHD Graphics ✅
⑤ CPU 模式实测：25s 就绪 → 出图 512×512/12 步 144s 成功（画面结构正常，GPU 使用率 0%）✅
```

### ⑤ 蒙版手绘修复验收（客观数据）

用插件自带的 `sd-mask-qa.py` 对「手绘蒙版 → 蒙版重绘」做量化体检：

```
蒙版覆盖 2.69% ｜ 蒙版内命中 79.9% ｜ 蒙版外保留 99.92% ｜ 外溢 0.08% ｜ suspect 0
```

- **蒙版内命中 79.9%**：涂抹区域确实被重绘（剩下 20% 是边界抗锯齿与原本就接近的区域）；
- **蒙版外保留 99.92%**：未涂区域几乎像素级原样保留 —— 这正是蒙版重绘的核心价值
  （画风/背景/人物不跟着变）；
- 手绘窗口实测：底图正常显示、**两笔涂抹痕迹清晰可见**（红色高亮带 + 波浪线）、
  笔刷光标圈 + 十字准心跟手；存盘蒙版 1216×1536（= 参考图原始尺寸）、纯黑白。
  对照图见 `tmp/mask-comparison.png`（原图 / 手绘蒙版 / 出图结果 三联）。


### ③ 1.0.1 真机报告（第三方机器 · 6GB 卡 · 未装 Ollama）五连修

> 来源：`sd-bridge-guard-issues-2026-10-16.md`（RTX 3060 Laptop 6GB / A1111 v1.10.1 /
> torch 2.1.2+cu121 / **未安装 Ollama**）。两条阻塞、三条健壮性。

**Issue 1（阻塞）无本地视觉模型时 `Ensure-Vram -For 'sd'` 白卸 SD → 后续每轮 txt2img 必 500**
- 根因：`Test-FaceQuality` 内部无条件调 `Ensure-Vram -For 'sd' -Note '视觉审核'`，理由是
  「给常驻 5278MB 的 8B 视觉模型腾显存」——但本机根本没这个模型，卸载纯属白卸。
  而 A1111 v1.10.1 在「卸载 → 请求内重载」这条路径上会把部分权重留在 CPU
  （CLIP token embedding、LoRA Linear 都遇到过）→ 同一次请求内张量设备不一致 → 500。
  6GB 卡上 SD 常驻后剩余恒为 3.6G < 默认阈值 4G，**每一轮都会触发**。
- 修法（两层）：
  1. `Test-FaceQuality` 开头早退——`if ($NoVlmReview) { return -1 }` +
     `if (-not (Test-VlmApi)) { return -1 }`（服务不可达就不进质检，也不去白卸 SD）；
  2. 那行改 `if (Test-VlmApi) { Ensure-Vram -For 'sd' -Note '视觉审核' }`（只在模型真可达时才腾）。

**Issue 2（阻塞）`sd_inject({ run: true })` 的启动器漏传 cfg 驱动的四个开关**
- 根因：命令字符串与 `sd-inject-launcher.ps1` 的 `paramPairs` **两处各自维护**，
  launcher 那侧漏了 `-NoVlmStart` / `-NoAutoMask` / `-VlmModel` / `-NoVlmReview`。
  于是「插件设置里关掉审核」后：返回的命令文本是对的，但 `run:true` 真正执行的那次
  仍走默认开启审核的老路 → 触发 Issue 1 的 500。
- 修法（结构级根治，采纳报告建议）：抽出单一来源 `buildInjectCfgSwitches(cfg, args)`，
  命令字符串与 launcher **共用同一份**，从结构上不可能再漂移。

**Issue 3（一致性）`-NoVlmReview` 没「整条不跑」+ 未暴露显存开关**
- 根因：`-NoVlmReview` 只在 `Invoke-BaseIterate` 内置 `$vlmOk = $false`，
  但两个 `Test-FaceQuality` 调用点没用它做门禁（打印了「审核已关闭」却照跑质检 → 照旧白卸 SD）。
- 修法：`Invoke-FinalIterate` 的 `$vlmDown` 初值改为 `[bool]$NoVlmReview`（整条不跑）；
  `Invoke-BaseIterate` 的调用点加 `if ($vlmOk)` 门禁。
- **顺带新增两个插件配置项**（报告建议）：`vramRelease`（默认 true，false 时传 `-NoVramRelease`）
  与 `vramMinFreeGb`（默认 4.0，传 `-VramMinFreeGb`）——6GB 这类小显存卡终于能从配置层
  绕开「开跑前释放显存」，不必手工改命令。6G 卡建议：`vramRelease: false` 或 `vramMinFreeGb: 2.0`。

**Issue 4（安装）8 段并行下载必失败且原因被吞；hf-mirror 429 直接放弃**
- 根因：`SegmentWorker` 的 `catch {}` 完全吞掉异常，失败只回裸 `$false` ——
  用户只能看到「分段下载全部失败」，无法判断是服务端不支持 Range 还是本地网络问题。
- 修法：
  1. worker 改为回报 `@{ Ok; Errs }`，把每次尝试的异常（或「长度不符：期望 vs 实收」）收集起来；
  2. 失败时打印前 3 条分段失败原因；
  3. 单流降级对 **429 走 30s×次数 的退避重试**（原为固定 3s×次数，实测 hf-mirror 连打
     4 次全 429 就放弃了 SemiRealMix / VAE / EasyNegative / badhandv4 四个小文件）。

**Issue 5（健壮性）插件 spawn 的 SD 继承宿主旧 PATH，首次启动 `git clone` 失败**
- 根因：`install-sd.ps1` 把 MinGit 装到 `%LOCALAPPDATA%\dsh-sd-bridge\MinGit\cmd` 并写进
  **用户 PATH**，但运行中的 DSH 宿主（及其 spawn 的子进程）仍持有旧 PATH →
  `prepare_environment()` 报 `Couldn't clone assets. Command: "git" clone ... Error code: 1`。
- 修法：新增 `withGitOnPath(env)`，把插件自装的 MinGit 目录（及常见 git 落地位置）
  前置进子进程 PATH；只并入**已存在**的目录，找不到就原样返回（对已跑通的机器零影响）。
  注意**不能**用 `prepared` 做守卫——报告场景恰是 SD 已装（venv 存在）但 `repositories/`
  还没克隆完，照样需要 git。

**验证**：`npm test` 21 段全绿（新增 `REAL-ISSUES SMOKE OK`，14 条防回归断言覆盖 Issue 1-5）；
PS 5.1 `parse errors = 0`；`verify-integrity.mjs` 32/32 完好。

## 1.0.2 前序内容（手绘蒙版修复 + 蒙版不再锁定）

用户实测反馈两条，都是真机复现后修的。

### ① 手绘蒙版「看不到笔刷痕迹、也没有实际效果」——两个根因

**坑35：PowerShell 的 WinForms 事件处理器不继承函数局部作用域。**
`Show-MaskPainter` 里的 `$canvas` / `$maskG` / `$baseBmp` 等本是函数局部变量，
但 `Add_MouseDown` / `Add_MouseMove` 的 scriptblock 在**自己的作用域**里执行——
处理器里的这些变量全是 `$null`，`FillEllipse` 立即抛错，
表现就是「拖了没反应、窗口里什么都没有」。
**修法**：所有跨处理器共享的对象一律提到 `$script:` 作用域（`mp_` 前缀防撞），
处理器只读写 `$script:mp_*`，不再依赖闭包捕获。

**坑36：用 ColorMatrix 做「黑底白笔迹 → 半透明红」显示层，实测把底图整层盖成白色。**
`ColorMatrix` 的行列语义在 PowerShell 里既难写也难验（`MatrixRC` 命名属性与索引器行为不一致，
`$cm.M03` 这种写法直接报「属性不存在」；换成索引器又要手工清 25 项，稍有偏差就是全白/全黑）。
**修法**：彻底不用矩阵——另开一张**独立红色叠加层**（透明底 ARGB 位图）：
涂抹时同时往「蒙版层」写黑白（出图用）、往「红色层」写半透明红（显示用）；
显示 = 底图 + 红色层。零矩阵、零魔法，所见即所得。
擦除时红色层切 `CompositingMode::SourceCopy` 把该区域 alpha 直接置 0
（普通 `SourceOver` 模式下「画透明色」擦不掉东西）。

顺带增强：
- **笔刷光标圈 + 十字准心**跟手显示，随时知道笔刷多大、落点在哪
- 滚轮调笔刷（6–300 px），`[` / `]` 也能调
- 鼠标移出画布自动收起光标圈
- 画布 `AntiAlias`，边缘平滑
- 存盘按**参考图原始尺寸**用 `NearestNeighbor` 还原（SD 需要白=重绘区）

**实测**（自动化涂抹脚本：起窗口 → 定位 → 模拟鼠标按+拖 → 截图 → 回车 → 校验产物）：
```
窗口: 728x973       笔迹清晰可见（红色高亮带 + 光标圈）
SAVED: test-mask2.png (12306 bytes)
白色像素占比: 0.81%          蒙版尺寸 1216x1536（= 参考图原始尺寸）
采样颜色: RGB(0,0,0) + RGB(255,255,255)（灰阶仅 3 个抗锯齿边缘点）
```

### ② 蒙版不再锁定（用户要求）

**原行为**：对话侧一旦自动抠好蒙版（或给定精确框 / 蒙版图路径），表单里「蒙版」下拉就被**禁用**（灰蓝底 + 「对话已按图抠好蒙版并锁定」），用户想改也改不了。
**新行为**：**任何情况下蒙版都保持可编辑**——自动抠图结果只**预填**、不锁死。
想手绘就选「手动绘制（鼠标涂抹）」，想换区域选区域名，想整图重绘选「无」。

改动点：
- 三处 `$lockMask = $true` → `$false`（蒙版图路径 / 精确坐标框 / 自动抠图成功）
- 移除表单里的蒙版锁定块（`$cboMask.Enabled = $false` + 灰底 + 锁定文案）
- 提示文案更新为「（白色=重绘区；可填区域名/box:x,y,w,h/蒙版图路径，或选手动绘制）」

**底图锁定保持不变**（`$lockBase`）——底图由对话解析、值本身必须精确，锁住是合理的。

**实测**：图生图 + 对话给定坐标框，表单里蒙版下拉白底可编辑（显示「自动（按图内容抠图）」），底图框灰底禁用（「对话已解析底图并锁定」）——正是预期效果。

**回归**：PS 5.1 `parse errors = 0`；三份 `sd-inject.ps1` SHA256 一致（`8262794B5C6DA507`）。

## 1.0.1（完整性检测 + 手绘蒙版 + C 档参数注入 · 2026-10-16）

本轮三件事：**别人下载后能自查缺什么**、**蒙版可以鼠标手绘**、**C 档违禁词能注入表单**。

### ① 文件完整性检测（新功能）

别人从 npm / GitHub 拿到插件后，不再只能靠「跑一下看看报不报错」判断包是否完整——
现在有**基线清单 + 反向比对**：

- **`manifest.json`**（新增）：38 个文件的基线清单，逐文件记 `sha256 / bytes / category / shipped`。
  分类决定缺失的严重度：`runtime`（✗ 必需，缺了插件跑不起来）/ `tool`（△ 辅助，该功能不可用）/
  `doc`·`dev`·`ci`（· 可选，不影响运行）——不搞一刀切，避免 dev/doc 本来就不全时报一堆假错误。
- **`gen-manifest.mjs`**（新增）：`node gen-manifest.mjs` 生成基线；`--check` 只校验（CI 用，清单过期退出码非 0）。
- **`verify-integrity.mjs`**（新增）：独立检测脚本，终端彩色表格 / `--json` / `--md` / `--remote`。
  退出码 `0` 完好、`2` 缺必需文件、`3` 检测本身失败。
- **`sd_integrity` 工具**（新增，插件内）：跑检测并把排好版的中文表格交给模型贴给用户。
  按需联网拉 GitHub 上的最新 `manifest.json`（`main`/`master` 双分支兜底 + 12 秒超时，离线自动降级只做本机比对），
  列出**新版本新增了什么、哪些文件更新了、哪些已被仓库移除**。
- **启动自检**：插件 apply 时跑一次，缺 `runtime` 文件立即记醒目告警；
  **退出自检**：卸载时再跑一次并落盘 `~/.dsh-sd-bridge/integrity-report.{json,md}`，用户事后也能看。
- 全程异步 + 静默失败：检测绝不把插件主流程拖崩。

### ② 手绘蒙版（新功能）

C 档参数表「蒙版」下拉新增 **`手动绘制（鼠标涂抹）`**（紧跟「自动」之后）——选中即弹出手绘窗口：

| 操作 | 效果 |
| --- | --- |
| 左键拖动 | 涂抹要重绘的区域（笔迹显示为半透明红） |
| 右键拖动 | 擦除 |
| 滚轮 | 调笔刷大小（6–200 px，标题栏实时显示） |
| `C` 键 / 清空 | 清空全部笔迹 |
| `Enter` / 确定 | 保存蒙版并出图 |
| `Esc` / 取消 | 放弃，**回退自动蒙版**（不静默重画整张） |

实现要点：画布最长边压到 900 px 保证不卡（保存时按**参考图原始尺寸**用 NearestNeighbor 还原，蒙版与 SD 目标尺寸对齐）；
显示用 `ColorMatrix` 一次 `DrawImage` 完成（避免 900×900 逐像素 `GetPixel`）；
常驻位图复用（不每次涂抹新建 Bitmap）；两点间线性插值补点（快速拖动不断线）。
决策树里手绘**优先级最高**，不被「自动抠图 / 替换目标推断」覆盖。

### ③ C 档违禁词注入表单（技术测试链）

`sd_inject` 新增 `violationPrompts` / `suggestedPrompts` 参数，脚本侧新增 `-ViolationPrompts` / `-SuggestedPrompts`，
分别预填进参数表单**第一个框（正向）**与**第二个框（负向）**。为防漏传导致静默失效，加了五层防线：

| 层 | 机制 |
| --- | --- |
| L1 | schema `required: ['violationPrompts','suggestedPrompts']` |
| L2 | `execute()` 开头 `throw`——两个都空直接中断，报错信息告诉模型怎么补 |
| L3 | `hint` 里 `⚠️ 漏传参数：…` 告警（只传一个时同轮补调） |
| L4 | 命令 `parts` 拼 `-ViolationPrompts` / `-SuggestedPrompts` |
| L5 | 启动器 `paramPairs` 同步进 `$p` 数组 |

### ④ 真机故障修复（本轮实测踩到）

- **`sd-inject.ps1` 缺 UTF-8 BOM 导致 PS 5.1 按 GBK 读中文 → 语法错**（`Try 语句缺少 Catch`、
  `表达式或语句中包含意外的标记`）。三份脚本统一补 BOM，`parse errors = 0`。
- **SD 后端 500（`Expected all tensors to be on the same device, but found cpu and cuda:0`）**：
  8G 卡上 `qwen3-vl:8b` 常驻占 5.05G，SD 再要 4-5G → CLIP 文本编码器部分层被挤到 CPU，
  张量设备不一致直接崩。卸载常驻模型后显存 275MiB → 6731MiB 空闲，出图恢复。
- **SD 重启后 CLIP tokenizer 联网超时**：本地缓存（`<SD>\.cache\huggingface`）本是完整的，
  但没设 `HF_HOME` 就跑去 `huggingface.co` 拉 → 连接超时 ×5 重试 ×3 轮。
  启动时带 `HF_HOME` + `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1` → **9 秒就绪**（原来 57 秒）。

### ⑤ 插件管理页开关（前序 PR 延续）

插件内注册 HTTP 端点 `/api/sd-bridge-setting`（GET 读 / POST 写 `finalVisualReview`），
配合前端注入脚本在插件详情页渲染「最后视觉审验」开关。

**回归**：`node gen-manifest.mjs --check` 通过；`node verify-integrity.mjs` 本机比对 38/38 完好；
三份拷贝（主目录 / release / profile 加载副本）`sd-bridge.js` SHA256 一致；PS 5.1 `parse errors = 0`。

## 1.0.0（首个正式版 · 2026-10-16）

把 0.9.14 之后这一整轮真机修复收拢成正式版。**C 档（`sd_inject` → `sd-inject.ps1`）从「能出图」变成「可复现、可自查、失败有话说」**：

- **蒙版**：`四周（背景）` 环形路径修复（`$rects` 未初始化导致整条路径静默死掉）；区域蒙版改按最终出图尺寸画；
  衣服词表补 `sleeves / detached sleeves / hood / cloak / shawl / scarf`，检测框上限 `--max-boxes 3`，肩线守卫 8%→4%；
  连通块按同件多块合并并打印各块面积。
- **抠图健壮性**：SAM 显存自适应（≥4.5G cuda 全分辨率 / 3.0-4.5G 降到 640px / <3.0G 直接 CPU）；
  SAM 崩掉时用检测框兜底（与人物剪影相交、必要时裁到躯干带）；拿到空输出时**自动用 CPU 重试一次**；
  失败说明带 python 退出码 + stderr 尾巴。
- **审核（本地视觉模型）**：冷启动 `ollama serve`；审核模型换成**能识图**的 `qwen3-vl:8b`；
  走原生 `/api/chat` + `think:false` + `num_predict=1024`（原来走 `/v1` 时思考型模型的 `content` 恒为空 → 每次 -1）；
  送审前把图压到长边 768；**审核范围只限技术性**（system 约束禁止评价/描述/审查画面内容）；
  解析只认 `SCORE=<n>` 或首个 0-100 整数。
- **显存**：每个「要显存」的步骤开跑前按需释放对面那一侧（抠图/审核前卸载 SD checkpoint，出图前/收工后卸载本地模型）——
  实测释放效果 **0.46G → 7.02G（+6.56G）**。
- **产物目录只留成品**：预蒙版、命中率总览图等中间图跑完自动清理（`-KeepWorkFiles` 可保留）。
- **蒙版命中率体检**（`sd-mask-qa.py`）：拿「参考图 / 蒙版 / 成品」逐像素判 命中 / 命中未改 / 外溢 / 正确保留，
  出数字 + 总览图，C-1b 出图后自动跑。
- **C 档参数表**：两个提示词框末尾始终带逗号（含切画风重写后的兜底）。
- **有参考图时跳过素体自检迭代**（不再多出一张 `inject_00N.png`）。
- **画风不再列进「C 档选项表」**（用户要求 2026-10-16）：画风是 C 档表单里的一个档位，选中即把画风词写进**正向提示词**框（负向词写进负向框），属于提示词内容；选项表只留 模型 / LoRA / 比例 / 画质 / 迭代 / Denoising，并注明「画风不在本表里」。表单画风下拉保留。

- **插件页开关**：`vlmReview`（是否启用视觉审核）/ `vlmModel`（审核模型，默认能识图的 qwen3-vl:8b）/
  `vlmAutoStart`（是否自动冷启动本地模型服务）/ `maskAutoSegment`（是否自动抠图）。

**回归基线**：`node smoke-skill.mjs` **18 段全绿**；另有 5 个真跑测试随包发布
（`test-region-mask.ps1` 13/13、`test-mask-qa.ps1`、`test-vlm-cleanup.ps1` 9/9、
`test-automask-retry.ps1` 8/8、`test-vram-release.ps1`、`test-trailing-comma.ps1` 10/10）；
PS 5.1 `parse errors = 0`（UTF-8 BOM 在位）。## 0.9.24（C 档参数表的两个提示词框：末尾始终带逗号）

**需求（用户原话）**：在 c 档参数表中两个提示词框最后加逗号。

**为什么之前会「时有时无」**：预填那一步本来就补了逗号（`$formPositive/$formNegative` → 末尾补 `, `），
但**切画风会重写两个框**，而 `Add-StyleWords` / `Remove-StyleWords` 的返回值**都不带尾部逗号** ——
于是打开表单时看到的逗号，切一次画风就消失了。

**修法**：新增 `Add-TrailingComma`（已有逗号则原样，空串原样），并让**所有**写框的地方都过一遍：

- 切画风时移除旧画风词 → `Add-TrailingComma`；
- 切画风时注入新画风词 → `Add-TrailingComma`；
- 表单打开时的初始注入（`$st0`）→ `Add-TrailingComma`；
- 确认取 `Pos` / `Neg`（`$txtPos.Text` / `$txtNeg.Text`）→ 再兜一次（`(Add-TrailingComma …).TrimEnd()`）。

结果：**框里显示什么、后面就用什么**，两个框（正向 / 负向）最终一定以逗号结尾（框内是 `", "`，
提交值是 `","`）；空框不会被塞进一个逗号。

**验证**（`test-trailing-comma.ps1`，新增，真跑）

```
ok  plain text gets a comma                 ok  after style inject the box ends with a comma
ok  existing comma is untouched             ok  after style remove the box still ends with a comma
ok  comma without space is untouched        ok  negative box ends with a comma too
ok  empty stays empty                       ok  submitted value ends with a comma (no trailing space)
TRAILING-COMMA TEST OK                      ← 10/10
```

**回归**：`node smoke-skill.mjs` 十八段全绿，新增 `TRAILING-COMMA SMOKE OK`（6 条源码断言：函数在、
四条重写路径都补逗号、确认两处都兜、预填行为未丢）；PS 5.1 `parse errors = 0`；三份脚本 SHA256 一致。

## 0.9.23（每次运行前先释放显存）

**需求（用户原话）**：每次运行前先释放显存。

**为什么这条是刚需（本机实测）**：这张 8G 卡被三方共抢 —— SD(A1111) 常驻 2.5-5G、
抠图（YOLO-World + SAM）2-3G、8B 视觉模型 **5278MB**（`/api/ps` 实测）。
两者都常驻时实测**只剩 0.46G** → 抠图 CUDA OOM（python 进程被原生崩掉、只报「没有输出」）、
审核模型被挤到 CPU（一次 40-65s，慢到撞 180s 超时）。
**实测释放效果：0.46G → 7.02G（+6.56G）。**

**实现（`sd-inject.ps1`）**

- `Release-SdVram`：`POST /sdapi/v1/unload-checkpoint`（+ `/sdapi/v1/free`）让 A1111 交还显存；
  出图时 A1111 会**自动重载**，用户无感。
- `Release-OllamaVram`：`GET /api/ps` 列出常驻模型 → 逐个 `POST /api/generate {keep_alive:0}` 卸掉。
- `Ensure-Vram -For sd|ollama|any`：**只在剩余显存低于阈值时**才释放（`-VramMinFreeGb`，默认 4.0G），
  够用就打印「够用，不释放」直接走人，避免无谓的重载开销；拿不到显存信息（无 nvidia-smi）时静默跳过，不阻断出图。
- 开关 `-NoVramRelease`（完全关掉这套动作）。

**接在四个点上（每个"要显存"的步骤开跑前）**

| 时机 | 动作 | 理由 |
| --- | --- | --- |
| 自动抠图前 | 释放 **SD** | YOLO-World + SAM 要 2-3G（之前 OOM 崩掉的现场） |
| 视觉审核前 | 释放 **SD** | 8B 模型要 5.3G，SD 占着就只能走 CPU → 40-180s |
| 素体迭代前 | 释放 **Ollama** | 出图要 SD 掌卡 |
| 最终出图前 | 释放 **Ollama** | 同上 |
| 收工后 | 释放 **Ollama** | 不让本地模型长期占卡（下次调用自动重载） |

**真机验证**（`test-vram-release.ps1`，新增，真跑 + 量 nvidia-smi）

```
free VRAM at start     : 4.98 GB
ok  NoVramRelease frees nothing
free VRAM after release: 7.08 GB (delta 2.10 GB), ollama loaded=0
VRAM-RELEASE TEST OK
```

另一次（两者都常驻时）：`before 0.46G → after 7.02G，delta 6.56G`。

**回归**：`node smoke-skill.mjs` 十七段全绿，新增 `VRAM-RELEASE SMOKE OK`
（10 条源码断言 + spawn 真跑测试）；PS 5.1 `parse errors = 0`；三份脚本 SHA256 一致。

## 0.9.22（审核模型换成能识图的视觉模型 + 审核范围限制在技术性内容）

**需求（用户原话）**：模型换成能识图的模型，而且要制止他审查图片除了技术性之外的内容。

### ① 模型：默认 `qwen3.6-fable` → `qwen3-vl:8b`（能识图）

- 依据：`itsailor/qwen3.6-fable` 的模型卡原文写着 “**Vision does NOT work in this build.** … images are silently
  ignored and the model hallucinates a description. **Treat this as a text-only model.**” —— 它看不了图，
  拿它做审核只会得到胡说（`parable/qwen3-fable` 同理，2.33GB 文本模型）。**审核必须用能识图的模型。**
- 改动：`sd-inject.ps1` 的 `-VlmModel` 默认值、`sd-bridge.js` 的插件设置 `vlmModel` 默认值都改成 **`qwen3-vl:8b`**；
  插件页仍可改；「指定模型不在本机」时照旧回退到本机第一个 `vl`/`vision` 模型并提示怎么拉/怎么建。
- 本机 profile 补丁层已钉死：`vlmModel: qwen3-vl:8b`（配合 `vlmReview: true` / `vlmAutoStart: true`）。

### ② 审核范围：只许技术性，禁止碰画面内容

- **新增 system 约束（两个端点都带）**：
  > 你是一个生成图的结构缺陷检测器（自动质检环节的一环）。你的唯一任务是检查人物解剖结构是否崩坏（脸 / 手 / 四肢），
  > 只输出一个 0-100 的整数分。**禁止评价、描述、审查或拒绝画面内容**：不判断题材、不判断服装与裸露程度、
  > 不涉及性内容、不做任何合规 / 道德 / 安全判断，也不要复述画面里有什么。除分数外不要输出任何字。
- **用户问句**同步收紧：结尾加「只许输出分数，不许评论画面内容」；判据仍只有三类结构（脸 / 手 / 四肢）。
- **画风识别**那条（`Get-ImageStyleByVlm`）也加了「只判断画风（技术属性），不评价画面内容、不描述画面里有什么」。
- **解析只认数字**（结构性防线，模型多嘴也进不了打分逻辑）：先认 `SCORE=<n>`；否则取**第一个 0-100 的整数**
  （813 这类跳过）；空白回答先 `Trim()` 再判空（PowerShell 里空白串是真值）。
- 这样做的好处：审核输出的**唯一产物就是一个分数**，不会在日志/界面里留下任何对画面内容的评价或合规判断。

### 真机验证

```
review score = 100   (>=75 过关)   elapsed=40.7s     ← VLM-REVIEW TEST OK
```

**回归**：`node smoke-skill.mjs` 全绿（新增断言：默认模型必须是 qwen3-vl:8b、system 约束必须存在、
问句必须含「不许评论画面内容」、画风问句必须含「不评价画面内容」、解析必须是「首个 0-100 整数」）。
PS 5.1 `parse errors = 0`；包内/工作区/release 三份脚本 SHA256 一致。

## 0.9.21（素体不再额外生成 / 蒙版补部件 / 视觉审核失效的真因与修法）

**需求（用户原话）**：1 重新调试蒙版，同上，忽略裸体内容；2 qwen3.6-fable 在 ollama 里面模糊搜索，素体不需要额外生成了；3 视觉审核一致失效。

### ① 视觉审核「一致失效」——真机复现 + 三层修（最高优先）

真机复现（本机 qwen3-vl:8b 在册、Ollama 已就绪，对 832×1216 的成品送审）：

```
review score = -1   （= 模型没回答）   elapsed = 180.1s   ← 正好撞满 180s 超时
```

**根因**：送审的是**原分辨率**大图，8G 卡上 SD 常驻时 8B 视觉模型只能走 CPU / 部分卸载 →
一次推理跑不完 180 秒 → 每次都返回 `-1`。旧代码把 `-1` 静默当成「质检没工作」，
于是每一轮都不打分 → 用户看到的就是「视觉审核一致失效」。

修法（`Test-FaceQuality`）：

1. **送审前降分辨率**：长边压到 `-VlmImageMaxSide`（默认 768）再 base64 —— 像素数只剩约 40%，
   判「结构是否崩坏」够用，CPU 上也能在几十秒内出分。
2. **改走原生端点并关思考**：`/v1/chat/completions` 对思考型模型**不认 `think:false`** —— `content` 恒为空、
   思维链全在 `reasoning` 字段里。改成首选 `POST /api/chat`（`think:false` + `options.num_predict = 1024`）：
   实测 **11.9s、finish=stop、content="SCORE=100"**。num_predict 给太小（256/512/700）会「想一半被截断」，
   content 空或只剩半截数字（实测回过 "797"）；给到 1024 才收得住。
3. **解析与判空都修**：① 先认显式 `SCORE=<n>`，再退化为「第一个 0-100 的整数」（813 这种跳过）；
   ② 空白回答在 PowerShell 里是**真值**，`-not $raw` 判空失效 → 先 `Trim()`；
   ③ 超时可配 `-VlmTimeoutSec`（默认 300，原来写死 180）；拿不到分数会打印**模型原话 + 耗时**。
   真机最终结果：`review score = 100  (>=75 pass)  elapsed=65.2s` → **VLM-REVIEW TEST OK**。

### ② qwen3.6-fable 到底是哪个模型（模糊搜索结果）

- **它是社区模型，不是官方库模型**：`ollama pull qwen3.6-fable` 会 404，正确名字是
  **[`itsailor/qwen3.6-fable`](https://ollama.com/itsailor/qwen3.6-fable)**（22GB，256K 上下文；另有 `:27b-mlx`）。
  同名的另一个是 [`parable/qwen3-fable`](https://ollama.com/parable/qwen3-fable)（2.33GB）。
- ⚠️ **它做不了看图审核**：itsailor 那份的**模型卡原文**写着
  “**Vision does NOT work in this build.** … images are silently ignored and the model hallucinates a description.
  **Treat this as a text-only model.**” —— 它是 Qwen3.6-27B 的 NVFP4(MLX) 量化版、uncensored 创作/角色扮演模型，
  22GB 也不是 8G 卡能常驻的。
- 所以：**审核继续用本机现成的视觉模型**（`qwen3-vl:8b`）；`vlmModel` 想写 `qwen3.6-fable` 也可以，
  但脚本发现它不在本机时会回退到第一个 `vl`/`vision` 模型并打印「枚举到哪些 + 怎么拉/怎么建」。

### ③ 素体不再额外生成（用户明确要求）

- 现象：那轮产物目录里多出一张 `inject_001.png` —— 那是**素体自检迭代**先生成的素体底图。
- 修：**有参考图时（对话给了 `-InitImage`，或表单选「图生图」）直接跳过素体自检迭代** ——
  参考图本身就是底图，再跑一遍只会多一张图 + 白烧时间/显存；日志会打印
  「已有参考图 → 跳过素体自检迭代」。文生图（没有参考图）仍然照旧跑素体迭代。

### ④ 蒙版重新调试（按上一轮同样的极端用例：把衣服蒙版重绘掉，看残留）

真机测量（同一张参考图 + 同一套参数，步骤逐项可核对）：

| 项目 | 结果 |
| --- | --- |
| 检测词命中 | `dress / detached sleeves / kimono`（**袖套这次框到了** —— 词表已补 `sleeves`/`detached sleeves`/`hood`/`cloak`/`shawl`/`scarf`） |
| 检测框上限 | 写死的 2 → `--max-boxes`（默认 3）：多件套不再只收两个词 |
| 多件合一 | 5 件 → 并集覆盖 7.5% |
| 行内桥接 | 7.6% → 9.4% |
| 去脸区 | 9.4% → 9.1% |
| 连通块 | 保留 1/7 块（各块面积已写进 notes：9.11%, 0.01%, 0.00%… —— 其余 6 块是蝶/花碎块） |
| 薄纱补全 | 11.8% → 13.0%（最终覆盖 13.01%，与分辨率无关，稳定可复现） |
| 肩线守卫 | 8% → **4%**（实测 8% 会把「肩线附近」的袖套/披风整块丢掉；头发从人物上沿就开始，4% 仍挡得住） |
| 上一轮输出（007/008/009）命中率体检 | 蒙版内已改 **83.5% / 88.0% / 87.8%**，疑似漏衣料只剩 **0.80-0.84%**（上一轮是 2.32%） |

**仍要如实说的**：参考图里那条**兜帽/披风长布**不是连衣裙部件，检测器给它的词框不到 →
需要它一起重绘时请把蒙版填成 `box:` 或直接给蒙版图（或把目标改成「主体」）。
蒙版本身没有漏检问题（外溢 0.03% 那一轮已证明边界是干净的）。

**回归**：`node smoke-skill.mjs` 十四段全绿，新增 `BASE-SKIP+MASK-V2 SMOKE OK`（素体跳过条件、
衣服词表补部件、`--max-boxes`、肩线 4%、连通块面积日志）。PS 5.1 `parse errors = 0`。

## 0.9.20（插件页开关「视觉模型审核是否启动」+ 模型换 qwen3.6-fable + 审核人物肢体）

**需求（用户原话）**：在插件页加个开关吧，视觉模型审核是否启动可以自己选，模型换成 qwen3.6-fable，审查人物肢体。

1. **插件页开关 `vlmReview`（默认 `true`）** —— 视觉模型审核是否启动。
   设 `false` → `sd_inject` 生成的命令追加 **`-NoVlmReview`**：
   **不探活、不冷启动、不加载模型、不打分**（连「画风=一致」的参考图识别也不调模型，见 `Get-ImageStyleByVlm` 的提前返回），
   直接按迭代次数出满 N 张弹多选让你自己挑。日志会明确打印「视觉模型审核已关闭（-NoVlmReview / 插件设置 vlmReview=false）」。
2. **模型默认换成 `qwen3.6-fable`**（`sd-inject.ps1` 的 `-VlmModel` 默认值 + 插件设置 `vlmModel`，会写成 `-VlmModel "<模型名>"`）。
   ⚠️ 如实说明两点：
   - 本机现有模型是 `qwen3-vl:8b` / `qwen3.5:latest` / `qwen2.5-coder:7b` / `qwen2.5-abliterate:14b`，**没有 `qwen3.6-fable`**；
   - Ollama 官方库里也查不到这个名字（`https://registry.ollama.ai/v2/library/qwen3.6-fable/manifests/latest` → **HTTP 404**），
     所以 `ollama pull qwen3.6-fable` 会失败；要真用它得 `ollama create qwen3.6-fable -f Modelfile` 自建/导入，
     或者把插件页 `vlmModel` 改成已有模型（例如 `qwen3-vl:8b`）。
   - 脚本侧已做的兜底：指定模型不在本机时打印「本机枚举到哪些 + ollama pull / ollama create 两条路」，
     然后回退到本机第一个 `vl`/`vision` 模型继续出图（不阻断）。
3. **审核范围扩到整条人物肢体**（问句从「脸 + 手」扩到三类）：
   ① 脸部（对称/无多余/五官错位/畸形融化）② 手部（五指齐全/多指少指/扭曲粘连）
   ③ **肢体（手臂与腿是否各两条、左右对称、多肢少肢、关节反向错位、四肢畸形粘连、躯干与四肢比例失衡）**。
   `-FaceBoostTags` 与出图参数不受影响（审核只打分，不改提示词）。

**验证**：`node smoke-skill.mjs` 十三段全绿——新增 `VLM-REVIEW-SWITCH SMOKE OK`
（源码断言：`-NoVlmReview` 开关、默认模型 `qwen3.6-fable`、问句三类齐全、`ollama create` 提示、
关掉审核后画风识别提前返回；运行断言：`vlmReview=false` → 命令带 `-NoVlmReview`；
`vlmModel='my-vl:7b'` → 命令带 `-VlmModel "my-vl:7b"`；默认命令带 `-VlmModel "qwen3.6-fable"` 且不带 `-NoVlmReview`）。
文档同步：README（模型表/问句/降级表/参数表/插件设置表）、`docs/models-loras.md` 第 4 节（视觉审核 + 自建/回退说明）。

## 0.9.19（插件页开关「是否启动」你自己选 + 修掉「抠图脚本没有输出」）

**需求（用户原话 + 截图）**：截图里对话侧走到「按参考图内容抠『衣服』蒙版」这一步失败，
日志最后一句是「对话侧：蒙版没画出来（抠图脚本没有输出）→ 表单蒙版栏保持可编辑，请你填 box:/路径/区域名」；
用户要求：在插件页加个开关，是否启动可以自己选。

**① 插件页新增开关 `maskAutoSegment`（默认 `true`）**

- `sd-bridge.js` 新增配置项：C 档是否允许**自动抠图**（YOLO-World + SAM 现算蒙版）。
  设为 `false` 时 `sd_inject` 生成的命令追加 **`-NoAutoMask`**：整条抠图不跑（**不加载检测模型、
  不启动那条 python 链路**），改用几何区域蒙版（上半/下半/中间/四周）或表单里手填的 `box:` / 蒙版图。
- 与 v0.9.18 的 `vlmAutoStart` 并列，两个开关都在插件设置页上（配置 schema 注册，改完重启 dsh 生效）。

**② 「抠图脚本没有输出」的真根因（本机复现并已修）**

真机复现（同一条命令、同一张参考图）：

| 尝试 | 结果 |
| --- | --- |
| `--device auto`（当时剩余显存 6.9G → 走 cuda） | **进程原生崩掉**：stderr 停在 `YOLO-World 文字提示检测中…`，stdout **一行 JSON 都没有** → PowerShell 只能报「抠图脚本没有输出」 |
| `--device cpu` | **`ok:true`，覆盖 13.01%**（与之前 cuda 成功那轮的结果一致） |

也就是说：**崩的不是 SAM，是检测模型（YOLO-World）那一侧的 CUDA**，而且崩得没有栈、没有退出码可读。

修法（三层）：

1. **失败说明不再是一句话**：`AutoMaskNote` 现在带 **python 退出码**（并对 `0xC0000005` 这类异常退出直接点明
   「多半是显存不足/CUDA 崩溃」）+ **stderr 最后 6 行**。
2. **自动用 CPU 重试一次**：`New-AutoMaskFromImage` 拿到空输出时自动带 `--device cpu` 重跑，
   并把「自动改用 CPU 重试一次」打印给用户（实测 CPU 结果与 GPU 逐像素一致，只是慢些）。
3. **抠图失败不再 `exit 1`**：以前引用 `不会退回整图重绘…请改用 ① ② ③` 后直接退出，用户拿到的是「什么都没出」；
   现在按替换目标预填几何区域蒙版（下半（衣服）/ 上半（脸）/ 四周（背景）/ 中间（主体））继续出图，
   既不做整图重绘，也不让表单空着。对话侧预生成蒙版那条路径同样改成预填区域名。

**③ 顺带**：`sd-auto-mask.py` 新增 `--device auto|cuda|cpu`（默认 auto：按剩余显存决定，不够就整条走 CPU），
所有 ultralytics `predict` 调用都吃这个设备；并去掉 Windows 上不受支持的
`PYTORCH_CUDA_ALLOC_CONF=expandable_segments`（PyTorch 会为它打一条 UserWarning，解决不了这里的崩溃）。

**回归**：`node smoke-skill.mjs` 十一段全绿——新增 `MASK-AUTOSEGMENT-SWITCH SMOKE OK`
（断言默认命令不带 `-NoAutoMask`、`maskAutoSegment=false` 时必须带上且结构不破坏），
并新增 8 条源码断言（`-NoAutoMask` / `--device cpu` 重试 / 退出码说明 / 预填区域名 / 不再 exit 1）。

## 0.9.18（本地视觉模型关掉：插件侧开关 vlmAutoStart）

**需求（用户原话）**：本地视觉模型关掉。

**做了两件事**

1. **立刻停掉**：`Get-Process ollama | Stop-Process -Force` → 探活确认 `http://127.0.0.1:11434/v1/models`
   已不可达。冷启动这条链路本身保留（v0.9.17 刚加的），只是这次不拉。
2. **给「关掉」一个可持久化的开关**（否则下次 C 档一跑又会自动起）：
   - `sd-bridge.js` 新增插件设置 **`vlmAutoStart`**（默认 `true`）。设为 `false` 时，`sd_inject`
     生成的命令会在末尾追加 **`-NoVlmStart`**：服务没起就跳过质检（出满 N 张让你自己挑），
     **绝不偷偷拉起本机模型服务**。
   - 本机已直接把 profile 补丁层写成关：
     `C:\Users\zhang\.dsh\profiles\desktop\cordis.patch.yml`
     ```yaml
     - id: sd-bridge
       disabled: false
       config:
         vlmAutoStart: false
     ```
     （补丁层是**启动时**读的，所以这条要**重启 dsh** 才在会话里生效；要恢复冷启动把 `false` 改回 `true`
     或删掉这段 `config`。）
   - 也可以在单条命令上临时覆盖：命令里带 `-NoVlmStart` 即关，带不带开关都不影响出图。

**回归**：`node smoke-skill.mjs` 十段全绿，新增 `VLM-AUTOSTART-SWITCH SMOKE OK`——
断言「默认命令**不带** `-NoVlmStart`」与「`vlmAutoStart=false` 时命令**必须以 `-NoVlmStart` 结尾**
且结构不被破坏」。PS 5.1 `parse errors = 0`；包内/工作区/release 三份脚本 SHA256 一致。

## 0.9.17（本地视觉模型加入冷启动 + C 档跑完只留成品）

**需求（用户原话）**：本地视觉模型加入冷启动，然后在 c 档脚本完成后删除产生的额外图片。

**① 本地视觉模型（Ollama）冷启动**

- 问题：脸/手质检与「画风=一致」的参考图识别都靠本机 Ollama 上的 `qwen3-vl:8b`。以前它没起就直接降级——
  打印「本地视觉模型不可用」→ 素体只出一张、最终出图变成**「出满 N 张让你自己挑」**。用户看到的就是「插件没质检」。
  README 里那套 `-NoQwenStart` / `-QwenStartTimeout`（翻译链路）**早已整体移除**（回归断言在守着），
  所以解析侧一直没有任何自动拉起本地模型的逻辑。
- 修：新增 `Start-OllamaService`（`sd-inject.ps1`）——探活失败就 `Find-Ollama` 找 `ollama.exe` →
  `Start-Process -WindowStyle Hidden ollama serve` → 轮询到就绪（默认 60s，`-VlmStartTimeout` 可调），
  失败只降级不阻断。开关 `-NoVlmStart`（不自动拉起）。**接在三处**：
  1. SD 预热之后、弹表单之前（表单确认后马上要质检，别等素体迭代才发现没起）；
  2. 素体质检前置（`Invoke-BaseIterate` 的 `$vlmOk` 判定）；
  3. `Get-ImageStyleByVlm`（画风=一致 的参考图识别）。
- 另加 `Get-FreeVramGb` 显存提醒：8G 卡上 SD 常驻时，8B 视觉模型装不进显存（会走 CPU / 部分卸载），
  这时明确打印「这次质检会明显变慢」，而不是让用户以为卡死（质检请求本身 180s 超时兜着）。
- **真机验证（本机 Ollama 当时是停的）**：`Test-VlmApi` 先为 False → 冷启动 → **7.9 秒就绪** →
  枚举到 `qwen3-vl:8b | huihui_ai/qwen2.5-abliterate:14b | qwen2.5-coder:7b | qwen3.5:latest`，
  目标视觉模型 `qwen3-vl:8b` 在机内。也就是说这条链路以前是「静默降级」，现在会真的跑起来。

**② C 档跑完只留成品（中间图自动清理）**

- 以前产物目录会堆**中间图**：对话侧预生成的蒙版 `premask-<hash>-<target>.png` 与它的叠加预览
  `..._overlay.png` 落在产物目录里；命中率总览图也会落在那。用户要的是「跑完只剩成品」。
- 修：新增 `Add-RunWorkFile` / `Remove-RunWorkFiles` 记账式清理。
  - 预蒙版仍**必须先留在产物目录**（表单要把它填进「蒙版」栏并用它出图），所以是**跑完再删**；
  - 命中率总览图改为写进迭代临时目录（随目录一起清），`-KeepWorkFiles` 时才复制到产物目录；
  - 成品保存 / 质检降级多选 / 最终失败（退出前）三条路径都会清一遍；`-KeepWorkFiles` 则保留并列出路径备查；
  - 清理时逐个打印「已清理中间图: xxx」，不做静默删除。
- 真机验证：`test-vlm-cleanup.ps1`（新增，真跑）——合成「成品 + 预蒙版 + 预蒙版叠加图 + 命中率总览图」，
  断言默认只留成品、`-KeepWorkFiles` 全留并列出、`-NoVlmStart` 不 spawn serve、
  冷启动 spawn 后超时能优雅降级且不抛异常。

**回归**：`node smoke-skill.mjs` 九段全绿（新增 `VLM-COLDSTART+CLEANUP SMOKE OK`，并校验旧回归
「翻译链路已移除」不被新参数名污染）· `test-region-mask.ps1` 13/13 · `test-mask-qa.ps1` 全绿 ·
`test-vlm-cleanup.ps1` 9/9 · PS 5.1 `parse errors = 0`（BOM 在位）。

## 0.9.16（抠图不再被显存打挂 + 衣服多块合并 + 新增「蒙版命中率体检」）

**用户场景**：拿「把衣服蒙版重绘成裸体」当极端用例，人工审阅蒙版命中率（残留衣料一眼可见）。结果「生成还是混乱」。

**先说结论（用像素量出来的，不是猜）**：这一轮的蒙版**本身是好的**，混乱不是蒙版漏检造成的。

| 指标（832×1216 那轮） | 数值 | 含义 |
| --- | --- | --- |
| 蒙版覆盖 | 13.01% | 罩住裙子本体 |
| 蒙版内**已改** | 9.48%（占蒙版 **72.9%**） | 蒙版命中了 |
| 蒙版内未改 | 3.53%（占蒙版 27.1%） | 那块本来就是要留的躯干/肌肤 |
| **蒙版外被改（外溢）** | **0.03%（占蒙版外 0.02%）** | 边界干净，几乎没有外溢 |
| 蒙版外保留 | 86.96%（占蒙版外 99.98%） | 画风/背景天然不变 |

也就是说：**乱的那部分全在蒙版内**，是模型对提示词的回答 —— 提示词写的是
`nude, naked, topless, undressed, no clothes, removing clothes, clothes off, undressing, strip, revealing outfit`，
于是它老老实实画了「正在脱衣服」：半脱的布料、残留的暗色衣影。
用「脱衣」提示词去测蒙版有个自带陷阱：**模型会主动画出「半脱的衣服」**，看起来像蒙版漏了，其实那块像素**已经改过**。

**这一轮真正发现并修掉的两个真 bug（都复现过）**：

1. **SAM 抠图被显存打挂 → 整条替换路径拿不到蒙版**。
   同一个参考图、同一条命令：22:10 抠得出（13.01%），23:16 直接 `RuntimeError: CUDA error: out of memory`
   （notes 原文：`2.57 GiB free`，ViT-L 需要更多）。旧代码只把异常写进 notes，然后 `ok:false` →
   PowerShell 侧报「没抠出任何区域」→ **用户看到的就是「蒙版没生效」**，而且**时好时坏**。
   - 修：`sd-auto-mask.py` 加显存自适应阶梯 —— 剩余 ≥4.5G 才按 `--sam-side` 全分辨率跑 cuda；
     3.0–4.5G 降到 640px；**<3.0G 直接改走 CPU**（ViT-L 慢但绝不 OOM）。
   - 再兜底：SAM 万一还是挂，用 YOLO-World 的检测框生成**粗蒙版**（与人物剪影相交、必要时裁到躯干带），
     `ok:true` 而不是整条失败。
   - 验证：修后同一条命令重跑 → `ok:true`，coverage 13.01%（31.8s），与 22:10 那轮一致。

2. **衣服蒙版「只留最大连通块」**：同一件衣服被 SAM 拆成多块时，旧逻辑只保留最大的一块，袖子/裙摆那一侧整个丢掉。
   （实测这张图 7 块里 6 块都小于最大块的 18%，确实是蝴蝶/花点碎块，所以这一条**对这张图不改结果**，
   但同类图——多件套、披风、围巾——会直接丢掉一块。）
   - 修：衣服按「≥ 最大块 18% 且总覆盖 ≤32%」保留同件的多块；其他目标维持「只留最大块」。

**新增：蒙版命中率体检（`sd-mask-qa.py`）—— 不再靠「极端提示词 + 肉眼」**

- 输入「参考图 / 本次蒙版 / 本次成品」三方，逐像素判四类：**命中 / 命中未改 / 外溢 / 正确保留**，
  另附「疑似漏掉衣料」（蒙版外、没变、比局部更暗、贴着蒙版），输出数字 + 一张总览图
  （绿=蒙版内已改 / 黄=蒙版内未改 / 红=外溢 / 品红=疑似漏掉衣料）。
- **C-1b 出图后自动跑**：日志里直接给百分比与总览图路径（产品旁边一张 `qa-<成品名>.png`），
  换中性提示词（如「把衣服换成红色长裙」）时，蒙版外的残留衣料就是漏检 —— 不需要任何极端内容。
- 新增真跑测试 `test-mask-qa.ps1`：合成一张「已知答案」的三联图（蒙版 24.41%、命中 24.41%、
  外溢 0.81%、保留 74.77%），断言工具报出的数字与解析解一致；已接入 `smoke-skill.mjs`。

**验证**：`node smoke-skill.mjs` 八段全绿（新增 `MASK-QA SMOKE OK`）· `test-region-mask.ps1` 13/13 ·
PS 5.1 Parser `parse errors = 0`（BOM 在位）· 真机复跑抠图 `ok:true`。

## 0.9.15（C 档蒙版真跑修复：`四周（背景）`整条路径静默死掉 / 区域蒙版改按最终出图尺寸画 / 补真跑回归）

**症状（用户）**：C 档蒙版功能不完善——选「四周（背景）」或让脚本自动判成换背景时，蒙版起不到作用（拿不到蒙版 → 退到整图重绘那一档，原图等于白给）。

**根因（已用真跑确认，不是猜的）**：`sd-inject.ps1` 的 `New-RegionMask` 里 **`$rects` 从来没初始化**。

- `$rects += @{...}` 从 `$null` 起步，PowerShell 得到的是 **Hashtable**，不是数组；
- 环形（`四周（背景）` / `边缘`）要连加 4 块矩形，加到第二块就抛
  `Item has already been added. Key in dictionary: 'Y'`；
- 这个异常把 `New-RegionMask -Spec '四周（背景）'` 整句打断 → `$finalMask` 为空 →
  决策树落到 C-1a（提示「蒙版区域认不出 → 退回整图重绘」）→ **用户看到的就是「蒙版没生效、原图被重画」**；
- 单矩形形状（上半/下半/中间/box）只是**碰巧**还能用：`foreach` 一个 Hashtable 会把它自己当一项，而 `.X` 恰好就是键访问——所以之前的「像素校验」才会全绿，坑一直藏到环形。

**修复（`sd-inject.ps1`）**：

1. `New-RegionMask` 开头补 `$rects = @()` 与 `$shape = ''`，并删掉 `if ($shape -eq 'box') { $rects = $rects }` 这句空操作（那正是忘写初始化的痕迹）。
2. **区域蒙版改按「参考图的最终出图尺寸」生成**：原先按表单比例/画质尺寸画，然后出图尺寸又被参考图覆写、蒙版再被最近邻缩放一次——`boxpx:x,y,w,h` 会被当成**表单尺寸**的像素（区域整个错位），区域名也要多挨一次缩放。现在抽出 `Get-RefOutputSize`，C-1a / C-1b **共用同一个尺寸**，蒙版在画之前就把尺寸定好；只有「用户自带蒙版图」才走缩放对齐。
3. 文案不再误导：区域名认不出时打印的是「改走图生图·一致（收敛 denoising）」，不再宣称「退回整图重绘」（实际并没有整图重绘）。

**回归（新增真跑测试，这是本次最该补的一课）**：

- 新文件 `test-region-mask.ps1`：用 **PowerShell AST 从 `sd-inject.ps1` 抽出真函数**（不复制代码，避免两份漂移），对 9 种蒙版写法逐个生成蒙版并**量白像素比例**，另测 `Get-RefOutputSize` 的 8 倍数 / 长边 ≤1536 / 长宽比不失真；任一不符就 `exit 1`。
- `smoke-skill.mjs` 新增：源码断言（`$rects = @()` 必须存在、环形必须真有 4 块矩形进了 `$rects`、区域蒙版必须按最终出图尺寸生成）+ **spawn 真跑 `test-region-mask.ps1`**。
  —— 以前这个函数只有源码正则、一行都没真跑过，这就是它能一路发版的原因；现在测试本身会跑出 `REGION-MASK TEST OK`。

**验证（真跑数字，512×768）**：

| 蒙版写法 | 白像素 | 说明 |
| --- | --- | --- |
| `box:0.2,0.45,0.6,0.5` | 30.1% | 0.6×0.5=30% ✅ |
| `boxpx:100,200,400,300` | 30.5% | 400×300/512×768 ✅ |
| `box:0.2,0.45,0.6,0.5` + 反选 | 69.9% | 补集 ✅ |
| 下半（衣服） | 30.1% | ✅ |
| 上半（脸） | 16.1% | ✅ |
| 中间（主体） | 36.7% | ✅ |
| **四周（背景）** | **51.3%** | 修复前 **抛异常**；环形面积 1−(328×584)/(512×768)=51.3% ✅ |
| **四周（背景）反选** | **48.7%** | 修复前 **抛异常**；补集 ✅ |
| 乱填 | 空 | 认不出 → 返回空（落到 C-1a）✅ |

尺寸推导：1024×1024 → 1024×1024；1200×2000 → 920×1536；2496×3648 → 1048×1536；100×100 → 96×96（8 的倍数、长边 ≤1536、长宽比不漂）。

回归面：`node smoke-skill.mjs` 全绿（含新 `REGION-MASK SMOKE OK`）、`test-install-record.mjs` 全绿、`test-settings.mjs` 全绿、PS 5.1 Parser `parse errors = 0`（UTF-8 BOM 已确认在位）。

**已知与本修复无关**：`test-install-catalog.mjs` 的干跑用例（`install-sd.ps1` 干跑）在本机超过它自己 120 秒的 timeout 被 kill（`status=null`）；手动跑同一命令 >400 秒仍未结束，属于安装器预检慢的环境问题，与蒙版改动无关。

## 0.9.14（图生图「和原图没关系」三连修：底图必须真正生效 / C-1a 跟参考图尺寸 / 蒙版坐标框）

**症状（用户）**：图生图和原图完全没关系了。

**根因（三条，全部实测确认）**

1. **底图被静默替换**：图生图时若「底图」栏为空（对话没能把参考图传进 `-InitImage`，或传进来的不是可直接使用的文件路径），旧逻辑会**悄悄**去拿「输出目录最新一张」——经常抓到无关文件（表单截图、别的会话产物、上一轮放大图）→ 出图当然和用户心里的原图没关系。
2. **底图解析吃不下附件形态**：对话常把 `图片 sha256:…`、`xxx.png [8a34ca32]`、带说明文字的无后缀路径传进来，旧解析直接判「文件不存在」→ 落回第 1 条的静默替换。
3. **C-1a 用表单比例/画质当出图尺寸**：参考图 1024×1024 被压成 480×853，A1111 会拉伸/裁切底图，构图一变观感就是「没关系」；另外 denoising 填大了会把原图洗掉（同样表现为没关系）。

**修复（`sd-inject.ps1`）**

- **不再猜**：图生图且底图为空 → **红字报错并给出三种填法**（路径 / 「浏览…」/ 显式填「最近」），绝不静默换成最新一张；显式给了底图但解析失败 → 报出具体原因（`$script:LastInitFail`），并提示「附件哈希不是文件路径」。
- **解析能力补齐**：支持关键词（最近/最新/上一张…）、绝对/相对路径、**带哈希装饰的引用**（`sha256:…`、`[8a34ca32]`）、**从说明文字里抠出附件路径**，并会去 `输出目录`、`<工作区>\ref`、`DSH 附件目录` 里按哈希找图。
- **C-1a 尺寸跟参考图走**（长边 >1536 时等比收），并打印「底图 = …（原图 WxH），出图尺寸 WxH」；denoising 收敛（>0.65 提示并压到 0.65，要大改请用「替换 + 蒙版」）。
- **蒙版精度**：`mask` 支持**精确坐标框** `box:x,y,w,h`（0-1 归一化）与 `boxpx:x,y,w,h`（像素），仍支持区域名与「反选」；蒙版尺寸与最终出图尺寸不一致时**自动缩放对齐**（`region-mask-scaled.png`），避免区域错位。
- **提示词合并顺序**：替换任务（换衣服等）**用户新指令在前**；一致任务（只改画风/整体贴近）**参考图词在前**，保证与原图一致。

**验证（本机真跑 + 数字）**

| 项目 | 结果 |
| --- | --- |
| **底图是否真生效（关键）** | 同 seed 12345 同提示词：**img2img 距参考图 11.05/255**，而 **txt2img 对照 52.7/255** —— 差 ~4.8 倍，底图确实在起作用 |
| C-1a 尺寸 | 跟参考图走：`c1a-new-size_001.png` 1024×1024 与原图构图一致（旧行为 `c1a-old-size` 480×853 明显重新构图） |
| 坐标框蒙版 | `box:0.2,0.45,0.6,0.5` / `boxpx:100,200,400,300` / 带「反选」三种写法，采样点像素校验全部符合预期 |
| 蒙版重绘保真 | 未蒙版区（脸/头发/樱花）平均差 **0.00**、最大差 0；蒙版区确实被换掉 |
| 回归 | `smoke-skill.mjs` 新增 10 条断言（报错不许静默回落、哈希/附件解析、C-1a 尺寸与 denoising 收敛、box/boxpx、蒙版缩放、两种合并顺序）；四条测试全绿；PS7 + PS5.1 双 Parser + BOM 齐备 |

**顺手清掉的两个文本 bug**（上一轮改动带进来的）：技能正文里 `\b` 被 JS 当成退格字符 → `box:` 显示成 `ox:`（已还原），以及两处重复行。

## 0.9.13（对话判断任务类型 + 直接提交蒙版区域；文生图锁底图/蒙版）

**需求（用户原话）**：切换思路 —— 让**对话**判断任务类型（C 档文生图 / C-1 图生图），并在 C-1 时**直接提交蒙版区域**；文生图时，**底图、蒙版两个选项锁定**。

- **工具层（`sd-bridge.js` / `sd_inject`）**：新增三个参数 ——
  - `task`：`文生图` / `图生图`（**由对话判断后提交**，不问用户）；
  - `refImage`：图生图的底图路径；
  - `mask`：蒙版区域（`下半（衣服）` / `上半（脸）` / `中间（主体）` / `四周（背景）`，可加「反选」，也可填蒙版图路径）。
  `task`/`refImage`/`mask` 会写进**生成的命令**与**启动器参数**（`-Mode` / `-InitImage` / `-MaskSpec`），命令复制出去照样带这些预置。
- **脚本层（`sd-inject.ps1`）**：新增 `-Mode` / `-MaskSpec`；表单按它们**预置**「模式」与「蒙版」。
- **表单锁定**：模式 = 文生图 → **「底图」文本框、「浏览…」按钮、「蒙版」下拉全部锁定**（灰掉不可编辑），并把提示改成「（文生图：不需要底图/蒙版，已锁定）」；切到图生图则自动解锁、并把之前填/对话提交的蒙版值**还原**回来。
- **技能正文**：明确要求对话自己判断任务类型、自己决定蒙版区域并提交（换衣服→`下半（衣服）`、换脸→`上半（脸）`、换背景→`四周（背景）`；只改画风则 `mask` 留空走 C-1a）。
- **验证**：
  - 真实工具链路（直接 import 磁盘上的最新 `sd-bridge.js` 跑 `sd_inject`）：图生图+蒙版 → 命令带 `-Mode "图生图" -InitImage "…" -MaskSpec "下半（衣服）"` ✔；文生图 → 只带 `-Mode "文生图"`、**不带** `-InitImage/-MaskSpec` ✔；图生图不替换 → 不带 `-MaskSpec` ✔；
  - 表单锁定实测（真控件）：对话提交文生图 → 底图框/浏览/蒙版 `Enabled=False` + 提示文案正确；对话提交图生图+`下半（衣服）` → 三项可用且蒙版已预填；**来回切模式动态锁定/还原** ✔；
  - `smoke-skill.mjs` 新增 9 条断言（三个参数、枚举、命令与启动器透传、`-Mode/-MaskSpec` 参数、表单预置、锁定与提示文案、技能正文），四条测试全绿；PS7 + PS5.1 双 Parser `SYNTAX OK`、UTF-8 BOM 齐备。
- **注意**：dsh 宿主里注册的工具定义是**启动时载入**的 —— 新参数要**重启 dsh** 才会在会话里出现（脚本与命令模板已就绪，`smoke`/直跑验证均针对磁盘上的最新代码）。

## 0.9.12（C 档决策树：文生图 / 图生图·一致 / 图生图·替换（蒙版重绘））

**需求（用户原话）**：C 档图生图一致性太差，换个衣服结果连画风都变了；要在表单里能选「文生图 / 图生图」；下面的**模型、画风**要提供「**一致**」选项；上传图片 + 选图生图 + 一致 → **自动检测画风、主体**并写进提示词，尽量与参考图保持一致；如果执行的是**替换**（衣服、脸、背景等）→ 进入决策 **C-1**，脚本里用**蒙版指令**。

**实现（`sd-inject.ps1`）**

1. **表单新增「模式：文生图 / 图生图」总开关**，并联动：切到图生图 → 画风自动切「一致（自动检测参考图）」、Denoising 默认 0.45；切回文生图 → 画风回「二次元」、Denoising 0。
2. **画风下拉新增「一致（自动检测参考图）」**、**模型下拉新增「一致（照参考图）」**（空映射/不切换的语义都写进注释，不是漏写）。
3. **参考图解析链**（逐级兜底，任一级失败都不报错、只是降级）：
   - `Get-PngGenParams`：读参考图里 A1111 的 PNG 元数据 → 拿到**它的模型 + 原提示词/负向词**（我们自己出的图 = 一致性最强）；
   - `Get-ImageStyleByVlm`：本地视觉模型（Ollama）判画风档位（可选增强，没开就跳过）；
   - `Get-ImageTags`：调 A1111 `/sdapi/v1/interrogate` 反推标签（**dm 图走 deepdanbooru，照片走 clip**）。
4. **一致性合并 `Merge-ConsistencyPrompt`**：用户的新指令放**最前**（优先级高），参考图的词接在后面，并按**替换目标剥掉冲突标签**（换衣服 → 剥掉 dress/skirt/kimono 等衣服类标签；换背景 → 剥掉 sky/tree/room 等）→ **换内容但画风与主体不变**。
5. **替换识别 + 区域蒙版**：`Get-ReplaceTarget` 从指令里判「衣服 / 脸 / 背景 / 未指定」；`New-RegionMask` 现场生成区域蒙版（上半（脸）/ 下半（衣服）/ 中间（主体）/ 四周（背景），后缀「反选」取补集），也可在表单里**填蒙版图路径**。
6. **决策分支**（脚本会打印分支，便于核对）：
   - **C-0 文生图** → 忽略底图与蒙版，用完整提示词直出；
   - **C-1a 图生图·一致** → 底图 + denoising 0.4-0.5 贴底图，提示词已并入参考图的词；
   - **C-1b 图生图·替换** → **蒙版重绘**：`Invoke-FinalIterate` 新增 `-Mask` / `-InpaintFill`，透传给 `sd-direct.ps1`（`inpaint_full_res` + padding 32），并按**参考图原生尺寸**出图 → **未蒙版区域像素级原样保留**。
7. 图生图没填底图 → 自动用**输出目录最新一张**；再没有就红字报错（不再默默退回文生图）。

**实测踩的坑（都已修）**

- PNG chunk 长度是**大端**：第一次用 `BitConverter`（小端）读出来是垃圾长度、一个元数据都拿不到 → 手写大端解析。
- 蒙版填充模式：`fill=2`（潜空间噪声）在蒙版区**留满噪点**（实测相邻粗糙度 199）、`fill=1`（保留原图）出糊块（43）→ 默认改 **`fill=0`**（9.7，正常图像），并在代码里注明原因。
- 区域框不能铺满整幅宽度（会把背景/头发一起重画，实测出糊块）→ 收紧成中心框。

**验证（本机真跑）**

- **C-1b 像素级验证**：以 1024×1024 参考图 + 「下半（衣服）」蒙版跑蒙版重绘 → **未蒙版区（脸/头发/樱花）平均差 0.00 / 最大差 0**（完全一致），蒙版区平均差 273.84（确实被换掉）；换 fill/分辨率四组对照全部满足「未蒙版区 0 差」；
- **配方对照**：fill=2 / fill=1 / fill=0 × 全图分辨率 vs 仅蒙版，四组数值与出图目视比对，最终定 fill=0（见图 `SD-Picture\v1..v4`、`c1b-dress-final_001.png`）；
- **参考图解析链**：真实图命中 `Model=AWPainting_v1.2` + 原提示词/负向词；`deepdanbooru` 反推返回 60+ 标签；Ollama 未开时 VLM 档返回空并静默降级 ✔；
- **合并逻辑**：换衣服保留 13/16 标签（剥掉衣服类）、换背景保留 14/16（剥掉背景类）✔；
- **区域蒙版像素校验**：下半→顶黑中白底白、上半→顶白、四周→环形、反选→中心白、乱填→返回空 ✔；
- **表单联动**：切图生图 → 画风=一致 + Denoising=0.45 且画风词被正确剥离；切回文生图 → 二次元 + 0；模型下拉首项显示真实当前模型 ✔；离屏渲染确认 726px 布局无重叠（`SD-Picture\form-v0912-modepicker.png`）；
- `smoke-skill.mjs` 新增 16 条断言（模式/蒙版/一致档、PNG 大端解析、反推、区域蒙版、替换识别、一致性合并、`-Mask/-InpaintFill` 透传、fill=0 默认、技能写明决策树），四条测试全绿；PS7 + PS5.1 双 Parser `SYNTAX OK`、UTF-8 BOM 齐备。

## 0.9.11（画风对应修好：「二次元」这一档以前压根没有映射、也不会切回动漫底）

**症状**：C 档表单里选「二次元」，出来的却是半写实/写实图 —— 用户反馈「画风对应出问题了，现在二次元画风画不出来」。

**四个真缺陷（都是实测出来的，不是猜的）**：

1. **「二次元」这一档没有任何映射**：`Get-StylePrompt` 的 switch 里没有 `'二次元'` 分支（`'国风'`、`'赛博朋克'` 同样缺；`'厚涂'/水彩/像素风` 只有负向词）→ 选它等于什么都不注入。而它又是「无底图时」的**默认档**。
2. **「二次元」没有切回动漫底的规则**：画风→自动切模型是**持久**的（`写实 → majicMIX`、`彩色哥特 → SemiRealMix` 之后 SD 就一直停在写实底），旧规则只覆盖 写实 / 写实二次元 / 彩色哥特 → 选「二次元」不会切回来。**实测现网 SD 当时正停在 `SemiRealMix.safetensors [385ea18efa]` 上**，所以「二次元词 + 半写实底」= 画不出二次元。
3. **默认档根本不注入**：`$cboStyle.SelectedIndex = 1` 是在 `Add_SelectedIndexChanged` **之前**设的 → 用户「不动下拉、直接点确定」时一个画风词都没有（正是最常见的用法）。
4. **反复切画风会把逗号越堆越多**：剥离只做 `Replace`，留下 `", "` 尾巴，下次注入再补一个 → 实测连切三次后正向词变成 `1girl, solo, silver hair,,, anime style, ...`（多余的 `,,` 空标签）。

**修复（`sd-inject.ps1`）**：

- **映射补全 12/12**：「二次元」（线稿 + 赛璐璐平涂 + 动漫眼 + 压 3D/照片）、「国风」、「赛博朋克」新增；「厚涂/水彩/像素风」补齐正向词；「保持画风」显式写成空映射并注明这是它的语义（不是漏写）。
- **「二次元」强制切回动漫底**：新增 `Get-AnimeCheckpoint`（**优先 AWPainting**，其次 anything / ReVAnimated / dark sushi / 二次元 / 动漫 / anime），用户没在表单里手动选模型时自动切换，并打印「当前底子是 X（不是动漫底）→ 自动切回动漫底 Y」。
- **「写实二次元/东亚脸」补一条**：当前底是写实向时**先切回动漫底**再挂半写实 LoRA（原来会直接把 LoRA 挂在写实底上，更糊）。新增 `Test-RealisticCheckpoint` 做判定。
- **表单模型下拉首项显示真实当前模型**：`（当前模型：SemiRealMix.safetensors [385ea18efa]）` —— 新增 `Get-SdCurrentModel`；用户一眼就能看出「看着二次元、其实在写实底上」。解析同步改为前缀匹配。
- **初始档位补注入**：挂完事件后按当前档位再注入一次，默认「二次元」从此也有词。
- **提示词净化**：新增 `Add-StyleWords` / `Remove-StyleWords`（连续逗号折叠、首尾不残留空标签），表单联动改走这两个函数；送 SD 前再加一道同样的净化（脸部词/LoRA 追加也会产生 `,,`）。

**验证（全部真跑）**：

- 画风映射表逐个实测：12 个下拉档位全部有映射与/或明确空映射 ✔；
- 表单联动实测（真控件、真事件）：切 `写实`→`厚涂`→`保持画风`→连切三次 `二次元`：词正确替换、无重复、**无 `,,` 残留** ✔；构建完成时默认档已带二次元词 ✔；模型首项显示真实当前模型 ✔；
- 动漫底选择用**本机真实 checkpoint 列表**验证：命中 `AWPainting_v1.2.safetensors [3d1b3c42ec]` ✔；写实底判定对 `SemiRealMix`/`majicMIX` = True、对 `AWPainting`/`ReVAnimated` = False ✔；
- **同 seed（12345）同提示词前后对比实拍**：修复后（二次元词 + AWPainting）= 干净线稿 + 赛璐璐平涂的二次元脸；故障时（同样二次元词 + SemiRealMix）= 半写实/3D 娃娃脸 —— 两张图都留在 `SD-Picture\anime-after-fix_001.png` / `anime-before-fix_001.png`；
- `smoke-skill.mjs` 新增 11 条断言（**下拉里每个画风都必须有映射**、二次元必须含 `anime style`/`cel shading`、必须有 `Get-AnimeCheckpoint` 且优先 AWPainting、必须有二次元切模型规则、必须有当前模型探测与净化函数），并校验断言解析输入非空（12/12，不是真空通过）；四条测试全绿；PS7 + PS5.1 双 Parser `SYNTAX OK`、UTF-8 BOM 齐备。

**附带说明**：`sd-direct.ps1` 用 `-Checkpoint` 出图后会**还原原来的模型**（实测末尾打印「已还原模型: SemiRealMix…」），所以这里的「切模型」只影响本次出图，不会把用户的 SD 状态永久改掉。

## 0.9.10（坑34：迭代目录必须可写 —— 修外部用户报的「工作区一张成品都没有」）

**来源**：外部用户实测反馈（他的环境：DSH `workspace-write` 沙箱 / 工作区 `E:\...\default-workspace` / SD 在 `F:\AI\sd-webui-aki-v4.11.1-cu128`）。症状是「外面看得见图，工作区里什么都没有」。

- **根因链（他给的证据与代码完全对得上）**：
  1. `sd-inject.ps1` 把迭代目录建在 `[System.IO.Path]::GetTempPath()`，即 `C:\Users\<用户>\AppData\Local\Temp\sd-inject-iter-xxxxxxxx`；
  2. DSH 的 `workspace-write` 沙箱 ACL **只放行会话工作区**，用户 temp 根被拒写；
  3. 插件是用 `cmd start` 拉起**独立窗口**（`sd-bridge.js` 的 launcher + spawn），这条链路不经过会给 TMP/TEMP 改道的受限子进程 → `GetTempPath()` 落在不可写目录；
  4. 于是 `sd-direct.ps1` 落盘被拒 → 非 0 退出 → `sd-inject.ps1` 判 `$LASTEXITCODE` → 打印「素体出图失败，中止迭代」→ `exit 1`；
  5. **致命点在顺序**：三处把成品复制进 `-OutDir` 的 `Copy-Item` 全在迭代**之后**，脚本提前退出就永远执行不到 → 工作区空手；而 SD 自己的 `outputs\txt2img-images\<日期>\` 照旧有图（观感上「明明出了图」）。
- **修复（`sd-inject.ps1`）**：
  - 新增 `Test-DirWritable`：**真写一个探针文件再删**，而不是只看 `Test-Path`（后者会把「存在但被 ACL 拒写」误判成可用——正是本次误判来源）。
  - 新增 `Resolve-IterRoot`：**工作区优先 + 逐级兜底**——`-IterDir`（新参数，可显式指定）→ `<OutDir 的父目录>\.sd-inject-iter`（正常就是会话工作区）→ `$PSScriptRoot\.sd-inject-iter` → 系统 temp（旧行为兜底）；每级都拿探针验过，跳过的会打印原因。
  - **要么可写、要么明确报错**：四级全不可写时列出所有尝试过的路径并 `exit 1`，不再静默走到「找不到本轮产物」。
  - **`-OutDir` 提前探活**：不可写立刻红字说清（附「DSH 沙箱只允许写会话工作区」的提示）——以前要等十几分钟才看到「什么都没有」。
  - 清理与收尾：启动时扫「新根 + 旧 temp 根」两处残留；退出时删本次 `iter-*` 子目录，根目录空了顺手清掉（工作区不留空壳）。
  - **两处额外加固**（验证过程中踩出来的真实脆弱点）：① 清理循环遇到不存在/不可写候选时先 `Test-Path` + 整段 `try/catch`，免得在 `$ErrorActionPreference='Stop'`（启动器里就是 Stop）下把清理失败升级成流程中断；② 系统 temp 改用 `try/catch` + `TEMP/TMP/USERPROFILE` 多来源兜底求值——`[System.IO.Path]::GetTempPath()` 在个别受限宿主下会返回空字符串，直接喂 `Join-Path` 会抛「参数 Path 为空」的致命异常，把整条兜底链打断。
- **修复（`sd-bridge.js`，从源头掐掉同类问题）**：
  - 生成的 `sd-inject-launcher.ps1` 里**先把 TMP/TEMP/TMPDIR 指向工作区内的 `.dsh-tmp`**（并建目录）再启动脚本——这个窗口是 `cmd start` 拉起的独立进程，不经过宿主给 TMP/TEMP 改道的链路；指到工作区后，任何 `GetTempPath()/$env:TEMP` 的中间产物都落在可写位置。
  - C 档命令与启动器参数都**显式带上 `-IterDir "<工作区>\.sd-inject-iter"`**（技能里的「典型形态」示例同步更新）。
- **验证（本机真跑，不是静态推断）**：
  - 从 shipped 的 `sd-bridge.js` 里**原样抽出启动器生成代码**跑一遍，再用生成出来的启动器实际拉起探针脚本：`TEMP/TMP` 均被钉到 `<工作区>\.dsh-tmp` ✔、参数里带 `-IterDir <工作区>\.sd-inject-iter` ✔、`.dsh-tmp` 已创建 ✔；
  - 把 shipped 的「迭代根选择」整段真代码抽出来以**文件方式**执行：`-IterDir` 给一个不可写候选（`Z:\nope\iter`）→ 打印「不可写，跳过」并回落 `<工作区>\.sd-inject-iter` ✔；重复执行两次（幂等 + 清理路径）✔；
  - 顺着这套根目录**真出图**：素体底图与图生图产物都实打实落在假工作区 `<ws>\.sd-inject-iter\iter-*\`（`模式: txt2img + Hires x2` → `模式: img2img (denoising=0.5)`）✔；收尾后本次子目录与空壳根都被清掉 ✔；
  - 负例：`-OutDir` 指向不可写路径 → 立刻红字报错并 `exit 1`（附沙箱提示）✔；
  - `Test-DirWritable`：不可写候选 `False`、可写目录 `True` ✔；PS7 + PS5.1 双 Parser `SYNTAX OK`、UTF-8 BOM 齐备、`npm test` 四条全绿。
- 坑13 再次踩中并已恢复：编辑工具改 `.ps1` 会剥掉 UTF-8 BOM（首三字节退化成 `# s`），PS5.1 随即按 GBK 读中文注释报 30+ 处语法错——改完这两个脚本**必须**补回 `EF BB BF` 再双 Parser 复核（外部用户报告里也踩了同一坑）。

## 0.9.9（C 档图生图真正可用：素体阶段不再因质检缺失而空手，底图可自选）

背景：0.9.8 把 Denoising 解锁后，用户本机实测**仍然出不了图生图**——日志停在「素体迭代没有可用成品 → 本次仍走文生图」。

- **根因（0.9.8 只解开了锁，没解决底图来源）**：`sd-inject.ps1` 的图生图底图**只认素体自检迭代的产物**，而 `Invoke-BaseIterate` 在两种常见情况下直接 `return $null`：
  - ① 视觉质检不可用（`Test-VlmApi` 探活失败，比如 Ollama 没开）；
  - ② 本机枚举不到 `vl`/`vision` 模型。
  用户机器上 Ollama 未运行 → 素体阶段**一张图都不出** → 没有底图 → 图生图被静默降级成文生图。等于「Denoising 解锁了个寂寞」。
- **修复（`sd-inject.ps1`）**：
  - **素体阶段不再空手**：质检不可用时改为「**仍然出一张素体底图**，只是不做脸/手质检迭代」（`$vlmOk=$false` → 单轮出图即收，`Score=-1`），底图随时可供图生图使用；预热请求也只在真会质检时才发。
  - **表单新增「底图：」栏**（文本框 + **浏览…** 文件选择 + 灰字提示）：留空 = 用素体成品；填「**最近 / 最新 / 上一张 / latest**」= 用输出目录里最新一张图；也可以直接填路径（相对路径按当前目录、再按输出目录解析）或点浏览选图。⇢ 现在换张底图迭代、拿上一张结果接着改，都不用改脚本。
  - **底图解析函数 `Resolve-InitImagePath`**：关键词/相对路径/绝对路径统一解析，解析不到只给黄字提示并回落素体成品，不静默失败。
  - **最终出图分派重写**：底图优先级 = 表单「底图」栏 > 素体成品 > **现场补一张素体底图**（异常路径也不再让 Denoising 形同虚设）；拿到任何底图且 Denoising>0 就走图生图；填了底图但 Denoising=0 → 自动按图生图默认 **0.55** 兜底并说明。
  - 传了 `-NoIterate` 且没填底图时：明确提示「要图生图请填底图或去掉 -NoIterate」，不再默默走文生图。
  - 新增命令行参数 `-InitImage`：预填表单「底图」栏（便于外部调用/脚本化）。
  - 参数行日志补上底图来源：`出图参数：… | Denoising 0.5（图生图） | 底图「最近」 …`。
- **验证（真机端到端，SD 在跑、Ollama 未开）**：抽 `sd-inject.ps1` 的**真函数**跑验收脚本 —— A) 素体阶段在质检不可用时**确实产出了底图**（`模式: txt2img + Hires x2`，seed 3064304599）；B) 图生图阶段 `模式: **img2img (denoising=0.5)**`，2.4s 出图（上一版这里会直接跳过）。另：`Resolve-InitImagePath` 9 组输入实测（空/最近/最新/上一张/latest/相对文件名/绝对路径/不存在/纯空格）全部符合预期；表单离屏渲染确认新增行不重叠（底图行 320、提示底边 360、比例行 360，按钮底边 634 ≤ 表单高 646）；PS7 + PS5.1 双 Parser `SYNTAX OK`、UTF-8 BOM 齐备、`npm test` 四条全绿。

## 0.9.8（C 档参数表单 Denoising 解锁：从「看得到改不了」变成「改了就生效」）

背景：C 档 `sd-inject.ps1` 的参数表里，Denoising 一栏永远显示为灰掉（禁用）——用户既下拉不动也手填不了。

- **根因（三段全废）**：① 表单在**素体自检迭代之前**弹出，那一刻 `-HasBaseImage` 传参恒为 `$false`（`$baseWin` 还没产生），旧代码据此执行 `if (-not $HasBaseImage) { $cboDenoise.Enabled = $false }` → 控件**每次都被禁用**；② 解析段在同一条件下直接 `$den = 0`，手填的值也被丢掉；③ 最终出图硬编码 `Invoke-FinalIterate -InitImage "" -Denoising 0`，即使前两处放行也不生效。
- **修复（`sd-inject.ps1`）**：
  - **控件恒可编辑**：删掉 `Enabled = $false` 锁定逻辑，改为恒 `Enabled = $true` 的 `DropDown`（可下拉、可手填 0-0.95）；选项表改为 `0（文生图·不用底图）` / 0.3 / 0.4 / 0.5 / 0.6 / 0.7 / 0.8 / 0.9，**默认 `0（文生图·不用底图）`**（= 现状行为，不动默认出图链路）；下方新增 7pt 灰字提示「（0=文生图；0.3-0.5 贴底图；≥0.7 重画）」。
  - **解析恒定生效**：不再按 `HasBaseImage` 归零；取文本框开头的数字（兼容带说明的条目，`0,6` 这类逗号小数也认），空值/非法 → 0（保持现状），上限钳到 0.95。
  - **最终出图按值分派**：`Denoising = 0` → 文生图（默认行为不变，仍用完整 `$positive`）；`Denoising > 0` 且素体迭代有 winning 成品 → **图生图**（`-InitImage` 素体成品 + 表单 Denoising），素体无成品（`-NoIterate`/迭代失败）则回落文生图并给黄字提示；两处都打印模式日志（`最终出图走图生图：底图 = 素体成品（seed=…），denoising = …`）。
  - **「追加为空直接收尾」捷径加守卫**：`$defaultsOnly` 追加 `$P.Denoise -le 0`——用户填了 >0 就必须真出一轮图生图，不能被「素体图即最终图」那条捷径吃掉。
- **测试**：`sd-inject.ps1` 首三字节 `EF BB BF`（坑13/19：编辑工具会剥 BOM，已按流程补回）+ PS7 与 PS5.1 双 Parser `SYNTAX OK`；**抽发布代码段做行为验证**（`0（文生图·不用底图）`→0、`0.3`→0.3、`0,6`→0.6、`1`/`2`→钳 0.95、`abc`/空 → 0）；`npm test`（smoke-skill / test-install-record / test-settings / test-install-catalog）四条全绿。
- **四处同步**：dev 仓库、插件包（`node_modules\dsh-unrestricted-printing`）、会话工作区、`release\` 的 `sd-inject.ps1` 内容一致（sha256 `15d4d407…` 相同、BOM 齐备）。原文件备份于 `dist\dsh-unrestricted-printing-backup-20261015-185331\`。

## 0.9.7（C 档选项表：A 档出图后自动罗列 + 用户自调画风进 C 档表单 + 权重/镜像清单）

背景：「整理打包」本次把插件在本机的全部相关内容（源码、脚本、模型/VAE/LoRA 权重、用户自调画风）整理成可复现的一套，并解决「A 档出图后用户不知道还能改什么参数」这个体验缺口。

- **C 档选项表（新功能）**：`sd_txt2img` / `sd_img2img` / `sd_inpaint` 三个出图工具输出 schema 新增 `quickOptions` 字段（由 `buildQuickOptions()` 生成，本次一并导出供测试断言），内容 = C 档参数表单的全部可选项：**画风 / 模型 / LoRA / 比例 / 画质 / 迭代 / Denoising**（Markdown 表格 + 用法示例 + ★ 用户自调标记）。三个工具的 `hint` 明确要求：**A 档出图后必须把 `quickOptions` 原样贴到图片下方**，用户回一句「4 号画风 + majicMIX + 3:4 + 1024p，再来一张」即可改参数重出图；`sd-paint` 技能新增「## C 档选项表（A 档出图后必贴）」章节 + 回复骨架第 7 条，附画风编号对照表。
- **用户自调画风进 C 档画风下拉（`sd-inject.ps1`）**：`Get-StylePrompt` 新增两条实测配方——**「写实二次元·东亚脸」**（窄脸型 + 杏仁眼 + 虹膜高光 + 眼神光 + 正面偏侧柔光，负向压宽脸/宽眼距/西方面孔/过曝/真人照片；沿用「动漫底子 + `<lora:semirealisticanime:0.6>` 不切模型」路径，自动切模型判断同步扩成 `-in @('写实二次元','写实二次元·东亚脸')`）与 **「釉彩调色盘」**（本机 LoRA `<lora:釉彩·麻袋调色盘_v1.0:0.8>` + 釉面/粗布色域词）。画风下拉顺序：保持画风 / 二次元 / 写实二次元 / **写实二次元·东亚脸** / 彩色哥特 / **釉彩调色盘** / 国风 / 赛博朋克 / 写实 / 厚涂 / 水彩 / 像素风。
- **触发话术写进技能**：技能首段新增提示——新对话第一句说「**打开SD插件**」、出图要求前加「**用SD插件绘制**」，可显著提高技能与工具命中率（README 同步写成对照表）。
- **新增 `docs/models-loras.md`**：本机全部权重清单（6 个 HF checkpoint + 1 个本机 ReVAnimated + 2 VAE + 4 HF LoRA/嵌入 + 7 个国内自调 LoRA），**每条带 HF 镜像直链（`hf-mirror.com`）+ sha256 + 本机文件大小与用途**，另附镜像站对照、一键拉取命令、单文件 `curl` 示例与落盘位置。
- **README 重写（版本更新内容置顶）**：新增「版本更新内容（v0.9.7）」「这样用成功率最高」「效果图（实出图）」「两个档位怎么用」「C 档选项表」「模型 / LoRA 镜像清单」「本次随机测试记录」；图片用 `docs/assets/` 下 6 张**本次实拍/实出图**（含 C 档参数表单截屏与 5 张不同画风出图）。踩坑表新增 #25。
- **测试**：`smoke-skill.mjs` 新增 15 条断言（`quickOptions` 字段三工具齐备、表格含三项 ★ 自调画风与五类参数、技能含 C 档选项表章节与两条触发话术、`sd-inject.ps1` 含新画风与 LoRA 全名、东亚脸复用不切模型路径）；`npm test` 四条全绿。
- **真机随机测试 6 张**（银发少女樱花 / 写实二次元·东亚脸 / 国风山水 LoRA / 赛博朋克场景 LoRA / 釉彩调色盘 LoRA / majicMIX 写实人像）：全部通过自检；釉彩调色盘第 1 轮手部偏糊，第 2 轮加重手部负向 + 手不入镜后通过（seed 与结论记入 README）。
- 坑19 复踩记录：编辑工具改完 `sd-inject.ps1` 后 BOM 再次被剥掉（首三字节变成 `# s`），已按流程补回 `EF BB BF` 并用 PS7 + PS5.1 双 Parser 复核 `SYNTAX OK`。
- **补齐「本地模型评估链」文档**（README 新增专章 + `docs/models-loras.md` 新增第 4 节）：把 C 档一直存在但只在 CHANGELOG 里提过的本地评估流程写进用户文档——视觉质检模型 `qwen3-vl:8b`（脸+手 0-100 分、≥75 过关、`temperature=0.1`、超时 180s、答题前纯文本预热 300s 把模型加载进显存）、翻译模型 `huihui_ai/qwen2.5-abliterate:14b`（纯翻译器）、两段迭代（素体自检迭代 `-IterateRounds` 3 轮 + 最终出图按「迭代次数」连出 N 张取最高分）、五类降级路径（探活失败跳过 / 无视觉模型给 pull 提示 / 指定模型不在本机自动回退 / 质检持续无分出满 N 张并弹多选 / 枚举不到模型点出 `OLLAMA_MODELS`）、全部相关参数表与两条 `ollama pull` 命令；同时明确 **A 档不走本地评估**（A 档质检 = 执行模型自己 `read_image` 看图）。

## 0.9.6（写实二次元配方回填 + 首次使用先拉起 SD 再弹表单 + 图片选择框白屏修复 + 手部质检）

- **写实二次元（半写实/2.5D）十轮迭代实测配方回填**（技能全文、`sd_models` qualityHint、`sd-inject.ps1` 画风联动与自动切模型四处同步）：
  - **首选路径**：AWPainting（动漫底子，不切模型）+ `<lora:semirealisticanime:0.6>` + `(modern anime style:1.25), (semi-realistic:1.1), delicate refined anime face, (big detailed anime eyes:1.25), youthful face, detailed skin shading, soft cinematic lighting`；负向 `(old anime style:1.2), retro anime, flat color, cel shading, (photorealistic:1.3), (mature female face:1.3)`。
  - **LoRA 权重 0.6 是平衡点**：0.45 脸崩（眼距开/五官挤）、0.8 御姐化跑真人照片——实测结论写进技能与脚本注释。
  - **SemiRealMix 降为备选**：只在半写实 LoRA 缺失时自动退回（实测它做底容易出 3D 娃娃脸或直接跑成照片）；`sd-inject.ps1` 的「写实二次元 → 自动切 SemiRealMix」改为「有 LoRA 就不切模型」。
  - hires 参数经验：scale 1.5 / denoising 0.55；0.4 会洗糊细节、restoreFaces 同样洗脸，配方里注明别开。
- **资源清单扩充**（install-sd.ps1）：模型加 `semirealmix`（robotjung/SemiRealMix，sha256 `385ea18e…`）、LoRA 加 `semireal`（NoneIQalt/semirealisticanime，sha256 `ffce3323…`），默认 `-Models 'awpainting,semirealmix'`、`-Loras 'add_detail,semireal,easynegative,badhandv4'`。sha256 均经 HF raw 端点 LFS 指针核对（tree API 的 40 位 oid 是 git sha1、xet-cas URL 哈希不是标准 sha256，均不可用——真机下载后 Get-FileHash 逐一比对通过）。
- **C 档首次使用先拉起 SD 再弹表单**（sd-inject.ps1 0a 段）：探活失败时用 `sd-direct.ps1 -StartOnly` 预热（自带 Write-Progress 进度条 + mm:ss 运行时间），就绪后再拉 LoRA/模型列表弹表单，列表不再空；预热失败不阻断（照常弹表单）。`sd-direct.ps1` 新增 `-StartOnly`（只拉起 API 到就绪即退、不出图），`$Prompt` 去必填；等待循环从「每 15 秒一行文本」改为进度条（注意顶部 `$ProgressPreference='SilentlyContinue'` 会吞 Write-Progress，画条前临时切回 Continue）。
- **C 档画风词进表单**：新增 `Get-StylePrompt`（画风→正/负向词映射），画风下拉切换时**幂等注入**两个提示词框（先剥上次注入的词再进新词，用户手写内容不受影响）；主流程删除表单确认后的二次追加，杜绝重复。
- **图片选择框白屏修复**（Show-ImagePicker）：ListView+ImageList 缩略图加载失败即整框白屏（异常被空 catch 吞）→ 改 CheckedListBox（纯文本文件名+勾选，绝不白屏）+ 右侧 PictureBox 预览（加载失败只显灰底占位）。
- **手部细节纳入质检（A 档 + C 档）**：C 档 VLM 问句从「只查脸」改为「脸+手综合打分」（五指齐全/多指/少指/并指粘连/关节错位都扣分），输出一律「脸/手质检得分」；A 档三个生图工具的 selfCheck 与技能「出图自检」把**手部列为第一优先检查项**并给出救手手段（`(bad hands:1.4), (extra fingers:1.4)` 加重、badhandv4 嵌入、换 seed）。
- 测试：test-install-catalog 断言更新（模型/LoRA 键清单 + 两条新 sha256 + 默认值正则）；smoke/settings 全绿；三处 .ps1 UTF-8 BOM 与 PS5.1 Parser 复核通过（编辑工具会剥 BOM，每次改完必须补回——坑13/19 再次踩中）。

## 0.9.5（GitHub Issues #1/#2/#4 回填：编码死锁/308句柄泄漏/hires 500/默认值收敛）

对照 `savinglighting/dsh-unrestricted-printing` 三个 issue 逐项核对当前 0.9.4 版并修复仍存在的缺陷：

- **Issue #1 缺陷 1（pip 约束编码）**：`writePipConstraints()` 注释改为**纯 ASCII**——中文 Windows 上 pip 用 gbk 读无 BOM 约束文件会 `UnicodeDecodeError`，torch 还没装就炸。另按 Issue #4 坑 5 补钉 `pandas==2.1.4` 断开解析器病态回溯。
- **Issue #1 缺陷 2 / Issue #4 坑 6（HF 自举死锁）**：`buildHfEnv()` 改为 `HF_ENDPOINT` **无条件**指向镜像，只把离线开关留给「有缓存」的情形——缓存为空时不给镜像 = 只能去连被墙的 huggingface.co = 缓存永远填不上（死锁）。
- **Issue #4 坑 2（PEP 517 构建隔离）**：`buildFreshEnv()` 新增 `PIP_NO_BUILD_ISOLATION=1`——pip ≥ 24 上 `PIP_CONSTRAINT` 进不了构建隔离，隔离环境拉最新 setuptools 移除 `pkg_resources` → CLIP 构建失败；禁用隔离后直接用 venv 里钉死的 `setuptools==69.5.1` 构建。
- **Issue #2 bug 1/2（install-sd.ps1 308 不跟随 + 句柄泄漏）**：新增 `Resolve-HfRedirect` 手动跟 301/302/303/307/308 跳转链；分段 worker 改写 `.partnew` + 长度校验后原子改名（不再产生半成品分片）、`finally` 显式释放句柄、HEAD 与单流前先跟跳转；分段全挂自动降级单流重试；`.part*` 清理逐项 `try/catch`（Issue #1 缺陷 3 同根：被占文件 `Remove-Item` 不再掀翻整个脚本）。
- **Issue #2 bug 3（hires 500）**：`sd_txt2img` hires 分支补 `denoising_strength`（默认 0.5，新增 `hiresDenoising` 参数暴露），A1111 v1.10.1 拿 None 与 int 比较会 TypeError。
- **Issue #2 bug 4/5（默认值收敛）**：`sd-direct.ps1` 默认负面词与 `sd-bridge.js` 对齐（补 `extra fingers, fewer digits, malformed limbs, signature, jpeg artifacts`）、尺寸/步数对齐 `512×768/22`；`sd_script`/`sd_script_b` 脚本生成命令的默认值同步收敛；inpaint 默认重绘幅度改读配置 `inpaintDenoising`（默认 0.6），不再硬编码。

## 0.9.4（出图参数表单：确认提示词后弹五项参数，最终出图走图生图 + 质检迭代）

背景：用户要求在确认提示词之后再弹 5 个参数框——「迭代次数：」（默认=素体迭代测出的最佳次数，可改）、「Denoising：」（默认 0.7，可改）、「比例：」（默认 9:16，常见比例下拉可选）、「画风：」（默认二次元，图生图默认保持画风，下拉可选）、「画质：」（默认 480p，常见档位下拉可选）。

- **参数表单（Show-ParamForm，WinForms）**：五行固定布局——迭代次数（可编辑下拉 1-5，默认 = `$baseWin.RoundsUsed` 素体迭代实际用掉的最佳轮数，非法输入回落）、Denoising（可编辑下拉 0.4-0.9，默认 0.7；无素体成品时灰掉）、比例（只读下拉 9:16 / 1:1 / 3:4 / 4:3 / 16:9 / 2:3 / 3:2 / 21:9，默认 9:16）、画风（只读下拉 保持画风 / 二次元 / 国风 / 赛博朋克 / 写实 / 厚涂 / 水彩 / 像素风，图生图默认「保持画风」、文生图默认「二次元」）、画质（只读下拉 480p / 640p / 768p / 1024p / 1280p，默认 480p）。
- **尺寸映射（Get-SizeFor）**：画质档定短边、比例定形状，8 的倍数向下取整、下限 256（如 9:16+480p → 264x480，21:9+1280p → 1280x544）。`-Width/-Height` 参数不再用于最终出图，只当素体迭代的初始形状。
- **最终出图（Invoke-FinalIterate）**：按表单参数连出 N 张（换 seed、第 2 张起带 `-RestoreFaces`），每张过 VLM 脸部质检，**取最高分那张**打开收尾；质检挂了（-1）不再烧轮数、直接采纳当前轮。有素体成品 → **图生图**（`-InitImage` 素体 winning 图 + `-Denoising` 表单值）：追加内容画上去的同时构图与过关的脸保得住；无素体成品 → 文生图。
- **画风只进负面**（替换词红线不破）：写实/厚涂/水彩/像素风映射到对应的负面词（如写实 → `anime, cartoon, illustration, painting`），**正向一个字都不加**；「保持画风」「二次元」「国风」「赛博朋克」不动负面。
- **追加为空的快捷收尾**：只在「无追加 + 有素体成品 + 表单全默认形态」（比例 9:16、画质 480p、画风保持画风/二次元、迭代次数=素体轮数）时保留——用户调了任何参数都会真出图，参数表单不再被绕过。
- 测试：pwsh7 + PS5.1 Parser 0 错误、UTF-8 with BOM、`SKILL SMOKE OK`；表单五项静态断言全过、尺寸映射 6 组用例全对；真机端到端：素体图 + 追加（银发/蓝裙/花园）denoising=0.7 图生图 → 脸部 100/100、尺寸 480x720 正确。

## 0.9.3（素体自检迭代：基底图自己迭代到脸部过关，追加内容仍由用户手动决定）

背景：用户要求 C 档（sd-inject.ps1）的素体出图也要自我迭代到最好效果，但**绝不**往提示词里加任何词（包括违规词的「替换词」）——追加什么由插件用户在弹框里手动输入，保留参与感；同时全身图脸部容易崩，也要迭代救回来。

- **素体自检迭代（sd-inject.ps1，默认开）**：弹追加框**之前**，先用 `-BasePrompt` 只跑基底：每轮换 seed（`-Seed -1`）、第 2 轮起带面部修复，每轮产物交给**本地视觉模型**（默认 `qwen3-vl:8b`，`-VlmModel` 可换；自动按 vl/vision 优先挑候选，embed/rerank 排除）做脸部质检——只问「眼睛/五官/脸部结构是否崩坏」，只回 0-100 整数分；**≥75 过关即停**，上限 `-IterateRounds`（默认 3）轮。质检只改 seed 与面部修复，**不改提示词一个字**。`-NoIterate` 恢复老行为（直接出一张）。视觉模型不可用 / 没有视觉模型 / 连续低分且已开修复（判定质检模型不可靠）→ 自动降级为「出一张就收」，绝不卡死。
- **VLM 预热 + 超时放宽**：实测 8B 视觉模型首问要冷启动加载进显存（>120s 超时返回 -1），迭代前先发一条纯文本空问预热（300s），带图质检超时放宽到 180s。
- **seed 捕获与锚定**：`sd-direct.ps1` 出图后多打两行机器可解析的 `SEEDFILE:` / `SEEDVALUE:`（真实 seed，img2img/inpaint 一样有效）；迭代捕获每轮真实 seed。**追加为空** → 迭代产物就是最终图（不再重复出一张，直接打开收尾）；**有追加** → 最终出图用 winning seed 锚定（构图与过关的脸保得住，追加内容叠上去）。迭代期间统一 `-NoOpen`，最终那张才弹看图器。
- **面部修复开关（sd-direct.ps1）**：新增 `-RestoreFaces`（`restore_faces=true`）与 `-CodeFormerWeight`（默认 0.5）。A1111 的修复强度不在 txt2img 请求体里，走 `/sdapi/v1/options` 设 `code_former_weight_factor`，`face_restoration_model` 为空时补 `CodeFormer`；设置失败降级为服务端默认继续，不阻断出图。
- **同步**：包内、工作区根、插件安装副本三处 sd-inject.ps1 / sd-direct.ps1 已更新（UTF-8 with BOM；PS5.1 + pwsh7 Parser 0 错误；`SKILL SMOKE OK`、INSTALL RECORD OK、SETTINGS SMOKE OK）。真机端到端验证：真实 SD 出图 → qwen3-vl 质检 95 分 → seed 捕获 4229936936，脸部健康。`test-install-catalog.mjs` 在 DSH 沙箱内因 `spawnSync` 拿不到子进程退出码（恒 null）而无法通过，属沙箱边界（改动前后同样失败，该测试只覆盖 install-sd.ps1，本次未动），需沙箱外复跑。
- 已知限制：DSH 沙箱为低完整性级别，对 `D:\SD.4.8` 的写入被硬拒（deny-only Administrators）——SD 目录那份 sd-direct.ps1 便利副本本次同步不上，插件下次运行 `syncDirectInto()` 会自动补齐。

## 0.9.2（坑22：C 档命令改由 sd_inject 调用时生成，不再把图存到 profile 目录）

背景：0.9.1 之后用户再次实测，走 C 档本地注入命令出的图**仍然**存到 `C:\Users\zhang\.dsh\profiles\desktop\SD-Picture`。这次是 0.9.1 没修干净的那一半。

- **根因**：0.9.1 只改了「`-OutDir` 交给脚本按 `$PSScriptRoot` 解析」，但**命令里的脚本路径本身还是错的**。技能全文是 `skills.register()` **全局注册**的，apply 时拿不到会话 exec，`docLabels(exec)` 里的 `sessionCwd(exec)` 只能退到 `process.cwd()`——也就是 DSH 宿主进程目录（profile 目录）。于是技能里的 `%DIRECT_INJECT%` 被永久固化成 `C:\Users\zhang\.dsh\profiles\desktop\sd-inject.ps1`（本次实测：模型拿到的技能全文里就是这条路径），用户跑它时 `$PSScriptRoot` = profile 目录 → 默认 `-OutDir` = `profile\SD-Picture`。
- **修法（命令改为调用时生成）**：新增工具 **`sd_inject`**（C 档专用，**不碰 SD、不出图**，只返回命令字符串）。它在 `execute(args, exec)` 里用 `sessionCwd(exec)`（会话工作区）算路径，返回的命令同时带上：
  - `-File "<会话工作区>\sd-inject.ps1"`（并先 `directPathFor()` 把脚本同步进工作区）；
  - `-OutDir "<会话工作区>\SD-Picture"`（**显式注入**，即使误跑了别处的脚本副本也存不回 profile）。
  技能文本不再出现任何固化绝对路径：C 档那一段改成「调 `sd_inject` → 把返回的 `command` 逐字贴出」，并删掉 0.9.1 那条「不要传 `-OutDir`」（现在反向要求：不要改/删插件注入的 `-OutDir`）。`docLabels` 里的 `%DIRECT_INJECT%` 标签一并删除（连同它的 `injectAbs` 计算）。
- **`apply()` 不再 `syncDirectScripts(process.cwd())`**：往宿主进程目录同步脚本，只会制造一份「看起来就是命令要用的」profile 副本并误导用户。apply 时只做 `syncDirectInto()`——把 `sd-direct.ps1` 同步进 **SD 目录**（保住「SD 目录那份与包内一致」的老承诺）；工作区那份留到命令生成时由 `directPathFor(会话工作区)` 现场同步。`syncDirectScripts` 顺手重构成 `syncScriptFile(file, target)`，避免 root 与 sdDir 相同时重复写。
- **顺带修**：`sd_inpaint` 之前没进 `applyDocsToTools()` 的注入名单，描述里的 `%OUT%` / `%REF%` 是字面量；现在 `sd_inpaint` 与 `sd_inject` 一起注入。
- **C 档本地注入的界面文案改成人话**（用户指定）：冷启动那行改为「插件附件拉起中（首次拉起加载约1-3分钟）」、**隐藏**「可执行: <ollama 路径>」那行、接口就绪那行改为「提示词优化中」、真正调审查模型那行改为「生成最终提示词（第N/M次）」（不再打印端点与模型名）。提权/换模型/超时等排查信息一律保留。
- **确认环节可反复改最终提示词**（用户要求，机会不限）：`=== 最终提示词 ===` 之后的确认提示为「按 Enter 确认并出图，**输入 e 修改提示词**，输入 q 退出」。输入 `e`/`E`/`修改` 弹出两个预填当前值的输入框（正向、负向；**留空 = 保持不变**，不会把提示词清空），改完重新打印最终提示词并**继续提供 e**——想改几次改几次，Enter 才出图，`q` 退出行为不变。（最初版本是「只有一次机会」，按用户要求放开。）
  - 逻辑测试：`tmp\test-inject-confirm.ps1`（mock 掉 `Read-Host` / `Read-InputBox`）实跑 5 个场景——Enter 直出、改正向、改负向、**连改两轮（3 轮提示 / 4 次弹框 / 最终取 P2）**、q 退出，全通过。
- **删掉非 JSON 重试时的刷屏句**（用户要求）：`模型 '…' 返回的不是合法 JSON（可能是专用模型不肯接这活）—— 重试 N/M` 整句删除，重试分支只留诊断用的「  原始回复：<模型原话>」；最终失败的「已重试 N 次，换下一个模型」保留（换模型的原因要说清楚）。smoke 加两条断言：该句不得再出现、`原始回复` 必须保留。
- **加权反 NSFW 拦截（用户实测反馈：只删词不够，有概率出违规图）**。背景：A 档把违规词删掉后，SD 会顺着残留上下文（睡衣/床/私密场景/挑逗构图）脑补，实测仍可能出违规图；用户同时反馈末尾「违禁提示词」只列了几个词、也不带权重。
  - **机制**：① 正向补合规反向词 `fully clothed, modest outfit, sfw, safe for work`（可按需加权 1.2-1.4）；② **剔除的违规标签按 `(tag:1.4~1.6)` 加权追加进 `negativePrompt`**；③ 场景/姿势/氛围类边缘词按 `(tag:1.1~1.3)` 也进负向。**权重档位**写进技能：主体级 1.5-1.7 / 场景氛围 1.2-1.4 / 边缘暗示 1.1-1.2，**上限约 1.7**（再高 CFG 失衡、画面发糊畸形）。
  - **插件兜底**：新增常量 `SAFETY_NEGATIVE`，`DEFAULTS.defaultNegative`、`sd_inject` 的 `INJECT_BASE_NEGATIVE`、`sd-inject.ps1` 的 `$BaseNegative` 默认值三处同步带上加权安全底噪 `(nsfw:1.6), (nudity:1.5), (nude:1.5), (explicit sexual content:1.4), (sexual content:1.4), (suggestive:1.2)`（画质底线保持在前，命令形态不变）。`sd_txt2img` / `sd_img2img` / `sd_inpaint` 的 `negativePrompt` 参数说明也写清加权要求。
  - **本地注入脚本的模型退回「纯翻译器」**（用户要求：只翻译并填入，不做任何其他事）：`$sysPrompt` 里那四条加权要求**全部撤掉**，改为明确约束——只做中→英标签翻译填空；**不要增/删/改写/合并/「优化」标签**，不要补质量词/画风词/人物特征/服装/场景/光影；**不要加权重**；**不要加安全或合规类标签**（权重与安全底噪一律由脚本处理）；没给的那段填空字符串；除 JSON 外一个字符都不输出。脚本自己的加权 `$BaseNegative` 底噪不受影响（拦截仍在，只是不由模型插手）。脚本里「审查模型」字样统一改为**「翻译模型」**（含回退提示语）。smoke 断言随之改为反向锁定（不得再出现 `1.5-1.7` / `权重上限约 1.7` / `审查模型`）。
- **坑24：PS5.1 调 Ollama 的双向编码坑（实调发现）**。改完纯翻译 prompt 后真机一测：模型回的全是「å°å¥³」式乱码 / 干脆不翻译只回模板——**根因不在 prompt，在编码**：PS5.1 的 `Invoke-RestMethod` 收到**字符串 body** 会按 Latin-1(28591) 发送，中文到了模型那边全是乱码，模型看不懂只能瞎猜；反过来 Ollama 的**响应头不带 charset**，PS5.1 又按 Latin-1 解码 UTF-8 正文。修法两头堵：
  - 请求侧：`$body` 显式 `[System.Text.Encoding]::UTF8.GetBytes()` 后发送，`Content-Type` 补 `charset=utf-8`；
  - 响应侧：新增 `Repair-Utf8Mojibake`（检测到 Latin-1 扩展字符就按原字节还原一次，纯 ASCII 原样返回）。
  实测：修复前模型回复 852 字符的「解释 + JSON 模板」且 positive 全是乱码；修复后同样输入回 105 字符的纯 JSON。
- **坑25：小模型偶尔把中文词原样抄回（实测「少女」）**。system prompt 加两条硬约束（出现任何汉字都算失败 + 常见词映射示例 少女→girl / 樱花→cherry blossoms / 下雨→rain）和 **两组 few-shot 对话**（assistant 轮示范「正负都译成英文标签、没给就空串」——比讲道理有效得多）；解析后新增兜底：字段里检测到汉字先**重试**，重试到底仍不译全就 `Strip-Cjk` 把未翻译的中文标签整条丢掉（英文标签原样保留），保证最终提示词全英文。真机回归 3 组样例全过：纯翻译、零权重括号、零质量词/合规词、无中文残留。
  - **末尾回执只有「违禁提示词」这行动了**（用户明确：建议替换词那行暂时不动）：违禁提示词要求按**五类**自查列全（① 裸露/衣着状态 ② 性行为/自慰类动作 ③ 性器官/体液 ④ 道具/场景 ⑤ 姿势/氛围暗示），不再只列最露骨的两三个；②③ 只写类别占位。建议替换词**保持原样式**（「合规替代方向，如 clothed、fully clothed、sfw、portrait 等」，没有合适替代词就留空）。同时写明权限边界：加重负向只在 A 档做，**C 档绝不加**；C 档命令里的 `-BaseNegative` 是插件固定常量、与本次请求无关，不算泄露。
  - **验证**：真机跑 `sd-direct.ps1` 带全套加权负向（1.4-1.6）——exit 0、3.5s、画面正常不发糊（`SD-Picture\weightcheck_001.png`）；smoke 新增 18 条断言（三处底噪一致、档位/上限文案、五类自查、**建议替换词保持原样**、C 档边界）；`acceptance.mjs` 加 `-BaseNegative` 带底噪断言。
- **坑23：PS5.1 把 CJK 字母也算变量名字符**。用户实测「生成最终提示词（第1/4次）」打印成「（第1/）」——`"…$QwenRetries次…"` 被解析成变量 `$QwenRetries次`（未定义 → 空值），`次` 跟着一起消失。改为 `"…${QwenRetries}次…"`（花括号划清名字边界），并加一条全包回归断言：`sd-inject.ps1` / `sd-direct.ps1` / `install-sd.ps1` 里**任何**「`$变量` 紧跟非 ASCII 字母」都算违规（扫描时跳过整行注释里的反例示例）。实测：PS7 不吞、**PS5.1 吞**（所以只能在 `powershell.exe` 下验），修后 PS5.1 打印 `生成最终提示词（第1/4次）` / `（第3/4次）` 均正确。
- 坑13 复查：编辑 `.ps1` 后 BOM 两次被编辑工具剥掉，均已补回 UTF-8 with BOM，Parser 0 错误；`sd-inject.ps1` 已同步到 `D:\DSWorkPlace\sd-inject.ps1`。
- **实机/测试**：`smoke-skill.mjs` 里原来那条断言的其实是**反例**——它把技能里的脚本路径断言成"存在即可"，而那个路径正是 `process.cwd()`（跑测试时= 仓库目录，恰好有同名文件）所以一直是绿的；现已改成正面回归：用**临时工作区**当会话 cwd 调 `sd_inject`，断言命令里的脚本路径与 `-OutDir` 都落在该工作区、且命令不含 `profiles`；同时断言技能文本里不得残留真实机器路径、不得再出现「不要传 -OutDir」。`acceptance.mjs` 工具清单与 C 档用例同步更新。

## 0.9.1（产物落点修复：C 档命令不再把图存到 profile 目录）

背景：用户实测发现，走 C 档本地注入命令出的图存到了 `C:\Users\zhang\.dsh\profiles\desktop\SD-Picture`，而不是会话工作区 `D:\DSWorkPlace\SD-Picture`。

- **根因**：两条路径算的不是同一个目录。工具调用走 `resolveOutputDir(exec)` → `sessionCwd(exec)`（会话工作区，正确）；而 C 档命令文本是技能注册时**一次性**把 `%OUT_ABS%` 替换进去的，`docLabels()` 当时用的是 `process.cwd()`——也就是 DSH 宿主进程的工作目录（`C:\Users\zhang\.dsh\profiles\desktop`）。技能是全局注册、apply 时拿不到会话 exec，所以这个值被永久固化成了 profile 目录。
- **修法（不靠进程 cwd）**：C 档命令**不再传 `-OutDir`**，改由 `sd-inject.ps1` 自己解析——其默认 `-OutDir` 从 `Get-Location`（随用户运行目录漂移）改为 **`$PSScriptRoot\SD-Picture`**（脚本所在目录）。而 `syncDirectScripts` 早已把 `sd-inject.ps1` 同步到会话工作区，于是无论从哪个目录运行命令，产物都落回工作区，与生图工具落点一致。
- `docLabels(exec)` 仍改为优先用会话工作区（拿得到 exec 时更准），`applyDocTokens` / `applyDocsToTools` / `mapStringsDeep` 一并透传 `exec`；`%OUT_ABS%` 标签保留但技能命令块已不再使用。
- 技能文本补一条硬性说明：**不要传 `-OutDir`**，传了反而可能指到别处。
- **实机验证**：把命令的 cwd 设成 `C:\Users\zhang\.dsh\profiles\desktop` 运行，`-OutDir` 仍解析为 `D:\DSWorkPlace\SD-Picture`（脚本所在目录），不再漂移。
- 测试：`smoke-skill.mjs` 断言改为「命令块内不得出现 `-OutDir`」+「技能必须写明不要传 `-OutDir`」+「`sd-inject.ps1` 默认 OutDir 必须是 `$PSScriptRoot` 且不得用 `Get-Location`」。
- 坑13 复查：编辑后 BOM 被剥，已补回 UTF-8 with BOM，Parser 0 错误。

## 0.9.0（sd-inject.ps1：审查模型每个多重试 + 真机拉通验证）

- **每个模型内部再重试 `$QwenRetries` 次（默认 4）**：模型回绝、返回非 JSON、或两个字段都空，先在**同一个模型**上再试，只有同一模型 4 次都不成才换下一个候选。原来「一次不行就换模型」，遇到概率性回绝（abliterate 系尤其如此）会把好模型白白跳过。
- **重试时略抬 temperature**：`0.2 + 0.15 × (attempt-1)`，完全确定性时容易反复撞同一句回绝。
- **404 直接换模型**：模型不在本机（404）是确定性失败，重试没意义，直接 `break` 到下一个候选。
- **重试间隔 1 秒**（`Start-Sleep -Seconds 1`），避免把本地服务打得太急。
- **进度可见**：每次调用打印 `(第 N/4 次)`，成功时若 `attempt -gt 1` 补一句「第 N 次尝试成功」。
- **说人话**：全部失败时报「试了 3 个模型、每个最多 4 次」+ 拉取提示 + `-QwenRetries` 可调。
- **真机验证**：`huihui_ai/qwen2.5-abliterate:14b`（9.0 GB）已拉通——默认模型首次调用即成功，中文正确拆成 `silver hair, red ribbon, school uniform`。另外用 mock Ollama 实跑 3 个场景：前 3 次回绝第 4 次成功、同模型 4 次全拒后换下一个、3 个模型全拒后报错退出。
- 坑13 复查：编辑后 BOM 被剥，已补回 UTF-8 with BOM，Parser 0 错误。
- 测试：`smoke-skill.mjs` 新增 5 条断言（`$QwenRetries` 默认 4、`for ($attempt...)` 循环、temperature 递推、404 短路、重试间隔）。
- 拉取提醒：该模型在 Ollama 仓库里**只有带命名空间的全名** `huihui_ai/qwen2.5-abliterate:14b`（裸名 404），脚本默认值已用全名。

## 0.8.9（sd-inject.ps1：审查模型重试 + 专用模型排最后）

背景：用户实跑 C 档注入命令，截图里两件事同时炸——① `qwen2.5-abliterate:14b` 不在本机，回退逻辑挑了**第一个** qwen，正好是 `qwen2.5-coder:7b`；② 代码模型直接回绝 `I'm sorry, but I can't assist with that request.`，脚本判「不是合法 JSON」后 `exit 1` 整单崩掉。

- **候选模型排序**（`Rank-QwenModels`）：按名字识别 `coder|code|vl|vision|embed|math|ocr|rerank` 等**专用模型**并排到最后，`instruct|chat|abliterate|latest` 等通用对话模型优先。本机实测排序：`qwen3.5:latest` → `qwen2.5-coder:7b` → `qwen3-vl:8b`。
- **逐个候选重试**（`Get-QwenCandidates` + `foreach ($cand in $order)`）：模型不在本机（404）、调用失败、返回不是合法 JSON、或 JSON 里两个字段都空——四种情况都**换下一个候选**再试，最多 3 个，不再让一个专用模型把整单带崩。候选列表枚举一次后缓存，重试不反复打接口。
- **容忍模型裹话**：解析前截取第一个 `{` 到最后一个 `}` 之间的内容，兼容「好的，这是结果：{...}」这类回复。
- **`-QwenModel` 显式指定**的排到最前（用户点名先试），仍失败才走自动排序。
- **说人话**：全部失败时报出试过哪些模型、提示 `ollama pull qwen2.5-abliterate:14b` 或 `-QwenModel qwen3.5:latest`；成功但从默认值回退时，也说明白是哪个模型接的活。
- 坑13 复查：编辑后 BOM 被工具剥掉导致 PS 解析报 3 个错，已补回 UTF-8 with BOM，Parser 0 错误。
- 测试：`smoke-skill.mjs` 新增 7 条断言（默认模型名、`Rank-QwenModels`、`Get-QwenCandidates`、`foreach ($cand in $order)` 重试、3 次上限、专用模型压底、JSON 主体截取）；并用 mock Ollama 实跑 5 个场景全通过——默认模型缺失回退、专用模型回绝后重试、全部候选失败、`-QwenModel` 显式指定优先、留空输入不调模型。
- **本机注意**：`huihui_ai/qwen2.5-abliterate:14b` 首次拉取要用**带命名空间的全名**——裸名 `qwen2.5-abliterate:14b` 在 Ollama 仓库里不存在（registry 404：`pull model manifest: file does not exist`），只有 `huihui_ai/qwen2.5-abliterate` 这个仓库提供该模型。脚本默认值已同步改为全名。

## 0.8.8（sd-inject.ps1：审查模型换成 qwen2.5-abliterate:14b）

- **`-QwenModel` 默认值改为 `qwen2.5-abliterate:14b`**：C 档本地注入流程最后一步唤起的审查模型由「自动挑第一个 qwen」改为显式指定这个 14b 模型。
- **保留自动兜底**：模型不在 `ollama list` 里时仍自动回退到第一个 qwen 系模型并提示一句（不阻断），同时打印 `ollama pull qwen2.5-abliterate:14b` 拉取命令；调用失败时也提示同一条命令。
- **显式传 `-QwenModel ""`** = 回到 0.8.7 的「自动挑第一个 qwen 系模型」行为。
- 文案同步：脚本头注释、`调用本地审查模型：...` 提示、README 第 102 行。
- 坑13 复查：编辑后已恢复 UTF-8 with BOM（PS5.1 无 BOM 会按 GBK 读），PS Parser 无语法错误；`smoke-skill.mjs` / `acceptance.mjs` 全绿。
- 已同步生效路径：`D:\DSWorkPlace\dsh-unrestricted-printing\`、`C:\Users\zhang\.dsh\profiles\desktop\sd-inject.ps1`（C 档命令实际引用的那份）、`C:\Users\zhang\.dsh\profiles\desktop\node_modules\dsh-unrestricted-printing\sd-inject.ps1`（插件安装副本）、`D:\DSWorkPlace\sd-inject.ps1`（工作区同步副本）。
- 注意：本机 Ollama 目前只有 `qwen2.5-coder:7b` / `qwen3.5:latest` / `qwen3-vl:8b`，**尚未安装** `qwen2.5-abliterate:14b`——首次跑会自动回退到第一个 qwen 系模型；要真正用上它先执行 `ollama pull qwen2.5-abliterate:14b`（约 9GB）。

## 0.8.7（sd-inject.ps1：Qwen 冷启动 + 模型自动挑）

背景：用户实跑 C 档的本地注入命令，一输入中文就报 `Qwen 调用失败：无法连接到远程服务器`。

- **根因是两个问题叠在一起**：① `ollama serve` 本来就没在跑；② `-QwenModel` 默认值 `qwen2.5:14b` 是**写死的猜测值**——本机 Ollama 实际只有 `qwen2.5-coder:7b` / `qwen3.5:latest` / `qwen3-vl:8b`。服务没起 + 模型不存在，最后只甩出一个看不懂的连接错误。
- **冷启动**（对齐 `sd-direct.ps1` 拉起 SD 的同一套姿势）：新增 `Test-QwenApi` 探活 → `Start-QwenApi` 没起就 `Start-Process ollama serve` 后台拉起（句柄重定向到 `%TEMP%\dsh-sd-inject-qwen.log*`，不继承控制台管道）→ 轮询到就绪。`-NoQwenStart` 关闭、`-QwenStartTimeout`（默认 300s）调超时；超时/找不到 `ollama.exe` 都只报一条错 + 一行提示就退出。自举只认 Ollama，vLLM / LM Studio 端点请用户自己先起。
- **模型自动挑**：`-QwenModel` 默认改为空 = 自动选本机第一个 qwen 系模型；显式指定但 `ollama list` 里没有时，自动回退到第一个可用模型并提示一句（不阻断）。枚举顺序：OpenAI 兼容 `/models` → Ollama 原生 `/api/tags` → `ollama list` CLI 兜底。
- **说人话**：一个模型都枚举不到时，直接把 `OLLAMA_MODELS` 这个最常见根因打出来（本机就是它指向空目录、模型实际在别处），不再让用户面对一个 400 Bad Request 猜。
- 技能文本与三个生图工具描述同步补一句「脚本会自己冷启动本地模型服务，首次约 1-3 分钟」。
- 测试：`smoke-skill.mjs` 新增冷启动断言（三个函数存在、有输入时必须先冷启动再解析模型、必须拉 `serve`、有超时/可关闭开关、必须点 `OLLAMA_MODELS`、**不得使用 PS7 专有的 `??` 运算符**——本次真踩中，PS5.1 直接语法错）。
- **实机验证通过**：冷启动拉起 `ollama serve` → 自动挑到 `qwen2.5-coder:7b` → 中文拆成英文标签 → 基底 + 追加拼接 → 确认出图，产物 `SD-Picture\inject_001.png`（512x768，正常）。留空 / 仅负向输入 / 全空格三种输入的 `hasInput` 判定也都验证过。

## 0.8.6
- B 档并入 C 档：C 档完全覆盖原 B 档行为。
- C 档输出命令新增 -BasePrompt / -BaseNegative 素体基底。
- sd-inject.ps1 弹框输入改为追加：基底 + 用户输入，拼接后出图；留空直接跑基底。
- smoke-skill.mjs 新增 C 档、基底、追加模式断言。
- 本次改动落在生效路径 D:\DSWorkPlace\dsh-unrestricted-printing\。

## 0.8.5（坑21：安装记录写失败不得判安装失败）

背景：`test-install-catalog.mjs` 的干跑段一直报 `dry run must exit 0, got null`，曾被认为是「沙箱问题、既有、不在范围内」——实际是真 bug。

- **根因**：`install-sd.ps1` 收尾处 `[System.IO.File]::WriteAllText($env:USERPROFILE\.dsh-sd-bridge.json, ...)` 是**裸调用、没有 try/catch**，而脚本设了 `$ErrorActionPreference = 'Stop'`。于是记录写不进去（只读 HOME、沙箱拦、企业策略）时一次 `UnauthorizedAccessException` 就把**整次安装**打成非 0 退出——而 WebUI、模型、VAE、`config.json` 全都已经落盘成功。用户看到的是一次「失败的安装」，其实东西都装好了，只是少了一条路径记录。
- **修复**：记录写入包 `try/catch`，失败只报一条错 + 一行提示（指向 `DSH_SD_DIR` / `cordis.patch.yml` 两条兜底路径），**不再 exit 1**；完成横幅多打一行「记录没写成功 → 重启前先设 `DSH_SD_DIR=<Target>`，否则插件探测不到」。BOM 校验逻辑原样保留（坑10 不回归）。
- **记录路径可覆盖**：新增 `-StateFile` 参数与 `DSH_SD_STATE_FILE` 环境变量，留空仍是 `~/.dsh-sd-bridge.json`。优先级：`-StateFile` > `DSH_SD_STATE_FILE` > `$env:USERPROFILE`。
- **测试不再依赖 HOME 可写**：干跑段改为把记录改道到临时目录（`-StateFile`），断言 exit 0、`record.sdDir` 指向 `-Target`、记录首字节是 `{`（无 BOM）。新增 6b) 节**专项验坑21**：故意把记录指到一个不存在目录 → 断言仍 exit 0、有「安装记录写入失败（不影响已装好的 SD）」提示、且能到达 `== 完成 ==` 横幅。另加静态断言：`-StateFile` 参数存在、认 `DSH_SD_STATE_FILE`、写入在 try/catch 里、记录失败不 exit 1。
- 实测两种路径：可写 → exit 0 + `已记录安装位置 ... (BOM=False)`；不可写 → exit 0 + 一条非致命提示 + 兜底说明。四条不出图测试（smoke / record / settings / catalog）全过。
- 坑13/坑19 回归防护：改完 `.ps1` 仍必须补回 UTF-8 BOM + CRLF（本次改动用 Node 补 BOM，未走 PowerShell 重写，避免二次编码损坏）。

## 0.8.3（`sd_script_b` 外部词表透传：-TermFile）
- **`sd_script_b` 新增 `termFile` 参数**：占位符映射表 JSON 路径。插件只**透传路径**（命令追加 `-TermFile "<path>"`），不读取、不写入、不解析词表内容，也不对 `prompt` / `negativePrompt` 做任何替换——占位符原样写进命令。留空时插件生成一个输出目录下的建议路径（`terms_<时间戳>.json`）。
- **`buildCommand` 新增 `-TermFile` 分支**（放在 `-Name` 之后）：其余参数拼接、`psQuote` 转义、`commandBlock` / `alignTwoVersionTags` 行为一律不动。
- **`sd-direct.ps1` 新增 `$TermFile` 参数与替换逻辑**：在 `Start-SdApiIfNeeded` 之后、构造 `$body` 之前读词表（`ConvertFrom-Json` 后逐键 `$Prompt.Replace($key, $val)` / `$Negative.Replace($key, $val)`）。脚本不生成、不推断任何映射；词表不存在或解析失败时**静默跳过**，原样执行，不阻断、不报错。
- **输出 schema 新增 `termFile` 字段**，工具描述与参数说明同步；`smoke-skill.mjs` 新增断言：命令必须含 `-TermFile`、占位符（`__TERM_A__`）必须原样进命令、输出必须带 `termFile` 路径（默认落在输出目录下且命名为 `terms_<时间戳>.json`）、显式传入时原样使用；`sd-direct.ps1` 必须定义 `$TermFile` 并含 `.Replace($key, $val)`。
- README 新增「外部词表（-TermFile）」小节。不出图三条测试（smoke / record / settings）全过；`test-install-catalog` 的沙箱失败为既有问题，不在本次范围内。
- **顺带修复 `sd-direct.ps1` 编码回归（坑13）**：工作区副本此前被写成 UTF-8 **无 BOM**，PS5.1 会按 GBK 解码 → 中文注释/字符串变乱码 → 语法错误（`[System.Management.Automation.Language.Parser]` 实测 10 处 parse error；补 BOM 后 0 处）。已重存为 UTF-8 **with BOM**，内容逐字节不变；`smoke-skill.mjs` 新增 BOM 断言（源文件 + 同步进工作区的那一份）防止再回归。

## 0.8.2（`sd_script_b` 自动提取原始输入作为位置对齐基准）

背景：`originalPrompt` 原本是必填，但调用方（模型分流改写后）常常拿不到「用户最早那一版」的原文，只能提供处理后的 `prompt`——位置对齐缺了基准就退化成单版透传，双版本对齐形同虚设。

- **新增 `extractOriginalInput(exec)`**（放在 `sessionCwd` 附近的工具公共件区）：从会话上下文提取最近一条用户消息原文。路径优先级 `session.messages`（倒序查找 `role === 'user'`，取 `content` 或 `text`）→ `session.header.originalInput`（兼容 `originalPrompt`）→ 空字符串。**纯字段读取**：无词表、无正则、不做内容判定，任何形状异常（非数组 messages、null/数字元素、缺 header）都静默返回 `''`，绝不抛异常。
- **`originalPrompt` 改为可选**：`scriptBTool.execute` 里显式传入时 `originalSource = 'explicit'`；留空且提取成功时用提取值作基准、`originalSource = 'extracted'`；两处都拿不到才 `originalSource = 'fallback'` 并维持原行为（退化为全部保留正向）。直接透传 `args.originalPrompt` / `args.prompt`，**无调用前交换、无参数名映射错误**。
- **输出 schema 新增 `originalSource`**（`enum: ['explicit', 'extracted', 'fallback']`），标记基准来源便于排查；工具描述与参数说明同步说明兜底规则。
- 测试：`smoke-skill.mjs` 新增断言——`extractOriginalInput` 在模拟 exec 上取到最后一条 user 消息、回落到 `header.originalInput`、无历史/异常形状返回 `''`；`originalSource` 字段存在且三态可枚举；`required` 从 `['originalPrompt', 'prompt']` 改为 `['prompt']`；extracted / fallback 两条端到端用例。三条不出图测试（smoke / record / settings）全过。

## 0.8.1（`sd_script_b` 对齐方向反转 + B 档指向统一）

背景：0.8.0 的对齐方向写反了。脚本要复现的是「用当前版本（`prompt`）生成的那张图」，正向必须与生成时一致；原来把 `originalPrompt` 的词留在正向、`prompt` 的差异词送负向，脚本跑出来反而是「原始版本」的图，与会话里那张对不上。

- **反转 `alignTwoVersionTags` 方向**（sd-bridge.js）：② 两版同位都非空且不等时改为 **`prompt[i]`（当前版本）进正向原位、`originalPrompt[i]`（原始版本）进负向**；① 相等时保留正向、③ 仅 original 非空进正向、④ 仅 prompt 非空保留正向四条规则不变。`positivePrompt` / `negativePrompt` 返回字段与蒙版、denoising 逻辑不动。
- **B 档指向统一到 `sd_script_b`**：`sd_txt2img` / `sd_img2img` / `sd_inpaint` 三个工具描述里「明显违规 → 改调 sd_script」的措辞改为 `sd_script_b`；`sd_script` 描述保持原样（A 档/单版透传专用，末尾已注明「需要双版本对齐改用 sd_script_b」）。
- **蒙版模式 denoising 保留 0.7**，不与 `sd_inpaint` 的 0.6 对齐（`sd_script_b` 传的是当前版本参数，默认 0.7；修瑕补全请显式传 0.40-0.55）。
- **技能文本同步**：B 档第 3 步的双版本说明改为「prompt 的词留在正向原位、original 的词进负向（被替换掉的旧标签进负向）」；源码头注释、`sd_script_b` 工具描述与参数说明同步反转。
- 测试：`smoke-skill.mjs` / `acceptance.mjs` 的对齐断言反转（positivePrompt = 当前版本、negativePrompt = original 差异词 + negativePrompt），蒙版用例断言同步；三条不出图测试（smoke / record / settings）全过。
- **回归排查（本轮复查「B 档正向未含原始输入」）**：逐项核对四个怀疑点——① 技能 B 档第 3 步已指向 `sd_script_b`（不是 `sd_script`）；② `sd_txt2img` / `sd_img2img` / `sd_inpaint` 描述里的 B 档措辞已全部为 `sd_script_b`；③ `alignTwoVersionTags` 方向已是「prompt 进正向、originalPrompt 差异词进负向」；④ `scriptBTool.execute` 直接透传 `args.originalPrompt` / `args.prompt`，无参数名映射错误、无调用前交换。据此补充 smoke 断言：`assert.ok(skill.content.includes('sd_script_b'))` + B 档第 3 步必须显式「调 `sd_script_b`」+ 遮掉 `sd_script_b` 后，技能文本与三个生图工具描述里不得再出现裸 `sd_script` 的 B 档指向。

## 0.8.0（`sd_script_b` 双版本对齐：脚本复现与会话出图对齐）

背景：`sd_script` 直接透传 `prompt` / `negativePrompt`，而模型分流改写时常常顺手**重排或替换**正向标签——脚本原样吃下改写版，跑出来的图与会话里那张对不上（SD 的提示词顺序参与条件，换序＝换图）。

- **新增第七个工具 `sd_script_b`（B 档专用，只生成命令、不碰 SD、不出图）**：参数 `originalPrompt`（必填）、`prompt`（必填）、`negativePrompt`、`initImage`、`mask`、`maskBox`、`maskBlur`、`inpaintingFill`、`maskInvert`、`inpaintFullRes`、`inpaintFullResPadding`、`denoising`（默认 **0.7**）、`width`、`height`、`steps`、`seed`、`name`。
- **位置对齐逻辑（纯位置比较，无词表、无正则、不做内容审查）**：两版按逗号切分、逐位置对比——① 相等 → 保留正向；② 两版都非空且不等 → 当前版本（`prompt`）进**正向原位**、原始版本（`originalPrompt`）进**负向**（0.8.1 起的方向：复现的是当前版本生成的那张图）；③ 仅 `originalPrompt` 非空 → 进正向；④ 仅 `prompt` 非空 → 保留正向；`negativePrompt` 追加到负向末尾。返回新增 `positivePrompt` / `negativePrompt` / `mask` 便于核对。
- **注册**：`apply()` 的工具数组（含文档占位符注入列表 `applyDocsToTools`）加入 `scriptBTool`，工具键顺序为 `sd_txt2img / sd_img2img / sd_inpaint / sd_script / sd_script_b / sd_models / sd_server`。
- **技能文本**：B 档第 3 步改调 `sd_script_b`（说明同时传 `originalPrompt` + `prompt`、顺序一一对应，差异词进负向）；回复骨架、工作流、图生图参考图三处 B 档指向同步；`sd_script` 描述末尾加「本工具只透传一版提示词；需要双版本对齐改用 `sd_script_b`」。
- **不动**：`sd_txt2img` / `sd_img2img` / `sd_inpaint` 一行未改——A 档走生图工具自带的 `script`，提示词由插件从本次出图参数逐字带出，天然不受改写影响。
- **语义（写进了工具描述与 README）**：`originalPrompt` = 用户最早那一版输入（位置基准），`prompt` = 当前模型处理后的输出；插件**只认位置差异、不做内容审查**（内容审查是模型层的事，插件不替模型下判定）。对齐依赖调用方同时传两版且顺序对应；只传 `prompt`（`originalPrompt` 留空）则退化为全部保留正向。
- **蒙版重绘支持（与 `sd_inpaint` 对齐）**：新增 `mask`（白色/不透明 = 重绘区，优先）与 `maskBox`（"x,y,w,h"，插件现场造黑底白块蒙版存进 `ref/`），加 `maskBlur`（默认 4）/ `inpaintingFill` / `maskInvert` / `inpaintFullRes` / `inpaintFullResPadding`（默认 32）；给了 mask/maskBox 即 `mode = 蒙版重绘`（必须同时给 `initImage`），尺寸与 maskBox 坐标换算沿用 `sd_inpaint` 同一套规则（尺寸默认跟随底图），返回新增 `mask` 路径。`denoising` 默认仍 0.7（`sd_inpaint` 是 0.6，修瑕补全请显式传 0.40-0.55）。技能「蒙版重绘」一节的 B 档指向、`sd_inpaint` 之外的 B 档措辞同步；`sd_inpaint` 本体按不变量一行未动。
- 测试：`smoke-skill.mjs` 工具注册断言更新为七个，并新增对齐规则断言（差异词进负向、单版退化、仅 original 非空的补位、`denoising` 默认 0.7、mask/maskBox 走【蒙版重绘】且缺 `initImage` 报错）；`acceptance.mjs` 工具清单同步为七个 + `sd_script_b` 纯命令回归（含 maskBox 造蒙版）。

## 0.7.0（设置入口 + 环境预检 + 资源清单化拉取）

对着评论区反馈做的四件事：设置里找不到配置项、装机环境缺东西、模型拉取对象过时、缺常见 LoRA。

- **设置面板配置入口（修「设置里没有这个插件设置内容」）**：`sd-bridge.js` 新增 `registerSettings`——运行时动态 `import('@deepseek-ai/schemastery')` 构造 schema（零静态依赖，schemastery 缺失则跳过注册、工具照常可用），`settings.register('sd-bridge', schema)` 注册到 **设置 → 插件 → sd-bridge**，`DEFAULTS` 全部 13 个字段可编辑（每个带中文说明）。`scope.watch` 实时并回 `cfg`，工具调用现读 `cfg`，**改完下一个调用即生效、无需重启**。优先级：DEFAULTS < 设置面板 < `cordis.patch.yml` 显式覆盖（patch 层指定的键被冻结，面板不覆盖）。
- **环境预检段 `Test-Prereqs`（缺啥补啥，先于一切下载）**：磁盘 ≥15GB 提前拦 → 镜像探活（失败提示换 `-Mirror ""`）→ git（缺则自举 MinGit）→ Python 3.10（占位符则静默装 3.10.6）→ **VC++ 2015-2022 x64 运行库**（查注册表 `VC\Runtimes\x64`，缺则下官方 `vc_redist.x64.exe` 静默装；torch/A1111 硬依赖，缺了首轮启动报错极迷惑）。每项失败只报一条错 + 一行提示即 `exit 1`，最后打一张「✓ 就绪清单」。`-NoPrereq` / `-SkipVC` / `-SkipDiskCheck` 可分别跳过。
- **模型/VAE 拉取对象换成本机实测组合（清单化）**：`-Models` 逗号多选（`awpainting` 默认 / `revanimated` / `anythingv5` / `majicmix` / `darksushi`），`-Vaes`（`mse` 默认 / `animevae`）。**全部 5 个 checkpoint + 2 个 VAE 的 sha256 已与本机出图正常的文件逐字节比对**（HF lfs oid = sha256：AWPainting `3d1b3c42…`、ReVAnimated v1.1 `d725be5d…`、anything-v5 `7f96a1a9…`、majicMIX v7 `7c819b6d…`、dark sushi brighterPruned `099e0754…`、animevae `f921fb3f…`）。清单键写错会列出全部可用键。
- **常见 LoRA/Embedding 拉取**：`-Loras` 默认 `add_detail,easynegative,badhandv4`（细节增强 LoRA 38MB + 负面嵌入 24KB + 手部修复嵌入 18KB，均 HF 镜像直链 + sha256 校验）；LoRA 落 `models\Lora`、Embedding 落 `models\embeddings`（A1111 各自扫描目录）。`-SkipLora` 跳过、`none` 清空。**你本地那批国内站 LoRA（国风山水/赛博朋克/电商摄影等）不进清单**——直链不稳，README 写了手动放置说明。
- **`-Upgrade` 升级复验**：已存在文件做 sha 复验，不符就重拉；清单条目带 `Supersedes`（如 ReVAnimated v10 → v1.1）时旧版在、新版缺就补拉新版（**旧版保留**）。
- **资源清单汇总**：跑完打印「[类型] 文件 — ✓ 已下载 / ✓ 已存在 / ✗ 原因」一张表，失败项提示重跑自动续传。
- **文档去旧插件化**：README/`cordis.patch.yml`/源码头注释删除「替换原 `dsh-sd-bridge`」「与原插件同 id」等声明（原版从未发布）；`package.json` 仓库地址从 `YOUR-USER` 占位改为 `savinglighting`。
- **踩坑新增：编辑 `.ps1` 会丢 UTF-8 BOM**（PS5.1 无 BOM 按 GBK 读 → 语法错），改完必须补回 `EF BB BF`——本次实测踩中，靠 `[Parser]::ParseFile` 检查抓出。
- **踩坑新增：符号链接插件裸 import 依赖会落空**——插件以 profile node_modules 符号链接指向工作区时，Node 按 realpath 解析依赖，`import('@deepseek-ai/schemastery')` 必然失败 → 设置注册被静默跳过（「注册了但面板还是没有」的隐藏根因）。`tryLoadConfigSchema` 增加途径②：扫 `~/.dsh/profiles/*/node_modules/@deepseek-ai/schemastery/lib/index.mjs` 按绝对路径导入。
- 新增 `test-settings.mjs`：schema 注册（ns = `sd-bridge`、13 字段全在 `dict` 上）+ 面板改动实时并回 `cfg` + **patch 显式键不被面板覆盖** + 越界钳制（denoising 0-1、idleStop ≥0、startupTimeout ≥30s）。
- 新增 `test-install-catalog.mjs`：BOM 断言 + 三张清单（键/sha256/HF 源，含 AWPainting 与 animevae 的已验证哈希）+ 预检五项与单条退出 + `-Models`/`-Loras` 默认值 + 临时目录干跑（预检打印、记录无 BOM）+ 非法键 exit 1 并列出可用键。
- **发布整理**：README 与源码头注释的工具计数从「五件套」更正为「六件套」并补上 `sd_inpaint`（0.6.0 新增蒙版重绘后文案未同步）；README 示例图与 LICENSE 徽章改用绝对地址，在 npm 包页面同样能渲染；`package.json` 的 `files` 补 `CHANGELOG.md`，新增 `scripts`（`npm test` = 四条不出图检查，`npm run acceptance` = 真实出图验收）；`sd-direct.ps1` / `install-sd.ps1` 行尾统一为 CRLF（与 `.gitattributes` 的 `*.ps1 text eol=crlf` 声明一致），UTF-8 BOM 保持不变、`[Parser]::ParseFile` 复核 SYNTAX OK。

## 0.6.0（几个坑回填 + 脚本跑完自动开图）

从「点安装 → 新会话跑通」踩的 12 个坑全部回填进插件与安装脚本；可复现脚本新增「跑完打开这张图」。

- **脚本跑完自动打开那张图**：`sd-direct.ps1` 保存成功后用系统默认看图器打开产物，`-NoOpen` 关闭；工具描述、`sd-paint` 技能与 `asMarkdown` 头部同步说明。
- **脚本自带服务托管 + 单条报错（坑15，别人电脑实测）**：SD API 没开时脚本按 `-SdDir` > `DSH_SD_DIR` > `~/.dsh-sd-bridge.json` > 各盘常见安装名**自己拉起**并轮询就绪（`-NoStart` 关闭、`-StartTimeout` 调超时、日志 `%TEMP%\dsh-sd-direct-launch.log*`）；端口被占、目录/解释器缺失、API 调用失败、结果无图——统一 `Fail` **只报一条错误 + 一行提示就 `exit 1`**，不再出现「连不上 → 空数组 → 空值写盘 → 空 JSON」连炸 4 条。
- **坑10 · BOM（唯一影响所有会话的根因）**：安装记录读取改为「剥 BOM → JSON 解析 → 失败按字段兜底 → **大声记日志**」，读到 BOM 就**就地自愈重写**为无 BOM UTF-8；`install-sd.ps1` 写记录改用无 BOM UTF-8 并回读校验 `BOM=False`。
- **坑11 · 离线 tokenizer 失败**：只有 `<SD>\.cache\huggingface` 真有 `models--*` 才接管 `HF_HOME` 并开离线；缓存为空则不接管、保持联网（`DSH_SD_HF_ONLINE=1` 强制联网）。
- **坑6 · Blackwell**：全新安装时探测 `compute_cap ≥ 12` → 自动 `TORCH_COMMAND` 换 torch 2.7.0 + torchvision 0.22.0（cu128，本机 RTX 5060 实测 CUDA 可用）；已设 `TORCH_*` 则完全尊重。
- **坑7/8 · pip**：`PIP_CONSTRAINT` 钉 `setuptools==69.5.1`、`numpy==1.26.2`、`opencv-python==4.11.0.86`（作用到含 PEP 517 构建隔离在内的每次 pip），另设 `PIP_RETRIES=10` / `PIP_TIMEOUT=60`；`DSH_SD_PIP_CONSTRAINT=0` 可关。
- **坑9 · 上游删库**：本地缺 `repositories/stable-diffusion-stability-ai` 时自动把 `STABLE_DIFFUSION_REPO` 指向 camenduru fork（保留同一 commit `cf1d67a6…`，签名 verified）。
- **坑2 · 无 git**：`install-sd.ps1` 自动自举 MinGit 便携版——资源带 `digest` 先校验 sha256、再 `git --version` 实测，装完写入用户 PATH（保留注册表 ExpandString 类型）。
- **坑4 · 商店占位 Python**：自动静默装官方 Python 3.10.6（用户级 `PrependPath`），`pythonDir` 记进安装记录，插件 `resolvePython` 在 SD 自带 python/venv 之后兜底使用。
- **坑5 · 大文件断流**：`Get-SegmentedFile` 8 段并行 Range 下载 + 断点续传 + 长度/可选 sha256 校验（实测与单流逐字节一致）。
- **坑13（本次新发现）**：`.ps1` 固定存 **UTF-8 with BOM**——PS5.1 对无 BOM 文件按 GBK 读，中文多字节会吞掉后面的 `)` `"` 直接语法错（与坑10 的 JSON 记录恰好相反：JSON 必须无 BOM）。
- **坑14（本次新发现）**：`sd-direct.ps1` 的 `-Seed` 由 `[int]` 改为 `[long]`——SD 的 seed 是 uint32，`3845143617` 这类种子在 `[int]` 上直接参数转换失败。
- **坑16 · 新装 SD 画质差（本次新发现，根因＝模型）**：`install-sd.ps1` 默认模型从 2022 年的 SD1.5 base 换成 **AWPainting v1.2**（远端 sha256 `3d1b3c42ec…` 与本机出图正常的文件**逐字节一致**），补下 **`vae-ft-mse-840000`**（`735e4c3a…`，实测 4 段下载 + 哈希通过），并合并写入 `config.json` 的 `sd_model_checkpoint` / `sd_vae` / `CLIP_stop_at_last_layers=2`——只改点名键、保留其余键、写回不带 BOM、非 UTF-8 老文件按原编码读写、`-NoConfig` 关闭；`sd_models` 发现只有 base 模型时返回 `qualityHint` 给出升级路径。
- **坑17 · 脚本拉起的 SD 启动卡几分钟（本次新发现）**：`sd-direct.ps1` 启动前按插件同一规则设 HF 环境（缓存命中 → `HF_HOME` + 离线加载；未命中 → 保持联网走 `hf-mirror`；`DSH_SD_HF_ONLINE=1` 强制联网），修掉「去连 huggingface.co 重试 5 次×10s×多文件」——实测 HF 重试 0 次、冷启动到出图 28 秒。
- **坑18 · stderr 刷「找不到驱动器 E:」（本次新发现）**：扫盘先 `Test-Path` 跳过不存在的盘符，候选路径再包 `try/catch`。
- **句柄彻底脱离**：启动 SD 时 stdin/stdout/stderr 三者都显式重定向到文件，避免继承宿主管道导致「脚本跑完了宿主却一直挂着不返回」。
- **画质默认值（本机与所有机器生效）**：`defaultSampler: 'DPM++ 2M'`（同步数下比 A1111 默认的 Euler a 更干净）、`defaultNegative`（调用方没传负面词时补质量底线）、`img2imgDenoising: 0.55`（更贴参考图）；`sd-direct.ps1` 新增 `-Sampler`（默认同为 DPM++ 2M）并写进可复现命令，**复现结果与会话里一致**。
- **出图自检 → 优化循环（违不违规都要做）**：两个生图工具返回新增 `selfCheck` 提醒，技能正文新增「出图自检 → 优化循环」与「图生图画风一致」两节，回复骨架 / 工作流 / 工具描述同步——出图后用 `read_image` 自己看，肢体/水印/构图/风格不合格最多再改 2 轮（每轮只改 1-2 个变量、保留 seed、逐轮贴图）；**图生图**并排对照参考图，按「同源模型 + 风格词入提示词 + denoising 0.30-0.50 + 同尺寸」四步锁画风；**A 档若仍残留违规内容立即重画**，B 档照旧不出图。
- **新增 `sd_inpaint` 蒙版重绘**：只重画画面里一块，字段名逐个对照本机 A1111 源码（`mask` / `mask_blur` / `inpainting_fill` / `inpaint_full_res` / `inpaint_full_res_padding` / `inpainting_mask_invert`）。蒙版二选一：`mask` 蒙版图，或 `maskBox: "x,y,w,h"`——没有蒙版图时**插件手写 PNG 编码器**（zlib + CRC32，零第三方依赖）现场造黑底白块蒙版存进 `ref/`；返回【蒙版重绘】可复现脚本与「接缝/色差/边缘重复/越界误改」自检；`sd-direct.ps1` 新增 `-Mask / -MaskBlur / -InpaintFill / -MaskInvert / -NoFullRes / -InpaintPadding`；技能新增「蒙版重绘」章节（含 A 档可只把违规那块蒙版重画、B 档照旧不出图）。**修复**：`readImageBase64` 恒返回 Promise，漏 `await` 会让 `init_images` 变 `[null]` → 服务端 `'NoneType' has no attribute startswith` 500。
- 新增 `test-install-record.mjs`（BOM 读取 + 自愈专项，不出图、毫秒级）；`acceptance.mjs` 新增第 8 步**真跑一遍脚本**（powershell.exe PS5.1 执行 + uint32 seed 回归）与第 10 步**真实蒙版重绘**（maskBox 造蒙版 → 出图 → 断言脚本带 `-Mask`、蒙版 PNG 合法）；README 补「14 坑排查表」与「必须**新开会话**复验」的验收方法。

## 0.5.0 (portable release)

跨机器可移植发布版——别人安装插件即可使用，无需任何本地适配。

- **SD 目录自动探测**：`sdDir` 默认留空，按「配置 > `DSH_SD_DIR` 环境变量 > `~/.dsh-sd-bridge.json` 自举记录 > 扫盘候选」查找本机 SD WebUI；找不到时工具返回可读的安装指引而不是崩溃。
- **一键自举安装**：新增 `install-sd.ps1`（克隆 WebUI + 下载模型 + 记录安装位置）。
- **工作区化**：`outputDir`/`refDir` 默认改为相对路径（`SD-Picture` / `ref`），解析到会话工作区；`sd-direct.ps1` 同步到「工作区根目录 + SD 目录」，命令注入 `-OutDir`，脚本与插件保存同一目录。
- **文案模板化**：工具描述与 `sd-paint` 技能全文不再写死盘符，注册时按本机配置注入实际路径。
- **全新安装兼容**：venv 尚未创建时不跳过依赖准备、不禁用联网（首次启动可在线安装 torch 等依赖）。
- 测试去硬编码：`smoke-skill.mjs` / `acceptance.mjs` 走自动探测 + 临时工作区，新增可移植性断言。
- `sd-direct.ps1` 的 `-OutDir` 默认改为「当前目录\SD-Picture」（插件生成命令时会显式注入）。

## 0.4.0

- 图生图参考图固化：工作区外的聊天附件自动复制到 `ref/`（按内容哈希命名），脚本引用稳定副本。
- `sd_script` 与生图工具共用同一套固化逻辑。

## 0.3.0

- 违规分流协议（A 档删词出图 / B 档不出图只给合规素体脚本 / 末尾英文违规词清单）与 `sd-paint` 技能。
- `sd_script` 工具：只生成可复现脚本，不调 SD、不出图。
