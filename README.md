# dsh-unrestricted-printing

[![npm](https://img.shields.io/npm/v/dsh-unrestricted-printing.svg)](https://www.npmjs.com/package/dsh-unrestricted-printing)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/savinglighting/dsh-unrestricted-printing/blob/main/LICENSE)

**DeepSeek Harness 插件 · 本机 Stable Diffusion 生图九件套 + 违规分流协议（A 档 / C 档）· 跨机器零适配**

> **本包原名 `dsh-sd-bridge-guard`（v1.3.0）**，现改名 **`dsh-unrestricted-printing`**，以本仓库独立发布（首发版本 **v0.0.1 测试版**）：
> 仓库 `savinglighting/dsh-unrestricted-printing`、npm 包 `dsh-unrestricted-printing`。
> 功能不变，`sd-bridge` 组件 id 不变，旧 profile 配置可继续沿用（详见 [CHANGELOG.md](CHANGELOG.md)）。

让 DeepSeek Harness 直接调用你电脑里的 Stable Diffusion WebUI 生图：不用提前打开 SD（首次调用自动以纯 API 模式拉起）、不用改任何路径——装上插件就能用。

---

## 🆕 版本更新内容（v1.0.5 · 2026-10-18）· 架构升级：本地 AIGC 调度网关

**本轮把「脚本串联式生图插件」重构成「带资源治理与高可用容灾能力的本地 AIGC 调度网关」。**
前端（`sd-inject.ps1` 表单 / 插件工具）**只跟网关说话**，不再直连 WebUI(7860) / ComfyUI(8188)。

> **装这个插件要下载什么？** 全部列在 **[INSTALL.md](INSTALL.md)**：每一项都有用途、大小、国内镜像地址、
> 落盘路径、校验方式（SD WebUI + checkpoint/VAE/LoRA + **CLIP 文本编码器 1.59G** + Python pin + ADetailer +
> ComfyUI + GGUF 节点 + **Qwen 三件套 13.6G** + Krea2 + Ollama 视觉质检 + ROS2）。
>
> 两个配套脚本（`gateway/tools/`）：
> - `check-deps.ps1` —— **依赖体检**：逐项 ✓/⚠/✗ + 路径 + 大小 + 缺失项的现成下载命令（可 `-Markdown` 出报告）
> - `bootstrap-downloads.ps1` —— **引导下载**：默认 dry-run 只打印计划，`-Apply` 才真下载（curl 断点续传 + 大小校验）
>
> ```powershell
> npm run deps:check        # 体检（本机实测：23 项 OK21 / WARN2 / MISSING0）
> npm run deps:bootstrap    # 看要下什么（加 -Apply 执行）
> npm run pack:github       # 打 GitHub 发布产物 → dist\*.zip + *.tgz
> ```


### ① 网关与双引擎路由（P1）

| 模型枚举（**严格 4 个**） | 引擎 | 说明 |
|---|---|---|
| `SD_FP16` | WebUI `/sdapi/v1/*` | FP16 精度，用 WebUI 当前 checkpoint |
| `Anima_INT8` | WebUI `/sdapi/v1/*` | INT8 量化（SD 系，沿用当前 checkpoint） |
| `QwenImage_NVFP4` | ComfyUI `/prompt` | 本机是 Qwen-Image-2.1 UC **Q4_K_M** GGUF（同族；NVFP4 缺失时自动落到 GGUF） |
| `Krea2_Q4` | ComfyUI `/prompt` | 未下载模型 → 探测为 `no-model`，提交时给**明确错误**而不是崩 |

- `POST /api/generate` → `{task_id, status:'queued'}`（立刻返回，不阻塞）
- `GET /api/status/{task_id}` → `queued / training / running / success / failed`（失败带 `error_code` + 阶梯记录，可查）
- 启动：`node gateway/index.js`（幂等：端口上已有网关时直接退出 0）
- 自检：`node gateway/index.js --check` 打印解析后的配置 + 4 个模型的真实可用性

### ② 进程管家与 OOM 阶梯强杀（P2）

- 台账记录每个引擎的 **PID / 启动参数 / 健康 / 重启次数**（端口反查纳管：不是网关拉起的 SD/ComfyUI 也能被管）
- OOM 时 `taskkill /PID {pid} /F /T` **强杀整棵进程树**（含"端口反查补刀"）；拒绝强杀网关自身/父进程
- 阶梯重启重试：`--medvram → --medvram-sdxl → --lowvram`，**每级最多 1 次**；用尽 → 任务 `failed(OOM_LADDER_EXHAUSTED)` + 日志留痕
- 全部 try-catch；`gateway/test/oom-ladder.test.mjs` 用 mock exec/spawn 覆盖（含 spawn 失败、build 失败、无启动命令）

### ③ ROS2 监控（P3）

- 连 `ws://localhost:9090`（rosbridge）订阅话题，**只收 JSON**；握手/订阅/解析全 try-catch
- 断连 → 自动降级 `nvidia-smi`；再有异常 → 快照标记 `stale` 并**放行**（监控绝不阻塞出图）
- 用途：队列准入提示 + OOM 预警（写进任务记录 `vram_warning`），**不做硬闸门**
  （`GW_VRAM_STRICT=1` 才改成"低显存排队等待"——实测硬闸会把任务永久卡在队列）
- 零依赖：`gateway/lib/ros2.js` 手写 RFC6455 客户端（插件目录不适合带一堆 npm 依赖）

### ④ 队列 / 独占锁 / 训练互斥（P4）

- **单车道排队锁**：准备阶段（校验/探测）不占锁；正式出图才抢锁，抢不到**排队**而不是拒单
- 训练独占：`POST /api/training/start` → `isTraining=true`，此时任何生图请求 **409**；`/api/training/end` 释放
- `sdxl_train_network.py` **强制注入** `--network_dim=4 --optimizer_type=AdamW8bit --lowvram`（同名参数以强制值为准，不重复注入）
- 训练结束 / 异常退出 / **网关重启**都必须释放锁 + 清理临时文件（启动时读状态文件做崩溃恢复）

### ⑤ `sd-inject.ps1`：**启动先弹「是/否」→ 生图（含加字）→ 打开成品 → 参数表**（C 档流程，2026-10-20 定稿）

- **脚本一启动就弹「是否开启视觉审查」是/否窗**（用户要求 2026-10-20）：它是**第一个**窗口，
  前面不准有任何阻塞步骤 —— 键鼠实测 **4.1 秒**出现在桌面（`-StartDialog yes|no` 可跳过弹窗直接定档，自动化用）。
  · 【是】开启视觉审查 = 跑完整生图（素体自检迭代 + 脸/手质检迭代，慢一些但质量有保障）；
  · 【否】关闭视觉审查 = 按正常生图流程出一轮（快）。
  两侧后续完全一致：**生图（有加字要求就加字）→ 自动打开成品 → 弹参数表**。
- **顺序定稿**：之所以要有这个开头的小窗，是因为 10-18 那版「先生成后弹窗」让用户对着空白控制台干等
  **2 分 42 秒**（实测心跳 `01:10:30 pregenerate-start` → `01:13:12 pregenerate-done`），
  感受就是「脚本启动了什么都没有」。现在开头的选择窗 4 秒出、出图进度在控制台可见。
  想回到「先弹参数表、点了才出图」用 `-NoPreGenerate`（`-PreGenerate` 保留兼容，等价默认）。
- **预生成阶段就把字加上**（用户要求「有加字要求就加字」）：`-AddText` 非空时，
  出完图立刻用**另一档模型**（`Resolve-AddTextModel`，Krea2 优先）在成品上写字，
  自动打开的、状态栏显示的、以及 `-PreGenPath` 引用的都是**带字的那张**（另存 `原名_文字.png`，原图保留）。
  预生成已经加过字的那张，后面任何出口都不会再加第二遍（`$script:PreGenTexted` 双份字保护）。
- **表单也有「加字」行**（文本框 + 「加字模型」下拉，默认 `自动（换另一档）`）：留空 = 不加字；
  表单里填的字作用于**点击「确定出图」之后**那一次出图（预生成早就跑完了，不可能回头用表单里的值）。
  为什么要有这一行：以前加字只能靠对话传 `-AddText`，表单里没地方填 —— 对话漏传就永远没有字。
- **加字不会再被绕过**：四条出口（预生成 / 「追加为空 → 直接收尾」捷径 / 最终出图 / 质检模型不可用）
  统一走 `Invoke-AddTextStage`；以前那条捷径是 `exit 0`，把加字整段跳过去了。
- **加字参数实测**：ComfyUI 路由的 denoise 偏钝，`0.42` **字根本写不上去**（用户报的「文字没有给我」），
  `0.60` 排版崩、`0.65` 干净、`0.78` 多画连接词 —— 默认 `-AddTextDenoise 0.65`。
- **加字位置 / 字号 / 字体风格都能选（2026-10-21 用户要求）**：
  · 对话侧参数：`-AddTextPos`（`random` 默认 / `TL…BR` 九宫格 / `"x,y"` 自由点）、`-AddTextSize`（小·中·大·特大）、
    `-AddTextStyle`（粗体无衬线（白，默认）·细体无衬线·衬线体·手写楷体·霓虹发光·描边黑体·中文书法）；
  · 用户侧：参数表「加字位置」行的「缩略图选位置…」按钮 → **选位器**：**右侧是成品缩略图**
    （点哪儿字就放哪儿，画红叉 + 实时文字预览），左侧是九宫格 + 随机 + 字号/字体风格下拉 + 位置读数；
    「用这个位置」把三项一起回填。参数表还有独立的「字号/风格」栏。
  · 位置/字号/风格任一改动 → 出图阶段会**从未加字的原图重加一遍**（不会把新字叠在旧字上）。
  · 不传位置 = 脚本开始时**随机**挑一格加字（随机结果写进日志与心跳）。
- **加字提示词的定稿口径**：目标文字用双引号括住、放提示词**最末尾**；方位短语在**前段**；字号只出一个形容词
  （`small` / `big` / `huge`）接在风格段前面 —— 全句只有一个名词 `title`，与验过的模板同构。
  实测（本机视觉模型逐字核对图上文字）：带名词的旧写法会被画成假字（`Poster` / `Pioster` / `Tinle`），定稿写法不会。
- **宽×高首次沿用命令行 `-Width/-Height`**（超本档长边上限时等比收进来，不用会报错的尺寸）；
  之后改比例/画质/换模型仍是「档位最后说话」（坑63 不受影响）。
- **进度可视（2026-10-19）**：后台出图阶段给 **7 步清单 + 双进度条**——
  ①检查参数与目录 ②网关就绪 ③引擎就绪（必要时拉起 SD/ComfyUI）④提交任务 ⑤出图 ⑥落盘 ⑦弹窗；
  出图这步实时打「`采样 26% · 预计剩 5s`」（WebUI 读 A1111 真实进度；ComfyUI 无进度接口 → 按时间估算并标「估算」）。
  表单里同样有进度条，点「确定出图」后也会动（数据源：网关 `GET /api/progress/{task_id}`，前端仍不直连引擎）。
- **参数表左右两栏（2026-10-19）**：左栏 = 正向/负向两个大提示词框（宽 556 × 高 312，带滚动 + 底部编辑提示）；
  右栏 = 模型档位/模式/底图/蒙版/Denoising/视觉审查/迭代次数/比例/画风/画质/LoRA/checkpoint/命名/宽×高/加字
  + 进度条 + 状态栏 + 按钮（控件名与自动化定位规则保持不变，键鼠脚本无需改动）。
- 预生成档位由 `-Model` 指定（4 枚举之一，默认 `QwenImage_NVFP4`）；只在 `-PreGenerate` 时才跑，
  失败/超时**不挡表单**，照常弹出可手动重出。
- 模型下拉**严格限定 4 枚举**；宽×高（默认跟随命令行 `-Width/-Height`，改比例/画质会重算）；状态栏；
  **一个**「确定出图（走网关）」按钮（原来「提交出图」+「确定出图」两个按钮重复 → 已合并成一个，它同时是 AcceptButton）
- 点确定 → `POST /api/generate`（`-TimeoutSec 2`）拿到 Task_ID → `System.Windows.Forms.Timer(Interval=2000)` 异步轮询
- 状态栏配色：`queued` 黄 / `training` 橙 / `running` 蓝 / `success` 绿 / `failed` 红
- 连续 3 次请求失败 → 停表 + 显示「**与网关断开连接**」；任务结束或 `FormClosing` 一律 `$timer.Stop()` + `$timer.Dispose()`
- `Krea2_Q4` 且宽或高 > 1024 → 弹窗报错并 `return`（宽高用 `[int]::TryParse()` 解析）；`$form.AcceptButton = $btnSubmit`
- **默认画风 = 「保持画风」**：不再往提示词框里塞画风词（用户反馈"提示词疑似被固定画风"——
  默认档位曾把 `anime style / cel shading / (3d:1.2) …` 写进两个框；现在默认一个词都不加，
  想加画风自己选档位，选了才会幂等写进去）
- **图生图 Denoising 默认 0.65**（用户指定）：切到「图生图」时 Denoising 自动给 `0.65`
  （更贴底图可选 0.4-0.5；≥0.7 属大改，一致模式仍会在 0.65 处收敛防止把原图洗掉）
- 表单已出图 → 自动跳过素体自检迭代（不再"点一次出两张"）
- 所有网络请求 try-catch，**表单绝不假死**；网关没在跑时脚本会自己把它拉起来（`-NoGatewayAutoStart` 可关）
- 素体自检迭代 / 最终出图同样经网关；引擎预热改为 `POST /api/engines/{engine}/ensure`；提交时控制台留痕（模型/尺寸/底图/蒙版 + 两个提示词框原文）

### ⑥ 测试交付（P6）

- `gateway/test/`：67 项 Node 单测/集成测试（路由分流 / 状态机 / OOM 阶梯 / 训练锁 / ROS2 降级 / 超时熔断 / 单车道并发 / 参数透传）
  用**假 WebUI + 假 ComfyUI + 假 rosbridge**跑，不碰真实后端：`npm run test:gateway`
- `gateway/tools/ui-gateway-verify.ps1`：**真实键鼠**驱动表单，逐档位 × 逐模式（文生图/图生图）验证出图；
  参考图从 `SD-Picture` 与 `D:\截图` **随机抽取**（禁止指定特定图）
- 真机实测（2026-10-18）：`SD_FP16` 文/图生图、`Anima_INT8`、`QwenImage_NVFP4`（ComfyUI 真机 GGUF）全通；`Krea2_Q4` 按预期给出"模型未就绪"明确错误

### 本轮踩到并修掉的坑（真机实测回填）

| 坑 | 现场 | 修法 |
|---|---|---|
| 56 | SD txt2img 500 `ExceptionGroup`，而 `/sdapi/v1/options` 一切正常 | SD 侧 HF 缓存只有 tokenizer 四个小文件、**没有 CLIP 权重**（1.7G），旧逻辑"目录在=缓存命中"→ 设了 `HF_HUB_OFFLINE=1` → `CLIPTextModel.from_pretrained` 直接 OSError。修：离线判定必须落到"文本编码器权重真的在" |
| 57 | `Init-Observability` 报 `CommandNotFoundException`，日志/心跳静默失效 | PowerShell **不做函数前向引用**：调用在 321 行、定义在 700+ 行。修：定义上移到调用之前 |
| 58 | 网关"拉起引擎"看着有 PID，实际什么都没发生 | 带文件沙箱的宿主里 `detached: true` 子进程**退出码 0 但写盘全被静默拒绝**。修：默认非 detached（`GW_ENGINE_DETACHED=1` 可开） |
| 59 | 低显存时任务永久卡在队列 | 准入硬闸把"引擎常驻显存"误判成"跑不动"。修：默认只预警放行，`GW_VRAM_STRICT=1` 才排队 |
| 60 | UI 自动化里下拉框按 Enter 会**提前出图** | 表单 `AcceptButton = 提交出图`，下拉关闭时的 Enter 穿透到表单。修：自动化一律用 Tab 提交选择 |
| 61 | 改过的 `.ps1` 突然语法全错 | 编辑器去掉了 UTF-8 BOM → PS5.1 按 GBK 解码中文全乱。修：`gateway/tools/fix-bom.ps1`（改完 .ps1 就补 BOM） |
| 62 | SD 出图 500 只回一句 `ExceptionGroup`，用户看不懂也救不回 | A1111 把设备错位/OOM 都包成这个空壳。修：① 网关识别到 `ExceptionGroup` 先 `POST /api/sdapi/v1/reload-checkpoint` 自愈一次再重试；② `sd-direct.ps1` 早有的 reload 自愈保持不动（两边都不再调 unload） |
| 63 | 表单「宽×高」永远停在 264×480，改画质也不动 | 「用户改过就不再同步」的守卫被宿主初始化时触发的一次 TextChanged 永久置位。修：档位永远是最后说话的人（改比例/画质一定重算覆盖） |
| 64 | 键鼠自动化里 ComboBox 一展开，整个控件树就变空 | 本机 MSAA→UIA 桥对下拉弹窗不暴露条目名，展开后该进程自动化树整体失效。修：自动化改「点提示词框 → Tab 走到下拉 → 方向键改档」，全程不展开列表 |
| 65 | **用户实测"两次都没出图"**：ComfyUI 路由 400 `value_not_in_list: sampler_name: 'DPM++ 2M'` | A1111 与 ComfyUI 的采样器名是两个命名空间。修：① 网关按引擎分流（A1111 名映射成 `dpmpp_2m` 等，映射不到回落模型推荐值）；② `sd-inject` 只对 WebUI 档位透传采样器；③ ComfyUI 的 `node_errors` 翻译成人话再报错 |
| 66 | 点一次「确定」出两张（表单一张 + 素体迭代一张） | 表单已出图后仍跑素体自检迭代。修：`$P.GwPaths` 非空即跳过素体迭代 |

### A 档链路同样收口到网关

`sd-direct.ps1` 的 `Invoke-SdApi` 现在**优先经网关出图**（`POST /api/generate` + 轮询 `/api/status`），
把 hires fix / restore_faces / ADetailer / inpaint 等参数原样透传给网关（`extra` 字段），
产物读回 base64 后按原逻辑落盘命名。网关不在时打印提示并回退直连（`-NoGateway` 可强制直连），
所以「前端不直连 WebUI/ComfyUI」在 A 档工具链上也成立。

### 运维注意

- 网关默认 `127.0.0.1:8799`；`node gateway/index.js`（幂等）。关停网关请用 `taskkill /PID <网关PID> /F`
  （**别加 `/T`**：SD/ComfyUI 是网关按需拉起的子进程，`/T` 会把它们一起停；加了也没关系，下次出图会自动 `ensure` 拉起）。
- 关键环境变量：`GW_PORT` / `GW_OUT_DIR` / `GW_WEBUI_URL` / `GW_COMFY_URL` / `GW_ROS2_URL` / `GW_VRAM_STRICT` /
  `GW_ENGINE_DETACHED` / `GW_TRAIN_SCRIPT` / `GW_LOG_LEVEL`；也可写 `gateway.config.json`（插件根或工作区）。

---

## 🆕 版本更新内容（v1.0.1 · 2026-10-16）

**本轮三件事：下载后能自查缺什么、蒙版可以鼠标手绘、C 档违禁词能注入表单。**

### ① 文件完整性检测（新功能）

别人拿到插件后不再只能靠「跑一下看看报不报错」判断包是否完整——现在有**基线清单 + 反向比对**：

```bash
node verify-integrity.mjs              # 本机 vs 随包清单，终端彩色表格
node verify-integrity.mjs --remote     # 再比对仓库最新版（列出新增/更新/移除）
node verify-integrity.mjs --md         # Markdown 表格（贴 issue / 回复用）
node verify-integrity.mjs --json       # 机器可读
```

或在 DSH 里直接说「**检查一下 SD 插件少了什么文件**」→ 模型调 `sd_integrity` 工具，回你一张排好版的表：

| 状态 | 文件 | 分类 | 大小 | 影响 |
|------|------|------|------|------|
| ✗ 必需 | `sd-mask-qa.py` | runtime | 6737B | 插件无法运行 |
| △ 辅助 | `test-vram-release.ps1` | tool | 3441B | 该功能不可用 |
| · 可选 | `CHANGELOG.md` | doc | 123626B | 不影响运行 |

分类决定严重度（`runtime` / `tool` / `doc`·`dev`·`ci`），不搞一刀切——npm 包装不上 dev/doc 是正常的，只有 `runtime` 缺失才是真告警。

**自动触发点**：插件启动时跑一次（缺必需文件记醒目告警）；退出时再跑一次并落盘 `~/.dsh-sd-bridge/integrity-report.{json,md}`。

**发布者侧**：`node gen-manifest.mjs` 生成基线，`--check` 校验是否过期（CI 用）；`prepublishOnly` 已挂自动生成 + 校验。

### ② 手绘蒙版（新功能）

C 档参数表「蒙版」下拉新增 **`手动绘制（鼠标涂抹）`**（紧跟「自动」之后）——选中即弹出参考图，鼠标涂出要重绘的区域：

| 操作 | 效果 |
|------|------|
| 左键拖动 | 涂抹要重绘的区域（笔迹显示为半透明红） |
| 右键拖动 | 擦除 |
| 滚轮 | 调笔刷大小（6–200 px，标题栏实时显示） |
| `C` 键 / 清空 | 清空全部笔迹 |
| `Enter` / 确定 | 保存蒙版并出图 |
| `Esc` / 取消 | 放弃，**回退自动蒙版**（不静默重画整张） |

画布最长边压到 900 px 保证不卡，保存时按**参考图原始尺寸**还原（蒙版与 SD 目标尺寸对齐）。手绘优先级最高，不会被自动抠图/替换目标推断覆盖。

### ③ C 档违禁词注入表单（技术测试链）

`sd_inject` 新增 `violationPrompts` / `suggestedPrompts` 参数，脚本侧新增 `-ViolationPrompts` / `-SuggestedPrompts`，分别预填进参数表单第一个框（正向）与第二个框（负向）。五层防线防漏传：schema `required` → `execute()` 抛错 → hint 告警 → 命令拼参 → 启动器传参。

### ④ 真机故障修复

- **`sd-inject.ps1` 缺 UTF-8 BOM → PS 5.1 按 GBK 读中文语法错**。三份脚本统一补 BOM，`parse errors = 0`。
- **SD 后端 500（`Expected all tensors to be on the same device, but found cpu and cuda:0`）**：8G 卡上 `qwen3-vl:8b` 常驻 5.05G，SD 再要 4-5G → CLIP 编码器部分层被挤到 CPU，张量设备不一致直接崩。卸载常驻模型后 275MiB → 6731MiB 空闲。
- **SD 重启后 CLIP tokenizer 联网超时**：本地缓存本是完整的，但没设 `HF_HOME` 跑去拉 huggingface.co 超时。带上 `HF_HOME` + `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1` → **9 秒就绪**（原来 57 秒）。

---

## 版本更新内容（v1.0.0 · 2026-10-16）

**首个正式版。其中「C 档选项表」按用户要求做了调整：画风不再列在里面。**

- **画风不进选项表**：画风在 C 档参数表单里是一个**档位** —— 选中就把该画风的词**直接写进「正向提示词」框**（负向词写进负向框），它属于提示词内容；所以选项表只留 **模型 / LoRA / 比例 / 画质 / 迭代 / Denoising**，并在表下注明「画风不在本表里，去 C 档表单选或直接编辑提示词」。
- 表单里的画风下拉**保留**（选档位 → 自动注入画风词 + 需要时联动切 checkpoint/挂 LoRA）。
- 另外把 0.9.15→0.9.24 那一整轮真机修复一并收进正式版（蒙版/抠图/审核/显存/中间图清理/命中率体检/后缀逗号），详见 CHANGELOG。

---

## 版本更新内容（v0.9.23 · 2026-10-16）

**每次运行前先释放显存（8G 卡上三方抢卡的治本手段）。**

- **实测问题**：SD 常驻 2.5-5G + 抠图（YOLO-World + SAM）2-3G + 8B 视觉模型 **5278MB** —— 都常驻时只剩 **0.46G**。后果就是抠图 CUDA OOM（python 被原生崩掉、只报「没有输出」）和审核被挤到 CPU（40-180s）。
- **修法**：`Ensure-Vram` 在每个「要显存」的步骤开跑前**按需**释放对面那一侧 ——
  抠图前 / 审核前让 A1111 卸载 checkpoint（出图时自动重载，用户无感）；素体出图前 / 最终出图前 / 收工后让本地模型服务卸掉常驻模型（`keep_alive:0`）。
  只在剩余显存低于 `-VramMinFreeGb`（默认 4G）时才动手；`-NoVramRelease` 可整体关掉。
- **实测效果**：`0.46G → 7.02G（+6.56G）`；另一个场景 `4.98G → 7.08G`。
- **顺带**：审核现在能在 GPU 上跑（实测 11.9s 出分，而不是 40-65s 的 CPU 兜底）。

---

## 版本更新内容（v0.9.22 · 2026-10-16）

**审核模型换成能识图的视觉模型；审核范围严格限制在技术性内容。**

- **默认模型改成 `qwen3-vl:8b`**（本机在册、**能识图**）：`itsailor/qwen3.6-fable` 那类量化创作模型是**纯文本**的（模型卡写明 vision 不可用、图片被静默忽略），做不了看图审核。插件页 `vlmModel` 仍可改，但脚本在「指定模型不在本机」时会回退到第一个 `vl`/`vision` 模型并提示。
- **审核只许碰技术性内容**：新增 system 约束（原生 `/api/chat` 与 `/v1` 兼容端点都带）——「你是生成图的结构缺陷检测器，唯一任务是检查人物解剖结构是否崩坏，只输出 0-100 分；**禁止评价 / 描述 / 审查 / 拒绝画面内容**：不判断题材、不判断服装与裸露程度、不涉及性内容、不做合规 / 道德 / 安全判断、不复述画面」。用户问句同样写明「只许输出分数，不许评论画面内容」；「画风=一致」的识别问句也加了「只判断画风（技术属性）」。
- **解析只认数字**：先认 `SCORE=<n>`，否则取第一个 0-100 的整数（813 这类跳过）；空白回答先 `Trim` 再判空。所以即使模型多嘴评价了内容，也不会进入打分逻辑。
- 真机验证：`review score = 100`（≥75 过关），elapsed 40.7s。

---

## 版本更新内容（v0.9.21 · 2026-10-15）

**素体不再额外生成；蒙版补部件；视觉审核「一致失效」的真因与修法。**

- **有参考图时跳过素体自检迭代**（图生图 / 蒙版重绘）：参考图本身就是底图，不再多出一张 `inject_00N.png`；文生图照旧。
- **审核失效真因**（真机复现 score=-1 / 180s 超时）：① 送审原图太大（先降分辨率，长边 768）；② 走 `/v1/chat/completions` 对思考型模型**不认 `think:false`**（`content` 恒空，改用原生 `/api/chat` + `think:false` + `num_predict=1024`，11.9s 出 `SCORE=100`）；③ 空白回答在 PowerShell 里是真值，`-not $raw` 判空失效（先 `Trim`）。配 `-VlmTimeoutSec` 可调超时，拿不到分数会打印模型原话与耗时。
- **蒙版**：衣服词表补 `sleeves / detached sleeves / hood / cloak / shawl / scarf`，检测框上限 2→`--max-boxes 3`，肩线守卫 8%→4%，连通块面积写进 notes。
- 「qwen3.6-fable」的真实身份：社区模型 `itsailor/qwen3.6-fable`（22GB，模型卡写明 **vision 不可用**）；同名的 `parable/qwen3-fable` 2.33GB。

---

## 版本更新内容（v0.9.20 · 2026-10-15）

**插件页开关「视觉模型审核是否启动」+ 审核模型换成 `qwen3.6-fable` + 审核范围扩到「人物肢体」。**

- **新设置 `vlmReview`**（默认 `true`）：C 档是否启用**视觉模型审核**。设为 `false` → 生成的命令带 `-NoVlmReview` → **不探活、不冷启动、不加载模型、不打分**（连参考图「画风=一致」的识别也不调模型），直接按迭代次数出满 N 张弹多选让你自己挑。适合「不想让本机模型介入审核」的场景。
- **新设置 `vlmModel`**（默认 `qwen3.6-fable`）：审核用哪个模型，会写成 `-VlmModel "<模型名>"` 传给脚本。⚠️ 本机现在的模型是 `qwen3-vl:8b` / `qwen3.5:latest` / `qwen2.5-coder:7b` / `qwen2.5-abliterate:14b`，**没有 `qwen3.6-fable`**，Ollama 官方库里也查不到这个名字（`registry.ollama.ai/v2/library/qwen3.6-fable` 返回 404）——要么 `ollama create qwen3.6-fable -f Modelfile` 自建/导入，要么把插件页这一项改成已有的视觉模型；脚本在「指定模型不在本机」时会打印「本机枚举到哪些 + 怎么拉/怎么建」并回退到第一个 `vl`/`vision` 模型，不阻断出图。
- **审核范围扩到整条肢体**：问句从「脸 + 手」变成三类——① 脸部（对称/无多余/五官错位/畸形融化）② 手部（五指齐全/多指少指/扭曲粘连）③ **肢体（手臂与腿是否各两条、左右对称、多肢少肢、关节反向错位、四肢畸形粘连、躯干与四肢比例失衡）**。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0920插件页开关视觉模型审核是否启动--模型换成-qwen36-fable--审核人物肢体)。

---

## 版本更新内容（v0.9.19 · 2026-10-15）

**插件页多一个开关：自动抠图要不要跑，你自己选。**

- **新设置 `maskAutoSegment`**（默认 `true`）：C 档是否允许自动抠图（YOLO-World + SAM 现算蒙版）。
  设为 `false` → 生成的命令带 `-NoAutoMask` → **完全不加载检测模型**（那条 python 链路不启动），
  改用几何区域蒙版（上半/下半/中间/四周，按画面比例画）或你在表单里手填的 `box:` / 蒙版图。
  适合「抠图脚本在这台机器上老崩 / 不想让脚本动 GPU」的场景。
- **修掉截图里那个「抠图脚本没有输出」**：真机复现了——**cuda 下检测模型会把 python 进程直接崩掉**
  （连一行 JSON 都没打，PowerShell 只能报「没有输出」）；同一条命令加 `--device cpu` **100% 成功，
  且结果逐像素一致**（覆盖 13.01%）。所以：① 失败说明现在带 **python 退出码 + stderr 尾巴**（不再是一句话）；
  ② **自动用 CPU 重试一次**并把过程打印出来；③ 抠图彻底失败时**不再 exit 1**，而是预填几何区域蒙版继续出图。
- **抠图失败不再让表单空着**：以前只留一句「蒙版栏保持可编辑，请你填 box:/路径/区域名」（用户不知道填什么）；
  现在按替换目标**预填**「下半（衣服）/ 上半（脸）/ 四周（背景）/ 中间（主体）」，点确定就能跑，仍可改。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0919插件页开关是否启动你自己选--修掉抠图脚本没有输出)。

