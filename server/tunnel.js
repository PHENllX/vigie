/**
 * Client du tunnel Vigie (côté maison).
 *
 * Ouvre une connexion sortante persistante vers le relais public et exécute
 * les requêtes qui en proviennent contre le dashboard local. Aucun port
 * entrant n'est ouvert sur le réseau domestique.
 */

const http = require("http");
const WebSocket = require("ws");
const { T, encode, decode, json, cleanHeaders } = require("./protocol");

function startTunnel({ relayUrl, token, localPort, onStatus }) {
  let ws = null;
  let stopped = false;
  let retryDelay = 2000;
  let retryTimer = null;
  const localWs = new Map(); // streamId -> WebSocket local
  const pendingReq = new Map(); // streamId -> requête http en cours

  const status = (state, detail) => {
    if (typeof onStatus === "function") onStatus(state, detail);
  };

  function connect() {
    if (stopped) return;

    let target;
    try {
      const u = new URL(relayUrl);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = "/__tunnel";
      u.search = "?token=" + encodeURIComponent(token);
      target = u.toString();
    } catch (e) {
      status("error", "Adresse du relais invalide.");
      return;
    }

    status("connecting");
    ws = new WebSocket(target, { handshakeTimeout: 15000 });

    ws.on("open", () => {
      retryDelay = 2000;
      status("connected");
    });

    ws.on("message", (buf, isBinary) => {
      if (!isBinary) return;
      const frame = decode(buf);
      if (frame) handleFrame(frame);
    });

    ws.on("unexpected-response", (_req, res) => {
      status(
        "error",
        res.statusCode === 401
          ? "Jeton refusé par le relais."
          : "Le relais a répondu " + res.statusCode + "."
      );
    });

    const reconnect = () => {
      for (const req of pendingReq.values()) req.destroy();
      pendingReq.clear();
      for (const lws of localWs.values()) try { lws.close(); } catch (e) {}
      localWs.clear();

      if (stopped) return;
      status("disconnected");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, retryDelay);
      // Recul progressif jusqu'à 30 s : on n'inonde pas le relais.
      retryDelay = Math.min(retryDelay * 1.7, 30000);
    };

    ws.on("close", reconnect);
    ws.on("error", () => {});
  }

  function send(type, streamId, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(type, streamId, payload));
  }

  function handleFrame({ type, streamId, payload }) {
    if (type === T.REQ_HEAD) {
      const head = json(payload);
      if (!head) return;

      const req = http.request(
        {
          host: "127.0.0.1",
          port: localPort,
          method: head.method,
          path: head.url,
          headers: { ...cleanHeaders(head.headers), host: "127.0.0.1:" + localPort },
        },
        (res) => {
          send(T.RES_HEAD, streamId, {
            status: res.statusCode,
            headers: cleanHeaders(res.headers),
          });
          // On relaie en flux : une vidéo ne passe jamais entièrement en mémoire.
          res.on("data", (chunk) => send(T.RES_BODY, streamId, chunk));
          res.on("end", () => {
            send(T.RES_END, streamId);
            pendingReq.delete(streamId);
          });
        }
      );

      req.on("error", (err) => {
        send(T.ERR, streamId, { message: err.message });
        pendingReq.delete(streamId);
      });

      pendingReq.set(streamId, req);
      return;
    }

    if (type === T.REQ_BODY) {
      const req = pendingReq.get(streamId);
      if (req) req.write(payload);
      return;
    }

    if (type === T.REQ_END) {
      const req = pendingReq.get(streamId);
      if (req) req.end();
      return;
    }

    if (type === T.WS_OPEN) {
      const head = json(payload) || {};
      const lws = new WebSocket("ws://127.0.0.1:" + localPort + (head.url || "/ws"));
      // Le relais accepte le navigateur avant que cette connexion locale soit
      // prête : on met de côté ce qui arrive entre-temps plutôt que le perdre.
      lws.__pending = [];
      localWs.set(streamId, lws);

      lws.on("open", () => {
        for (const m of lws.__pending) lws.send(m);
        lws.__pending = [];
      });
      lws.on("message", (data) => send(T.WS_DOWN, streamId, data));
      lws.on("close", () => {
        localWs.delete(streamId);
        send(T.WS_CLOSE, streamId);
      });
      lws.on("error", () => {
        localWs.delete(streamId);
        send(T.WS_CLOSE, streamId);
      });
      return;
    }

    if (type === T.WS_UP) {
      const lws = localWs.get(streamId);
      if (!lws) return;
      if (lws.readyState === WebSocket.OPEN) lws.send(payload);
      else if (lws.__pending) lws.__pending.push(Buffer.from(payload));
      return;
    }

    if (type === T.WS_CLOSE) {
      const lws = localWs.get(streamId);
      if (lws) try { lws.close(); } catch (e) {}
      localWs.delete(streamId);
      const req = pendingReq.get(streamId);
      if (req) {
        req.destroy();
        pendingReq.delete(streamId);
      }
      return;
    }
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      if (ws) try { ws.close(); } catch (e) {}
    },
  };
}

module.exports = { startTunnel };
