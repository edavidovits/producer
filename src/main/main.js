const { app, BrowserWindow, ipcMain, globalShortcut, nativeImage, dialog, crashReporter, shell, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const pty = require("node-pty");
const log = require("./logger");

crashReporter.start({ submitURL: "", uploadToServer: false });

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
  log.info(
    `Session ${id} creating (${assistantConfig.label}, cwd: ${cwd || "default"})`
  );
  const shell = process.env.SHELL || "/bin/zsh";

  const ptyProcess = pty.spawn(shell, ["-l", "-c", assistantConfig.command], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: cwd || process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color" },
  });

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

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log.error(`Render process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
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

  ipcMain.handle("session:create", (_event, payload) => {
    if (payload && typeof payload === "object") {
      return createSession(payload.cwd, payload.assistant);
    }
    return createSession(payload, "claude");
  });

  ipcMain.on("terminal:input", (_event, { id, data }) => {
    if (sessions[id] && sessions[id].alive) {
      sessions[id].pty.write(data);
    }
  });

  ipcMain.on("terminal:resize", (_event, { id, cols, rows }) => {
    if (sessions[id] && sessions[id].alive) {
      try {
        sessions[id].pty.resize(cols, rows);
      } catch (e) {
        log.warn(`Session ${id} resize failed: ${e.message}`);
      }
    }
  });

  ipcMain.on("session:kill", (_event, { id }) => {
    if (sessions[id] && sessions[id].alive) {
      sessions[id].pty.kill();
      sessions[id].alive = false;
    }
    delete sessions[id];
  });
});

app.on("window-all-closed", () => {
  Object.values(sessions).forEach((s) => {
    if (s.alive) s.pty.kill();
  });
  app.quit();
});