---

## 版本更新内容（v0.9.18 · 2026-10-15）

**本地视觉模型可以彻底关掉：插件设置 `vlmAutoStart`。**

- 设为 `false` 时，`sd_inject` 生成的 C 档命令会在末尾追加 **`-NoVlmStart`**：视觉模型服务没起就**跳过质检**（出满 N 张让你自己挑），**绝不偷偷在你机器上拉起 `ollama serve`**。默认 `true`（= 没起就冷启动，见 v0.9.17）。
- 两种关法：① 插件设置 `vlmAutoStart: false`（写进 profile 的 `cordis.patch.yml`，需重启 dsh 生效）；② 单条命令上带 `-NoVlmStart`（立即生效，只影响这一次）。
- 已经关掉本地服务时，行为与「视觉模型本来就不可用」完全一致：照常出图，只是没有脸/手自动打分。

---

## 版本更新内容（v0.9.17 · 2026-10-15）

**本地视觉模型自动冷启动；C 档跑完产物目录只留成品。**

- **视觉模型冷启动**：脸/手质检与「画风=一致」的参考图识别都靠本机 Ollama 上的 `qwen3-vl:8b`。以前它没起就**静默降级**（素体只出一张、最终出图变成「出满 N 张让你自己挑」）——你看到的就是「插件没质检」。现在：没起就自动 `ollama serve` 并轮询到就绪（默认 60s，`-VlmStartTimeout` 可调；`-NoVlmStart` 关掉），失败只降级不阻断。**本机实测：Ollama 停着 → 冷启动 7.9 秒就绪 → 枚举到 `qwen3-vl:8b`。**
- **显存提醒**：8G 卡上 SD 常驻时 8B 视觉模型装不进显存（会走 CPU / 部分卸载），这时会明确告诉你「本次质检会明显变慢」，而不是让你以为卡死。
- **跑完只留成品**：`premask-*.png`、它的 `_overlay.png`、命中率总览图这类中间图，以前会堆在产物目录里；现在跑完自动清理（逐个打印「已清理中间图: xxx」），命中率总览图默认写进迭代临时目录随目录一起清。要留图排查加 `-KeepWorkFiles`，会把清单列给你。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0917本地视觉模型加入冷启动--c-档跑完只留成品)。

