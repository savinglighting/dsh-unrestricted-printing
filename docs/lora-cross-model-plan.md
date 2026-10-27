# LoRA 跨模型可用性改造 · 完整计划书

> 版本：v1.0 ｜ 日期：2026-10-24 ｜ 范围：dsh-unrestricted-printing 插件
> 决策记录：跨架构搬运管线**走网关**；M5 参数标定采用**我出分 + 附原图**

---

## 一、背景与目标

### 1.1 问题

C 档出图即使在参数表里选了 LoRA，成品仍是"普通出图"。日志实证（`run-20261024-213715.log`）：

| 行 | 现象 |
| --- | --- |
| 104 | `[表单提交] 正向：1girl, solo, long white hair...`（完整） |
| 117 | `正向: , detailed face, beautiful detailed eyes, ..., <lora:守岸人_id_v2:0.8>`（原提示词丢失） |
| 114 | `已挂 LoRA：<lora:守岸人_id_v2:0.8>` |
| 103 | `[表单提交] 模型=QwenImage_NVFP4` |
| 128 | `表单已用网关出图（QwenImage_NVFP4）→ 直接采用` |

两处独立故障：
1. **`$positive` 从未被赋值为 `$P.Pos`** —— 表单里改的提示词完全不参与最终出图
2. **LoRA 挂在架构不兼容的模型档上** —— 本机 LoRA 全是 SD1.5，Qwen-Image 是 DiT

### 1.2 目标

| 编号 | 目标 | 验收 |
| --- | --- | --- |
| G1 | 所有 LoRA 在所有模型档上都能得到"能用"的结果 | 无静默失效 |
| G2 | 兼容组合自动路由，不要求用户懂架构 | 用户选 LoRA 即自动纠正档位 |
| G3 | 不兼容组合提供跨架构搬运 | DiT 模型出图带 LoRA 角色/风格特征 |
| G4 | 表单与控制台都能看到 LoRA 全清单及兼容性 | 两处均实现 |
| G5 | 修复提示词丢失 bug | 日志正向长度 = 表单提交长度 |

---

## 二、技术边界（可行性判定）

### 2.1 LoRA 的数学本质

$$\Delta W = \frac{\alpha}{r} \cdot B A$$

`A: [r, in_features]`、`B: [out_features, r]`，只能作用于**同名同形状**的目标权重。

### 2.2 本机实测数据

**LoRA 侧**（29 个 SD1.5 LoRA），头部张量特征：

```
lora_te_text_model_encoder_layers_0_mlp_fc1.lora_down.weight   shape [256, 768]
lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_*    shape [r, 320]
lora_unet_up_blocks_3_*                                        shape [r, 1280]
```

**模型侧**：

| 档位 | key | 引擎 | 架构 |
| --- | --- | --- | --- |
| SD_FP16 | `SD_FP16` | A1111 | SD1.5/SDXL UNet |
| Anima_INT8 | `Anima_INT8` | A1111 | SD1.5/SDXL UNet |
| Qwen-Image | `QwenImage_NVFP4` | ComfyUI | Qwen-Image DiT（`qwen-image-2.1-UC-Q4_K_M.gguf`） |
| Krea2 | `Krea2_Q4` | ComfyUI | Krea2/Flux DiT（`krea2_turbo-Q4_K_M.gguf`） |

### 2.3 判定

| 组合 | 能否直用 | 依据 |
| --- | --- | --- |
| SD1.5 LoRA ↔ SD1.5 底模 | ✅ 原生 | 同架构同形状 |
| SD1.5 LoRA ↔ SDXL 底模 | ❌ | 通道数 768 vs 1280、层名不同 |
| SD1.5 LoRA ↔ Qwen-Image | ❌ | 无 `down_blocks`，隐藏维 3072 |
| SD1.5 LoRA ↔ Krea2/Flux | ❌ | 无 UNet 拓扑，`double_blocks` 结构 |

**结论：跨架构"张量直译"不成立。** 任何声称能做的方案都需要训练投影网络（数小时/个、质量不可控），不纳入范围。

**可实现路径**：同架构直通 + 兼容路由 + 跨架构**效果搬运**（两段式）。

---

## 三、总体架构

