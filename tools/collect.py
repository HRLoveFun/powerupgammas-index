#!/usr/bin/env python3
"""
采集 PowerUpGammas 频道数据。

数据源核实结论（2026-11):
  1. yt-dlp 提取 /videos 与 /playlists 标签页可用 (--flat-playlist)。
  2. 单个 watch 页面在默认 UA 下被 "Sign in to confirm you're not a bot" 拦截,
     但使用爬虫类 UA (facebookexternalhit / Googlebot) 可拿到含 videoDetails 的
     HTML, 从中解析 ytInitialPlayerResponse, 得到精确 uploadDate / 简介 / 时长。
  3. 该路径下 captions 为空且 playabilityStatus=UNPLAYABLE, 字幕不可得。
"""
import json
import os
import re
import subprocess
import sys
import time
import concurrent.futures as cf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
CACHE = os.path.join(RAW, "videos")
CHANNEL = "https://www.youtube.com/@PowerUpGammas"
CHANNEL_ID = "UCTb0BeBF6L7l2JsebTauH0Q"
CRAWLER_UA = "facebookexternalhit/1.1 (compatible; index-builder)"

os.makedirs(CACHE, exist_ok=True)


def ytdlp_json(url, extra=None):
    cmd = [sys.executable, "-m", "yt_dlp", "--flat-playlist", "--dump-single-json",
           "--skip-download", "--no-warnings", url]
    if extra:
        cmd += extra
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-500:])
    return json.loads(r.stdout)


def curl(url, tries=3):
    for i in range(tries):
        r = subprocess.run(["curl", "-s", "--compressed", "-A", CRAWLER_UA,
                            "--max-time", "30", url], capture_output=True, text=True)
        if r.returncode == 0 and len(r.stdout) > 2000:
            return r.stdout
        time.sleep(1.5 * (i + 1))
    return ""


PLAYER_RE = re.compile(r"var ytInitialPlayerResponse = (\{.*?\});</script>", re.S)


def fetch_video(vid):
    path = os.path.join(CACHE, vid + ".json")
    if os.path.exists(path):
        try:
            with open(path) as f:
                d = json.load(f)
            if d.get("_ok"):
                return d
        except Exception:
            pass
    html = curl(f"https://www.youtube.com/watch?v={vid}")
    rec = {"id": vid, "_ok": False}
    m = PLAYER_RE.search(html)
    if m:
        try:
            pr = json.loads(m.group(1))
        except Exception:
            pr = {}
        vd = pr.get("videoDetails") or {}
        mf = ((pr.get("microformat") or {}).get("playerMicroformatRenderer") or {})
        if vd.get("videoId"):
            rec.update({
                "_ok": True,
                "title": vd.get("title"),
                "description": vd.get("shortDescription") or "",
                "length": int(vd.get("lengthSeconds") or 0),
                "publish_date": (mf.get("publishDate") or mf.get("uploadDate") or "")[:10],
                "keywords": vd.get("keywords") or [],
                "view_count": vd.get("viewCount"),
                "is_unlisted": bool(mf.get("isUnlisted")),
                "category": mf.get("category"),
            })
    with open(path, "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    return rec


def main():
    print("[1/3] 频道视频列表")
    ch = ytdlp_json(CHANNEL + "/videos")
    entries = ch.get("entries") or []
    print(f"      {len(entries)} 条")

    print("[2/3] 播放列表")
    pls = ytdlp_json(CHANNEL + "/playlists").get("entries") or []
    playlists = []
    for p in pls:
        f = os.path.join(RAW, "playlists", p["id"] + ".json")
        if os.path.exists(f):
            d = json.load(open(f))
        else:
            d = ytdlp_json(p["url"])
            os.makedirs(os.path.dirname(f), exist_ok=True)
            json.dump(d, open(f, "w"), ensure_ascii=False)
        playlists.append({
            "id": p["id"],
            "title": d.get("title") or p.get("title"),
            "description": (d.get("description") or "").strip(),
            "video_ids": [e["id"] for e in (d.get("entries") or []) if e.get("id")],
        })
        print(f"      {p['id']} n={len(playlists[-1]['video_ids'])} {playlists[-1]['title']}")

    print("[3/3] 逐条视频元数据")
    ids = [e["id"] for e in entries]
    todo = [v for v in ids if not os.path.exists(os.path.join(CACHE, v + ".json"))]
    print(f"      待抓取 {len(todo)} / {len(ids)}")
    done = 0
    with cf.ThreadPoolExecutor(6) as ex:
        futs = {ex.submit(fetch_video, v): v for v in todo}
        for fu in cf.as_completed(futs):
            done += 1
            if done % 25 == 0:
                print(f"      {done}/{len(todo)}")

    videos = []
    for v in ids:
        d = fetch_video(v)
        if not d.get("_ok"):
            print(f"      !! 缺元数据 {v}")
        videos.append({
            "id": v,
            "title": d.get("title"),
            "date": d.get("publish_date"),
            "description": d.get("description", ""),
            "length": d.get("length"),
            "keywords": d.get("keywords", []),
        })

    out = {"channel_id": CHANNEL_ID, "channel": "PowerUpGammas",
           "videos": videos, "playlists": playlists}
    json.dump(out, open(os.path.join(RAW, "collected.json"), "w"), ensure_ascii=False, indent=1)
    print(f"完成: {len(videos)} 视频, {len(playlists)} 播放列表 -> raw/collected.json")


if __name__ == "__main__":
    main()
