# 安装引导 · dsh-unrestricted-printing v0.0.1

> 这份文档把「装这个插件需要下载/准备的一切」列成清单：**每一项都给出用途、大小、下载地址（含国内镜像）、
> 落盘路径、校验方式**。照着做即可，不需要猜路径。
>
> 配套两个脚本（都在 `gateway/tools/`）：
> - `check-deps.ps1` —— **体检**：扫描本机，逐项报告 ✓/✗、路径、大小，并打印缺失项的下载命令。
> - `bootstrap-downloads.ps1` —— **引导下载**：默认只打印计划（dry-run），加 `-Apply` 才真下载（可断点续传）。
>
> 一分钟版：`npm install -g` 或 DSH 里粘 Git 源装插件 → 跑 `check-deps.ps1` → 按 ✗ 的提示装 → 再跑一次全 ✓ → 出图。

---

## 0. 三种安装插件本体的方式（任选其一）

| 方式 | 命令 / 操作 | 适用 |
|---|---|---|
| **DSH 插件市场（推荐）** | DSH →「设置 → 插件 → 安装」粘 GitHub 源 `savinglighting/dsh-unrestricted-printing` | 普通用户 |
| **npm** | `npm i -g dsh-unrestricted-printing`（或写进 DSH 插件配置的 npm 源） | 已用 npm 管理插件 |
| **手动解包** | 下载 [Releases](https://github.com/savinglighting/dsh-unrestricted-printing/releases) 里的 `dsh-unrestricted-printing-0.0.1.zip` → 解到 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-unrestricted-printing` → 重启 DSH | 内网/离线机器 |

装好后插件目录长这样（本机实测路径仅作示例）：

```
<插件目录>\
├─ sd-bridge.js            # 插件入口（工具注册 / 违规分流）
├─ sd-inject.ps1           # C 档：后台预生成 + 参数表单（走网关）
├─ sd-direct.ps1           # A 档：sd-direct 出图脚本（也走网关）
├─ sd-auto-mask.py         # 自动抠图（YOLO-World + SAM）
├─ sd-mask-qa.py           # 蒙版命中率体检
├─ install-sd.ps1          # SD WebUI 自举安装器（老组件，仍可用）
├─ gateway\                # 本地 AIGC 调度网关（Node，零第三方依赖）
│  ├─ index.js  server.js  lib\  test\  tools\
└─ docs\  README.md  CHANGELOG.md  INSTALL.md  manifest.json  package.json
```

---

## 1. 前置条件

| 项目 | 要求 | 检查命令 |
|---|---|---|
| 操作系统 | Windows 10/11 x64 | `winver` |
| 显卡 | NVIDIA，**显存 ≥ 6G**（8G 最稳；Qwen 路线建议 ≥ 8G + 32G 内存） | `nvidia-smi` |
| 驱动 | 支持 CUDA 12.x | `nvidia-smi`（右上角 CUDA Version） |
| Node.js | **≥ 18**（网关用它跑，零第三方依赖） | `node -v` |
| Python（SD 侧） | **3.10.x**（A1111 只认 3.10） | `<SD>\python\python.exe -V` |
| git | 任意近期版本（拉 ComfyUI / 自定义节点） | `git --version` |
| 磁盘 | **≥ 60G 空闲**（SD 模型 ~20G + Qwen 三件套 ~14G + CLIP 1.7G + 缓存） | `Get-PSDrive D` |
| 内存 | ≥ 16G（Qwen 的 8.7G 文本编码器需整体载入，可用内存 < 7G 会崩） | `Get-CimInstance Win32_ComputerSystem` |
| 网络 | HuggingFace 国内直连通常不通 → **统一走 `https://hf-mirror.com`** | `curl -I https://hf-mirror.com` |

---

## 2. 需下载清单（全部项）

> 列里 `D:\…` 是本机实测示例路径；换机器时把前缀换成你自己的盘符/目录即可。
> 「自检」栏对应 `check-deps.ps1` 里的条目 ID。

### 2.1 插件本体与运行时（必备）

| ID | 名称 | 用途 | 大小 | 下载 | 放哪 |
|---|---|---|---|---|---|
| `plugin` | 插件文件 | 全部功能 | ~1.5M | [Releases zip](https://github.com/savinglighting/dsh-unrestricted-printing/releases) / `npm i dsh-unrestricted-printing` | `<profile>\node_modules\dsh-unrestricted-printing` |
| `node` | Node.js ≥18 | 跑网关 | ~30M | https://nodejs.org/dist/ 或 `winget install OpenJS.NodeJS.LTS` | PATH |
| `gw-gate` | 网关端口 | 前端唯一入口 | — | 不需要下载；默认 `127.0.0.1:8799` | — |

### 2.2 SD WebUI 路线（`SD_FP16` / `Anima_INT8` 两档）

| ID | 名称 | 用途 | 大小 | 下载 | 放哪 |
|---|---|---|---|---|---|
| `sd-root` | Stable Diffusion WebUI（A1111 1.10.x / 秋叶整合包） | WebUI 引擎 | ~5G（含 py 环境） | 官方 https://github.com/AUTOMATIC1111/stable-diffusion-webui ；整合包随便找一份 1.10 系；或跑插件自带 `install-sd.ps1` 自举 | `D:\SD.4.8`（含 `launch.py` + `python\python.exe`） |
| `sd-ckpt` | 主 checkpoint（示例 AWPainting_v1.2） | 出图画质底座 | ~2G/个 | Civitai / HF（搜索模型名） | `<SD>\models\Stable-diffusion\*.safetensors` |
| `sd-ckpt2` | 备用 checkpoint（示例 anything-v5 / majicMIX / wai光辉） | 换风格 | 2-6.5G/个 | 同上 | 同上 |
| `sd-vae` | VAE（示例 `vae-ft-mse-840000-ema-pruned` / `animevae.pt`） | 颜色/细节修正 | ~0.3G | https://huggingface.co/stabilityai/sd-vae-ft-mse-original | `<SD>\models\VAE\` |
| `sd-lora` | LoRA（示例 `add_detail` / `easynegative` / `badhandv4` / `semireal`） | 细节/负面词/手部 | 10-150M/个 | Civitai | `<SD>\models\Lora\` |
| `sd-clip` | **CLIP 文本编码器 `openai/clip-vit-large-patch14`** | **点图必需**：缺它 `txt2img` 必 500（见故障 ①） | **1.59G** | `curl -L -C - -o model.safetensors https://hf-mirror.com/openai/clip-vit-large-patch14/resolve/main/model.safetensors` | `<SD>\.cache\huggingface\hub\models--openai--clip-vit-large-patch14\snapshots\8d052a0f05efbaefbc9e8786ba291cfdf93e5bff\model.safetensors` |
| `sd-ext-adetailer` | 扩展 **ADetailer** | 默认面部修复（`face_yolov8s.pt`，插件出图默认开） | ~1G（含模型） | https://github.com/Bing-su/adetailer （Extensions → Install from URL） | `<SD>\extensions\adetailer\` |
| `sd-ext-misc` | 扩展（可选）：ControlNet / segment-anything / inpaint-anything / wd14-tagger / tagcomplete / dynamic-thresholding / ultimate-upscale | 抠图、反推、放大等 | 数 G | 各自 GitHub（Extensions 面板装） | `<SD>\extensions\` |
| `sd-pin` | Python 包三件套 **transformers==4.30.2 / tokenizers==0.13.3 / huggingface_hub==0.23.5** | **点图必需**：新版 transformers 5.x 移除了 `.text_model`，A1111 必崩（见故障 ②） | ~10M | `python -m pip install --no-deps --timeout 60 -i https://pypi.tuna.tsinghua.edu.cn/simple transformers==4.30.2 tokenizers==0.13.3 huggingface_hub==0.23.5` | `<SD>\python\lib\site-packages\` |

### 2.3 ComfyUI 路线（`QwenImage_NVFP4` / `Krea2_Q4` 两档）

| ID | 名称 | 用途 | 大小 | 下载 | 放哪 |
|---|---|---|---|---|---|
| `comfy-root` | ComfyUI（0.41.0 实测可用） | ComfyUI 引擎 | ~1G | `git clone https://github.com/comfyanonymous/ComfyUI` 或下 Release zip | `D:\ComfyUI` |
| `comfy-venv` | 独立 venv（torch cu128 + requirements） | 与 SD 的 python 彻底隔离 | ~6G | `python -m venv venv` → `venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu128` → `pip install -r requirements.txt` | `D:\ComfyUI\venv`（实测 py3.10.11 + torch 2.11.0+cu128） |
| `comfy-node-gguf` | 自定义节点 **ComfyUI-GGUF** | 加载 Qwen GGUF unet | ~1M | `git clone https://github.com/city96/ComfyUI-GGUF` | `D:\ComfyUI\custom_nodes\ComfyUI-GGUF` |
| `comfy-node-qwen` | 自定义节点 **qwen-adapter**（可选） | Qwen 专用加载节点（不装也能用标准节点） | ~10K | 随插件 docs 说明；或直接用标准 `UnetLoaderGGUF + CLIPLoader(sd3) + VAELoader` | `D:\ComfyUI\custom_nodes\qwen-adapter` |
| `qwen-unet` | Qwen-Image-2.1 UC **Q4_K_M** GGUF | Qwen 出图主体 | **4.29G** | HF `QuantStack/Qwen-Image-2.1-UC-GGUF`（镜像：把域名换 `hf-mirror.com`） | `D:\ComfyUI\models\unet\qwen-image-2.1-UC-Q4_K_M.gguf` |
| `qwen-clip` | Qwen 文本编码器 `qwen3vl_8b_int8_convrot.safetensors` | Qwen 提示词编码（**8.7G 需整体载入**） | **8.71G** | 同上（对应仓库内 text_encoders 文件） | `D:\ComfyUI\models\text_encoders\` |
| `qwen-vae` | Qwen VAE `qwen_image_2.1_vae_bf16.safetensors` | 解码 | 0.63G | 同上 | `D:\ComfyUI\models\vae\` |
| `krea-unet` | Krea2 Turbo **GGUF Q4_K_M**（`krea2_turbo-Q4_K_M.gguf`） | `Krea2_Q4` 档的出图主体 | **6.97G** | HF `vantagewithai/Krea-2-Turbo-GGUF`（镜像 `hf-mirror.com`） | `D:\ComfyUI\models\unet\` |
| `krea-clip` | Krea2 编码器 **Qwen3-VL-4B int8**（`qwen3-vl-4b-heretic_int8.safetensors`） | Krea2 必须配 **4B**（`comfy/sd.py` 要求 `CLIPType.KREA2 + TEModel.QWEN3VL_4B`；配 8B 加载必失败） | **4.50G** | HF `DreamFast/Qwen3-VL-4b-Heretic-ComfyUI` | `D:\ComfyUI\models\text_encoders\` |
| `krea-vae` | Krea2 VAE（`krea2-vae.safetensors`） | Krea2 要 **64 通道** VAE（qwen 的 16 通道会 `VAEDecode` 报 64 vs 16） | 0.24G | HF `mikkoph/krea2-vae` | `D:\ComfyUI\models\vae\` |

### 2.4 可选：本地视觉质检（VLM，脸/手打分）

| ID | 名称 | 用途 | 大小 | 下载 | 放哪 |
|---|---|---|---|---|---|
| `ollama` | Ollama | 本地跑视觉模型 | ~0.7G | https://ollama.com/download | PATH |
| `ollama-vlm` | `qwen3-vl:8b` | 脸/手质检打分（不给就降级为"出满 N 张你自选"） | **6.1G** | `ollama pull qwen3-vl:8b` | Ollama 模型库 |

> 不装 VLM 也能出图：质检会自动降级（`-NoVlmReview` 手动关同理）。

### 2.5 可选：ROS2 硬件监控（P3 的实时数据源）

| ID | 名称 | 用途 | 大小 | 下载 | 放哪 |
|---|---|---|---|---|---|
| `ros2` | `rosbridge_suite`（ROS2 + `rosbridge_server`） | 通过 `ws://localhost:9090` 推硬件 JSON | — | `apt/rosdep install rosbridge_server`（Linux 侧）或 Windows ROS2 包 | 监听 9090 |
| `ros2-topic` | 硬件监控话题（默认 `/hardware_monitor`，JSON） | 队列准入/OOM 预警 | — | 自己发：`ros2 topic pub /hardware_monitor std_msgs/String "{data: '{\"vram_free_gb\":6.2,\"vram_total_gb\":8,\"gpu_util\":37}'}"` | — |

> **没装 ROS2 完全不影响**：网关会自动降级用 `nvidia-smi`（本机实测即此路径）。

---

## 3. 一键引导：体检 + 下载

```powershell
# ① 体检：逐项 ✓/✗，并打印缺失项的下载命令（可加 -Markdown 生成报告）
powershell -NoProfile -ExecutionPolicy Bypass -File gateway\tools\check-deps.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File gateway\tools\check-deps.ps1 -Markdown docs\deps-report.md

# ② 引导下载：默认 dry-run（只打印计划）；-Apply 才真下载（curl -C - 断点续传 + 下完校验大小）
powershell -NoProfile -ExecutionPolicy Bypass -File gateway\tools\bootstrap-downloads.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File gateway\tools\bootstrap-downloads.ps1 -Apply -Only qwen-unet,qwen-clip,qwen-vae
powershell -NoProfile -ExecutionPolicy Bypass -File gateway\tools\bootstrap-downloads.ps1 -Apply -Only sd-clip
```

### B2. Krea2 三件套（决定 `Krea2_Q4` 能不能出图；也是**唯一能把中文写准**的档）

```powershell
# 三件必须凑齐，少一件该档位就 no-model（补齐前后都实测过：文件齐了 status 立刻变 ok）
powershell -NoProfile -ExecutionPolicy Bypass -File gateway\tools\bootstrap-downloads.ps1 -Apply -Only krea-unet,krea-clip,krea-vae
```

| 文件 | 大小 | 为什么必须是它 |
|---|---|---|
| `models\unet\krea2_turbo-Q4_K_M.gguf` | 6.97G | 官方仓库 `krea/Krea-2-Turbo` 是 **gated（需授权）**，社区 GGUF 版免授权可直接下 |
| `models\text_encoders\qwen3-vl-4b-heretic_int8.safetensors` | 4.50G | ComfyUI 的 Krea2 分支硬要求 **QWEN3VL_4B**；用本机已有的 8B 会「加载成功但出糊图/报错」 |
| `models\vae\krea2-vae.safetensors` | 0.24G | Krea2 latent 是 **64 通道**，误用 qwen 的 16 通道 VAE → `VAEDecode` 直接 `expected 64 channels, got 16` |

> 只想要「人物海报」不需要 Krea2；需要**在图上写中文字**（如「深度求索」）时才装。装好后 `-AddText "DeepSeek / 深度求索"` 会自动走「先出图 → Krea2 最后加字」。

---

## 4. 分步安装（跟着清单走）

### A. SD WebUI + 模型 + CLIP（决定 `SD_FP16` / `Anima_INT8` 能不能出图）

```powershell
# A1 装 WebUI（或直接用你已有的整合包）
#    已有整合包：确认目录里有 launch.py 与 python\python.exe
#    自举安装：插件自带 install-sd.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File install-sd.ps1

# A2 放 checkpoint / VAE / LoRA（见 2.2 的落盘路径）

# A3 补 CLIP 文本编码器（1.59G，缺它必 500）
$dir = "<SD>\.cache\huggingface\hub\models--openai--clip-vit-large-patch14\snapshots\8d052a0f05efbaefbc9e8786ba291cfdf93e5bff"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
curl -L -C - -o "$dir\model.safetensors" https://hf-mirror.com/openai/clip-vit-large-patch14/resolve/main/model.safetensors

# A4 恢复 A1111 原生 pin（transformers 5.x 会让 SD 崩溃）
& "<SD>\python\python.exe" -m pip install --no-deps --timeout 60 -i https://pypi.tuna.tsinghua.edu.cn/simple `
    transformers==4.30.2 tokenizers==0.13.3 huggingface_hub==0.23.5

# A5 ADetailer（默认面部修复用）
#    在 WebUI → Extensions → Install from URL 填 https://github.com/Bing-su/adetailer ，装完重启
```

### B. ComfyUI + Qwen 三件套（决定 `QwenImage_NVFP4` 能不能出图）

```powershell
git clone https://github.com/comfyanonymous/ComfyUI D:\ComfyUI
cd D:\ComfyUI
python -m venv venv
.\venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu128
.\venv\Scripts\pip install -r requirements.txt
git clone https://github.com/city96/ComfyUI-GGUF custom_nodes\ComfyUI-GGUF
# 权重三件套（把域名换成 hf-mirror.com 即可国内直连，见 2.3 表格）
#   models\unet\qwen-image-2.1-UC-Q4_K_M.gguf
#   models\text_encoders\qwen3vl_8b_int8_convrot.safetensors
#   models\vae\qwen_image_2.1_vae_bf16.safetensors
powershell -NoProfile -ExecutionPolicy Bypass -File gateway\tools\bootstrap-downloads.ps1 -Apply -Only qwen-unet,qwen-clip,qwen-vae
```

### C. 起服务 + 自检

```powershell
# 起网关（幂等；它会在需要时自动把 SD / ComfyUI 拉起来）
node gateway\index.js

# 自检：打印解析后的配置 + 4 个模型的真实可用性
node gateway\index.js --check

# 期望（本机实测）：
#   SD_FP16=ok  Anima_INT8=ok  QwenImage_NVFP4=ok  Krea2_Q4=ok（三件套齐了）/ no-model（未装）
#   monitor.source=nvidia-smi（没起 rosbridge 时自动降级，正常）

# 跑测试（不占显卡）
npm run test:gateway        # 69 项单测/集成，全绿才算装对
```

---

## 5. 装完自检清单

| 检查 | 命令 | 期望 |
|---|---|---|
| 网关活着 | `curl http://127.0.0.1:8799/api/health` | `"gateway":"ok"`，engines 里 webui/comfy 至少一个 ok |
| 模型可用性 | `curl http://127.0.0.1:8799/api/models` | 4 项：装了的 `ok`，没装的 `no-model`（明确，不崩） |
| SD 能出图 | `curl -X POST http://127.0.0.1:8799/api/generate -H "Content-Type: application/json" -d "{\"model\":\"SD_FP16\",\"prompt\":\"1girl, solo\",\"width\":512,\"height\":768,\"steps\":12}"` | 返回 `task_id`；随后 `curl http://127.0.0.1:8799/api/status/<id>` → `success` + `paths` |
| ComfyUI 能出图 | 同上，`"model":"QwenImage_NVFP4"` | 首次约 60-100s（要载 8.7G 编码器） |
| 引擎能被网关拉起 | `curl -X POST http://127.0.0.1:8799/api/engines/webui/ensure` | `"online":true` |
| 依赖体检 | `gateway\tools\check-deps.ps1` | 该装的项全 ✓ |
| 插件冒烟 | `node smoke-skill.mjs` | 21 项 `SMOKE OK` |

---

## 6. 故障对照表（装完最常见）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| ① | SD `/sdapi/v1/options` 正常，但 `txt2img` **500 `ExceptionGroup`** | HF 缓存里只有 tokenizer 四个小文件、**没有 CLIP 权重（1.59G）**；旧逻辑"目录在=缓存命中"还会设 `HF_HUB_OFFLINE=1`，于是 `CLIPTextModel.from_pretrained` 直接 OSError | 见 2.2 `sd-clip`：补 `model.safetensors`；插件的 `sd-direct.ps1` 已改成"权重真的在才算命中" |
| ② | SD 启动日志：`AttributeError: 'CLIPTextModel' object has no attribute 'text_model'` | 装成了 **transformers 5.x**（A1111 需要 4.x） | 见 2.2 `sd-pin`：`pip install --no-deps transformers==4.30.2 tokenizers==0.13.3 huggingface_hub==0.23.5` |
| ③ | 网关"拉起引擎"有 PID 但什么都没发生 | 带文件沙箱的宿主里 `detached:true` 子进程会退出码 0 却写盘被拒 | 用默认（非 detached）；确需 detached 设 `GW_ENGINE_DETACHED=1` |
| ④ | ComfyUI 400 `value_not_in_list: sampler_name: 'DPM++ 2M'` | A1111 采样器名发给了 ComfyUI（两套命名空间） | v1.0.5 已修：网关按引擎分流映射；也可在表单里给 ComfyUI 档位留空采样器 |
| ⑤ | Qwen 出图崩在加载编码器 / access violation | 8.71G 文本编码器需整体入内存，系统可用内存 < 7G | 关掉浏览器/QQ 等；或 ≥32G 内存 |
| ⑥ | 任务一直 `queued` 不动 | 旧版"低显存硬闸"把引擎常驻显存误判成跑不动 | v1.0.5 默认只预警放行；确需排队设 `GW_VRAM_STRICT=1` |
| ⑦ | `.ps1` 中文全乱、语法报错 | 编辑后丢了 **UTF-8 BOM**（PS5.1 按 GBK 解码） | `powershell -File gateway\tools\fix-bom.ps1 <文件>` |
| ⑧ | 出图两张 | 表单已出图又跑了素体迭代 | v1.0.5 已修（表单出图即跳过素体迭代） |

---

## 7. 运行时目录（本机示例）

```
D:\SD.4.8\                                  # SD WebUI 根
├─ models\Stable-diffusion\  models\VAE\  models\Lora\
├─ extensions\                              # ADetailer / ControlNet / SAM …
└─ .cache\huggingface\hub\models--openai--clip-vit-large-patch14\…\model.safetensors

D:\ComfyUI\                                 # ComfyUI 根
├─ venv\  custom_nodes\ComfyUI-GGUF\
└─ models\{unet,text_encoders,vae}\         # Qwen 三件套

D:\DSWorkPlace\                             # 工作区（产物 & 网关日志）
├─ SD-Picture\                              # 所有成品落这里
└─ .dsh-gateway\logs\                       # 网关 JSONL 日志 / 引擎启动日志
```

---

## 8. 卸载 / 回滚

| 对象 | 做法 |
|---|---|
| 插件 | DSH 插件页卸载，或删 `node_modules\dsh-unrestricted-printing` |
| 网关 | 结束 node 进程即可（**建议 `taskkill /PID <pid> /F`，别加 `/T`**：SD/ComfyUI 是它按需拉起的子进程） |
| SD pin 回滚 | 需要回到新版 transformers：`pip install --no-deps transformers==5.20.1 tokenizers==0.23.3 huggingface_hub==2.2.0`（旧版本号见 `tmp\sd-pip-versions-before.txt`） |
| 模型权重 | 直接删对应文件；缺了插件会明确报 `no-model`，不会崩 |

---

## 9. 版本与打包

```powershell
# 本地跑全量测试
npm test                    # 冒烟 + 单测 + 网关测试

# 生成发布产物（GitHub Release 用）
npm pack                    # → dsh-unrestricted-printing-0.0.1.tgz（npm 安装用）
powershell -NoProfile -ExecutionPolicy Bypass -File publish-npm.ps1 -DryRun   # 只检查不发布

# GitHub 发布流程（tag push 后由 .github/workflows/release.yml 自动构建并挂产物）
git tag v0.0.1 && git push origin v0.0.1
```