```
                        ┌─────────────────────────────┐
                        │  lora-inspect.js（P0）      │
                        │  只读 safetensors 头部 JSON │
                        │  → family / dim / usableTiers│
                        └──────────────┬──────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
   ┌──────────────────┐   ┌────────────────────┐   ┌────────────────────┐
   │ 兼容路由 (P1)    │   │ 搬运管线 (P2)      │   │ 前端展示 (P5)      │
   │ autoSwitch/bridge│   │ Stage1 SD+LoRA     │   │ 表单置灰+标注      │
   │ /block           │   │ Stage2 DiT img2img │   │ 控制台全量清单     │
   └────────┬─────────┘   └─────────┬──────────┘   └────────────────────┘
            │                       │
            └───────────┬───────────┘
                        ▼
              ┌──────────────────────┐
              │ 网关 (server.js)     │
              │ /api/loras/inspect   │
              │ /api/bridge/generate │
              └──────────────────────┘
```

---

## 四、模块详细设计

### P0 · LoRA 元数据引擎

**新增** `gateway/lib/lora-inspect.js`

只读 safetensors 前 8 字节长度 + JSON 头，不加载权重（单文件 < 5 ms）。

```js
export function inspectLora(filePath) -> {
  name, filePath, bytes,
  family,            // 'sd15' | 'sdxl' | 'flux' | 'krea2' | 'qwen-image' | 'unknown'
  familyConfidence,  // 'high' | 'medium' | 'low'
  dim, alpha,
  tensorCount,
  hasTextEncoder, textEncoderDim,
  unetInChannels,    // [320, 640, 1280]
  usableTiers,       // ['SD_FP16','Anima_INT8']
  needsBridge,       // 是否需要搬运管线
  notes              // 判定过程中的异常说明
}
```

**判定规则**（按优先级短路）：

| # | 条件 | family |
| --- | --- | --- |
| 1 | 张量名含 `double_blocks` 或 `single_blocks` | `flux` / `krea2` |
| 2 | 张量名含 `transformer_blocks` 且无 `down_blocks` | `qwen-image` |
| 3 | `text_encoder` 维 768 且 UNet 首层 320 | `sd15` |
| 4 | `text_encoder` 维 1024 且 UNet 首层 320 | `sd2` |
| 5 | `text_encoder` 维 1280 且 UNet 首层 320 | `sdxl` |
| 6 | 其余 | `unknown`（仅同档可见，标注"无法判定"） |

**降级路径**：头部无 `__metadata__`（如 `semirealisticanime` 只有 528 张量、无 base 标记）时，用张量名+形状推断，`familyConfidence = 'medium'`。

**新增** `gateway/lib/lora-inspect-cli.js`

```bash
node gateway/lib/lora-inspect-cli.js --all          # 扫描全部并输出表格
node gateway/lib/lora-inspect-cli.js --file <path>  # 单个详情
node gateway/lib/lora-inspect-cli.js --json         # 机器可读
```

**新增 API** `GET /api/loras/inspect?refresh=1`

```json
{ "ok": true, "count": 29, "loras": [ /* inspectLora 数组 */ ] }
```

### P1 · 兼容性路由

**映射表**（`models.js` 增加 `family` 字段 + 反向映射）：

| LoRA family | 可用档位 |
| --- | --- |
| `sd15` / `sdxl` | `SD_FP16`、`Anima_INT8` |
| `flux` / `krea2` | `Krea2_Q4` |
| `qwen-image` | `QwenImage_NVFP4` |
| `unknown` | 不限制，但打警告 |

**新增** `sd-inject.ps1` 函数 `Test-LoraModelCompat`

```powershell
param([string]$LoraName, [string]$Model)
# 返回 @{ Ok; SuggestedModel; Family; Message }
```

**三种策略**（配置 `loraCompatPolicy`，默认 `autoSwitch`）：

| 策略 | 行为 |
| --- | --- |
| `autoSwitch` | 自动切档 + 控制台黄字说明 |
| `bridge` | 转 P2 搬运管线 |
| `block` | 拒绝并列出可选档 |

**顺带修两个 P0 bug**：

1. 在 `$P = Show-ParamForm ...`（**行 5365**）之后立即插入：

```powershell
$positive = if ($P.Pos -and "$($P.Pos)".Trim()) { "$($P.Pos)".Trim() } else { $formPositive }
$negative = if ($P.Neg -and "$($P.Neg)".Trim()) { "$($P.Neg)".Trim() } else { $formNegative }
if ($formPositive.Length -gt 20 -and $positive.Length -lt $formPositive.Length * 0.5) {
    Write-Host "警告：表单正向提示词长度骤降（$($formPositive.Length) → $($positive.Length)），请检查是否被清空" -ForegroundColor Yellow
}
```

2. `-Model` 默认值 `QwenImage_NVFP4` 改为 `SD_FP16`；仅在无 LoRA 时保留 Qwen 优先（因 SD1.5 跑 1216×1536 会崩解剖）。

