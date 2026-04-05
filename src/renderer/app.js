// Producer -- renderer (with workspaces)

const fs = require("fs");
const path = require("path");
const { Terminal } = require("@xterm/xterm");
const { FitAddon } = require("@xterm/addon-fit");
const { WebLinksAddon } = require("@xterm/addon-web-links");
const { marked } = require("marked");
const mammoth = require("mammoth");
marked.setOptions({ gfm: true, breaks: true });

// Home directory -- configurable, resolved at init
let DEFAULT_DIR = null;
let SETTINGS_FILE = null;
let WORKSPACE_FILE = null;

// Light terminal theme
const TERM_THEME = {
  background: "#ffffff",
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

// ─── DOM references ───

const tabStrip = document.getElementById("tab-strip");
const terminalBody = document.getElementById("terminal-body");
const sidebar = document.getElementById("sidebar");
const workspaceList = document.getElementById("workspace-list");
const btnNewWorkspace = document.getElementById("btn-new-workspace");
const sidebarToggleOpen = document.getElementById("sidebar-toggle-open");
const sidebarToggleClosed = document.getElementById("sidebar-toggle-closed");
const viewerContent = document.getElementById("viewer-content");
const breadcrumb = document.getElementById("breadcrumb");
const btnBack = document.getElementById("btn-back");
const btnHome = document.getElementById("btn-home");
const fileHeader = document.getElementById("file-header");
const fileHeaderIcon = document.getElementById("file-header-icon");
const fileHeaderName = document.getElementById("file-header-name");
const btnCloseFile = document.getElementById("btn-close-file");
const btnEditFile = document.getElementById("btn-edit-file");
const viewerPane = document.getElementById("viewer-pane");

// ─── Workspace data model ───

let workspaces = [];
let activeWorkspaceIdx = -1;
let sidebarCollapsed = false;
let nextWorkspaceId = 1;
let workspaceDragState = null;
let workspaceClickSuppressUntil = 0;

// Each workspace: { id, name, sessions: [], activeSessionIdx, fileViewerState }
// Each session: { id, name, named, term, fitAddon, container, pendingInput, hasCapturedFirstPrompt, animateName }

function generateWorkspaceId() {
  return "ws_" + nextWorkspaceId++;
}

// ─── Workspace persistence ───

function saveWorkspaceState() {
  if (!WORKSPACE_FILE) return;
  const data = {
    nextWorkspaceId: nextWorkspaceId,
    sidebarCollapsed: sidebarCollapsed,
    activeWorkspaceIdx: activeWorkspaceIdx,
    workspaces: workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      fileViewerState: {
        currentPath: ws.fileViewerState.currentPath,
        currentDir: ws.fileViewerState.currentDir,
      },
    })),
  };
  try {
    fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    // silently fail
  }
}

function loadWorkspaceState() {
  if (!WORKSPACE_FILE) return null;
  try {
    const raw = fs.readFileSync(WORKSPACE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Utility ───

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function iconSvg(id, size) {
  size = size || 16;
  return (
    '<svg width="' +
    size +
    '" height="' +
    size +
    '"><use href="#icon-' +
    id +
    '" /></svg>'
  );
}

function truncateTabName(text) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 20) return trimmed;
  return trimmed.slice(0, 18).trimEnd() + "...";
}

function getDefaultSessionName(idx) {
  return "Session " + (idx + 1);
}

function moveWorkspace(fromIdx, toIdx) {
  if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
  const activeWs = workspaces[activeWorkspaceIdx];
  const moved = workspaces.splice(fromIdx, 1)[0];
  workspaces.splice(toIdx, 0, moved);
  activeWorkspaceIdx = workspaces.indexOf(activeWs);
}

function beginWorkspaceDrag(state, event) {
  const { row, placeholder } = state;
  const rect = row.getBoundingClientRect();
  state.dragging = true;
  state.offsetY = event.clientY - rect.top;

  placeholder.style.height = rect.height + "px";
  workspaceList.insertBefore(placeholder, row);

  row.classList.add("dragging");
  row.style.width = rect.width + "px";
  row.style.left = rect.left + "px";
  row.style.top = rect.top + "px";
}

function updateWorkspaceDrag(state, event) {
  const { row, placeholder } = state;
  row.style.top = event.clientY - state.offsetY + "px";

  const siblings = Array.from(workspaceList.children).filter(
    (child) => child !== row && child !== placeholder
  );

  let beforeNode = null;
  for (const child of siblings) {
    const rect = child.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      beforeNode = child;
      break;
    }
  }

  workspaceList.insertBefore(placeholder, beforeNode);
}

