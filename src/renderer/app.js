// Producer -- renderer

const fs = require("fs");
const path = require("path");
const { Terminal } = require("@xterm/xterm");
const { FitAddon } = require("@xterm/addon-fit");
const { WebLinksAddon } = require("@xterm/addon-web-links");
const { marked } = require("marked");
const mammoth = require("mammoth");
marked.setOptions({ gfm: true, breaks: true });

const DEFAULT_DIR =
  "/Users/eytan/Davidovits & Co Dropbox/Eytan Davidovits/eytan-os";

// Light terminal theme -- blends with the app, text feels native
const TERM_THEME = {
  background: "#faf9f8",
  foreground: "#1c1917",
  cursor: "#1c1917",
  cursorAccent: "#faf9f8",
  selectionBackground: "#fed7aa80",
  selectionForeground: "#1c1917",
  black: "#1c1917",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#1e40af",
  magenta: "#6b21a8",
  cyan: "#155e75",
  white: "#d6d3d1",
  brightBlack: "#57534e",
  brightRed: "#dc2626",
  brightGreen: "#15803d",
  brightYellow: "#a16207",
  brightBlue: "#1d4ed8",
  brightMagenta: "#7e22ce",
  brightCyan: "#0e7490",
  brightWhite: "#f5f5f4",
};

// ─── Sessions / Tabs ───

const sessions = [];
let activeSessionIdx = -1;

const tabStrip = document.getElementById("tab-strip");
const terminalBody = document.getElementById("terminal-body");

function getDefaultSessionName(idx) {
  return "Session " + (idx + 1);
}

function truncateTabName(text) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 20) return trimmed;
  return trimmed.slice(0, 18).trimEnd() + "...";
}