---

## 版本更新内容（v0.9.16 · 2026-10-15）

**抠图不再被显存打挂；衣服蒙版不再只留一块；新增「蒙版命中率体检」——蒙版准不准不用再靠人眼猜。**

- **SAM 显存自适应 + 兜底**：同一个参考图、同一条命令，22:10 抠得出、23:16 直接 `CUDA out of memory`（A1111 常驻，ViT-L 要更多显存）→ 旧代码报 `ok:false`，你看到的就是「蒙版没生效」，而且**时好时坏**。现在：剩余显存 ≥4.5G 才全分辨率上 cuda、3.0–4.5G 降到 640px、**<3.0G 直接走 CPU**；SAM 万一还是挂，用检测框生成粗蒙版（与人物剪影相交、必要时裁到躯干带）兜底，不再整条失败。
- **衣服连通块合并**：旧逻辑「只留最大连通块」，同一件衣服被 SAM 拆开时会丢掉袖子/裙摆那一侧；现在按「≥ 最大块 18% 且总覆盖 ≤32%」保留同件的多块。
- **新增 `sd-mask-qa.py` 蒙版命中率体检**：拿「参考图 / 本次蒙版 / 本次成品」逐像素判 **命中 / 命中未改 / 外溢 / 正确保留**，外加「疑似漏掉衣料」标记，输出数字 + 一张总览图（绿=已改 / 黄=未改 / 红=外溢 / 品红=疑似漏检）。**C-1b 出图后自动跑**，产品旁边落一张 `qa-<成品名>.png`。
- **想测蒙版，用中性提示词就够**（例如「把衣服换成红色长裙」）：蒙版外的残留衣料就是漏检。用「脱衣」类提示词反而自带陷阱 —— 模型会主动画「半脱的衣服」，那看着像漏检，其实那块像素**已经改过**（实测数字：蒙版内已改 72.9%、蒙版外被改仅 0.03%）。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0916抠图不再被显存打挂--衣服多块合并--新增蒙版命中率体检)。

---

## 版本更新内容（v0.9.15 · 2026-10-15）

**修 C 档蒙版不完善：`四周（背景）`这条路径整条是死的**（换背景/自动判成换背景时，拿不到蒙版 → 原图等于白给）。

- **根因（真跑确认）**：`New-RegionMask` 里 `$rects` 从未初始化 —— `$rects += @{...}` 从 `$null` 起步拿到的是 **Hashtable 不是数组**，环形要加第 4 块矩形时直接抛 `Item has already been added. Key in dictionary: 'Y'`；异常打断整句 → 蒙版为空 → 落到 C-1a。单矩形形状（上半/下半/中间/box）只是**碰巧**还能用，所以之前的「像素校验」全绿、坑一直藏着。
- **修**：函数开头补 `$rects = @()`，删掉 `$rects = $rects` 空操作。
- **区域蒙版改按「参考图的最终出图尺寸」生成**：以前按表单比例/画质画蒙版、出图尺寸再被参考图覆写、蒙版再被缩放一次 —— 传 `boxpx:x,y,w,h`（像素）时区域**整个错位**。现在 C-1a / C-1b 共用 `Get-RefOutputSize`，蒙版在画之前就把尺寸定好；只有「你自己带的蒙版图」才走缩放对齐。
- **补真跑回归**：新 `test-region-mask.ps1` 用 AST 抽出真函数、逐种蒙版**量白像素**（`四周（背景）` 修复前抛异常、修复后 51.3%），`smoke-skill.mjs` 会 spawn 它 —— 以前这个函数只有源码正则，一行都没真跑过，这就是它能一路发版的原因。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0915c-档蒙版真跑修复四周背景整条路径静默死掉--区域蒙版改按最终出图尺寸画--补真跑回归)。

---

## 版本更新内容（v0.9.14 · 2026-10-15）

**修「图生图和原图完全没关系」**（三条根因一起修，并且用数字证明底图真的在生效）：

- **底图不再被偷偷换掉**：以前图生图时「底图」留空，脚本会**静默**抓「输出目录最新一张」——常抓到无关文件（截图、别的产物）。现在**没底图就停下来报错**，并告诉你三种填法；只有你**显式**填「最近」才用最新一张。
- **附件引用也能当底图**：`图片 sha256:…`、`xxx.png [8a34ca32]`、带说明文字的无后缀路径，都会被正确解析（脚本会去输出目录、`ref`、DSH 附件目录里按哈希找图）。
- **图生图尺寸跟参考图走**：不再拿表单的 `9:16 / 480p` 去压参考图（1024×1024 被压成 480×853 会重新构图）；`一致` 模式下 denoising 过高也会被收敛（**高于 0.65 会把原图洗掉**，要大改请用「替换 + 蒙版」）。
- **蒙版支持精确坐标框**：`mask` 除了区域名，还可以传 `box:x,y,w,h`（0-1 归一化）或 `boxpx:x,y,w,h`（像素）；蒙版尺寸与出图尺寸不一致时**自动缩放对齐**，不再错位。
- **实测数字**：同 seed 同提示词，**img2img 距参考图 11.05/255**，txt2img 对照 **52.7/255** —— 底图在起作用；蒙版重绘时未蒙版区（脸/头发/背景）平均差 **0.00**。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0914图生图和原图没关系三连修底图必须真正生效--c-1a-跟参考图尺寸--蒙版坐标框)。

---

## 版本更新内容（v0.9.13 · 2026-10-15）

**任务类型改由对话判断，并直接替你选好蒙版；文生图时「底图 / 蒙版」两项锁定。**

- **对话层**：你只要说「用SD插件绘制一个银发少女」——对话判定为**文生图（C-0）**，表单里的**底图与蒙版会直接锁定**（灰掉、不可编辑，提示写明「文生图：不需要底图/蒙版，已锁定」），省得误填。
- 你说「把这张图的衣服换成红色连衣裙」并给一张图 —— 对话判定为**图生图（C-1）**，并把底图与**蒙版区域一起提交**（换衣服 → `下半（衣服）`；换脸 → `上半（脸）`；换背景 → `四周（背景）`），表单里这两项**已按对话的结论预填**，你仍可手改；模式切回文生图再切回来，蒙版值不会丢。
- 只改画风 / 整体贴近参考图（不替换）→ 对话不提交蒙版，走 **C-1a** 整图 img2img（denoising 0.4-0.5 保画风）。
- 底层：`sd_inject` 工具新增 `task` / `refImage` / `mask` 三个参数，会写进生成的命令与启动器参数（`-Mode` / `-InitImage` / `-MaskSpec`），复制命令出去也照样带。
- ⚠️ 工具的**参数定义是 dsh 启动时载入**的：这一版新增的参数要**重启 dsh** 才能在会话里生效（脚本侧已全部就绪）。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0913对话判断任务类型--直接提交蒙版区域文生图锁底图蒙版)。

