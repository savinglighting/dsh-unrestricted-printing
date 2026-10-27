"""蒙版命中率体检：把「参考图 / 蒙版 / 出图」三方逐像素对齐，给出可核对的数字 + 人工审阅总览图。

为什么需要它：蒙版准不准，光看生成结果会被「模型自己画了什么」干扰
（实测：用「脱衣服」提示词去测蒙版，模型会把衣服画成「半脱状态」——
看起来像蒙版漏了，其实那块像素**已经改过**了，是新画的内容）。
这里直接测「蒙版内变没变 / 蒙版外动没动」，与提示词无关，可以客观回答蒙版成功率。

四类判定：
  hit         蒙版内 & 像素变了   -> 蒙版命中且重绘生效
  ineffective 蒙版内 & 像素没变   -> 命中了但没改（denoising 太低 / 蒙版里本来就是要留的内容）
  leak        蒙版外 & 像素变了   -> 羽化/膨胀外溢，把不该动的动了
  kept        蒙版外 & 像素没变   -> 正确保留（换衣服不变画风的关键）
另有 suspect：蒙版外 & 没变 & 局部偏暗 & 贴着蒙版 -> 疑似漏掉的衣料碎片（人工复核用，非判决）

用法：
  python sd-mask-qa.py --ref REF.png --mask MASK.png --out OUT.png [--qa-dir DIR] [--json]
输出：stdout 人类可读报告；--json 时改成一行 JSON（PowerShell 侧解析用）。
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np


def imread_any(path, flag=cv2.IMREAD_COLOR):
    """Windows 中文/非 ASCII 路径：cv2.imread 会失败 -> np.fromfile + imdecode。"""
    try:
        buf = np.fromfile(path, dtype=np.uint8)
        img = cv2.imdecode(buf, flag)
        if img is not None:
            return img
    except Exception:
        pass
    return cv2.imread(path, flag)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, help="参考图（喂给 img2img 的那张）")
    ap.add_argument("--mask", required=True, help="蒙版图（白=重绘区）")
    ap.add_argument("--out", required=True, help="最终出图")
    ap.add_argument("--qa-dir", default="", help="总览图输出目录（默认=出图同目录）")
    ap.add_argument("--diff-threshold", type=float, default=12.0, help="判「像素变了」的平均通道差阈值")
    ap.add_argument("--json", action="store_true", help="输出一行 JSON（供 PowerShell 解析）")
    args = ap.parse_args()

    result = {"ok": False, "hit": 0.0, "ineffective": 0.0, "leak": 0.0, "kept": 0.0,
              "mask": 0.0, "suspect": 0.0, "suspect_blobs": 0, "overlay": "", "notes": ""}
    ref = imread_any(args.ref)
    mask = imread_any(args.mask)
    out = imread_any(args.out)
    if ref is None or mask is None or out is None:
        result["notes"] = f"读不出图：ref={ref is not None} mask={mask is not None} out={out is not None}"
        print(json.dumps(result, ensure_ascii=True) if args.json else result["notes"])
        return 0

    H, W = ref.shape[:2]
    if out.shape[:2] != (H, W):
        out = cv2.resize(out, (W, H), interpolation=cv2.INTER_AREA)
    if mask.shape[:2] != (H, W):
        mask = cv2.resize(mask, (W, H), interpolation=cv2.INTER_NEAREST)
    m = (cv2.cvtColor(mask, cv2.COLOR_BGR2GRAY) > 127)

    diff = np.abs(ref.astype(np.int16) - out.astype(np.int16)).mean(axis=2)
    changed = diff > args.diff_threshold
    tot = float(H * W)
    hit = float((m & changed).sum()) / tot
    ineff = float((m & ~changed).sum()) / tot
    leak = float((~m & changed).sum()) / tot
    kept = float((~m & ~changed).sum()) / tot
    m_cov = float(m.sum()) / tot

    # 疑似漏掉的衣料：蒙版外、没变、比局部均值暗（衣物），且贴着蒙版
    suspect = np.zeros_like(m, dtype=bool)
    blobs = 0
    try:
        gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY).astype(np.float32)
        local = cv2.blur(gray, (61, 61))
        darker = gray < local - 12
        near = cv2.dilate(m.astype(np.uint8) * 255,
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61))) > 0
        suspect = (~m) & (~changed) & darker & near
        n, _lab, stats, _ = cv2.connectedComponentsWithStats(suspect.astype(np.uint8), 8)
        blobs = sum(1 for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] > 0.003 * tot)
    except Exception:
        pass

    vis = ref.copy()
    vis[m & changed] = (0.35 * vis[m & changed] + 0.65 * np.array([0, 255, 0])).astype(np.uint8)
    vis[m & ~changed] = (0.35 * vis[m & ~changed] + 0.65 * np.array([0, 215, 255])).astype(np.uint8)
    vis[~m & changed] = (0.35 * vis[~m & changed] + 0.65 * np.array([0, 0, 255])).astype(np.uint8)
    vis[suspect] = (0.25 * vis[suspect] + 0.75 * np.array([255, 0, 255])).astype(np.uint8)
    qa_dir = args.qa_dir or os.path.dirname(os.path.abspath(args.out))
    try:
        os.makedirs(qa_dir, exist_ok=True)
        ov = os.path.join(qa_dir, "qa-" + os.path.splitext(os.path.basename(args.out))[0] + ".png")
        cv2.imwrite(ov, vis)
        result["overlay"] = ov
    except Exception as e:
        result["notes"] = f"总览图写入失败：{type(e).__name__}"

    result.update({"ok": True, "mask": round(m_cov, 4), "hit": round(hit, 4),
                   "ineffective": round(ineff, 4), "leak": round(leak, 4), "kept": round(kept, 4),
                   "suspect": round(float(suspect.sum()) / tot, 4), "suspect_blobs": int(blobs)})
    if not result["notes"]:
        in_mask = max(1e-9, m_cov)
        out_mask = max(1e-9, 1.0 - m_cov)
        result["notes"] = (f"蒙版内已改 {100 * hit / in_mask:.1f}%｜蒙版内未改 {100 * ineff / in_mask:.1f}%"
                           f"｜蒙版外被改 {100 * leak / out_mask:.2f}%（外溢）｜蒙版外保留 {100 * kept / out_mask:.2f}%")
    if args.json:
        print(json.dumps(result, ensure_ascii=True))
    else:
        print(f"蒙版命中率体检：frame {W}x{H}，蒙版覆盖 {100 * m_cov:.2f}%")
        print(f"  命中共 {100 * hit:6.2f}% 占画面（占蒙版 {100 * hit / max(1e-9, m_cov):5.1f}%）")
        print(f"  命中未改 {100 * ineff:6.2f}%（占蒙版 {100 * ineff / max(1e-9, m_cov):5.1f}%，denoising 太低或本就该保留）")
        print(f"  外溢 {100 * leak:6.2f}%（占蒙版外 {100 * leak / max(1e-9, 1 - m_cov):5.2f}%）")
        print(f"  正确保留 {100 * kept:6.2f}%（占蒙版外 {100 * kept / max(1e-9, 1 - m_cov):5.2f}%）")
        print(f"  疑似漏掉衣料 {100 * float(suspect.sum()) / tot:6.2f}%（{blobs} 块 >0.3%，需人工复核）")
        if result["overlay"]:
            print(f"  总览图：{result['overlay']}")
            print("  图例：绿=蒙版内已改 / 黄=蒙版内未改 / 红=蒙版外被改（外溢）/ 品红=疑似漏掉衣料")
    return 0


if __name__ == "__main__":
    sys.exit(main())