function cleanupWorkspaceDrag(state) {
  const { row, placeholder, onPointerMove, onPointerUp } = state;
  row.removeEventListener("pointermove", onPointerMove);
  row.removeEventListener("pointerup", onPointerUp);
  row.removeEventListener("pointercancel", onPointerUp);
  if (row.hasPointerCapture(state.pointerId)) {
    row.releasePointerCapture(state.pointerId);
  }
  placeholder.remove();
  row.classList.remove("dragging");
  row.style.width = "";
  row.style.left = "";
  row.style.top = "";
}

function attachWorkspaceDrag(row, idx) {
  row.addEventListener("pointerdown", (event) => {
    if (workspaceDragState) return;
    if (event.button !== 0) return;
    if (
      event.target.closest(".ws-action") ||
      event.target.closest(".ws-rename-input")
    ) {
      return;
    }

    const state = {
      row: row,
      fromIdx: idx,
      pointerId: event.pointerId,
      startY: event.clientY,
      dragging: false,
      placeholder: document.createElement("div"),
    };
    state.placeholder.className = "ws-row-placeholder";

    state.onPointerMove = (moveEvent) => {
      if (!state.dragging && Math.abs(moveEvent.clientY - state.startY) < 6) {
        return;
      }
      if (!state.dragging) {
        beginWorkspaceDrag(state, moveEvent);
      }
      updateWorkspaceDrag(state, moveEvent);
    };

    state.onPointerUp = () => {
      const didDrag = state.dragging;
      let toIdx = -1;
      if (didDrag) {
        const orderedNodes = Array.from(workspaceList.children).filter(
          (child) => child !== row
        );
        toIdx = orderedNodes.indexOf(state.placeholder);
      }
      cleanupWorkspaceDrag(state);
      workspaceDragState = null;

      if (!didDrag) return;

      workspaceClickSuppressUntil = performance.now() + 250;
      if (toIdx === -1 || toIdx === state.fromIdx) {
        renderSidebar();
        return;
      }

      moveWorkspace(state.fromIdx, toIdx);
      // Re-switch to active workspace to ensure terminals/tabs/viewer are consistent
      switchWorkspace(activeWorkspaceIdx);
      saveWorkspaceState();
    };

    workspaceDragState = state;
    row.setPointerCapture(event.pointerId);
    row.addEventListener("pointermove", state.onPointerMove);
    row.addEventListener("pointerup", state.onPointerUp);
    row.addEventListener("pointercancel", state.onPointerUp);
  });
}

// ─── Active workspace helpers ───

function activeWorkspace() {
  return workspaces[activeWorkspaceIdx] || null;
}

// ─── Sessions / Tabs ───

let isRenaming = false;

