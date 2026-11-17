/*
 * 笔记模块：Markdown 子集 + Notion 风格的块编辑器
 *
 * 支持：
 *   # / ## / ###  标题      - 或 *  无序列表     1.  有序列表
 *   >  引用         ```  代码块        ---  分隔线
 *   **粗体**  *斜体*  `行内代码`  [文字](链接)
 *
 * 用法：
 *   NoteEditor.render(md)              -> HTML 字符串（只读展示）
 *   new NoteEditor(host, {value, onInput, placeholder})
 *   .getValue() / .focus() / .destroy()
 */
(function (global) {
  "use strict";

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- 行内 markdown <-> html ---------------- */

  function inlineToHtml(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, (m, a) => "<code>" + a + "</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, (m, a) => "<strong>" + a + "</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, (m, p1, a) => p1 + "<em>" + a + "</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (m, t, u) => '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>");
    return s;
  }

  function inlineToMd(node) {
    let out = "";
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const tag = n.nodeName.toLowerCase();
      if (tag === "strong" || tag === "b") out += "**" + inlineToMd(n) + "**";
      else if (tag === "em" || tag === "i") out += "*" + inlineToMd(n) + "*";
      else if (tag === "code") out += "`" + n.textContent + "`";
      else if (tag === "a") out += "[" + n.textContent + "](" + (n.getAttribute("href") || "") + ")";
      else if (tag === "br") out += "\n";
      else out += inlineToMd(n);
    });
    return out;
  }

  /* ---------------- 块级 markdown ---------------- */

  const HR = /^\s*([-*_])\1{2,}\s*$/;

  function parseMd(md) {
    const lines = String(md || "").replace(/\r/g, "").split("\n");
    const blocks = [];
    let inCode = false, buf = [];
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (inCode) { blocks.push({ t: "code", text: buf.join("\n") }); buf = []; inCode = false; }
        else inCode = true;
        continue;
      }
      if (inCode) { buf.push(line); continue; }
      if (!line.trim()) continue;
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) blocks.push({ t: "h" + m[1].length, text: m[2] });
      else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) blocks.push({ t: "ul", text: m[1] });
      else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) blocks.push({ t: "ol", text: m[1] });
      else if ((m = line.match(/^>\s?(.*)$/))) blocks.push({ t: "quote", text: m[1] });
      else if (HR.test(line)) blocks.push({ t: "hr", text: "" });
      else blocks.push({ t: "p", text: line });
    }
    if (inCode && buf.length) blocks.push({ t: "code", text: buf.join("\n") });
    if (!blocks.length) blocks.push({ t: "p", text: "" });
    return blocks;
  }

  function blocksToMd(blocks) {
    return blocks.map((b) => {
      switch (b.t) {
        case "h1": return "# " + b.text;
        case "h2": return "## " + b.text;
        case "h3": return "### " + b.text;
        case "ul": return "- " + b.text;
        case "ol": return "1. " + b.text;
        case "quote": return "> " + b.text;
        case "hr": return "---";
        case "code": return "```\n" + b.text + "\n```";
        default: return b.text;
      }
    }).join("\n");
  }

  function render(md) {
    const blocks = parseMd(md);
    return blocks.map((b) => {
      if (b.t === "hr") return '<hr class="ne-hr">';
      if (b.t === "code") return '<pre class="ne-pre"><code>' + escapeHtml(b.text) + "</code></pre>";
      const inner = inlineToHtml(b.text);
      if (b.t === "p") return "<p>" + inner + "</p>";
      if (b.t === "ul") return "<li>" + inner + "</li>";
      if (b.t === "ol") return "<li>" + inner + "</li>";
      if (b.t === "quote") return "<blockquote>" + inner + "</blockquote>";
      const lv = b.t.slice(1);
      return "<h" + lv + ">" + inner + "</h" + lv + ">";
    }).join("");
  }

  /* ---------------- 编辑器 ---------------- */

  // 行首标记 -> 块类型；允许标记后直接跟着内容（粘贴、连续输入也能识别）
  const SHORTCUT = [
    [/^(#{1,3})\s+([\s\S]*)$/, (m) => ({ t: "h" + m[1].length, rest: m[2] })],
    [/^[-*]\s+([\s\S]*)$/, (m) => ({ t: "ul", rest: m[1] })],
    [/^(\d+)\.\s+([\s\S]*)$/, (m) => ({ t: "ol", rest: m[2] })],
    [/^>\s+([\s\S]*)$/, (m) => ({ t: "quote", rest: m[1] })],
  ];

  function caretAtStart(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(el);
    r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    return r.toString().length === 0;
  }

  function caretAtEnd(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return false;
    const after = document.createRange();
    after.selectNodeContents(el);
    after.setStart(r.endContainer, r.endOffset);
    return after.toString().length === 0;
  }

  function focusEnd(el) {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  class Editor {
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.onInput = this.opts.onInput || function () {};
      host.classList.add("ne");
      host.textContent = "";
      const blocks = parseMd(this.opts.value || "");
      blocks.forEach((b) => host.appendChild(this.makeBlock(b.t, b.text)));
      host.addEventListener("keydown", (e) => this.onKeyDown(e));
      host.addEventListener("input", (e) => this.onInputEvent(e));
      host.addEventListener("paste", (e) => this.onPaste(e));
      host.addEventListener("blur", () => this.fire(), true);
      this.renumber();
    }

    makeBlock(type, text) {
      const d = document.createElement("div");
      d.className = "ne-block";
      d.dataset.type = type;
      d.setAttribute("contenteditable", "true");
      if (type === "hr") { d.setAttribute("contenteditable", "false"); d.textContent = ""; }
      else d.innerHTML = inlineToHtml(text || "");
      return d;
    }

    renumber() {
      let n = 0;
      this.blocks().forEach((b) => {
        if (b.dataset.type === "ol") { n += 1; b.dataset.idx = n; }
        else n = 0;
      });
    }

    blocks() {
      return Array.from(this.host.querySelectorAll(".ne-block"));
    }

    blockOf(node) {
      const el = node && node.nodeType === 1 ? node : node && node.parentElement;
      return el ? el.closest(".ne-block") : null;
    }

    getValue() {
      const bs = this.blocks().map((el) => ({
        t: el.dataset.type,
        text: el.dataset.type === "code" ? el.textContent : inlineToMd(el),
      }));
      return blocksToMd(bs.filter((b) => b.t === "hr" || b.t === "code" || b.text.trim() !== ""));
    }

    focus() {
      const first = this.blocks()[0];
      if (first) focusEnd(first);
    }

    destroy() { this.host.textContent = ""; }

    fire() { this.onInput(this.getValue()); }

    onInputEvent(e) {
      const el = this.blockOf(e.target);
      if (!el) return;

      // Markdown 快捷输入：`# ` → 标题，`- ` → 列表，`> ` → 引用，`1. ` → 有序
      if (el.dataset.type === "p" && caretAtEnd(el)) {
        const txt = el.textContent;
        for (const [re, fn] of SHORTCUT) {
          const m = re.exec(txt);
          if (m) {
            const r = fn(m);
            el.dataset.type = r.t;
            el.textContent = r.rest;
            focusEnd(el);
            break;
          }
        }
      }

      // 行内格式：在光标位于行尾时把 **粗体** 之类转成真实标签
      if (el.dataset.type !== "code" && el.dataset.type !== "hr" && caretAtEnd(el)) {
        const raw = inlineToMd(el);
        const html = inlineToHtml(raw);
        if (html !== el.innerHTML && /\*\*|`|\[[^\]]*\]\(/.test(raw)) {
          el.innerHTML = html;
          focusEnd(el);
        }
      }
      this.renumber();
      this.fire();
    }

    onKeyDown(e) {
      const el = this.blockOf(e.target);
      if (!el) return;

      if (e.key === "Enter" && !e.shiftKey) {
        if (el.dataset.type === "code" || el.dataset.type === "hr") return;
        e.preventDefault();
        const isList = el.dataset.type === "ul" || el.dataset.type === "ol" || el.dataset.type === "quote";
        const nextType = isList ? el.dataset.type : "p";
        // 空列表项回车 -> 退出列表
        if (isList && el.textContent.trim() === "") {
          el.dataset.type = "p";
          return;
        }
        const nb = this.makeBlock(nextType, "");
        el.after(nb);
        focusEnd(nb);
        this.renumber();
        this.fire();
        return;
      }

      if (e.key === "`" && el.dataset.type === "p" && el.textContent === "``") {
        e.preventDefault();
        el.dataset.type = "code";
        el.textContent = "";
        this.fire();
        return;
      }

      if (e.key === "Backspace") {
        const prev = el.previousElementSibling;
        const empty = el.textContent.trim() === "";
        if (el.dataset.type !== "p" && empty && caretAtStart(el)) {
          e.preventDefault();
          el.dataset.type = "p";
          this.renumber();
          this.fire();
          return;
        }
        if (!caretAtStart(el)) { this.fire(); return; }
        if (!prev) return;
        e.preventDefault();
        if (empty) {
          el.remove();
          focusEnd(prev);
        } else {
          const frag = document.createDocumentFragment();
          while (el.firstChild) frag.appendChild(el.firstChild);
          prev.appendChild(frag);
          el.remove();
          focusEnd(prev);
        }
        this.fire();
      }
    }

    onPaste(e) {
      const el = this.blockOf(e.target);
      if (!el) return;
      const text = (e.clipboardData || window.clipboardData).getData("text/plain");
      if (!text) return;
      e.preventDefault();
      // 多行粘贴：按行拆成新块
      const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
      if (lines.length <= 1) {
        document.execCommand("insertText", false, text);
        return;
      }
      const frag = document.createDocumentFragment();
      lines.forEach((ln) => frag.appendChild(this.makeBlock("p", ln)));
      el.after(frag);
      this.fire();
    }
  }

  global.NoteEditor = {
    render, parseMd, blocksToMd, inlineToHtml, Editor,
    create(host, opts) { return new Editor(host, opts); },
    isEmpty(md) { return !String(md || "").trim(); },
  };
})(window);
