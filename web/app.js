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
    manual: loadManual(),
    rows: {},
    years: [],
    dirty: false,
  };

  DATA.videos.forEach((v) => (S.byId[v.id] = v));
  DATA.tags.forEach((t) => (S.tagById[t.id] = t));

  /* ---------------- manual overlay ---------------- */
  function emptyManual() {
    return { tags: {}, refs: {}, notes: {}, tagDefs: [], pendingDismissed: [] };
  }
  // 公开版只认构建时写进文件的版本；开发版才叠加浏览器里的暂存
  function loadManual() {
    if (IS_DEV) {
      try {
        const raw = localStorage.getItem(LSKEY);
        if (raw) return Object.assign(emptyManual(), JSON.parse(raw));
      } catch (e) {}
    }
    return window.__MANUAL__ ? Object.assign(emptyManual(), JSON.parse(JSON.stringify(window.__MANUAL__))) : emptyManual();
  }
  const hasLocal = () => {
    try { return !!localStorage.getItem(LSKEY); } catch (e) { return false; }
  };

  function mergeTags(v) {
    const rule = S.manual.tags[v.id] || {};
    const rm = rule.remove || [], ad = rule.add || [];
    let out = (v.autoTags || []).filter((t) => rm.indexOf(t) < 0);
    ad.forEach((t) => {
      if (S.tagById[t] && out.indexOf(t) < 0) out.push(t);
    });
    const hasPlaylist = out.some((t) => S.tagById[t] && S.tagById[t].source === "playlist");
    out = out.filter((t) => t !== "unfiled");
    if (!hasPlaylist) out.push("unfiled");
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

  /* ---------------- header ---------------- */
  function renderHead() {
    const vids = S.videos;
    const first = vids[vids.length - 1].date, last = vids[0].date;
    const edges = vids.reduce((a, v) => a + v.refs.length, 0);
    $("#headmeta").innerHTML =
      "<b>" + S.videos.length + "</b> 期<i>/</i>" + first.slice(0, 4) + "–" + last.slice(0, 4) +
      "<i>/</i><b>" + edges + "</b> 条关联";
    $("#footstat").textContent =
      "排序：发布日期从新到旧 · 共 " + S.videos.length + " 个公开视频 · 生成于 " + DATA.generatedAt;
    $("#footnote").textContent = IS_DEV
      ? "开发版：点行内空白处写笔记，点「编辑」改标签与引用；改动暂存本地，导出后固化"
      : "标签来自频道播放列表；引用按简介链接与系列结构推断";
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
      DATA.tags.filter((t) => t.source === "playlist"),
      DATA.tags.filter((t) => t.source === "manual"),
      DATA.tags.filter((t) => t.source === "system"),
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
        b.title = t.full + "（" + n + " 期）";
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
      a.title = v.title + "（点击打开原视频）";
      ct.appendChild(a);
      ct.appendChild(el("div", "c-note"));
      row.appendChild(ct);

      const cr = el("div", "c-refs");
      row.appendChild(cr);

      if (IS_DEV) {
        row.addEventListener("click", (ev) => {
          if (ev.target.closest("a,.badge,.penbtn,button,.np")) return;
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
      row.title = v.tags.map((t) => (S.tagById[t] ? S.tagById[t].label : t)).join(" · ");

      const cr = row.querySelector(".c-refs");
      cr.textContent = "";
      const mentions = mentionTargets(v);
      if (mentions.length) {
        const b = el("button", "badge mention");
        b.dataset.from = v.id;
        if (mentions.length === 1) {
          const t = S.byId[mentions[0].to], r = mentions[0];
          const why = r.label ? "简介链接：" + r.label : "明确引用：";
          b.title = why + "\n→ " + t.title + "（" + t.date + "）\n点击高亮并连线";
        } else {
          const lines = mentions.slice(0, 4).map((r) => "· " + S.byId[r.to].title).join("\n");
          const more = mentions.length > 4 ? "\n… 共 " + mentions.length + " 个" : "";
          b.title = "明确引用 " + mentions.length + " 个视频\n" + lines + more + "\n点击一并高亮并连线";
        }
        b.setAttribute("aria-label", "查看该行引用");
        b.onclick = (ev) => { ev.stopPropagation(); toggleSource(v.id); };
        cr.appendChild(b);
      }
      if (IS_DEV) {
        const pen = el("button", "penbtn", "编辑");
        pen.title = "改标签与引用";
        pen.onclick = (ev) => { ev.stopPropagation(); toggleEditor(v.id); };
        cr.appendChild(pen);
      }

      row.classList.toggle("has-note", !!v.note);
      const cn = row.querySelector(".c-note");
      if (cn) {
        const show = v.note && S.openNote !== v.id;
        cn.classList.toggle("has", !!show);
        cn.innerHTML = show ? NoteEditor.render(v.note) : "";
        cn.onclick = show && !IS_DEV
          ? (e) => { e.stopPropagation(); cn.classList.toggle("open"); }
          : null;
      }
    });
  }

  /* ---------------- filtering ---------------- */
  function matches(v) {
    if (S.search && v.title.toLowerCase().indexOf(S.search) < 0) return false;
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
      const show = ok || forced.has(v.id);
      const row = S.rows[v.id];
      row.classList.toggle("hidden", !show);
      row.classList.toggle("is-temp", show && !ok);
      if (show) { shown++; yearOn[v.date.slice(0, 4)] = true; }
    });
    S.years.forEach((y) => y.el.classList.toggle("hidden", !yearOn[y.year]));
    $("#footstat").textContent =
      (S.sel.size || S.search ? "筛选后 " + shown + " / " + S.videos.length + " 期" :
        "排序：发布日期从新到旧 · 共 " + S.videos.length + " 个公开视频") + " · 生成于 " + DATA.generatedAt;
    markActive();
    drawFrames();
    drawLinks();
  }

  /* ---------------- references & lines ---------------- */
  function sameSeries(a, b) {
    return !!a.series && a.series === b.series;
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

      // 简介里互相列过链接的同系列视频，在提示里点出来
      const linked = ids.some((id) => {
        const v = S.byId[id];
        return v && v.refs.some((r) => r.type === "mention" && sameSeries(v, S.byId[r.to]));
      });

      const runs = [];
      let run = [rows[0]];
      for (let i = 1; i < rows.length; i++) {
        const prev = run[run.length - 1];
        if (rows[i].offsetTop <= prev.offsetTop + prev.offsetHeight + 2) run.push(rows[i]);
        else { runs.push(run); run = [rows[i]]; }
      }
      runs.push(run);

      const g = svgEl("g", {});
      const t = document.createElementNS(SVGNS, "title");
      t.textContent = "系列：" + name + "（共 " + ids.length + " 期" + (linked ? "，简介中互有链接" : "") + "）";
      g.appendChild(t);

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

  function buildEditor(box, v) {
    box.textContent = "";

    // 标签
    const r1 = el("div", "ed-row");
    r1.appendChild(el("div", "ed-label", "标签"));
    const b1 = el("div", "ed-body");
    DATA.tags.filter((t) => t.source !== "system").forEach((t) => {
      const on = v.tags.indexOf(t.id) >= 0;
      const c = el("button", "tag mini" + (on ? " on" : ""));
      c.style.setProperty("--tc", t.color);
      const sw = el("span", "sw");
      c.append(sw, el("span", null, t.label));
      c.onclick = (ev) => {
        ev.stopPropagation();
        setTag(v.id, t.id, !on);
        buildEditor(box, S.byId[v.id]);
        paintRows(); applyFilter();
      };
      b1.appendChild(c);
    });
    r1.appendChild(b1);
    box.appendChild(r1);

    // 引用
    const r2 = el("div", "ed-row");
    r2.appendChild(el("div", "ed-label", "引用"));
    const b2 = el("div", "ed-body");
    const editRefs = mentionTargets(v);
    const seriesOnly = v.refs.length - editRefs.length;
    if (!editRefs.length) b2.appendChild(el("span", "lg", "暂无跨系列的明确引用"));
    editRefs.forEach((r) => {
      const chip = el("span", "refitem" + (r.type === "series" ? " series" : ""));
      chip.appendChild(el("span", "rdot"));
      const t = S.byId[r.to].title;
      chip.title = t;
      const short = t.length > 18 ? t.slice(0, 18) + "…" : t;
      chip.appendChild(el("span", null, short));
      const x = el("span", "x", "×");
      x.onclick = (ev) => {
        ev.stopPropagation();
        setRef(v.id, r.to, false);
        buildEditor(box, S.byId[v.id]);
        paintRows(); applyFilter();
      };
      chip.appendChild(x);
      b2.appendChild(chip);
    });
    if (seriesOnly > 0) {
      b2.appendChild(el("span", "lg dim", "另有 " + seriesOnly + " 条同系列关系，已由方框归组"));
    }
    r2.appendChild(b2);
    box.appendChild(r2);

    // 添加引用
    const r3 = el("div", "ed-row");
    r3.appendChild(el("div", "ed-label", ""));
    const b3 = el("div", "ed-body");
    const inp = el("input", "refinput");
    inp.placeholder = "输入标题以添加引用…";
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("input", () => showSug(inp, v));
    b3.appendChild(inp);
    r3.appendChild(b3);
    box.appendChild(r3);

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
  }

  let sugBox = null;
  function showSug(inp, v) {
    if (sugBox) sugBox.remove();
    const q = inp.value.trim().toLowerCase();
    if (q.length < 1) return;
    const hits = S.videos
      .filter((x) => x.id !== v.id && !v.refs.some((r) => r.to === x.id))
      .filter((x) => x.title.toLowerCase().indexOf(q) >= 0)
      .slice(0, 40);
    if (!hits.length) return;
    const box = el("div", "sug");
    hits.forEach((x) => {
      const d = el("div");
      d.appendChild(el("span", "sug-d", x.date));
      d.appendChild(document.createTextNode(x.title));
      d.onclick = (ev) => {
        ev.stopPropagation();
        setRef(v.id, x.id, true);
        box.remove(); sugBox = null;
        const ed = S.rows[v.id].querySelector(".editor");
        if (ed) buildEditor(ed, S.byId[v.id]);
        paintRows(); applyFilter();
      };
      box.appendChild(d);
    });
    const r = inp.getBoundingClientRect();
    box.style.position = "absolute";
    box.style.left = window.scrollX + r.left + "px";
    box.style.top = window.scrollY + r.bottom + 4 + "px";
    box.style.position = "fixed";
    box.style.left = r.left + "px";
    box.style.top = r.bottom + 4 + "px";
    document.body.appendChild(box);
    sugBox = box;
  }
  document.addEventListener("click", (e) => {
    if (sugBox && !sugBox.contains(e.target) && !e.target.classList.contains("refinput")) {
      sugBox.remove(); sugBox = null;
    }
  });

  function setTag(vid, tagId, on) {
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

  function setRef(vid, toId, on) {
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
    commit();
  }

  function commit() {
    recompute();
    paintRows();
    Array.from(S.active).forEach((id) => { if (!S.byId[id] || !mentionTargets(S.byId[id]).length) S.active.delete(id); });
    try { localStorage.setItem(LSKEY, JSON.stringify(S.manual)); S.dirty = true; } catch (e) {}
    renderTags();
    refreshDirty();
    applyFilter();
  }

  function refreshDirty() {
    const ex = $("#btnExport"), rs = $("#btnReset");
    if (!ex) return;
    const notes = S.manual.notes || {};
    const n = Object.keys(S.manual.tags).filter((k) => {
      const r = S.manual.tags[k]; return (r.add || []).length || (r.remove || []).length;
    }).length + Object.keys(S.manual.refs).filter((k) => {
      const r = S.manual.refs[k]; return (r.add || []).length || (r.remove || []).length;
    }).length + Object.keys(notes).filter((k) => String(notes[k] || "").trim()).length;
    ex.hidden = !n;
    rs.hidden = !n;
    ex.textContent = "导出修订 (" + n + ")";
  }

  function exportManual() {
    const out = {
      _comment: "人工维护覆盖层。以 YouTube 视频 ID 为索引；构建时与自动数据合并。",
      tags: S.manual.tags, refs: S.manual.refs, notes: S.manual.notes || {},
      tagDefs: S.manual.tagDefs || [],
      pendingDismissed: S.manual.pendingDismissed || [],
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "manual.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("已导出 manual.json —— 放入 data/ 后重新构建即可固化");
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
    paintRows();
    svgResize();

    const r = row.getBoundingClientRect();
    if (r.top < 130) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function buildNotePanel(p, v) {
    const bar = el("div", "np-bar");
    bar.appendChild(el("span", "np-label", "笔记"));
    bar.appendChild(el("span", "np-tip", "Markdown：# 标题　- 列表　> 引用　**粗体**　`代码`"));
    const done = el("button", "ghost sm np-done", "完成");
    done.onclick = (ev) => { ev.stopPropagation(); closeNote(); };
    bar.appendChild(done);
    p.appendChild(bar);

    const body = el("div", "np-body");
    p.appendChild(body);

    const ed = NoteEditor.create(body, {
      value: v.note || "",
      onInput: (md) => setNote(v.id, md),
    });
    p._editor = ed;
    p.addEventListener("click", (ev) => ev.stopPropagation());
    setTimeout(() => ed.focus(), 40);
  }

  function closeNote() {
    const id = S.openNote;
    if (!id) return;
    S.openNote = null;
    const row = S.rows[id];
    if (row) {
      const p = row.querySelector(".np");
      if (p) p.remove();
      row.classList.remove("editing");
    }
    paintRows();
    svgResize();
  }

  let noteT = null;
  function setNote(vid, md) {
    const notes = S.manual.notes || (S.manual.notes = {});
    const val = String(md || "").trim();
    if (val) notes[vid] = md; else delete notes[vid];
    S.byId[vid].note = val;
    try { localStorage.setItem(LSKEY, JSON.stringify(S.manual)); } catch (e) {}
    refreshDirty();
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
    [["有同系列候选时", "在下拉里选一期点「确认」，即建立一条明确引用（蓝色圆点）。"],
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
    btn.title = "查看需要人工确认的提及";
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

      const mates = v.series ? S.videos.filter((x) => x.series === v.series && x.id !== v.id) : [];
      if (mates.length) {
        const sel = el("select");
        sel.appendChild(new Option("关联到同系列的…", ""));
        mates.slice(0, 30).forEach((m) => sel.appendChild(new Option(m.date + " · " + m.title.slice(0, 22), m.id)));
        act.appendChild(sel);
        const ok = el("button", "ghost sm", "确认");
        ok.onclick = () => {
          if (!sel.value) return;
          setRef(v.id, sel.value, true);
          dismissPending(p.videoId);
        };
        act.appendChild(ok);
      } else {
        act.appendChild(el("span", "lg", "没有同系列候选，可点该行的「编辑」手动添加"));
      }

      const loc = el("button", "ghost sm", "定位");
      loc.onclick = () => {
        $("#drawer").hidden = true;
        const row = S.rows[v.id];
        if (row.classList.contains("hidden")) { S.sel.clear(); S.search = ""; $("#search").value = ""; renderTags(); applyFilter(); }
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
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
    try { localStorage.setItem(LSKEY, JSON.stringify(S.manual)); } catch (e) {}
    renderPending(); refreshDirty();
  }

  /* ---------------- misc ---------------- */
  let toastT = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.hidden = true), 2600);
  }

  function buildDevTools() {
    const box = $("#devTools");
    if (!box) return;
    const pend = el("button", "ghost");
    pend.id = "btnPending"; pend.hidden = true;
    const exp = el("button", "ghost");
    exp.id = "btnExport"; exp.hidden = true;
    const rst = el("button", "ghost", "重置");
    rst.id = "btnReset"; rst.hidden = true;
    box.append(pend, exp, rst);
  }

  function init() {
    document.body.classList.toggle("dev", IS_DEV);
    if (IS_DEV) {
      buildDevTools();
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

    $("#search").addEventListener("input", (e) => {
      S.search = e.target.value.trim().toLowerCase();
      S.active.clear();
      applyFilter();
    });

    if (IS_DEV) {
      $("#btnExport").onclick = exportManual;
      $("#btnReset").onclick = () => {
        if (!confirm("放弃本地所有修订（含笔记），恢复到文件版本？")) return;
        localStorage.removeItem(LSKEY);
        location.reload();
      };
      $("#btnPending").onclick = () => {
        const d = $("#drawer");
        d.hidden = !d.hidden;
      };
      $("#drawerClose").onclick = () => ($("#drawer").hidden = true);
    }

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (sugBox) { sugBox.remove(); sugBox = null; return; }
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
    if (IS_DEV && hasLocal()) toast("已载入本地修订（含笔记）");
  }

  init();
})();
