// Servidor multiplayer DARK RISE (WebSocket) - feito para o Render (plano Free).
// Ele so repassa a posicao dos jogadores que estao perto uns dos outros.

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 24;
const TICK_HZ = 15;
const VISIBLE_DIST = 200;
const MAX_MSG_PER_SEC = 40;

const players = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("DARK RISE servidor no ar. Jogadores online: " + players.size);
});

const wss = new WebSocketServer({ server, maxPayload: 512 });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.close(1013, "servidor cheio");
    return;
  }
  const id = nextId++;
  const p = { ws, st: null, hadNear: false, msgs: 0, alive: true };
  players.set(id, p);
  send(ws, { t: "hello", id });
  console.log("entrou", id, "online:", players.size);

  ws.on("pong", () => { p.alive = true; });

  ws.on("message", (data) => {
    p.msgs++;
    if (p.msgs > MAX_MSG_PER_SEC) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || m.t !== "s" || !Array.isArray(m.d) || m.d.length !== 7) return;
    const [x, y, z, yaw, speed, g, k] = m.d.map(Number);
    if (![x, y, z, yaw, speed].every(Number.isFinite)) return;
    if (Math.abs(x) > 5000 || Math.abs(y) > 5000 || Math.abs(z) > 5000) return;
    p.st = [x, y, z, yaw, speed, g ? 1 : 0, k ? 1 : 0];
  });

  ws.on("close", () => {
    players.delete(id);
    console.log("saiu", id, "online:", players.size);
    for (const o of players.values()) send(o.ws, { t: "left", id });
  });

  ws.on("error", () => {});
});

setInterval(() => {
  const list = [];
  for (const [id, p] of players) if (p.st) list.push([id, p]);
  const maxD2 = VISIBLE_DIST * VISIBLE_DIST;
  for (const [id, p] of list) {
    const near = {};
    let any = false;
    for (const [oid, o] of list) {
      if (oid === id) continue;
      const dx = o.st[0] - p.st[0];
      const dy = o.st[1] - p.st[1];
      const dz = o.st[2] - p.st[2];
      if (dx * dx + dy * dy + dz * dz <= maxD2) {
        near[oid] = o.st;
        any = true;
      }
    }
    if (any || p.hadNear) send(p.ws, { t: "snap", d: near });
    p.hadNear = any;
  }
}, 1000 / TICK_HZ);

setInterval(() => { for (const p of players.values()) p.msgs = 0; }, 1000);

setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) { p.ws.terminate(); continue; }
    p.alive = false;
    try { p.ws.ping(); } catch (e) {}
  }
}, 30000);

server.listen(PORT, () => console.log("Servidor DARK RISE na porta", PORT));
