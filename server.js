// Servidor multiplayer DARK RISE (WebSocket) - feito para o Render (plano Free).
// Repassa a posicao dos jogadores proximos, o chat e o sistema de STAFF (ADM 1 a 5).
//
// VARIAVEIS DE AMBIENTE (Render > Environment):
//   OWNER_CODE   codigo secreto do dono (o texto secreto que voce digita no chat).
//                Sem essa variavel o acesso do dono fica DESATIVADO. Nao coloque o codigo no GitHub.
//   OWNER_NAME   (opcional, recomendado) Nome_Sobrenome do personagem do dono. Se definido,
//                so esse personagem consegue usar o codigo.
//   OWNER_REBIND (opcional) "1" = deixa o dono vincular um aparelho novo (use so ao trocar de celular).
//   DATA_FILE    (opcional) caminho do arquivo de dados (staff, bans, logs). Padrao: ./darkrise_data.json
//                No plano Free do Render o disco e apagado a cada deploy/reinicio; para manter os dados
//                use um Disk do Render e aponte DATA_FILE para ele (ex.: /data/darkrise.json).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const OWNER_CODE = process.env.OWNER_CODE || "";
const OWNER_NAME = (process.env.OWNER_NAME || "").trim();
const OWNER_REBIND = process.env.OWNER_REBIND === "1";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "darkrise_data.json");
const MAX_PLAYERS = 24;
const TICK_HZ = 15;
const VISIBLE_DIST = 200;
const MAX_MSG_PER_SEC = 40;
const CHAT_COOLDOWN_MS = 700;
const NAME_RE = /^[A-Z][a-z]{1,14}_[A-Z][a-z]{1,14}$/;   // Rafael_Santos
const WORLD_HALF = 360;                                  // (antigo) usado so por comandos antigos
const MAP_HALF_X = 1800, MAP_HALF_Z = 1270;              // mapa atual 3600 x 2540 m

const LEVEL_NAME = {
  1: "ADM 1 (Administrador)", 2: "ADM 2 (Administrador Avançado)", 3: "ADM 3 (Líder)",
  4: "ADM 4 (Manager)", 5: "ADM 5 (STAFF Suprema / Dono)",
};
const SKINS = ["normal", "adm", "sombra", "vermelho", "dourado", "azul"];   // precisa bater com Scripts/staff_fx.gd
const POLICE_RANKS = ["cadete", "soldado", "cabo", "sargento", "tenente", "capitao", "major", "coronel"];
const PLACES = ["deposito", "spawn"];                                      // locais do /movercarro (ver net.gd)

// [nivel minimo, comando, argumentos, descricao]  -> fonte unica: o /ahelp usa esta lista.
const USAGE = [
  [1, "/ahelp", "[comando]", "Lista os comandos de ADM do seu cargo"],
  [1, "/inviz", "", "Fica invisível para jogadores comuns"],
  [1, "/uninviz", "", "Volta a ficar visível"],
  [1, "/sairadm", "", "Remove o seu próprio cargo de ADM"],
  [1, "/tpmapa", "X Z", "Teleporta você para um ponto do mapa (use tocando no mapa)"],
  [1, "/mute", "ID minutos motivo", "Silencia um jogador"],
  [1, "/kick", "ID motivo", "Expulsa um jogador"],
  [2, "/ban", "ID dias motivo", "Bane por dias"],
  [2, "/skin", "ID skin", "Troca a skin de um jogador"],
  [2, "/limparcarros", "raio", "Remove veículos num raio"],
  [2, "/limpararea", "raio", "Limpa a área num raio"],
  [2, "/movercarro", "ID local", "Move o veículo do jogador (deposito/spawn)"],
  [3, "/tp", "ID", "Vai até o jogador"],
  [3, "/trazer", "ID", "Traz o jogador até você"],
  [3, "/banpermanente", "ID motivo", "Banimento permanente"],
  [3, "/daradm", "ID nivel", "Dá ADM (até o seu limite)"],
  [3, "/removeradm", "ID", "Remove o ADM de alguém"],
  [3, "/darpolicia", "ID cargo", "Dá cargo na polícia"],
  [3, "/retirarpolicia", "ID", "Tira o cargo da polícia"],
  [3, "/demitir", "ID motivo", "Demite do cargo/emprego"],
  [3, "/verstaff", "", "Lista a equipe"],
  [3, "/historico", "ID", "Histórico de punições"],
  [4, "/promover", "ID nivel", "Promove (até ADM 3)"],
  [4, "/rebaixar", "ID nivel", "Rebaixa para um nível menor (0 = remove)"],
  [4, "/revisarpunicao", "ID [anular]", "Revisa/anula punições"],
  [4, "/anuncioglobal", "mensagem", "Anúncio para todos"],
  [4, "/reiniciarevento", "", "Reinicia o evento"],
  [4, "/verlogsstaff", "[quantidade]", "Logs administrativos"],
  [5, "/setlevel", "ID nivel", "Define o nível (0 a 5)"],
  [5, "/desbanir", "IDban|Nome_Sobrenome", "Remove um banimento"],
  [5, "/spawncarro", "modelo", "Cria um veículo"],
  [5, "/spawnitem", "item quantidade", "Cria itens"],
  [5, "/spawnnpc", "modelo", "Cria um NPC"],
  [5, "/spawnobjeto", "modelo", "Cria um objeto"],
  [5, "/teleport", "ID X Y Z", "Teleporta para coordenadas"],
  [5, "/godmode", "ID", "Liga/desliga god mode"],
  [5, "/manutencao", "on|off", "Modo manutenção"],
  [5, "/configservidor", "", "Mostra a configuração"],
];
const CMD_LEVEL = { help: 0, ajuda: 0 };
for (const u of USAGE) CMD_LEVEL[u[1].slice(1)] = u[0];

