# kohya 数据集目录模板

一次炼制会为**每条轨道**各建一个独立数据集根，互不混用：

```
<datasetRoot>/
├─ aili_id/                      ← ID 轨数据集根（= --train_data_dir）
│  ├─ 10_aili_id/                ← 重复次数_概念名（程序自动生成）
│  │  ├─ 01.png
│  │  ├─ 01.txt                  ← 必须同名、必须非空
│  │  ├─ 02.png
│  │  └─ 02.txt
│  └─ reg/                       ← 可选：减轻遗忘
│     └─ 1_aili_id_reg/
│        ├─ g01.png
│        └─ g01.txt              ← 可留空
└─ aili_base/                    ← Base 轨数据集根
   └─ 10_aili_base/
      └─ ...
```

## 三条硬规则

1. **目录名必须是 `数字_名字`**（`10_aili_id`）。数字 = 每 epoch 重复次数；kohya 靠这个前缀识别数据集，不匹配的目录会被忽略。
2. **标注文件与图片严格同名**（`01.png` ↔ `01.txt`），编码 UTF-8。缺标注会在训练前被拦下并指出具体文件。
3. **`reg/` 是可选的**，放 5–10 张"通用人物"图（不是本角色）。给多了浪费显存，给少了防遗忘效果不明显。

## 分轨原则

| 轨道 | 素材应该是什么 | 标注侧重点 |
|---|---|---|
| ID 轨 | 脸部 / 头肩特写为主（≥60%） | 发型、发色、瞳色、表情、脸部构图与光照；服装词尽量少 |
| Base 轨 | 半身 / 全身 / 场景为主（特写 ≤25%） | 服装、场景、构图、光照；脸部细节尽量少 |

> Base 轨脸部特写超 25% 会被**直接拦下**：那正是 Base 学到身份、后续换装变脸的头号原因。

## 标注写法

见 `caption-example.txt`。一句话概括：**只写可变的东西，绝不写"这是谁"**。

- ✅ `woman in garden, sunlight, green dress, upper body`
- ✅ `close-up, face, soft rim light, dark background`
- ✅ `full body, standing, knight armor, castle courtyard, dusk`
- ❌ `sks woman, <lora:myChar:0.8>, my OC Alice`（触发词 + 内联语法 + 角色名，三项全禁）
- ❌ `Alice in garden`（角色名会被判为疑似身份 token）
