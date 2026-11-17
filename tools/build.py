#!/usr/bin/env python3
"""
构建索引数据并打包为单文件 index.html。

输入 : raw/collected.json  (collect.py 产出)
       data/manual.json    (人工维护覆盖层, 原样内嵌, 由页面在运行时合并)
       web/template.html / web/styles.css / web/app.js
输出 : data/index.json      (结构化数据, 便于检查)
       index.html           (自包含交付物, 可直接双击打开)
"""
import datetime
import difflib
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw", "collected.json")
MANUAL = os.path.join(ROOT, "data", "manual.json")
WEB = os.path.join(ROOT, "web")

CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7,
          "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12, "十三": 13,
          "十四": 14, "十五": 15, "十六": 16, "十七": 17, "十八": 18,
          "十九": 19, "二十": 20}

PALETTE = ["#c9a227", "#5b9cf8", "#7fbf7f", "#c98bdb", "#e0895b", "#56c7c1",
           "#a8b3c4", "#d97b93", "#8fa4e0", "#b0a24a", "#6fb3a0", "#cf8f6a"]


def cn_to_int(s):
    s = s.strip()
    if s.isdigit():
        return int(s)
    return CN_NUM.get(s)


def clean_tag_label(title):
    return re.split(r"｜|\|", title)[0].strip(" 　-—·")


def title_base(title):
    t = re.split(r"\s*[｜|]\s*", title)[0]
    t = re.sub(r"[\[（(【]\s*[上下]\s*[\]）)】]", "", t)
    t = re.sub(r"[（(]\s*第\s*[一二三四五六七八九十百\d]+\s*[集讲期][)）]", "", t)
    t = re.sub(r"\bDay\s*\d+\b", "", t)
    return t.strip(" 　-—·：:")


EP_RE = re.compile(r"[（(]\s*第\s*([一二三四五六七八九十百\d]+)\s*[集讲期]\s*[)）]")
UD_RE = re.compile(r"[\[（(【]\s*([上下])\s*[\]）)】]")
DAY_RE = re.compile(r"\bDay\s*(\d+)\b")
SERIES_RE = re.compile(r"^(.{2,28}?系列(?:视频)?)\s*[-－—]\s*")


def _norm_name(s):
    return re.sub(r"[\s　·・,，.。:：!！?？\-—_/()（）\[\]【】]", "", s).lower()


def detect_series(videos):
    """返回 [{vid, kind, name, order, ordered}]，kind 用于区分集数制 / 上下集 / 具名系列。"""
    out = []
    for v in videos:
        t = v["title"]
        m = EP_RE.search(t)
        if m:
            n = cn_to_int(m.group(1))
            parts = re.split(r"\s+[-－—]\s+", t)
            name = parts[-1] if len(parts) > 1 else title_base(t)
            name = re.sub(r"[（(]\s*第\s*[^)）]*[)）]", "", name).strip()
            if n:
                out.append({"vid": v["id"], "kind": "ep", "name": name, "order": n, "ordered": True})
                continue
        m = DAY_RE.search(t)
        if m:
            tag = re.search(r"【([^】]+)】", t)
            name = tag.group(1).strip() if tag else "Day 系列"
            out.append({"vid": v["id"], "kind": "day", "name": name, "order": int(m.group(1)), "ordered": True})
            continue
        m = UD_RE.search(t)
        if m:
            base = title_base(t)
            out.append({"vid": v["id"], "kind": "ud", "name": base,
                        "order": 1 if m.group(1) == "上" else 2, "ordered": True})
            continue
        m = SERIES_RE.match(t)
        if m:
            out.append({"vid": v["id"], "kind": "sr", "name": m.group(1).strip(), "order": 0, "ordered": False})
    return out


AMBIG = ["承接", "之前的内容", "上一期", "上期", "前面提到", "前几期"]

YT_ID_RE = re.compile(r"(?:youtube\.com/(?:watch\?[^\s)]*?v=|shorts/|embed/)|youtu\.be/)([\w-]{11})")
HEADER_RE = re.compile(r"^\s*([^\s].{0,42}?)[：:]\s*$")


def _is_template_header(h):
    """频道把同一份「其他视频」清单贴在多数简介里，属于模板，不是引用。"""
    if "✳️" in h:
        return True
    return ("其他" in h and "视频" in h)


