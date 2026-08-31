const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");

// --- Emplacements ---------------------------------------------------------
// On garde les données hors du dossier d'install (chemin sans espaces, plus
// simple à partager avec Docker Desktop sous Windows).
const DATA_DIR = path.join(os.homedir(), "Vigie");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const COMPOSE_FILE = path.join(DATA_DIR, "docker-compose.yml");
const ENV_FILE = path.join(DATA_DIR, ".env");
const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");

const DASHBOARD_PORT = 3001;

let mainWindow = null;
let setupWindow = null;
let tray = null;
let dashboardServer = null;
let tunnelClient = null;
let tunnelState = "off";
let updater = null;
let config = null;
let isQuitting = false;

// --- Config ---------------------------------------------------------------
function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const c = JSON.parse(raw);
    if (c && (c.mode === "host" || c.mode === "client")) return c;
  } catch (e) {
    /* pas encore configuré */
  }
  return null;
}

function saveConfig(c) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), "utf8");
  config = c;
}

// --- Utilitaires ----------------------------------------------------------
function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 180000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
    });
  });
}

function localIPv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        // On écarte les interfaces virtuelles (WSL, Docker, VirtualBox…)
        const virtual = /vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V|Loopback/i.test(name);
        candidates.push({ addr: net.address, virtual });
      }
    }
  }
  const real = candidates.find((c) => !c.virtual && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.addr));
  return (real || candidates.find((c) => !c.virtual) || candidates[0])?.addr || "127.0.0.1";
}

async function dockerStatus() {
  const v = await run("docker --version");
  if (!v.ok) return { installed: false, running: false };
  const info = await run("docker info");
  return { installed: true, running: info.ok };
}

// --- Génération des fichiers Docker --------------------------------------
function writeDockerFiles(cfg) {
  ensureDirs();

  const compose = `services:
  wyze-bridge:
    container_name: wyze-bridge
    restart: unless-stopped
    image: mrlt8/wyze-bridge:latest
    ports:
      - "8554:8554"       # RTSP
      - "8888:8888"       # HLS
      - "8889:8889"       # WebRTC
      - "8189:8189/udp"   # WebRTC/ICE
      - "5000:5000"       # WebUI du bridge (debug)
    environment:
      - WYZE_EMAIL=\${WYZE_EMAIL}
      - WYZE_PASSWORD=\${WYZE_PASSWORD}
      - API_ID=\${API_ID}
      - API_KEY=\${API_KEY}
      - WB_IP=\${HOST_IP}
      - WB_AUTH=false
      - RECORD_ALL=${cfg.record ? "true" : "false"}
      # Jetons strftime : {THEDATE}/{THETIME} n'existent pas dans le pont 2.10+
      # et le font planter au démarrage (KeyError).
      - RECORD_PATH=/record/{cam_name}/%Y-%m-%d_%H-%M-%S
      # Les durées exigent une unité, et seuls s et h sont acceptés.
      - RECORD_LENGTH=60s
      - RECORD_KEEP=${cfg.recordKeep || "168h"}
      # Sans MOTION_API, le pont ignore purement et simplement MOTION_WEBHOOKS.
      - MOTION_API=true
      - MOTION_WEBHOOKS=http://host.docker.internal:${DASHBOARD_PORT}/webhook/motion?cam={cam_name}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - "${RECORDINGS_DIR.replace(/\\/g, "/")}:/record"
`;
  fs.writeFileSync(COMPOSE_FILE, compose, "utf8");

  const env = [
    `WYZE_EMAIL=${cfg.wyzeEmail || ""}`,
    `WYZE_PASSWORD=${cfg.wyzePassword || ""}`,
    `API_ID=${cfg.apiId || ""}`,
    `API_KEY=${cfg.apiKey || ""}`,
    `HOST_IP=${cfg.hostIp || localIPv4()}`,
    "",
  ].join("\n");
  fs.writeFileSync(ENV_FILE, env, "utf8");
}