---

## 版本更新内容（v0.9.12 · 2026-10-15）

C 档从「填一堆参数抽奖」变成**有决策树的出图流程**——专门解决「换个衣服结果连画风都变了」：

| 你想干的事 | 表单怎么填 | 脚本走哪条路 |
| --- | --- | --- |
| 纯文字出图 | 模式 = **文生图** | **C-0**：忽略底图与蒙版，用完整提示词直出 |
| 拿参考图改，画风要保持 | 模式 = **图生图**、底图 = 参考图（或填「最近」= 输出目录最新一张）、画风 = **一致（自动检测参考图）**、模型 = **一致（照参考图）** | **C-1a**：从参考图**自动检测画风/主体/模型**（PNG 元数据 → 本地视觉模型 → A1111 反推）并写进提示词，denoising 0.4-0.5 贴底图 |
| **换衣服 / 换脸 / 换背景** | 模式 = 图生图 + 蒙版 = **下半（衣服）**（脸 / 四周（背景）/ 反选…）；或蒙版留「无」但在提示词里写「**把衣服换成…**」→ 自动选区域 | **C-1b 蒙版重绘**：只重画蒙版区，**未蒙版区域像素级原样保留**（实测差异 0.00）→ 画风/背景不会跟着变 |

- 新增表单开关：**模式（文生图 / 图生图）**、**蒙版（无 / 上半脸 / 下半衣服 / 中间 / 四周背景 / 反选，或直接填蒙版图路径）**；画风与模型各加了 **「一致」** 档。
- 自动检测的优先级：**参考图自带 A1111 元数据**（模型 + 原提示词/负向词，一致性最强）→ 本地视觉模型判画风 → A1111 反推标签（动漫图走 deepdanbooru、照片走 clip）。
- 「一致」不是嘴上说：换衣服时脚本会**把参考图里衣服类标签剥掉**（dress/skirt/kimono…）再合并，其余（画风、脸、头发、背景）全部保留。
- 图生图没填底图会自动用输出目录**最新一张**；实在没有会用红字告诉你原因，不会偷偷改成文生图。
- 蒙版重绘默认 **fill=0 填充**（实测 fill=2「潜空间噪声」会在蒙版区留满噪点）、按参考图**原生尺寸**出图。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0912c-档决策树文生图--图生图一致--图生图替换蒙版重绘)。

---

## 版本更新内容（v0.9.11 · 2026-10-15）

修「**选了二次元，画出来却不是二次元**」—— 表单里的画风档位以前有的没词、有的不切模型：

- **「二次元」这一档以前完全没有映射**（`Get-StylePrompt` 里没有它的分支），它又是默认档 → 选了等于没选；现在补上正统二次元词（线稿 + 赛璐璐平涂 + 动漫眼，负向压 3D/照片感），另补「国风 / 赛博朋克」和「厚涂 / 水彩 / 像素风」的正向词，**12 个档位全部有映射**。
- **「二次元」现在会强制切回动漫底**：画风切模型是**持久**的（用过「写实」→ 停在 majicMIX、用过「彩色哥特」→ 停在 SemiRealMix），旧规则不会切回来 —— 这就是「二次元画不出来」的真正原因。现在选二次元会自动切到 **AWPainting**（本机动漫默认；找不到就依次找 anything / ReVAnimated / dark sushi）。
- **模型下拉首项直接显示真实当前模型**：`（当前模型：SemiRealMix.safetensors…）`，一眼看出「看着二次元、其实还在写实底上」。
- **默认档位也会注入画风词了**（以前不动下拉就没词）；**反复切画风不再堆逗号**（以前连切几次会出现 `hair,,, anime style`）。
- 实拍对比（同 seed 同提示词）：修复后是干净线稿赛璐璐的二次元脸，故障时是半写实/3D 娃娃脸 —— 见 `SD-Picture\anime-after-fix_001.png` 与 `anime-before-fix_001.png`。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0911画风对应修好二次元这一档以前压根没有映射也不会切回动漫底)。

---

## 版本更新内容（v0.9.10 · 2026-10-15）

修外部用户报的 **「SD 出了图，但工作区里一张成品都没有」**：

- **根因**：迭代中间图写在系统 temp，而 DSH 的 `workspace-write` 沙箱 ACL **只允许写会话工作区**；插件又是用 `cmd start` 拉起独立窗口跑的（不经过会给 TMP/TEMP 改道的受限子进程）→ `GetTempPath()` 落在不可写目录 → 出图落盘被拒 → 脚本判到失败就 `exit 1`，而把成品复制进 `-OutDir` 的那几行**全在迭代之后**，于是工作区永远是空的。
- **修法一（脚本）**：迭代目录改为**工作区优先 + 逐级兜底**——`-IterDir`（新参数）→ `<OutDir 的父目录>\.sd-inject-iter` → 脚本目录 → 系统 temp；每一级都用**真实探针写入**验证（只看「存在」会把被 ACL 拒写的目录误判成可用）；全不可写就明确报错并列出试过哪些路径。`-OutDir` 也提前探活，不可写**立刻**说清原因，不让你等十几分钟。
- **修法二（插件）**：拉起的窗口里先把 `TMP/TEMP/TMPDIR` 指到工作区的 `.dsh-tmp`，并在 C 档命令里显式带上 `-IterDir "<工作区>\.sd-inject-iter"` —— 从源头保证中间产物落在可写位置。
- 附带加固：清理残留目录时对不存在/不可写的候选先判存在再扫（`-ErrorActionPreference='Stop'` 下不再中断流程）；系统 temp 取不到时用 `TEMP/TMP/USERPROFILE` 兜底（个别受限宿主里 `GetTempPath()` 可能返回空）。
- 真机验收：启动器实跑确认 TEMP 被钉到 `<工作区>\.dsh-tmp`；抽 shipped 真代码跑「不可写候选 → 跳过并回落工作区」；真出图落进 `<工作区>\.sd-inject-iter\iter-*\`（`img2img (denoising=0.5)`）；负例早失败；双 Parser + `npm test` 全绿。
- 详情见 [CHANGELOG.md](CHANGELOG.md#0910坑34迭代目录必须可写--修外部用户报的工作区一张成品都没有)。

---

## 版本更新内容（v0.9.9 · 2026-10-15）

**C 档图生图现在真的能用**（0.9.8 只解开了 Denoising 的锁，底图来源还是个坑）：

- **问题**：填了 Denoising 也出不了图生图 —— 老的素体阶段在「本地视觉模型不可用」（Ollama 没开）或「枚举不到 vl 模型」时**一张图都不出**，而图生图的底图只认素体产物 → 静默降级成文生图。
- **修复一：素体阶段不再空手**。质检不可用时改为「**照常出一张素体底图**，只是不跑脸/手质检迭代」，底图随时可供图生图使用。
- **修复二：表单新增「底图：」栏**（可留空，旁边有「浏览…」选图）：
  - 留空 = 用素体成品（默认）；
  - 填 **最近 / 最新 / 上一张** = 用输出目录 `SD-Picture` 里最新一张图 → **接着上一张继续改**；
  - 或直接填图片路径（支持相对路径、也支持点「浏览…」挑文件）。
- **修复三：只要拿得到底图 + Denoising > 0 就一定走图生图**；填了底图但忘填 Denoising 时按图生图默认 `0.55` 兜底；`-NoIterate` 且没填底图会明确提示原因。
- 真机验收：素体阶段在无质检环境下照样产出底图，图生图阶段日志出现 `模式: img2img (denoising=0.5)`；表单新增行不挤压原有布局。
- 详情见 [CHANGELOG.md](CHANGELOG.md#099c-档图生图真正可用素体阶段不再因质检缺失而空手底图可自选)。

---

## 版本更新内容（v0.9.8 · 2026-10-15）

本次是**修 bug**版本，只动 C 档参数表单里那个「看得到、改不了」的 Denoising：

- **问题**：C 档 `sd-inject.ps1` 参数表的 **Denoising 一栏永远是灰的**（禁用），既下拉不动也手填不了；就算填了也不生效。
- **根因（三段全废）**：① 表单在素体自检迭代**之前**弹出，那时 `-HasBaseImage` 传参恒为 `$false`，旧代码据此把控件 `Enabled = $false` → 每次都灰；② 解析段在同一条件下直接 `$den = 0`；③ 最终出图硬编码 `-InitImage "" -Denoising 0`。
- **修复后怎么用**：表单里 Denoising **恒可编辑**（下拉或手填 0-0.95）：
  - `0（文生图·不用底图）`（默认）= 现在的行为，走文生图，不动默认出图链路；
  - `0.3-0.5` = 拿**素体迭代的 winning 图**当底图微调（贴底图、保构图）；`≥0.7` = 基本重画；
  - 选了 `>0` 就真的走图生图，日志会写明 `最终出图走图生图：底图 = 素体成品（seed=…），denoising = …`。
- 详情见 [CHANGELOG.md](CHANGELOG.md#098c-档参数表单-denoising-解锁从看得到改不了变成改了就生效)。

---

## 版本更新内容（v0.9.7 · 2026-10-15）

本次是「整理打包」版本，重点是**让用户一句话就能改参数重出图**，并把本机全部权重资源整理成可复现清单：

- **新增「C 档选项表」（A 档出图后自动罗列；2026-10-16 起不含画风，画风由 C 档表单档位写进正向提示词）**：`sd_txt2img` / `sd_img2img` / `sd_inpaint` 三个出图工具都新增返回字段 `quickOptions`——一张 Markdown 表，把 C 档参数表单里的 **画风 / 模型 / LoRA / 比例 / 画质 / 迭代 / Denoising** 全量可选项一次列全。**A 档每次出图后，这张表会自动贴到图片下方**，用户直接回一句「4 号画风 + majicMIX + 3:4 + 1024p，再来一张」即可快速重出图，不用自己回忆参数名。
- **用户自调画风进入 C 档画风选项（`sd-inject.ps1` 参数表单）**：
  - **★ 写实二次元·东亚脸**（2026-10-15 实测配方）：在「写实二次元」基础上把五官往东亚脸收——窄脸型、杏仁眼 + 虹膜高光、眼神光、正面偏侧柔光 + 发丝轮廓光；负向压掉宽脸/宽眼距/西方面孔/过曝/真人照片。沿用「动漫底子 + `<lora:semirealisticanime:0.6>` 不切模型」路径。
  - **★ 釉彩调色盘**（用户本机 LoRA 画风）：`<lora:釉彩·麻袋调色盘_v1.0:0.8>` + 釉面质感/粗布调色盘色域词。
  - 加上原有的 **★ 彩色哥特**，C 档选项表里现在有 **3 个 ★ 用户自调画风**（编号 4 / 5 / 6）。
- **触发话术写进技能与本文档**：新对话第一句说「**打开SD插件**」、出图要求前加「**用SD插件绘制**」，能明显提高插件与生图工具被命中的成功率（详见下节）。
- **新增 `docs/models-loras.md`**：本机全部 checkpoint / VAE / LoRA / 嵌入的清单，**每条都带 HF 镜像直链（`hf-mirror.com`）+ sha256**，另附国内自调 LoRA 的来源站点与落盘位置。
- **新增实拍图**：C 档参数表单截图 + 5 张本次随机测试实出图（见下「效果图」）。
- 测试：`npm test` 全绿；`smoke-skill.mjs` 新增 15 条断言（quickOptions 字段、C 档选项表章节、★ 自调画风、触发话术、表单画风项）；随机测试 6 张图全部通过自检（样例与 seed 见文末）。

> 历史版本看 [CHANGELOG.md](https://github.com/savinglighting/dsh-unrestricted-printing/blob/main/CHANGELOG.md)。**DSH 插件暂不支持自动更新：升级需先卸载再安装新版。**

---

## ⭐ 这样用成功率最高（用户须知）

| 做法 | 效果 |
| --- | --- |
| 新对话**第一句**先说 **`打开SD插件`** | 让模型先读 `sd-paint` 技能、把生图工具挂上来，后面出图更稳 |
| 出图要求**前面加上** **`用SD插件绘制`**（例：`用SD插件绘制：银发少女站在樱花树下`） | 明确点名走本机 SD，不跑偏到别的方式 |
| 想改画风/模型/比例 | 出图后**直接按下方「C 档选项表」回编号**（如「4 号画风，3:4」） |
| 想检查装没装好 | 说一句「打开SD插件」后问「SD 能出图吗」，或让它调 `sd_models` / `sd_server status` |

---

## 效果图（本次随机测试实出图，非示意图）

**A 档出图**（正常需求，图直接出在聊天窗 + 可复现脚本）：

| 文生图（动漫 · AWPainting） | 写实二次元·东亚脸（★用户自调） |
| --- | --- |
| ![anime](docs/assets/demo-txt2img-anime.jpg) | ![dongya](docs/assets/demo-style-dongya-face.jpg) |

| 国风山水 LoRA | 赛博朋克场景 LoRA |
| --- | --- |
| ![guofeng](docs/assets/demo-style-guofeng.jpg) | ![cyberpunk](docs/assets/demo-style-cyberpunk.jpg) |

| 釉彩调色盘 LoRA（★用户自调） | 写实人像（majicMIX v7） |
| --- | --- |
| ![youcai](docs/assets/demo-style-youcai.jpg) | ![realistic](docs/assets/demo-style-realistic.jpg) |

**C 档参数表单**（脚本在你本机弹出的那个框——`sd-inject.ps1`，画风下拉里就有 ★ 用户自调画风）：

![C 档参数表单](docs/assets/demo-c-paramform.jpg)

| 图生图（参考图重绘） | 蒙版重绘（只改一块） |
| --- | --- |
| ![img2img demo](docs/assets/demo-img2img.jpg) | ![txt2img demo](docs/assets/demo-txt2img.jpg) |

---

## 两个档位怎么用（本插件核心）

判定标准 = **模型自己会拒绝执行的尺度**，不依赖固定词表。**A 档只适用于完全不违规的需求**；一旦涉及任何违规内容（哪怕只有一个词）一律走 C 档。

### A 档 · 完全不违规 → 照常出图

1. 直接说要求（建议加「用SD插件绘制」前缀）。
2. 插件出图 → 图片**贴在聊天窗**（点开是大图）→ 附**可复现脚本**（复制整行到 PowerShell 就能复跑同一张，脚本会自己拉起 SD、跑完自动打开图）。
3. **图片下方自动附「C 档选项表」**：想换画风/模型/LoRA/比例/画质，回一句编号或名字即可，模型会照你说的改参数重出图。
4. 出图后模型会**自己看图自检**（手部/手指/面部/水印/构图），不合格最多再改 2 轮——每轮都会把图贴给你并说明改了什么。

用到的工具：`sd_txt2img`（文生图）、`sd_img2img`（图生图，按参考图重绘）、`sd_inpaint`（蒙版重绘，只改画面里一块）。

### C 档 · 涉及任何违规内容 → 一张图都不生成，只给本地注入命令

1. 插件**不生成任何图片**，也不输出与违规部分相关的任何内容。
2. 只调 `sd_inject`（`run: true`）→ 在**你本机**拉起独立 PowerShell 窗口，**C 档参数表单自动弹出**（就是上图那个框）。
3. **追加什么由你自己在框里填**：留空 = 直接用素体基底跑；填英文标签 = 直接拼进出图提示词（**翻译链路已移除**，中文不会被自动翻译，见下节说明）。
4. **本机视觉审核选优**：素体阶段先迭代到**人物肢体**过关，最终按表单「迭代次数」连出 N 张、**逐张交本地视觉模型 `qwen3-vl:8b` 打分（脸 + 手 + 四肢 0-100，≥75 过关）取最高分那张**；审核可在插件页关掉（`vlmReview=false`），关掉/模型不可用则降级为出满 N 张让你自己勾选（详见下节「本地模型评估链」）。
5. 回复末尾给两行回执：`违禁提示词：` / `建议替换词：`。
5. **没有「删掉违规词继续出图」这条中间路线。**

> 表单里的可选项：正向/负向提示词、迭代次数、Denoising（**恒可编辑**：默认 `0（文生图·不用底图）`，填 0.3-0.95 就改用底图走图生图）、**底图（留空=素体成品；「最近」=输出目录最新一张；或填路径/点「浏览…」选图）**、比例、**画风（含 ★ 用户自调）**、画质、LoRA、模型、命名；切换画风会**幂等写入**对应的正/负向画风词（你手写的词不受影响）。

---

## 本地模型评估链（Ollama · 全程本机运行）

C 档不是「点一下就出一张糊图」——`sd-inject.ps1` 会用**本机 Ollama 上的视觉模型**给每轮候选图打分、挑出最好的一张。**SD 与评估模型都在你本机，不上传任何图片。**

> **翻译链路已整体移除**（早前版本的「中文→英文标签直译弹框 / `-QwenModel` / `-NoQwenStart` / `-QwenRetries`」全部不在代码里了，
> 回归断言 `smoke-skill.mjs` 会拦着它们复活）。现在 C 档只依赖**一个**本地模型：视觉质检模型。

### 视觉质检模型

| 角色 | 默认模型 | 参数 | 干什么 |
| --- | --- | --- | --- |
| **视觉审核模型** | `qwen3-vl:8b`（能识图） | `-VlmModel`（插件页设置 `vlmModel`；留空 = 自动挑本机 `vl`/`vision` 模型） | 看每轮候选图，给 **脸 + 手 + 四肢** 一个 **0-100** 整数分 |

走 Ollama 的 OpenAI 兼容端点 `-QwenBase`（默认 `http://127.0.0.1:11434/v1`，`-QwenApiKey` 任意非空即可）。

