const { app, BrowserWindow, ipcMain, globalShortcut, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const pty = require("node-pty");

app.setName("Producer");
let mainWindow;

const sessions = {};
let nextSessionId = 1;

const DEFAULT_CWD =
  "/Users/eytan/Davidovits & Co Dropbox/Eytan Davidovits/eytan-os";

// ─── Window state persistence ───

const stateFile = path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
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
  } catch {}
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
    backgroundColor: "#faf9f8",
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

function createSession(cwd) {
  const id = nextSessionId++;
  const shell = process.env.SHELL || "/bin/zsh";

  const ptyProcess = pty.spawn(shell, ["-l", "-c", "claude"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: cwd || process.env.HOME || DEFAULT_CWD,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  sessions[id] = { pty: ptyProcess, alive: true };

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal:data", { id, data });
    }
  });

  ptyProcess.onExit(() => {
    // Clean up dead session
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
  createWindow();

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

  ipcMain.handle("session:create", (_event, cwd) => {
    return createSession(cwd);
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
      } catch (_) {}
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