// ---------------------------------------------------------------- dados persistentes
// Aparelhos sao guardados so como hash (se o arquivo vazar, ninguem consegue se passar por um ADM).
const EMPTY_DB = () => ({
  ownerDev: "", staff: {}, police: {}, skins: {}, bans: [], banSeq: 0, mutes: {},
  history: [], logs: [], maintenance: false,
});
function loadDb() {
  try {
    return Object.assign(EMPTY_DB(), JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch (e) {
    if (e.code !== "ENOENT") {
      try { fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak"); } catch (_) {}
      console.log("aviso: arquivo de dados ilegivel, comecando vazio (copia em .bak)");
    }
    return EMPTY_DB();
  }
}
const db = loadDb();
let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DATA_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.log("erro ao salvar dados:", e.message); }
  }, 400);
}
const keyOf = (dev) => crypto.createHash("sha256").update("dr1:" + dev).digest("hex").slice(0, 32);

const players = new Map();   // id -> { ws, st, name, gender, dev, dk, level, invis, skin, police, god, joined, ... }

// ---------------------------------------------------------------- utilidades
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function onlineCount() { let n = 0; for (const p of players.values()) if (p.joined) n++; return n; }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { for (const p of players.values()) if (p.joined) send(p.ws, obj); }
function sys(p, m, c) { send(p.ws, { t: "sys", m, c: c || "" }); }
function sysAll(m, c) { broadcast({ t: "sys", m, c: c || "" }); }
function panel(p, title, lines) {
  send(p.ws, { t: "panel", title, lines: lines.slice(0, 80).map((l) => String(l).slice(0, 170)) });
}
function freeId() { for (let i = 1; i <= MAX_PLAYERS; i++) if (!players.has(i)) return i; return 0; }
function namesMap() { const d = {}; for (const [id, p] of players) if (p.joined) d[id] = p.name; return d; }
function labelOf(id, p) { return p.name + " (" + id + ")"; }
function when(ts) {
  return new Date(ts).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function isOwner(q) { return !!q.dk && q.dk === db.ownerDev; }
function int(s, min, max) {
  if (!/^-?\d{1,9}$/.test(s || "")) return null;
  const n = parseInt(s, 10);
  return n < min || n > max ? null : n;
}
function num(s) { const n = Number(s); return /^-?\d+(\.\d+)?$/.test(s || "") && Number.isFinite(n) ? n : null; }

function pushStaff(p) {
  const cmds = USAGE.filter((u) => u[0] <= p.level);
  send(p.ws, { t: "staff", lvl: p.level, skin: p.skin, inv: p.invis, god: p.god, police: p.police,
               lname: LEVEL_NAME[p.level] || "", cmds });
}

// Log administrativo (so staff le; nunca guarda o codigo do dono).
function slog(p, action, target, detail) {
  const e = { ts: Date.now(), by: p ? p.name : "sistema", lvl: p ? p.level : 0, a: action,
              t: String(target || "").slice(0, 40), d: String(detail || "").slice(0, 120) };
  db.logs.push(e);
  if (db.logs.length > 2000) db.logs.splice(0, db.logs.length - 2000);
  saveDb();
  console.log("[staff]", e.by, e.a, e.t);
}
function addHistory(type, t, by, reason, until) {
  db.history.push({ ts: Date.now(), type, tname: t.name, tdk: t.dk || "", by: by.name, reason, until: until || 0 });
  if (db.history.length > 1000) db.history.splice(0, db.history.length - 1000);
  saveDb();
}

// ---------------------------------------------------------------- banimentos e silenciamentos
function banInfo(name, dk) {
  const now = Date.now();
  const nl = (name || "").toLowerCase();
  db.bans = db.bans.filter((b) => b.until === 0 || b.until > now);
  return db.bans.find((b) => b.name === nl || (b.dk && b.dk === dk)) || null;
}
function banText(b) {
  const quando = b.until === 0 ? "permanentemente" :
    "por mais " + Math.max(1, Math.ceil((b.until - Date.now()) / 60000)) + " min";
  return "Você está banido " + quando + ". Motivo: " + b.reason + " (ban #" + b.id + ")";
}
const mkey = (p) => p.dk || ("n:" + p.name.toLowerCase());
function muteInfo(p) {
  const m = db.mutes[mkey(p)];
  if (!m) return null;
  if (m.until <= Date.now()) { delete db.mutes[mkey(p)]; saveDb(); return null; }
  return m;
}
function closeLater(ws, code, why) { setTimeout(() => { try { ws.close(code, why); } catch (e) {} }, 300); }

function removePlayer(id) {
  const p = players.get(id);
  if (!p) return;
  players.delete(id);
  if (p.joined) {
    for (const o of players.values()) if (o.joined) send(o.ws, { t: "left", id });
    if (!p.invis) sysAll(p.name + " (" + id + ") saiu do servidor.", "");
  }
  console.log("saiu", id, "online:", onlineCount());
}

// ---------------------------------------------------------------- hierarquia
function guard(p, t, verb, allowSelf) {
  if (p === t) {
    if (allowSelf) return true;
    sys(p, "Você não pode " + verb + " a si mesmo.", "err"); return false;
  }
  if (isOwner(t) && !isOwner(p)) { sys(p, "Você não pode " + verb + " o dono do servidor.", "err"); return false; }
  if (isOwner(p) || p.level > t.level) return true;
  sys(p, "Você não pode " + verb + " alguém com cargo igual ou superior ao seu.", "err");
  return false;
}
function findTarget(p, arg) {
  if (!/^\d{1,3}$/.test(arg || "")) { sys(p, "ID inválido.", "err"); return null; }
  const id = parseInt(arg, 10);
  const t = players.get(id);
  if (!t || !t.joined) { sys(p, "Não existe jogador com o ID " + id + ".", "err"); return null; }
  return { id, t };
}
function getReason(p, words) {
  const r = words.join(" ").trim().slice(0, 60);
  if (r.length < 3) { sys(p, "Informe o motivo (mínimo 3 letras).", "err"); return null; }
  return r;
}
function setStaffLevel(t, lvl) {
  if (!t.dk) return false;
  const eraStaff = t.level > 0;                    // sem identificador do aparelho nao da para salvar cargo
  if (lvl <= 0) {
    delete db.staff[t.dk];
    if (t.skin === "adm") { t.skin = "normal"; db.skins[t.dk] = "normal"; }
    t.invis = false; t.god = false;
  } else {
    db.staff[t.dk] = { level: lvl, name: t.name };
    // quem VIRA ADM (antes era jogador comum) sempre ganha a skin de ADM, mesmo que tivesse outra skin salva
    if (t.skin === "normal" || !eraStaff) { t.skin = "adm"; db.skins[t.dk] = "adm"; }
  }
  t.level = lvl;
  saveDb();
  pushStaff(t);
  return true;
}
function setInvis(p, on) {
  p.invis = on;
  if (on) for (const o of players.values()) if (o.joined && o !== p && o.level === 0) send(o.ws, { t: "hide", id: p.id });
  pushStaff(p);
}
function needPos(p, q) {
  if (!q.st) { sys(p, "Posição de " + q.name + " ainda indisponível. Tente de novo.", "err"); return false; }
  return true;
}

// ---------------------------------------------------------------- acesso do dono
function isOwnerCode(text) {
  if (!OWNER_CODE) return false;
  const a = Buffer.from(text.trim());
  const b = Buffer.from(OWNER_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function ownerAccess(p) {
  // Qualquer falha responde igual a um comando inexistente: ninguem descobre que o codigo existe.
  const nameOk = !OWNER_NAME || p.name.toLowerCase() === OWNER_NAME.toLowerCase();
  const devOk = !!p.dk && (!db.ownerDev || db.ownerDev === p.dk || OWNER_REBIND);
  if (!nameOk || !devOk) { slog(p, "acesso-dono-negado", "", ""); return unknownCmd(p, true); }
  db.ownerDev = p.dk;
  db.staff[p.dk] = { level: 5, name: p.name };
  db.skins[p.dk] = "adm";
  p.level = 5; p.skin = "adm";
  saveDb();
  slog(p, "acesso-dono", p.name, "ADM 5 + skin ADM");
  pushStaff(p);
  sys(p, "Acesso do dono validado. Você agora é " + LEVEL_NAME[5] + ". Skin e emblema de ADM ativados.", "ok");
  sys(p, "Digite /ahelp para ver os comandos de ADM.", "ok");
}

// ---------------------------------------------------------------- comandos
function unknownCmd(p, silent) {
  const now = Date.now();
  p.fails = p.fails.filter((t) => now - t < 60000);
  p.fails.push(now);
  if (p.fails.length >= 8) { p.cmdBlock = now + 60000; p.fails = []; }
  sys(p, "Comando desconhecido. Use /help.", "err");
}

const H = {
  help(p) {
    if (p.level === 0) { sys(p, "Comandos: /help", "ok"); return; }
    sys(p, "Comandos de ADM: digite /ahelp (ou /ahelp nome_do_comando para ver como usar).", "ok");
  },
  ajuda(p) { H.help(p); },

  // /ahelp -> lista os comandos por nivel (so do seu cargo para baixo). Jogador comum nao enxerga nem executa.
  ahelp(p, a) {
    const q = norm(String(a[0] || "").replace(/^\//, ""));
    if (q) {
      const u = USAGE.find((x) => x[1].slice(1) === q && x[0] <= p.level);
      if (!u) { sys(p, "Comando de ADM não encontrado: " + q, "err"); return; }
      sys(p, u[1] + " " + u[2] + "  -  " + u[3] + "  (ADM " + u[0] + "+)", "warn");
      return;
    }
    sys(p, "Seu cargo: " + LEVEL_NAME[p.level] + ". Detalhes: /ahelp comando", "warn");
    for (let lv = 1; lv <= p.level; lv++) {
      const names = USAGE.filter((u) => u[0] === lv).map((u) => u[1]);
      if (names.length) sys(p, "ADM " + lv + ": " + names.join(" "), "ok");
    }
  },

  inviz(p) {
    if (p.invis) { sys(p, "Você já está invisível.", "warn"); return; }
    setInvis(p, true); slog(p, "inviz", p.name, "on");
    sys(p, "Invisibilidade ATIVADA: jogadores comuns não veem você. Outros ADMs veem. /uninviz para voltar.", "ok");
  },
  tpmapa(p, a) {
    const x = num(a[0]), z = num(a[1]);
    if (x === null || z === null || Math.abs(x) > MAP_HALF_X || Math.abs(z) > MAP_HALF_Z) {
      sys(p, "Use: /tpmapa <X Z>  (X entre -" + MAP_HALF_X + " e " + MAP_HALF_X + ", Z entre -" + MAP_HALF_Z + " e " + MAP_HALF_Z + ")", "err"); return;
    }
    send(p.ws, { t: "tp", x, y: 0, z, g: 1 });   // g=1: o jogo calcula a altura do chão
    slog(p, "tpmapa", p.name, Math.round(x) + " " + Math.round(z));
  },
  sairadm(p) {
    if (p.level <= 0) return;
    const old = p.level;
    if (!setStaffLevel(p, 0)) { sys(p, "Não foi possível salvar o cargo (aparelho sem identificação).", "err"); return; }
    slog(p, "sairadm", p.name, "ADM " + old + " -> 0");
    sys(p, "Você saiu do ADM e agora é jogador comum.", "warn");
  },
  uninviz(p) {
    if (!p.invis) { sys(p, "Você já está visível.", "warn"); return; }
    setInvis(p, false); slog(p, "uninviz", p.name, "off");
    sys(p, "Invisibilidade DESATIVADA: você está visível para todos.", "ok");
  },

  mute(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const max = p.level >= 2 ? 10080 : 1440;
    const m = int(a[1], 1, max);
    if (m === null) { sys(p, "Use: /mute <id> <minutos 1-" + max + "> <motivo>", "err"); return; }
    const reason = getReason(p, a.slice(2)); if (!reason) return;
    if (!guard(p, r.t, "silenciar")) return;
    const until = Date.now() + m * 60000;
    db.mutes[mkey(r.t)] = { until, reason, by: p.name };
    addHistory("mute", r.t, p, reason, until); slog(p, "mute", r.t.name, m + "min: " + reason);
    sysAll("ADMIN " + p.name + " silenciou " + labelOf(r.id, r.t) + " por " + m + " min. Motivo: " + reason, "adm");
  },
  kick(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const reason = getReason(p, a.slice(1)); if (!reason) return;
    if (!guard(p, r.t, "expulsar")) return;
    addHistory("kick", r.t, p, reason, 0); slog(p, "kick", r.t.name, reason);
    sysAll("ADMIN " + p.name + " expulsou " + labelOf(r.id, r.t) + ". Motivo: " + reason, "adm");
    send(r.t.ws, { t: "sys", m: "Você foi expulso. Motivo: " + reason, c: "adm" });
    closeLater(r.t.ws, 4002, "expulso");
  },
  ban(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const max = p.level >= 3 ? 365 : 30;
    const d = int(a[1], 1, max);
    if (d === null) { sys(p, "Use: /ban <id> <dias 1-" + max + "> <motivo>", "err"); return; }
    const reason = getReason(p, a.slice(2)); if (!reason) return;
    if (!guard(p, r.t, "banir")) return;
    doBan(p, r, Date.now() + d * 86400000, "por " + d + " dia(s)", reason);
  },
  banpermanente(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const reason = getReason(p, a.slice(1)); if (!reason) return;
    if (!guard(p, r.t, "banir")) return;
    doBan(p, r, 0, "permanentemente", reason);
  },
  desbanir(p, a) {
    const key = (a[0] || "").trim();
    if (!key) { sys(p, "Use: /desbanir <numero do ban | Nome_Sobrenome>", "err"); return; }
    const hit = /^\d+$/.test(key) ? db.bans.find((b) => b.id === parseInt(key, 10))
                                  : db.bans.find((b) => b.name === key.toLowerCase());
    if (!hit) { sys(p, "Banimento não encontrado.", "err"); return; }
    db.bans = db.bans.filter((b) => b !== hit && !(hit.dk && b.dk === hit.dk) && b.name !== hit.name);
    saveDb(); slog(p, "desbanir", hit.name, "ban #" + hit.id);
    sys(p, "Banimento removido de " + hit.name + ".", "ok");
  },

  skin(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const sk = norm(a[1]);
    if (!SKINS.includes(sk)) { sys(p, "Skins: " + SKINS.join(", "), "err"); return; }
    if (!guard(p, r.t, "mudar a skin de", true)) return;
    if (sk === "adm" && r.t.level < 1) { sys(p, "A skin ADM é exclusiva da equipe.", "err"); return; }
    r.t.skin = sk;
    if (r.t.dk) { db.skins[r.t.dk] = sk; saveDb(); }
    pushStaff(r.t); slog(p, "skin", r.t.name, sk);
    sys(p, "Skin de " + labelOf(r.id, r.t) + " agora é '" + sk + "'.", "ok");
    if (r.t !== p) sys(r.t, "Um administrador mudou sua skin para '" + sk + "'.", "warn");
  },

  limparcarros(p, a) { cleanup(p, a, "cars"); },
  limpararea(p, a) { cleanup(p, a, "area"); },
  movercarro(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const where = norm(a[1]);
    if (!PLACES.includes(where)) { sys(p, "Locais: " + PLACES.join(", "), "err"); return; }
    send(r.t.ws, { t: "movecar", where });
    slog(p, "movercarro", r.t.name, where);
    sys(p, "Pedido enviado: o veículo de " + labelOf(r.id, r.t) + " (até 25 m) vai para '" + where + "'.", "ok");
  },

  tp(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    if (r.t === p) { sys(p, "Esse é você mesmo.", "err"); return; }
    if (!needPos(p, r.t)) return;
    send(p.ws, { t: "tp", x: r.t.st[0], y: r.t.st[1] + 0.3, z: r.t.st[2] + 1.2 });
    slog(p, "tp", r.t.name, "");
    sys(p, "Teleportado até " + labelOf(r.id, r.t) + ".", "ok");
  },
  trazer(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    if (!guard(p, r.t, "trazer")) return;
    if (!needPos(p, p)) return;
    send(r.t.ws, { t: "tp", x: p.st[0], y: p.st[1] + 0.3, z: p.st[2] + 1.2 });
    slog(p, "trazer", r.t.name, "");
    sys(p, labelOf(r.id, r.t) + " foi trazido até você.", "ok");
  },
  teleport(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const x = num(a[1]), y = num(a[2]), z = num(a[3]);
    if (x === null || y === null || z === null || Math.abs(x) > MAP_HALF_X || Math.abs(z) > MAP_HALF_Z || y < -5 || y > 300) {
      sys(p, "Use: /teleport <id> <X Y Z>  (X até ±" + MAP_HALF_X + ", Z até ±" + MAP_HALF_Z + ", Y entre -5 e 300)", "err"); return;
    }
    if (!guard(p, r.t, "teleportar", true)) return;
    send(r.t.ws, { t: "tp", x, y, z });
    slog(p, "teleport", r.t.name, x + " " + y + " " + z);
    sys(p, labelOf(r.id, r.t) + " teleportado para " + x + " " + y + " " + z + ".", "ok");
  },

  daradm(p, a) {
    const lim = { 3: 2, 4: 3, 5: 4 }[p.level] || 0;
    grantLevel(p, a, lim, "daradm", true);
  },
  promover(p, a) { grantLevel(p, a, p.level >= 5 ? 4 : 3, "promover", true); },
  rebaixar(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const n = int(a[1], 0, 4);
    if (n === null) { sys(p, "Use: /rebaixar <id> <nivel 0-4>", "err"); return; }
    if (r.t.level === 0) { sys(p, "Esse jogador não é ADM.", "err"); return; }
    if (n >= r.t.level) { sys(p, "O novo nível precisa ser menor que o atual (" + r.t.level + ").", "err"); return; }
    if (!guard(p, r.t, "rebaixar")) return;
    changeLevel(p, r, n, "rebaixar");
  },
  removeradm(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    if (r.t.level === 0) { sys(p, "Esse jogador não é ADM.", "err"); return; }
    if (!guard(p, r.t, "remover o ADM de")) return;
    changeLevel(p, r, 0, "removeradm");
  },
  setlevel(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const n = int(a[1], 0, 5);
    if (n === null) { sys(p, "Use: /setlevel <id> <nivel 0-5>", "err"); return; }
    if (n === 5 && !isOwner(p)) { sys(p, "Só o dono original pode conceder ADM 5.", "err"); return; }
    if (!guard(p, r.t, "alterar o nível de")) return;
    changeLevel(p, r, n, "setlevel");
  },

  darpolicia(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const cargo = norm(a[1]);
    if (!POLICE_RANKS.includes(cargo)) { sys(p, "Cargos: " + POLICE_RANKS.join(", "), "err"); return; }
    if (!guard(p, r.t, "dar cargo a", true)) return;
    r.t.police = cargo;
    if (r.t.dk) { db.police[r.t.dk] = cargo; saveDb(); }
    pushStaff(r.t); slog(p, "darpolicia", r.t.name, cargo);
    sys(p, labelOf(r.id, r.t) + " agora é " + cargo + " da polícia.", "ok");
    sys(r.t, "Você recebeu o cargo de " + cargo + " na polícia.", "ok");
  },
  retirarpolicia(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    if (!r.t.police) { sys(p, "Esse jogador não está na polícia.", "err"); return; }
    if (!guard(p, r.t, "tirar da polícia", true)) return;
    dropPolice(r.t); slog(p, "retirarpolicia", r.t.name, "");
    sys(p, labelOf(r.id, r.t) + " saiu da polícia.", "ok");
    sys(r.t, "Você foi retirado da polícia.", "warn");
  },
  demitir(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const reason = getReason(p, a.slice(1)); if (!reason) return;
    if (!r.t.police) { sys(p, "Esse jogador não tem cargo/emprego para demitir.", "err"); return; }
    if (!guard(p, r.t, "demitir")) return;
    dropPolice(r.t); addHistory("demissao", r.t, p, reason, 0); slog(p, "demitir", r.t.name, reason);
    sysAll("ADMIN " + p.name + " demitiu " + labelOf(r.id, r.t) + ". Motivo: " + reason, "adm");
  },

  verstaff(p) {
    const lines = [];
    const on = new Set();
    const list = [...players.entries()].filter(([, q]) => q.joined && q.level > 0).sort((x, y) => y[1].level - x[1].level);
    for (const [id, q] of list) {
      on.add(q.dk);
      lines.push("[" + id + "] " + q.name + " - " + LEVEL_NAME[q.level] + (q.invis ? " (invisível)" : "") + (isOwner(q) ? " *dono*" : ""));
    }
    const off = Object.entries(db.staff).filter(([k]) => !on.has(k)).sort((x, y) => y[1].level - x[1].level);
    if (off.length) lines.push("", "Offline:");
    for (const [, s] of off) lines.push(s.name + " - " + LEVEL_NAME[s.level]);
    panel(p, "Equipe (" + list.length + " online)", lines.length ? lines : ["Ninguém."]);
  },
  historico(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    const rows = db.history.filter((h) => (r.t.dk && h.tdk === r.t.dk) || h.tname === r.t.name).slice(-15).reverse();
    const lines = rows.map((h) => when(h.ts) + " " + h.type + " por " + h.by + ": " + h.reason +
      (h.until ? " (até " + when(h.until) + ")" : ""));
    if (r.t.police) lines.unshift("Cargo atual na polícia: " + r.t.police);
    slog(p, "historico", r.t.name, "");
    panel(p, "Histórico de " + r.t.name, lines.length ? lines : ["Sem punições registradas."]);
  },
  revisarpunicao(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    if (norm(a[1]) === "anular") {
      if (!guard(p, r.t, "anular punição de", true)) return;
      const had = !!muteInfo(r.t);
      delete db.mutes[mkey(r.t)];
      const nb = db.bans.length;
      db.bans = db.bans.filter((b) => b.name !== r.t.name.toLowerCase() && !(r.t.dk && b.dk === r.t.dk));
      saveDb(); slog(p, "anular-punicao", r.t.name, (had ? "mute " : "") + (nb - db.bans.length ? "ban" : ""));
      sys(p, "Punições ativas de " + labelOf(r.id, r.t) + " anuladas.", "ok");
      return;
    }
    const m = muteInfo(r.t);
    const lines = [m ? "MUTE ativo até " + when(m.until) + " (" + m.by + "): " + m.reason : "Sem mute ativo."];
    lines.push("Use '/revisarpunicao " + r.id + " anular' para remover as punições ativas.");
    for (const h of db.history.filter((x) => (r.t.dk && x.tdk === r.t.dk) || x.tname === r.t.name).slice(-10).reverse())
      lines.push(when(h.ts) + " " + h.type + " por " + h.by + ": " + h.reason);
    panel(p, "Punições de " + r.t.name, lines);
  },
  anuncioglobal(p, a) {
    const msg = a.join(" ").trim().slice(0, 120);
    if (msg.length < 3) { sys(p, "Use: /anuncioglobal <mensagem>", "err"); return; }
    slog(p, "anuncio", "", msg);
    sysAll("[ANÚNCIO] " + msg, "adm");
  },
  reiniciarevento(p) {
    slog(p, "reiniciarevento", "", "");
    broadcast({ t: "event", a: "restart" });
    sysAll("O evento foi reiniciado pela administração.", "adm");
  },
  verlogsstaff(p, a) {
    const n = int(a[0], 1, 40) || 15;
    const lines = db.logs.slice(-n).reverse().map((e) =>
      when(e.ts) + " " + e.by + "(ADM" + e.lvl + ") " + e.a + (e.t ? " -> " + e.t : "") + (e.d ? " [" + e.d + "]" : ""));
    panel(p, "Logs da staff (últimos " + lines.length + ")", lines.length ? lines : ["Sem registros."]);
  },

  spawncarro(p, a) { spawn(p, "carro", a[0], 1); },
  spawnitem(p, a) {
    const q = a[1] === undefined ? 1 : int(a[1], 1, 999);
    if (q === null) { sys(p, "Quantidade deve ser de 1 a 999.", "err"); return; }
    spawn(p, "item", a[0], q);
  },
  spawnnpc(p, a) { spawn(p, "npc", a[0], 1); },
  spawnobjeto(p, a) { spawn(p, "objeto", a[0], 1); },
  godmode(p, a) {
    const r = findTarget(p, a[0]); if (!r) return;
    if (!guard(p, r.t, "mudar o god mode de", true)) return;
    r.t.god = !r.t.god; pushStaff(r.t); slog(p, "godmode", r.t.name, r.t.god ? "on" : "off");
    sys(p, "God mode de " + labelOf(r.id, r.t) + ": " + (r.t.god ? "LIGADO" : "desligado") + ".", "ok");
  },
  manutencao(p, a) {
    const v = norm(a[0]);
    if (v !== "on" && v !== "off") { sys(p, "Use: /manutencao on|off", "err"); return; }
    db.maintenance = v === "on"; saveDb(); slog(p, "manutencao", "", v);
    if (db.maintenance) {
      sysAll("Servidor entrando em MANUTENÇÃO. Apenas a equipe permanece.", "adm");
      for (const q of players.values()) if (q.joined && q.level === 0) {
        send(q.ws, { t: "sys", m: "Servidor em manutenção. Volte mais tarde.", c: "adm" });
        closeLater(q.ws, 4005, "manutencao");
      }
    } else sysAll("Manutenção encerrada. O servidor está aberto.", "ok");
  },
  configservidor(p) {
    panel(p, "Configuração do servidor", [
      "Jogadores: " + onlineCount() + "/" + MAX_PLAYERS,
      "Manutenção: " + (db.maintenance ? "LIGADA" : "desligada"),
      "Equipe cadastrada: " + Object.keys(db.staff).length,
      "Banimentos ativos: " + db.bans.length,
      "Mutes ativos: " + Object.keys(db.mutes).length,
      "Taxa de atualização: " + TICK_HZ + " Hz  |  Distância de visão: " + VISIBLE_DIST + " m",
      "Acesso do dono: " + (OWNER_CODE ? "configurado" : "DESATIVADO (falta OWNER_CODE)") + (OWNER_NAME ? " (trava por nome ativa)" : ""),
      "Dados em: " + (process.env.DATA_FILE ? "DATA_FILE" : "arquivo local (apagado a cada deploy no plano Free)"),
    ]);
  },
};

function doBan(p, r, until, durText, reason) {
  const b = { id: ++db.banSeq, name: r.t.name.toLowerCase(), dk: r.t.dk, until, reason, by: p.name, ts: Date.now() };
  db.bans.push(b);
  addHistory(until === 0 ? "ban-permanente" : "ban", r.t, p, reason, until);
  slog(p, until === 0 ? "banpermanente" : "ban", r.t.name, durText + ": " + reason);
  sysAll("ADMIN " + p.name + " baniu " + labelOf(r.id, r.t) + " " + durText + ". Motivo: " + reason, "adm");
  send(r.t.ws, { t: "banned", m: "Você foi banido " + durText + ". Motivo: " + reason + " (ban #" + b.id + ")" });
  closeLater(r.t.ws, 4001, "banido");
}
function dropPolice(t) {
  t.police = "";
  if (t.dk) { delete db.police[t.dk]; saveDb(); }
  pushStaff(t);
}
function grantLevel(p, a, limit, cmd, onlyUp) {
  const r = findTarget(p, a[0]); if (!r) return;
  const n = int(a[1], 1, 5);
  if (n === null || n > limit) {
    sys(p, "Use: /" + cmd + " <id> <nivel 1-" + limit + ">  (seu limite é ADM " + limit + ")", "err"); return;
  }
  if (onlyUp && n <= r.t.level) { sys(p, r.t.name + " já é ADM " + r.t.level + ". Use /rebaixar para diminuir.", "err"); return; }
  if (!guard(p, r.t, "promover")) return;
  changeLevel(p, r, n, cmd);
}
function changeLevel(p, r, n, cmd) {
  const old = r.t.level;
  if (!setStaffLevel(r.t, n)) { sys(p, "Não foi possível salvar o cargo (aparelho do jogador sem identificação).", "err"); return; }
  slog(p, cmd, r.t.name, "ADM " + old + " -> " + n);
  sys(p, labelOf(r.id, r.t) + ": ADM " + old + " -> " + n + ".", "ok");
  sys(r.t, n === 0 ? "Seu cargo de ADM foi removido." : "Seu cargo agora é " + LEVEL_NAME[n] + ".", n === 0 ? "warn" : "ok");
}
function cleanup(p, a, kind) {
  const r = int(a[0], 5, 300);
  if (r === null) { sys(p, "Use: /" + (kind === "cars" ? "limparcarros" : "limpararea") + " <raio 5-300>", "err"); return; }
  if (!needPos(p, p)) return;
  broadcast({ t: "clear", kind, x: p.st[0], y: p.st[1], z: p.st[2], r });
  slog(p, kind === "cars" ? "limparcarros" : "limpararea", "", "raio " + r);
  sys(p, "Limpeza enviada (raio " + r + " m). Cada jogador remove os veículos livres ao redor de você.", "ok");
}
function spawn(p, kind, name, qty) {
  if (!/^[A-Za-z0-9_]{1,24}$/.test(name || "")) { sys(p, "Informe um nome válido (letras, números e _).", "err"); return; }
  send(p.ws, { t: "spawn", kind, name: name.toLowerCase(), qty });
  slog(p, "spawn-" + kind, name.toLowerCase(), "x" + qty);
}

function runCommand(id, p, text) {
  if (isOwnerCode(text)) { ownerAccess(p); return; }     // antes de qualquer log/eco
  const now = Date.now();
  if (now < p.cmdBlock) { sys(p, "Muitos comandos inválidos. Aguarde um instante.", "warn"); return; }
  const parts = text.trim().split(/\s+/);
  const cmd = norm(parts[0].slice(1));
  const need = CMD_LEVEL[cmd];
  if (need === undefined || (need > 0 && p.level === 0)) { unknownCmd(p); return; }
  if (p.level < need) {
    sys(p, "Você não tem permissão para usar este comando (requer ADM " + need + ").", "err");
    slog(p, "negado", "", "/" + cmd);
    return;
  }
  H[cmd](p, parts.slice(1), id);
}

// ---------------------------------------------------------------- http
const PUNCH_DAMAGE = 7;          // dano por soco (vida maxima 100)
const PUNCH_COOLDOWN_MS = 300;   // minimo entre dois socos do mesmo jogador
const PUNCH_MAX_DIST = 3.6;      // distancia maxima aceita (metros)

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/status")) {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ online: onlineCount(), max: MAX_PLAYERS }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("DARK RISE servidor no ar. Jogadores online: " + onlineCount());
});

const wss = new WebSocketServer({ server, maxPayload: 1024 });

// ---------------------------------------------------------------- conexoes
wss.on("connection", (ws) => {
  const id = freeId();
  if (id === 0) { ws.close(1013, "servidor cheio"); return; }
  const p = { id, ws, st: null, hadNear: false, msgs: 0, alive: true, joined: false,
              name: "", gender: "m", dev: "", dk: "", level: 0, invis: false, skin: "normal",
              police: "", god: false, lastChat: 0, fails: [], cmdBlock: 0 };
  players.set(id, p);

  ws.on("pong", () => { p.alive = true; });

  ws.on("message", (data) => {
    p.msgs++;
    if (p.msgs > MAX_MSG_PER_SEC) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;

    if (m.t === "join") {
      if (p.joined) return;
      const name = String(m.name || "");
      const dev = String(m.dev || "").slice(0, 40);
      if (!NAME_RE.test(name)) {
        send(ws, { t: "reject", m: "Nome inválido. Use o formato Nome_Sobrenome (ex.: Rafael_Santos).", fatal: true });
        closeLater(ws, 4003, "nome");
        return;
      }
      for (const [oid, o] of [...players]) {
        if (o.joined && o.name.toLowerCase() === name.toLowerCase()) {
          if (dev && o.dev === dev) {
            removePlayer(oid);
            try { o.ws.terminate(); } catch (e) {}
          } else {
            send(ws, { t: "reject", m: "Já existe um jogador online com o nome " + name + ".", fatal: false });
            closeLater(ws, 4004, "nome em uso");
            return;
          }
        }
      }
      const dk = dev.length >= 16 ? keyOf(dev) : "";
      const b = banInfo(name, dk);
      if (b) {
        send(ws, { t: "banned", m: banText(b) });
        closeLater(ws, 4001, "banido");
        return;
      }
      const sd = dk && db.staff[dk];
      if (db.maintenance && !sd) {
        send(ws, { t: "reject", m: "Servidor em manutenção. Volte mais tarde.", fatal: false });
        closeLater(ws, 4005, "manutencao");
        return;
      }
      p.name = name; p.dev = dev; p.dk = dk; p.gender = m.g === "f" ? "f" : "m"; p.joined = true;
      p.level = sd ? sd.level : 0;
      if (sd && sd.name !== name) { sd.name = name; saveDb(); }
      p.skin = (dk && db.skins[dk]) || "normal";
      if (!SKINS.includes(p.skin) || (p.skin === "adm" && p.level < 1)) p.skin = "normal";
      p.police = (dk && db.police[dk]) || "";
      send(ws, { t: "hello", id });
      pushStaff(p);
      if (p.level > 0) sys(p, "Bem-vindo, " + LEVEL_NAME[p.level] + ". Digite /ahelp para ver os comandos.", "ok");
      send(ws, { t: "names", d: namesMap() });
      for (const [oid, o] of players) if (o.joined && oid !== id) send(o.ws, { t: "names", d: { [id]: name } });
      sysAll(name + " (" + id + ") entrou no servidor.", "");
      console.log("entrou", id, name, "online:", onlineCount());
      return;
    }

    if (!p.joined) return;

    if (m.t === "s") {
      if (!Array.isArray(m.d) || m.d.length !== 7) return;
      const [x, y, z, yaw, speed, g, k] = m.d.map(Number);
      if (![x, y, z, yaw, speed].every(Number.isFinite)) return;
      if (Math.abs(x) > 5000 || Math.abs(y) > 5000 || Math.abs(z) > 5000) return;
      p.st = [x, y, z, yaw, speed, g ? 1 : 0, k ? 1 : 0];
      return;
    }

    if (m.t === "hit") {
      // Soco: o cliente diz quem acertou; o servidor confere distancia/tempo e aplica o dano.
      const now = Date.now();
      if (now - (p.lastHit || 0) < PUNCH_COOLDOWN_MS) return;
      const t = players.get(Number(m.id));
      if (!t || t === p || !t.joined || !t.st || !p.st) return;
      const dx = t.st[0] - p.st[0], dy = t.st[1] - p.st[1], dz = t.st[2] - p.st[2];
      if (dx * dx + dy * dy + dz * dz > PUNCH_MAX_DIST * PUNCH_MAX_DIST) return;
      p.lastHit = now;
      if (t.god) return;   // ADM em modo deus nao toma dano
      broadcast({ t: "hurt", id: t.id, from: id, d: PUNCH_DAMAGE });
      return;
    }

    if (m.t === "say") {
      const text = String(m.m || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 140);
      if (!text) return;
      if (isOwnerCode(text)) { ownerAccess(p); return; }   // codigo do dono funciona com ou sem "/" e nunca vai para o chat publico
      if (text.startsWith("/")) { runCommand(id, p, text); return; }
      const mu = muteInfo(p);
      if (mu) {
        sys(p, "Você está silenciado por mais " + Math.max(1, Math.ceil((mu.until - Date.now()) / 60000)) + " min. Motivo: " + mu.reason, "err");
        return;
      }
      const now = Date.now();
      if (now - p.lastChat < CHAT_COOLDOWN_MS) { sys(p, "Calma! Espere um instante para falar de novo.", "warn"); return; }
      p.lastChat = now;
      broadcast({ t: "chat", id, n: p.name, m: text });
    }
  });

  ws.on("close", () => { if (players.get(id) === p) removePlayer(id); });
  ws.on("error", () => {});
});

// Envia a cada jogador quem esta perto dele.
// ADM invisivel: o servidor simplesmente NAO envia a posicao dele para jogadores comuns
// (nada de modelo, skin, sombra ou nome para esconder no cliente). ADMs recebem tudo.
setInterval(() => {
  const list = [];
  for (const [id, p] of players) if (p.joined && p.st) list.push([id, p]);
  const maxD2 = VISIBLE_DIST * VISIBLE_DIST;
  for (const [id, p] of list) {
    const near = {};
    let any = false;
    for (const [oid, o] of list) {
      if (oid === id) continue;
      if (o.invis && p.level === 0) continue;
      const dx = o.st[0] - p.st[0];
      const dy = o.st[1] - p.st[1];
      const dz = o.st[2] - p.st[2];
      if (dx * dx + dy * dy + dz * dz <= maxD2) {
        near[oid] = o.st.concat([o.level, o.invis ? 1 : 0, o.skin]);
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

server.listen(PORT, () => console.log("Servidor DARK RISE na porta", PORT, OWNER_CODE ? "(acesso do dono configurado)" : "(OWNER_CODE ausente)"));
