const { ipcRenderer } = require("electron");

window.ipc = {
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data)),
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
};
