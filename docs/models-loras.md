# 模型 / VAE / LoRA / 嵌入 —— 清单与镜像站（本机实测）

> 本文件由「整理打包」任务生成（2026-10-15），列出 dsh-unrestricted-printing 在本机用到的全部权重资源：
> **每一条都有 HF 镜像直链**（`hf-mirror.com`，国内可直连），另有 **sha256**（与本机正在出图、画质已验证的文件逐字节比对过；HF 的 LFS `oid` 就是 sha256）。
> 一键拉取用包内 `install-sd.ps1`（默认就走镜像）；单文件手动下载按下面的直链 `curl`/浏览器即可。

## 0. 镜像站与用法

| 站点 | 地址 | 说明 |
| --- | --- | --- |
| HF 国内镜像（默认） | `https://hf-mirror.com` | `install-sd.ps1 -Mirror` 默认值；把 `huggingface.co` 原样换成它即可 |
| HF 官方源 | `https://huggingface.co` | 科学上网时用 `-Mirror ""` 切换 |
| ModelScope 魔搭 | `https://modelscope.cn` | 部分 checkpoint 有搬运版，国内直连，搜索模型名即可 |
| LiblibAI 哩布哩布 | `https://www.liblib.art` | **国内自调 LoRA 来源**（国风山水 / 赛博朋克 / 自然美妆场景 / 釉彩·麻袋调色盘 / 39 这类） |
| Civitai | `https://civitai.com` | 备用 LoRA / embedding 来源（EasyNegative、badhandv4 等都有收录） |

一键按清单拉取（自动走镜像 + sha256 校验 + 断点续传 8 段并行）：

```powershell
powershell -ExecutionPolicy Bypass -File "插件目录\install-sd.ps1" -Models "awpainting,semirealmix,majicmix" -Vaes "mse,animevae" -Loras "add_detail,semireal,easynegative,badhandv4"
```

单文件手动下载（示例，任意条目同理）：把表格里的「镜像直链」丢给浏览器 / `curl`：

```powershell
curl.exe -L -o AWPainting_v1.2.safetensors https://hf-mirror.com/sam749/AWPainting-v1-2/resolve/main/awpainting_v12.safetensors
# 校验（可选，值见下表 sha256）：Get-FileHash .\AWPainting_v1.2.safetensors -Algorithm SHA256
```

