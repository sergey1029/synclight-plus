const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = ["settings", "state", "frame"];

contextBridge.exposeInMainWorld("api", {
  get: () => ipcRenderer.invoke("ui:get"),
  listApps: () => ipcRenderer.invoke("ui:listApps"),
  set: (patch) => ipcRenderer.send("ui:set", patch),
  resetSettings: () => ipcRenderer.send("ui:reset"),
  test: (on) => ipcRenderer.send("ui:test", on),
  pauseHotkeys: (paused) => ipcRenderer.send("ui:pauseHotkeys", paused),
  closeSyncLight: () => ipcRenderer.send("ui:closeSyncLight"),
  forgetDevices: () => ipcRenderer.send("ui:forgetDevices"),
  openNetworkSettings: () => ipcRenderer.send("ui:openNetworkSettings"),
  sendFrame: (colors) => ipcRenderer.send("engine:frame", colors),
  on: (channel, fn) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