async function createTab(name) {
  const id = await window.ipc.invoke("session:create", DEFAULT_DIR);
  const defaultName = getDefaultSessionName(sessions.length);

  const container = document.createElement("div");
  container.className = "terminal-session";
  container.dataset.sessionId = id;
  terminalBody.appendChild(container);

  const term = new Terminal({
    fontFamily: '"Geist Mono", "SF Mono", Menlo, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 1.5,
    theme: TERM_THEME,
    scrollback: 10000,
    overviewRulerWidth: 0,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(container);

  // Gate keyboard handling during rename
  term.attachCustomKeyEventHandler(() => !isRenaming);

  const session = {
    id,
    name: name || defaultName,
    named: !!name && name !== defaultName,
    term,
    fitAddon,
    container,
    pendingInput: "",
    hasCapturedFirstPrompt: false,
  };

  term.onData((data) => {
    window.ipc.send("terminal:input", { id, data });

    if (session.named || session.hasCapturedFirstPrompt) return;

    if (data === "\r") {
      const candidate = session.pendingInput.trim().replace(/\s+/g, " ");
      if (candidate.startsWith("/")) {
        session.pendingInput = "";
        return;
      }
      if (candidate.split(" ").filter(Boolean).length >= 2) {
        session.hasCapturedFirstPrompt = true;
        session.name = truncateTabName(candidate);
        session.named = true;
        session.animateName = true;
        renderTabs();
      }
      session.pendingInput = "";
      return;
    }

    if (data === "\u007f") {
      session.pendingInput = session.pendingInput.slice(0, -1);
      return;
    }

    if (data.startsWith("\x1b")) return;

    const printable = data.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    if (!printable) return;
    session.pendingInput += printable;
  });

  sessions.push(session);

  renderTabs();
  activateTab(sessions.length - 1);
  return session;
}

function activateTab(idx) {
  if (idx < 0 || idx >= sessions.length) return;
  activeSessionIdx = idx;

  sessions.forEach((s, i) => {
    s.container.classList.toggle("active", i === idx);
  });

  renderTabs();

  requestAnimationFrame(() => {
    const s = sessions[idx];
    s.fitAddon.fit();
    window.ipc.send("terminal:resize", {
      id: s.id,
      cols: s.term.cols,
      rows: s.term.rows,
    });
    if (!isRenaming) s.term.focus();
  });
}

function closeTab(idx) {
  if (sessions.length <= 1) return;
  const s = sessions[idx];
  window.ipc.send("session:kill", { id: s.id });
  s.term.dispose();
  s.container.remove();
  sessions.splice(idx, 1);

  if (activeSessionIdx >= sessions.length) {
    activeSessionIdx = sessions.length - 1;
  } else if (activeSessionIdx > idx) {
    activeSessionIdx--;
  }
  activateTab(activeSessionIdx);
}

function fitActiveTerminal() {
  if (activeSessionIdx < 0) return;
  const s = sessions[activeSessionIdx];
  s.fitAddon.fit();
  window.ipc.send("terminal:resize", {
    id: s.id,
    cols: s.term.cols,
    rows: s.term.rows,
  });
}

function renderTabs() {
  tabStrip.innerHTML = "";
  sessions.forEach((s, i) => {
    const tab = document.createElement("button");
    tab.className = "tab" + (i === activeSessionIdx ? " active" : "");
    const animClass = s.animateName ? " animate-in" : "";
    if (s.animateName) s.animateName = false;
    tab.innerHTML =
      '<span class="tab-label' + animClass + '">' +
      escapeHtml(s.name) +
      "</span>" +
      '<span class="tab-actions">' +
        '<span class="tab-action tab-rename" title="Rename"><svg width="12" height="12"><use href="#icon-pencil" /></svg></span>' +
        '<span class="tab-action tab-close" title="Close"><svg width="10" height="10"><use href="#icon-close" /></svg></span>' +
      "</span>";

    tab.addEventListener("click", (e) => {
      if (e.target.closest(".tab-close")) {
        closeTab(i);
      } else if (e.target.closest(".tab-rename")) {
        startRenameTab(i);
      } else {
        activateTab(i);
      }
    });

    tabStrip.appendChild(tab);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "tab tab-add";
  addBtn.title = "New session";
  addBtn.innerHTML =
    '<svg width="14" height="14"><use href="#icon-plus" /></svg>';
  addBtn.addEventListener("click", () => createTab());
  tabStrip.appendChild(addBtn);
}

// IPC routing
window.ipc.on("terminal:data", ({ id, data }) => {
  const s = sessions.find((s) => s.id === id);
  if (!s) return;
  s.term.write(data);
});

window.ipc.on("terminal:exit", ({ id }) => {
  const s = sessions.find((s) => s.id === id);
  if (s) s.term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
});

// ─── Keyboard shortcuts ───
window.ipc.on("shortcut:new-tab", () => createTab());
window.ipc.on("shortcut:close-tab", () => {
  if (sessions.length > 1) closeTab(activeSessionIdx);
});

// ─── Tab rename ───

let isRenaming = false;

function startRenameTab(idx) {
  const tab = tabStrip.children[idx];
  if (!tab) return;
  const label = tab.querySelector(".tab-label");
  const current = sessions[idx].name;
  const activeTerm =
    activeSessionIdx >= 0 ? sessions[activeSessionIdx].term : null;
  isRenaming = true;

  if (activeTerm) {
    activeTerm.blur();
    activeTerm.options.disableStdin = true;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-rename-input";
  input.value = current;
  input.style.width = Math.max(60, label.offsetWidth + 8) + "px";
  input.style.position = "absolute";
  input.style.zIndex = "10";

  const stripPosition = getComputedStyle(tabStrip).position;
  if (stripPosition === "static") {
    tabStrip.style.position = "relative";
  }

  const labelRect = label.getBoundingClientRect();
  const stripRect = tabStrip.getBoundingClientRect();
  input.style.left = labelRect.left - stripRect.left + "px";
  input.style.top = labelRect.top - stripRect.top + "px";
  input.style.height = labelRect.height + "px";

  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => e.stopPropagation());
  input.addEventListener("keyup", (e) => e.stopPropagation());
  input.addEventListener("keypress", (e) => e.stopPropagation());

  input.addEventListener("focusout", (e) => {
    if (isRenaming && e.relatedTarget) {
      setTimeout(() => {
        if (isRenaming) input.focus();
      }, 0);
    }
  });

  label.style.visibility = "hidden";
  tabStrip.appendChild(input);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  function restoreTerminal() {
    if (activeTerm) {
      activeTerm.options.disableStdin = false;
      activeTerm.focus();
    }
  }

  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    isRenaming = false;
    input.remove();
    const val = input.value.trim() || current;
    sessions[idx].name = val;
    renderTabs();
    restoreTerminal();
  }

  input.addEventListener("blur", () => setTimeout(commit, 20));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      committed = true;
      isRenaming = false;
      input.remove();
      renderTabs();
      restoreTerminal();
    }
  });
}