async function createTab(name) {
  const ws = activeWorkspace();
  if (!ws) return;

  const id = await window.ipc.invoke("session:create", DEFAULT_DIR);
  const defaultName = getDefaultSessionName(ws.sessions.length);

  const container = document.createElement("div");
  container.className = "terminal-session";
  container.dataset.sessionId = id;
  container.dataset.workspaceId = ws.id;
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

  term.attachCustomKeyEventHandler(() => !isRenaming);

  const session = {
    id: id,
    name: name || defaultName,
    named: !!name && name !== defaultName,
    term: term,
    fitAddon: fitAddon,
    container: container,
    pendingInput: "",
    hasCapturedFirstPrompt: false,
    animateName: false,
  };

  term.onData((data) => {
    window.ipc.send("terminal:input", { id: id, data: data });

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

  ws.sessions.push(session);
  sessionMap[id] = session;

  renderTabs();
  activateTab(ws.sessions.length - 1);
  renderSidebar();
  return session;
}

function activateTab(idx) {
  const ws = activeWorkspace();
  if (!ws) return;
  if (idx < 0 || idx >= ws.sessions.length) return;
  ws.activeSessionIdx = idx;

  // Show/hide terminal containers for this workspace
  ws.sessions.forEach((s, i) => {
    s.container.classList.toggle("active", i === idx);
  });

  renderTabs();

  requestAnimationFrame(() => {
    const s = ws.sessions[idx];
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
  const ws = activeWorkspace();
  if (!ws) return;
  if (ws.sessions.length <= 1) return;
  const s = ws.sessions[idx];
  delete sessionMap[s.id];
  window.ipc.send("session:kill", { id: s.id });
  s.term.dispose();
  s.container.remove();
  ws.sessions.splice(idx, 1);

  if (ws.activeSessionIdx >= ws.sessions.length) {
    ws.activeSessionIdx = ws.sessions.length - 1;
  } else if (ws.activeSessionIdx > idx) {
    ws.activeSessionIdx--;
  }
  activateTab(ws.activeSessionIdx);
  renderSidebar();
}

function fitActiveTerminal() {
  const ws = activeWorkspace();
  if (!ws || ws.activeSessionIdx < 0 || ws.activeSessionIdx >= ws.sessions.length)
    return;
  const s = ws.sessions[ws.activeSessionIdx];
  s.fitAddon.fit();
  window.ipc.send("terminal:resize", {
    id: s.id,
    cols: s.term.cols,
    rows: s.term.rows,
  });
}

let tabDragState = null;
let tabClickSuppressUntil = 0;

function renderTabs() {
  const ws = activeWorkspace();
  tabStrip.innerHTML = "";
  if (!ws) return;

  ws.sessions.forEach((s, i) => {
    const tab = document.createElement("button");
    tab.className = "tab" + (i === ws.activeSessionIdx ? " active" : "");
    const animClass = s.animateName ? " animate-in" : "";
    if (s.animateName) s.animateName = false;
    tab.innerHTML =
      '<span class="tab-label' +
      animClass +
      '">' +
      escapeHtml(s.name) +
      "</span>" +
      '<span class="tab-actions">' +
      '<span class="tab-action tab-rename" title="Rename"><svg width="12" height="12"><use href="#icon-pencil" /></svg></span>' +
      '<span class="tab-action tab-close" title="Close"><svg width="10" height="10"><use href="#icon-close" /></svg></span>' +
      "</span>";

    // Drag to reorder tabs
    tab.addEventListener("pointerdown", (event) => {
      if (tabDragState) return;
      if (event.button !== 0) return;
      if (event.target.closest(".tab-action")) return;

      const tState = {
        tab, fromIdx: i, pointerId: event.pointerId,
        startX: event.clientX, dragging: false,
        placeholder: document.createElement("div"),
        offsetX: 0,
      };
      tState.placeholder.className = "tab tab-placeholder";
      tState.placeholder.style.height = "100%";

      tState.onPointerMove = (me) => {
        if (!tState.dragging && Math.abs(me.clientX - tState.startX) < 6) return;
        if (!tState.dragging) {
          const rect = tab.getBoundingClientRect();
          tState.dragging = true;
          tState.offsetX = me.clientX - rect.left;
          tState.placeholder.style.width = rect.width + "px";
          tabStrip.insertBefore(tState.placeholder, tab);
          tab.classList.add("tab-dragging");
          tab.style.width = rect.width + "px";
          tab.style.position = "fixed";
          tab.style.zIndex = "1000";
          tab.style.top = rect.top + "px";
          tab.style.left = rect.left + "px";
        }
        tab.style.left = (me.clientX - tState.offsetX) + "px";
        // Find insertion point
        const siblings = Array.from(tabStrip.children).filter(
          (c) => c !== tab && c !== tState.placeholder && !c.classList.contains("tab-add")
        );
        let inserted = false;
        for (const sib of siblings) {
          const sr = sib.getBoundingClientRect();
          if (me.clientX < sr.left + sr.width / 2) {
            tabStrip.insertBefore(tState.placeholder, sib);
            inserted = true;
            break;
          }
        }
        if (!inserted && siblings.length > 0) {
          const addBtn = tabStrip.querySelector(".tab-add");
          tabStrip.insertBefore(tState.placeholder, addBtn);
        }
      };

      tState.onPointerUp = () => {
        const didDrag = tState.dragging;
        // Determine index from placeholder position BEFORE cleanup
        let toIdx = -1;
        if (didDrag) {
          const siblings = Array.from(tabStrip.children).filter(
            (c) => c !== tab && !c.classList.contains("tab-add")
          );
          toIdx = siblings.indexOf(tState.placeholder);
        }
        tab.removeEventListener("pointermove", tState.onPointerMove);
        tab.removeEventListener("pointerup", tState.onPointerUp);
        tab.removeEventListener("pointercancel", tState.onPointerUp);
        if (tab.hasPointerCapture(tState.pointerId)) {
          tab.releasePointerCapture(tState.pointerId);
        }
        if (didDrag) {
          tState.placeholder.remove();
          tab.classList.remove("tab-dragging");
          tab.style.position = "";
          tab.style.zIndex = "";
          tab.style.top = "";
          tab.style.left = "";
          tab.style.width = "";
          if (toIdx !== -1 && toIdx !== tState.fromIdx) {
            const activeSession = ws.sessions[ws.activeSessionIdx];
            const moved = ws.sessions.splice(tState.fromIdx, 1)[0];
            ws.sessions.splice(toIdx, 0, moved);
            ws.activeSessionIdx = ws.sessions.indexOf(activeSession);
            activateTab(ws.activeSessionIdx);
          }
          tabClickSuppressUntil = performance.now() + 250;
        }
        tabDragState = null;
        renderTabs();
      };

      tabDragState = tState;
      tab.setPointerCapture(event.pointerId);
      tab.addEventListener("pointermove", tState.onPointerMove);
      tab.addEventListener("pointerup", tState.onPointerUp);
      tab.addEventListener("pointercancel", tState.onPointerUp);
    });

    tab.addEventListener("click", (e) => {
      if (tabClickSuppressUntil && performance.now() < tabClickSuppressUntil) return;
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

// ─── Tab rename ───

function startRenameTab(idx) {
  const ws = activeWorkspace();
  if (!ws) return;
  const tab = tabStrip.children[idx];
  if (!tab) return;
  const label = tab.querySelector(".tab-label");
  const current = ws.sessions[idx].name;
  const activeTerm =
    ws.activeSessionIdx >= 0 ? ws.sessions[ws.activeSessionIdx].term : null;
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
    ws.sessions[idx].name = val;
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

// ─── IPC routing (O(1) lookup via map) ───

const sessionMap = {}; // id -> session object

window.ipc.on("terminal:data", ({ id, data }) => {
  const s = sessionMap[id];
  if (s) s.term.write(data);
});

window.ipc.on("terminal:exit", ({ id }) => {
  const s = sessionMap[id];
  if (s) s.term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
});

// ─── Keyboard shortcuts ───
window.ipc.on("shortcut:new-tab", () => createTab());
window.ipc.on("shortcut:close-tab", () => {
  const ws = activeWorkspace();
  if (ws && ws.sessions.length > 1) closeTab(ws.activeSessionIdx);
});

// ─── Resize handle ───

const resizeHandle = document.getElementById("resize-handle");
let isResizing = false;

resizeHandle.addEventListener("mousedown", (e) => {
  isResizing = true;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
});

let viewerResizeRaf = null;
document.addEventListener("mousemove", (e) => {
  if (!isResizing) return;
  const mainEl = document.getElementById("main");
  const mainRect = mainEl.getBoundingClientRect();
  const newWidth = mainRect.right - e.clientX;
  if (newWidth >= 320 && newWidth <= mainRect.width - 400) {
    viewerPane.style.width = newWidth + "px";
    if (!viewerResizeRaf) {
      viewerResizeRaf = requestAnimationFrame(() => {
        fitActiveTerminal();
        viewerResizeRaf = null;
      });
    }
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

let unwatchCurrent = null;
let isViewingFile = false;
let isEditing = false;
let editorSaveTimeout = null;
let slideDirection = null;

function getFileIconId(entry) {
  if (entry.isDirectory) return "folder";
  const ext = path.extname(entry.path).slice(1).toLowerCase();
  const map = {
    md: "markdown",
    mdx: "markdown",
    txt: "doc",
    json: "code",
    js: "code",
    ts: "code",
    py: "code",
    rb: "code",
    go: "code",
    rs: "code",
    sh: "code",
    lua: "code",
    html: "code",
    css: "code",
    jsx: "code",
    tsx: "code",
    yml: "config",
    yaml: "config",
    toml: "config",
    ini: "config",
    env: "config",
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    svg: "image",
    webp: "image",
    pdf: "pdf",
    csv: "table",
    xlsx: "table",
    xls: "table",
    doc: "doc",
    docx: "doc",
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
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function readFileBuffer(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function sanitizeHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  div
    .querySelectorAll("script, iframe, object, embed, form")
    .forEach((el) => el.remove());
  div
    .querySelectorAll("[onload], [onerror], [onclick], [onmouseover]")
    .forEach((el) => {
      el.removeAttribute("onload");
      el.removeAttribute("onerror");
      el.removeAttribute("onclick");
      el.removeAttribute("onmouseover");
    });
  return div.innerHTML;
}

function updateBreadcrumb(filePath) {
  if (!filePath) {
    breadcrumb.innerHTML = "";
    return;
  }
  let display = filePath;
  if (filePath.startsWith(DEFAULT_DIR)) {
    display = filePath.slice(DEFAULT_DIR.length + 1) || "eytan-os";
  }
  const parts = display.split("/");
  let accumulated = DEFAULT_DIR;
  breadcrumb.innerHTML = parts
    .map((p, i) => {
      if (i > 0 || display === "eytan-os") {
        accumulated =
          display === "eytan-os" && i === 0
            ? DEFAULT_DIR
            : accumulated + "/" + p;
      } else {
        accumulated = DEFAULT_DIR + "/" + p;
      }
      const fullPath = accumulated;
      if (i < parts.length - 1) {
        return (
          '<span class="crumb" data-path="' +
          escapeHtml(fullPath) +
          '">' +
          escapeHtml(p) +
          '</span><span class="sep">/</span>'
        );
      }
      return '<span class="crumb-current">' + escapeHtml(p) + "</span>";
    })
    .join("");
  breadcrumb.querySelectorAll(".crumb").forEach((el) => {
    el.addEventListener("click", () => {
      slideDirection = "back";
      const ws = activeWorkspace();
      if (ws) ws.fileViewerState.navHistory = [];
      showDirectory(el.dataset.path);
    });
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
    btnEditFile.innerHTML =
      '<svg width="16" height="16"><use href="#icon-pencil" /></svg>';
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

function applySlide() {
  viewerContent.classList.remove("slide-forward", "slide-back");
  if (slideDirection) {
    void viewerContent.offsetWidth;
    viewerContent.classList.add("slide-" + slideDirection);
    slideDirection = null;
  }
}

function cleanupWatch() {
  if (unwatchCurrent) {
    unwatchCurrent();
    unwatchCurrent = null;
  }
}

function cleanupEditorTimeout() {
  if (editorSaveTimeout) {
    clearTimeout(editorSaveTimeout);
    editorSaveTimeout = null;
  }
}

function updateNavButtons() {
  const ws = activeWorkspace();
  const navHist = ws ? ws.fileViewerState.navHistory : [];
  const curDir = ws ? ws.fileViewerState.currentDir : DEFAULT_DIR;
  const isHome = curDir === DEFAULT_DIR;
  btnBack.style.display = (navHist.length > 0 || isViewingFile) ? "" : "none";
  btnHome.style.display = isHome && !isViewingFile ? "none" : "";
}

function showDirectory(dirPath) {
  cleanupWatch();
  cleanupEditorTimeout();
  hideFileHeader();
  const ws = activeWorkspace();
  if (ws) {
    ws.fileViewerState.currentPath = dirPath;
    ws.fileViewerState.currentDir = dirPath;
  }
  updateBreadcrumb(dirPath);
  const entries = readDir(dirPath);
  if (entries.length === 0) {
    viewerContent.innerHTML =
      '<div class="empty-state">' +
      iconSvg("folder", 32) +
      "<div>Empty folder</div></div>";
    applySlide();
    updateNavButtons();
    return;
  }
  const list = document.createElement("ul");
  list.className = "file-list";
  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "file-item" + (entry.isDirectory ? " directory" : "");
    li.innerHTML =
      '<span class="fi-icon">' +
      iconSvg(getFileIconId(entry), 16) +
      '</span><span class="fi-name">' +
      escapeHtml(entry.name) +
      "</span>";
    li.addEventListener("click", () => {
      slideDirection = "forward";
      if (entry.isDirectory) {
        const ws2 = activeWorkspace();
        if (ws2) ws2.fileViewerState.navHistory.push(ws2.fileViewerState.currentDir);
        showDirectory(entry.path);
      } else {
        showFile(entry.path);
      }
    });
    list.appendChild(li);
  });
  viewerContent.innerHTML = "";
  viewerContent.appendChild(list);
  applySlide();
  updateNavButtons();
}

function showFile(filePath) {
  cleanupWatch();
  cleanupEditorTimeout();
  const ws = activeWorkspace();
  if (ws) ws.fileViewerState.currentPath = filePath;
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
        const currentWs = activeWorkspace();
        if (updated !== null && currentWs && currentWs.fileViewerState.currentPath === filePath)
          renderMarkdown(updated);
      });
      unwatchCurrent = () => watcher.close();
    } catch {}
  } else if (ext === "docx") {
    const buf = readFileBuffer(filePath);
    if (buf === null) return showError();
    const expectedPath = filePath;
    mammoth
      .convertToHtml({ buffer: buf })
      .then((r) => {
        const currentWs = activeWorkspace();
        if (currentWs && currentWs.fileViewerState.currentPath !== expectedPath) return;
        viewerContent.innerHTML =
          '<div class="docx-body">' + sanitizeHtml(r.value) + "</div>";
      })
      .catch(() => {
        const currentWs = activeWorkspace();
        if (currentWs && currentWs.fileViewerState.currentPath === expectedPath) showError();
      });
  } else if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) {
    viewerContent.innerHTML =
      '<div class="image-preview"><img src="file://' +
      encodeURI(filePath) +
      '" /></div>';
  } else {
    const content = readFileContent(filePath);
    if (content === null) return showError();
    viewerContent.innerHTML =
      '<pre class="plain-text">' + escapeHtml(content) + "</pre>";
  }
  applySlide();
  updateNavButtons();
}

function showError() {
  viewerContent.innerHTML =
    '<div class="empty-state">' +
    iconSvg("file", 32) +
    "<div>Cannot read file</div></div>";
}

function renderMarkdown(content) {
  viewerContent.innerHTML =
    '<div class="markdown-body">' +
    sanitizeHtml(marked(content)) +
    "</div>";
}

btnBack.addEventListener("click", () => {
  slideDirection = "back";
  const ws = activeWorkspace();
  if (isViewingFile) {
    hideFileHeader();
    if (ws && ws.fileViewerState.currentDir) showDirectory(ws.fileViewerState.currentDir);
    return;
  }
  if (ws && ws.fileViewerState.navHistory.length > 0) {
    const prev = ws.fileViewerState.navHistory.pop();
    if (prev) showDirectory(prev);
  }
});

btnHome.addEventListener("click", () => {
  slideDirection = "back";
  const ws = activeWorkspace();
  if (ws) ws.fileViewerState.navHistory = [];
  showDirectory(DEFAULT_DIR);
});

document.getElementById("btn-change-home").addEventListener("click", async () => {
  const picked = await window.ipc.invoke("app:pickFolder");
  if (!picked) return;
  DEFAULT_DIR = picked;
  try {
    const settings = { homeDir: picked };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch {}
  slideDirection = "back";
  const ws = activeWorkspace();
  if (ws) {
    ws.fileViewerState.navHistory = [];
    ws.fileViewerState.currentDir = DEFAULT_DIR;
    ws.fileViewerState.currentPath = DEFAULT_DIR;
  }
  showDirectory(DEFAULT_DIR);
});

btnCloseFile.addEventListener("click", () => {
  slideDirection = "back";
  if (isEditing) saveEditor();
  cleanupEditorTimeout();
  hideFileHeader();
  const ws = activeWorkspace();
  if (ws && ws.fileViewerState.currentDir) showDirectory(ws.fileViewerState.currentDir);
});

btnEditFile.addEventListener("click", () => {
  const ws = activeWorkspace();
  if (!ws || !ws.fileViewerState.currentPath) return;
  const currentPath = ws.fileViewerState.currentPath;
  if (isEditing) {
    saveEditor();
    cleanupEditorTimeout();
    const content = readFileContent(currentPath);
    if (content !== null) renderMarkdown(content);
    isEditing = false;
    btnEditFile.innerHTML =
      '<svg width="16" height="16"><use href="#icon-pencil" /></svg>';
    btnEditFile.title = "Edit";
  } else {
    const content = readFileContent(currentPath);
    if (content === null) return;
    cleanupWatch(); // Stop file watcher so external changes don't overwrite edits
    isEditing = true;
    btnEditFile.innerHTML =
      '<svg width="16" height="16"><use href="#icon-check" /></svg>';
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
        try {
          fs.writeFileSync(editingPath, textarea.value, "utf-8");
        } catch {}
        editorSaveTimeout = null;
      }, 500);
    });
  }
});

function saveEditor() {
  cleanupEditorTimeout();
  const textarea = viewerContent.querySelector(".md-editor");
  const ws = activeWorkspace();
  if (textarea && ws && ws.fileViewerState.currentPath) {
    try {
      fs.writeFileSync(ws.fileViewerState.currentPath, textarea.value, "utf-8");
    } catch {}
  }
}

// ─── Workspace CRUD ───

function createWorkspace(name) {
  const ws = {
    id: generateWorkspaceId(),
    name: name || "Workspace " + workspaces.length,
    sessions: [],
    activeSessionIdx: -1,
    fileViewerState: {
      currentPath: DEFAULT_DIR,
      currentDir: DEFAULT_DIR,
      navHistory: [],
    },
  };
  workspaces.push(ws);
  renderSidebar();
  switchWorkspace(workspaces.length - 1);
  // Create initial tab
  createTab("Session 1");
  saveWorkspaceState();
  return ws;
}

function deleteWorkspace(idx) {
  if (workspaces.length <= 1) return;
  const ws = workspaces[idx];
  // Kill all sessions
  ws.sessions.forEach((s) => {
    delete sessionMap[s.id];
    window.ipc.send("session:kill", { id: s.id });
    s.term.dispose();
    s.container.remove();
  });
  workspaces.splice(idx, 1);

  if (activeWorkspaceIdx >= workspaces.length) {
    activeWorkspaceIdx = workspaces.length - 1;
  } else if (activeWorkspaceIdx > idx) {
    activeWorkspaceIdx--;
  } else if (activeWorkspaceIdx === idx) {
    activeWorkspaceIdx = Math.min(idx, workspaces.length - 1);
  }
  switchWorkspace(activeWorkspaceIdx);
  saveWorkspaceState();
}

function switchWorkspace(idx) {
  if (idx < 0 || idx >= workspaces.length) return;

  // Save current file viewer state is already done via fvState references
  cleanupWatch();
  cleanupEditorTimeout();
  hideFileHeader();
  isViewingFile = false;
  isEditing = false;

  // Hide all terminal containers from every workspace
  workspaces.forEach((ws) => {
    ws.sessions.forEach((s) => {
      s.container.classList.remove("active");
      s.container.style.display = "none";
    });
  });

  activeWorkspaceIdx = idx;
  const ws = workspaces[idx];

  // Show this workspace's terminal containers
  ws.sessions.forEach((s) => {
    s.container.style.display = "";
  });

  // Activate the right tab
  if (ws.sessions.length > 0 && ws.activeSessionIdx >= 0) {
    activateTab(ws.activeSessionIdx);
  }

  renderTabs();
  renderSidebar();

  // Restore file viewer state
  const fv = ws.fileViewerState;
  if (fv.currentPath && fv.currentPath !== fv.currentDir) {
    // Was viewing a file
    showDirectory(fv.currentDir || DEFAULT_DIR);
    showFile(fv.currentPath);
  } else {
    showDirectory(fv.currentDir || fv.currentPath || DEFAULT_DIR);
  }

  saveWorkspaceState();
}

// ─── Sidebar rendering ───

function renderSidebar() {
  workspaceList.innerHTML = "";
  workspaces.forEach((ws, i) => {
    const row = document.createElement("div");
    row.className = "ws-row" + (i === activeWorkspaceIdx ? " active" : "");

    const tabCount = ws.sessions.length;

    const letter = ws.name.charAt(0).toUpperCase();
    row.innerHTML =
      '<span class="ws-letter">' +
      escapeHtml(letter) +
      "</span>" +
      '<span class="ws-name">' +
      escapeHtml(ws.name) +
      "</span>" +
      '<span class="ws-count">' +
      tabCount +
      "</span>" +
      '<span class="ws-actions">' +
      '<button class="ws-action ws-rename" title="Rename">' +
      '<svg width="11" height="11"><use href="#icon-pencil" /></svg>' +
      "</button>" +
      '<button class="ws-action ws-delete" title="Delete">' +
      '<svg width="11" height="11"><use href="#icon-trash" /></svg>' +
      "</button>" +
      "</span>";

    attachWorkspaceDrag(row, i);

    row.addEventListener("click", (e) => {
      if (performance.now() < workspaceClickSuppressUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target.closest(".ws-rename")) {
        startRenameWorkspace(i);
      } else if (e.target.closest(".ws-delete")) {
        deleteWorkspace(i);
      } else {
        if (i !== activeWorkspaceIdx) switchWorkspace(i);
      }
    });

    workspaceList.appendChild(row);
  });
}

function startRenameWorkspace(idx) {
  const row = workspaceList.children[idx];
  if (!row) return;
  const nameEl = row.querySelector(".ws-name");
  const current = workspaces[idx].name;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ws-rename-input";
  input.value = current;

  nameEl.innerHTML = "";
  nameEl.appendChild(input);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => e.stopPropagation());

  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const val = input.value.trim() || current;
    workspaces[idx].name = val;
    renderSidebar();
    saveWorkspaceState();
  }

  input.addEventListener("blur", () => setTimeout(commit, 20));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      committed = true;
      renderSidebar();
    }
  });
}

// ─── Sidebar toggle ───

const topbarLeft = document.getElementById("topbar-left");

function applySidebarState() {
  sidebar.classList.toggle("collapsed", sidebarCollapsed);
  topbarLeft.classList.toggle("needs-traffic-space", sidebarCollapsed);
  sidebarToggleOpen.classList.toggle("hidden", sidebarCollapsed);
  sidebarToggleClosed.classList.toggle("hidden", !sidebarCollapsed);
}

let savedSidebarWidth = null;

function toggleSidebar() {
  if (!sidebarCollapsed) {
    // Collapsing -- save current width
    savedSidebarWidth = sidebar.offsetWidth;
  }
  sidebarCollapsed = !sidebarCollapsed;
  // Add transition class for animation
  sidebar.classList.add("animating");
  applySidebarState();
  if (!sidebarCollapsed && savedSidebarWidth) {
    // Expanding -- restore saved width
    sidebar.style.width = savedSidebarWidth + "px";
  }
  setTimeout(() => {
    sidebar.classList.remove("animating");
    fitActiveTerminal();
  }, 200);
  saveWorkspaceState();
}

sidebarToggleOpen.addEventListener("click", toggleSidebar);
sidebarToggleClosed.addEventListener("click", toggleSidebar);

btnNewWorkspace.addEventListener("click", () => {
  createWorkspace("Workspace " + (workspaces.length + 1));
});

// ─── Sidebar resize ───

const sidebarResizeHandle = document.getElementById("sidebar-resize-handle");
let isSidebarResizing = false;

sidebarResizeHandle.addEventListener("mousedown", (e) => {
  if (sidebarCollapsed) return;
  isSidebarResizing = true;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
});

let sidebarResizeRaf = null;
document.addEventListener("mousemove", (e) => {
  if (!isSidebarResizing) return;
  const newWidth = e.clientX;
  if (newWidth >= 200 && newWidth <= 500) {
    sidebar.style.width = newWidth + "px";
    if (!sidebarResizeRaf) {
      sidebarResizeRaf = requestAnimationFrame(() => {
        fitActiveTerminal();
        sidebarResizeRaf = null;
      });
    }
  }
});

document.addEventListener("mouseup", () => {
  if (isSidebarResizing) {
    isSidebarResizing = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    fitActiveTerminal();
  }
});

// ─── Window resize ───

let resizeTimeout;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitActiveTerminal, 50);
});