落地位置：checkpoint → `<SD目录>\models\Stable-diffusion\`；VAE → `models\VAE\`；LoRA → `models\Lora\`；embedding → `embeddings\`（老版 A1111 也认 `models\embeddings\`）。

---

## 1. Checkpoint（大模型，本机 7 个）

| 键（`-Models`） | 本机文件 | 大小 | HF 仓库 | 镜像直链 | sha256 | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `awpainting` | `AWPainting_v1.2.safetensors` | 2034 MB | `sam749/AWPainting-v1-2` | https://hf-mirror.com/sam749/AWPainting-v1-2/resolve/main/awpainting_v12.safetensors | `3d1b3c42ec704f3397d9e2968e3e544eda111741e10793afd78faa8148b36e12` | **默认·通用**（动漫/插画，官方推荐 CLIP skip 2） |
| `revanimated` | `动漫ReVAnimated_v1.1.safetensors` | 5410 MB | `hanafuusen2001/ReVAnimated` | https://hf-mirror.com/hanafuusen2001/ReVAnimated/resolve/main/revAnimated_v11.safetensors | `d725be5d187c172fbabfb2d35cf6bff2237367a8c1cf743d03c1c0e57f0e43fa` | 动漫综合（画风更能打，体积大） |
| `anythingv5` | `anything-v5-PrtRE.safetensors` | 2034 MB | `ckpt/anything-v5.0` | https://hf-mirror.com/ckpt/anything-v5.0/resolve/main/AnythingV5V3_v5PrtRE.safetensors | `7f96a1a9ca9b3a3242a9ae95d19284f0d2da8d5282b42d2d974398bf7663a252` | 动漫·anything v5（稳妥老牌） |
| `majicmix` | `写实：majicMIX realistic 麦橘写实_v7.safetensors` | 2034 MB | `digiplay/majicMIX_realistic_v7` | https://hf-mirror.com/digiplay/majicMIX_realistic_v7/resolve/main/majicmixRealistic_v7.safetensors | `7c819b6d13663ed720c2254f4fe18373107dfef2448d337913c8fc545640881e` | **写实人像**（C 档「写实」画风自动切它） |
| `semirealmix` | `SemiRealMix.safetensors` | 2034 MB | `robotjung/SemiRealMix` | https://hf-mirror.com/robotjung/SemiRealMix/resolve/main/SemiRealMix.safetensors | `385ea18efae6a93c19c1fc5e13447e19b5ed6f16d01b7be65f7f48252688e4b4` | **彩色哥特**画风底模（半写实/2.5D 备选） |
| `darksushi` | `二次元：dark sushi mix 大颗寿司mix_brighterpruned.safetensors` | 2034 MB | `mdl-mirror/dark-sushi-mix` | https://hf-mirror.com/mdl-mirror/dark-sushi-mix/resolve/main/darkSushiMixMix_brighterPruned.safetensors | `099e07547a45dc501a96a7b613e5bfe502be9477199172ca29821882dd8350a1` | 二次元·大颗寿司（亮部加强版） |

## 2. VAE（本机 2 个）

| 键（`-Vaes`） | 本机文件 | 大小 | HF 仓库 | 镜像直链 | sha256 | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `mse` | `vae-ft-mse-840000-ema-pruned.safetensors` | 319 MB | `stabilityai/sd-vae-ft-mse-original` | https://hf-mirror.com/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors | `735e4c3a447a3255760d7f86845f09f937809baa529c17370d83e4c3758f3c75` | **默认·不发灰**（写进 `config.json` 的 `sd_vae`） |
| `animevae` | `animevae.pt` | 785 MB | `akibanzu/animevae` | https://hf-mirror.com/akibanzu/animevae/resolve/main/animevae.pt | `f921fb3f29891d2a77a6571e56b8b5052420d2884129517a333c60b1b4816cdf` | 动漫·anything 系专用 |

## 3. LoRA（HF 清单 + 本机自调）

### 3.1 HF 清单（`-Loras` 键，`install-sd.ps1` 能一键拉）

| 键 | 本机文件 | 大小 | HF 仓库 | 镜像直链 | sha256 | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `add_detail` | `add_detail.safetensors` | 36 MB | `OedoSoldier/detail-tweaker-lora` | https://hf-mirror.com/OedoSoldier/detail-tweaker-lora/resolve/main/add_detail.safetensors | `47aaaf0d2945ca937151d61304946dd229b3f072140b85484bc93e38f2a6e2f7` | 细节增强（写 0.6-0.8） |
| `semireal` | `semirealisticanime.safetensors` | 288 MB | `NoneIQalt/semirealisticlora` | https://hf-mirror.com/NoneIQalt/semirealisticlora/resolve/main/semirealisticanime.safetensors | `ffce33239edde3afd8831beac2168cf60fc0a447e2f76d86dcc06460a2b9359a` | **写实二次元 / 写实二次元·东亚脸** 专用（**0.6** 是实测平衡点） |
| `easynegative` | `EasyNegative.safetensors`（嵌入，放 `embeddings\`） | 24 KB | `embed/EasyNegative` | https://hf-mirror.com/embed/EasyNegative/resolve/main/EasyNegative.safetensors | `c74b4e810b030f6b75fde959e2db678c268d07115b85356d3c0138ba5eb42340` | 负面嵌入·通用质量底线 |
| `badhandv4` | `badhandv4.safetensors`（嵌入，放 `embeddings\`） | 18 KB | `Eugeoter/badhandv4` | https://hf-mirror.com/Eugeoter/badhandv4/resolve/main/badhandv4.safetensors | `6836f178cc41a5436730afded6cbe2bdcef61663b1ad2d2f83ad028019a0ff98` | 手部修复嵌入（**手崩优先用它**） |

### 3.2 本机自调 / 国内站 LoRA（不进 HF 默认清单，手动放 `models\Lora\`）

这些是用户自己收集/自己调的风格资源（国内站直链不稳，脚本不抓，手动下载后放进 `models\Lora\`，`sd_models` 就能列出来）：

| 本机文件 | 大小 | 建议来源（搜同名即可） | 用途 / 对应画风 |
| --- | --- | --- | --- |
| `釉彩·麻袋调色盘_v1.0.safetensors` | 144 MB | LiblibAI / Civitai 搜「釉彩 麻袋 调色盘 / glaze palette」 | **C 档画风「釉彩调色盘」**（釉面质感 + 粗布色域，权重 0.8） |
| `国风山水_v1.0.safetensors` | 72 MB | LiblibAI 搜「国风山水」 | 国风山水（`<lora:国风山水_v1.0:0.8>`） |
| `赛博朋克_v1.0.safetensors` | 144 MB | LiblibAI 搜「赛博朋克」 | 赛博朋克人物/氛围 |
| `赛博朋克场景_v1.0.safetensors` | 144 MB | LiblibAI 搜「赛博朋克场景」 | 赛博朋克场景（霓虹雨夜街景） |
| `自然美妆场景_v1.0.safetensors` | 144 MB | LiblibAI 搜「自然美妆场景」 | 电商/美妆人像场景 |
| `39_v1.0.safetensors` | 72 MB | LiblibAI 搜「39」 | 用户自留风格（按需挂） |
| `EasyNegativeV2.safetensors` | 24 KB | Civitai 搜 EasyNegativeV2 | 负面嵌入（V2，与 EasyNegative 二选一） |

> 国内站下载要点：LiblibAI 需登录后点下载；Civitai 直链要带 token。两个站都建议直接搜文件名关键词，
> 下载后核对体积（上表「大小」是本机实测值，误差 ±1 MB 属正常）。

## 4. 本地 Ollama 模型（视觉审核：人物肢体打分，图片不出机器）

C 档 `sd-inject.ps1` 会用本机 Ollama 上的**视觉模型**给每轮候选图的**人物肢体**打分，取最高分那张。
（**翻译链路已整体移除**：早前版本的 `-QwenModel` / `-NoQwenStart` / `-QwenRetries` 都不在代码里了。）

| 角色 | 默认模型 | 参数 | 用途 | 拉取/自制 |
| --- | --- | --- | --- | --- |
| **视觉审核**（脸 + 手 + 四肢 0-100 打分） | `qwen3-vl:8b`（必须**能识图**） | `-VlmModel`（插件设置 `vlmModel` 会写进命令；留空 = 自动挑本机 `vl`/`vision` 模型） | 素体自检迭代 + 最终出图选最高分那张；**≥75 过关** | `ollama pull qwen3-vl:8b`（本机已在册）。⚠️ `itsailor/qwen3.6-fable` 那类量化创作模型模型卡写明 **vision 不可用**，图片会被静默忽略，不能做审核 |

- 审核问句只问**结构**、不问内容：① 脸部（对称/无多余/五官错位/畸形融化）② 手部（五指齐全/多指少指/扭曲粘连）
  ③ 肢体（手臂与腿是否各两条、左右对称、多肢少肢、关节反向错位、四肢畸形粘连、躯干与四肢比例失衡）。
- **插件页开关**：`vlmReview`（默认 `true`）= 是否启用视觉审核。设为 `false` 时命令追加 `-NoVlmReview`：
  不探活、不冷启动、不加载模型、不打分（连参考图画风识别也不调模型），直接按迭代次数出满 N 张让你自己挑。
- 接口：Ollama OpenAI 兼容端点，默认 `-QwenBase http://127.0.0.1:11434/v1`（`-QwenApiKey` 任意非空即可）；服务没起时脚本会自己拉起 `ollama serve`（`-NoVlmStart` 关闭、`-VlmStartTimeout` 调超时）。
- 兜底：本机没有视觉模型 → 提示拉取命令并照常出图；指定模型不在本机 → 提示「本机枚举到哪些 + 怎么拉/怎么建」后回退到本机第一个 `vl`/`vision` 模型；审核持续无分 → 出满 N 张并弹多选对话框让你自己留；一个模型都枚举不到 → 直接点出 `OLLAMA_MODELS` 指向空目录这个最常见根因。
- 可换小模型省显存：8G 显存机器上，8B 视觉模型与 SD 抢显存会变慢（脚本会在剩余显存 < 3G 时提醒），可换更小的视觉模型（`-VlmModel <名称>`，只要支持图像输入即可）。
- **检测本机已装模型**：`ollama list`（本机实测 OLLAMA_MODELS 曾指向空目录，模型实际在另一路径下，脚本已在报错里点出这条）。

## 5. 本机环境基线（画质已验证）

| 项 | 值 |
| --- | --- |
| checkpoint | `AWPainting_v1.2.safetensors`（Model hash `3d1b3c42ec`） |
| VAE | `vae-ft-mse-840000-ema-pruned.safetensors`（VAE hash `735e4c3a44`） |
| CLIP skip | `2`（动漫模型必须，写进 `config.json` 的 `CLIP_stop_at_last_layers`） |
| 采样器 / 步数 / CFG | `DPM++ 2M` / 22-28 / 7 |
| 典型 hires | scale 1.5、denoising 0.55（别开 restoreFaces，会洗细节） |

换机器复现同样画质：装好 WebUI 后跑一次 `install-sd.ps1`（默认就补 AWPainting + mse VAE + CLIP skip 2），再按上表核对 `sd_models` 列出的名字。
