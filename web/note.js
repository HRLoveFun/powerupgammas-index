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
      const lead = (line.match(/^[ \t]*/) || [""])[0].replace(/\t/g, "  ").length;
      const indent = Math.min(3, Math.floor(lead / 2));
      if (/^\s*```/.test(line)) {
        if (inCode) { blocks.push({ t: "code", text: buf.join("\n") }); buf = []; inCode = false; }
        else inCode = true;
        continue;
      }
      if (inCode) { buf.push(line); continue; }
      if (!line.trim()) continue;
      const body = line.replace(/^\s+/, "");
      let m;
      if ((m = body.match(/^(#{1,3})\s+(.*)$/))) blocks.push({ t: "h" + m[1].length, text: m[2], indent: indent });
      else if ((m = body.match(/^[-*]\s+(.*)$/))) blocks.push({ t: "ul", text: m[1], indent: indent });
      else if ((m = body.match(/^\d+\.\s+(.*)$/))) blocks.push({ t: "ol", text: m[1], indent: indent });
      else if ((m = body.match(/^>\s?(.*)$/))) blocks.push({ t: "quote", text: m[1], indent: indent });
      else if (HR.test(body)) blocks.push({ t: "hr", text: "" });
      else blocks.push({ t: "p", text: body, indent: indent });
    }
    if (inCode && buf.length) blocks.push({ t: "code", text: buf.join("\n") });
    if (!blocks.length) blocks.push({ t: "p", text: "" });
    return blocks;
  }

  function blocksToMd(blocks) {
    return blocks.map((b) => {
      const pad = "  ".repeat(b.indent || 0);
      switch (b.t) {
        case "h1": return pad + "# " + b.text;
        case "h2": return pad + "## " + b.text;
        case "h3": return pad + "### " + b.text;
        case "ul": return pad + "- " + b.text;
        case "ol": return pad + "1. " + b.text;
        case "quote": return pad + "> " + b.text;
        case "hr": return pad + "---";
        case "code": return pad + "```\n" + b.text + "\n```";
        default: return pad + b.text;
      }
    }).join("\n");
  }

  function render(md) {
    const blocks = parseMd(md);
    return blocks.map((b) => {
      const ind = (b.indent || 0) * 18;
      const st = ind ? ' style="margin-left:' + ind + 'px"' : "";
      if (b.t === "hr") return '<hr class="ne-hr">';
      if (b.t === "code") return '<pre class="ne-pre"' + st + '><code>' + escapeHtml(b.text) + '</code></pre>';
      const inner = inlineToHtml(b.text);
      if (b.t === "p") return "<p" + st + ">" + inner + "</p>";
      if (b.t === "ul") return "<li" + st + ">" + inner + "</li>";
      if (b.t === "ol") return "<li" + st + ">" + inner + "</li>";
      if (b.t === "quote") return "<blockquote" + st + ">" + inner + "</blockquote>";
      const lv = b.t.slice(1);
      return "<h" + lv + st + ">" + inner + "</h" + lv + ">";
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
      blocks.forEach((b) => host.appendChild(this.makeBlock(b.t, b.text, b.indent || 0)));
      host.addEventListener("keydown", (e) => this.onKeyDown(e));
      host.addEventListener("input", (e) => this.onInputEvent(e));
      host.addEventListener("paste", (e) => this.onPaste(e));
      host.addEventListener("blur", () => this.fire(), true);
      this.renumber();
    }

    makeBlock(type, text, indent) {
      const d = document.createElement("div");
      d.className = "ne-block";
      d.dataset.type = type;
      d.dataset.indent = String(Math.max(0, Math.min(3, indent || 0)));
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
        indent: parseInt(el.dataset.indent || "0", 10),
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

      if (e.key === "Tab") {
        e.preventDefault();
        const cur = parseInt(el.dataset.indent || "0", 10);
        const next = e.shiftKey ? Math.max(0, cur - 1) : Math.min(3, cur + 1);
        el.dataset.indent = String(next);
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


  /* ---------------- 源码编辑器（Markdown + 实时预览） ---------------- */
  function applyIndent(ta, outdent) {
    const v = ta.value;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const lineStart = v.lastIndexOf("\n", s - 1) + 1;
    const multi = v.slice(s, e).indexOf("\n") >= 0;

    if (!multi) {
      if (outdent) {
        const before = v.slice(lineStart, s);
        const m = before.match(/ {1,2}$/);
        if (!m) return;
        ta.value = v.slice(0, s - m[0].length) + v.slice(s);
        ta.setSelectionRange(s - m[0].length, s - m[0].length);
      } else {
        ta.value = v.slice(0, s) + "  " + v.slice(e);
        ta.setSelectionRange(s + 2, s + 2);
      }
      return;
    }

    const block = v.slice(lineStart, e);
    const lines = block.split("\n");
    const changed = lines.map((l) => (outdent ? l.replace(/^ {1,2}/, "") : "  " + l)).join("\n");
    ta.value = v.slice(0, lineStart) + changed + v.slice(e);
    ta.setSelectionRange(lineStart, lineStart + changed.length);
  }

  function createSource(host, opts) {
    opts = opts || {};
    host.classList.add("ns");
    host.textContent = "";

    const ta = document.createElement("textarea");
    ta.className = "ns-src";
    ta.spellcheck = false;
    ta.value = opts.value || "";
    ta.placeholder = opts.placeholder || "写点什么……支持 Markdown：# 标题、- 列表、> 引用、**粗体**、`代码`";

    const withPrev = opts.preview !== false;
    const prev = document.createElement("div");
    prev.className = "ns-prev";
    if (withPrev) host.append(ta, prev); else { host.classList.add("ns-solo"); host.append(ta); }

    const autosize = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(Math.max(ta.scrollHeight, 92), 460) + "px";
    };
    const paint = () => {
      if (withPrev) {
        const v = ta.value;
        prev.innerHTML = v.trim() ? render(v) : '<span class="ns-empty">预览区</span>';
      }
      autosize();
    };

    ta.addEventListener("input", () => {
      paint();
      if (opts.onInput) opts.onInput(ta.value);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      applyIndent(ta, e.shiftKey);
      paint();
      if (opts.onInput) opts.onInput(ta.value);
    });

    paint();
    return {
      getValue: () => ta.value,
      focus: () => setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, 40),
    };
  }


  /* ---------------- 富文本编辑（单一编辑区 + 行首快捷） ---------------- */

  function mdToRichHtml(md) {
    const blocks = parseMd(md);
    let out = "", list = null, listType = "";
    const closeList = () => { if (list) { out += "</" + listType + ">"; list = null; listType = ""; } };
    blocks.forEach((b) => {
      const ind = (b.indent || 0) * 40;
      const st = ind ? ' style="margin-left:' + ind + 'px"' : "";
      const inner = inlineToHtml(b.text || "");
      if (b.t === "hr") { closeList(); out += "<hr>"; return; }
      if (b.t === "code") { closeList(); out += '<pre' + st + '><code>' + escapeHtml(b.text) + "</code></pre>"; return; }
      if (b.t === "ul" || b.t === "ol") {
        const tag = b.t === "ul" ? "ul" : "ol";
        if (listType !== tag) { closeList(); out += "<" + tag + ">"; list = true; listType = tag; }
        out += "<li>" + inner + "</li>";
        return;
      }
      closeList();
      if (b.t === "h1") out += "<h1>" + inner + "</h1>";
      else if (b.t === "h2") out += "<h2>" + inner + "</h2>";
      else if (b.t === "h3") out += "<h3>" + inner + "</h3>";
      else if (b.t === "quote") out += "<blockquote" + st + ">" + inner + "</blockquote>";
      else if (b.text) out += "<p>" + inner + "</p>";
    });
    closeList();
    return out || "<p><br></p>";
  }

  const BLOCK_TAGS = /^(P|DIV|H1|H2|H3|LI|BLOCKQUOTE|PRE|UL|OL|SECTION|ARTICLE)$/;

  function htmlToRichMd(root) {
    const lines = [];
    const inline = (node) => {
      let out = "";
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) { out += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        const tag = n.nodeName.toLowerCase();
        if (tag === "strong" || tag === "b") out += "**" + inline(n) + "**";
        else if (tag === "em" || tag === "i") out += "*" + inline(n) + "*";
        else if (tag === "code") out += "`" + n.textContent + "`";
        else if (tag === "a") out += "[" + n.textContent + "](" + (n.getAttribute("href") || "") + ")";
        else if (tag === "br") out += "\n";
        else out += inline(n);
      });
      return out;
    };
    const indentOf = (el) => {
      const m = (el.style && el.style.marginLeft) || "";
      const px = parseInt(m, 10) || 0;
      return px >= 100 ? 3 : px >= 60 ? 2 : px >= 20 ? 1 : 0;
    };
    const walk = (node, prefix) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) {
          const t = n.nodeValue.replace(/\u00a0/g, " ").trim();
          if (t) lines.push(prefix + t);
          return;
        }
        if (n.nodeType !== 1) return;
        const tag = n.nodeName;
        if (tag === "LI") { lines.push(prefix + "- " + inline(n).trim()); return; }
        if (tag === "UL" || tag === "OL") {
          Array.from(n.children).forEach((li) => {
            if (li.tagName !== "LI") return;
            const pad = "  ".repeat(indentOf(li));
            const marker = tag === "OL" ? "1. " : "- ";
            const inner = Array.from(li.childNodes).filter((c) => c.nodeName !== "UL" && c.nodeName !== "OL");
            const sub = document.createElement("div");
            inner.forEach((c) => sub.appendChild(c.cloneNode(true)));
            const text = inline(sub).trim();
            lines.push(pad + marker + text);
            const nested = Array.from(li.children).filter((c) => c.tagName === "UL" || c.tagName === "OL");
            nested.forEach((nl) => walk(nl, pad + "  "));
          });
          return;
        }
        if (tag === "H1") { lines.push("# " + inline(n)); return; }
        if (tag === "H2") { lines.push("## " + inline(n)); return; }
        if (tag === "H3") { lines.push("### " + inline(n)); return; }
        if (tag === "BLOCKQUOTE") { lines.push("> " + inline(n)); return; }
        if (tag === "PRE") { lines.push("```\n" + n.textContent + "\n```"); return; }
        if (tag === "HR") { lines.push("---"); return; }
        if (BLOCK_TAGS.test(tag)) {
          // 里面还有块级子元素（如 <div><ul>…）时继续下钻，别把整块当一段文本
          const hasBlock = Array.from(n.children).some((c) => BLOCK_TAGS.test(c.nodeName));
          if (hasBlock) { walk(n, prefix); return; }
          const text = inline(n).trim();
          if (text) lines.push(prefix + text);
          return;
        }
        const t = inline(n).trim();
        if (t) lines.push(prefix + t);
      });
    };
    walk(root, "");
    return lines.join("\n");
  }

  const SHORTCUTS = [
    [/^(#{1,3})\s+([\s\S]*)$/, (m) => ({ block: "h" + m[1].length, rest: m[2] })],
    [/^[-*]\s+([\s\S]*)$/, (m) => ({ list: "ul", rest: m[1] })],
    [/^(\d+)\.\s+([\s\S]*)$/, (m) => ({ list: "ol", rest: m[2] })],
    [/^>\s+([\s\S]*)$/, (m) => ({ block: "blockquote", rest: m[1] })],
    [/^```$/, () => ({ block: "pre", rest: "" })],
  ];

  function createRich(host, opts) {
    opts = opts || {};
    host.classList.add("rich");
    host.setAttribute("contenteditable", "true");
    host.setAttribute("spellcheck", "false");
    host.innerHTML = mdToRichHtml(opts.value || "");
    if (!host.innerHTML.trim()) host.innerHTML = "<p><br></p>";

    const emit = () => { if (opts.onInput) opts.onInput(htmlToRichMd(host)); };

    const currentBlock = () => {
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      let n = sel.anchorNode;
      if (n && n.nodeType === 3) n = n.parentNode;
      while (n && n !== host && !BLOCK_TAGS.test(n.nodeName)) n = n.parentNode;
      return n === host ? null : n;
    };

    const applyShortcut = (block, act) => {
      if (!block || !block.isConnected) return;
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(block);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete");
      if (act.list) {
        document.execCommand(act.list === "ul" ? "insertUnorderedList" : "insertOrderedList");
      } else {
        document.execCommand("formatBlock", false, act.block);
      }
      if (act.rest) document.execCommand("insertText", false, act.rest);
      emit();
    };

    const onInput = () => {
      const sel = window.getSelection();
      if (!sel.rangeCount) { emit(); return; }
      const block = currentBlock();
      if (block) {
        const text = block.textContent || "";
        const r = sel.getRangeAt(0);
        const atEnd = r.endOffset === (r.endContainer.nodeType === 3 ? r.endContainer.nodeValue.length : r.endContainer.childNodes.length);
        if (atEnd) {
          for (const [re, fn] of SHORTCUTS) {
            const m = re.exec(text);
            if (!m) continue;
            const act = fn(m);
            // 放到事件循环之后执行：input 事件里直接改 DOM 会被浏览器忽略
            setTimeout(() => applyShortcut(block, act), 0);
            break;
          }
        }
      }
      emit();
    };

    const onKey = (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        document.execCommand(e.shiftKey ? "outdent" : "indent");
        emit();
      }
    };

    host.addEventListener("input", onInput);
    host.addEventListener("keydown", onKey);
    host.addEventListener("blur", emit);

    return {
      getValue: () => htmlToRichMd(host),
      focus: () => setTimeout(() => {
        host.focus();
        const r = document.createRange();
        r.selectNodeContents(host);
        r.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }, 40),
    };
  }

  global.NoteEditor = {
    render, parseMd, blocksToMd, inlineToHtml, Editor,
    create(host, opts) { return new Editor(host, opts); },
    createSource,
    createRich,
    isEmpty(md) { return !String(md || "").trim(); },
  };
})(window);