// ─── Resize handle ───

const resizeHandle = document.getElementById("resize-handle");
const viewerPane = document.getElementById("viewer-pane");
let isResizing = false;

resizeHandle.addEventListener("mousedown", (e) => {
  isResizing = true;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
  if (!isResizing) return;
  const appWidth = document.getElementById("app").offsetWidth;
  const newWidth = appWidth - e.clientX;
  if (newWidth >= 280 && newWidth <= appWidth - 400) {
    viewerPane.style.width = newWidth + "px";
    fitActiveTerminal();
  }
});

document.addEventListener("mouseup", () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    fitActiveTerminal();
  }
});

// ─── File viewer ───

let currentPath = null;
let currentDir = null;
let navHistory = [];
let unwatchCurrent = null;
let isViewingFile = false;
let editorSaveTimeout = null;

const viewerContent = document.getElementById("viewer-content");
const breadcrumb = document.getElementById("breadcrumb");
const btnBack = document.getElementById("btn-back");
const btnHome = document.getElementById("btn-home");
const fileHeader = document.getElementById("file-header");
const fileHeaderIcon = document.getElementById("file-header-icon");
const fileHeaderName = document.getElementById("file-header-name");
const btnCloseFile = document.getElementById("btn-close-file");
const btnEditFile = document.getElementById("btn-edit-file");
let isEditing = false;

function iconSvg(id, size) {
  size = size || 16;
  return (
    '<svg width="' + size + '" height="' + size + '"><use href="#icon-' + id + '" /></svg>'
  );
}

function getFileIconId(entry) {
  if (entry.isDirectory) return "folder";
  const ext = path.extname(entry.path).slice(1).toLowerCase();
  const map = {
    md: "markdown", mdx: "markdown", txt: "doc",
    json: "code", js: "code", ts: "code", py: "code", rb: "code",
    go: "code", rs: "code", sh: "code", lua: "code", html: "code",
    css: "code", jsx: "code", tsx: "code",
    yml: "config", yaml: "config", toml: "config", ini: "config", env: "config",
    png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image",
    pdf: "pdf", csv: "table", xlsx: "table", xls: "table",
    doc: "doc", docx: "doc",
  };
  return map[ext] || "file";
}

function readDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }));
  } catch {
    return [];
  }
}

function readFileContent(filePath) {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return null; }
}

function readFileBuffer(filePath) {
  try { return fs.readFileSync(filePath); } catch { return null; }
}

// Sanitize HTML to prevent script injection from viewed files
function sanitizeHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("script, iframe, object, embed, form").forEach((el) => el.remove());
  div.querySelectorAll("[onload], [onerror], [onclick], [onmouseover]").forEach((el) => {
    el.removeAttribute("onload");
    el.removeAttribute("onerror");
    el.removeAttribute("onclick");
    el.removeAttribute("onmouseover");
  });
  return div.innerHTML;
}

