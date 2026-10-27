#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
sd-addtext-composite.py —— 加字「只改文字那一块」合成器（2026-10-21）

背景（实测）：加字那一步是「另一档模型」对成品做 img2img，denoise 0.65 时
**整张 93% 像素被重画**（实测 diffRatio=0.9314）→ 用户要的画风/提示词符合度被洗掉，
观感就是「它拿我的成品重画了一遍，而不是按我的提示词出图」。

本脚本把这件事收窄：**只在文字所在的那块矩形里采用 AI 写好的字**，
矩形外 100% 保留原图（像素级不动），边缘做羽化过渡。

用法：
  python sd-addtext-composite.py --base 原图.png --texted AI带字图.png
        --pos 0.518,0.907 --size 特大 --style 霓虹发光 --out 成品_文字.png
  也支持直接给框：--box x,y,w,h（0-1 归一化，相对原图）

输出 JSON（stdout，UTF-8）：
  {"ok":true,"out":"...","box_px":[x,y,w,h],"inside_changed_ratio":0.12,"outside_changed_ratio":0.0}
"""
import argparse
import json
import os
import sys

try:
    from PIL import Image, ImageFilter
except Exception as e:  # noqa
    print(json.dumps({"ok": False, "error": "PIL 不可用: %s" % e}, ensure_ascii=False))
    sys.exit(0)

# 九宫格 → 文字框（相对值：x, y, w, h，与选位器预览同一套规则）
ZONE_RECTS = {
    'TL': (0.05, 0.06, 0.55, 0.22), 'TC': (0.20, 0.06, 0.60, 0.18), 'TR': (0.40, 0.06, 0.55, 0.22),
    'ML': (0.05, 0.39, 0.50, 0.22), 'MC': (0.25, 0.40, 0.50, 0.20), 'MR': (0.45, 0.39, 0.50, 0.22),
    'BL': (0.05, 0.72, 0.55, 0.22), 'BC': (0.20, 0.76, 0.60, 0.18), 'BR': (0.40, 0.72, 0.55, 0.22),
}
# 字号 → 文字框高度（相对图高）
SIZE_H = {'小': 0.13, '中': 0.20, '大': 0.26, '特大': 0.34}


def zone_from_point(x, y):
    cx = 'L' if x < 0.34 else ('C' if x < 0.67 else 'R')
    cy = 'T' if y < 0.34 else ('M' if y < 0.67 else 'B')
    return cy + cx


def resolve_box(args, W, H):
    """返回归一化框 (x, y, w, h)"""
    if args.box:
        parts = [float(v) for v in args.box.replace('，', ',').split(',')]
        if len(parts) == 4:
            return tuple(parts)
    pos = (args.pos or '').strip()
    size = (args.size or '中').strip()
    h = SIZE_H.get(size, 0.20)
    if pos and ',' in pos:
        try:
            px, py = [float(v) for v in pos.replace('，', ',').split(',')[:2]]
            if px > 1:
                px /= 100.0
            if py > 1:
                py /= 100.0
            w = 0.60
            return (max(0.0, px - w / 2), max(0.0, py - h / 2), w, h)
        except Exception:
            pass
    z = (pos or 'MC').upper()
    if z not in ZONE_RECTS:
        z = 'MC'
    x, y, w, hz = ZONE_RECTS[z]
    # 字号越大，框越高（并以原框中心扩）
    cy = y + hz / 2
    h2 = max(hz, h)
    return (x, max(0.0, cy - h2 / 2), w, h2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True, help='未加字的原图（画面要保住的这张）')
    ap.add_argument('--texted', required=True, help='AI 写字的版本')
    ap.add_argument('--out', required=True)
    ap.add_argument('--pos', default='')
    ap.add_argument('--size', default='中')
    ap.add_argument('--style', default='')
    ap.add_argument('--box', default='', help='直接给框 x,y,w,h（0-1）')
    ap.add_argument('--feather', type=int, default=6, help='边缘羽化像素')
    ap.add_argument('--grow', type=float, default=0.06, help='框外扩（相对短边）')
    args = ap.parse_args()

    if not os.path.isfile(args.base) or not os.path.isfile(args.texted):
        print(json.dumps({"ok": False, "error": "输入图不存在"}, ensure_ascii=False))
        return
    try:
        base = Image.open(args.base).convert('RGB')
        tex = Image.open(args.texted).convert('RGB')
        if tex.size != base.size:
            tex = tex.resize(base.size, Image.LANCZOS)
        W, H = base.size
        nx, ny, nw, nh = resolve_box(args, W, H)
        g = max(2, int(min(W, H) * args.grow))
        x0 = max(0, int(nx * W) - g)
        y0 = max(0, int(ny * H) - g)
        x1 = min(W, int((nx + nw) * W) + g)
        y1 = min(H, int((ny + nh) * H) + g)
        if x1 - x0 < 8 or y1 - y0 < 8:
            print(json.dumps({"ok": False, "error": "文字框太小"}, ensure_ascii=False))
            return
        # 羽化蒙版（框内 255，边缘渐变）
        mask = Image.new('L', (W, H), 0)
        mask.paste(255, (x0, y0, x1, y1))
        if args.feather > 0:
            mask = mask.filter(ImageFilter.GaussianBlur(args.feather))
        out = base.copy()
        out.paste(tex, (0, 0), mask)
        out.save(args.out)

        # 定量报告：框内/框外 变化比例（用缩略图算，快且够用）
        small_b = base.resize((128, 192))
        small_a = out.resize((128, 192))
        import math
        def diff_ratio(im1, im2, xa, ya, xb, yb):
            px1 = im1.load(); px2 = im2.load()
            tot = 0; chg = 0
            for yy in range(ya, yb):
                for xx in range(xa, xb):
                    tot += 1
                    p1 = px1[xx, yy]; p2 = px2[xx, yy]
                    if abs(p1[0] - p2[0]) + abs(p1[1] - p2[1]) + abs(p1[2] - p2[2]) > 24:
                        chg += 1
            return (chg / tot) if tot else 0.0
        bx0 = max(0, int(nx * 128) - 2); by0 = max(0, int(ny * 192) - 2)
        bx1 = min(128, int((nx + nw) * 128) + 2); by1 = min(192, int((ny + nh) * 192) + 2)
        ins = diff_ratio(small_b, small_a, bx0, by0, bx1, by1)
        outs = 0.0
        if by0 > 0:
            outs = max(outs, diff_ratio(small_b, small_a, 0, 0, 128, by0))
        if by1 < 192:
            outs = max(outs, diff_ratio(small_b, small_a, 0, by1, 128, 192))
        print(json.dumps({
            "ok": True, "out": args.out, "box_px": [x0, y0, x1, y1],
            "inside_changed_ratio": round(ins, 4), "outside_changed_ratio": round(outs, 4),
        }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))


if __name__ == '__main__':
    main()