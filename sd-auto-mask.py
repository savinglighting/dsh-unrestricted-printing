#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
sd-auto-mask.py —— 按「这一张图的内容」自动生成重绘蒙版（不预设区域）。

思路（全部用本机已有文件，不联网下载）：
  ① YOLO-World（开放词表检测，文字提示）在参考图里找出目标物体 → 检测框；
  ② SAM（segment-anything，本机已有 vit_l / vit_h 权重）用这些框做 box-prompted 分割 → 精细轮廓蒙版；
  ③ 合并 + 形态学闭运算 + 膨胀 + 羽化 → 输出 8bit 灰度 PNG（白色 = 重绘区，黑色 = 保留区）。

目标映射：
  衣服 → dress/skirt/shirt/clothes/jacket/coat/uniform/kimono/...（取并集）
  脸   → face / head
  背景 → person 取反（人以外的都算背景）
  主体 → person

输出：stdout 打一行 JSON（ok / engine / boxes / coverage / mask / labels / notes），PowerShell 侧据此记录与回退。
失败时 ok=false 并把原因写进 notes，绝不抛栈影响主流程。
"""
import argparse
import glob
import json
import os
import sys

# 必须在 import torch / ultralytics **之前**设：显存碎片化是 8G 卡上「同一个命令时好时坏」的主因
# （实测：22:10 能抠、23:16 直接 CUDA OOM / 进程异常退出、PowerShell 侧只看到「没有输出」）。
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")


def _free_vram_gb():
    """剩余显存（GB）；取不到返回 -1。"""
    try:
        import torch
        if not torch.cuda.is_available():
            return -1
        return torch.cuda.mem_get_info()[0] / (1024.0 ** 3)
    except Exception:
        return -1


def pick_device(args):
    """检测/分割用哪个设备：显存不够就整条走 CPU。

    YOLO-World 的**加载与首次推理**同样会抢显存（不只是 SAM）。实测截图里那次失败就是
    「脚本跑到 YOLO-World 检测那一步就没输出了」——进程被 CUDA 崩掉，PowerShell 只能报
    「抠图脚本没有输出」。所以这里统一按剩余显存决定，宁可慢（CPU 也能跑）也不崩。
    """
    if getattr(args, "device", "auto") == "cpu":
        return "cpu"
    if getattr(args, "device", "auto") == "cuda":
        return "cuda"
    free = _free_vram_gb()
    if free < 0:
        return "cpu"
    if free < getattr(args, "vram_min_gb", 3.0):
        return "cpu"
    return "cuda"


TARGET_LABELS = {
    # YOLO-World 实测：多词一起喂会互相稀释（命中率骤降），必须**单词逐个试**。
    # 下面按「野外命中率」排序，命中即停（最多取 --max-boxes 个词的结果）。
    # 2026-10-16 补（用户反馈：换衣服后「袖子 / 兜帽 / 披风」这些**不属于连衣裙的部件**没进蒙版，
    # 重绘完身上还挂着半截袖子）：把 detached sleeves / hood / cloak / shawl / scarf 这类
    # 「同一套衣服的其它部件」加进词表，让检测器也能框到它们，后面的多件合一再并成一套。
    "衣服": ["dress", "sleeves", "detached sleeves", "hood", "cloak", "cape", "shawl", "scarf",
             "jacket", "coat", "uniform", "kimono", "sweater", "hoodie",
             "swimsuit", "swimwear", "bodysuit", "leotard", "wetsuit", "jumpsuit",
             "shirt", "skirt", "pants", "shorts", "raincoat", "clothing", "clothes", "outfit"],
    "脸": ["face", "head"],
    "背景": ["person"],
    "主体": ["person"],
}
INVERT_TARGETS = {"背景"}
# 找不到服饰词时：用「人物轮廓」兜底（按这张图里人的实际形状取躯干/腿部，而不是固定矩形）
SILHOUETTE_FALLBACK = {
    # 只在 --allow-silhouette 显式开启时才用「人物剪影 ∩ 躯干带」兜底。默认**禁止**：
    # 衣服蒙版一旦退化成身体剪影，重绘会把整个躯干重画（实测角色直接转身，等于换人）。
    "衣服": (0.14, 0.55, 1.00, 1.00),
    "脸": (0.00, 0.42, 0.30, 0.70),
}


def _write_png(path, img):
    """非 ASCII 路径安全写盘（cv2.imwrite 在中文路径下会静默失败）。"""
    import cv2   # 模块级没 import，函数里必须自己拿（否则 NameError 被吞掉 → 静默不写盘）
    try:
        ok, buf = cv2.imencode(os.path.splitext(path)[1] or ".png", img)
        if ok:
            buf.tofile(path)
            return True
    except Exception:
        pass
    try:
        return bool(cv2.imwrite(path, img))
    except Exception:
        return False

def find_file(roots, patterns, min_mb=0.5):
    """在 roots 下按 patterns 找文件（限制递归深度，避免扫全盘）。

    排序规则：**先按 patterns 的先后顺序**（前面的模式优先），同一模式内再按体积降序。
    这样 sam_vit_l 就真的会优先于 sam_vit_h（否则 7.9G 显存 + A1111 常驻必然 OOM）。
    """
    import fnmatch
    hits = []
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        base_depth = root.rstrip("\\/").count(os.sep)
        for dirpath, dirnames, filenames in os.walk(root):
            if dirpath.count(os.sep) - base_depth > 6:
                dirnames[:] = []
                continue
            for pi, pat in enumerate(patterns):
                for fn in filenames:
                    if fnmatch.fnmatch(fn.lower(), pat.lower()):
                        p = os.path.join(dirpath, fn)
                        try:
                            if os.path.getsize(p) >= min_mb * 1024 * 1024:
                                hits.append((pi, p))
                        except OSError:
                            pass
    # 先按模式顺序（vit_l 优先于 vit_h），同一模式内大的优先（真权重优先于 LFS 指针）
    hits.sort(key=lambda x: (x[0], -os.path.getsize(x[1])))
    return [p for _, p in hits]


def _count_person(sd_dir, img_bgr, dev):
    """确认这张图里到底有没有人。

    实测（用户 2026-10-16）：用户把一张**终端报错截图**（1112x340）当参考图传进来，
    12 个衣服词全零命中，黄字提示却是「换词或用手工框/区域蒙版」—— 用户换再多词也永远不会成功，
    因为图里根本没有人物。零命中 ≠ 词不对，必须先分清「词没命中」和「图里没人」。
    返回检测到的人数（找不到 person 权重时返回 -1 = 无法判定）。
    """
    models = find_file([sd_dir or ""], ["*person*yolov8*-seg.pt", "*person*.pt"], min_mb=1)
    if not models:
        return -1
    try:
        from ultralytics import YOLO
        pm = YOLO(models[0])
        pred = pm.predict(img_bgr, conf=0.25, verbose=False, device=dev)[0]
        n = 0 if pred.boxes is None else len(pred.boxes)
        del pm
        return n
    except Exception:
        return -1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--target", required=True, help="衣服 / 脸 / 背景 / 主体")
    ap.add_argument("--out", required=True)
    ap.add_argument("--sd-dir", default="")
    ap.add_argument("--sam", default="", help="指定 SAM 权重路径（留空自动找）")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"], help="检测/分割设备：auto=按剩余显存决定（默认，8G 卡上 SD 常驻时会走 CPU 保命）")
    ap.add_argument("--boxes", default="", help="可选：手工框 x1,y1,x2,y2[;x1,y1,x2,y2]（跳过 YOLO-World）")
    ap.add_argument("--box-threshold", type=float, default=0.03, help="检测阈值（YOLO-World 用低阈值才容易命中服饰词）")
    ap.add_argument("--max-side", type=int, default=2048, help="检测最长边（实测 1600 会漏检服饰，2048 才稳）")
    ap.add_argument("--dilate", type=int, default=8, help="蒙版外扩像素（接缝更自然）")
    ap.add_argument("--feather", type=int, default=4, help="羽化半径像素")
    ap.add_argument("--no-invert", action="store_true")
    ap.add_argument("--allow-silhouette", action="store_true", help="允许人物剪影兜底（默认关：会把身体一起重画）")
    ap.add_argument("--fill-sheer", action="store_true", help="衣服：大核闭运算补全薄纱/透视布料（有上限保护）")
    ap.add_argument("--sheer-scale", type=float, default=0.05, help="薄纱补全的闭运算半径系数（相对最长边）")
    ap.add_argument("--no-shoulder-guard", action="store_true", help="关闭「衣服不能落在肩线以上」约束（诊断用）")
    ap.add_argument("--grow", action="store_true", help="衣服：颜色一致性生长（默认关；守岸人那张实测会长进薄纱/浅色头发）")
    ap.add_argument("--sam-side", type=int, default=1024, help="SAM 在多大分辨率上分割（默认 1024，省显存；蒙版会放回原尺寸）")
    ap.add_argument("--points", default="", help="SAM 点提示（图像像素坐标）：x,y;x,y …；给了就跳过检测直接点选")
    ap.add_argument("--max-words", type=int, default=12, help="逐词检测最多试几个词（命中即停）")
    ap.add_argument("--max-boxes", type=int, default=3, help="最多收集几个词的检测框（衣服是多件套：连衣裙/袖套/兜帽各算一件，实测只收 2 个会漏掉袖套）")
    ap.add_argument("--vram-min-gb", type=float, default=3.0, help="SAM 上 cuda 前要求的最低剩余显存（实测 2.57G 剩余时 ViT-L 仍会 CUDA OOM）")
    ap.add_argument("--vram-cpu-gb", type=float, default=3.0, help="剩余显存低于这个值就直接改走 CPU 分割（ViT-L 慢但绝不会 OOM）")
    ap.add_argument("--vram-full-gb", type=float, default=4.5, help="剩余显存高于这个值才按 sam-side 全分辨率在 cuda 上分割，否则降到 640px")
    args = ap.parse_args()


    # 检测器设备：与 SAM 同一套显存判断。YOLO-World 的加载/首推同样会抢显存，实测就是它把进程崩掉的。
    DEV = pick_device(args)
    print(f"[抠图] 检测设备：{DEV}（剩余显存 {_free_vram_gb():.1f}G）", file=sys.stderr, flush=True)

    print("[抠图] 开始（加载检测模型约 10-20 秒，请稍候…）", file=sys.stderr, flush=True)
    result = {"ok": False, "engine": "", "boxes": 0, "coverage": 0.0,
              "mask": "", "labels": [], "notes": "", "persons": -1}
    notes = []

    try:
        import cv2
        import numpy as np
    except Exception as e:  # pragma: no cover
        result["notes"] = f"缺少 cv2/numpy：{e}"
        print(json.dumps(result, ensure_ascii=True))
        return 0

    if not os.path.isfile(args.image):
        result["notes"] = f"参考图不存在：{args.image}"
        print(json.dumps(result, ensure_ascii=True))
        return 0

    # Windows 中文/非 ASCII 路径：cv2.imread 直接失败（OpenCV 老限制）→ np.fromfile + imdecode

    print("[抠图] 读取参考图…", file=sys.stderr, flush=True)
    img_bgr = None
    try:
        buf = np.fromfile(args.image, dtype=np.uint8)
        img_bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    except Exception as e:
        result["notes"] = f"参考图读取异常：{type(e).__name__}"
    if img_bgr is None:
        try:
            img_bgr = cv2.imread(args.image, cv2.IMREAD_COLOR)
        except Exception:
            pass
    if img_bgr is None:
        result["notes"] = "参考图读不出来（路径含中文？格式不支持？）"
        print(json.dumps(result, ensure_ascii=True))
        return 0
    H, W = img_bgr.shape[:2]

    labels = TARGET_LABELS.get(args.target, ["person"])
    result["labels"] = labels

    # ---------- ① 检测框：手工框优先，其次 YOLO-World，最后退回 person 专用分割模型 ----------
    boxes = []
    pre_mask = None
    used_words = []
    if args.boxes.strip():
        for part in args.boxes.split(";"):
            vals = [float(v) for v in part.replace("，", ",").split(",") if v.strip()]
            if len(vals) == 4:
                boxes.append(vals)
        if boxes:
            result["engine"] = "手动框 + SAM"

    if not boxes:
        sd = args.sd_dir or ""
        roots = [p for p in [os.path.join(sd, ".cache", "huggingface") if sd else "",
                             os.path.join(sd, "models") if sd else "",
                             sd] if p]
        world_weights = find_file(roots, ["*world*.pt"], min_mb=1)
        if world_weights:
            try:

                print("[抠图] YOLO-World 文字提示检测中…", file=sys.stderr, flush=True)
                from ultralytics import YOLO
                scale = min(1.0, args.max_side / max(H, W))
                im = cv2.resize(img_bgr, None, fx=scale, fy=scale) if scale < 1 else img_bgr
                # 单词逐个试：YOLO-World 多词混喂会稀释分数（实测 15 词 0 命中、单词命中）
                for word in labels[: args.max_words]:
                    if len(boxes) >= max(1, args.max_boxes):
                        break
                    try:
                        m = YOLO(world_weights[0])     # 每个词新建实例：重复 set_classes 会触发 CUDA/CPU 设备错位
                        m.set_classes([word])
                        pred = m.predict(im, conf=args.box_threshold, verbose=False, device=DEV)[0]
                        got = 0
                        for b in pred.boxes:
                            x1, y1, x2, y2 = [float(v) / scale for v in b.xyxy[0].tolist()]
                            boxes.append([x1, y1, x2, y2])
                            got += 1
                        if got:
                            used_words.append(word)
                        del m
                    except Exception as e:
                        notes.append(f"词「{word}」检测异常：{type(e).__name__}")
                        continue
                if boxes:
                    result["engine"] = f"YOLO-World(词：{'/'.join(used_words)}) + SAM"
                    notes.append(f"命中 {len(boxes)} 框")
                else:
                    # 零命中先确认「图里有没有人」——见 _count_person 注释（用户 2026-10-16 实测：
                    # 传进来的是终端报错截图，零命中却被提示「换词」，误导用户反复试词）。
                    _nperson = _count_person(args.sd_dir or "", img_bgr, DEV)
                    result["persons"] = _nperson
                    if _nperson == 0:
                        notes.append(
                            f"这张图里没检测到人物（YOLO-World 试过 {len(labels[:args.max_words])} 个词全零命中；"
                            f"person 检测也是 0 人）→ 参考图可能不是人物图（是截图/风景/纯色块？）"
                            f"，换词不会有帮助，请改用「几何区域蒙版」或手绘蒙版"
                        )
                    elif _nperson > 0:
                        notes.append(
                            f"图里有 {_nperson} 人但 YOLO-World 试过 {labels[:args.max_words]} 都没命中"
                            f"（可能是画风/遮挡导致检测失败）→ 换词或用手工框/区域蒙版"
                        )
                    else:
                        notes.append(f"YOLO-World 试过 {labels[:args.max_words]} 都没命中；没抠出任何区域（换词或用手工框/区域蒙版）")
            except Exception as e:
                notes.append(f"YOLO-World 失败：{type(e).__name__}: {e}")
        else:
            notes.append("没找到 YOLO-World 权重（*.pt）")

    # 脸：YOLO-World 对 face 不稳定 → 用 adetailer 的专用人脸/YOLO 模型拿框
    if not boxes and args.target == "脸":
        sd = args.sd_dir or ""
        face_models = find_file([sd], ["face_yolov8*.pt", "*face*.pt"], min_mb=0.5)
        if face_models:
            try:
                from ultralytics import YOLO
                fm = YOLO(face_models[0])
                pred = fm.predict(img_bgr, conf=0.3, verbose=False, device=DEV)[0]
                for b in pred.boxes:
                    boxes.append([float(v) for v in b.xyxy[0].tolist()])
                if boxes:
                    notes.append(f"人脸专用模型命中 {len(boxes)} 框")
                del fm
            except Exception as e:
                notes.append(f"人脸模型失败：{type(e).__name__}")

    # 衣服/脸兜底：用「人物轮廓」定位（按这张图里人的实际形状，而不是固定矩形）
    if not boxes and args.target in SILHOUETTE_FALLBACK and args.allow_silhouette:
        sd = args.sd_dir or ""
        seg_models = find_file([sd], ["*person*yolov8*-seg.pt"], min_mb=1)
        person_mask = None
        if seg_models:
            try:
                from ultralytics import YOLO
                pm = YOLO(seg_models[0])
                pred = pm.predict(img_bgr, conf=0.25, verbose=False, device=DEV)[0]
                if pred.masks is not None and len(pred.masks.data):
                    person_mask = np.zeros((H, W), dtype=np.uint8)
                    for mm in pred.masks.data:
                        arr = (mm.cpu().numpy() > 0.5).astype(np.uint8) * 255
                        person_mask = np.maximum(person_mask, cv2.resize(arr, (W, H), interpolation=cv2.INTER_NEAREST))
                del pm
            except Exception as e:
                notes.append(f"人物轮廓兜底失败：{type(e).__name__}")
        if person_mask is not None and person_mask.max() > 0:
            # 直接用「人物轮廓 ∩ 躯干带」当蒙版：形状跟着这张图里人的实际剪影走（不固定矩形），
            # 也不再交给 SAM 二次分割——实测把轮廓框喂给 SAM 会只切出一小块（覆盖率 0.1%，等于没改）。
            ys, xs = np.where(person_mask > 127)
            top, bottom = int(ys.min()), int(ys.max())
            band = SILHOUETTE_FALLBACK[args.target]
            y1 = int(top + (bottom - top) * band[0])
            y2 = int(top + (bottom - top) * band[1])
            band_mask = np.zeros_like(person_mask)
            band_mask[max(0, y1):max(0, y2), :] = 255
            pre_mask = cv2.bitwise_and(person_mask, band_mask)
            notes.append(f"按人物轮廓兜底（取人物剪影 y {band[0]}-{band[1]} 区段）")
            result["engine"] = "person-seg 轮廓（跟随人物剪影）"

    # 衣服专用：YOLO-World 的 dress 框往往罩住整个人 → 直接 box-prompt 会把整个人重画（实测角色转身）。
    # 改成在该框的**下半部**取几个点做 SAM 点提示，然后**取最紧的那个掩膜**（衣服只是一块织物，不该是整个人）。
    garment_points = []
    if args.target == "衣服" and boxes:
        for bx in boxes:
            x1, y1, x2, y2 = bx
            cx = (x1 + x2) / 2.0
            bw = x2 - x1
            bh = y2 - y1
            for fy in (0.62, 0.78, 0.90):
                for fx in (0.5, 0.33, 0.67):
                    garment_points.append([[cx + (fx - 0.5) * bw, y1 + fy * bh]])
    # 人物框：衣服蒙版必须落在**肩线以下**（否则会把头发/头顶当成衣服 —— 实测「头发+披风」被整块涂红）
    person_box = None
    person_mask_for_points = None
    person_box = None
    if args.target == "衣服":
        seg_ms = find_file([args.sd_dir or ""], ["*person*yolov8*-seg.pt"], min_mb=1)
        if seg_ms:
            try:
                from ultralytics import YOLO
                pm_ = YOLO(seg_ms[0])
                pr_ = pm_.predict(img_bgr, conf=0.25, verbose=False, device=DEV)[0]
                if pr_.masks is not None and len(pr_.masks.data):
                    _pmask = np.zeros((H, W), dtype=np.uint8)
                    for _mm in pr_.masks.data:
                        _arr = (_mm.cpu().numpy() > 0.5).astype(np.uint8) * 255
                        _pmask = np.maximum(_pmask, cv2.resize(_arr, (W, H), interpolation=cv2.INTER_NEAREST))
                    # 用**检测框**（含头/头发）当基准：person-seg 的掩膜通常不含头发，
                    # 拿掩膜上沿当「人物上沿」会把正常衣服误判成「在头上」（实测两图被误杀）。
                    if pr_.boxes is not None and len(pr_.boxes):
                        _b = pr_.boxes.xyxy.cpu().numpy()
                        person_box = (int(_b[:, 1].min()), int(_b[:, 3].max()))
                    else:
                        _ys, _ = np.where(_pmask > 127)
                        if len(_ys):
                            person_box = (int(_ys.min()), int(_ys.max()))
                    person_mask_for_points = _pmask
                del pm_
            except Exception:
                pass


    # 脸禁区：衣服蒙版绝不许盖到脸（否则「换衣服」会顺手把脸重画 —— 实测多件合一曾把整张脸吞进去）。
    face_box = None
    if args.target == "衣服":
        _fm = find_file([args.sd_dir or ""], ["face_yolov8*.pt", "*face*.pt"], min_mb=0.5)
        if _fm:
            try:
                from ultralytics import YOLO
                _fmod = YOLO(_fm[0])
                _fp = _fmod.predict(img_bgr, conf=0.3, verbose=False, device=DEV)[0]
                if _fp.boxes is not None and len(_fp.boxes):
                    _fb = _fp.boxes.xyxy.cpu().numpy()
                    face_box = (float(_fb[:, 0].min()), float(_fb[:, 1].min()),
                                float(_fb[:, 2].max()), float(_fb[:, 3].max()))
                del _fmod
            except Exception:
                pass

    # 衣服：再补一路「人物剪影取点」——按人物轮廓逐行取中线，落在躯干/腿部，
    # 不依赖 YOLO 框（框不准时点会落到头发上，实测会把头发+披风当衣服）。
    if args.target == "衣服" and person_mask_for_points is not None:
        _ys4, _ = np.where(person_mask_for_points > 127)
        if len(_ys4):
            _top, _bot = int(_ys4.min()), int(_ys4.max())
            _h = max(1, _bot - _top)
            for _f in (0.30, 0.42, 0.55, 0.68, 0.80, 0.90):
                _y = min(H - 1, int(_top + _f * _h))
                _rowxs = np.where(person_mask_for_points[_y] > 127)[0]
                if len(_rowxs):
                    garment_points.append([[float(int(_rowxs.mean())), float(_y)]])

    if args.points.strip():
        pts = []
        for part in args.points.split(";"):
            vals = [float(v) for v in part.replace("，", ",").split(",") if v.strip()]
            if len(vals) == 2:
                pts.append(vals)
        if pts:
            garment_points = [pts]      # 手动点：只跑一次，不做「取最紧」筛选
    # ---------- ② 用 SAM 把框变成精细蒙版 ----------
    mask_full = np.zeros((H, W), dtype=np.uint8)
    sam_used = False
    sam_path = args.sam
    if not sam_path:
        sd = args.sd_dir or ""
        found = find_file([sd], ["sam_vit_l*.pth", "sam_vit_b*.pth", "sam_vit_h*.pth", "mobile_sam*.pt"], min_mb=50)
        sam_path = found[0] if found else ""
    if pre_mask is not None:
        mask_full = pre_mask
        sam_used = True   # 已由轮廓兜底给出蒙版，跳过 SAM
    elif sam_path and os.path.isfile(sam_path) and (boxes or garment_points):
        try:
            import torch
            from segment_anything import sam_model_registry, SamPredictor
            name = os.path.basename(sam_path).lower()
            if "vit_h" in name:
                kind = "vit_h"
            elif "vit_b" in name:
                kind = "vit_b"
            elif "vit_l" in name or "mobile" not in name:
                kind = "vit_l"
            else:
                kind = "vit_l"
            device = "cuda" if torch.cuda.is_available() else "cpu"
            # 显存自适应：A1111 常驻时这张 7.9G 卡的**剩余显存是漂的**。真机实测（2026-10-15 23:16）：
            # 同一个参考图、同一个命令，22:10 能抠出蒙版，23:16 就报
            # "CUDA out of memory ... 2.57 GiB free" → SAM 整段失败 → 换衣服/换背景拿不到蒙版。
            # 所以不再盲上 cuda：先读实际剩余显存，不够就降分辨率，再不够直接走 CPU。
            side_used = float(args.sam_side)
            if device == "cuda":
                try:
                    _free_b = torch.cuda.mem_get_info()[0]
                    _free_gb = _free_b / (1024.0 ** 3)
                    if _free_gb < args.vram_cpu_gb:
                        device = "cpu"
                        side_used = min(side_used, 768.0)
                        notes.append(f"显存只剩 {_free_gb:.1f}G → SAM 改走 CPU（实测 2.57G 剩余时 ViT-L 仍 CUDA OOM，宁可慢也不让蒙版整条失败）")
                    elif _free_gb < args.vram_full_gb:
                        side_used = min(side_used, 640.0)
                        notes.append(f"显存只剩 {_free_gb:.1f}G → SAM 降到 {int(side_used)}px（省显存）")
                    else:
                        try:
                            torch.cuda.empty_cache()
                        except Exception:
                            pass
                except Exception:
                    pass
            # 在缩小图上分割，掩膜再放回原尺寸：省显存（A1111 常驻时 7.9G 卡很容易 OOM），也快得多。
            # 蒙版最终会被插件缩放到出图尺寸，所以这里降分辨率不影响最终精度。
            work_scale = min(1.0, side_used / max(H, W))
            img_work = cv2.resize(img_bgr, None, fx=work_scale, fy=work_scale, interpolation=cv2.INTER_AREA) if work_scale < 1 else img_bgr
            sam = sam_model_registry[kind](checkpoint=sam_path).to(device)
            predictor = SamPredictor(sam)

            print("[抠图] SAM 分割中…", file=sys.stderr, flush=True)
            predictor.set_image(cv2.cvtColor(img_work, cv2.COLOR_BGR2RGB))
            def _back(m):
                a = (m.astype(np.uint8)) * 255
                if work_scale < 1:
                    a = cv2.resize(a, (W, H), interpolation=cv2.INTER_LINEAR)
                    a = ((a > 127).astype(np.uint8)) * 255
                return a
            def _sc(v):
                return v * work_scale
            if garment_points:
                # 衣服：**把全部候选点当成一次正样本**喂给 SAM（多点比单点稳），在它给的 3 张候选里
                # 挑「最紧但仍是织物级」的那张：
                #   太紧（<3%）= 只切到布片，改了等于没改；
                #   太松（>32%）= 整个人，重绘会把身体/姿势一起重画（实测角色直接转身）。
                # 绝不把所有点的掩膜并起来。候选顺序：只点 → 点+框 → 框内多点（应对贴身穿搭/紧身衣）。
                best = None
                best_cov = 9.9
                best_tag = ""
                parts = []          # 合格零件（每件 ≤18%、过肩线守卫）→ 最后并成整套
                cand_sets = [np.array(garment_points[0]) * work_scale]
                if boxes:
                    bx = boxes[0]
                    cand_sets.append(np.array([[bx[0] * work_scale, bx[1] * work_scale],
                                               [(bx[0] + bx[2]) / 2 * work_scale, (bx[1] + bx[3]) / 2 * work_scale]]))
                    cand_sets.append(np.array([[(bx[0] + bx[2]) / 2 * work_scale, (bx[1] + bx[3]) / 2 * work_scale]]))
                tries = []
                for ci, cs in enumerate(cand_sets):
                    tries.append((f"点集{ci + 1}", cs, None))
                if boxes:
                    tries.append(("点+框", cand_sets[0], boxes[0]))
                for tag, pts_w, box in tries:
                    for mm_out in (True, False):
                        try:
                            kw = {"point_coords": pts_w,
                                  "point_labels": np.ones(len(pts_w), dtype=int),
                                  "multimask_output": mm_out}
                            if box is not None:
                                x1, y1, x2, y2 = box
                                kw["box"] = np.array([x1 * work_scale, y1 * work_scale, x2 * work_scale, y2 * work_scale])
                            m, _, _ = predictor.predict(**kw)
                        except Exception:
                            continue
                        arrs = m if m.ndim == 3 else [m]
                        for cand in arrs:
                            cov = float((cand > 0).mean())
                            if not (0.02 <= cov <= 0.34):
                                continue
                            arr_full = _back(cand)
                            if face_box is not None:
                                _fx1, _fy1, _fx2, _fy2 = face_box
                                _pw2 = 0.06 * (_fx2 - _fx1); _ph2 = 0.06 * (_fy2 - _fy1)
                                _gx1 = max(0, int(_fx1 - _pw2)); _gy1 = max(0, int(_fy1 - _ph2))
                                _gx2 = min(W, int(_fx2 + _pw2)); _gy2 = min(H, int(_fy2 + _ph2))
                                _facepx = int((arr_full[_gy1:_gy2, _gx1:_gx2] > 127).sum())
                                _tot = int((arr_full > 127).sum()) or 1
                                if _facepx / float(_tot) > 0.08:
                                    continue      # 这块压到脸了，不是衣服
                            # 硬约束：衣服不可能在头顶 —— 蒙版上沿若高于「人物上沿 + 8% 身高」就丢掉
                            # 硬约束：衣服不可能长在头顶 —— 但**肩线附近的部件是合法的**。
                            # 2026-10-16 修（用户反馈：换完衣服还挂着半截袖子）：旧判据是「上沿不得高于
                            # 人物上沿 + 8% 身高」，而**袖套/兜帽/披风**正好卡在这条线上 → 整块被丢，
                            # 蒙版只剩连衣裙本体，袖子留在身上。改成「不得高于下巴」（有脸框就用脸框底边，
                            # 没有才退回旧判据），既挡住头/头发，也放行肩部服饰。
                            if person_box is not None and not args.no_shoulder_guard:
                                _m = cv2.resize(arr_full, (W, H), interpolation=cv2.INTER_NEAREST)
                                _ys3, _ = np.where(_m > 127)
                                if len(_ys3):
                                    # 4%（原来 8%）＝ 把「肩线附近」的袖套/披风放行；头发/头饰从人物上沿
                                    # 就开始（0-3%），所以 4% 仍然挡得住 —— 再加下面那道脸部重叠 ≤8% 双保险。
                                    top_limit = person_box[0] + 0.04 * (person_box[1] - person_box[0])
                                    if float(_ys3.min()) < top_limit:
                                        continue
                            if cov <= 0.18 and all(float((p > 127).mean()) != cov or True for p in parts):
                                parts.append(arr_full)
                            if cov < best_cov:
                                best_cov = cov
                                best = arr_full
                                best_tag = tag + ("（多候选）" if mm_out else "")
                if best is not None:
                    mask_full = best
                    notes.append(f"衣服：{best_tag} 挑出织物级掩膜（覆盖 {best_cov:.1%}）")
                    # 多件合一：把各合格零件并起来（水手服=衬衫+裙+领结、大衣=大衣+围巾）。
                    # 只有在并集不超 30% 时才采用 —— 超了就退回单件，避免把身体一起吞进来。
                    if len(parts) >= 2:
                        _u = np.zeros_like(best)
                        for _p in parts:
                            _u = np.maximum(_u, _p)
                        _uc = float((_u > 127).mean())
                        if 0.02 <= _uc <= 0.30 and _uc > float((best > 127).mean()) * 1.08:
                            mask_full = _u
                            notes.append(f"多件合一：{len(parts)} 件 → 并集覆盖 {_uc:.1%}")
                else:
                    notes.append("衣服：点提示没给出织物级掩膜（要么过小、要么罩住整个人）→ 请改用 box: 精确框或蒙版图")
            else:
                for bx in boxes:
                    x1, y1, x2, y2 = bx
                    m, _, _ = predictor.predict(box=np.array([x1 * work_scale, y1 * work_scale, x2 * work_scale, y2 * work_scale]), multimask_output=False)
                    mask_full = np.maximum(mask_full, _back(m[0] if m.ndim == 3 else m))
            sam_used = True
            notes.append(f"SAM({kind}) 分割完成")
            del sam
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
        except Exception as e:
            notes.append(f"SAM 失败：{type(e).__name__}: {e}")
            # SAM 挂掉绝不能把「换衣服 / 换背景」整条路径废掉（实测：这里一失败，
            # PowerShell 侧就报「没抠出任何区域」→ 用户看到的是「蒙版没生效」）。
            # 兜底分两层，尽量别退成「一个长方形罩住整个人」：
            #   ① 先补一次人物剪影（有剪影就与框相交，蒙版不出人体）；
            #   ② 若粗蒙版纵向吞掉了整个人（含头/脚），按躯干带裁一刀 —— 换衣服只该动躯干那一段。
            if boxes:
                if person_mask_for_points is None:
                    try:
                        _seg2 = find_file([args.sd_dir or ""], ["*person*yolov8*-seg.pt"], min_mb=1)
                        if _seg2:
                            from ultralytics import YOLO as _YOLO2
                            _pm2 = _YOLO2(_seg2[0])
                            _pr2 = _pm2.predict(img_bgr, conf=0.25, verbose=False, device=DEV)[0]
                            if _pr2.masks is not None:
                                _acc = np.zeros((H, W), dtype=np.uint8)
                                for _mm in _pr2.masks.data:
                                    _arr = (_mm.cpu().numpy() > 0.5).astype(np.uint8) * 255
                                    _acc = np.maximum(_acc, cv2.resize(_arr, (W, H), interpolation=cv2.INTER_NEAREST))
                                if _acc.max() > 0:
                                    person_mask_for_points = _acc
                                    _ysp, _ = np.where(_acc > 127)
                                    if len(_ysp):
                                        person_box = (int(_ysp.min()), int(_ysp.max()))
                                    notes.append("兜底：已补人物剪影用于裁边")
                            del _pm2
                    except Exception:
                        pass
                for bx in boxes:
                    try:
                        _x1, _y1, _x2, _y2 = [int(round(float(v))) for v in bx[:4]]
                    except Exception:
                        continue
                    _x1 = max(0, min(W - 4, _x1)); _y1 = max(0, min(H - 4, _y1))
                    _x2 = max(_x1 + 4, min(W, _x2)); _y2 = max(_y1 + 4, min(H, _y2))
                    mask_full[_y1:_y2, _x1:_x2] = 255
                if person_mask_for_points is not None:
                    mask_full = cv2.bitwise_and(mask_full, person_mask_for_points)
                if (args.target == "衣服" and person_box is not None and mask_full.max() > 0):
                    _t, _b = person_box
                    _hh = max(1, _b - _t)
                    _lim0 = int(_t + 0.08 * _hh)      # 肩线以上不留（那是头/头发）
                    _lim1 = int(_t + 0.82 * _hh)      # 小腿以下不留（换衣服不动脚）
                    _band = np.zeros((H, W), dtype=np.uint8)
                    _band[max(0, _lim0):min(H, _lim1), :] = 255
                    _clipped = cv2.bitwise_and(mask_full, _band)
                    if _clipped.max() > 0 and float((_clipped > 127).mean()) < float((mask_full > 127).mean()):
                        notes.append(f"粗蒙版裁到躯干带（{float((mask_full > 127).mean()):.1%} → {float((_clipped > 127).mean()):.1%}），避免整个人被重画")
                        mask_full = _clipped
                if mask_full.max() > 0:
                    sam_used = True
                    notes.append(f"已用 {len(boxes)} 个检测框生成粗蒙版兜底（非精细分割，边缘是直的）")

    # SAM 不可用时：退回 person 专用分割模型（只对「人」有效，用于背景/主体）
    if not sam_used:
        sd = args.sd_dir or ""
        seg_models = find_file([sd], ["*person*yolov8*-seg.pt", "*yolov8*-seg.pt"], min_mb=1)
        if seg_models and args.target in ("背景", "主体"):
            try:
                from ultralytics import YOLO
                m = YOLO(seg_models[0])
                pred = m.predict(img_bgr, conf=args.box_threshold, verbose=False, device=DEV)[0]
                if pred.masks is not None:
                    for mm in pred.masks.data:
                        arr = (mm.cpu().numpy() > 0.5).astype(np.uint8) * 255
                        arr = cv2.resize(arr, (W, H), interpolation=cv2.INTER_NEAREST)
                        mask_full = np.maximum(mask_full, arr)
                    sam_used = True
                    result["engine"] = result["engine"] or "person-seg(YOLOv8) 兜底"
                    notes.append("改用 person 专用分割模型")
            except Exception as e:
                notes.append(f"person 分割兜底失败：{type(e).__name__}: {e}")

    if mask_full.max() == 0:
        result["notes"] = "；".join(notes + ["没抠出任何区域（换词或用手工框/区域蒙版）"])
        print(json.dumps(result, ensure_ascii=True))
        return 0

    # ---------- ③ 后处理：闭运算补洞 → 膨胀 → 羽化 ----------
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    mask_full = cv2.morphologyEx(mask_full, cv2.MORPH_CLOSE, k)

    print("[抠图] 后处理（桥接/扣脸/薄纱/羽化）…", file=sys.stderr, flush=True)
    # 行内连通桥接：同一件衣服常被 SAM 拆成几块（水手服只抠到领结、大衣只抠到一节围巾）。
    # 做法：逐行取蒙版的最左/最右，若这一段的宽度不超过「该行人物宽度」的 70%，就把这段填满。
    # 只在人物剪影内填，且总覆盖不得超 32%（超了退回原蒙版）——不会吞掉整幅或背景。
    try:
        if args.target == "衣服" and (mask_full > 127).any():
            _before = float((mask_full > 127).mean())
            _bridged = mask_full.copy()
            _rows = np.where((mask_full > 127).any(axis=1))[0]
            if len(_rows):
                _r0, _r1 = int(_rows.min()), int(_rows.max())
                for _y in range(_r0, _r1 + 1):
                    _xs = np.where(mask_full[_y] > 127)[0]
                    if len(_xs) < 2:
                        continue
                    _xl, _xr = int(_xs.min()), int(_xs.max())
                    _span = _xr - _xl + 1
                    if person_mask_for_points is not None:
                        _pxs = np.where(person_mask_for_points[_y] > 127)[0]
                        if len(_pxs) == 0:
                            continue
                        _pw = int(_pxs.max()) - int(_pxs.min()) + 1
                        if _span > 0.70 * _pw:
                            continue
                    else:
                        if _span > 0.70 * W:
                            continue
                    _bridged[_y, _xl:_xr + 1] = 255
            _after = float((_bridged > 127).mean())
            if _after <= 0.32 and (_after > _before or _after < 0.32):
                if abs(_after - _before) > 1e-6:
                    mask_full = _bridged
                    notes.append(f"行内连通桥接：{_before:.1%} → {_after:.1%}")
            else:
                notes.append(f"桥接后过大（{_after:.1%}）→ 保持原蒙版")
    except Exception:
        pass

    # 颜色一致性生长：SAM 常只切到衣服的一小块布片（<6%）。用 LAB 颜色距离把**与这块同色、
    # 且与之连通**的区域并进来 —— 同一件衣服颜色一致，皮肤/头发/背景颜色不同，所以不会越界。
    # 有上限：生长后不得超 32%，且至少长出 1.5 倍才采用。
    try:
        _cov0 = float((mask_full > 127).mean())
        if args.grow and args.target == "衣服" and 0 < _cov0 < 0.06:
            _lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
            _ys5, _xs5 = np.where(mask_full > 127)
            if len(_ys5):
                _mean = _lab[_ys5, _xs5].mean(axis=0)
                _dist = np.linalg.norm(_lab - _mean, axis=2)
                _similar = (_dist < 30).astype(np.uint8) * 255
                _n, _labels = cv2.connectedComponents(_similar, connectivity=8)
                _keep = [int(v) for v in np.unique(_labels[mask_full > 127]) if v != 0]
                if _keep:
                    _grown = np.isin(_labels, _keep).astype(np.uint8) * 255
                    if person_mask_for_points is not None:
                        _grown = cv2.bitwise_and(_grown, person_mask_for_points)
                    _cov1 = float((_grown > 127).mean())
                    if _cov1 >= _cov0 * 1.5 and _cov1 <= 0.32:
                        mask_full = _grown
                        notes.append(f"颜色一致性生长：{_cov0:.1%} → {_cov1:.1%}")
                    else:
                        notes.append(f"颜色生长幅度不合适（{_cov0:.1%} → {_cov1:.1%}）→ 保持原蒙版")
    except Exception:
        pass

    # 脸禁区兜底：无论前面怎么合并，最终把脸从蒙版里减掉（衣领贴着下巴也不会碰脸）。
    if face_box is not None:
        try:
            _fx1, _fy1, _fx2, _fy2 = face_box
            _pw3 = 0.06 * (_fx2 - _fx1); _ph3 = 0.06 * (_fy2 - _fy1)
            _gx1b = max(0, int(_fx1 - _pw3)); _gy1b = max(0, int(_fy1 - _ph3))
            _gx2b = min(W, int(_fx2 + _pw3)); _gy2b = min(H, int(_fy2 + _ph3))
            _bf = float((mask_full > 127).mean())
            _tmp2 = mask_full.copy()
            _tmp2[_gy1b:_gy2b, _gx1b:_gx2b] = 0
            _af = float((_tmp2 > 127).mean())
            if _af > 0.005:
                mask_full = _tmp2
                notes.append(f"已扣除脸区（{_bf:.1%} → {_af:.1%}）")
        except Exception:
            pass

    # 连通块筛选：去掉蝴蝶/花点等误检碎块（碎块会让无关区域被重画），但**衣服不能只留最大那块** ——
    # 真机实测（2026-10-15 23:10 那轮）：一件连衣裙被 SAM 拆成 7 块，旧逻辑只留最大的一块，
    # 袖子那一侧与裙摆整个没进蒙版；人工审阅叠加图看到的就是「裙子边缘一圈没被罩住」，
    # 出图自然就「衣服没换干净 + 残留碎片」。衣服改成按「面积比例 + 总覆盖上限」保留同件的多块。
    try:
        n_lab, labels, stats, _ = cv2.connectedComponentsWithStats((mask_full > 127).astype(np.uint8), connectivity=8)
        if n_lab > 2:
            areas = stats[1:, cv2.CC_STAT_AREA].astype(np.float64)
            order = np.argsort(-areas)
            if args.target == "衣服":
                top = float(areas[order[0]])
                keep_ids = []
                cum = 0.0
                limit = 0.32 * H * W
                for idx in order:
                    a = float(areas[idx])
                    if keep_ids and a < max(0.002 * H * W, 0.18 * top):
                        continue                      # 小碎块（蝴蝶/花点）：丢掉
                    if keep_ids and cum + a > limit:
                        continue                      # 总覆盖上限：别把身体一起罩进去
                    keep_ids.append(int(idx) + 1)
                    cum += a
                mask_full = np.where(np.isin(labels, keep_ids), 255, 0).astype(np.uint8)
                _area_txt = ",".join(f"{100.0 * a / (H * W):.2f}%" for a in areas[order[:8]])
                notes.append(f"衣服：保留 {len(keep_ids)}/{n_lab - 1} 块（合并同一件衣服的分散部件，总覆盖 {cum / (H * W):.1%}；各块面积 {_area_txt}）")
            else:
                keep = 1 + int(np.argmax(areas))
                mask_full = np.where(labels == keep, 255, 0).astype(np.uint8)
                notes.append(f"已只留最大连通块（原 {n_lab - 1} 块）")
    except Exception:
        pass
    if args.dilate > 0:
        k2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (args.dilate * 2 + 1, args.dilate * 2 + 1))
        mask_full = cv2.dilate(mask_full, k2)
    # 衣服可选：补全薄纱/透视布料（SAM 对半透明布料常判成非衣服）。用**大核闭运算**桥接细缝——
    # 不要用凸包：裙子是斜跨人体的轮廓，凸包会把 90% 画面都罩进去（实测直接废掉）。
    # 带双重上限保护：变大超过 2.2 倍、或超过画面 22%，就保持原蒙版不动。
    if args.fill_sheer and args.target == "衣服":
        try:
            r = max(10, int(args.sheer_scale * max(H, W)))
            kk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r * 2 + 1, r * 2 + 1))
            before = float((mask_full > 127).mean())
            closed = cv2.morphologyEx(mask_full, cv2.MORPH_CLOSE, kk)
            after = float((closed > 127).mean())
            if after <= min(0.30, max(0.20, before * 1.8)):
                mask_full = closed
                notes.append(f"已补全薄纱区（{before:.1%} → {after:.1%}）")
            else:
                notes.append(f"薄纱补全会过大（{before:.1%} → {after:.1%}）→ 保持原蒙版")
        except Exception:
            pass

    if args.target in INVERT_TARGETS and not args.no_invert:
        mask_full = cv2.bitwise_not(mask_full)
        notes.append("背景目标：已取反（人以外的区域）")
    if args.feather > 0:
        mask_full = cv2.GaussianBlur(mask_full, (args.feather * 2 + 1, args.feather * 2 + 1), 0)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    _write_png(args.out, mask_full)
    # 蒙版叠加预览：把重绘区半透明染色盖回原图（验收蒙版准不准就看这张，不用靠生成结果猜）。
    try:
        overlay = img_bgr.copy()
        m3 = (mask_full > 127)
        tint = np.zeros_like(img_bgr)
        tint[:, :, 2] = 255          # BGR：红
        overlay[m3] = (0.45 * tint[m3] + 0.55 * overlay[m3]).astype(np.uint8)
        edge = cv2.morphologyEx((m3.astype(np.uint8)) * 255, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
        overlay[edge > 0] = (255, 255, 255)
        ov_path = os.path.splitext(os.path.abspath(args.out))[0] + "_overlay.png"
        _write_png(ov_path, overlay)
        result["overlay"] = ov_path
    except Exception as e:
        notes.append(f"叠加预览生成失败：{type(e).__name__}")
    # 重绘区包围盒（便于判断「是不是又罩住整张图了」）
    try:
        ys, xs = np.where(mask_full > 127)
        if len(ys):
            result["bbox"] = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
            result["bbox_ratio"] = round(float((xs.max() - xs.min()) * (ys.max() - ys.min()) / (H * W)), 3)
    except Exception:
        pass
    result["ok"] = True
    result["mask"] = os.path.abspath(args.out)
    result["boxes"] = len(boxes)
    result["coverage"] = round(float((mask_full > 127).mean()), 4)
    result["notes"] = "；".join(notes)
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # 兜底：绝不让辅助脚本把主流程带崩
        print(json.dumps({"ok": False, "engine": "", "boxes": 0, "coverage": 0.0,
                          "mask": "", "labels": [], "notes": f"内部错误：{type(exc).__name__}: {exc}"},
                         ensure_ascii=False))
        sys.exit(0)
