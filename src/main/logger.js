const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const logDir = path.join(app.getPath("userData"), "logs");
const logFile = path.join(logDir, "producer.log");
const prevLogFile = path.join(logDir, "producer.prev.log");

// Ensure log directory exists
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch {}

// Rotate on startup if > 1MB
try {
  const stat = fs.statSync(logFile);
  if (stat.size > 1024 * 1024) {
    fs.renameSync(logFile, prevLogFile);
  }
} catch {}

const recent = [];
const RECENT_MAX = 40;

function write(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  recent.push({ ts, level, msg });
  if (recent.length > RECENT_MAX) recent.shift();
  try {
    fs.appendFileSync(logFile, line);
  } catch {}
}

const log = {
  info: (msg) => write("INFO", msg),
  warn: (msg) => write("WARN", msg),
  error: (msg) => write("ERROR", msg),
  recent: () => recent.slice(),
};

module.exports = log;