function updateBreadcrumb(filePath) {
  if (!filePath) { breadcrumb.innerHTML = ""; return; }
  let display = filePath;
  if (filePath.startsWith(DEFAULT_DIR)) {
    display = filePath.slice(DEFAULT_DIR.length + 1) || "eytan-os";
  }
  const parts = display.split("/");
  let accumulated = DEFAULT_DIR;
  breadcrumb.innerHTML = parts
    .map((p, i) => {
      if (i > 0 || display === "eytan-os") {
        accumulated = display === "eytan-os" && i === 0 ? DEFAULT_DIR : accumulated + "/" + p;
      } else {
        accumulated = DEFAULT_DIR + "/" + p;
      }
      const fullPath = accumulated;
      if (i < parts.length - 1) {
        return '<span class="crumb" data-path="' + escapeHtml(fullPath) + '">' + escapeHtml(p) + '</span><span class="sep">/</span>';
      }
      return '<span class="crumb-current">' + escapeHtml(p) + "</span>";
    })
    .join("");
  breadcrumb.querySelectorAll(".crumb").forEach((el) => {
    el.addEventListener("click", () => { slideDirection = "back"; navHistory = []; showDirectory(el.dataset.path); });
  });
}

function showFileHeader(filePath) {
  isViewingFile = true;
  isEditing = false;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const entry = { path: filePath, isDirectory: false };
  fileHeaderIcon.innerHTML = iconSvg(getFileIconId(entry), 18);
  fileHeaderName.textContent = path.basename(filePath);
  fileHeader.classList.remove("hidden");
  if (ext === "md" || ext === "mdx") {
    btnEditFile.classList.remove("hidden");
    btnEditFile.innerHTML = '<svg width="16" height="16"><use href="#icon-pencil" /></svg>';
    btnEditFile.title = "Edit";
  } else {
    btnEditFile.classList.add("hidden");
  }
}

function hideFileHeader() {
  isViewingFile = false;
  isEditing = false;
  fileHeader.classList.add("hidden");
  btnEditFile.classList.add("hidden");
}

let slideDirection = null;

function applySlide() {
  viewerContent.classList.remove("slide-forward", "slide-back");
  if (slideDirection) {
    void viewerContent.offsetWidth;
    viewerContent.classList.add("slide-" + slideDirection);
    slideDirection = null;
  }
}

function cleanupWatch() {
  if (unwatchCurrent) { unwatchCurrent(); unwatchCurrent = null; }
}

function cleanupEditorTimeout() {
  if (editorSaveTimeout) {
    clearTimeout(editorSaveTimeout);
    editorSaveTimeout = null;
  }
}

function showDirectory(dirPath) {
  cleanupWatch();
  cleanupEditorTimeout();
  hideFileHeader();
  currentPath = dirPath;
  currentDir = dirPath;
  updateBreadcrumb(dirPath);
  const entries = readDir(dirPath);
  if (entries.length === 0) {
    viewerContent.innerHTML = '<div class="empty-state">' + iconSvg("folder", 32) + "<div>Empty folder</div></div>";
    return;
  }
  const list = document.createElement("ul");
  list.className = "file-list";
  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "file-item" + (entry.isDirectory ? " directory" : "");
    li.innerHTML = '<span class="fi-icon">' + iconSvg(getFileIconId(entry), 16) + '</span><span class="fi-name">' + escapeHtml(entry.name) + "</span>";
    li.addEventListener("click", () => {
      slideDirection = "forward";
      if (entry.isDirectory) { navHistory.push(currentDir); showDirectory(entry.path); }
      else { showFile(entry.path); }
    });
    list.appendChild(li);
  });
  viewerContent.innerHTML = "";
  viewerContent.appendChild(list);
  applySlide();
}

