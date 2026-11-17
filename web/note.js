/*
 * 笔记模块：Markdown 子集 + 单一编辑区的富文本编辑器
 *
 * 支持：
 *   # / ## / ###  标题      - 或 *  无序列表     1.  有序列表
 *   >  引用         ```  代码块        ---  分隔线
 *   **粗体**  *斜体*  `行内代码`  [文字](链接)
 *
 * 用法：
 *   NoteEditor.render(md)                     -> HTML 字符串（只读展示）
 *   NoteEditor.createRich(host, {value, onInput, placeholder})
 *   NoteEditor.createSource(host, {value, onInput, placeholder})
 *   .getValue() / .focus() / .destroy()
 *
 * 内容始终以 Markdown 落盘；两个编辑器共用同一份文本。
 * 行首标记（# - > 1. ```）在输入时即时转换；行内格式在离开编辑区时统一渲染。
 */
(function (global) {
  "use strict";

  const INDENT_PX = 18;   // 每级缩进的像素数（列表嵌套的视觉宽度）

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- 行内 markdown <-> html ---------------- */

  // 只放行 http(s) / mailto / tel、站内相对路径；其余带 scheme 的一律当普通文字。
  function safeHref(u) {
    const s = String(u).replace(/[\u0000-\u0020\u007f]/g, "");
    if (/^(https?:|mailto:|tel:)/i.test(s)) return true;
    if (/^[#/]/.test(s) || /^\.{1,2}\//.test(s)) return true;
    return !/^[a-z][a-z0-9+.-]*:/i.test(s);
  }

  function inlineToHtml(text) {
    let s = escapeHtml(text).replace(/\u0000/g, "");
    // 行内代码先抽成占位符，避免里面的 ** 被当粗体
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, a) => {
      codes.push(a);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // 星号紧贴内容才算斜体，`3 * 4 * 5` 不再被吃成 <em>
    s = s.replace(/(^|[^*])\*(\S(?:[^*\n]*?\S)?)\*(?!\*)/g, "$1<em>$2</em>");
    // URL 允许一层成对括号，wiki 那种 Foo_(bar) 不再被截断
    s = s.replace(/\[([^\]]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g, (m, t, u) =>
      safeHref(u) ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + "</a>" : t);
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + codes[+i] + "</code>");
    return s;
  }

  // 代码里的反引号比外层多一个，内容才不会被截断
  function codeSpan(text) {
    const runs = String(text).match(/`+/g) || [];
    const max = runs.reduce((a, s) => Math.max(a, s.length), 0);
    const fence = "`".repeat(max + 1);
    return max ? fence + " " + text + " " + fence : fence + text + fence;
  }

  function inlineToMd(node) {
    let out = "";
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const tag = n.nodeName.toLowerCase();
      if (tag === "strong" || tag === "b") out += "**" + inlineToMd(n) + "**";
      else if (tag === "em" || tag === "i") out += "*" + inlineToMd(n) + "*";
      else if (tag === "code") out += codeSpan(n.textContent);
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
      else if ((m = body.match(/^(\d+)\.\s+(.*)$/))) blocks.push({ t: "ol", text: m[2], n: parseInt(m[1], 10) || 1, indent: indent });
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
        case "ol": return pad + (b.n || 1) + ". " + b.text;
        case "quote": return pad + "> " + b.text;
        case "hr": return pad + "---";
        case "code": return pad + "```\n" + b.text + "\n```";
        default: return pad + b.text;
      }
    }).join("\n");
  }

  // 只读渲染：连续列表项包进同一个 ul/ol，序号与缩进才正常
  function render(md) {
    const blocks = parseMd(md);
    let out = "", open = "";
    const close = () => { if (open) { out += "</" + open + ">"; open = ""; } };
    blocks.forEach((b) => {
      const ind = (b.indent || 0) * INDENT_PX;
      const st = ind ? ' style="margin-left:' + ind + 'px"' : "";
      if (b.t === "ul" || b.t === "ol") {
        if (open !== b.t) {
          close();
          out += "<" + b.t + (b.t === "ol" && b.n > 1 ? ' start="' + b.n + '"' : "") + ">";
          open = b.t;
        }
        out += "<li" + st + ">" + inlineToHtml(b.text) + "</li>";
        return;
      }
      close();
      if (b.t === "hr") { out += "<hr>"; return; }
      if (b.t === "code") { out += "<pre" + st + "><code>" + escapeHtml(b.text) + "</code></pre>"; return; }
      const inner = inlineToHtml(b.text);
      if (b.t === "p") { out += "<p" + st + ">" + inner + "</p>"; return; }
      if (b.t === "quote") { out += "<blockquote" + st + ">" + inner + "</blockquote>"; return; }
      const lv = b.t.slice(1);
      out += "<h" + lv + st + ">" + inner + "</h" + lv + ">";
    });
    close();
    return out;
  }

  /* ---------------- 富文本编辑（单一编辑区 + 行首快捷） ---------------- */

  function mdToRichHtml(md) {
    const blocks = parseMd(md);
    let out = "", openTag = "";
    const closeList = () => { if (openTag) { out += "</" + openTag + ">"; openTag = ""; } };
    blocks.forEach((b) => {
      const ind = (b.indent || 0) * INDENT_PX;
      const st = ind ? ' data-indent="' + (b.indent || 0) + '" style="margin-left:' + ind + 'px"' : "";
      const inner = inlineToHtml(b.text || "");
      if (b.t === "hr") { closeList(); out += "<hr>"; return; }
      if (b.t === "code") { closeList(); out += "<pre" + st + "><code>" + escapeHtml(b.text) + "</code></pre>"; return; }
      if (b.t === "ul" || b.t === "ol") {
        if (openTag !== b.t) {
          closeList();
          out += "<" + b.t + (b.t === "ol" && b.n > 1 ? ' start="' + b.n + '"' : "") + ">";
          openTag = b.t;
        }
        out += "<li" + st + ">" + inner + "</li>";
        return;
      }
      closeList();
      if (b.t === "h1") out += "<h1" + st + ">" + inner + "</h1>";
      else if (b.t === "h2") out += "<h2" + st + ">" + inner + "</h2>";
      else if (b.t === "h3") out += "<h3" + st + ">" + inner + "</h3>";
      else if (b.t === "quote") out += "<blockquote" + st + ">" + inner + "</blockquote>";
      else if (b.text) out += "<p" + st + ">" + inner + "</p>";
    });
    closeList();
    return out || "<p><br></p>";
  }

  const BLOCK_TAGS = /^(P|DIV|H1|H2|H3|LI|BLOCKQUOTE|PRE|SECTION|ARTICLE)$/;
  const LIST_TAGS = /^(UL|OL)$/;

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
        else if (tag === "code") out += codeSpan(n.textContent);
        else if (tag === "a") out += "[" + n.textContent + "](" + (n.getAttribute("href") || "") + ")";
        else if (tag === "br") out += "\n";
        else out += inline(n);
      });
      return out;
    };
    const indentOf = (el) => {
      const attr = el.dataset && el.dataset.indent;
      if (attr != null && attr !== "") return Math.max(0, Math.min(3, parseInt(attr, 10) || 0));
      const px = parseInt((el.style && el.style.marginLeft) || "", 10) || 0;
      return px >= INDENT_PX * 3 ? 3 : px >= INDENT_PX * 2 ? 2 : px >= INDENT_PX ? 1 : 0;
    };
    const padOf = (el) => "  ".repeat(indentOf(el));
    // contenteditable 里按回车插的是 <br>，textContent 会把它当没有 -> 换行丢失
    const preText = (pre) => {
      const clone = pre.cloneNode(true);
      Array.from(clone.querySelectorAll("br")).forEach((br) => br.replaceWith("\n"));
      return clone.textContent.replace(/\u00a0/g, " ");
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
          let num = parseInt(n.getAttribute("start"), 10) || 1;
          Array.from(n.children).forEach((li) => {
            if (li.tagName !== "LI") return;
            const pad = "  ".repeat(indentOf(li));
            const marker = tag === "OL" ? (num++) + ". " : "- ";
            const inner = Array.from(li.childNodes).filter((c) => !LIST_TAGS.test(c.nodeName));
            const sub = document.createElement("div");
            inner.forEach((c) => sub.appendChild(c.cloneNode(true)));
            const text = inline(sub).trim();
            lines.push(pad + marker + text);
            Array.from(li.children).filter((c) => LIST_TAGS.test(c.tagName)).forEach((nl) => walk(nl, pad + "  "));
          });
          return;
        }
        if (tag === "H1") { lines.push(padOf(n) + "# " + inline(n)); return; }
        if (tag === "H2") { lines.push(padOf(n) + "## " + inline(n)); return; }
        if (tag === "H3") { lines.push(padOf(n) + "### " + inline(n)); return; }
        if (tag === "BLOCKQUOTE") { lines.push(padOf(n) + "> " + inline(n)); return; }
        if (tag === "PRE") { lines.push("```\n" + preText(n) + "\n```"); return; }
        if (tag === "HR") { lines.push("---"); return; }
        if (BLOCK_TAGS.test(tag)) {
          // 里面还有块级子元素（如 <div><ul>…）时继续下钻，别把整块当一段文本
          const hasBlock = Array.from(n.children).some((c) => BLOCK_TAGS.test(c.nodeName) || LIST_TAGS.test(c.nodeName));
          if (hasBlock) { walk(n, prefix); return; }
          const text = inline(n).trim();
          if (text) lines.push((prefix || padOf(n)) + text);
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

  // 删掉块开头 n 个可见字符（只动文字节点，保留里面的粗体/链接）
  function stripPrefix(block, n) {
    let remain = n;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    while (remain > 0 && (node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (len <= remain) { remain -= len; node.nodeValue = ""; }
      else { node.nodeValue = node.nodeValue.slice(remain); remain = 0; }
    }
    block.normalize();
  }

  function placeCaret(host, node) {
    host.focus();
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function createRich(host, opts) {
    opts = opts || {};
    host.classList.add("rich");
    host.setAttribute("contenteditable", "true");
    host.setAttribute("spellcheck", "false");
    host.innerHTML = mdToRichHtml(opts.value || "");
    if (!host.innerHTML.trim()) host.innerHTML = "<p><br></p>";

    const syncEmpty = () => host.classList.toggle("is-empty", !host.textContent.trim() && !host.querySelector("pre,hr"));
    const emit = () => { syncEmpty(); if (opts.onInput) opts.onInput(htmlToRichMd(host)); };
    syncEmpty();

    const caretRange = () => {
      const sel = window.getSelection();
      return sel.rangeCount ? sel.getRangeAt(0) : null;
    };
    const blockAtCaret = () => {
      const r = caretRange();
      if (!r) return null;
      let n = r.endContainer;
      if (n && n.nodeType === 3) n = n.parentNode;
      while (n && n !== host) {
        if (n.nodeType === 1) {
          if (LIST_TAGS.test(n.nodeName)) return null;
          if (BLOCK_TAGS.test(n.nodeName)) return n;
        }
        n = n.parentNode;
      }
      return null;
    };
    const atEndOf = (block, r) => {
      if (!block.contains(r.endContainer)) return false;
      const probe = document.createRange();
      probe.selectNodeContents(block);
      probe.setStart(r.endContainer, r.endOffset);
      return probe.toString().length === 0;
    };

    // 直接把块换成目标结构：不再「清空内容再 execCommand」，避免 <p><ul> 这种非法嵌套
    const applyShortcut = (block, act, prefixLen) => {
      if (!block || !block.isConnected) return;
      stripPrefix(block, prefixLen);
      // 已经是列表项：只去掉标记，别再往里套一层列表/标题
      if (block.tagName === "LI") { emit(); return; }
      const tag = act.list || act.block;
      const isList = tag === "ul" || tag === "ol";
      const wrap = document.createElement(tag);
      const holder = isList ? document.createElement("li") : wrap;
      if (isList) wrap.appendChild(holder);
      while (block.firstChild) holder.appendChild(block.firstChild);
      if (!holder.firstChild) holder.appendChild(document.createElement("br"));
      block.replaceWith(wrap);
      placeCaret(host, holder);
      emit();
    };

    const onInput = () => {
      const r = caretRange();
      if (!r) { emit(); return; }
      const block = blockAtCaret();
      if (block && atEndOf(block, r)) {
        const text = block.textContent || "";
        for (const [re, fn] of SHORTCUTS) {
          const m = re.exec(text);
          if (!m) continue;
          const act = fn(m);
          const prefixLen = text.length - (act.rest || "").length;
          // 放到事件循环之后执行：input 事件里直接改 DOM 会被浏览器忽略
          setTimeout(() => applyShortcut(block, act, prefixLen), 0);
          break;
        }
      }
      emit();
    };

    // 行内格式（**粗体**、`代码`、[文字](链接)）在离开编辑区时统一渲染，
    // 输入过程中不动 DOM，输入法与撤销都不会被打断。
    const normalize = () => {
      const html = mdToRichHtml(htmlToRichMd(host));
      if (html && html !== host.innerHTML) host.innerHTML = html;
    };

    const onFocusOut = (e) => {
      if (e.relatedTarget && host.contains(e.relatedTarget)) return;
      normalize();
      emit();
    };

    const onKey = (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const block = blockAtCaret() || host.lastElementChild;
      if (!block) return;
      const attr = block.dataset.indent;
      const px = parseInt((block.style && block.style.marginLeft) || "", 10) || 0;
      const cur = attr != null && attr !== "" ? (parseInt(attr, 10) || 0)
        : (px >= INDENT_PX * 3 ? 3 : px >= INDENT_PX * 2 ? 2 : px >= INDENT_PX ? 1 : 0);
      const next = Math.max(0, Math.min(3, e.shiftKey ? cur - 1 : cur + 1));
      block.dataset.indent = String(next);
      block.style.marginLeft = next ? next * INDENT_PX + "px" : "";
      emit();
    };

    host.addEventListener("input", onInput);
    host.addEventListener("keydown", onKey);
    host.addEventListener("focusout", onFocusOut);

    return {
      getValue: () => htmlToRichMd(host),
      focus: () => setTimeout(() => {
        host.focus();
        const first = host.firstElementChild;
        const sel = window.getSelection();
        sel.removeAllRanges();
        if (!first) return;
        const r = document.createRange();
        r.selectNodeContents(first);
        r.collapse(true);
        sel.addRange(r);
      }, 40),
      destroy: () => {
        host.removeEventListener("input", onInput);
        host.removeEventListener("keydown", onKey);
        host.removeEventListener("focusout", onFocusOut);
        host.classList.remove("rich", "is-empty");
        host.removeAttribute("contenteditable");
        host.removeAttribute("spellcheck");
        host.textContent = "";
      },
    };
  }

  /* ---------------- 源码编辑器（纯 Markdown 文本域） ---------------- */

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
    host.append(ta);

    const autosize = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(Math.max(ta.scrollHeight, 92), 460) + "px";
    };

    const onInput = () => {
      autosize();
      if (opts.onInput) opts.onInput(ta.value);
    };
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      applyIndent(ta, e.shiftKey);
      autosize();
      if (opts.onInput) opts.onInput(ta.value);
    };

    ta.addEventListener("input", onInput);
    ta.addEventListener("keydown", onKey);

    autosize();
    return {
      getValue: () => ta.value,
      focus: () => setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, 40),
      destroy: () => {
        ta.removeEventListener("input", onInput);
        ta.removeEventListener("keydown", onKey);
        host.classList.remove("ns");
        host.textContent = "";
      },
    };
  }

  global.NoteEditor = {
    render, parseMd, blocksToMd, inlineToHtml,
    createRich,
    createSource,
    isEmpty(md) { return !String(md || "").trim(); },
  };
})(window);
