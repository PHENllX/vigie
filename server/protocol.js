/**
 * Protocole du tunnel Vigie.
 *
 * Une seule connexion WebSocket sortante part du PC hôte vers le relais public.
 * Toutes les requêtes des navigateurs y sont multiplexées, chacune identifiée
 * par un streamId. Les corps de réponse circulent en morceaux : une vidéo ne
 * doit jamais être mise entièrement en mémoire.
 *
 * Trame binaire : [type:1][streamId:4 BE][charge utile]
 */

const T = {
  REQ_HEAD: 1, // relais -> hôte : {method, url, headers}
  REQ_BODY: 2, // relais -> hôte : morceau du corps de requête
  REQ_END: 3, // relais -> hôte : fin du corps de requête
  RES_HEAD: 4, // hôte -> relais : {status, headers}
  RES_BODY: 5, // hôte -> relais : morceau du corps de réponse
  RES_END: 6, // hôte -> relais : fin de la réponse
  ERR: 7, // les deux sens : {message}
  WS_OPEN: 8, // relais -> hôte : {url}
  WS_UP: 9, // relais -> hôte : message du navigateur
  WS_DOWN: 10, // hôte -> relais : message vers le navigateur
  WS_CLOSE: 11, // les deux sens
  PING: 12,
  PONG: 13,
};

function encode(type, streamId, payload) {
  const body =
    payload === undefined || payload === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");

  const frame = Buffer.allocUnsafe(5 + body.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(streamId >>> 0, 1);
  body.copy(frame, 5);
  return frame;
}

function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return null;
  return {
    type: buf.readUInt8(0),
    streamId: buf.readUInt32BE(1),
    payload: buf.subarray(5),
  };
}

function json(payload) {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch (e) {
    return null;
  }
}

// En-têtes propres à un saut réseau : ne pas les retransmettre tels quels.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

module.exports = { T, encode, decode, json, cleanHeaders };