### P2 · 跨架构搬运管线（走网关）

**新增 API** `POST /api/bridge/generate`

```json
{
  "model": "QwenImage_NVFP4",
  "lora": { "name": "守岸人_官方1024", "weight": 1.0 },
  "prompt": "...", "negative": "...",
  "width": 1216, "height": 1536,
  "stage1": { "model": "SD_FP16", "steps": 30, "cfg": 7 },
  "stage2": { "denoise": 0.35, "steps": 24, "cfg": 1.0 }
}
```

**执行流**：

1. **Stage 1**：`SD_FP16` + `<lora:X:1.0>` + 完整提示词 → `base.png`
2. **校验**：Stage 1 失败 → 直接返回失败（不进入 Stage 2）
3. **Stage 2**：目标 DiT 模型 `img2img(base.png, denoise)` → `final.png`
4. **兜底**：Stage 2 失败 → 返回 Stage 1 的图 + `degraded: true`
5. **元数据**：两段参数写入 PNG（`bridge_stage1` / `bridge_stage2`）

**待标定参数**（M5）：

| 参数 | 初值 | 扫描范围 |
| --- | --- | --- |
| Stage2 denoise | 0.35 | 0.30 / 0.35 / 0.40 / 0.45 |
| Stage2 cfg | 1.0 | 固定（flow 系必须 1） |
| Stage2 steps | 24 | 固定 |

**新增** `sd-inject.ps1` 函数 `Invoke-LoraBridge`，在 `loraCompatPolicy = bridge` 时接管出图。

### P3 · LoRA 修复能力

| 能力 | 说明 |
| --- | --- |
| 元数据补全 | 缺 `ss_base_model_version` → 形状推断 |
| 键名归一化 | kohya / LyCORIS / 社区前缀差异 → 统一 family 视图（不改原文件） |
| 可选瘦身 | LoCon 卷积层剥离为纯 LoRA（体积 -30~60%，提升 A1111 兼容性） |

### P4 · ComfyUI 可见性

- 已确认 `D:\ComfyUI\extra_model_paths.yaml` 正确共享 `D:/SD.4.8/models/Lora` ✅
- `GET /api/models?refresh=1` 增加 `visibleLoras` 字段，标注每个 LoRA 在哪些引擎可见

### P5 · 前端交互（两处都做）

**表单**（`sd-inject.ps1` 行 2745 区域）

- 下拉项格式：`守岸人_官方1024 0.8  [SD1.5]`
- 与当前档不兼容 → 置灰 + 后缀 `[需 SD_FP16]`
- 自动匹配命中 → 表单顶部横幅：`已自动匹配 LoRA：守岸人_官方1024（0.8）· 已切模型档 SD_FP16`

**控制台**

- 全量清单：`编号 / 名称 / family / dim / 可用档`
- 未命中 → 打印前 20 个可选项 + 手填格式提示

**新增** `Select-LoraForRequest`（自动匹配算法）

| 优先级 | 规则 | 得分 |
| --- | --- | --- |
| 1 | 去权重后缀后完全同名 | 100 |
| 2 | LoRA 名包含关键词 / 关键词包含 LoRA 名 | 80 |
| 3 | 去 `_官方1024`/`_id`/`_base`/`_v2` 后缀后匹配 | 60 |
| 4 | 编辑距离 ≤ 2 | 40 |

多命中排序：`_官方1024` > `_id` > `_base`。

---

## 五、文件改动清单

| 文件 | 类型 | 关键位置 |
| --- | --- | --- |
| `gateway/lib/lora-inspect.js` | **新增** | — |
| `gateway/lib/lora-inspect-cli.js` | **新增** | — |
| `gateway/lib/bridge-orchestrator.js` | **新增** | Stage1/Stage2 编排 |
| `gateway/lib/models.js` | 修改 | 档位增加 `family` 字段 |
| `gateway/server.js` | 修改 | +2 路由（现有 20 个） |
| `gateway/lib/engines.js` | 修改 | bridge 工作流生成 |
| `sd-inject.ps1` | 修改 | 行 2745（下拉）、行 5291（formPositive）、行 5365（表单返回后插入） |
| `sd-bridge.js` | 修改 | 新增 `sd_lora_inspect` 工具 + 技能文档 |
| `tests/test-lora-inspect.mjs` | **新增** | 架构判定单测（基线 29 个 LoRA） |
| `tests/test-bridge.mjs` | **新增** | 搬运管线编排单测（mock 引擎） |

---

## 六、里程碑

