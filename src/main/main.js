const { app, BrowserWindow, ipcMain, globalShortcut, nativeImage, dialog, crashReporter, shell, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const pty = require("node-pty");
const log = require("./logger");

crashReporter.start({ submitURL: "", uploadToServer: false });

// Renderer was crashing with EXC_BAD_ACCESS (null deref) inside Chromium's
// GPU-side font/text rasterizer during heavy workspace-switch re-layouts
// (confirmed via Crashpad minidump: main-thread fault with CoreText glyph
// measurement active). Forcing software rasterization avoids that code path.
// Must be called before app "ready".
app.disableHardwareAcceleration();

process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.stack || err}`);
});

process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

app.setName("Producer");
let mainWindow;

const sessions = {};
let nextSessionId = 1;

const ASSISTANTS = {
  claude: { command: "claude", label: "Claude" },
  codex: { command: "codex", label: "Codex" },
};

function resolveAssistant(key) {
  return ASSISTANTS[key] ? key : "claude";
}

function isUsableDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== "string") return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveSessionCwd(cwd, sessionId) {
  if (isUsableDirectory(cwd)) return cwd;
  const fallback = process.env.HOME || app.getPath("home");
  if (cwd) {
    log.warn(`Session ${sessionId} cwd unavailable (${cwd}); falling back to ${fallback}`);
  }
  return fallback;
}

function sessionEnv() {
  const env = { ...process.env };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.CLICOLOR = "1";
  env.TERM_PROGRAM = "Producer";
  return env;
}

function killAllSessions(reason) {
  const ids = Object.keys(sessions);
  if (ids.length === 0) return;
  log.warn(`Killing ${ids.length} session(s): ${reason}`);
  ids.forEach((id) => {
    const session = sessions[id];
    if (!session) return;
    try {
      if (session.alive && session.pty) session.pty.kill();
    } catch (e) {
      log.warn(`Session ${id} kill failed during ${reason}: ${e.message}`);
    }
    session.alive = false;
    delete sessions[id];
  });
}

// ─── Window state persistence ───

const stateFile = path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch (e) {
    log.warn(`Failed to load window state: ${e.message}`);
    return null;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const isMaximized = mainWindow.isMaximized();
  const isFullScreen = mainWindow.isFullScreen();
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ bounds, isMaximized, isFullScreen }));
  } catch (e) {
    log.warn(`Failed to save window state: ${e.message}`);
  }
}

function createWindow() {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, "..", "..", "assets", "icon.icns")
  );
  if (process.platform === "darwin") app.dock.setIcon(icon);

  const saved = loadWindowState();
  const defaults = { width: 1440, height: 940, x: undefined, y: undefined };
  const bounds = saved ? saved.bounds : defaults;

  mainWindow = new BrowserWindow({
    width: bounds.width || defaults.width,
    height: bounds.height || defaults.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 960,
    minHeight: 600,
    icon: icon,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1917" : "#faf9f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
    },
  });

  if (saved && saved.isMaximized) mainWindow.maximize();
  if (saved && saved.isFullScreen) mainWindow.setFullScreen(true);

  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);
  mainWindow.on("close", saveWindowState);

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function createSession(cwd, assistantKey) {
  const id = nextSessionId++;
  const assistant = resolveAssistant(assistantKey);
  const assistantConfig = ASSISTANTS[assistant];
  const sessionCwd = resolveSessionCwd(cwd, id);
  log.info(
    `Session ${id} creating (${assistantConfig.label}, cwd: ${sessionCwd})`
  );
  const shellPath = process.env.SHELL || "/bin/zsh";

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shellPath, ["-l", "-c", assistantConfig.command], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: sessionCwd,
      env: sessionEnv(),
    });
  } catch (e) {
    const message = `Session ${id} failed to spawn ${assistantConfig.label}: ${e.message}`;
    log.error(message);
    throw new Error(message);
  }

  sessions[id] = { pty: ptyProcess, alive: true };

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal:data", { id, data });
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    log.info(`Session ${id} exited (code: ${exitCode}, signal: ${signal})`);
    if (sessions[id]) {
      sessions[id].alive = false;
      delete sessions[id];
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal:exit", { id });
    }
  });

  return id;
}

app.whenReady().then(() => {
  log.info("App ready");
  let inApplicationsFolder = false;
  try {
    inApplicationsFolder = app.isInApplicationsFolder();
  } catch (e) {
    log.warn(`Could not check Applications folder status: ${e.message}`);
  }
  log.info(
    `App fingerprint: version=${app.getVersion()}, inApplicationsFolder=${inApplicationsFolder}, exePath=${process.execPath}`
  );
  if (process.platform === "darwin" && !inApplicationsFolder) {
    log.warn("Producer is not running from /Applications; macOS privacy grants may not match the installed app.");
  }
  nativeTheme.themeSource = "system";
  nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(
        nativeTheme.shouldUseDarkColors ? "#1c1917" : "#faf9f8"
      );
    }
  });
  createWindow();
  log.info("Window created");

  let rendererReloads = 0;
  let lastReloadAt = 0;
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const aliveCount = Object.values(sessions).filter((s) => s.alive).length;
    const sessionIds = Object.keys(sessions).join(",") || "none";

    let dumpName = "(lookup failed)";
    try {
      const dumpDir = path.join(app.getPath("userData"), "Crashpad", "pending");
      const files = fs.readdirSync(dumpDir).filter((f) => f.endsWith(".dmp"));
      if (files.length === 0) {
        dumpName = "(none in pending/)";
      } else {
        dumpName = files
          .map((f) => ({ f, mtime: fs.statSync(path.join(dumpDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0].f;
      }
    } catch (e) {
      dumpName = `(error: ${e.message})`;
    }

    const breadcrumbs = log.recent();
    const trail = breadcrumbs
      .map((r) => `    [${r.ts}] [${r.level}] ${r.msg}`)
      .join("\n");

    log.error(
      `Render process gone: reason=${details.reason}, exitCode=${details.exitCode}\n` +
      `  active sessions: ${aliveCount} (ids: ${sessionIds})\n` +
      `  crashpad dump: ${dumpName}\n` +
      `  breadcrumbs (last ${breadcrumbs.length}):\n` +
      trail
    );
    killAllSessions(`renderer gone (${details.reason})`);
    // Auto-recover the renderer instead of leaving a dead window. Guard against
    // a crash loop: if it dies again within 5s, back off and stop reloading.
    const now = Date.now();
    if (now - lastReloadAt < 5000) {
      rendererReloads++;
    } else {
      rendererReloads = 0;
    }
    lastReloadAt = now;
    if (details.reason === "clean-exit" || details.reason === "killed") return;
    if (rendererReloads >= 3) {
      log.error("Renderer crashed repeatedly; not reloading again to avoid a loop.");
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      log.warn(`Reloading renderer (attempt ${rendererReloads + 1})`);
      mainWindow.reload();
    }
  });

  ipcMain.on("log:renderer", (_event, { level, msg }) => {
    const fn = log[level] || log.info;
    fn(`[renderer] ${msg}`);
  });

  mainWindow.on("focus", () => {
    globalShortcut.register("CommandOrControl+T", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("shortcut:new-tab");
      }
    });
    globalShortcut.register("CommandOrControl+W", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("shortcut:close-tab");
      }
    });
  });

  mainWindow.on("blur", () => {
    globalShortcut.unregister("CommandOrControl+T");
    globalShortcut.unregister("CommandOrControl+W");
  });

  ipcMain.handle("app:getUserDataPath", () => {
    return app.getPath("userData");
  });

  ipcMain.handle("app:getHomePath", () => {
    return app.getPath("home");
  });

  ipcMain.handle("app:pickFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Choose your workspace folder",
      message: "Select the folder Producer should use as your file viewer home.",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("app:showInFinder", (_event, filePath) => {
    return shell.showItemInFolder(filePath);
  });

  ipcMain.handle("app:openPrivacySettings", (_event, pane) => {
    const panes = {
      allFiles: "Privacy_AllFiles",
      filesAndFolders: "Privacy_FilesAndFolders",
    };
    const targetPane = panes[pane] || panes.allFiles;
    return shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${targetPane}`
    );
  });

  ipcMain.handle("session:create", (_event, payload) => {
    if (payload && typeof payload === "object") {
      return createSession(payload.cwd, payload.assistant);
    }
    return createSession(payload, "claude");
  });

  ipcMain.on("terminal:input", (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      log.warn("Ignoring terminal input with invalid payload");
      return;
    }
    const { id, data } = payload;
    if (typeof data !== "string") {
      log.warn(`Ignoring terminal input for session ${id}: data must be a string`);
      return;
    }
    if (sessions[id] && sessions[id].alive) {
      try {
        sessions[id].pty.write(data);
      } catch (e) {
        log.warn(`Session ${id} write failed: ${e.message}`);
      }
    }
  });

  ipcMain.on("terminal:resize", (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      log.warn("Ignoring terminal resize with invalid payload");
      return;
    }
    const { id, cols, rows } = payload;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
      log.warn(`Ignoring terminal resize for session ${id}: invalid size ${cols}x${rows}`);
      return;
    }
    if (sessions[id] && sessions[id].alive) {
      try {
        sessions[id].pty.resize(cols, rows);
      } catch (e) {
        log.warn(`Session ${id} resize failed: ${e.message}`);
      }
    }
  });

  ipcMain.on("session:kill", (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      log.warn("Ignoring session kill with invalid payload");
      return;
    }
    const { id } = payload;
    if (sessions[id] && sessions[id].alive) {
      try {
        sessions[id].pty.kill();
      } catch (e) {
        log.warn(`Session ${id} kill failed: ${e.message}`);
      }
      sessions[id].alive = false;
    }
    delete sessions[id];
  });
});

app.on("child-process-gone", (_event, details) => {
  log.warn(
    `Child process gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}, serviceName=${details.serviceName || "n/a"}`
  );
});

app.on("window-all-closed", () => {
  killAllSessions("window-all-closed");
  app.quit();
});
