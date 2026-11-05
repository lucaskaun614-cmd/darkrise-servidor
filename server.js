// Servidor multiplayer DARK RISE (WebSocket) - feito para o Render (plano Free).
// Repassa a posicao dos jogadores proximos, o chat e o sistema de STAFF (ADM 1 a 5).
//
// VARIAVEIS DE AMBIENTE (Render > Environment):
//   OWNER_CODE   codigo secreto do dono (o texto secreto que voce digita no chat).
//                Sem essa variavel o acesso do dono fica DESATIVADO. Nao coloque o codigo no GitHub.
//   OWNER_NAME   (opcional, recomendado) Nome_Sobrenome do personagem do dono. Se definido,
//                so esse personagem consegue usar o codigo.
//   OWNER_REBIND (opcional) "1" = deixa o dono vincular um aparelho novo (use so ao trocar de celular).
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   (login com Google) ids criados no Google Cloud (OAuth, "Aplicativo da Web").
//                Sem elas o botao "Entrar com o Google" mostra uma mensagem de "nao configurado" e o Convidado segue funcionando.
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
// E-mails Google que viram DONO (ADM 5) automaticamente ao entrar com o Google. Sem nome e sem codigo.
// Para mudar sem editar o codigo: variavel OWNER_EMAILS no Render (separe por virgula).
const OWNER_EMAILS = (process.env.OWNER_EMAILS || "lucaskaun614@gmail.com").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "darkrise_data.json");
const MAX_PLAYERS = 24;
const TICK_HZ = 15;
const VISIBLE_DIST = 200;
const MAX_MSG_PER_SEC = 80;
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
  [5, "/doze", "me|ID balas", "Dá a espingarda Doze com munição (ex.: /doze me 100)"],
  [5, "/manutencao", "on|off", "Modo manutenção"],
  [5, "/configservidor", "", "Mostra a configuração"],
];
const CMD_LEVEL = { help: 0, ajuda: 0 };
for (const u of USAGE) CMD_LEVEL[u[1].slice(1)] = u[0];

