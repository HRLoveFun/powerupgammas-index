(function () {
  "use strict";

  const DATA = window.__DATA__;
  const MODE = window.__MODE__ || "public";
  const IS_DEV = MODE === "dev";
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const pad2 = (n) => String(n).padStart(2, "0");
  const LSKEY = "pug.manual.v1";

  const S = {
    videos: DATA.videos.slice(),
    byId: {},
    tagById: {},
    pending: DATA.pending.slice(),
    sel: new Set(),
    search: "",
    active: new Set(),    // 已展开引用的行（视频 id）
    openEditor: null,     // 展开「标签/引用」面板的行
    openNote: null,       // 展开笔记编辑器的行
    pick: null,           // 选目标模式：{from, q, idx, listEl, inputEl}
    pickItems: [],        // 当前候选（供键盘上下移动）
    undo: null,           // 最近一次引用改动的快照
    manual: loadManual(),
    rows: {},
    years: [],
    dirty: false,          // 尚未来得及落盘
    pendingSync: false,    // 有改动还没推到远端
    remoteDiffers: false,   // 本地改动与线上版本不一致
    dirtyKeys: new Set(),   // 自上次同步以来改动的字段，形如 "notes:<id>"
    publishedAt: "",
  };

  DATA.videos.forEach((v) => (S.byId[v.id] = v));
  function rebuildTagIndex() {
    const map = new Map();
    DATA.tags.forEach((t) => map.set(t.id, Object.assign({}, t)));
    (S.manual.tagDefs || []).forEach((d) => {
      if (!d || !d.id) return;
      if (d.hidden) { map.delete(d.id); return; }
      const cur = map.get(d.id);
      if (cur) {
        if (d.label) { cur.label = d.label; cur.full = d.label; }
        if (d.color) cur.color = d.color;
      } else {
        const label = d.label || d.id;
        map.set(d.id, { id: d.id, label: label, full: label, color: d.color || "#8a8f98", source: "manual" });
      }
    });
    S.tags = Array.from(map.values());
    S.tagById = {};
    S.tags.forEach((t) => (S.tagById[t.id] = t));
  }
  rebuildTagIndex();

  /* ---------------- manual overlay ---------------- */
  function emptyManual() {
    return { tags: {}, refs: {}, notes: {}, tagDefs: [], pendingDismissed: [] };
  }
  // 公开版只认构建时写进文件的版本；开发版只在「有未同步改动」时才用浏览器暂存
  function loadManual() {
    if (IS_DEV) {
      try {
        const raw = localStorage.getItem(LSKEY);
        if (raw) {
          const o = JSON.parse(raw);
          // 已经同步过的暂存不再覆盖页面内嵌的版本，避免拿旧数据编辑
          if (o && o._pending) return Object.assign(emptyManual(), o);
        }
      } catch (e) {}
    }
    return window.__MANUAL__ ? Object.assign(emptyManual(), JSON.parse(JSON.stringify(window.__MANUAL__))) : emptyManual();
  }
  // 「有本地修订」= 存在未同步的改动；仅仅是存过一份不算
  const hasLocal = () => {
    try {
      const raw = localStorage.getItem(LSKEY);
      if (!raw) return false;
      const o = JSON.parse(raw);
      return !!o._pending;
    } catch (e) { return false; }
  };

  function mergeTags(v) {
    const rule = S.manual.tags[v.id] || {};
    const rm = rule.remove || [], ad = rule.add || [];
    let out = (v.autoTags || []).filter((t) => rm.indexOf(t) < 0);
    ad.forEach((t) => {
      if (S.tagById[t] && out.indexOf(t) < 0) out.push(t);
    });
    // 仅当这一期没有任何实际标签时才归入「未归类」
    out = out.filter((t) => t !== "unfiled");
    const named = out.some((t) => S.tagById[t] && S.tagById[t].source !== "system");
    if (!named) out.push("unfiled");
    return out;
  }

  function mergeRefs(v) {
    const rule = S.manual.refs[v.id] || {};
    const rm = rule.remove || [], ad = rule.add || [];
    let out = (v.autoRefs || []).filter((r) => rm.indexOf(r.to) < 0).slice();
    const seen = new Set(out.map((r) => r.to));
    ad.forEach((r) => {
      if (r.to === v.id || seen.has(r.to) || !S.byId[r.to]) return;
      out.push({ to: r.to, n: S.byId[r.to].n, type: r.type || "mention", note: r.note || "" });
      seen.add(r.to);
    });
    out.sort((a, b) => a.n - b.n);
    return out;
  }

  function recompute() {
    rebuildTagIndex();
    const notes = S.manual.notes || {};
    S.videos.forEach((v) => {
      v.tags = mergeTags(v);
      v.refs = mergeRefs(v);
      v.note = (notes[v.id] || "").trim();
    });
  }

  // 可见内容的真实高度：绝对定位的 SVG 会撑大 scrollHeight，不能拿它当基准
  function listContentHeight() {
    let h = 0;
    S.videos.forEach((v) => {
      const r = S.rows[v.id];
      if (r && !r.classList.contains("hidden")) h = Math.max(h, r.offsetTop + r.offsetHeight);
    });
    return h;
  }

  // 把一份 manual 装载进来并整体重绘（用于运行时拉取线上版本）
  function adoptManual(obj) {
    S.manual = Object.assign(emptyManual(), obj || {});
    recompute();
    paintRows();
    renderTags();
    refreshDirty();
    applyFilter();
    if (IS_DEV) renderPending();
  }

  function stripManual(m) {
    const o = Object.assign({}, m || {});
    delete o._savedAt;
    delete o._comment;
    delete o._schema;
    return JSON.stringify(o);
  }

  // 运行时拉取仓库里的 data/manual.json；失败（file:// 或离线）就沿用内嵌副本
  async function hydrateManual() {
    if (!/^https?:$/.test(location.protocol)) return;
    let remote = null;
    try {
      const r = await fetch("data/manual.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      remote = await r.json();
    } catch (e) {
      return;
    }
    if (!remote || typeof remote !== "object") return;

    const hasLocalEdits = IS_DEV && hasLocal() && stripManual(remote) !== stripManual(S.manual);
    if (hasLocalEdits) {
      // 开发版有未提交的改动：本地优先，但把差异标出来，避免误以为已经生效
      S.remoteDiffers = true;
      updateSaveState();
      return;
    }
    if (stripManual(remote) === stripManual(S.manual)) return;
    adoptManual(remote);
    if (IS_DEV) updateSaveState();
  }

  /* ---------------- 本地持久化 ---------------- */
  let storageOK = true;
  let storageWarned = false;
  let resetting = false;     // 重置期间禁止任何落盘，否则 pagehide / 防抖会把删掉的又写回来

  function persist() {
    if (resetting) return;
    const d = new Date();
    S.manual._savedAt = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0")).join(":");
    S.manual._pending = S.pendingSync ? 1 : 0;
    try {
      localStorage.setItem(LSKEY, JSON.stringify(S.manual));
      storageOK = true;
    } catch (e) {
      storageOK = false;
      warnStorage();
    }
    S.dirty = false;
    markSaved();
  }

  function markSaved() { updateSaveState(); }

  function updateSaveState() {
    if (!IS_DEV) return;
    const pill = $("#saveState");
    const np = document.querySelector(".np-status");
    const auto = autoSyncOn();
    const raw = S.manual._savedAt || "";
    const hm = raw ? raw.slice(0, 5) : "";
    let short, full, cls = "";

    if (!storageOK) { short = "未保存"; full = "浏览器禁止本地存储，改动不会被保留"; cls = "err"; }
    else if (syncing) { short = "同步中…"; full = "正在写入仓库"; cls = "warn"; }
    else if (S.syncError) { short = "同步失败"; full = "同步失败 · 仅存本地（" + S.syncError + "）"; cls = "err"; }
    else if (S.pendingSync && auto) { short = "待同步…"; full = "有改动等待写入仓库"; cls = "warn"; }
    else if (S.pendingSync && !auto) { short = "仅存本机"; full = "改动只存在这台浏览器 · 点此配置同步"; cls = "warn"; }
    else if (S.publishedAt) { short = "已同步 " + S.publishedAt.slice(0, 5); full = "已同步 " + S.publishedAt; cls = "ok"; }
    else if (S.remoteDiffers) { short = "未同步"; full = "本地版本与线上不一致"; cls = "warn"; }
    else if (hm) { short = "已保存 " + hm; full = "本地已保存 " + raw; cls = "ok"; }
    else { short = auto ? "自动同步" : "同步未配置"; full = auto ? "自动同步已开启" : "点此配置 Token，把改动写回仓库"; cls = auto ? "ok" : "warn"; }

    if (pill) {
      pill.hidden = false;
      pill.className = "savepill " + cls;
      pill.setAttribute("aria-label", full + "（点击打开同步设置）");
      const t = pill.querySelector(".sp-t");
      if (t) t.textContent = short;
    }
    if (np) np.textContent = !storageOK ? "未保存" : (raw ? "已保存 " + raw : "已保存");
  }

  function warnStorage() {
    if (storageWarned) return;
    storageWarned = true;
    const b = el("div", "storagewarn");
    b.innerHTML = "";
    b.appendChild(el("b", null, "浏览器禁止本地存储"));
    b.appendChild(document.createTextNode(
      "（常见于无痕/隐私模式）。改动只在当前页面有效，关掉就没了。请换普通窗口打开，或改完立即点「导出修订」保存成文件。"));
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 12000);
  }

  /* ---------------- header ---------------- */
  function renderHead() {
    const vids = S.videos;
    const first = vids[vids.length - 1].date, last = vids[0].date;
    const edges = vids.reduce((a, v) => a + v.refs.length, 0);
    $("#headmeta").innerHTML =
      "<b>" + S.videos.length + "</b> 期<i>/</i>" + first.slice(0, 4) + "–" + last.slice(0, 4) +
      "<i>/</i><b>" + edges + "</b> 条关联";
    $("#footstat").textContent = "";
    $("#footsep").hidden = true;
    $("#footnote").textContent =
      "数据更新于 " + DATA.generatedAt + " · 标签来自频道播放列表，引用按简介链接与系列结构推断";
  }

  /* ---------------- tags ---------------- */
  function renderTags() {
    const bar = $("#tagbar");
    bar.textContent = "";
    const all = el("button", "tag all" + (S.sel.size === 0 ? " on" : ""));
    all.innerHTML = "全部";
    all.onclick = () => { S.sel.clear(); S.active.clear(); renderTags(); applyFilter(); };
    bar.appendChild(all);

    const groups = [
      S.tags.filter((t) => t.source === "playlist"),
      S.tags.filter((t) => t.source === "manual"),
      S.tags.filter((t) => t.source === "system"),
    ];
    groups.forEach((g) => {
      if (!g.length) return;
      if (g[0].source !== "playlist") {
        const d = el("span", "dvd");
        bar.appendChild(d);
      }
      g.forEach((t) => {
        const n = S.videos.filter((v) => v.tags.indexOf(t.id) >= 0).length;
        if (!n) return;
        const b = el("button", "tag" + (S.sel.has(t.id) ? " on" : ""));
        b.style.setProperty("--tc", t.color);
        b.setAttribute("aria-pressed", S.sel.has(t.id) ? "true" : "false");
        const sw = el("span", "sw");
        const lb = el("span", null, t.label);
        const nn = el("span", "n", n);
        b.append(sw, lb, nn);
        b.onclick = () => {
          if (S.sel.has(t.id)) S.sel.delete(t.id); else S.sel.add(t.id);
          S.active.clear();
          renderTags(); applyFilter();
        };
        bar.appendChild(b);
      });
    });
    updateHint();
  }

  function updateHint() {
    const h = $("#selhint");
    if (!S.sel.size) { h.textContent = ""; return; }
    h.textContent = "已选 " + S.sel.size + " 个标签（取并集）";
  }

  /* ---------------- list ---------------- */
  function renderList() {
    const list = $("#list");
    const svg = $("#links");
    [...list.querySelectorAll(".row,.yr")].forEach((n) => n.remove());
    S.rows = {}; S.years = [];

    let curYear = null;
    S.videos.forEach((v) => {
      const y = v.date.slice(0, 4);
      if (y !== curYear) {
        curYear = y;
        const d = el("div", "yr", y);
        list.appendChild(d);
        S.years.push({ el: d, year: y });
      }
      const row = el("div", "row");
      row.dataset.id = v.id;
      row.dataset.n = v.n;

      const stripe = el("span", "stripe");
      row.appendChild(stripe);

      row.appendChild(el("div", "c-date", v.date));

      const ct = el("div", "c-title");
      const a = el("a", null, v.title);
      a.href = "https://www.youtube.com/watch?v=" + v.id;
      a.target = "_blank"; a.rel = "noopener";
      ct.appendChild(a);
      ct.appendChild(el("div", "c-note"));
      row.appendChild(ct);

      const cr = el("div", "c-refs");
      row.appendChild(cr);

      if (IS_DEV) {
        row.addEventListener("click", (ev) => {
          if (S.pick) return;
          if (ev.target.closest("a,.badge,.penbtn,button,.np,.editor")) return;
          toggleNote(v.id);
        });
      }

      list.appendChild(row);
      S.rows[v.id] = row;
    });
    paintRows();
    svg.style.height = listContentHeight() + "px";
  }

  function paintRows() {
    S.videos.forEach((v) => {
      const row = S.rows[v.id];
      if (!row) return;
      const cols = v.tags.map((t) => (S.tagById[t] ? S.tagById[t].color : "#5a626e"));
      const stripe = row.querySelector(".stripe");
      if (!cols.length) {
        stripe.style.background = "transparent";
      } else if (cols.length === 1) {
        stripe.style.background = cols[0];
      } else {
        const step = 100 / cols.length;
        stripe.style.background = "linear-gradient(to bottom," +
          cols.map((c, i) => c + " " + (i * step).toFixed(1) + "%," + c + " " + ((i + 1) * step).toFixed(1) + "%").join(",") + ")";
      }

      const cr = row.querySelector(".c-refs");
      cr.textContent = "";
      const mentions = mentionTargets(v);
      if (mentions.length) {
        const b = el("button", "badge mention");
        b.dataset.from = v.id;
        b.setAttribute("aria-label", "查看该行引用（" + mentions.length + " 个）");
        b.onclick = (ev) => { ev.stopPropagation(); toggleSource(v.id); };
        cr.appendChild(b);
      }
      if (IS_DEV) {
        const pen = el("button", "penbtn", "编辑");
        pen.onclick = (ev) => { ev.stopPropagation(); toggleEditor(v.id); };
        cr.appendChild(pen);
      }

      row.classList.toggle("has-note", !!v.note);
      const cn = row.querySelector(".c-note");
      if (cn) {
        const show = v.note && S.openNote !== v.id;
        cn.classList.toggle("has", !!show);
        cn.innerHTML = show ? NoteEditor.render(v.note) : "";
        if (show && IS_DEV) {
          cn.onclick = (e) => {
            e.stopPropagation();
            // 正在笔记里划词（想复制）时不抢这次点击
            const sel = window.getSelection();
            if (sel && sel.rangeCount && cn.contains(sel.anchorNode) && String(sel).trim()) return;
            toggleNote(v.id);
          };
        } else {
          // 公开版保持纯文本：没有点击行为，划词即可复制
          cn.onclick = null;
          cn.removeAttribute("title");
        }
      }
    });
  }

  /* ---------------- filtering ---------------- */
  function matches(v) {
    if (S.search) {
      const hay = v.title + " " + (v.note || "");
      if (hay.toLowerCase().indexOf(S.search) < 0) return false;
    }
    if (!S.sel.size) return true;
    return v.tags.some((t) => S.sel.has(t));
  }

  function applyFilter() {
    const forced = new Set();
    S.active.forEach((id) => (S.byId[id] ? mentionTargets(S.byId[id]) : []).forEach((r) => forced.add(r.to)));
    const yearOn = {};
    let shown = 0;
    S.videos.forEach((v) => {
      const ok = matches(v);
      // 选目标时源行必须留在视野里，否则筛选会把面板一起藏掉
      const pinned = !!(S.pick && S.pick.from === v.id);
      const show = ok || forced.has(v.id) || pinned;
      const row = S.rows[v.id];
      row.classList.toggle("hidden", !show);
      row.classList.toggle("is-temp", show && !ok);
      if (show) { shown++; yearOn[v.date.slice(0, 4)] = true; }
    });
    S.years.forEach((y) => y.el.classList.toggle("hidden", !yearOn[y.year]));
    const filtering = !!(S.sel.size || S.search);
    $("#footstat").textContent = filtering ? "筛选后 " + shown + " / " + S.videos.length + " 期" : "";
    $("#footsep").hidden = !filtering;
    markActive();
    drawFrames();
    drawLinks();
  }

  /* ---------------- references & lines ---------------- */
  function sameSeries(a, b) {
    return !!(a && b && a.series && a.series === b.series);
  }

  // 圆点只表示「跨系列的明确引用」；同系列内部的关系由方框表达
  function mentionTargets(v) {
    return (v.refs || []).filter((r) => r.type !== "series" && !sameSeries(v, S.byId[r.to]));
  }

  function toggleSource(id) {
    const v = S.byId[id];
    if (!v || !mentionTargets(v).length) return;
    const on = !S.active.has(id);
    if (on) S.active.add(id); else S.active.delete(id);
    applyFilter();
    if (!on) return;

    // 把第一个目标行带进视野
    const ms = mentionTargets(v);
    const first = S.rows[ms[0].to];
    if (!first) return;
    const r = first.getBoundingClientRect();
    if (r.top < 140 || r.bottom > window.innerHeight - 16) {
      first.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    ms.forEach((ref) => {
      const row = S.rows[ref.to];
      if (!row) return;
      row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
    });
  }

  function markActive() {
    Object.values(S.rows).forEach((r) => r.classList.remove("is-source", "is-target"));
    document.querySelectorAll(".badge.sel").forEach((b) => b.classList.remove("sel"));
    S.active.forEach((id) => {
      const v = S.byId[id], row = S.rows[id];
      if (!v || !row) return;
      row.classList.add("is-source");
      mentionTargets(v).forEach((r) => { if (S.rows[r.to]) S.rows[r.to].classList.add("is-target"); });
      const dot = row.querySelector(".badge");
      if (dot) dot.classList.add("sel");
    });
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function drawLinks() {
    const svg = $("#links");
    svg.textContent = "";
    const list = $("#list");
    const H = listContentHeight();
    svg.style.height = H + "px";
    if (!S.active.size) return;

    const defs = svgEl("defs", {});
    [["arw-m", "#5b9cf8"], ["arw-s", "#9b7cf0"]].forEach(([id, c]) => {
      const m = svgEl("marker", {
        id: id, viewBox: "0 0 8 8", refX: "7", refY: "4",
        markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse",
      });
      m.appendChild(svgEl("path", { d: "M0,0.6 L7,4 L0,7.4 z", fill: c }));
      defs.appendChild(m);
    });
    svg.appendChild(defs);

    const lr = list.getBoundingClientRect();
    const gutter = parseFloat(getComputedStyle(list).paddingRight) || 104;
    const edgeX = lr.right - gutter;          // 行右边缘 = SVG 左边缘
    const order = Array.from(S.active)
      .filter((id) => S.rows[id] && !S.rows[id].classList.contains("hidden"))
      .sort((a, b) => S.rows[a].offsetTop - S.rows[b].offsetTop);

    let ei = 0;
    order.forEach((id) => {
      const a = S.rows[id], v = S.byId[id];
      const ms = mentionTargets(v);
      const n = ms.length;
      let k = 0;
      ms.forEach((r) => {
        const b = S.rows[r.to];
        if (!b || b.classList.contains("hidden")) return;
        const y2 = b.offsetTop + b.offsetHeight / 2;
        const shift = n > 1 ? (k - (n - 1) / 2) * 3.2 : 0;
        const y1 = a.offsetTop + a.offsetHeight / 2 + shift;
        const bow = 26 + (ei % 6) * 12;
        const isSeries = r.type === "series";
        const p = svgEl("path", {
          d: "M1," + y1 + " C" + bow + "," + y1 + " " + bow + "," + y2 + " 2," + y2,
          stroke: isSeries ? "#9b7cf0" : "#5b9cf8",
          "stroke-opacity": isSeries ? ".7" : ".88",
          "stroke-width": "1.25",
          "stroke-dasharray": isSeries ? "3 3" : "none",
          "marker-end": "url(#" + (isSeries ? "arw-s" : "arw-m") + ")",
        });
        svg.appendChild(p);
        k++; ei++;
      });
    });
  }

  /* ---------------- 系列方框 ---------------- */
  function drawFrames() {
    const svg = $("#frames");
    if (!svg) return;
    svg.textContent = "";
    const list = $("#list");
    svg.style.height = listContentHeight() + "px";

    // 按系列名归组：标题结构决定的成员关系，与引用类型无关
    const groups = new Map();
    S.videos.forEach((v) => {
      if (!v.series) return;
      if (!groups.has(v.series)) groups.set(v.series, []);
      groups.get(v.series).push(v.id);
    });
    if (!groups.size) return;

    const W = svg.getBoundingClientRect().width || list.clientWidth;

    groups.forEach((ids, name) => {
      const rows = ids
        .map((id) => S.rows[id])
        .filter((r) => r && !r.classList.contains("hidden"))
        .sort((a, b) => a.offsetTop - b.offsetTop);
      if (rows.length < 2) return;

      const runs = [];
      let run = [rows[0]];
      for (let i = 1; i < rows.length; i++) {
        const prev = run[run.length - 1];
        if (rows[i].offsetTop <= prev.offsetTop + prev.offsetHeight + 2) run.push(rows[i]);
        else { runs.push(run); run = [rows[i]]; }
      }
      runs.push(run);

      const g = svgEl("g", {});

      const boxes = runs.map((seg) => {
        const last = seg[seg.length - 1];
        const top = seg[0].offsetTop + 1.5;
        const bottom = last.offsetTop + last.offsetHeight - 1.5;
        return { top: top, bottom: bottom };
      });

      // 被非系列视频隔开的段落：用虚线把同一组串起来
      if (boxes.length > 1) {
        for (let i = 0; i < boxes.length - 1; i++) {
          g.appendChild(svgEl("path", {
            d: "M" + (W + 8) + "," + boxes[i].bottom + " L" + (W + 8) + "," + boxes[i + 1].top,
            stroke: "rgba(155,124,240,.5)", "stroke-width": "1",
            "stroke-dasharray": "2 4", fill: "none",
          }));
        }
      }
      boxes.forEach((b) => {
        g.appendChild(svgEl("rect", {
          x: 2.5, y: b.top, width: Math.max(0, W - 5), height: Math.max(0, b.bottom - b.top),
          rx: 9, ry: 9,
          fill: "rgba(155,124,240,.05)",
          stroke: "rgba(155,124,240,.34)",
          "stroke-width": "1",
        }));
      });
      svg.appendChild(g);
    });
  }

  /* ---------------- editor ---------------- */
  function toggleEditor(id) {
    if (S.openNote) closeNote();                       // 笔记面板与标签/引用面板不同时展开
    if (S.openEditor && S.openEditor !== id) closeEditor(S.openEditor);
    if (S.openEditor === id) { closeEditor(id); return; }
    S.openEditor = id;
    const row = S.rows[id];
    row.classList.add("editing");
    const ed = el("div", "editor");
    ed.dataset.for = id;
    buildEditor(ed, S.byId[id]);
    row.appendChild(ed);
    svgResize();
  }

  function closeEditor(id) {
    const row = S.rows[id];
    if (!row) return;
    if (S.pick && S.pick.from === id) clearPick();
    row.classList.remove("editing");
    const ed = row.querySelector(".editor");
    if (ed) ed.remove();
    if (S.openEditor === id) S.openEditor = null;
    svgResize();
  }

  function svgResize() {
    const h = listContentHeight();
    $("#links").style.height = h + "px";
    if ($("#frames")) $("#frames").style.height = h + "px";
    drawFrames();
    drawLinks();
  }

  const shortTitle = (t, n) => (t && t.length > n ? t.slice(0, n) + "…" : t || "");
  function isSeriesRef(v, r) {
    const t = S.byId[r.to];
    return r.type === "series" || (!!t && sameSeries(v, t));
  }
  function isManualRef(vid, to) {
    const rule = (S.manual.refs || {})[vid];
    return !!(rule && (rule.add || []).some((x) => x.to === to));
  }
  const overlapTags = (a, b) => {
    const bt = b.tags || [];
    return (a.tags || []).filter((t) => t !== "unfiled" && bt.indexOf(t) >= 0).length;
  };

  function buildEditor(box, v) {
    box.textContent = "";
    box._refsBody = null;
    // 面板会被反复重建，把「当前展开的是哪个子面板」挂在节点上
    if (!box._tagUI) box._tagUI = { mode: null, q: "" };
    const ui = box._tagUI;

    // 标签
    const r1 = el("div", "ed-row");
    r1.appendChild(el("div", "ed-label", "标签"));
    const b1 = el("div", "ed-body");

    // 只列本期已有的标签，不把全局标签库整排倒出来
    const cur = (v.tags || []).filter((id) => id !== "unfiled" && S.tagById[id]);
    if (!cur.length) b1.appendChild(el("span", "lg dim", "本期暂无标签"));
    cur.forEach((id) => {
      const t = S.tagById[id];
      const chip = el("span", "tagchip");
      chip.style.setProperty("--tc", t.color || "#8a8f98");
      chip.append(el("span", "sw"), el("span", "tn", t.label));
      const x = el("span", "x", "×");
      x.setAttribute("aria-label", "从本期移除标签「" + t.label + "」");
      x.onclick = (ev) => {
        ev.stopPropagation();
        setTag(v.id, id, false);
        buildEditor(box, S.byId[v.id]);
        paintRows(); applyFilter();
      };
      chip.appendChild(x);
      b1.appendChild(chip);
    });

    const ops = el("span", "ed-ops");
    const bAdd = el("button", "ghost sm" + (ui.mode === "add" ? " accent" : ""), "＋ 新增视频标签");
    bAdd.onclick = (ev) => {
      ev.stopPropagation();
      ui.mode = ui.mode === "add" ? null : "add";
      ui.q = "";
      buildEditor(box, v);
    };
    const bNew = el("button", "ghost sm" + (ui.mode === "new" ? " accent" : ""), "＋ 新增全局标签");
    bNew.onclick = (ev) => {
      ev.stopPropagation();
      ui.mode = ui.mode === "new" ? null : "new";
      buildEditor(box, v);
    };
    const bMng = el("button", "ghost sm", "管理全局标签");
    bMng.onclick = (ev) => { ev.stopPropagation(); openTagManager(); };
    ops.append(bAdd, bNew, bMng);
    b1.appendChild(ops);

    r1.appendChild(b1);
    box.appendChild(r1);
    if (ui.mode === "add") box.appendChild(buildTagAddPanel(box, v, ui));
    else if (ui.mode === "new") box.appendChild(buildTagNewPanel(box, v, ui));

    // 引用：全部列出，同系列用虚线，不再隐藏
    const r2 = el("div", "ed-row");
    r2.appendChild(el("div", "ed-label", "引用"));
    const b2 = el("div", "ed-body");
    box._refsBody = b2;
    renderRefChips(b2, v);
    r2.appendChild(b2);
    box.appendChild(r2);

    // 笔记不在这里放入口：点笔记文字（或行内空白）直接进编辑器
    const r4 = el("div", "ed-row");
    r4.appendChild(el("div", "ed-label", ""));
    const b4 = el("div", "ed-body");
    const cbtn = el("button", "ghost sm", "复制该期链接");
    cbtn.onclick = (ev) => {
      ev.stopPropagation();
      navigator.clipboard.writeText("https://www.youtube.com/watch?v=" + v.id);
      toast("已复制链接");
    };
    b4.appendChild(cbtn);
    r4.appendChild(b4);
    box.appendChild(r4);

    if (S.pick && S.pick.from === v.id) box.appendChild(buildPicker(v));
  }

  /* ---------------- 标签三个入口 ---------------- */
  // 全局标签库里还没挂到本期的标签，按使用次数排序
  function tagPool(v) {
    const used = new Set((v.tags || []).filter((id) => S.tagById[id]));
    return S.tags
      .filter((t) => t.source !== "system" && !used.has(t.id))
      .map((t) => ({ t: t, n: S.videos.filter((x) => x.tags.indexOf(t.id) >= 0).length }))
      .sort((a, b) => b.n - a.n || a.t.label.localeCompare(b.t.label, "zh"));
  }

  function renderTagCandidates(host, box, v, ui) {
    host.textContent = "";
    const q = (ui.q || "").trim().toLowerCase();
    const toks = q ? q.split(/\s+/).filter(Boolean) : [];
    let pool = tagPool(v);
    if (toks.length) {
      pool = pool.filter((o) => toks.every((k) =>
        (o.t.label + " " + (o.t.full || "")).toLowerCase().indexOf(k) >= 0));
    } else {
      pool = pool.slice(0, 6);
      host.appendChild(el("div", "tg-hint", "留空只显示最常用的 6 个；输入名称可搜到其余标签"));
    }
    if (!pool.length) {
      host.appendChild(el("div", "tg-empty", toks.length
        ? "没有匹配的标签，换个词，或用「新增全局标签」建一个"
        : "全局标签都已加在这一期上"));
      return;
    }
    pool.slice(0, 6).forEach((o) => {
      const item = el("div", "tg-item");
      item.style.setProperty("--tc", o.t.color || "#8a8f98");
      item.append(el("span", "sw"), el("span", "tn", o.t.label));
      // 只有「命中的是播放列表全名、而简写标签名里没有这个词」时才补出全名，避免重复堆字
      const labelLow = o.t.label.toLowerCase();
      const fromFull = toks.length && !toks.every((k) => labelLow.indexOf(k) >= 0);
      if (fromFull && o.t.full && o.t.full !== o.t.label) item.appendChild(el("span", "tf", o.t.full));
      item.appendChild(el("span", "n", String(o.n)));
      item.onclick = (ev) => {
        ev.stopPropagation();
        setTag(v.id, o.t.id, true);
        buildEditor(box, S.byId[v.id]);
        paintRows(); applyFilter();
      };
      host.appendChild(item);
    });
  }

  // 新增视频标签：搜索已有全局标签并挂到本期
  function buildTagAddPanel(box, v, ui) {
    const sub = el("div", "ed-sub");
    const head = el("div", "sub-head");
    head.append(el("span", "sub-k", "选标签"),
      el("span", "sub-hint", "把已有的全局标签加到本期"));
    const close = el("button", "ghost sm", "收起");
    close.onclick = (ev) => { ev.stopPropagation(); ui.mode = null; buildEditor(box, v); };
    head.appendChild(close);
    sub.appendChild(head);

    const inp = el("input", "refinput sub-input");
    inp.type = "text";
    inp.placeholder = "搜索标签名称…";
    inp.autocomplete = "off";
    inp.value = ui.q || "";
    const list = el("div", "sub-list");
    const paint = () => renderTagCandidates(list, box, v, ui);
    inp.addEventListener("input", () => { ui.q = inp.value; paint(); });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        ui.mode = null; buildEditor(box, v);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const first = list.querySelector(".tg-item");
        if (first) first.click();
      }
    });
    sub.append(inp, list);
    paint();
    setTimeout(() => {
      const n = box.querySelector(".sub-input");
      if (!n) return;
      try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); }
    }, 0);
    return sub;
  }

  // 新增全局标签：建一个全站可用的标签，并顺手挂到本期
  function buildTagNewPanel(box, v, ui) {
    const sub = el("div", "ed-sub");
    const head = el("div", "sub-head");
    head.append(el("span", "sub-k", "新标签"),
      el("span", "sub-hint", "建好会同时加到本期；改名、换色、删除在「管理全局标签」"));
    const close = el("button", "ghost sm", "收起");
    close.onclick = (ev) => { ev.stopPropagation(); ui.mode = null; buildEditor(box, v); };
    head.appendChild(close);
    sub.appendChild(head);

    const form = el("div", "ed-new");
    const color = el("input", "tsw");
    color.type = "color";
    color.value = "#4a90d9";
    const name = el("input", "tname");
    name.type = "text";
    name.placeholder = "标签名称";
    name.maxLength = 24;
    const ok = el("button", "primary", "创建并加到本期");
    const submit = () => {
      const clean = name.value.trim();
      if (!clean) { name.focus(); return; }
      if (S.tags.some((t) => t.label === clean)) {
        toast("已有同名标签，用「新增视频标签」挂到本期即可");
        name.focus(); return;
      }
      const id = createTag(clean, color.value);
      if (!id) return;
      setTag(v.id, id, true);
      ui.mode = null;
      buildEditor(box, S.byId[v.id]);
      paintRows(); applyFilter();
      toast("已新建全局标签「" + clean + "」并加到本期");
    };
    ok.onclick = (ev) => { ev.stopPropagation(); submit(); };
    const keys = (e) => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        ui.mode = null; buildEditor(box, v);
      } else if (e.key === "Enter") {
        e.preventDefault(); submit();
      }
    };
    name.addEventListener("keydown", keys);
    color.addEventListener("keydown", keys);
    form.append(color, name, ok);
    sub.appendChild(form);
    setTimeout(() => {
      const n = box.querySelector(".ed-new .tname");
      if (n) n.focus();
    }, 0);
    return sub;
  }

  function renderRefChips(b2, v) {
    b2.textContent = "";
    const refs = (v.refs || []).slice().sort((a, b) =>
      (isSeriesRef(v, a) ? 1 : 0) - (isSeriesRef(v, b) ? 1 : 0) || a.n - b.n);
    if (!refs.length) b2.appendChild(el("span", "lg", "暂无引用，点右侧「＋ 添加引用」"));
    refs.forEach((r) => {
      const t = S.byId[r.to];
      if (!t) return;
      const series = isSeriesRef(v, r);
      const chip = el("span", "refitem" + (series ? " series" : ""));
      chip.appendChild(el("span", "rdot"));
      chip.appendChild(el("span", "rd", t.date.slice(2)));
      chip.appendChild(el("span", "rt", shortTitle(t.title, 14)));
      if (isManualRef(v.id, r.to)) {
        const mk = el("span", "mk", "手");
        mk.setAttribute("aria-label", "手动添加");
        chip.appendChild(mk);
      }
      chip.onclick = (ev) => { ev.stopPropagation(); jumpToRef(r.to); };
      if (r.type !== "series") {
        const x = el("span", "x", "×");
        x.setAttribute("aria-label", "删除这条引用");
        x.onclick = (ev) => {
          ev.stopPropagation();
          setRef(v.id, r.to, false);
        };
        chip.appendChild(x);
      }
      b2.appendChild(chip);
    });
    const picking = !!(S.pick && S.pick.from === v.id);
    const add = el("button", "tag mini add", picking ? "选目标中…" : "＋ 添加引用");
    if (picking) {
      add.disabled = true;
      add.style.opacity = ".55";
      add.style.cursor = "default";
    } else {
      add.onclick = (ev) => { ev.stopPropagation(); enterPick(v.id); };
    }
    b2.appendChild(add);
    const nSeries = refs.filter((r) => isSeriesRef(v, r)).length;
    if (nSeries) {
      b2.appendChild(el("span", "lg dim", "虚线 " + nSeries + " 条为系列内关联，不画线；组内关系由方框表达"));
    }
  }

  function refreshRefs(vid) {
    const row = S.rows[vid];
    const box = row && row.querySelector(".editor");
    if (!box || !box._refsBody) return;
    renderRefChips(box._refsBody, S.byId[vid]);
    if (S.pick && S.pick.from === vid) {
      renderPickList(S.byId[vid]);
      markPickRows();
    }
    svgResize();
  }

  function jumpToRef(id) {
    const row = S.rows[id];
    if (!row) return;
    if (row.classList.contains("hidden")) {
      S.sel.clear(); S.search = ""; $("#search").value = "";
      renderTags(); applyFilter();
    }
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
  }

  /* ---------------- 选目标模式 ---------------- */
  function buildPicker(v) {
    const wrap = el("div", "ed-pick");
    const head = el("div", "pk-head");
    head.appendChild(el("span", "pk-k", "选目标"));
    head.appendChild(el("span", "pk-sub",
      "为《" + shortTitle(v.title, 20) + "》添加引用 · 点列表任意一行，或直接搜索"));
    const end = el("button", "ghost sm", "结束");
    end.onclick = (ev) => { ev.stopPropagation(); exitPick(); };
    head.appendChild(end);
    wrap.appendChild(head);

    const inp = el("input", "refinput pk-input");
    inp.type = "text";
    inp.value = S.pick.q || "";
    inp.placeholder = "留空：按同系列 / 同标签 / 最近给候选；输入即筛";
    inp.autocomplete = "off";
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("input", () => {
      S.pick.q = inp.value;
      S.pick.idx = 0;
      renderPickList(v);
    });
    inp.addEventListener("keydown", onPickKey);
    wrap.appendChild(inp);

    const list = el("div", "pk-list");
    wrap.appendChild(list);
    S.pick.listEl = list;
    S.pick.inputEl = inp;
    renderPickList(v);
    setTimeout(() => {
      if (!S.pick || !S.pick.inputEl) return;
      try { S.pick.inputEl.focus({ preventScroll: true }); } catch (e) { S.pick.inputEl.focus(); }
    }, 0);
    return wrap;
  }

  function pickScore(from, x, toks) {
    const hay = (x.title + " " + (x.series || "")).toLowerCase();
    if (!toks.every((t) => hay.indexOf(t) >= 0)) return null;
    let s = 0;
    if (sameSeries(from, x)) s += 1000;
    s += overlapTags(from, x) * 120;
    s -= Math.abs(x.n - from.n) * 0.8;
    return s;
  }

  function renderPickList(v) {
    const host = S.pick && S.pick.listEl;
    if (!host) return;
    const st = host.scrollTop;
    host.textContent = "";
    const q = (S.pick.q || "").trim();
    const toks = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const used = new Set((v.refs || []).map((r) => r.to));
    const hit = [];
    const add = (x, group) => {
      if (x.id === v.id || hit.some((h) => h.x.id === x.id)) return;
      hit.push({ x: x, group: group });
    };

    if (!toks.length) {
      const mates = v.series ? S.videos.filter((x) => x.series === v.series && x.id !== v.id) : [];
      mates.slice().sort((a, b) => a.n - b.n).forEach((x) => add(x, "同系列 " + mates.length + " 期"));
      const inMates = new Set(mates.map((m) => m.id));
      S.videos.filter((x) => x.id !== v.id && !inMates.has(x.id))
        .map((x) => ({ x: x, o: overlapTags(v, x) }))
        .filter((o) => o.o > 0)
        .sort((a, b) => b.o - a.o || Math.abs(a.x.n - v.n) - Math.abs(b.x.n - v.n))
        .slice(0, 8)
        .forEach((o) => add(o.x, "同标签"));
      S.videos.filter((x) => x.id !== v.id)
        .sort((a, b) => Math.abs(a.n - v.n) - Math.abs(b.n - v.n))
        .slice(0, 8)
        .forEach((x) => add(x, "最近"));
    } else {
      S.videos.filter((x) => x.id !== v.id)
        .map((x) => ({ x: x, s: pickScore(v, x, toks) }))
        .filter((o) => o.s !== null)
        .sort((a, b) => b.s - a.s)
        .slice(0, 30)
        .forEach((o) => add(o.x, "搜索结果"));
    }

    if (!hit.length) {
      host.appendChild(el("div", "pk-empty",
        q ? "没有匹配的标题。换个词，或清空搜索按系列 / 标签找。" : "没有可推荐的候选，直接搜标题。"));
      S.pickItems = [];
      S.pickIdx = 0;
      return;
    }
    let last = null;
    hit.forEach((o, i) => {
      if (o.group !== last) {
        last = o.group;
        host.appendChild(el("div", "pk-group", o.group));
      }
      host.appendChild(pickItem(v, o.x, used, toks, i));
    });
    S.pickItems = hit.map((h) => h.x);
    S.pickIdx = Math.min(S.pick.idx || 0, S.pickItems.length - 1);
    if (S.pickIdx < 0) S.pickIdx = 0;
    // 光标不要停在已引用的条目上：优先落到后面第一个可选项
    if (S.pickItems[S.pickIdx] && used.has(S.pickItems[S.pickIdx].id)) {
      let next = S.pickItems.findIndex((x, i) => i > S.pickIdx && !used.has(x.id));
      if (next < 0) next = S.pickItems.findIndex((x) => !used.has(x.id));
      if (next >= 0) S.pickIdx = next;
    }
    S.pick.idx = S.pickIdx;
    markPickCursor();
    host.scrollTop = st;
  }

  function pickItem(from, x, used, toks, i) {
    const item = el("div", "pk-item");
    item.dataset.i = i;
    const on = used.has(x.id);
    const rev = (x.refs || []).some((r) => r.to === from.id);
    const ser = sameSeries(from, x);
    if (on) item.classList.add("used");
    item.appendChild(el("span", "pk-d", x.date));
    const tt = el("span", "pk-t");
    tt.appendChild(highlightText(x.title, toks));
    item.appendChild(tt);
    const tags = (x.tags || []).filter((t) => t !== "unfiled").slice(0, 2)
      .map((t) => (S.tagById[t] ? S.tagById[t].label : t));
    const meta = [x.series || "", tags.join(" · ")].filter(Boolean).join(" ｜ ");
    if (meta) item.appendChild(el("span", "pk-m", meta));
    const st = el("span", "pk-st");
    if (on) { st.textContent = "已引用"; st.classList.add("on"); }
    else if (rev) { st.textContent = "反向已存在"; st.classList.add("rev"); }
    else if (ser) { st.textContent = "同系列"; st.classList.add("ser"); }
    if (st.textContent) item.appendChild(st);
    item.onclick = (ev) => {
      ev.stopPropagation();
      choosePick(x);
    };
    return item;
  }

  function choosePick(x) {
    if (!S.pick) return;
    const from = S.byId[S.pick.from];
    if (!from || !x) return;
    if ((from.refs || []).some((r) => r.to === x.id)) { toast("这两期已经是引用关系"); return; }
    const rev = (x.refs || []).some((r) => r.to === from.id);
    setRef(from.id, x.id, true, { msg: rev ? "已添加引用（对方也引用了本期）" : "已添加引用" });
    if (S.pick && S.pick.pending) {
      const pid = S.pick.pending;
      S.pick.pending = null;
      dismissPending(pid);
    }
  }

  function onPickKey(e) {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); exitPick(); return;
    }
    if (!S.pick) return;
    const n = (S.pickItems || []).length;
    if (!n) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      S.pick.idx = (S.pick.idx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      markPickCursor();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choosePick(S.pickItems[S.pick.idx]);
    }
  }

  function markPickCursor() {
    const host = S.pick && S.pick.listEl;
    if (!host) return;
    const cur = host.querySelector('.pk-item[data-i="' + S.pick.idx + '"]');
    Array.from(host.querySelectorAll(".pk-item")).forEach((n) => n.classList.toggle("cur", n === cur));
    if (!cur) return;
    const hr = host.getBoundingClientRect(), ir = cur.getBoundingClientRect();
    if (ir.top < hr.top) host.scrollTop += ir.top - hr.top - 4;
    else if (ir.bottom > hr.bottom) host.scrollTop += ir.bottom - hr.bottom + 4;
  }

  function highlightText(text, toks) {
    if (!toks || !toks.length) return document.createTextNode(text);
    const lower = text.toLowerCase();
    const ranges = [];
    toks.forEach((t) => {
      let i = lower.indexOf(t);
      while (i >= 0) { ranges.push([i, i + t.length]); i = lower.indexOf(t, i + t.length); }
    });
    if (!ranges.length) return document.createTextNode(text);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    ranges.forEach((r) => {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r.slice());
    });
    const frag = document.createDocumentFragment();
    let p = 0;
    merged.forEach(([s, e]) => {
      if (s > p) frag.appendChild(document.createTextNode(text.slice(p, s)));
      frag.appendChild(el("mark", null, text.slice(s, e)));
      p = e;
    });
    if (p < text.length) frag.appendChild(document.createTextNode(text.slice(p)));
    return frag;
  }

  function markPickRows() {
    const from = S.pick ? S.byId[S.pick.from] : null;
    const used = new Set(from ? (from.refs || []).map((r) => r.to) : []);
    Object.keys(S.rows).forEach((id) => {
      const row = S.rows[id];
      row.classList.toggle("pick-src", !!from && id === from.id);
      row.classList.toggle("pick-used", used.has(id));
    });
  }

  function clearPick() {
    S.pick = null;
    S.pickItems = [];
    document.body.classList.remove("picking");
    Object.keys(S.rows).forEach((id) => S.rows[id].classList.remove("pick-src", "pick-used"));
  }

  function enterPick(id, pendingId) {
    const v = S.byId[id];
    if (!v) return;
    if (S.pick && S.pick.from === id) { exitPick(); return; }
    if (S.pick) clearPick();
    S.pick = { from: id, q: "", idx: 0, listEl: null, inputEl: null, pending: pendingId || null };
    S.pickItems = [];
    document.body.classList.add("picking");
    if (S.openEditor !== id) toggleEditor(id);
    const box = S.rows[id] && S.rows[id].querySelector(".editor");
    if (box) buildEditor(box, v);
    markPickRows();
    // 让源行连同上面的 chip 一起留在视野里，别被吸顶栏遮住
    const row = S.rows[id];
    if (row && row.getBoundingClientRect().top < 130) {
      row.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    svgResize();
  }

  function exitPick() {
    if (!S.pick) return;
    const id = S.pick.from;
    clearPick();
    const box = S.rows[id] && S.rows[id].querySelector(".editor");
    if (box) buildEditor(box, S.byId[id]);
    svgResize();
  }

  function setTag(vid, tagId, on) {
    S.dirty = true;
    S.pendingSync = true;
    S.dirtyKeys.add("tags:" + vid);
    const m = S.manual.tags;
    const rule = m[vid] || (m[vid] = { add: [], remove: [] });
    rule.add = rule.add || []; rule.remove = rule.remove || [];
    const isAuto = (S.byId[vid].autoTags || []).indexOf(tagId) >= 0;
    if (on) {
      rule.remove = rule.remove.filter((x) => x !== tagId);
      if (!isAuto && rule.add.indexOf(tagId) < 0) rule.add.push(tagId);
    } else {
      rule.add = rule.add.filter((x) => x !== tagId);
      if (isAuto && rule.remove.indexOf(tagId) < 0) rule.remove.push(tagId);
    }
    commit();
  }

  function setRef(vid, toId, on, opts) {
    opts = opts || {};
    const before = S.manual.refs[vid] ? JSON.parse(JSON.stringify(S.manual.refs[vid])) : null;
    S.dirty = true;
    S.pendingSync = true;
    S.dirtyKeys.add("refs:" + vid);
    const m = S.manual.refs;
    const rule = m[vid] || (m[vid] = { add: [], remove: [] });
    rule.add = rule.add || []; rule.remove = rule.remove || [];
    if (on) {
      rule.remove = rule.remove.filter((x) => x !== toId);
      if (!rule.add.some((r) => r.to === toId)) rule.add.push({ to: toId, type: "mention" });
    } else {
      rule.add = rule.add.filter((r) => r.to !== toId);
      if ((S.byId[vid].autoRefs || []).some((r) => r.to === toId) && rule.remove.indexOf(toId) < 0) {
        rule.remove.push(toId);
      }
    }
    if (!rule.add.length && !rule.remove.length) delete m[vid];
    commit();
    refreshRefs(vid);
    if (!opts.silent) {
      S.undo = { kind: "ref", vid: vid, before: before };
      toast(opts.msg || (on ? "已添加引用" : "已删除引用"), "撤销", undoRef, 4200);
    }
  }

  function undoRef() {
    const u = S.undo;
    if (!u || u.kind !== "ref" || !S.byId[u.vid]) return;
    S.undo = null;
    if (u.before) S.manual.refs[u.vid] = u.before;
    else delete S.manual.refs[u.vid];
    S.dirty = true;
    S.pendingSync = true;
    S.dirtyKeys.add("refs:" + u.vid);
    commit();
    refreshRefs(u.vid);
    toast("已撤销");
  }

  function commit() {
    recompute();
    paintRows();
    Array.from(S.active).forEach((id) => { if (!S.byId[id] || !mentionTargets(S.byId[id]).length) S.active.delete(id); });
    persist();
    renderTags();
    refreshDirty();
    applyFilter();
    scheduleSync();
  }

  function countEdits() {
    const m = S.manual, notes = m.notes || {};
    const nz = (r) => ((r && ((r.add || []).length || (r.remove || []).length)) ? 1 : 0);
    return {
      tags: Object.keys(m.tags || {}).reduce((a, k) => a + nz(m.tags[k]), 0),
      refs: Object.keys(m.refs || {}).reduce((a, k) => a + nz(m.refs[k]), 0),
      notes: Object.keys(notes).filter((k) => String(notes[k] || "").trim()).length,
    };
  }

  function refreshDirty() {
    const ex = $("#btnExport"), rs = $("#btnReset");
    if (!ex) return;
    const c = countEdits();
    const n = c.tags + c.refs + c.notes;
    ex.hidden = !n;
    rs.hidden = !S.pendingSync;   // 只有还没同步到仓库的本地改动才有「重置」可言
    ex.textContent = "导出修订 (" + n + ")";
  }

  function exportManual() {
    const out = {
      _comment: "人工维护覆盖层。以 YouTube 视频 ID 为索引；构建时与自动数据合并。",
      tags: S.manual.tags, refs: S.manual.refs, notes: S.manual.notes || {},
      tagDefs: S.manual.tagDefs || [],
      pendingDismissed: S.manual.pendingDismissed || [],
    };
    delete out._savedAt;
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "manual.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("已导出 manual.json —— 放入 data/ 后重新构建即可固化");
  }

  /* ---------------- 同步到仓库 ---------------- */
  const GHKEY = "pug.gh.v1";
  const NEUTRAL = { name: "PowerUpGammas Index", email: "noreply@github.com" };

  function ghConfig() {
    const c = { repo: "", branch: "main", token: "", auto: true };
    try { Object.assign(c, JSON.parse(localStorage.getItem(GHKEY) || "{}")); } catch (e) {}
    if (!c.repo) {
      const m = location.hostname.match(/^([^.]+)\.github\.io$/);
      const seg = location.pathname.split("/").filter(Boolean);
      if (m && seg.length) c.repo = m[1] + "/" + seg[0];
    }
    return c;
  }

  function saveGhConfig(c) {
    try { localStorage.setItem(GHKEY, JSON.stringify(c)); } catch (e) {}
  }

  const syncReady = () => { const c = ghConfig(); return !!(c.repo && c.token); };

  function manualForFile() {
    const o = JSON.parse(JSON.stringify(S.manual));
    delete o._savedAt;
    delete o._pending;
    return o;
  }

  function toB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  function fromB64(b64) {
    const bin = atob(String(b64 || "").replace(/\s/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function stamp() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0")).join(":");
  }

  // 只把「本机改动过的条目」盖到远端版本上，避免多设备互相覆盖
  function mergeManual(remote, local, keys) {
    const out = JSON.parse(JSON.stringify(remote || {}));
    // keys 形如 "notes:<id>"，只覆盖本机真正改过的那个字段
    ["tags", "refs", "notes"].forEach((k) => {
      out[k] = out[k] || {};
      keys.forEach((key) => {
        const p = key.indexOf(":");
        if (p < 0 || key.slice(0, p) !== k) return;
        const id = key.slice(p + 1);
        if (local[k] && local[k][id] !== undefined) out[k][id] = local[k][id];
        else delete out[k][id];
      });
    });
    const defs = new Map();
    (out.tagDefs || []).forEach((d) => defs.set(d.id, d));
    (local.tagDefs || []).forEach((d) => defs.set(d.id, d));
    out.tagDefs = Array.from(defs.values());
    out.pendingDismissed = Array.from(new Set([].concat(out.pendingDismissed || [], local.pendingDismissed || [])));
    // 文件头的说明字段以仓库里的为准，避免浏览器用旧副本覆盖文档
    if (!out._comment && local._comment) out._comment = local._comment;
    if (!out._schema && local._schema) out._schema = local._schema;
    return out;
  }

  function ghApi(cfg) {
    const parts = String(cfg.repo || "").split("/");
    const owner = parts[0], repo = parts[1];
    if (!owner || !repo) throw new Error("仓库格式应为 owner/repo");
    if (!cfg.token) throw new Error("请填写 Access Token");
    const branch = cfg.branch || "main";
    return {
      url: "https://api.github.com/repos/" + owner + "/" + repo + "/contents/data/manual.json",
      branch: branch,
      headers: {
        Authorization: "Bearer " + cfg.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
  }

  async function ghRead(api) {
    const r = await fetch(api.url + "?ref=" + encodeURIComponent(api.branch), { headers: api.headers, cache: "no-store" });
    if (r.status === 404) return { sha: null, data: null };
    if (r.status === 401) throw new Error("Token 无效或已过期");
    if (!r.ok) throw new Error("读取仓库失败（HTTP " + r.status + "）");
    const j = await r.json();
    let data = null;
    try { data = JSON.parse(fromB64(j.content)); } catch (e) {}
    return { sha: j.sha, data: data };
  }

  async function ghWrite(api, api2, data, sha) {
    const body = {
      message: "更新索引：" + stamp(),
      content: toB64(JSON.stringify(data, null, 2) + "\n"),
      branch: api.branch,
      author: NEUTRAL,
      committer: NEUTRAL,
    };
    if (sha) body.sha = sha;
    const p = await fetch(api.url, {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, api.headers),
      body: JSON.stringify(body),
    });
    if (p.ok) return true;
    if (p.status === 409) return false;              // 已被别人改过，交给调用方重试
    if (p.status === 401) throw new Error("Token 无效或已过期");
    if (p.status === 403) throw new Error("权限不足：Token 需要该仓库的 Contents 读写权限");
    let detail = "";
    try { detail = (await p.json()).message || ""; } catch (e) {}
    throw new Error((detail || "写入失败") + "（HTTP " + p.status + "）");
  }

  function diffKeys(remote, local) {
    const keys = new Set();
    ["tags", "refs", "notes"].forEach((k) => {
      const r = (remote && remote[k]) || {};
      const l = local[k] || {};
      new Set(Object.keys(r).concat(Object.keys(l))).forEach((id) => {
        if (JSON.stringify(r[id]) !== JSON.stringify(l[id])) keys.add(k + ":" + id);
      });
    });
    return Array.from(keys);
  }

  // 一次完整同步：读远端 -> 合并本机改动 -> 写回；冲突时重读重试一次
  async function ghSync(cfg) {
    const api = ghApi(cfg);
    const local = manualForFile();
    let lastErr = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const remote = await ghRead(api);
      let data = local;

      if (remote.data) {
        const keys = S.dirtyKeys.size ? Array.from(S.dirtyKeys) : diffKeys(remote.data, local);
        data = mergeManual(remote.data, local, keys);
        // 内容没变化就不产生空提交
        if (JSON.stringify(data) === JSON.stringify(remote.data)) {
          return { skipped: true };
        }
      }
      const ok = await ghWrite(api, api, data, remote.sha);
      if (ok) return { ok: true, data: data };
      lastErr = new Error("冲突");
    }
    throw lastErr || new Error("同步失败");
  }

  /* ---- 自动同步 ---- */
  let syncTimer = null, syncing = false, syncQueued = false;
  S.syncError = "";

  function autoSyncOn() {
    const c = ghConfig();
    return !!(c.auto && c.token && c.repo);
  }

  let hintedNoSync = false;
  function scheduleSync() {
    if (!autoSyncOn()) {
      updateSaveState();
      if (!hintedNoSync) {
        hintedNoSync = true;
        toast("改动只存在这台浏览器，点右上角「启用同步」才会写进仓库");
      }
      return;
    }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => runSync(true), 2200);
  }

  async function runSync(auto) {
    if (!syncReady()) { S.syncError = "未配置 Token"; updateSaveState(); return; }
    if (syncing) { syncQueued = true; return; }
    syncing = true;
    S.syncError = "";
    updateSaveState();
    try {
      const r = await ghSync(ghConfig());
      if (r.data) absorbManual(r.data);
      S.publishedAt = stamp();
      S.dirty = false;
      S.pendingSync = false;
      S.remoteDiffers = false;
      S.dirtyKeys.clear();
      S.manual._savedAt = S.publishedAt;
      S.manual._pending = 0;
      persistQuiet();
      refreshPublishBtn();
      refreshDirty();          // 同步完成后「重置」应当收起
    } catch (e) {
      S.syncError = e.message || "同步失败";
    } finally {
      syncing = false;
      updateSaveState();
      if (syncQueued) { syncQueued = false; scheduleSync(); }
      else if (!auto && !S.syncError) toast("已同步到仓库");
    }
  }

  function absorbManual(data) {
    // 同步回包用的是发出请求那一刻的本机副本：正在编辑的笔记以页面里的内容为准，
    // 否则停手后 2 秒触发同步，往返途中敲的几个字会被整份替换掉。
    const panel = document.querySelector(".np");
    const editingId = S.openNote;
    const editingMd = panel && panel._editor ? panel._editor.getValue() : null;

    S.manual = Object.assign(emptyManual(), data);
    if (editingId && editingMd != null) {
      S.manual.notes = S.manual.notes || {};
      if (String(editingMd).trim()) S.manual.notes[editingId] = editingMd;
      else delete S.manual.notes[editingId];
    }
    recompute();
    paintRows();
    renderTags();
    refreshDirty();
  }

  function persistQuiet() {
    if (resetting) return;
    try { localStorage.setItem(LSKEY, JSON.stringify(S.manual)); } catch (e) {}
  }

  function openPublish() {
    if (document.querySelector(".modal")) return;
    const cfg = ghConfig();
    const mask = el("div", "modal");
    const box = el("div", "modal-box");
    box.appendChild(el("h3", null, "同步到仓库"));
    box.appendChild(el("p", "modal-hint",
      "开发版的改动会写回仓库的 data/manual.json，其他设备刷新即可看到（约 30 秒）。Token 只存这台浏览器。"));

    const mk = (label, key, type, ph) => {
      const l = el("label", null, label);
      const i = el("input");
      i.type = type || "text";
      i.value = cfg[key] || "";
      i.placeholder = ph || "";
      i.dataset.k = key;
      i.autocomplete = "off";
      l.appendChild(i);
      box.appendChild(l);
      return i;
    };
    const repoIn = mk("仓库（owner/repo）", "repo", "text", "owner/repo");
    const branchIn = mk("分支", "branch", "text", "main");
    const tokenIn = mk("Access Token（只存本浏览器，不写进仓库）", "token", "password", "github_pat_…");
    tokenIn.spellcheck = false;

    const autoWrap = el("label", "modal-check");
    const autoIn = el("input");
    autoIn.type = "checkbox";
    autoIn.checked = cfg.auto !== false;
    autoWrap.appendChild(autoIn);
    autoWrap.appendChild(document.createTextNode(" 自动同步（停止输入 2 秒后自动提交）"));
    box.appendChild(autoWrap);

    const msg = el("div", "modal-msg");
    const acts = el("div", "modal-actions");

    const save = () => {
      const c = {
        repo: repoIn.value.trim(),
        branch: branchIn.value.trim() || "main",
        token: tokenIn.value.trim(),
        auto: autoIn.checked,
      };
      saveGhConfig(c);
      refreshPublishBtn();
      updateSaveState();
      return c;
    };

    const cancel = el("button", "ghost", "关闭");
    cancel.onclick = () => mask.remove();

    const pull = el("button", "ghost", "用线上版本覆盖本地");
    pull.onclick = async () => {
      if (!confirm("丢弃本地未同步的改动，改用仓库里的版本？")) return;
      try {
        const r = await fetch("data/manual.json?t=" + Date.now(), { cache: "no-store" });
        if (!r.ok) throw new Error("拉取失败");
        adoptManual(await r.json());
        try { localStorage.removeItem(LSKEY); } catch (e) {}
        S.remoteDiffers = false; S.dirty = false; S.pendingSync = false; S.publishedAt = ""; S.syncError = ""; S.dirtyKeys.clear();
        updateSaveState();
        refreshDirty();
        msg.className = "modal-msg ok";
        msg.textContent = "已切换到线上版本。";
      } catch (e) {
        msg.className = "modal-msg";
        msg.textContent = e.message;
      }
    };

    const ok = el("button", "primary", "立即同步");
    ok.onclick = async () => {
      save();
      ok.disabled = true; ok.textContent = "同步中…";
      msg.className = "modal-msg"; msg.textContent = "";
      try {
        await runSync(false);
        if (S.syncError) throw new Error(S.syncError);
        msg.className = "modal-msg ok";
        msg.textContent = "已同步。其他设备刷新后即可看到（约 30 秒）。";
        ok.textContent = "已同步";
        setTimeout(() => mask.remove(), 1400);
      } catch (e) {
        msg.className = "modal-msg";
        msg.textContent = e.message;
        ok.disabled = false; ok.textContent = "立即同步";
      }
    };

    acts.append(pull, cancel, ok);
    box.appendChild(msg);
    box.appendChild(acts);
    mask.appendChild(box);
    mask.addEventListener("click", (e) => { if (e.target === mask) mask.remove(); });
    document.body.appendChild(mask);
    setTimeout(() => repoIn.focus(), 30);
  }

  /* ---------------- 标签增删改 ---------------- */
  const tagDefs = () => S.manual.tagDefs || (S.manual.tagDefs = []);
  const findDef = (id) => tagDefs().find((d) => d.id === id);

  function refreshEditor() {
    if (!S.openEditor) return;
    const row = S.rows[S.openEditor];
    const box = row && row.querySelector(".editor");
    if (box) buildEditor(box, S.byId[S.openEditor]);
  }

  function createTag(label, color) {
    const clean = String(label || "").trim();
    if (!clean) return null;
    const id = "tg-" + Math.random().toString(36).slice(2, 9);
    tagDefs().push({ id: id, label: clean, color: color || "#8a8f98" });
    commit();
    return id;
  }

  function renameTag(id, label) {
    const clean = String(label || "").trim();
    if (!clean) return;
    const d = findDef(id);
    if (d) { d.label = clean; delete d.hidden; }
    else tagDefs().push({ id: id, label: clean });
    commit();
    refreshEditor();
  }

  function recolorTag(id, color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    const d = findDef(id);
    if (d) { d.color = color; delete d.hidden; }
    else tagDefs().push({ id: id, color: color });
    commit();
    refreshEditor();
  }

  function deleteTag(id) {
    const t = S.tagById[id];
    if (t && t.source === "system") { toast("系统标签不能删除"); return; }
    const defs = tagDefs();
    const i = defs.findIndex((d) => d.id === id);
    // 保留名称与颜色，否则自定义标签删掉后就没法恢复
    const rec = { id: id, hidden: true };
    const cur = i >= 0 ? defs[i] : null;
    if (cur && cur.label) rec.label = cur.label;
    if (cur && cur.color) rec.color = cur.color;
    if (!rec.label && t) rec.label = t.label;
    if (!rec.color && t) rec.color = t.color;
    if (i >= 0) defs[i] = rec; else defs.push(rec);
    S.sel.delete(id);
    commit();
    refreshEditor();
  }

  function restoreTag(id) {
    const defs = tagDefs();
    const i = defs.findIndex((d) => d.id === id);
    if (i >= 0) {
      const base = DATA.tags.find((t) => t.id === id);
      // 内置标签：删掉覆盖记录即可回到原样；自定义标签：只去掉隐藏标记
      if (base) defs.splice(i, 1);
      else delete defs[i].hidden;
    }
    commit();
    refreshEditor();
  }

  function hiddenTags() {
    const out = [];
    tagDefs().forEach((d) => {
      if (!d.hidden) return;
      const base = DATA.tags.find((t) => t.id === d.id);
      out.push(d.label || (base && base.label) || d.id);
    });
    return out;
  }

  function openTagManager() {
    if (document.querySelector(".modal")) return;
    const mask = el("div", "modal");
    const box = el("div", "modal-box taggedit");
    box.appendChild(el("h3", null, "全局标签管理"));
    box.appendChild(el("p", "modal-hint",
      "改名或换色立即生效，影响所有视频；删除会从全部视频上移除该标签，之后可以恢复。这里新建的标签不会自动归到某一期，用行内的「新增视频标签」挂上去。"));

    const list = el("div", "taglist");
    box.appendChild(list);

    const add = el("div", "tagadd");
    const addName = el("input", "tname");
    addName.placeholder = "新标签名称";
    addName.maxLength = 24;
    const addColor = el("input", "tsw");
    addColor.type = "color";
    addColor.value = "#4a90d9";
    const addBtn = el("button", "primary", "新增");
    add.append(addColor, addName, addBtn);
    box.appendChild(add);

    const render = () => {
      list.textContent = "";
      S.tags.filter((t) => t.source !== "system").forEach((t) => {
        const n = S.videos.filter((v) => v.tags.indexOf(t.id) >= 0).length;
        const row = el("div", "tagrow");

        const c = el("input", "tsw");
        c.type = "color";
        c.value = t.color;
        let colorT = null;
        c.oninput = () => {
          clearTimeout(colorT);
          colorT = setTimeout(() => recolorTag(t.id, c.value), 260);
        };
        row.appendChild(c);

        const nm = el("input", "tname");
        nm.value = t.label;
        nm.maxLength = 24;
        nm.onchange = () => renameTag(t.id, nm.value);
        row.appendChild(nm);

        row.appendChild(el("span", "tcount", String(n)));

        const del = el("button", "tx", "删除");
        del.onclick = () => {
          if (!confirm("删除标签「" + t.label + "」？将从 " + n + " 个视频上移除，之后可恢复。")) return;
          deleteTag(t.id);
          render();
        };
        row.appendChild(del);
        list.appendChild(row);
      });

      const hidden = tagDefs().filter((d) => d.hidden);
      if (hidden.length) {
        list.appendChild(el("div", "tagsec", "已删除"));
        hidden.forEach((d) => {
          const base = DATA.tags.find((t) => t.id === d.id);
          const name = d.label || (base && base.label) || d.id;
          const row = el("div", "tagrow gone");
          row.appendChild(el("span", "tname static", name));
          const back = el("button", "ghost sm", "恢复");
          back.onclick = () => { restoreTag(d.id); render(); };
          row.appendChild(back);
          list.appendChild(row);
        });
      }
    };

    addBtn.onclick = () => {
      const label = addName.value.trim();
      if (!label) { addName.focus(); return; }
      if (S.tags.some((t) => t.label === label)) {
        toast("已有同名标签"); addName.focus(); return;
      }
      const id = createTag(label, addColor.value);
      if (!id) return;
      addName.value = "";
      addName.focus();
      render();
      refreshEditor();
      toast("已新增全局标签「" + S.tagById[id].label + "」");
    };
    addName.onkeydown = (e) => { if (e.key === "Enter") addBtn.click(); };

    const close = el("button", "ghost", "关闭");
    close.onclick = () => mask.remove();
    const acts = el("div", "modal-actions");
    acts.appendChild(close);
    box.appendChild(acts);

    mask.appendChild(box);
    mask.addEventListener("click", (e) => { if (e.target === mask) mask.remove(); });
    document.body.appendChild(mask);
    render();
    setTimeout(() => addName.focus(), 30);
  }

  /* ---------------- 行内笔记 ---------------- */
  function toggleNote(id) {
    if (S.openNote === id) { closeNote(); return; }
    if (S.openNote) closeNote();
    if (S.openEditor) closeEditor(S.openEditor);
    if (S.active.size) { S.active.clear(); applyFilter(); }

    S.openNote = id;
    const row = S.rows[id];
    const v = S.byId[id];
    row.classList.add("editing");
    const p = el("div", "np");
    p.dataset.for = id;
    buildNotePanel(p, v);
    row.appendChild(p);
    markSaved();            // 面板进 DOM 之后再刷新状态，否则 .np-status 还查不到
    paintRows();
    svgResize();

    const r = row.getBoundingClientRect();
    if (r.top < 130) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function buildNotePanel(p, v) {
    const bar = el("div", "np-bar");
    bar.appendChild(el("span", "np-label", "笔记"));

    const seg = el("span", "np-seg");
    const bW = el("button", "seg on", "富文本");
    const bS = el("button", "seg", "源码");
    seg.append(bW, bS);
    bar.appendChild(seg);

    bar.appendChild(el("span", "np-status", ""));
    p.appendChild(bar);

    const body = el("div", "np-body");
    p.appendChild(body);

    let cur = v.note || "";
    let ed = null;
    const getMode = () => (localStorage.getItem("pug.noteMode") === "src" ? "src" : "rich");
    const putMode = (m) => { try { localStorage.setItem("pug.noteMode", m); } catch (e) {} };

    function mount() {
      if (ed && typeof ed.getValue === "function") cur = ed.getValue();
      // 同一个 host 反复挂载：不销毁旧编辑器会叠加监听器（切一次模式，Tab 一下跳两级）
      if (ed && typeof ed.destroy === "function") ed.destroy();
      body.textContent = "";
      const m = getMode();
      bW.classList.toggle("on", m === "rich");
      bS.classList.toggle("on", m === "src");
      if (m === "rich") {
        ed = NoteEditor.createRich(body, {
          value: cur,
          onInput: (md) => { cur = md; setNote(v.id, md); },
        });
      } else {
        ed = NoteEditor.createSource(body, {
          value: cur,
          onInput: (md) => { cur = md; setNote(v.id, md); },
        });
      }
      p._editor = ed;
      setTimeout(() => ed.focus(), 30);
    }

    bW.onclick = (e) => { e.stopPropagation(); if (getMode() !== "rich") { putMode("rich"); mount(); } };
    bS.onclick = (e) => { e.stopPropagation(); if (getMode() !== "src") { putMode("src"); mount(); } };

    p.addEventListener("click", (ev) => ev.stopPropagation());
    mount();
  }

  function closeNote() {
    const id = S.openNote;
    if (!id) return;
    S.openNote = null;
    const row = S.rows[id];
    if (row) {
      const p = row.querySelector(".np");
      if (p) {
        if (p._editor && typeof p._editor.destroy === "function") p._editor.destroy();
        p.remove();
      }
      row.classList.remove("editing");
    }
    paintRows();
    svgResize();
  }

  let noteT = null, notePersistT = null;
  function setNote(vid, md) {
    S.dirty = true;
    S.pendingSync = true;
    S.dirtyKeys.add("notes:" + vid);
    const notes = S.manual.notes || (S.manual.notes = {});
    const val = String(md || "").trim();
    if (val) notes[vid] = md; else delete notes[vid];
    S.byId[vid].note = val;
    // 每敲一个字就整份写 localStorage 太浪费；停手后再落盘，pagehide 里还有一次兜底
    clearTimeout(notePersistT);
    notePersistT = setTimeout(persist, 220);
    refreshDirty();
    scheduleSync();
    clearTimeout(noteT);
    noteT = setTimeout(() => svgResize(), 260);
  }

  /* ---------------- pending drawer ---------------- */
  function pendingIntro() {
    const box = el("div", "pi-intro");
    box.appendChild(el("p", null, "这里列出的不是已知引用，而是需要你判断的「提及」。"));

    const p2 = el("p", null, "");
    p2.appendChild(document.createTextNode("视频简介里偶尔出现"));
    p2.appendChild(el("em", null, "「承接之前的内容」「上一期讲过」"));
    p2.appendChild(document.createTextNode(
      "这类说法——能确定它提到了本频道的某个视频，但从字面无法确定是哪一期。系统不去猜，把它放在这里等你决定。"));
    box.appendChild(p2);

    const ul = el("ul");
    [["点「选择目标…」", "进入选目标模式：同系列 / 同标签 / 最近已经排好，点任意一行或搜标题，选中即建立引用。"],
     ["想先看看上下文", "点「定位」跳到该视频所在行（若正被筛选隐藏会自动展开）。"],
     ["确定没有对应视频", "点「忽略」，这条不再出现（记在 manual.json 的 pendingDismissed）。"]
    ].forEach(([k, v]) => {
      const li = el("li");
      li.appendChild(el("b", null, k + "："));
      li.appendChild(document.createTextNode(v));
      ul.appendChild(li);
    });
    box.appendChild(ul);

    box.appendChild(el("p", "dim",
      "当前 " + S.videos.length + " 条简介中命中 " + (S.pending.length + (S.manual.pendingDismissed || []).length) +
      " 处。这位作者几乎不在文字里互引，所以队列通常很短——空着是正常的。"));
    return box;
  }

  function renderPending() {
    const btn = $("#btnPending");
    btn.hidden = !S.pending.length;
    btn.innerHTML = "待确认<span class='cnt'>" + S.pending.length + "</span>";
    const body = $("#drawerBody");
    body.textContent = "";
    $("#drawerSub").textContent = S.pending.length + " 条";
    body.appendChild(pendingIntro());
    if (!S.pending.length) {
      body.appendChild(el("div", "pi-empty", "当前没有待确认项。"));
      return;
    }
    S.pending.forEach((p) => {
      const v = S.byId[p.videoId];
      if (!v) return;
      const box = el("div", "pi");
      const t = el("div", "pi-t");
      const a = el("a", null, v.title);
      a.href = "https://www.youtube.com/watch?v=" + v.id;
      a.target = "_blank"; a.rel = "noopener";
      t.appendChild(a);
      box.appendChild(t);
      box.appendChild(el("div", "pi-m", v.date + " · 命中「" + p.phrase + "」"));
      box.appendChild(el("div", "pi-e", p.evidence));
      const act = el("div", "pi-a");

      const pick = el("button", "ghost sm", "选择目标…");
      pick.onclick = () => {
        $("#drawer").hidden = true;
        jumpToRef(v.id);
        enterPick(v.id, p.videoId);
      };
      act.appendChild(pick);

      const loc = el("button", "ghost sm", "定位");
      loc.onclick = () => {
        $("#drawer").hidden = true;
        jumpToRef(v.id);
      };
      act.appendChild(loc);

      const ig = el("button", "ghost sm", "忽略");
      ig.onclick = () => dismissPending(p.videoId);
      act.appendChild(ig);
      box.appendChild(act);
      body.appendChild(box);
    });
  }

  function dismissPending(vid) {
    S.manual.pendingDismissed = S.manual.pendingDismissed || [];
    if (S.manual.pendingDismissed.indexOf(vid) < 0) S.manual.pendingDismissed.push(vid);
    S.pending = S.pending.filter((p) => p.videoId !== vid);
    persist();
    renderPending(); refreshDirty();
    scheduleSync();
  }

  /* ---------------- misc ---------------- */
  let toastT = null;
  function toast(msg, actLabel, act, ms) {
    const t = $("#toast");
    t.textContent = "";
    t.appendChild(document.createTextNode(msg));
    if (actLabel && act) {
      const b = el("button", "toast-act", actLabel);
      b.onclick = () => {
        t.hidden = true;
        clearTimeout(toastT);
        act();
      };
      t.appendChild(b);
    } else {
      S.undo = null;
    }
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; S.undo = null; }, ms || 2600);
  }

  function refreshPublishBtn() {
    const b = $("#btnPublish");
    if (!b) return;
    const ready = syncReady();
    b.textContent = ready ? "同步" : "启用同步";
    b.className = "ghost" + (ready ? "" : " accent");
  }

  function buildSavePill() {
    const p = el("button", "savepill");
    p.id = "saveState";
    p.type = "button";
    p.append(el("span", "dot"), el("span", "sp-t", ""));
    p.onclick = (e) => { e.stopPropagation(); openPublish(); };
    document.body.appendChild(p);
  }

  function buildDevTools() {
    const box = $("#devTools");
    if (!box) return;
    const pend = el("button", "ghost");
    pend.id = "btnPending"; pend.hidden = true;
    const pub = el("button", "ghost accent", "启用同步");
    pub.id = "btnPublish";
    const exp = el("button", "ghost");
    exp.id = "btnExport"; exp.hidden = true;
    const rst = el("button", "ghost", "重置");
    rst.id = "btnReset"; rst.hidden = true;
    box.append(pend, pub, exp, rst);
    refreshPublishBtn();
  }

  function init() {
    S.pendingSync = !!S.manual._pending;
    document.body.classList.toggle("dev", IS_DEV);
    if (IS_DEV) {
      buildDevTools();
      buildSavePill();
      const chip = $("#modechip");
      if (chip) chip.hidden = false;
    } else {
      const d = $("#drawer");
      if (d) d.remove();
    }

    recompute();
    renderHead();
    renderTags();
    renderList();
    if (IS_DEV) renderPending();
    refreshDirty();
    applyFilter();

    // 选目标模式：整张列表都成为点选目标；捕获阶段拦掉链接跳转与笔记展开
    if (IS_DEV) {
      $("#list").addEventListener("click", (ev) => {
        if (!S.pick) return;
        if (ev.target.closest(".editor")) return;
        const row = ev.target.closest(".row");
        if (!row || !row.dataset.id) return;
        ev.preventDefault();
        ev.stopPropagation();
        const from = S.byId[S.pick.from];
        if (!from) return;
        const id = row.dataset.id;
        if (id === from.id) { toast("这就是当前行，点别的行"); return; }
        if ((from.refs || []).some((r) => r.to === id)) { toast("这两期已经是引用关系"); return; }
        choosePick(S.byId[id]);
      }, true);
    }

    $("#search").addEventListener("input", (e) => {
      S.search = e.target.value.trim().toLowerCase();
      S.active.clear();
      applyFilter();
    });

    if (IS_DEV) {
      $("#btnPublish").onclick = openPublish;
      $("#btnExport").onclick = exportManual;
      $("#btnReset").onclick = () => {
        if (!confirm("放弃本地所有修订（含笔记），恢复到文件版本？已同步到仓库的改动不会回滚。")) return;
        resetting = true;
        S.pendingSync = false;
        clearTimeout(notePersistT);
        try { localStorage.removeItem(LSKEY); } catch (e) {}
        location.reload();
      };
      $("#btnPending").onclick = () => {
        const d = $("#drawer");
        d.hidden = !d.hidden;
      };
      $("#drawerClose").onclick = () => ($("#drawer").hidden = true);
    }

    document.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;   // 输入法组字时的 Esc 不算关闭
      if (e.key !== "Escape") return;
      if (S.pick) { exitPick(); return; }
      if (S.openNote) { closeNote(); return; }
      const d = $("#drawer");
      if (d && !d.hidden) { d.hidden = true; return; }
      if (S.active.size) { S.active.clear(); applyFilter(); }
    });

    let rt;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => { svgResize(); }, 120);
    });
    if (IS_DEV) {
      // 关标签页/切后台时再落一次盘，避免移动端 Safari 不触发 beforeunload
      const flush = () => { if (S.pendingSync) persist(); };
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });

      if (hasLocal()) {
        const c = countEdits();
        updateSaveState();
        toast("已恢复本地修订：笔记 " + c.notes + " · 标签 " + c.tags + " · 引用 " + c.refs);
      }
      updateSaveState();
    }

    // 起页面后再去拉一次线上版本（file:// 下自动跳过）
    hydrateManual().then(() => {
      if (IS_DEV && S.manual._pending && autoSyncOn()) scheduleSync();
    });

    // 切回标签页时再看一眼有没有新版本（公开版也生效）
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") hydrateManual();
    });
  }

  init();
})();