// Save workspace state when app is closing
window.addEventListener("beforeunload", () => {
  saveWorkspaceState();
});

// Also save periodically (every 10s) to catch navigation changes
setInterval(saveWorkspaceState, 10000);

// ─── Init ───

(async function init() {
  // Resolve persistence paths
  const userDataPath = await window.ipc.invoke("app:getUserDataPath");
  WORKSPACE_FILE = path.join(userDataPath, "workspaces.json");
  SETTINGS_FILE = path.join(userDataPath, "settings.json");

  // Load or prompt for home directory
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")); } catch {}

  if (settings.homeDir && fs.existsSync(settings.homeDir)) {
    DEFAULT_DIR = settings.homeDir;
  } else {
    // First launch -- prompt user to pick a folder
    const homePath = await window.ipc.invoke("app:getHomePath");
    const picked = await window.ipc.invoke("app:pickFolder");
    DEFAULT_DIR = picked || homePath;
    settings.homeDir = DEFAULT_DIR;
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
  }

  const saved = loadWorkspaceState();

  if (saved && saved.workspaces && saved.workspaces.length > 0) {
    nextWorkspaceId = saved.nextWorkspaceId || 1;
    sidebarCollapsed = !!saved.sidebarCollapsed;
    applySidebarState();

    // Recreate workspaces from saved state (without sessions -- those are ephemeral)
    saved.workspaces.forEach((wsData) => {
      const ws = {
        id: wsData.id,
        name: wsData.name,
        sessions: [],
        activeSessionIdx: -1,
        fileViewerState: wsData.fileViewerState || {
          currentPath: DEFAULT_DIR,
          currentDir: DEFAULT_DIR,
          navHistory: [],
        },
      };
      // Reset navHistory since it references runtime paths
      ws.fileViewerState.navHistory = [];
      workspaces.push(ws);
    });

    const targetIdx = Math.min(
      saved.activeWorkspaceIdx || 0,
      workspaces.length - 1
    );
    activeWorkspaceIdx = targetIdx;

    renderSidebar();

    // Create an initial tab for each workspace sequentially
    async function initWorkspaceTabs() {
      for (let i = 0; i < workspaces.length; i++) {
        activeWorkspaceIdx = i;
        await createTab("Session 1");
      }
      // Switch to the saved active workspace
      switchWorkspace(targetIdx);
    }
    initWorkspaceTabs();
  } else {
    // First launch: create a Default workspace
    const ws = {
      id: generateWorkspaceId(),
      name: "Default",
      sessions: [],
      activeSessionIdx: -1,
      fileViewerState: {
        currentPath: DEFAULT_DIR,
        currentDir: DEFAULT_DIR,
        navHistory: [],
      },
    };
    workspaces.push(ws);
    activeWorkspaceIdx = 0;
    applySidebarState();
    renderSidebar();
    showDirectory(DEFAULT_DIR);
    createTab("Session 1");
    saveWorkspaceState();
  }
})();
