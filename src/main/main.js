const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const pty = require("node-pty");

app.setName("Producer");
let mainWindow;

const sessions = {};
let nextSessionId = 1;

const DEFAULT_CWD =
  "/Users/eytan/Davidovits & Co Dropbox/Eytan Davidovits/eytan-os";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 600,
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

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function createSession(cwd) {
  const id = nextSessionId++;
  const shell = process.env.SHELL || "/bin/zsh";

  const ptyProcess = pty.spawn(shell, ["-l", "-c", "claude"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: cwd || DEFAULT_CWD,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  sessions[id] = { pty: ptyProcess, alive: true };

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal:data", { id, data });
    }
  });

  ptyProcess.onExit(() => {
    if (sessions[id]) {
      sessions[id].alive = false;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal:exit", { id });
    }
  });

  return id;
}

app.whenReady().then(() => {
  createWindow();

  // Cmd+T new tab, Cmd+W close tab
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
