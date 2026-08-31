const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");

/**
 * Démarre le serveur du dashboard.
 * Tourne uniquement sur le PC hôte ; le PC secondaire s'y connecte par le réseau.
 */
function startDashboard({
  port,
  recordingsDir,
  cameras,
  bridgeHost,
  onMotion,
  // Le pont tourne en Docker sur ce même PC, ports publiés en local.
  bridgeInternalHost = "127.0.0.1",
}) {
  const BRIDGE_INTERNAL_HOST = bridgeInternalHost;
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const recentEvents = [];

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // CORS permissif : uniquement destiné au réseau local domestique.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  });

  app.use(express.static(path.join(__dirname, "public")));
  app.use("/recordings", express.static(recordingsDir));

  app.get("/api/config", (req, res) => {
    res.json({ cameras, bridgeHost });
  });

  // --- Proxy HLS ----------------------------------------------------------
  // Le navigateur ne parle jamais au pont directement : tout passe par ici.
  // Indispensable en accès distant (une page HTTPS ne peut pas charger un
  // flux HTTP, et l'IP locale du pont est injoignable de l'extérieur).
  app.get(/^\/hls\/([^/]+)\/(.+)$/, (req, res) => {
    const cam = req.params[0];
    const rest = req.params[1];
    if (!cameras.includes(cam)) return res.status(404).end();

    const upstream = http.request(
      { host: BRIDGE_INTERNAL_HOST, port: 8888, path: `/${cam}/${rest}`, method: "GET", timeout: 15000 },
      (up) => {
        const type = up.headers["content-type"] || "";
        const isManifest = rest.endsWith(".m3u8") || type.includes("mpegurl");

        if (!isManifest) {
          // Segments vidéo : on relaie tel quel, en flux, sans mise en mémoire.
          res.writeHead(up.statusCode || 200, {
            "content-type": type || "video/mp2t",
            "cache-control": "no-store",
          });
          up.pipe(res);
          return;
        }

        // Manifeste : on réécrit les URLs absolues pour qu'elles repassent ici.
        let body = "";
        up.setEncoding("utf8");
        up.on("data", (d) => (body += d));
        up.on("end", () => {
          const rewritten = body.replace(
            /https?:\/\/[^/\s]+\/([^\s"']+)/g,
            (_m, p) => `/hls/${p.startsWith(cam + "/") ? p : cam + "/" + p}`
          );
          res.writeHead(up.statusCode || 200, {
            "content-type": "application/vnd.apple.mpegurl",
            "cache-control": "no-store",
          });
          res.end(rewritten);
        });
      }
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent) res.status(502).end();
    });
    upstream.end();

    // Si le client ferme l'onglet, on coupe aussi côté pont.
    res.on("close", () => upstream.destroy());
  });

  // Appelé par docker-wyze-bridge (MOTION_WEBHOOKS) à chaque détection.
  app.all("/webhook/motion", (req, res) => {
    const cam = req.query.cam || "inconnue";
    const event = { cam, at: new Date().toISOString() };
    recentEvents.unshift(event);
    if (recentEvents.length > 50) recentEvents.pop();

    // Notification native sur le PC hôte
    if (typeof onMotion === "function") onMotion(cam);

    // Diffusion à tous les dashboards connectés (dont le PC secondaire)
    const payload = JSON.stringify({ type: "motion", ...event });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(payload);
    });

    res.status(200).send("ok");
  });

  app.get("/api/events", (req, res) => res.json(recentEvents));

  app.get("/api/recordings", (req, res) => {
    const results = [];
    try {
      const cams = fs
        .readdirSync(recordingsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const camDir of cams) {
        const camPath = path.join(recordingsDir, camDir.name);
        for (const f of fs.readdirSync(camPath)) {
          if (!f.endsWith(".mp4")) continue;
          const stat = fs.statSync(path.join(camPath, f));
          results.push({
            cam: camDir.name,
            file: f,
            url: `/recordings/${encodeURIComponent(camDir.name)}/${encodeURIComponent(f)}`,
            mtime: stat.mtimeMs,
          });
        }
      }
    } catch (e) {
      /* dossier vide au démarrage */
    }
    results.sort((a, b) => b.mtime - a.mtime);
    res.json(results.slice(0, 100));
  });

  // 0.0.0.0 pour que le PC secondaire puisse se connecter.
  server.listen(port, "0.0.0.0", () => {
    console.log(`Dashboard Wyze sur le port ${port}`);
  });

  return server;
}

module.exports = { startDashboard };