def extract_description_refs(videos):
    """
    按小节语义解析简介里的频道内链接：
      · 「✏️ 推荐的本频道其他资料和视频」「系列视频链接」「相关视频链接」= 作者主动给出的引用
      · 「✳️ 其他期权视频 / 其他定量视频」= 逐期复制的模板清单, 排除
    返回 {vid: [{to, label}]}
    """
    by_id = {v["id"]: v for v in videos}
    occ = {}
    raw = {}
    for v in videos:
        section = ""
        for ln in (v["description"] or "").splitlines():
            s = ln.strip()
            if not s:
                continue
            m = HEADER_RE.match(s)
            if m:
                section = m.group(1)
                if _is_template_header(section) or "风险声明" in section:
                    section = "__skip__"
                continue
            if s.startswith("⚠️") or "风险声明" in s or s.startswith("PowerUpGammas 旨在"):
                section = "__skip__"
                continue
            ids = [i for i in YT_ID_RE.findall(s) if i in by_id and i != v["id"]]
            if not ids:
                continue
            if section == "__skip__":
                continue
            label = YT_ID_RE.sub("", s).strip(" 　·-—●*👉")
            for i in ids:
                occ[i] = occ.get(i, 0) + 1
                raw.setdefault(v["id"], {})[i] = label[:80]
    # 双保险：出现在 60 篇以上简介里的目标仍视为模板
    out = {}
    for vid, m in raw.items():
        out[vid] = [{"to": t, "label": lb} for t, lb in m.items() if occ.get(t, 0) < 60]
    return out



def pending_mentions(videos, covered):
    """
    简介正文里含糊提及本频道内容、但无法指向具体视频 -> 待人工确认。
    已在简介链接块里给出目标的视频不再重复提示。
    """
    out = []
    for v in videos:
        d = v["description"] or ""
        if not d.strip() or v["id"] in covered:
            continue
        lines = []
        for ln in d.splitlines():
            if re.search(r"https?://|powerupgammas|teachable|bit\.ly", ln, re.I):
                continue
            if re.match(r"^\s*[✅🔴📗📈✳️⚠️]", ln):
                continue
            lines.append(ln)
        body = " ".join(lines)
        for kw in AMBIG:
            if kw in v["title"]:
                continue
            i = body.find(kw)
            if i < 0:
                continue
            snippet = body[max(0, i - 45): i + 55].strip()
            out.append({
                "videoId": v["id"],
                "phrase": kw,
                "evidence": ("…" + snippet + "…") if snippet else kw,
            })
            break
    return out