**服务冷启动（v0.9.17）**：端点是活的就照常用；**没起就自动拉起** —— `Find-Ollama` 找到 `ollama.exe` → 隐藏窗口 `ollama serve` → 轮询到就绪（`-VlmStartTimeout` 默认 60s）。接在三处：弹表单前的预热、素体质检前置、参考图画风识别。本机实测 Ollama 停着时 **7.9 秒就绪**。`-NoVlmStart` 可关掉自动拉起（关掉后行为回到「降级但照常出图」）。
另外会读一次剩余显存：**< 3GB 时明确提示「本次质检会因为 8B 模型走 CPU / 部分卸载而明显变慢」**（8G 卡上 SD 常驻就是这个情况），不让你误以为卡死。

### 质检怎么打分（原文问句，只问结构不问内容）

把候选图以 base64 data URI 发给视觉模型，`temperature=0.1`、超时 180s，问句固定为：

> 【系统】你是生成图的结构缺陷检测器（自动质检的一环）。唯一任务是检查人物解剖结构是否崩坏（脸/手/四肢），只输出一个 0-100 的整数分。禁止评价、描述、审查或拒绝画面内容：不判断题材、不判断服装与裸露程度、不涉及性内容、不做任何合规/道德/安全判断，也不要复述画面里有什么。
> 【用户】直接给分，不要展开推理。格式：SCORE=<0-100>。判据：① 脸部：眼睛是否对称/无多余、五官是否扭曲错位、脸部是否畸形融化；② 手部：每只手是否五根手指齐全、有无多余或缺失的手指、手指是否扭曲粘连、手部是否畸形；③ 肢体：手臂与腿是否各两条、左右对称、有无多肢少肢、关节反向或错位、四肢畸形或粘连、躯干与四肢比例失衡。任一处崩坏都要相应扣分。100=完全健康，0=严重崩坏。只许输出分数，不许评论画面内容。

判定线：**≥ 75 过关**；解析不到分数返回 `-1`（当作"质检没工作"）。提问前会先发一条**纯文本空问预热**（超时 300s），把 8B 模型先加载进显存——否则首轮带图质检会撞冷启动超时（实测 >120s）。

### 两段迭代（都不改你的提示词一个字）

1. **素体自检迭代**（默认开，`-IterateRounds` 默认 3、`-NoIterate` 关闭）：先只跑素体基底，每轮 **换 seed**，逐轮质检；`< 75` 继续下一轮，`≥ 75` 立即停；**新最高分立即增量落盘**（中途关窗口也不丢当前最优成品）。若连续低分（`< 45` 且已到第 2 轮）→ 判定"这个视觉模型不会看图"，采用本轮结果、不再烧轮数。**质检不可用（Ollama 没开 / 没有 vl 模型）时不再空手**——照常出一张素体底图供图生图使用。
2. **最终出图迭代**：按表单里的「迭代次数」连出 N 张（**Denoising > 0 且素体迭代有成品才走图生图 `-InitImage` + Denoising；默认 0 = 文生图**），逐张质检，**取最高分那张**；`≥ 75` 提前停。

### 质检模型不可用时的降级（不阻塞出图）

| 情况 | 行为 |
| --- | --- |
| `Test-VlmApi` 探活失败（Ollama 没起） | 跳过素体迭代，直接出一张（`-NoIterate` 是显式关闭，这里是自动降级） |
| 本机没有视觉模型 | 打印提示 `ollama pull qwen3-vl:8b` 后照常出图 |
| `-VlmModel` 指定的模型不在本机 | 自动回退到本机第一个 `vl`/`vision` 模型并提示 |
| 质检连续返回 `-1` | 后续轮**不再质检**，改为出满 N 张并弹出多选对话框（纯文本勾选 + 右侧预览，**绝不白屏**）让你自己留几张 |
| 一个模型都枚举不到 | 直接点出最常见根因 `OLLAMA_MODELS` 指向空目录（本机实测就是这个坑） |

### 相关参数（`sd-inject.ps1`）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-QwenBase` | `http://127.0.0.1:11434/v1` | Ollama OpenAI 兼容端点 |
| `-VlmModel` | `qwen3-vl:8b` | 视觉审核的模型（人物肢体打分）；插件页 `vlmModel` 会写进命令 |
| `-NoVramRelease` / `-VramMinFreeGb` | 关 / `4.0` | 开跑前先释放显存：剩余低于阈值就卸载对面那一侧（SD / 本地模型）；v0.9.23 |
| `-IterateRounds` | `3` | 素体自检迭代轮数上限 |
| `-NoIterate` | 关 | 跳过素体自检迭代，直接出一张 |
| `-NoVlmStart` / `-VlmStartTimeout` | 关 / `60` | 视觉模型服务冷启动开关与等待秒数（v0.9.17）；插件设置 `vlmAutoStart: false` 会自动给生成命令补上 `-NoVlmStart`（v0.9.18） |
| `-KeepWorkFiles` | 关 | 保留本次产生的中间图（预蒙版 / 命中率总览图）备查；默认跑完自动清理，产物目录只留成品 |
| `-FaceBoostTags` | `detailed face, beautiful detailed eyes, perfect face, detailed skin` | 自动追加进正向的脸部细节词（传 `""` 关闭；**这是唯一会被自动写进提示词的内容**） |

> **A 档没有这一步**：A 档出图的质检是**执行模型（我）自己用 `read_image` 看图**——按技能「出图自检 → 优化循环」查手部/面部/水印/构图，不合格最多再改 2 轮。本地视觉模型的自动打分只存在于 C 档的 `sd-inject.ps1` 流程里。
>
> 拉模型：`ollama pull qwen3-vl:8b`。（`itsailor/qwen3.6-fable` 那类量化创作模型**看不了图**，做不了审核。）

---

## C 档选项表（A 档出图后自动罗列到你眼前）

插件每次 A 档出图后会把下面这张表**原样贴到图片下方**（工具的 `quickOptions` 字段）。它就是 C 档参数表单里可一键改的那部分参数（**不含画风**）：

| 类别 | 可选项 |
| --- | --- |
| **画风** | 1 保持画风（图生图默认） · 2 二次元（默认） · 3 写实二次元 · **4 写实二次元·东亚脸 ★用户自调** · **5 彩色哥特 ★用户自调** · **6 釉彩调色盘 ★用户自调（本机 LoRA）** · 7 国风 · 8 赛博朋克 · 9 写实 · 10 厚涂 · 11 水彩 · 12 像素风 |
| **模型** | AWPainting_v1.2（动漫默认） · majicMIX realistic v7（写实） · SemiRealMix（彩色哥特/半写实备选） · anything-v5 · dark sushi mix · ReVAnimated |
| **LoRA** | semirealisticanime（半写实 0.6） · add_detail（细节 0.6-0.8） · 国风山水_v1.0 · 赛博朋克_v1.0 · 赛博朋克场景_v1.0 · 自然美妆场景_v1.0 · 釉彩·麻袋调色盘_v1.0 · 39_v1.0 |
| **负面嵌入** | EasyNegative · EasyNegativeV2 · badhandv4（手崩优先用它） |
| **比例** | 9:16（竖屏默认） · 1:1 · 3:4 · 4:3 · 16:9 · 2:3 · 3:2 · 21:9 |
| **画质** | 480p · 640p · 768p · 1024p · 1280p · 2160p（4K） |
| **迭代** | 1 / 2 / 3 / 4 / 5 / 8 / 12 / 16 / 24 / 32（越高越慢越精细；C 档这里是**出图张数**——逐张过本地视觉模型质检、取最高分那张） |
| **Denoising** | **0（默认，表单里选「0（文生图·不用底图）」）= 文生图** · 0.3-0.5 贴素体底图微调 · 0.6-0.7 明显改动 · 0.8-0.9 基本重画（表单里恒可编辑：下拉选或手填 0-0.95；填 >0 就走图生图，底图 = 素体自检迭代的 winning 图） |

> 用法：回一句「**4 号画风 + majicMIX + 3:4 + 1024p，再来一张**」，或「保持这个画风，只换成赛博朋克场景 LoRA」。★ = 用户自己调出来的画风。完整模型/LoRA 名单随时可用 `sd_models` 查（名称以本机实际文件为准）。

---

## 模型 / LoRA 镜像清单

完整清单（含 **sha256 校验值**、每条 HF 镜像直链、本机文件大小、用途）见 **[docs/models-loras.md](docs/models-loras.md)**。摘要：