async function startBridge() {
  writeDockerFiles(config);
  return run(`docker compose --env-file ".env" -f "docker-compose.yml" up -d`, { cwd: DATA_DIR });
}

async function stopBridge() {
  return run(`docker compose -f "docker-compose.yml" down`, { cwd: DATA_DIR });
}

// --- Fenêtres -------------------------------------------------------------
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 740,
    height: 860,
    minHeight: 520,
    // La section « accès à distance » allonge le formulaire : on laisse
    // redimensionner plutôt que de piéger le bouton hors de l'écran.
    resizable: true,
    title: "Vigie — configuration",
    backgroundColor: "#0f1115",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, "ui", "setup.html"));
  setupWindow.on("closed", () => {
    setupWindow = null;
    if (!mainWindow && !isQuitting) app.quit();
  });
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Vigie",
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // La fenêtre doit continuer à recevoir les alertes même réduite.
      backgroundThrottling: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(url);
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Les liens externes (clips vidéo, portail Wyze) ouvrent le navigateur.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  // Fermer = réduire dans la barre système (l'enregistrement continue).
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, "ui", "tray.png");
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    return; // pas d'icône disponible, on continue sans tray
  }
  const menu = Menu.buildFromTemplate([
    { label: `Vigie ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: "Ouvrir le dashboard", click: () => mainWindow && (mainWindow.show(), mainWindow.focus()) },
    {
      label: "Vérifier les mises à jour…",
      click: () => updater && updater.check(true),
    },
    { type: "separator" },
    {
      label: "Ouvrir le dossier des enregistrements",
      click: () => shell.openPath(RECORDINGS_DIR),
    },
    {
      label: "Reconfigurer…",
      click: () => {
        try {
          fs.unlinkSync(CONFIG_FILE);
        } catch (e) {}
        dialog.showMessageBox({
          type: "info",
          message: "Configuration réinitialisée",
          detail: "Redémarre l'application pour relancer l'assistant.",
        });
      },
    },
    { type: "separator" },
    {
      label: "Arrêter le pont vidéo",
      visible: config?.mode === "host",
      click: async () => {
        const r = await stopBridge();
        dialog.showMessageBox({
          type: r.ok ? "info" : "error",
          message: r.ok ? "Pont vidéo arrêté" : "Échec de l'arrêt",
          detail: r.ok
            ? "Les caméras ne sont plus enregistrées. Redémarre l'application pour relancer."
            : r.stderr.slice(0, 400),
        });
      },
    },
    {
      label: "Quitter",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip("Vigie — surveillance");
  tray.setContextMenu(menu);
  tray.on("double-click", () => mainWindow && (mainWindow.show(), mainWindow.focus()));
}

// --- Démarrage ------------------------------------------------------------
function startTunnelIfConfigured() {
  if (!config.remote?.enabled || !config.remote.relayUrl || !config.remote.token) return;
  const { startTunnel } = require("./server/tunnel");
  tunnelClient = startTunnel({
    relayUrl: config.remote.relayUrl,
    token: config.remote.token,
    localPort: DASHBOARD_PORT,
    onStatus: (state, detail) => {
      tunnelState = state;
      if (detail) console.log("[tunnel]", state, detail);
      if (tray) tray.setToolTip("Vigie — " + (state === "connected" ? "accès distant actif" : "surveillance"));
    },
  });
}

async function startHostMode() {
  const { startDashboard } = require("./server/dashboard");
  dashboardServer = startDashboard({
    port: DASHBOARD_PORT,
    recordingsDir: RECORDINGS_DIR,
    cameras: config.cameras || [],
    bridgeHost: config.hostIp || localIPv4(),
    onMotion: (cam) => notifyMotion(cam),
    bridgeInternalHost: "127.0.0.1",
  });

  startTunnelIfConfigured();

  // Après un redémarrage de Windows, Docker Desktop peut mettre une minute à
  // être prêt : on réessaie plutôt que d'échouer silencieusement.
  let started = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const d = await dockerStatus();
    if (d.installed && d.running) {
      started = await startBridge();
      if (started.ok) break;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }

  createMainWindow(`http://127.0.0.1:${DASHBOARD_PORT}`);

  if (!started || !started.ok) {
    const d = await dockerStatus();
    dialog.showMessageBox({
      type: "warning",
      title: "Pont vidéo non démarré",
      message: !d.installed
        ? "Docker Desktop n'est pas installé sur ce PC."
        : !d.running
        ? "Docker Desktop n'est pas démarré."
        : "Le pont vidéo n'a pas pu démarrer.",
      detail: !d.running
        ? "Lance Docker Desktop, attends « Engine running », puis redémarre cette application. Le dashboard s'ouvre quand même, mais les caméras resteront noires."
        : (started?.stderr || "").slice(0, 500),
    });
  }
}

function startClientMode() {
  createMainWindow(`http://${config.hostIp}:${DASHBOARD_PORT}`);
}

function notifyMotion(cam) {
  if (!config?.notifications) return;
  if (!Notification.isSupported()) return;
  new Notification({
    title: "Mouvement détecté",
    body: `Caméra : ${cam}`,
    silent: false,
  }).show();
}

// --- IPC ------------------------------------------------------------------
ipcMain.handle("setup:docker", async () => dockerStatus());
ipcMain.handle("setup:localIp", async () => localIPv4());
ipcMain.handle("setup:genToken", async () => require("crypto").randomBytes(24).toString("base64url"));
ipcMain.handle("setup:copy", async (_e, text) => {
  require("electron").clipboard.writeText(String(text || ""));
  return true;
});

ipcMain.handle("setup:testHost", async (_e, ip) => {
  return new Promise((resolve) => {
    const req = require("http").get(
      { host: ip, port: DASHBOARD_PORT, path: "/api/config", timeout: 4000 },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve({ ok: true, config: JSON.parse(body) });
          } catch (e) {
            resolve({ ok: false, error: "Réponse invalide de l'hôte." });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Aucune réponse — vérifie l'adresse IP et que le PC hôte est allumé." });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
});

ipcMain.handle("setup:save", async (_e, cfg) => {
  saveConfig(cfg);
  // Une caméra de sécurité doit revenir toute seule après un redémarrage.
  try {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: cfg.mode === "host" });
  } catch (e) {}
  if (setupWindow) setupWindow.close();
  createTray();
  if (cfg.mode === "host") {
    await startHostMode();
  } else {
    startClientMode();
  }
  return { ok: true };
});

// En mode hôte, la notification est déjà déclenchée côté serveur (plus fiable
// quand la fenêtre est réduite) — on évite donc le doublon.
ipcMain.on("notify:motion", (_e, cam) => {
  if (config?.mode === "host") return;
  notifyMotion(cam);
});

// --- Cycle de vie ---------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    ensureDirs();

    // Les mises à jour tournent quel que soit le mode : c'est justement sur le
    // PC secondaire qu'on ne veut pas avoir à réinstaller à la main.
    const { setupUpdater } = require("./updater");
    updater = setupUpdater({
      prepareQuit: () => {
        isQuitting = true;
        if (tunnelClient) try { tunnelClient.stop(); } catch (e) {}
      },
    });

    config = loadConfig();
    if (!config) {
      createSetupWindow();
    } else {
      createTray();
      if (config.mode === "host") await startHostMode();
      else startClientMode();
    }
  });
}

app.on("window-all-closed", (e) => {
  // On garde l'app vivante dans la barre système sous Windows.
  if (process.platform !== "darwin" && isQuitting) app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (tunnelClient) {
    try {
      tunnelClient.stop();
    } catch (e) {}
  }
  if (dashboardServer) {
    try {
      dashboardServer.close();
    } catch (e) {}
  }
});