def main():
    col = json.load(open(RAW))
    manual = json.load(open(MANUAL)) if os.path.exists(MANUAL) else {}
    videos = col["videos"]
    playlists = col["playlists"]

    videos.sort(key=lambda v: (v["date"] or "", v["id"]), reverse=True)
    idx = {v["id"]: i + 1 for i, v in enumerate(videos)}

    # 播放列表 -> 标签
    tags = []
    for i, p in enumerate(playlists):
        tags.append({"id": p["id"], "label": clean_tag_label(p["title"]),
                     "full": p["title"], "color": PALETTE[i % len(PALETTE)],
                     "source": "playlist"})
    for td in manual.get("tagDefs", []):
        tags.append({"id": td["id"], "label": td["label"], "full": td.get("note", ""),
                     "color": td.get("color") or PALETTE[len(tags) % len(PALETTE)],
                     "source": "manual"})
    tags.append({"id": "unfiled", "label": "未归类", "full": "未收录进任何播放列表",
                 "color": "#5a626e", "source": "system"})

    pl_of = {}
    for p in playlists:
        for vid in p["video_ids"]:
            pl_of.setdefault(vid, []).append(p["id"])

    # 系列关联：先按 (kind, 归一化名称) 分组，再合并名称高度相似的分组（标题里的错字/简写）
    det = detect_series(videos)
    groups = {}
    for d in det:
        groups.setdefault((d["kind"], _norm_name(d["name"])), {
            "name": d["name"], "ordered": d["ordered"], "items": []})["items"].append(
            (d["vid"], d["order"]))
    keys = list(groups.keys())
    for i, ka in enumerate(keys):
        for kb in keys[i + 1:]:
            if ka not in groups or kb not in groups or ka[0] != kb[0] or ka[0] == "sr":
                continue
            if difflib.SequenceMatcher(None, ka[1], kb[1]).ratio() >= 0.86:
                keep, drop = (ka, kb) if len(groups[ka]["name"]) >= len(groups[kb]["name"]) else (kb, ka)
                groups[keep]["items"] += groups[drop]["items"]
                if len(groups[drop]["name"]) > len(groups[keep]["name"]):
                    groups[keep]["name"] = groups[drop]["name"]
                del groups[drop]

    auto_refs = {v["id"]: [] for v in videos}
    date_of = {v["id"]: v["date"] for v in videos}
    for g in groups.values():
        if len(g["items"]) < 2:
            continue
        if g["ordered"]:
            items = sorted(g["items"], key=lambda x: (x[1], date_of[x[0]]))
        else:
            items = sorted(g["items"], key=lambda x: (date_of[x[0]], x[0]))
        for (prev, _), (cur, _) in zip(items, items[1:]):
            auto_refs[cur].append({"to": prev, "type": "series", "series": g["name"]})
        for vid, _ in items:
            next(v for v in videos if v["id"] == vid)["series"] = g["name"]

    # 简介中的显式引用（优先于系列推断，同一目标以 mention 为准）
    desc_refs = extract_description_refs(videos)
    for vid, lst in desc_refs.items():
        for r in lst:
            hit = next((x for x in auto_refs[vid] if x["to"] == r["to"]), None)
            if hit:
                hit["type"] = "mention"
                hit["label"] = r["label"]
                hit.pop("series", None)
            else:
                auto_refs[vid].append({"to": r["to"], "type": "mention", "label": r["label"]})

    payload = {
        "channel": {"name": col["channel"], "id": col["channel_id"],
                    "url": "https://www.youtube.com/@PowerUpGammas"},
        "generatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "total": len(videos),
        "videos": [{
            "n": idx[v["id"]],
            "id": v["id"],
            "title": v["title"],
            "date": v["date"],
            "length": v["length"],
            "autoTags": list(pl_of.get(v["id"], [])),
            "autoRefs": sorted([{"to": r["to"], "n": idx[r["to"]], "type": r["type"],
                                 **({"series": r["series"]} if r.get("series") else {}),
                                 **({"label": r["label"]} if r.get("label") else {})}
                                for r in auto_refs[v["id"]]], key=lambda x: x["n"]),
            **({"series": v["series"]} if v.get("series") else {}),
        } for v in videos],
        "tags": tags,
        "pending": pending_mentions(videos, set(desc_refs)),
    }
    # 只有数据真的变了才更新时间戳，保证重复构建不产生空提交
    out_path = os.path.join(ROOT, "data", "index.json")
    if os.path.exists(out_path):
        try:
            prev = json.load(open(out_path))
            same = ({k: v for k, v in prev.items() if k != "generatedAt"} ==
                    {k: v for k, v in payload.items() if k != "generatedAt"})
            if same:
                payload["generatedAt"] = prev.get("generatedAt", payload["generatedAt"])
        except Exception:
            pass
    json.dump(payload, open(out_path, "w"), ensure_ascii=False, indent=1)

    tpl = open(os.path.join(WEB, "template.html")).read()
    css = open(os.path.join(WEB, "styles.css")).read()
    note = open(os.path.join(WEB, "note.js")).read()
    js = open(os.path.join(WEB, "app.js")).read()
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    man = json.dumps(manual, ensure_ascii=False, separators=(",", ":"))

    # 同一套源码构建两个页面：公开版 / 开发版
    built = []
    for mode, fname in (("public", "index.html"), ("dev", "dev.html")):
        data_js = ('window.__MODE__ = "%s";\nwindow.__DATA__ = %s;\nwindow.__MANUAL__ = %s;'
                   % (mode, data, man))
        html = (tpl.replace("/*__CSS__*/", css)
                   .replace("//__DATA__", data_js)
                   .replace("//__NOTE__", note)
                   .replace("//__JS__", js))
        open(os.path.join(ROOT, fname), "w").write(html)
        built.append((fname, len(html) // 1024))

    edges = sum(len(v) for v in auto_refs.values())
    print(f"视频 {len(videos)} | 标签 {len(tags)} | 系列边 {edges} | 待确认 {len(payload['pending'])}")
    print("  " + "  ".join(f"{f} {kb}KB" for f, kb in built))


if __name__ == "__main__":
    main()