// ---------------------------------------------------------------- dados persistentes
// Aparelhos sao guardados so como hash (se o arquivo vazar, ninguem consegue se passar por um ADM).
const EMPTY_DB = () => ({
  ownerDev: "", staff: {}, police: {}, skins: {}, bans: [], banSeq: 0, mutes: {}, glink: {},
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
  // Aceita o codigo com ou sem "/" na frente, tanto no que o jogador digita quanto no OWNER_CODE do Render.
  const strip = (t) => String(t).trim().replace(/^\/+/, "");
  const a = Buffer.from(strip(text));
  const b = Buffer.from(strip(OWNER_CODE));
  if (!b.length) return false;
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function ownerAccess(p) {
  // Qualquer falha responde igual a um comando inexistente: ninguem descobre que o codigo existe.
  // v3.10.1: so o codigo do dono vale. Trava por nome (OWNER_NAME) e por aparelho (OWNER_REBIND) foram removidas.
  const devOk = !!p.dk;   // precisa de uma chave de jogador para guardar o cargo
  if (!devOk) { slog(p, "acesso-dono-negado", "", ""); return unknownCmd(p, true); }
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
  doze(p, a) {
    let r;
    if (norm(a[0]) === "me") r = { id: p.id, t: p };
    else { r = findTarget(p, a[0]); if (!r) return; }
    const n = int(a[1], 1, 500);
    if (n === null) { sys(p, "Use: /doze me <balas>  ou  /doze <id> <balas>  (1 a 500).", "err"); return; }
    r.t.doze = true;
    r.t.ammo = Math.min(DOZE_MAX_AMMO, (r.t.ammo || 0) + n);
    send(r.t.ws, { t: "weapon", has: 1, ammo: r.t.ammo });
    slog(p, "doze", r.t.name, n + " balas");
    if (r.t === p) sys(p, "Você recebeu a Doze com " + n + " balas (total: " + p.ammo + ").", "ok");
    else {
      sys(p, labelOf(r.id, r.t) + " recebeu " + n + " balas da Doze (total: " + r.t.ammo + ").", "ok");
      sys(r.t, "Um administrador te deu a Doze com " + n + " balas.", "ok");
    }
  },
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
// Espingarda Doze (so ADM 5 entrega com /doze). O servidor controla municao, cadencia, alcance e dano.
const DOZE_MAX_AMMO = 999;
const DOZE_COOLDOWN_MS = 650;    // minimo entre dois tiros
const DOZE_RANGE = 28;           // alcance maximo (metros)
const DOZE_DMG_MAX = 80;         // dano de perto (ate 3 m)
const DOZE_DMG_MIN = 18;         // dano no alcance maximo
const DOZE_HEAR_DIST = 60;       // quem esta ate aqui ve o clarao / ouve o tiro


// ---------------------------------------------------------------- login com Google
// Fluxo: o jogo abre o navegador em /auth/google?s=<codigo>, o Google devolve o usuario em /auth/google/callback,
// o servidor guarda o resultado e o jogo busca em /auth/poll?s=<codigo>. O jogo recebe um TOKEN assinado
// (vale 90 dias) e o manda no "join". A conta Google passa a ser a "chave" do jogador (cargo, skin, ban...).
const G_ID = process.env.GOOGLE_CLIENT_ID || "";
const G_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "https://darkrise-servidor.onrender.com").replace(/\/+$/, "");
const G_REDIRECT = PUBLIC_URL + "/auth/google/callback";
const AUTH_KEY = crypto.createHash("sha256").update("dr-auth:" + G_SECRET).digest();
const AUTH_DAYS = 90;
const STATE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const pendingAuth = new Map();   // codigo -> { ok, token, email, name, err, exp }

const b64u = (b) => Buffer.from(b).toString("base64url");
function makeAuthToken(sub, email) {
  const body = b64u(JSON.stringify({ s: sub, e: email, x: Date.now() + AUTH_DAYS * 86400000 }));
  const sig = crypto.createHmac("sha256", AUTH_KEY).update(body).digest("base64url");
  return body + "." + sig;
}
function verifyAuth(tok) {
  if (!G_SECRET || typeof tok !== "string" || tok.length > 600) return null;
  const i = tok.indexOf(".");
  if (i < 1) return null;
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  const want = crypto.createHmac("sha256", AUTH_KEY).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!d || typeof d.s !== "string" || !d.s || !(d.x > Date.now())) return null;
    return { sub: d.s, e: String(d.e || "") };
  } catch (e) { return null; }
}
// Conta Google -> chave do jogador. A 1a vez, a conta herda a chave do aparelho (mantem cargo/skin ja existentes),
// desde que esse aparelho ainda nao pertenca a outra conta Google.
function accountKey(sub, devDk) {
  if (!db.glink) db.glink = {};
  if (db.glink[sub]) return db.glink[sub];
  const used = devDk && Object.values(db.glink).includes(devDk);
  const dk = devDk && !used ? devDk : keyOf("g:" + sub);
  db.glink[sub] = dk;
  saveDb();
  return dk;
}
function cleanPending() {
  const now = Date.now();
  for (const [k, v] of pendingAuth) if (v.exp < now) pendingAuth.delete(k);
  if (pendingAuth.size > 500) pendingAuth.clear();
}
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function page(res, code, title, body) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(title) + '</title><style>body{background:#0c0f1a;color:#fff;font-family:sans-serif;text-align:center;padding:40px 20px}' +
    "h1{font-size:26px}p{font-size:18px;color:#cfd6ee}a.b{display:inline-block;margin-top:22px;padding:16px 28px;background:#fff;color:#111;" +
    "border-radius:10px;text-decoration:none;font-weight:bold;font-size:20px}</style></head><body>" + body + "</body></html>");
}
async function googleCallback(url, res) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const slot = pendingAuth.get(state);
  if (!STATE_RE.test(state) || !slot) { page(res, 400, "Login expirado", "<h1>Login expirado</h1><p>Volte ao jogo e toque em Entrar com o Google de novo.</p>"); return; }
  if (!code) {
    slot.err = "Login cancelado."; page(res, 200, "Cancelado", "<h1>Login cancelado</h1><p>Volte ao jogo.</p>"); return;
  }
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: G_ID, client_secret: G_SECRET, redirect_uri: G_REDIRECT, grant_type: "authorization_code" }),
    });
    const j = await r.json();
    if (!r.ok || !j.id_token) throw new Error(j.error_description || j.error || "resposta invalida");
    const info = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString("utf8"));
    if (info.aud !== G_ID || !info.sub) throw new Error("token invalido");
    if (info.email_verified === false) throw new Error("email nao verificado");
    slot.token = makeAuthToken(String(info.sub), String(info.email || ""));
    slot.email = String(info.email || "");
    slot.name = String(info.name || "");
    slot.ok = true;
    console.log("login google ok:", slot.email);
    page(res, 200, "Login feito", "<h1>Login feito!</h1><p>Agora volte para o DARK RISE.</p>");
  } catch (e) {
    console.log("erro login google:", e.message);
    slot.err = "Não foi possível entrar com o Google.";
    page(res, 500, "Erro", "<h1>Não foi possível entrar</h1><p>Volte ao jogo e tente de novo.</p>");
  }
}
function handleAuth(req, res, url) {
  if (url.pathname === "/auth/poll") {
    const state = url.searchParams.get("s") || "";
    const slot = STATE_RE.test(state) ? pendingAuth.get(state) : null;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    if (!slot) { res.end(JSON.stringify({ ok: false })); return true; }
    if (slot.ok) { pendingAuth.delete(state); res.end(JSON.stringify({ ok: true, token: slot.token, email: slot.email, name: slot.name })); return true; }
    if (slot.err) { pendingAuth.delete(state); res.end(JSON.stringify({ ok: false, err: slot.err })); return true; }
    res.end(JSON.stringify({ ok: false }));
    return true;
  }
  if (url.pathname === "/auth/google") {
    if (!G_ID || !G_SECRET) { page(res, 200, "Não configurado", "<h1>Login com Google ainda não configurado</h1><p>Volte ao jogo e entre como Convidado.</p>"); return true; }
    const state = url.searchParams.get("s") || "";
    if (!STATE_RE.test(state)) { page(res, 400, "Erro", "<h1>Pedido inválido</h1>"); return true; }
    cleanPending();
    if (!pendingAuth.has(state)) pendingAuth.set(state, { ok: false, exp: Date.now() + 10 * 60000 });
    const go = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: G_ID, redirect_uri: G_REDIRECT, response_type: "code", scope: "openid email profile",
      state, prompt: "select_account" }).toString();
    page(res, 200, "DARK RISE", "<h1>DARK RISE</h1><p>Você abriu esta tela pelo jogo?<br>Se sim, continue com o Google.</p>" +
      '<a class="b" href="' + esc(go) + '">Continuar com o Google</a>');
    return true;
  }
  if (url.pathname === "/auth/google/callback") { googleCallback(url, res); return true; }
  return false;
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/auth/")) {
    try { if (handleAuth(req, res, new URL(req.url, "http://x"))) return; } catch (e) { res.writeHead(400); res.end("erro"); return; }
  }
  if (req.url && req.url.startsWith("/status")) {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ online: onlineCount(), max: MAX_PLAYERS }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("DARK RISE servidor no ar. Jogadores online: " + onlineCount());
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

