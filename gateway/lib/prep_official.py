"""
prep_official.py —— 官方素材全自动数据集准备（v2，被 official-pipeline.js 调用）

v1 → v2 改了什么（2026-10-25，针对「LoRA 效果依然很差」的实测修复）：
  ① 三档裁切 → 四档（全身 / 上半身 / 头肩 / 脸部特写）
     v1 的头肩裁切是死比例，官方立绘人物不居中时会切掉脸；v2 先做**脸部定位**
     （OpenCV 正脸检测 → 失败则退回中心偏上区域），四档都围绕检测到的脸，
     保证 ID 有足够的近距离样本 —— 这是「像不像」的关键。
  ② 标注加**触发词**（每个角色一个 ASCII 触发词）并逐图变化
     v1 全部图共用同一句 caption（实测 tag_frequency 只有 `{"yangyang": 13}`），
     等于告诉模型「所有图都是同一个东西」，场景/姿态被一起焊进权重，推理时提示词被顶掉。
     v2 每张 icon 都带 `触发词 + 构图`，构图词随档位变化，特征词一律不写（保持无条件焊入）。
  ③ 输出短边按训练分辨率对齐（512/640 档位不再生成 1024 大图，训练快 2.4 倍且不过曝）
  ④ 报告里带上每档的尺寸与触发词，便于事后核对

用法：
  python prep_official.py --src <素材目录或图片> --dst <数据集目录> --res 640 --trigger yyv4 --json
"""
import argparse
import json
import math
import os
import sys

from PIL import Image

IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


def collect(src):
    out = []
    if os.path.isdir(src):
        for root, _dirs, files in os.walk(src):
            for f in files:
                if f.lower().endswith(IMG_EXT):
                    out.append(os.path.join(root, f))
    elif os.path.isfile(src):
        out.append(src)
    return sorted(out)


def fit(im, target_short):
    """等比缩放到短边 >= target_short，并保证 8 的倍数"""
    w, h = im.size
    if min(w, h) < target_short:
        s = target_short / min(w, h)
        w, h = math.ceil(w * s), math.ceil(h * s)
    w = max(64, (w // 8) * 8)
    h = max(64, (h // 8) * 8)
    if (w, h) != im.size:
        im = im.resize((w, h), Image.LANCZOS)
    return im


def detect_face_box(im):
    """返回脸部框 (x, y, w, h) 与原图尺寸；检测不到返回 None。

    只用于**定位**（决定裁切重心），不做识别，也不需要联网模型。
    """
    try:
        import cv2
        import numpy as np
    except Exception:
        return None
    try:
        arr = np.asarray(im.convert("RGB"))
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
        cas = cv2.CascadeClassifier(cascade_path)
        if cas.empty():
            return None
        # 官方立绘脸部通常较小，多尺度扫一遍
        faces = cas.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4,
                                     minSize=(max(24, im.size[0] // 20), max(24, im.size[1] // 30)))
        if len(faces) == 0:
            return None
        # 取最大的一张脸（立绘里通常是主角）
        x, y, w, h = max(faces, key=lambda r: r[2] * r[3])
        return (int(x), int(y), int(w), int(h))
    except Exception:
        return None


def crops_for(im, face=None):
    """四档裁切：全都围绕脸部重心；没有脸时按「立绘头部在顶部中央」兜底。

    每档返回 (tag, box, caption_tail)。caption 里不含任何角色特征词，
    特征由触发词无条件携带（这是「不写发色也长对」的关键）。

    2026-10-25 修：v2 第一版把 upper/portrait/face 的宽度按整图宽度取比例，
    结果裁出 896x640 这种**横图**（人脸被拉扁、构图全错）。
    现在每档都按「高度 × 目标宽高比 0.78」定宽，保证四档都是竖构图。
    """
    W, H = im.size
    ASPECT = 0.78  # 宽 / 高，接近 3:4 竖构图

    if face:
        fx, fy, fw, fh = face
        cx = fx + fw / 2
        head_top = max(0.0, fy - fh * 0.55)
        head_h = fh * 1.9          # 含头发的头高
    else:
        # 斗罗式兜底：官方立绘头部高度约 1/7.5 身高，位于顶部中央
        cx = W / 2
        head_h = H / 7.5
        head_top = H * 0.02

    def box_by_height(top, height, cx_=None):
        c = W / 2 if cx_ is None else cx_
        half_w = (height * ASPECT) / 2
        x1 = max(0, int(c - half_w))
        x2 = min(W, int(c + half_w))
        y1 = max(0, int(top))
        y2 = min(H, int(top + height))
        if x2 - x1 < 64 or y2 - y1 < 64:
            return (0, 0, W, H)
        return (x1, y1, x2, y2)

    return [
        ("full", (0, 0, W, H), "full body, standing, simple background"),
        ("upper", box_by_height(head_top, H * 0.58), "upper body, portrait, simple background"),
        ("portrait", box_by_height(head_top, head_h * 2.1), "portrait, close-up, simple background"),
        # 脸部特写占两档（2026-10-26 加）：单档脸部占比只有 20%，拟合不足时脸最先崩。
        # 加一档更紧的脸部裁切，让模型有足够多的脸部样本学五官。
        ("face", box_by_height(head_top, head_h * 1.15), "face focus, close-up, simple background"),
        ("face_tight", box_by_height(head_top, head_h * 0.75), "face focus, extreme close-up, simple background"),
        # 下半身单独一档（2026-10-25 加）：四档里有三档都是上半身，
        # 实测出图时上装/头饰全对、腿和鞋却退回底模默认（黑丝变光腿、靴子变形）。
        # 补一档「腰部以下」把裤袜/靴子/裙摆一起学进去；
        # 起点定在 38% 高度（含腰臀，让裙摆和身体的结构关系成立），宽度按 3:4 竖构图收窄。
        ("legs", box_by_height(H * 0.38, H * 0.62), "lower body, legs, boots, simple background"),
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--res", type=int, default=640, help="目标短边（= 训练分辨率档位）")
    ap.add_argument("--trigger", default="", help="触发词（ASCII，写进每张图的标注首 token）")
    ap.add_argument("--max-images", type=int, default=80)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    files = collect(args.src)[: args.max_images]
    if not files:
        print(json.dumps({"ok": False, "error": "素材目录里没有图片"}))
        return 1

    os.makedirs(args.dst, exist_ok=True)
    for f in os.listdir(args.dst):
        os.remove(os.path.join(args.dst, f))

    target = args.res
    trig = args.trigger.strip()
    made = []
    idx = 0
    face_hits = 0
    for src in files:
        try:
            im = Image.open(src).convert("RGB")
        except Exception:
            continue
        face = detect_face_box(im)
        if face:
            face_hits += 1
        for tag, box, cap_tail in crops_for(im, face):
            c = im.crop(box)
            c = fit(c, target)
            idx += 1
            out = os.path.join(args.dst, f"img_{idx:03d}_{tag}.png")
            c.save(out, "PNG")
            caption = f"{trig}, {cap_tail}" if trig else cap_tail
            with open(out.replace(".png", ".txt"), "w", encoding="utf-8") as fp:
                fp.write(caption)
            made.append({"file": os.path.basename(out), "from": os.path.basename(src),
                         "tag": tag, "size": f"{c.size[0]}x{c.size[1]}", "caption": caption})

    report = {
        "ok": len(made) > 0,
        "sources": len(files),
        "images": len(made),
        "face_detected_sources": face_hits,
        "dst": args.dst,
        "resolution": args.res,
        "trigger": trig,
        "sample": made[:4],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if made else 1


if __name__ == "__main__":
    sys.exit(main())