| 类别 | 条目 | 镜像站 |
| --- | --- | --- |
| Checkpoint | AWPainting v1.2（默认）、ReVAnimated v1.1、anything-v5、majicMIX realistic v7、SemiRealMix、dark sushi mix | HF 国内镜像 `https://hf-mirror.com`（`install-sd.ps1 -Mirror` 默认值） |
| VAE | `vae-ft-mse-840000`（默认·不发灰）、`animevae` | 同上 |
| LoRA / 嵌入 | `add_detail`、`semirealisticanime`、`EasyNegative`、`badhandv4` | 同上 |
| 国内自调 LoRA | 釉彩·麻袋调色盘、国风山水、赛博朋克、赛博朋克场景、自然美妆场景、39、EasyNegativeV2 | [LiblibAI](https://www.liblib.art) / [Civitai](https://civitai.com)（手动放 `<SD>\models\Lora\`） |

一键拉取（走镜像 + sha256 校验 + 8 段并行下载 + 断点续传）：

```powershell
powershell -ExecutionPolicy Bypass -File "插件目录\install-sd.ps1" -Models "awpainting,semirealmix,majicmix" -Vaes "mse,animevae" -Loras "add_detail,semireal,easynegative,badhandv4"
```

---

## 特性

- **零本地适配**：SD 安装目录自动探测（配置 > 环境变量 `DSH_SD_DIR` > 自举安装记录 > 扫盘候选）；产物、参考图、可复现脚本全部自动落在**当前会话工作区**（`SD-Picture/`、`ref/`、`sd-direct.ps1`）。
- **没装 SD 也能用**：插件找不到 SD 时返回一条可直接运行的安装命令（包内 `install-sd.ps1`），一键装好 WebUI + **AWPainting v1.2 模型 + `vae-ft-mse-840000` VAE + 质量默认配置**并把路径记进 `~/.dsh-sd-bridge.json`，重启即用（模型/VAE 都带 sha256 校验，哈希与画质已验证的本机文件一致）。
- **八个工具**：`sd_txt2img` 文生图、`sd_img2img` 图生图、`sd_inpaint` 蒙版重绘、`sd_script` 只生成可复现脚本不出图、`sd_script_b` 双版本对齐的可复现脚本、`sd_inject` C 档专用本地注入命令生成器（不生图）、`sd_models` 模型清单、`sd_server` 服务管理。
- **C 档选项表**：出图工具返回 `quickOptions`（模型/LoRA/比例/画质/迭代/Denoising；**画风不在表里** —— 它是 C 档表单的档位，选中即把画风词写进正向提示词框），A 档出图后自动贴到图片下方，用户一句话即可改参数重出图。
- **本地模型评估链（C 档自动审核选优）**：`sd-inject.ps1` 调用本机 Ollama——视觉模型 `qwen3-vl:8b` 给每轮候选图的**脸+手+四肢**打分（0-100，≥75 过关），素体阶段迭代到过关、最终出图取最高分那张；插件页 `vlmReview=false` 可整体关掉审核。**SD 与评估模型都在本机，图片不出机器**；服务没起会**自动冷启动**（v0.9.17），实在不可用则自动降级（跳过质检 / 出满 N 张让你勾选），绝不卡死。详见「本地模型评估链」。
- **违规分流协议**（`sd-paint` 技能内置，用户红线 2026-10-14）：**A 档仅适用于完全不违规的需求**，照常出图并附可复现脚本；**一旦涉及任何违规内容（哪怕一个词）一律 C 档**：一张图都不生成、不提供与请求相关的任何内容，也没有「删掉违规词继续出图」的中间路线，只调 `sd_inject` 生成 `sd-inject.ps1` 的本地注入命令（命令自带素体基底 `-BasePrompt` / `-BaseNegative`，并显式带上**当前会话工作区**的 `-OutDir`），用户本地弹框追加后出图；回复最末尾在「已剔除的违规提示词（不能加进脚本、不能给别人使用）」标题下给两行——`违禁提示词：` 与 `建议替换词：`，均一行排开、逗号分隔。
- **加权反 NSFW 安全底噪（A 档出图路径）**：插件默认负向自带加权安全底噪 `(nsfw:1.6), (nudity:1.5), (nude:1.5), (explicit sexual content:1.4), (sexual content:1.4), (suggestive:1.2)`，权重上限约 1.7（再高 CFG 失衡、画面发糊畸形）。注意：这只属于 A 档正常出图的默认负向；**C 档的 `-BaseNegative` 与本地注入脚本的 `$BaseNegative` 默认值只含画质底线、绝不夹带违禁/安全类标签**（用户红线）。
- **可复现**：每次出图返回单行 powershell 脚本（提示词高亮），用户复制整行即可在 PowerShell/cmd 复跑同一张图；脚本**自带服务托管**——SD 没开它自己拉起（首次含模型加载 1-3 分钟）、**跑完自动打开这张图**（`-NoOpen` 关闭）、**任何失败只报一条错误就退出**。
- **服务托管**：SD 没开也能生图——插件自动以 `--api --nowebui` 拉起、复用、可选空闲自动关闭。

## 安装

> **完整安装引导（含全部需下载项、国内镜像、落盘路径、校验命令）见 [INSTALL.md](INSTALL.md)。**
> 下面是最短路径。

三种方式任选其一（装完重启 DeepSeek Harness）：

```text
# 1) 在 DSH「设置 → 插件」里粘贴 Git 安装源
github:savinglighting/dsh-unrestricted-printing

# 2) 或粘贴 npm 包名
dsh-unrestricted-printing

# 3) 或解压 GitHub Release 里的源码包到插件目录
#    node_modules\dsh-unrestricted-printing\  ← 解压 dsh-unrestricted-printing-0.0.1.zip 到这里

# 4) 或本地目录（开发者）
dsh plugin add link:D:\path\to\dsh-unrestricted-printing
```

装完先体检（它会告诉你还缺什么、按哪条命令补）：

```powershell
npm run deps:check          # = gateway\tools\check-deps.ps1
npm run deps:bootstrap      # 打印需要下载的清单（加 -Apply 真下载）
npm run gateway:check       # 网关自检：打印配置 + 4 个模型真实可用性
```

> DSH 插件暂不支持自动更新：升级需先卸载再安装新版。

## 打包与发布（GitHub 格式）

```powershell
npm run pack:github         # 本地复刻 release.yml：跑门禁 → 生成 dist 产物
# 产物：
#   dist\dsh-unrestricted-printing-0.0.1.zip   解包即用（含 package.json / INSTALL.md / gateway / docs / workflows）
#   dist\dsh-unrestricted-printing-0.0.1.tgz   npm pack 产物（npm i -g 用）
#   docs\deps-report.md                  依赖体检报告（-WithDepsReport 时生成，也随包发）

# 推 tag 后 GitHub 自动构建并发 Release（.github/workflows/release.yml）
git add -A; git commit -m "release: v0.0.1"; git tag v0.0.1; git push origin main --tags
```

## 首次使用

- **已装 SD WebUI**：什么都不用做。插件启动时自动探测（也认 `DSH_SD_DIR` 环境变量与 `cordis.patch.yml` 的 `sdDir` 覆盖）。
- **没装 SD**：让 Harness 帮你画张图，它会返回安装指引；或自己在 PowerShell 跑：

```powershell
powershell -ExecutionPolicy Bypass -File "插件目录\install-sd.ps1"
```

装完重启 DSH。首次生图会在线安装 Python/torch 依赖（10-30 分钟）。

### install-sd.ps1 参数

脚本先跑**环境预检**（磁盘 ≥15GB → 镜像探活 → git → Python 3.10 → VC++ 运行库，缺啥补啥、每项失败只报一条错即退出，最后打一张就绪清单），再克隆 WebUI、按清单拉资源：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Models` | `awpainting,semirealmix` | 模型清单，逗号多选：`awpainting` / `revanimated` / `anythingv5` / `majicmix` / `semirealmix` / `darksushi`（`none` = 不拉） |
| `-Vaes` | `mse,animevae` | VAE 清单：`mse`（写进 config 默认）/ `animevae` |
| `-Loras` | `add_detail,semireal,easynegative,badhandv4` | 常见资源：细节增强 LoRA + 半写实 LoRA + 负面嵌入 + 手部修复嵌入（`none` = 不拉） |
| `-Upgrade` | 关 | 已存在文件做 sha 复验、不符重拉；旧版本命中 `Supersedes` 时补拉新版（旧版保留） |
| `-Mirror` | `https://hf-mirror.com` | 填 `""` 用官方源 |
| `-SkipModel` / `-SkipVae` / `-SkipLora` | 关 | 跳过对应类别的下载 |
| `-NoPrereq` / `-SkipVC` / `-SkipDiskCheck` / `-SkipGit` / `-SkipPython` | 关 | 跳过环境预检的全部或某一项 |
| `-NoConfig` | 关 | 不写 `config.json` 质量默认值 |

清单里**每个条目的 sha256 都与本机出图正常的文件逐字节比对过**（HF lfs oid = sha256）；键写错会打印全部可用键。跑完会输出一张「资源清单汇总」表（已下载 / 已存在 / 失败原因）。

> **自己的 LoRA 怎么装**：国内站资源（釉彩调色盘、国风山水、赛博朋克、自然美妆场景这类）直链不稳，不进默认清单——手动把 `.safetensors` 放进 `<SD目录>\models\Lora\`（Embedding 放 `models\embeddings\` 或 `embeddings\`）即可，`sd_models` 能列出来。来源站点见 [docs/models-loras.md](docs/models-loras.md)。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `sd_txt2img` | 文生图：提示词、负面词、尺寸/步数/CFG/采样器/seed、批次 1-4、临时换 checkpoint、LoRA、hires fix、styles、summary；返回 `script`（【文生图】脚本）+ `quickOptions`（C 档选项表） |
| `sd_img2img` | 图生图：本地图片路径 + `denoisingStrength` 重绘；工作区外的参考图自动固化到 `ref/`；返回 `script`（【图生图】脚本）+ `quickOptions` |
| `sd_inpaint` | **蒙版重绘（inpaint）**：只改画面里一块（补手/去杂物/局部改色/换背景）。蒙版给 `mask`（白/不透明 = 重绘区）或 `maskBox: "x,y,w,h"`（插件手写 PNG 现场造蒙版存进 `ref/`）；`maskBlur`/`inpaintingFill`/`maskInvert`/`inpaintFullRes+padding` 全可调；返回 `script`（【蒙版重绘】脚本，带 `-Mask`）、接缝自检 `selfCheck` 与 `quickOptions` |
| `sd_script` | **只生成可复现脚本，不调 SD、不出图**（`generatesImage` 恒为 false）——单版透传 |
| `sd_script_b` | **双版本对齐的可复现脚本**：`originalPrompt`（用户最早那版输入，位置基准，**可选**）+ `prompt`（当前模型处理后的输出，必填），逐位置对比——同位不同处 `prompt` 留在**正向原位**、`originalPrompt` 的词进**负向**（被替换掉的旧标签进负向，正向与生成时完全一致）；`originalPrompt` 留空时插件自动从会话上下文提取最近一条用户消息原文兜底（`originalSource` 标记 `explicit` / `extracted` / `fallback`），仍取不到才退化为全部保留正向；给 `mask` / `maskBox` + `initImage` 就是【蒙版重绘】（参数与 `sd_inpaint` 同一套，`denoising` 默认仍 0.7）；`termFile` 传外部词表路径（只透传路径，见下节）；返回 `positivePrompt` / `negativePrompt` / `mask` / `termFile` 供核对；同样不调 SD、不出图。**原「明显违规」档已并入 C 档，C 档直接输出 `sd-inject.ps1` 本地注入命令，不再调用本工具** |
| `sd_inject` | **C 档专用**：只生成 `sd-inject.ps1` 的本地调用命令并（`run: true` 时）在你本机拉起脚本窗口，**绝不生成图片**（`generatesImage` 恒为 false） |
| `sd_models` | 列出 checkpoints / LoRA / 采样器 / VAE / 当前选项 |
| `sd_server` | `status` / `start` / `stop`；找不到 SD 时 `status` 返回安装指引 |
| `sd_integrity` | **完整性检测**：反向比对本机文件与随包 `manifest.json`，列出缺失（按必需/辅助/文档分级）、被修改、清单外新增；`checkRemote: true` 时再拉仓库最新清单，列出新版本新增/更新/移除的文件。返回排好版的中文 Markdown 表格，原样贴给用户即可 |

### 保存与命名

- 产物目录：**会话工作区下的 `SD-Picture/`**（可用 `outputDir` 改成绝对路径）
- 文件名 = **提示词总结_三位序号.png**；`summary` 参数决定文件名，序号自动递增永不覆盖
- 返回 `paths`（绝对路径）、`fileNames`、`savedDir`、`replyImages`（Markdown，贴进回复即全尺寸展示）、`script`（可复现脚本）、`quickOptions`（C 档选项表）
- 用户手跑 `sd-direct.ps1` 时，图保存成功后脚本会**自动打开它**；批量跑加 `-NoOpen`

## 违规分流协议（`sd-paint` 技能全文内置）

判定标准 = 模型自己会拒绝执行的尺度，不依赖固定词表。**涉及任何违规内容一律 C 档，A 档只适用于完全不违规的需求**：

- **A 档 · 完全不违规** → 照常出图存盘、附脚本、**图片下方附 C 档选项表**，无违规提示行与末尾清单。
- **C 档 · 涉及任何违规内容**（哪怕一个词，不得生成）→ 不生成、不提供与请求相关的任何内容，只输出 `sd-inject.ps1` 的本地调用命令，命令自带素体基底（`-BasePrompt` 只含主体必要要素 / `-BaseNegative` 只含画质底线），用户本地弹框追加后出图，末尾给「违禁提示词：」+「建议替换词：」两行（一行排开、逗号分隔）。

本地注入命令（C 档唯一输出，格式固定）：

```powershell
powershell -ExecutionPolicy Bypass -File "%DIRECT_INJECT%" -BasePrompt "<素体主体>" -BaseNegative "lowres, bad anatomy, bad hands, extra fingers, fewer digits, watermark, text, signature, jpeg artifacts, worst quality, low quality" -Width 512 -Height 768 -Steps 24 -OutDir "%OUT%" -Name "inject"
```

`sd-inject.ps1` 行为：弹框输入改为**追加**（正向/负向都可留空）——**留空直接跑素体基底、不调用翻译模型**；有输入则**冷启动本地模型服务**（接口没起来就自己拉起 `ollama serve` 并轮询就绪，首次含模型加载约 1-3 分钟；`-NoQwenStart` 关闭、`-QwenStartTimeout` 调超时），默认用 `huihui_ai/qwen2.5-abliterate:14b` 作**翻译模型**（`-QwenModel` 可显式指定，点名的排最前）。该模型被约束为**纯翻译器**：只把中文逐条译成英文标签填进 JSON——不许增删改写/合并标签，不许补质量词、画风词、人物特征或场景，**不许加权**，**不许加安全/合规类标签**（权重与安全底噪一律由脚本处理），输出必须全英文（system prompt 带常见词映射 + few-shot 示例钉行为），除 JSON 外不输出任何字符。**编码坑已内置**（PS5.1 的 `Invoke-RestMethod` 字符串 body 会按 Latin-1 发送、Ollama 响应头无 charset 会按 Latin-1 解码——脚本统一 UTF-8 字节发送 + `Repair-Utf8Mojibake` 修复响应）；返回里残留中文时先重试、重试到底仍未译全就丢掉未翻译的中文标签（英文标签保留），保证最终提示词全英文。**两级重试**：模型回绝、返回非 JSON、或 JSON 两个字段都空时，先在同一个模型上重试最多 `$QwenRetries` 次（默认 4，每次略抬 temperature 避开同一句回绝、间隔 1 秒），同一模型 4 次都不成才换下一个候选模型（最多 3 个）——`coder` / `vl` / `embed` 等专用模型会被排到最后（它们会直接回绝这类任务），通用对话模型优先；404（模型不在本机）这类确定性失败不重试、直接换。全部失败才退出并给出 `ollama pull` 提示。拿到结果后与基底拼接（`基底 + 追加`），显示结果、按 Enter 确认出图。

### C 档参数表单（sd-inject.ps1 弹出）

| 字段 | 说明 |
| --- | --- |
| 正向/负向提示词 | 基底已预填、可直接改；**切换画风会幂等写入对应的画风词**（先剥上次注入的词再进新词，你手写的词不受影响） |
| 迭代次数 | 默认 3（上限 32），素体自检迭代轮数 |
| Denoising | 默认 0.7；图生图/重绘幅度 |
| 比例 | 9:16 / 1:1 / 3:4 / 4:3 / 16:9 / 2:3 / 3:2 / 21:9 |
| **画风** | 保持画风 / 二次元 / 写实二次元 / **写实二次元·东亚脸 ★** / 彩色哥特 ★ / **釉彩调色盘 ★** / 国风 / 赛博朋克 / 写实 / 厚涂 / 水彩 / 像素风 |
| 画质 | 480p / 640p / 768p / 1024p / 1280p / 2160p（4K） |
| LoRA | 从本机 SD 实时拉取（不用 LoRA = 留空） |
| 模型 | 从本机 SD 实时拉取（当前模型 = 不切） |
| 命名 | 留空 = 自动总结提示词命名 |

> **拉取翻译模型要用全名**：`ollama pull huihui_ai/qwen2.5-abliterate:14b`。裸名 `qwen2.5-abliterate:14b` 在 Ollama 仓库里不存在，会报 `pull model manifest: file does not exist`。

### 双版本对齐（`sd_script_b`）

`sd_script` 直接透传 `prompt` / `negativePrompt`——模型分流改写时顺手**重排或替换**的标签会原样进脚本，脚本复现出来的图就与会话里那张不一致。`sd_script_b` 改为**同时吃两版**、逐位置对齐（按逗号切分后做纯位置比较，**无词表、无正则、不做内容审查**）：`originalPrompt` = 用户最早那版输入（位置基准），`prompt` = 当前模型处理后的输出。方向以**当前版本**为准——正向 = `prompt`（复现会话里那张图），`originalPrompt` 的差异词（被替换掉的旧标签）进负向。

| 两版在同一位置 | 输出 |
| --- | --- |
| 相同 | 保留在正向 |
| 都非空且不同 | `prompt[i]` 留在**正向原位**，`originalPrompt[i]` 进**负向** |
| 只有 `originalPrompt` 有 | 进正向 |
| 只有 `prompt` 有 | 保留正向 |

`negativePrompt`（可选）追加到负向末尾；返回 `positivePrompt` / `negativePrompt` / `mask` 方便核对。**前提**：调用方同时传两版且顺序一一对应；只传 `prompt` 则插件自动从会话上下文提取最近一条用户消息原文兜底（`session.messages` 倒序找 `role === 'user'` → `session.header.originalInput`，提取不到才退化为全部保留正向）。A 档走生图工具自带的 `script`（提示词由插件从本次出图参数逐字带出），天然不受改写影响。

**蒙版重绘**：给 `mask`（白色/不透明 = 重绘区）或 `maskBox: "x,y,w,h"` + `initImage` 就是【蒙版重绘】，`maskBlur` / `inpaintingFill` / `maskInvert` / `inpaintFullRes` / `inpaintFullResPadding` 与 `sd_inpaint` 同一套（尺寸默认跟随底图）；`denoising` 默认仍 0.7，修瑕补全请显式传 0.40-0.55。

### 外部词表（-TermFile）

`sd_script_b` 生成的命令支持 `-TermFile <path>` 参数，指向一个 JSON 映射表。
脚本在执行前读取该文件，对 `-Prompt` 与 `-Negative` 做字符串替换。
映射表由用户在执行前提供，插件不读取、不写入、不生成任何映射内容。
格式：`{ "占位符": "替换值" }`。文件不存在时静默跳过。

## 配置

**推荐：设置 → 插件 → `sd-bridge`**（0.7.0 起注册了配置 schema，全部字段可视化编辑、带中文说明，改完下一个工具调用即生效）。也可在 `cordis.patch.yml` 中按 id `sd-bridge` 覆盖——**patch 层显式指定的键优先级最高，设置面板不会覆盖它们**。

优先级：默认值 < 设置面板 < `cordis.patch.yml`。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sdDir` | `''`（自动探测） | SD WebUI 安装目录；探测顺序：此配置 > `DSH_SD_DIR` > `~/.dsh-sd-bridge.json` > 扫盘候选 |
| `port` | `7860` | API 端口 |
| `autoStart` | `true` | 探测不到 API 时自动启动 |
| `startupTimeoutMs` | `420000` | 等待 SD 就绪的上限（含模型加载） |
| `requestTimeoutMs` | `600000` | 单次生图上限 |
| `idleStopMinutes` | `0` | 空闲 N 分钟后自动关闭插件拉起的 SD（0 = 不关） |
| `extraArgs` | `[]` | 追加给 `launch.py` 的参数（如 `["--medvram"]`） |
| `vlmAutoStart` | `true` | C 档是否允许自动冷启动本地视觉模型（Ollama）；`false` → 命令带 `-NoVlmStart`（v0.9.18） |
| `maskAutoSegment` | `true` | C 档是否允许自动抠图（YOLO-World + SAM）；`false` → 命令带 `-NoAutoMask`，改用几何区域蒙版（v0.9.19） |
| `vlmReview` | `true` | C 档是否启用视觉模型审核（人物肢体打分）；`false` → 命令带 `-NoVlmReview`，不探活/不冷启动/不加载模型/不打分（v0.9.20） |
| `vlmModel` | `'qwen3-vl:8b'` | 审核用哪个模型（必须能识图），会写成 `-VlmModel <模型名>`；留空 = 自动挑本机 `vl`/`vision` 模型（v0.9.22 起默认改成视觉模型） |
| `outputDir` | `'SD-Picture'` | 产物目录；相对路径解析到会话工作区 |
| `refDir` | `'ref'` | 参考图固化目录；相对路径解析到会话工作区 |
| `defaultSampler` | `'DPM++ 2M'` | 未指定采样器时的默认（同步数下比 A1111 默认的 Euler a 更干净）；留空 = 用 SD 默认 |
| `defaultNegative` | 质量底线负面词 | 未传 `negativePrompt` 时自动补上（肢体/水印/低画质）；留空 = 不补 |
| `img2imgDenoising` | `0.55` | 图生图默认重绘幅度，越小越贴参考图（保画风建议显式传 0.30-0.50） |
| `inpaintDenoising` | `0.6` | 蒙版重绘默认重绘幅度（修瑕补全 0.40-0.55、换内容 0.65-0.80） |
| `enabled` | `true` | 关掉即不注册工具 |

## 测试

```powershell
npm test                      # = 下面四条不出图的检查（CI 可跑，不需要本机 SD）
node smoke-skill.mjs          # 注册冒烟 + 双分支协议要点 + C 档选项表 + 用户自调画风 + 可移植性断言（不出图）
node test-install-record.mjs  # 安装记录专项：BOM 读取 + 就地自愈（不出图、毫秒级）
node test-settings.mjs        # 设置面板专项：schema 注册字段 + 面板实时生效 + patch 优先（不出图）
node test-install-catalog.mjs # 安装清单专项：模型/LoRA 清单 sha/源 + 环境预检 + 干跑 + 非法键（不出图）
npm run acceptance            # 真实出图验收：命名、序号、脚本字段、ref 固化（需本机 SD 在跑）
```

环境变量：`DSH_SD_DIR` 指定 SD 目录；`ACCEPTANCE_WS` 指定验收工作区（默认临时目录）。

**验收方法（重要）**：改完插件后**新开一个会话**再画一张图复验——旧会话带着旧工具描述/旧上下文，跑通了也不代表新会话没问题，建议自己多试试。

### 本次「整理打包」随机测试记录（2026-10-15）

| # | 出图 | 模型 / LoRA | seed | 自检结论 |
| --- | --- | --- | --- | --- |
| 1 | 银发少女樱花 | AWPainting v1.2 | 386163131 | 无手部入镜、面部干净、构图完整 ✅ |
| 2 | 写实二次元·东亚脸 | AWPainting + semirealisticanime 0.6 | 4060256059 | 半写实东亚脸到位、无多指、光影通透 ✅ |
| 3 | 国风山水 | AWPainting + 国风山水_v1.0 0.8 | 797728627 | 水墨风达标、手部无畸形 ✅ |
| 4 | 赛博朋克场景 | AWPainting + 赛博朋克场景_v1.0 0.8 | 2316348413 | 霓虹雨夜层次正常、无水印 ✅ |
| 5 | 釉彩调色盘 | AWPainting + 釉彩·麻袋调色盘_v1.0 0.8 | 3531660722 → 588228372 | 第 1 轮手部偏糊 → 第 2 轮加重手部负向（(bad hands:1.5) 等）+ 手不入镜，通过 ✅ |
| 6 | 写实人像 | majicMIX realistic v7 | 2161574874 | 皮肤质感真实、五官自然、无 AI 水印 ✅ |

对照图见上方「效果图」。复跑任意一张：把出图时返回的脚本整行贴进 PowerShell 即可（改 `-Seed -1` 可换一张）。

## 踩坑排查表

| # | 现象 | 根因 | 解法（现状） |
| --- | --- | --- | --- |
| 1 | 写工作区被拒 `grantWrite` | Windows 对工作区目录缺当前用户完全控制权 | 宿主侧 ACL 问题，用 `diagnose-windows-sandbox-acl` 技能一条命令诊断并修复（非插件 bug） |
| 2 | GUI 装插件失败 | 本机无 `git`，`install-sd.ps1` 与部分包管理都要 git | `install-sd.ps1` 自动下 **MinGit 便携版**：GitHub 资源带 `digest` 就先校验 sha256、再 `git --version` 实测，装完写入用户 PATH |
| 3 | `run_in_background` / `timeoutMs` 报错 | **宿主 bug**：数字与布尔被强制转成字符串 | 这两个参数干脆不传，靠 120 秒超时自动转后台 |
| 4 | 无独立 Python | 只有 WindowsApps 商店占位符（本机另有 3.13，而 A1111 在 Windows 只认 3.10） | `install-sd.ps1` 静默装官方 **Python 3.10.6**（用户级 `PrependPath`，sha256 记录），并把 `pythonDir` 写进安装记录，插件 `resolvePython` 兜底用它 |
| 5 | 大文件下载反复停滞/断流 | 网络对单连接限速掐断（单流 ~300KB/s） | `Get-SegmentedFile`：**8 段并行 Range 下载** + 断点续传 + 长度/可选 sha256 校验（实测 4 段下载与单流逐字节一致） |
| 6 | RTX 5060 跑不起来 | Blackwell（sm_120）不支持 A1111 默认 `torch==2.1.2+cu121` | 插件全新安装时探测 `compute_cap ≥ 12` → 自动设 `TORCH_COMMAND`（torch 2.7.0 + torchvision 0.22.0，cu128，本机实测 CUDA 可用） |
| 7 | CLIP 源码构建失败 | 新版 setuptools 移除了 `pkg_resources` | `PIP_CONSTRAINT` 钉 `setuptools==69.5.1`——约束作用到**每一次** pip（含 PEP 517 构建隔离里那次），等于预装 + 免隔离双保险 |
| 8 | pip 在 opencv 上卡死 | 解析器版本回溯（4.14→4.13.0.92→…）反复重下 | `PIP_CONSTRAINT` 钉 `numpy==1.26.2` + `opencv-python==4.11.0.86` 断开回溯，另设 `PIP_RETRIES=10` / `PIP_TIMEOUT=60`；`DSH_SD_PIP_CONSTRAINT=0` 可关 |
| 9 | 环境准备克隆停滞 | `Stability-AI/stablediffusion` **仓库已删除**（GitHub 对已删仓库要求认证） | 本地还没克隆该仓库时自动设 `STABLE_DIFFUSION_REPO` → **camenduru fork**（保留同一 commit `cf1d67a6…`，签名 verified） |
| 10 | 插件读不到 SD 目录、HTTP 500、反复指引重复安装 | 安装记录带 **UTF-8 BOM 头**，裸 `JSON.parse` 遇 BOM 抛错被静默吞掉 → `sdDir` 为空 | 读侧剥 BOM + 字段兜底提取 + **大声记日志** + 读到 BOM 就**就地重写自愈**；写侧用无 BOM UTF-8 并回读校验 `BOM=False`；`test-install-record.mjs` 专项覆盖。**这是唯一影响所有会话的根因** |
| 11 | 离线模式 tokenizer 加载失败 | 插件指向空的 `<SD>\.cache\huggingface` 还强开离线开关；transformers 4.30 与新版 hub 离线查找不兼容 | 只有该缓存**真有 `models--*` 模型**才接管 `HF_HOME` 并离线；缓存为空则不接管、保持联网（`DSH_SD_HF_ONLINE=1` 强制联网） |
| 12 | （测试方法） | 只查文件内容没查字节编码 = 漏判 | 三层测试：`smoke-skill`（不出图）→ `test-install-record`（BOM 专项）→ `acceptance`（真实出图），且**必须新开会话复验** |
| 13 | `.ps1` 一跑就语法错 | `.ps1` 存成 **UTF-8 无 BOM**，Windows PowerShell 5.1 按 GBK 读 → 中文多字节把后面的 `)` `"` 吞掉 | `sd-direct.ps1` / `sd-inject.ps1` / `install-sd.ps1` 固定存 **UTF-8 with BOM**（PS7 也认 BOM）；注意 JSON 记录恰好相反——**JSON 必须无 BOM** |
| 14 | 脚本报 `Cannot convert value "3845143617" to type System.Int32` | SD 的 seed 是 **uint32**（可到 4294967295），脚本参数写成 `[int]$Seed`，超过 2147483647 就参数转换失败 | `sd-direct.ps1` 的 `-Seed` 改为 `[long]`；`acceptance.mjs` 新增第 8 步：**真跑一遍脚本**（PS5.1 执行 + uint32 seed），BOM/类型问题都会被它拦下 |
| 15 | 别人电脑上跑脚本：`Invoke-RestMethod 无法连接到远程服务器` 之后**连炸 4 条** | ① 对方机器 SD API 没在跑，而脚本只会连、不会拉起；② 连接失败后没有短路，`$result.images[0]` 空数组 → `WriteAllBytes` 空值 → `ConvertFrom-Json` 空值逐级炸 | `sd-direct.ps1` 先探测 API：**没开就自己把它拉起**（目录按 `-SdDir` > `DSH_SD_DIR` > `~/.dsh-sd-bridge.json` > 各盘常见安装名扫描查找，轮询到就绪，`-NoStart` 关闭、`-StartTimeout` 调超时、日志在 `%TEMP%\dsh-sd-direct-launch.log*`）；端口被别的服务占用、目录/解释器找不到、调用失败、结果没图——**统一走 `Fail` 只报一条错误 + 一行提示就 `exit 1`** |
| 16 | **新拉取 SD 出图质量非常差** | ① 新装默认模型是 2022 年的 **SD1.5 base**（`v1-5-pruned-emaonly`）+ 默认 VAE + CLIP skip 1，而这台画质好的机器是 **AWPainting v1.2 + `vae-ft-mse-840000` + CLIP skip 2**；② 没有专用 VAE 时画面发灰 | `install-sd.ps1` 默认模型换成 **AWPainting v1.2**（远端 sha256 `3d1b3c42ec…` 与本机出图正常文件**逐字节一致**），补下 mse VAE（`735e4c3a…`），并合并写入 `config.json` 的 `sd_model_checkpoint` / `sd_vae` / `CLIP_stop_at_last_layers=2`（只改点名键、保留其他键、去 BOM、非 UTF-8 老文件按原编码读写、`-NoConfig` 可关）；`sd_models` 检测到只有 base 模型时返回 `qualityHint` 提示升级 |
| 17 | 脚本拉起的 SD 启动卡几分钟 | 脚本没带 `HF_HOME`，transformers 去 `%USERPROFILE%\.cache\huggingface` 找 clip tokenizer，而 SD 缓存在 `<SD>\.cache\huggingface` → 找不到就连 huggingface.co **重试 5 次 × 10s × 多个文件** | `sd-direct.ps1` 启动前按插件同一套规则设 HF 环境：**缓存命中 → `HF_HOME` + 离线加载；未命中 → 保持联网并走 `hf-mirror` 镜像**（`DSH_SD_HF_ONLINE=1` 可强制联网）。实测修复后 **HF 重试 0 次、冷启动到出图 28 秒** |
| 18 | stderr 刷 `Join-Path 找不到驱动器 E:` | 扫盘时对不存在的盘符也去拼路径 | 先 `Test-Path "E:\"` 跳过不存在的盘；候选路径再包一层 `try/catch`（非法路径跳过不报错） |
| 19 | 改完 `.ps1` 突然全文件语法错 | **编辑工具写回时丢掉 UTF-8 BOM**（PS5.1 无 BOM 按 GBK 读，中文多字节吞掉 `)` `"`） | 改完 `.ps1` 立刻补回 BOM（读首三字节 `EF BB BF`，不是就前插 3 字节），再用 `[Parser]::ParseFile` 解析一遍确认 `SYNTAX OK`（本次 v0.9.7 又踩中一次，已按此流程修回） |
| 20 | 设置面板没有 sd-bridge 分组（注册代码看着没问题） | 插件以**符号链接**装进 profile node_modules 时，Node 按 realpath 解析依赖 → 裸 `import('@deepseek-ai/schemastery')` 落空，注册被静默跳过 | `tryLoadConfigSchema` 两条途径：裸 import 失败后扫 `~/.dsh/profiles/*/node_modules/.../schemastery/lib/index.mjs` 按绝对路径导入；`test-settings.mjs` 覆盖 |
| 21 | `install-sd.ps1` 明明装完了，`test-install-catalog` 却报 `dry run must exit 0, got null` | 安装记录**写失败被当成安装失败**：`[System.IO.File]::WriteAllText(...)` 是**裸调用、无 try/catch**，而 `$ErrorActionPreference = 'Stop'` 让一次 `UnauthorizedAccessException`（只读 HOME / 沙箱拦 / 企业策略）直接把整次安装打成非 0 退出 | 记录写入包 `try/catch`：失败只报一条错 + 一行提示（`DSH_SD_DIR` / `cordis.patch.yml` 两条兜底路径），**不再 exit 1**；记录路径可用 `-StateFile` 或 `DSH_SD_STATE_FILE` 覆盖；测试改为 `-StateFile` 改道到临时目录 |
| 22 | `sd-inject.ps1` 一输入中文就 `Qwen 调用失败：无法连接到远程服务器` | 默认模型名 `qwen2.5:14b` 是**写死的猜测值**：本机 Ollama 只有别的模型，且 `ollama serve` 本来就没在跑 | ① **冷启动** `ollama serve` + 轮询就绪；② **模型自动挑**（`-QwenModel` 留空 = 选本机第一个 qwen 系模型）；③ 一个模型都枚举不到时直接点出 `OLLAMA_MODELS` 这个最常见根因 |
| 23 | 中文 Windows 首次依赖准备 `RuntimeError: Couldn't install torch`（pip 退出码 2） | 约束文件含**中文注释**，pip 的 `auto_decode()` 只在文件带 UTF-8 BOM 时才按 utf-8 读，否则回退 locale 编码（中文 Windows 是 gbk）→ 第一个中文字节即 `UnicodeDecodeError` | `writePipConstraints()` 的注释一律**纯 ASCII**；另补钉 `pandas==2.1.4` 断开 pandas 病态回溯 |
| 24 | pip ≥ 24 上 `Installing clip` 报 `No module named 'pkg_resources'` | `PIP_CONSTRAINT` 在 pip 26 上进不了 **PEP 517 构建隔离**那一次，隔离环境照样拉最新 setuptools | 全新安装时设 `PIP_NO_BUILD_ISOLATION=1`：CLIP 这类源码包直接用 venv 里已钉死的 `setuptools==69.5.1` 构建 |
| 25 | A 档出图后用户不知道还能改什么参数（本次新增） | 出图工具只回图片与脚本，参数可选项要用户自己猜（或去翻本文档） | 三个出图工具新增 `quickOptions` 字段，技能要求**出图后原样贴到图片下方**——用户回一句编号就能改参数重出图 |

## 常见问题

- **新装的 SD 出图很差 / 发灰 / 不像样？** 是模型与 VAE，不是提示词：跑一遍 `install-sd.ps1`（会补装 **AWPainting v1.2** + `vae-ft-mse-840000` 并写质量默认配置，已装过 SD 也只会补缺的那部分），或先调 `sd_models`——它检测到只有新装默认的 SD1.5 base 会返回 `qualityHint`；动漫模型记得 CLIP skip = 2。
- **设置里找不到插件配置？** 0.7.0 起在 **设置 → 插件 → `sd-bridge`** 注册了配置面板（字段全可视化、带中文说明）；旧版只能改 `cordis.patch.yml`。若面板没有该项，说明还在跑旧版插件，重装最新版后新开会话。
- **想多装几个模型 / 常见 LoRA？** `install-sd.ps1 -Models "awpainting,majicmix" -Loras "add_detail,semireal,easynegative,badhandv4"`，键见上文参数表与 [docs/models-loras.md](docs/models-loras.md)；已有文件会跳过，`-Upgrade` 做 sha 复验并补拉新版。
- **安装时报缺 git / Python / VC++？** 不用手动补——0.7.0 起脚本先跑环境预检，缺啥自举啥（MinGit 便携版、官方 Python 3.10.6、vc_redist），每项失败只报一条错；也可 `-NoPrereq` 跳过整个预检。
- **首次启动很慢？** 加载 checkpoint 约 1-3 分钟（可调大 `startupTimeoutMs`）；全新安装还要先在线装依赖。脚本自己拉起 SD 时会带 HF 缓存/镜像环境，tokenizer 不会去连 huggingface.co 反复重试。
- **模型放哪？** `<SD 目录>\models\Stable-diffusion\`；LoRA 放 `models\Lora\`。名字用 `sd_models` 查。
- **换机器/换盘符？** 不用改任何配置——重新装插件即可，探测与工作区逻辑自动适配。

---

# English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that drives your local **Stable Diffusion WebUI** (AUTOMATIC1111 API) with eight tools — txt2img, img2img, inpaint (mask redraw), script-only (no image), dual-version script, C-tier local-inject command builder (no image), model listing, server management — plus a built-in **two-tier content-routing protocol**:

- **Tier A (fully compliant requests only)** → generate normally, show the image, the reproducible PowerShell script, and a **「C 档选项表」 quick-pick table** (styles — including the user's own tuned ones — models, LoRAs, ratios, quality, steps, denoising) right below the picture, so a single reply like "style #4 + majicMIX + 3:4" re-generates with the new parameters.
- **Tier C (any non-compliant content, even a single word)** → no image, no content related to the request; the plugin only emits the local-inject command for `sd-inject.ps1`, which pops the **C-tier parameter form** on your machine (style dropdown includes the ★ user-tuned styles). The user appends their own text there.

**Tip for best results**: start a new conversation with `打开SD插件` and prefix your request with `用SD插件绘制` (e.g. `用SD插件绘制：a silver-haired girl under cherry blossoms`).

**Zero local setup**: the SD install directory is auto-detected (`sdDir` config > `DSH_SD_DIR` env > `~/.dsh-sd-bridge.json` install record > drive scan); outputs, reference images and the reproducible script always land in your **session workspace**. No SD installed? The plugin returns a one-line command that runs the bundled `install-sd.ps1` bootstrap — it runs an **environment preflight first** (disk, mirror reachability, git, Python 3.10, VC++ runtime; each missing piece is bootstrapped automatically), then clones WebUI and pulls the selected **model/VAE/LoRA catalog** (`-Models`, `-Vaes`, `-Loras`, `-Upgrade`), every file verified by sha256. Full weight catalog with **hf-mirror.com** links and checksums: [docs/models-loras.md](docs/models-loras.md).

**Install**: paste `github:savinglighting/dsh-unrestricted-printing` (or the npm name `dsh-unrestricted-printing`) into DSH *Settings → Plugins*, then restart.

Configuration lives in **Settings → Plugins → `sd-bridge`** (editable live, applied on the next tool call); `cordis.patch.yml` overrides under id `sd-bridge` keep the highest priority — see the table above.

## License

MIT
