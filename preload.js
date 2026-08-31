const { contextBridge, ipcRenderer } = require("electron");

// API exposée à l'assistant de configuration
contextBridge.exposeInMainWorld("setupAPI", {
  checkDocker: () => ipcRenderer.invoke("setup:docker"),
  localIp: () => ipcRenderer.invoke("setup:localIp"),
  testHost: (ip) => ipcRenderer.invoke("setup:testHost", ip),
  genToken: () => ipcRenderer.invoke("setup:genToken"),
  copy: (text) => ipcRenderer.invoke("setup:copy", text),
  save: (cfg) => ipcRenderer.invoke("setup:save", cfg),
});

// API exposée au dashboard (hôte ET client) pour les notifications natives.
// Le dashboard vérifie sa présence : dans un navigateur normal il retombe
// simplement sur les notifications visuelles internes.
contextBridge.exposeInMainWorld("wyzeDesktop", {
  notifyMotion: (cam) => ipcRenderer.send("notify:motion", cam),
});