| 阶段 | 内容 | 交付物 | 工时 | 依赖 |
| --- | --- | --- | --- | --- |
| **M1** | P0 元数据引擎 + 单测 | `lora-inspect.js`、CLI、29 个 LoRA 全判定报告 | 1.5 h | — |
| **M2** | P1 兼容路由 + 修 2 个 P0 bug | 兼容闸门、提示词回传修复 | 1.5 h | M1 |
| **M3** | P5 前端（表单 + 控制台 + 自动匹配） | 置灰标注、清单、`Select-LoraForRequest` | 2 h | M2 |
| **M4** | P2 搬运管线（走网关） | `/api/bridge/generate`、`Invoke-LoraBridge` | 3 h | M2 |
| **M5** | 参数标定（denoise 四档） | 4 组图 + 视觉分 + 最优参数 | 2 h | M4 |
| **M6** | P3 修复 + P4 ComfyUI 清单合并 | 元数据补全、`visibleLoras` | 1.5 h | M1 |
| **M7** | 全量回归 | 冒烟 + 网关测试 + 真机「画守岸人」 | 1.5 h | 全部 |

**合计 13 小时。** 推荐顺序：M1 → M2 → M3（先治主症状）→ M4 → M5 → M6 → M7。

**分批交付建议**：
- **批次 1**（M1–M3，5 h）：修好"选了 LoRA 却普通出图"的全部症状
- **批次 2**（M4–M5，5 h）：跨架构搬运可用
- **批次 3**（M6–M7，3 h）：修复能力 + 全量回归

---

## 七、验证标准

| # | 验证项 | 判定 | 手段 |
| --- | --- | --- | --- |
| V1 | 元数据判定 | 29 个 LoRA 全部有 family，unknown 需给出原因 | `lora-inspect-cli --all` |
| V2 | 提示词完整性 | 日志「正向」长度 = 表单提交长度 | 比对 `run-*.log` 行 104 与 117 |
| V3 | 兼容路由 | 选 SD1.5 LoRA + Qwen 档 → 自动切 SD_FP16 并打日志 | 真机跑 + 查日志 |
| V4 | LoRA 真生效 | 产物 PNG `Lora hashes` 含该 LoRA（当前为空） | 读 PNG 元数据 |
| V5 | 搬运管线 | Qwen 档 + SD1.5 LoRA 出图带角色特征，视觉比对 ≥6/10 | 视觉模型打分 |
| V6 | 不兼容拒绝 | `block` 策略下明确报错并列出可选档 | 真机跑 |
| V7 | 自动匹配 | 「画一个守岸人」→ 日志出现 `已自动匹配 LoRA：守岸人_官方1024` | 真机跑 |
| V8 | 回归 | `smoke-skill.mjs` + `gateway/test/*.test.mjs` 全绿 | `npm test` |

---

## 八、风险与回滚

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| `sd-inject.ps1`（6199 行）改动引入回归 | **高** | 全部增量插入、不动既有分支；每阶段单独 commit；先 `-SelfTest` 再真跑 |
| P2 搬运后角色特征丢失 | 中 | M5 标定 denoise；失败兜底交付 Stage1 图 |
| DiT 模型 cfg≠1 会融图 | 中 | 硬编码 cfg=1，不给用户改 |
| 网关并发限制（单车道） | 中 | Stage1/Stage2 串行，复用现有排队锁 |
| LoRA 头部解析遇异常文件 | 低 | try/catch 降级 `unknown`，不阻断 |
| 显存不足（两段式连续跑） | 中 | 复用现有三级自愈；Stage 间主动卸载 |

**回滚点**：M1–M7 每阶段一个 commit，出问题 `git revert <commit>` 单阶段回滚，不影响其他阶段。

---

## 九、明确不做的事

| 事项 | 原因 |
| --- | --- |
| SD1.5 LoRA 张量直译为 Qwen/Krea2 LoRA | 数学上不成立（层不存在、形状不匹配） |
| 训练跨架构投影网络 | 数小时/个、质量不可控，ROI 太低 |
| 修改 LoRA 原文件 | 只读解析，不写回；瘦身能力输出新文件 |
| 跨架构 LoRA 的"等效权重"承诺 | 只能做到视觉相近，不做数值承诺 |

---

## 十、确认项（已定）

1. ✅ 搬运管线走网关（与现有调度架构一致，复用排队锁与状态机）
2. ✅ M5 参数标定：我输出四组图 + 视觉模型分数 + 结论，附原图供复核

---

*文档结束。确认后从 M1 开始执行。*