// ---------------------------------------------------------------- conexoes
wss.on("connection", (ws) => {
  const id = freeId();
  if (id === 0) { ws.close(1013, "servidor cheio"); return; }
  const p = { id, ws, st: null, hadNear: false, msgs: 0, alive: true, joined: false,
              name: "", gender: "m", dev: "", dk: "", level: 0, invis: false, skin: "normal",
              police: "", god: false, lastChat: 0, fails: [], cmdBlock: 0,
              doze: false, ammo: 0, w: 0, lastShot: 0 };
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
      let dk = dev.length >= 16 ? keyOf(dev) : "";
      const tok = String(m.tok || "");
      const gs = tok ? verifyAuth(tok) : null;
      if (gs) dk = accountKey(gs.sub, dk);          // logado com Google: a conta vira a chave do jogador
      if (gs && dk && gs.e && OWNER_EMAILS.includes(gs.e.toLowerCase())) {   // conta Google do dono: ADM 5 + skin ADM, sem codigo
        db.ownerDev = dk;
        db.staff[dk] = { level: 5, name };
        db.skins[dk] = "adm";
        saveDb();
        console.log("dono entrou pela conta Google:", gs.e);
      }
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
      if (tok) send(ws, { t: "auth", ok: !!gs, e: gs ? gs.e : "" });
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
      p.w = p.doze ? (Number(m.w) === 2 ? 2 : 1) : 0;   // 0 sem arma, 1 nas costas, 2 nas maos
      return;
    }

    if (m.t === "voice") {
      // Audio push-to-talk: somente jogadores a ate 20 metros recebem.
      if (typeof m.d !== "string" || m.d.length > 6000 || !p.st) return;
      const audio = { t: "voice", id: p.id, d: m.d };
      const max2 = 20 * 20;
      for (const [oid, other] of players) {
        if (oid === p.id || !other.joined || !other.st) continue;
        const dx = other.st[0] - p.st[0], dy = other.st[1] - p.st[1], dz = other.st[2] - p.st[2];
        if (dx * dx + dy * dy + dz * dz <= max2) send(other.ws, audio);
      }
      return;
    }

    if (m.t === "voice_end") {
      // Pacotes de voz cessam naturalmente quando o botao e solto.
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

    if (m.t === "shoot") {
      // Tiro da Doze: o cliente diz quem acertou; o servidor confere municao, cadencia e distancia.
      const now = Date.now();
      if (!p.doze || !p.st) return;
      if (now - (p.lastShot || 0) < DOZE_COOLDOWN_MS) return;
      if (p.ammo <= 0) { send(ws, { t: "weapon", has: 1, ammo: 0 }); return; }
      p.lastShot = now;
      p.ammo -= 1;
      send(ws, { t: "weapon", has: 1, ammo: p.ammo });
      const shot = { t: "shot", id };
      const hear2 = DOZE_HEAR_DIST * DOZE_HEAR_DIST;
      for (const [oid, other] of players) {
        if (oid === id || !other.joined || !other.st) continue;
        const ex = other.st[0] - p.st[0], ey = other.st[1] - p.st[1], ez = other.st[2] - p.st[2];
        if (ex * ex + ey * ey + ez * ez <= hear2) send(other.ws, shot);
      }
      const t = players.get(Number(m.id));
      if (!t || t === p || !t.joined || !t.st) return;
      const dx = t.st[0] - p.st[0], dy = t.st[1] - p.st[1], dz = t.st[2] - p.st[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > DOZE_RANGE + 2) return;
      if (t.god) return;   // ADM em modo deus nao toma dano
      const f = Math.min(1, Math.max(0, (dist - 3) / (DOZE_RANGE - 3)));
      const dmg = Math.round(DOZE_DMG_MAX - (DOZE_DMG_MAX - DOZE_DMG_MIN) * f);
      broadcast({ t: "hurt", id: t.id, from: id, d: dmg });
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
        near[oid] = o.st.concat([o.level, o.invis ? 1 : 0, o.skin, o.w || 0]);
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