function showFile(filePath) {
  cleanupWatch();
  cleanupEditorTimeout();
  currentPath = filePath;
  updateBreadcrumb(filePath);
  showFileHeader(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === "md" || ext === "mdx") {
    const content = readFileContent(filePath);
    if (content === null) return showError();
    renderMarkdown(content);
    try {
      const watcher = fs.watch(filePath, () => {
        const updated = readFileContent(filePath);
        if (updated !== null && currentPath === filePath) renderMarkdown(updated);
      });
      unwatchCurrent = () => watcher.close();
    } catch {}
  } else if (ext === "docx") {
    const buf = readFileBuffer(filePath);
    if (buf === null) return showError();
    const expectedPath = filePath;
    mammoth.convertToHtml({ buffer: buf }).then((r) => {
      if (currentPath !== expectedPath) return;
      viewerContent.innerHTML = '<div class="docx-body">' + sanitizeHtml(r.value) + "</div>";
    }).catch(() => {
      if (currentPath === expectedPath) showError();
    });
  } else if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) {
    viewerContent.innerHTML = '<div class="image-preview"><img src="file://' + encodeURI(filePath) + '" /></div>';
  } else {
    const content = readFileContent(filePath);
    if (content === null) return showError();
    viewerContent.innerHTML = '<pre class="plain-text">' + escapeHtml(content) + "</pre>";
  }
  applySlide();
}

function showError() {
  viewerContent.innerHTML = '<div class="empty-state">' + iconSvg("file", 32) + "<div>Cannot read file</div></div>";
}

function renderMarkdown(content) {
  viewerContent.innerHTML = '<div class="markdown-body">' + sanitizeHtml(marked(content)) + "</div>";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

btnBack.addEventListener("click", () => {
  slideDirection = "back";
  if (isViewingFile) { hideFileHeader(); if (currentDir) showDirectory(currentDir); return; }
  if (navHistory.length > 0) { const prev = navHistory.pop(); if (prev) showDirectory(prev); }
});

btnHome.addEventListener("click", () => { slideDirection = "back"; navHistory = []; showDirectory(DEFAULT_DIR); });

btnCloseFile.addEventListener("click", () => {
  slideDirection = "back";
  if (isEditing) saveEditor();
  cleanupEditorTimeout();
  hideFileHeader();
  if (currentDir) showDirectory(currentDir);
});

btnEditFile.addEventListener("click", () => {
  if (!currentPath) return;
  if (isEditing) {
    saveEditor();
    cleanupEditorTimeout();
    const content = readFileContent(currentPath);
    if (content !== null) renderMarkdown(content);
    isEditing = false;
    btnEditFile.innerHTML = '<svg width="16" height="16"><use href="#icon-pencil" /></svg>';
    btnEditFile.title = "Edit";
  } else {
    const content = readFileContent(currentPath);
    if (content === null) return;
    isEditing = true;
    btnEditFile.innerHTML = '<svg width="16" height="16"><use href="#icon-check" /></svg>';
    btnEditFile.title = "Done";
    const textarea = document.createElement("textarea");
    textarea.className = "md-editor";
    textarea.value = content;
    textarea.spellcheck = true;
    viewerContent.innerHTML = "";
    viewerContent.appendChild(textarea);
    textarea.focus();
    const editingPath = currentPath;
    textarea.addEventListener("input", () => {
      cleanupEditorTimeout();
      editorSaveTimeout = setTimeout(() => {
        try { fs.writeFileSync(editingPath, textarea.value, "utf-8"); } catch {}
        editorSaveTimeout = null;
      }, 500);
    });
  }
});

function saveEditor() {
  cleanupEditorTimeout();
  const textarea = viewerContent.querySelector(".md-editor");
  if (textarea && currentPath) {
    try { fs.writeFileSync(currentPath, textarea.value, "utf-8"); } catch {}
  }
}

let resizeTimeout;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitActiveTerminal, 50);
});

// ─── Init ───
showDirectory(DEFAULT_DIR);
createTab("Session 1");
