const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

// ─── Hard limits (defense-in-depth) ─────────────────────
const MAX_NICK_LEN = 24;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 5000;
const MAX_CLIENTS_PER_SESSION = Number(process.env.MAX_CLIENTS_PER_SESSION) || 32;
/** Turn timeout — seconds for each captain to ban before auto-ban fires. */
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS) || 30_000;
// How long a disconnected player keeps their seat (captain/host/team) so a
// refresh, dropped Wi-Fi, or a brief tab close doesn't reset their role.
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 60_000;
/** Per-IP socket-event rate limits: { eventName: [maxEvents, windowMs] } */
const SOCKET_LIMITS = {
  createSession: [10, 60_000],   // 10 per minute
  joinSession:   [60, 60_000],   // 60 per minute
  claimCaptain:  [30, 60_000],
  setTeam:       [30, 60_000],
  setTeamNames:  [30, 60_000],
  startDraft:    [10, 60_000],
  banMap:        [60, 60_000],
  banAgent:      [60, 60_000],
  pickSide:      [20, 60_000],
  chatMessage:   [30, 60_000],   // 30 messages per minute per IP
  leaveSession:  [10, 60_000],
};

const CHAT_MAX_LEN = 240;
const CHAT_HISTORY = 50;
let chatMsgSeq = 0;
const SERVER_STARTED_AT = Date.now();
const APP_VERSION = process.env.APP_VERSION || "1.1.1";

function clean(s, max) {
  if (s == null) return "";
  return String(s).replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { Accept: "application/json" }, timeout: 20000 },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

const explicitPortEnv = process.env.PORT != null && String(process.env.PORT).trim() !== "";
const AGENT_BAN_COUNT = 6;
const VAL_AGENTS = "https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=en-US";
const VAL_MAPS = "https://valorant-api.com/v1/maps?language=en-US";
/** Competitive pool only (names must match Valorant API `displayName`). */
const MAP_POOL_ORDER = [
  "Ascent",
  "Abyss",
  "Bind",
  "Breeze",
  "Fracture",
  "Haven",
  "Icebox",
  "Lotus",
  "Pearl",
  "Split",
  "Sunset",
];
const ALLOWED_MAP_NAMES = new Set(MAP_POOL_ORDER.map((n) => n.toLowerCase()));

let catalog = { agents: [], maps: [] };

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ─── Permanently-unique session codes ─────────────────
// We track every code we've ever handed out (both in memory for fast lookup
// and in an append-only log on disk so codes survive restarts). A code is
// never reused — even after its session is deleted — so stale shared links
// can never accidentally join a different session.
const DATA_DIR = path.join(__dirname, "data");
const CODE_LOG_PATH = path.join(DATA_DIR, "codes.log");
const FEEDBACK_LOG_PATH = path.join(DATA_DIR, "feedback.log");
const usedCodes = new Set();

async function loadUsedCodes() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const content = await fsp.readFile(CODE_LOG_PATH, "utf8").catch(() => "");
    for (const line of String(content).split(/\r?\n/)) {
      const t = line.trim().toUpperCase();
      if (t) usedCodes.add(t);
    }
    if (usedCodes.size) {
      console.log(`Loaded ${usedCodes.size} historical session code(s) from disk.`);
    }
  } catch (e) {
    console.warn("Used-codes load failed (continuing in-memory only):", e.message);
  }
}

function persistCode(code) {
  // Fire-and-forget; we keep an in-memory copy regardless.
  fsp.appendFile(CODE_LOG_PATH, code + "\n").catch((e) => {
    console.warn("Code persist failed:", e.message);
  });
}

function generateUniqueCode(sessions) {
  for (let i = 0; i < 1000; i++) {
    const code = randomCode();
    if (!usedCodes.has(code) && !sessions.has(code)) {
      usedCodes.add(code);
      persistCode(code);
      return code;
    }
  }
  // Astronomically improbable with 32^6 = ~1B codespace, but bail safely.
  throw new Error("Could not generate a unique session code after 1000 attempts");
}

// ─── Turn timer ───────────────────────────────────────
// Auto-ban a random remaining map/agent if a captain idles longer than
// TURN_TIMEOUT_MS. The deadline (turnEndsAt) is broadcast so clients render
// an authoritative countdown.
function clearTurnTimer(session) {
  if (session._turnTimer) {
    clearTimeout(session._turnTimer);
    session._turnTimer = null;
  }
  session.turnEndsAt = null;
}

function armTurnTimer(session, io) {
  clearTurnTimer(session);
  if (session.phase !== "map_ban" && session.phase !== "agent_ban") return;
  session.turnEndsAt = Date.now() + TURN_TIMEOUT_MS;
  session._turnTimer = setTimeout(() => {
    // Validate phase is still timing — a captain may have banned just before us.
    if (session.phase !== "map_ban" && session.phase !== "agent_ban") return;
    performAutoBan(session);
    armTurnTimer(session, io);
    broadcastSession(io, session);
  }, TURN_TIMEOUT_MS);
}

function performAutoBan(session) {
  if (session.phase === "map_ban") {
    const banned = new Set(session.mapBans);
    const remaining = catalog.maps.filter((m) => !banned.has(m.uuid));
    if (remaining.length <= 1) return; // nothing meaningful to do
    const turn = session.currentTurn;
    const choice = remaining[Math.floor(Math.random() * remaining.length)];
    session.mapBans.push(choice.uuid);
    const left = catalog.maps.filter((m) => !session.mapBans.includes(m.uuid));
    if (left.length === 1) {
      session.selectedMap = left[0];
      session.sidePickerTeam = turn === "A" ? "B" : "A";
      session.phase = "side_pick";
      session.agentBans = [];
      // Side pick has no turn timer.
      clearTurnTimer(session);
    } else {
      session.currentTurn = turn === "A" ? "B" : "A";
    }
  } else if (session.phase === "agent_ban") {
    const banned = new Set(session.agentBans);
    const remaining = catalog.agents.filter((a) => !banned.has(a.uuid));
    if (!remaining.length) return;
    const choice = remaining[Math.floor(Math.random() * remaining.length)];
    session.agentBans.push(choice.uuid);
    if (session.agentBans.length >= AGENT_BAN_COUNT) {
      session.phase = "done";
      clearTurnTimer(session);
    } else {
      session.currentTurn = session.currentTurn === "A" ? "B" : "A";
    }
  }
}

async function loadCatalog() {
  const [aJson, mJson] = await Promise.all([getJson(VAL_AGENTS), getJson(VAL_MAPS)]);
  catalog.agents = (aJson.data || [])
    .filter((a) => a.uuid && a.displayName && a.fullPortrait)
    .map((a) => ({
      uuid: a.uuid,
      name: a.displayName,
      image: a.fullPortrait,
      icon: a.displayIcon || a.displayIconSmall || a.fullPortrait,
    }))
    .sort((x, y) => x.name.localeCompare(y.name));
  catalog.maps = (mJson.data || [])
    .filter(
      (m) =>
        m.uuid &&
        m.displayName &&
        m.splash &&
        ALLOWED_MAP_NAMES.has(String(m.displayName).trim().toLowerCase())
    )
    .map((m) => ({
      uuid: m.uuid,
      name: m.displayName,
      image: m.splash,
    }))
    .sort(function (a, b) {
      const ia = MAP_POOL_ORDER.findIndex(
        (n) => n.toLowerCase() === String(a.name).trim().toLowerCase()
      );
      const ib = MAP_POOL_ORDER.findIndex(
        (n) => n.toLowerCase() === String(b.name).trim().toLowerCase()
      );
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
  console.log(`Catalog: ${catalog.maps.length} maps, ${catalog.agents.length} agents`);
}

function nick(session, socketId) {
  return session.nicks.get(socketId) || "Player";
}

function teamOf(session, socketId) {
  if (session.captainA === socketId) return "A";
  if (session.captainB === socketId) return "B";
  return session.teamMembers.get(socketId) || null;
}

function buildRosters(session) {
  const rosters = { A: [], B: [], spectators: [] };
  for (const [sid, name] of session.nicks.entries()) {
    const t = teamOf(session, sid);
    const isCap = session.captainA === sid || session.captainB === sid;
    const entry = { id: sid, nickname: name, isCaptain: isCap };
    if (t === "A") rosters.A.push(entry);
    else if (t === "B") rosters.B.push(entry);
    else rosters.spectators.push(entry);
  }
  const sortFn = (a, b) => (b.isCaptain - a.isCaptain) || a.nickname.localeCompare(b.nickname);
  rosters.A.sort(sortFn);
  rosters.B.sort(sortFn);
  rosters.spectators.sort((a, b) => a.nickname.localeCompare(b.nickname));
  return rosters;
}

function sessionView(session, forSocketId) {
  const captainA = session.captainA;
  const captainB = session.captainB;
  return {
    code: session.code,
    phase: session.phase,
    mapBans: session.mapBans,
    agentBans: session.agentBans,
    currentTurn: session.currentTurn,
    firstBanner: session.firstBanner || null,
    selectedMap: session.selectedMap,
    selectedSide: session.selectedSide || null,
    sidePickerTeam: session.sidePickerTeam || null,
    hostId: session.hostId,
    teamNames: session.teamNames || { A: "Team A", B: "Team B" },
    captainNames: {
      A: captainA ? nick(session, captainA) : null,
      B: captainB ? nick(session, captainB) : null,
    },
    teamRosters: buildRosters(session),
    me: {
      id: forSocketId,
      isHost: session.hostId === forSocketId,
      myTeam: teamOf(session, forSocketId),
      isCaptain: session.captainA === forSocketId || session.captainB === forSocketId,
    },
    // Turn-timer fields. turnEndsAt is the absolute server epoch ms when the
    // current captain's window expires; clients use it together with serverNow
    // to render a clock-skew-tolerant countdown.
    turnEndsAt: session.turnEndsAt || null,
    serverNow: Date.now(),
    turnTimeoutMs: TURN_TIMEOUT_MS,
    chat: Array.isArray(session.chat) ? session.chat.slice(-CHAT_HISTORY) : [],
    catalog,
  };
}

function broadcastSession(io, session) {
  // Any state push counts as activity — keeps stale-session GC honest.
  session.lastActivity = Date.now();
  io.in(session.code)
    .fetchSockets()
    .then((socks) => {
      for (const s of socks) {
        s.emit("state", sessionView(session, s.id));
      }
    })
    .catch(() => {});
}

function createSession(hostId, roomCode) {
  const now = Date.now();
  const session = {
    code: roomCode,
    hostId,
    createdAt: now,
    lastActivity: now,
    phase: "lobby",
    captainA: null,
    captainB: null,
    nicks: new Map(),
    teamMembers: new Map(),
    teamNames: { A: "Team A", B: "Team B" },
    chat: [],                  // [{ id, ts, fromId, fromName, team, text }]
    mapBans: [],
    agentBans: [],
    currentTurn: "A",
    firstBanner: null,        // who won the coin flip and bans first
    selectedMap: null,
    selectedSide: null,       // "attack" | "defense" (chosen on decider)
    sidePickerTeam: null,     // which team picks side (set when entering side_pick)
    turnEndsAt: null,
    _turnTimer: null,
    // ─── Resume-on-refresh ──────────────────────────────
    // Each connected player gets a stable 16-byte token. We keep their seat
    // (captain/host/team/nickname) tied to the token, not to the volatile
    // socket.id. When the same token reconnects we transparently re-key all
    // socket.id-based references to the new socket id (aliasSocket()).
    tokens: new Map(),        // token -> { socketId, disconnectedAt, graceTimer }
    socketToken: new Map(),   // socketId -> token
  };
  return session;
}

// ─── Token + alias helpers ───────────────────────────────
function newToken() {
  return crypto.randomBytes(16).toString("base64url");
}

function isValidToken(tok) {
  return typeof tok === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(tok);
}

function bindToken(session, socketId, token) {
  session.tokens.set(token, { socketId, disconnectedAt: null, graceTimer: null });
  session.socketToken.set(socketId, token);
}

// Rewrite every session field that keys off socket.id from oldSid → newSid.
// Used when a known token reconnects on a fresh socket (refresh / Wi-Fi drop).
function aliasSocket(session, oldSid, newSid) {
  if (oldSid === newSid) return;
  if (session.hostId === oldSid) session.hostId = newSid;
  if (session.captainA === oldSid) session.captainA = newSid;
  if (session.captainB === oldSid) session.captainB = newSid;
  if (session.nicks.has(oldSid)) {
    session.nicks.set(newSid, session.nicks.get(oldSid));
    session.nicks.delete(oldSid);
  }
  if (session.teamMembers.has(oldSid)) {
    session.teamMembers.set(newSid, session.teamMembers.get(oldSid));
    session.teamMembers.delete(oldSid);
  }
  session.socketToken.delete(oldSid);
}

// Run the "real" cleanup for a player slot (called from disconnect grace timer
// or from an explicit leaveSession event). Mirrors the original disconnect
// logic: drop the player, transfer host if they were host, delete the empty
// session if nobody remains.
function evictBySocketId(io, sessions, code, sidToEvict) {
  const session = sessions.get(code);
  if (!session) return;
  const wasHost = session.hostId === sidToEvict;
  session.nicks.delete(sidToEvict);
  session.teamMembers.delete(sidToEvict);
  if (session.captainA === sidToEvict) session.captainA = null;
  if (session.captainB === sidToEvict) session.captainB = null;
  const token = session.socketToken.get(sidToEvict);
  if (token) {
    const entry = session.tokens.get(token);
    if (entry && entry.graceTimer) clearTimeout(entry.graceTimer);
    session.tokens.delete(token);
  }
  session.socketToken.delete(sidToEvict);

  if (wasHost) {
    io.in(code).fetchSockets().then((socks) => {
      const s = sessions.get(code);
      if (!s) return;
      const others = socks.filter((sk) => sk.id !== sidToEvict);
      if (others.length > 0) {
        s.hostId = others[0].id;
        broadcastSession(io, s);
      } else {
        clearTurnTimer(s);
        sessions.delete(code);
      }
    }).catch(() => {
      const s = sessions.get(code);
      if (s) clearTurnTimer(s);
      sessions.delete(code);
    });
    return;
  }
  broadcastSession(io, session);
}

function remainingMaps(session) {
  return catalog.maps.filter((m) => !session.mapBans.includes(m.uuid));
}

function remainingAgents(session) {
  return catalog.agents.filter((a) => !session.agentBans.includes(a.uuid));
}

function sessionsStore() {
  if (!global.__draftSessions) global.__draftSessions = new Map();
  return global.__draftSessions;
}

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw || !String(raw).trim()) return null;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  await loadUsedCodes();
  await loadCatalog();

  // ─── Catalog auto-refresh ───
  // Re-fetch the Valorant API every 12h so newly-released agents/maps appear
  // without a server restart. Errors are logged but never crash the loop.
  const CATALOG_REFRESH_MS = Number(process.env.CATALOG_REFRESH_MS) || 12 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const before = `${catalog.maps.length}m/${catalog.agents.length}a`;
      await loadCatalog();
      const after = `${catalog.maps.length}m/${catalog.agents.length}a`;
      if (before !== after) console.log(`Catalog refreshed: ${before} → ${after}`);
    } catch (e) {
      console.warn("Catalog refresh failed (will retry next interval):", e.message);
    }
  }, CATALOG_REFRESH_MS).unref();

  const allowedList = parseAllowedOrigins();
  const corsOrigin =
    allowedList && allowedList.length
      ? function (origin, cb) {
          if (!origin) return cb(null, true);
          return cb(null, allowedList.includes(origin));
        }
      : true;

  const app = express();
  app.disable("x-powered-by"); // don't leak framework/version

  const traffic = {
    since: Date.now(),
    landingViews: 0,
    appShellViews: 0,
    feedbackTotal: 0,
    peakSockets: 0,
  };

  app.use(express.json({ limit: "24kb" }));

  // ─── Trust proxy ────────────────────────────────────
  // Behind nginx/Caddy/Cloudflare we MUST trust the X-Forwarded-* headers so
  // express-rate-limit and the socket IP map see the real client IP. Set
  // TRUST_PROXY to "1" (single hop), "true" (any), or a CIDR/IP string for
  // tighter control.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    if (trustProxy === "true") app.set("trust proxy", true);
    else if (/^\d+$/.test(trustProxy)) app.set("trust proxy", Number(trustProxy));
    else app.set("trust proxy", trustProxy);
  }

  // ─── Security headers via Helmet ────────────────────
  // Tight CSP: only allow assets we actually use. valorant-api.com hosts the
  // catalog images; Google Fonts is loaded from googleapis.com/gstatic.com;
  // socket.io's client is fetched from cdn.socket.io. WebSocket upgrades to
  // the same origin are needed by socket.io; ko-fi link is permitted in
  // navigations but not framed.
  const isProd = process.env.NODE_ENV === "production";
  const cspDirectives = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'", "https://cdn.socket.io"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
    imgSrc: [
      "'self'", "data:", "blob:",
      "https://media.valorant-api.com",
      "https://valorant-api.com",
    ],
    // Socket.io will negotiate either ws:// or wss:// to the same origin. In
    // dev we also allow ws to any port (Live Server scenario).
    connectSrc: isProd
      ? ["'self'", "wss:", "https://valorant-api.com"]
      : ["'self'", "ws:", "wss:", "http:", "https:"],
    formAction: ["'self'"],
    upgradeInsecureRequests: isProd ? [] : null,
  };
  if (!isProd) delete cspDirectives.upgradeInsecureRequests;
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: cspDirectives },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" }, // /img proxy works
      referrerPolicy: { policy: "no-referrer" },
      hsts: isProd ? { maxAge: 15552000, includeSubDomains: true, preload: false } : false,
      frameguard: { action: "deny" },
    })
  );

  app.use(
    cors({
      origin: corsOrigin,
      exposedHeaders: ["X-Valorant-Draft"],
    })
  );

  // Custom marker used by the client's port-discovery probe to identify
  // a DRAFTIX server vs. some other random Node app on the same port.
  app.use((_req, res, next) => {
    res.setHeader("X-Valorant-Draft", "1");
    next();
  });

  app.use((req, res, next) => {
    if (req.method === "GET") {
      const p = req.path || "";
      if (p === "/" || p === "/index.html") traffic.landingViews++;
      else if (p === "/app") traffic.appShellViews++;
    }
    next();
  });

  // ─── HTTP rate limit (lenient — protects static + healthz) ───
  const httpLimiter = rateLimit({
    windowMs: 60_000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests — slow down.",
  });
  app.use(httpLimiter);

  // ─── Health check (for monitors / load balancers) ───────
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      version: APP_VERSION,
      uptimeSec: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
      sessions: sessions.size,
      codesIssued: usedCodes.size,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      catalog: { maps: catalog.maps.length, agents: catalog.agents.length },
    });
  });

  const feedbackLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many submissions — try again later.",
  });

  const FEEDBACK_KINDS = new Set(["feedback", "bug", "other"]);
  const FEEDBACK_MSG_MAX = 4000;

  function isAllowedDiscordWebhookHost(hostname) {
    const h = String(hostname || "").toLowerCase();
    return (
      h === "discord.com" ||
      h === "discordapp.com" ||
      h.endsWith(".discord.com") ||
      h.endsWith(".discordapp.com")
    );
  }

  function postDiscordWebhook(webhookUrl, payload) {
    return new Promise((resolve) => {
      try {
        const u = new URL(webhookUrl);
        if (u.protocol !== "https:" || !isAllowedDiscordWebhookHost(u.hostname)) {
          console.warn("Feedback: webhook URL host not allowed:", u.hostname);
          return resolve(false);
        }
        const body = JSON.stringify(payload);
        const reqOut = https.request(
          {
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              "User-Agent": "DRAFTIX-Feedback/1.1",
            },
            timeout: 12000,
          },
          (up) => {
            const chunks = [];
            up.on("data", (c) => chunks.push(c));
            up.on("end", () => {
              const code = up.statusCode || 0;
              const ok = code >= 200 && code < 300;
              if (!ok) {
                const snippet = Buffer.concat(chunks).toString("utf8").slice(0, 800);
                console.warn("Feedback: Discord webhook HTTP", code, snippet || "(empty body)");
              }
              resolve(ok);
            });
          }
        );
        reqOut.on("error", (e) => {
          console.warn("Feedback: Discord webhook request error:", e.message);
          resolve(false);
        });
        reqOut.on("timeout", () => {
          reqOut.destroy();
          console.warn("Feedback: Discord webhook request timeout");
          resolve(false);
        });
        reqOut.write(body);
        reqOut.end();
      } catch (e) {
        console.warn("Feedback: Discord webhook URL error:", e.message);
        resolve(false);
      }
    });
  }

  app.post("/api/feedback", feedbackLimiter, async (req, res) => {
    if (req.body && String(req.body.website || "").trim()) {
      return res.status(400).json({ ok: false, error: "Invalid request" });
    }
    const kindRaw = clean(req.body && req.body.kind, 16).toLowerCase() || "feedback";
    const kind = FEEDBACK_KINDS.has(kindRaw) ? kindRaw : "feedback";
    const message = clean(req.body && req.body.message, FEEDBACK_MSG_MAX);
    if (!message || message.length < 4) {
      return res.status(400).json({ ok: false, error: "Please write a bit more detail (4+ characters)." });
    }
    const contact = clean(req.body && req.body.contact, 120);
    const page = clean(req.body && req.body.page, 240);
    const row = {
      ts: Date.now(),
      kind,
      message,
      contact: contact || undefined,
      page: page || undefined,
      ip: req.ip || "",
    };
    traffic.feedbackTotal++;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      await fsp.appendFile(FEEDBACK_LOG_PATH, JSON.stringify(row) + "\n");
    } catch (e) {
      console.warn("Feedback log write failed:", e.message);
      return res.status(500).json({ ok: false, error: "Could not save feedback — try again later." });
    }

    const hookRaw = process.env.FEEDBACK_DISCORD_WEBHOOK_URL;
    const hook = String(hookRaw || "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (hook && /^https:\/\//.test(hook)) {
      const head = `[${kind}] ${page ? `(${page}) ` : ""}${contact ? contact + " — " : ""}`;
      let chunk = message.slice(0, 1900);
      if (message.length > 1900) chunk += "…";
      const content = (head + chunk).slice(0, 1990);
      // Omit `username` — Discord sometimes rejects custom names; default webhook label is enough.
      postDiscordWebhook(hook, { content }).then((ok) => {
        if (!ok) console.warn("Feedback: Discord webhook delivery failed — check Render logs for HTTP body.");
      });
    } else if (hookRaw && String(hookRaw).trim()) {
      console.warn("Feedback: FEEDBACK_DISCORD_WEBHOOK_URL is set but not a valid https URL.");
    }

    res.json({ ok: true });
  });

  // ─── Image proxy for canvas exports ─────────────────
  // Browsers taint <canvas> if you draw cross-origin images without explicit
  // CORS. Riot's CDN is reliable but not guaranteed to send CORS headers, so
  // we proxy whitelisted URLs through us — adding the headers we control.
  //
  // Hardening:
  //   • Strict allowlist regex (only media.valorant-api.com / valorant-api.com)
  //   • Dedicated rate limit (looser than per-event but tighter than the
  //     global HTTP limit; prevents bandwidth abuse as a free proxy).
  //   • 5MB per-response size cap so a malicious upstream can't drain us.
  //   • Reject non-image Content-Type so we can't be coerced into proxying
  //     arbitrary text/JSON.
  const IMG_RATE = rateLimit({
    windowMs: 60_000,
    max: 240,                     // 240 image hits per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: "Image proxy rate limit hit — slow down.",
  });
  const IMG_MAX_BYTES = 5 * 1024 * 1024;

  app.get("/img", IMG_RATE, (req, res) => {
    const url = String((req.query && req.query.url) || "");
    if (!/^https:\/\/(media\.)?valorant-api\.com\//.test(url)) {
      return res.status(400).end("Bad URL");
    }
    const upstream = https.get(
      url,
      { headers: { "User-Agent": "DraftixImageProxy/1.0" }, timeout: 8000 },
      (up) => {
        if (up.statusCode && up.statusCode >= 400) {
          res.status(up.statusCode).end();
          up.resume();
          return;
        }
        const ct = String(up.headers["content-type"] || "");
        if (!/^image\//i.test(ct)) {
          res.status(415).end("Not an image");
          up.resume();
          return;
        }
        const declared = Number(up.headers["content-length"] || 0);
        if (declared && declared > IMG_MAX_BYTES) {
          res.status(413).end("Image too large");
          up.resume();
          return;
        }
        let received = 0;
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.setHeader("Access-Control-Allow-Origin", "*");
        up.on("data", (chunk) => {
          received += chunk.length;
          if (received > IMG_MAX_BYTES) {
            up.destroy();
            try { res.end(); } catch (_) {}
          }
        });
        up.pipe(res);
      }
    );
    upstream.on("error", () => { try { res.status(502).end(); } catch (_) {} });
    upstream.on("timeout", () => { upstream.destroy(); try { res.status(504).end(); } catch (_) {} });
  });

  const appHtmlPath = path.join(__dirname, "public", "app.html");

  // ─── Draft app at clean URL /app (file on disk is still app.html) ───
  function appendQuery(req) {
    const i = req.url.indexOf("?");
    return i >= 0 ? req.url.slice(i) : "";
  }
  app.get("/app", (_req, res) => {
    res.type("html");
    res.sendFile(appHtmlPath);
  });
  app.get("/app/", (req, res) => {
    res.redirect(301, "/app" + appendQuery(req));
  });
  // Old bookmarks / shared links → canonical /app
  app.get("/app.html", (req, res) => {
    res.redirect(301, "/app" + appendQuery(req));
  });

  // ─── Legacy redirect: /?code=XXX → /app?code=XXX ───
  app.get("/", (req, res, next) => {
    if (req.query && req.query.code) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") params.set(k, v);
      }
      return res.redirect(302, "/app?" + params.toString());
    }
    next();
  });

  // Serve static assets. HTML/JS/CSS must always revalidate so a redeploy is
  // picked up immediately — otherwise a stale cached app.js can run alongside
  // a new server and break features like the resume-on-refresh flow.
  app.use(express.static(path.join(__dirname, "public"), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.(html|js|css|json|webmanifest)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      } else if (/\.(png|jpg|jpeg|gif|webp|svg|ico|mp3|wav|woff2?)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
  }));

  app.use((err, req, res, next) => {
    const isParse =
      err instanceof SyntaxError &&
      err.status === 400 &&
      "body" in err;
    const isEntityParse = err && err.type === "entity.parse.failed";
    if (isParse || isEntityParse) {
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }
    next(err);
  });

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: corsOrigin } });

  const sessions = sessionsStore();

  function adminAccess(req) {
    const secret = process.env.ADMIN_STATS_TOKEN;
    if (!secret || String(secret).length < 24) return "off";
    const q = String(req.query.token || "");
    const auth = String(req.headers.authorization || "");
    const bearer =
      auth.length > 7 && auth.slice(0, 7).toLowerCase() === "bearer " ? auth.slice(7).trim() : "";
    if (q === secret || bearer === secret) return "ok";
    return "deny";
  }

  app.get("/api/admin/stats", (req, res) => {
    const a = adminAccess(req);
    if (a === "off") return res.status(404).end("Not found");
    if (a === "deny") return res.status(401).json({ error: "Unauthorized" });
    let sockets = 0;
    try {
      sockets = io.engine.clientsCount;
    } catch (_) {}
    res.json({
      ok: true,
      at: Date.now(),
      uptimeSec: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
      version: APP_VERSION,
      draftSessions: sessions.size,
      catalog: { maps: catalog.maps.length, agents: catalog.agents.length },
      socketsConnected: sockets,
      traffic: {
        since: traffic.since,
        landingViews: traffic.landingViews,
        appShellViews: traffic.appShellViews,
        feedbackTotal: traffic.feedbackTotal,
        peakSockets: traffic.peakSockets,
      },
    });
  });

  app.get("/internal/metrics", (req, res) => {
    const secret = process.env.ADMIN_STATS_TOKEN;
    if (!secret || String(secret).length < 24) return res.status(404).end("Not found");
    if (String(req.query.token || "") !== secret) {
      return res
        .status(401)
        .type("html")
        .send(
          "<!DOCTYPE html><meta charset=utf-8><title>Metrics</title><p>Missing or invalid <code>token</code>.</p>"
        );
    }
    res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>DRAFTIX — Admin metrics</title>
<link rel="stylesheet" href="/admin-dashboard.css"/>
</head>
<body class="admin-dash-page">
<header class="admin-header">
  <h1>DRAFT<span>IX</span> admin</h1>
  <p>Private metrics for this server instance only. Keep this URL secret (it contains your access token). Charts for long-term trends belong in <a href="https://render.com/docs/web-service-metrics" rel="noopener noreferrer">Render</a> or <a href="https://plausible.io" rel="noopener noreferrer">Plausible</a>.</p>
</header>
<main class="admin-main" id="dash-root">
  <div id="dash-banner" class="dash-banner" hidden></div>
  <div id="dash-meta" class="dash-meta"></div>
  <p class="dash-loading" id="dash-loading">Loading metrics…</p>
  <div id="dash-grid" class="dash-grid" hidden></div>
  <footer class="dash-foot">DRAFTIX internal · not linked from the public site · <code>/internal/metrics</code></footer>
</main>
<script src="/admin-metrics.js" defer></script>
</body></html>`);
  });

  // ─── Per-IP socket-event rate limiter ───
  const ipEventLog = new Map(); // ip -> { event -> number[] }
  function ipFromSocket(s) {
    return (
      (s.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      s.handshake.address ||
      "unknown"
    );
  }
  function allowSocketEvent(socket, event) {
    const limit = SOCKET_LIMITS[event];
    if (!limit) return true;
    const [max, win] = limit;
    const ip = ipFromSocket(socket);
    const now = Date.now();
    let bucket = ipEventLog.get(ip);
    if (!bucket) { bucket = {}; ipEventLog.set(ip, bucket); }
    const arr = (bucket[event] = (bucket[event] || []).filter((t) => now - t < win));
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  }
  // GC the rate-limit map occasionally
  setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of ipEventLog) {
      let alive = false;
      for (const k of Object.keys(bucket)) {
        bucket[k] = bucket[k].filter((t) => now - t < 120_000);
        if (bucket[k].length) alive = true;
      }
      if (!alive) ipEventLog.delete(ip);
    }
  }, 60_000).unref();

  function withLimit(socket, event, cb, handler) {
    if (!allowSocketEvent(socket, event)) {
      if (typeof cb === "function") cb({ ok: false, error: "Rate limit — slow down." });
      return;
    }
    handler();
  }

  io.on("connection", (socket) => {
    let joinedCode = null;
    try {
      const n = io.engine.clientsCount;
      if (n > traffic.peakSockets) traffic.peakSockets = n;
    } catch (_) {}

    socket.on("createSession", (payload, cb) => withLimit(socket, "createSession", cb, () => {
      if (sessions.size >= MAX_SESSIONS) {
        if (typeof cb === "function") cb({ ok: false, error: "Server full — too many active sessions." });
        return;
      }
      const nickname = clean(payload && payload.nickname, MAX_NICK_LEN) || "Host";
      let code;
      try {
        code = generateUniqueCode(sessions);
      } catch (e) {
        if (typeof cb === "function") cb({ ok: false, error: "Couldn't allocate a unique code, try again." });
        return;
      }
      const session = createSession(socket.id, code);
      session.nicks.set(socket.id, nickname);
      const token = newToken();
      bindToken(session, socket.id, token);
      sessions.set(code, session);
      socket.join(code);
      joinedCode = code;
      socket.emit("state", sessionView(session, socket.id));
      if (typeof cb === "function") cb({ ok: true, code, token });
    }));

    socket.on("joinSession", (payload, cb) => withLimit(socket, "joinSession", cb, async () => {
      const code = clean(payload && payload.code, 8).toUpperCase().replace(/\s/g, "");
      const nickname = clean(payload && payload.nickname, MAX_NICK_LEN) || "Player";
      const requestedToken = payload && isValidToken(payload.token) ? payload.token : null;
      if (code.length < 4) {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid code" });
        return;
      }
      const session = sessions.get(code);
      if (!session) {
        if (typeof cb === "function") cb({ ok: false, error: "Session not found" });
        return;
      }

      // ─── Resume path: known token for this session → re-alias seat ───
      const resumeEntry = requestedToken ? session.tokens.get(requestedToken) : null;
      if (resumeEntry) {
        const oldSid = resumeEntry.socketId;
        if (resumeEntry.graceTimer) {
          clearTimeout(resumeEntry.graceTimer);
          resumeEntry.graceTimer = null;
        }
        resumeEntry.disconnectedAt = null;
        const wasHost = session.hostId === oldSid;
        const wasCapA = session.captainA === oldSid;
        const wasCapB = session.captainB === oldSid;
        if (oldSid && oldSid !== socket.id) aliasSocket(session, oldSid, socket.id);
        resumeEntry.socketId = socket.id;
        session.socketToken.set(socket.id, requestedToken);
        if (nickname) session.nicks.set(socket.id, nickname);
        if (joinedCode && joinedCode !== code) socket.leave(joinedCode);
        socket.join(code);
        joinedCode = code;
        session.lastActivity = Date.now();
        socket.emit("state", sessionView(session, socket.id));
        broadcastSession(io, session);
        const roles = [
          wasHost ? "host" : null,
          wasCapA ? "captainA" : null,
          wasCapB ? "captainB" : null,
        ].filter(Boolean).join("+") || "spectator";
        console.log(`[resume] ${code} ${nickname || "?"} restored (${roles}) tok=${requestedToken.slice(0,8)}…`);
        if (typeof cb === "function") cb({ ok: true, code, token: requestedToken, resumed: true });
        return;
      }

      // Diagnostic: a token was provided but didn't match — likely from a
      // dropped-then-rebuilt session, or a stale localStorage entry.
      if (requestedToken) {
        console.log(`[resume-miss] ${code} ${nickname || "?"} sent token ${requestedToken.slice(0,8)}… (not in session.tokens — fresh join)`);
      }

      // ─── Cap clients per session (only counts fresh joins) ───────────
      try {
        const socks = await io.in(code).fetchSockets();
        const alreadyIn = socks.some((s) => s.id === socket.id);
        if (!alreadyIn && socks.length >= MAX_CLIENTS_PER_SESSION) {
          if (typeof cb === "function") cb({ ok: false, error: "Session full." });
          return;
        }
      } catch (_) { /* non-fatal */ }

      if (joinedCode && joinedCode !== code) socket.leave(joinedCode);
      socket.join(code);
      joinedCode = code;
      session.nicks.set(socket.id, nickname);
      const token = newToken();
      bindToken(session, socket.id, token);
      socket.emit("state", sessionView(session, socket.id));
      broadcastSession(io, session);
      if (typeof cb === "function") cb({ ok: true, code, token });
    }));

    socket.on("claimCaptain", (payload, cb) => withLimit(socket, "claimCaptain", cb, () => {
      const code = payload && String(payload.code).toUpperCase();
      const team = payload && payload.team;
      const session = sessions.get(code);
      if (!session || session.phase !== "lobby") {
        if (typeof cb === "function") cb({ ok: false, error: "Invalid" });
        return;
      }
      if (team !== "A" && team !== "B") {
        if (typeof cb === "function") cb({ ok: false, error: "Pick team A or B" });
        return;
      }
      if (team === "A") {
        if (session.captainA && session.captainA !== socket.id) {
          if (typeof cb === "function") cb({ ok: false, error: "Team A captain taken" });
          return;
        }
        if (session.captainB === socket.id) session.captainB = null;
        session.captainA = socket.id;
      } else {
        if (session.captainB && session.captainB !== socket.id) {
          if (typeof cb === "function") cb({ ok: false, error: "Team B captain taken" });
          return;
        }
        if (session.captainA === socket.id) session.captainA = null;
        session.captainB = socket.id;
      }
      session.teamMembers.set(socket.id, team);
      broadcastSession(io, session);
      if (typeof cb === "function") cb({ ok: true });
    }));

    socket.on("setTeam", (payload, cb) => withLimit(socket, "setTeam", cb, () => {
      const code = payload && String(payload.code).toUpperCase();
      const team = payload && payload.team;
      const session = sessions.get(code);
      if (!session || session.phase !== "lobby") {
        if (typeof cb === "function") cb({ ok: false, error: "Cannot change team now" });
        return;
      }
      if (session.captainA === socket.id || session.captainB === socket.id) {
        if (typeof cb === "function") cb({ ok: false, error: "Captains stay on their team" });
        return;
      }
      if (team === null || team === "spectator") {
        session.teamMembers.delete(socket.id);
      } else if (team === "A" || team === "B") {
        session.teamMembers.set(socket.id, team);
      } else {
        if (typeof cb === "function") cb({ ok: false, error: "Bad team" });
        return;
      }
      broadcastSession(io, session);
      if (typeof cb === "function") cb({ ok: true });
    }));

    socket.on("startDraft", (payload, cb) => withLimit(socket, "startDraft", cb, () => {
      const code = payload && String(payload.code).toUpperCase();
      const session = sessions.get(code);
      if (!session || session.hostId !== socket.id) {
        if (typeof cb === "function") cb({ ok: false, error: "Only host can start" });
        return;
      }
      if (!session.captainA || !session.captainB) {
        if (typeof cb === "function") cb({ ok: false, error: "Need both captains" });
        return;
      }
      const left = remainingMaps(session);
      if (left.length < 2) {
        if (typeof cb === "function") cb({ ok: false, error: "Not enough maps in catalog" });
        return;
      }
      session.phase = "map_ban";
      session.mapBans = [];
      session.agentBans = [];
      session.selectedMap = null;
      session.selectedSide = null;
      session.sidePickerTeam = null;
      // Coin flip: random team bans first.
      const firstBanner = Math.random() < 0.5 ? "A" : "B";
      session.currentTurn = firstBanner;
      session.firstBanner = firstBanner;
      armTurnTimer(session, io);
      broadcastSession(io, session);
      if (typeof cb === "function") cb({ ok: true });
    }));

    socket.on("banMap", (payload, cb) => withLimit(socket, "banMap", cb, () => {
      const code = payload && String(payload.code).toUpperCase();
      const mapUuid = payload && payload.uuid;
      const session = sessions.get(code);
      if (!session || session.phase !== "map_ban") {
        if (typeof cb === "function") cb({ ok: false, error: "Wrong phase" });
        return;
      }
      const turn = session.currentTurn;
      const expected = turn === "A" ? session.captainA : session.captainB;
      if (expected !== socket.id) {
        if (typeof cb === "function") cb({ ok: false, error: "Not your turn" });
        return;
      }
      if (!catalog.maps.some((m) => m.uuid === mapUuid) || session.mapBans.includes(mapUuid)) {
        if (typeof cb === "function") cb({ ok: false, error: "Bad map" });
        return;
      }
      const leftBefore = remainingMaps(session);
      if (leftBefore.length <= 1) {
        if (typeof cb === "function") cb({ ok: false, error: "Map already decided" });
        return;
      }
      session.mapBans.push(mapUuid);
      const left = remainingMaps(session);
      if (left.length === 1) {
        session.selectedMap = left[0];
        // Competitive procedure: team that did NOT make the final map ban picks side.
        session.sidePickerTeam = turn === "A" ? "B" : "A";
        session.phase = "side_pick";
        session.agentBans = [];
        clearTurnTimer(session);  // side pick has its own (lighter) flow, no turn timer
      } else {
        session.currentTurn = turn === "A" ? "B" : "A";
        armTurnTimer(session, io);
      }
      broadcastSession(io, session);
      if (typeof cb === "function") cb({ ok: true });
    }));

    socket.on("pickSide", (payload, cb) => withLimit(socket, "pickSide", cb, () => {
      const code = payload && String(payload.code).toUpperCase();
      const side = payload && payload.side;
      const session = sessions.get(code);
      if (!session || session.phase !== "side_pick") {
        if (typeof cb === "function") cb({ ok: false, error: "Wrong phase" });
        return;
      }
      if (side !== "attack" && side !== "defense") {
        if (typeof cb === "function") cb({ ok: false, error: "Pick attack or defense" });
        return;
      }
      const picker = session.sidePickerTeam;
      const expected = picker === "A" ? session.captainA : session.captainB;
      if (expected !== socket.id) {
        if (typeof cb === "function") cb({ ok: false, error: "Not your pick" });
        return;
      }
      session.selectedSide = side;
      session.phase = "agent_ban";
      // Convention: the side-picker (loser of map veto) bans agents first.
      session.currentTurn = picker;
      armTurnTimer(session, io);
      broadcastSession(io, session);
      if (typeof cb === "function") cb({ ok: true });
    }));

    socket.on("chatMessage", (payload, cb) => withLimit(socket, "chatMessage", cb, () => {
      const code = payload && String(payload.code).toUpperCase();
      const session = sessions.get(code);
      if (!session) {
        if (typeof cb === "function") cb({ ok: false, error: "Bad session" });
        return;
      }
      // Sender must already be in the room (defends against spoofed code).
      const room = io.sockets.adapter.rooms.get(code);
      if (!room || !room.has(socket.id)) {
        if (typeof cb === "function") cb({ ok: false, error: "Not in session" });
        return;
      }
      const raw = clean(payload && payload.text, CHAT_MAX_LEN);
      if (!raw) {
        if (typeof cb === "function") cb({ ok: false, error: "Empty message" });
        return;
      }
      const fromName = nick(session, socket.id) || "Player";
      const team = teamOf(session, socket.id);
      const isCap = session.captainA === socket.id || session.captainB === socket.id;
      const isHost = session.hostId === socket.id;
      const msg = {
        id: ++chatMsgSeq,
        ts: Date.now(),
        fromId: socket.id,
        fromName,
        team,        // "A" | "B" | null
        isCap,
        isHost,
        text: raw,
      };
      if (!Array.isArray(session.chat)) session.chat = [];
      session.chat.push(msg);
      if (session.chat.length > CHAT_HISTORY) {
        session.chat.splice(0, session.chat.length - CHAT_HISTORY);
      }
      session.lastActivity = Date.now();
      // Broadcast a lightweight chat-only event so clients can update without
      // rebuilding the whole state. Late joiners still get full history via
      // sessionView.chat.
      io.to(code).emit("chat", msg);
      if (typeof cb === "function") cb({ ok: true });
    }));

    socket.on("setTeamNames", (payload, cb) => withLimit(socket, "setTeamNames", cb, () => {
      const code = payload && String(payload.code).toUpperCase();
      const session = sessions.get(code);
      if (!session || session.hostId !== socket.id) {
        if (typeof cb === "function") cb({ ok: false, error: "Host only" });
        return;
      }
      if (session.phase !== "lobby") {
        if (typeof cb === "function") cb({ ok: false, error: "Names lock at draft start" });
        return;
      }
      const a = clean(payload && payload.A, MAX_NICK_LEN) || "Team A";
      const b = clean(payload && payload.B, MAX_NICK_LEN) || "Team B";
      session.teamNames = { A: a, B: b };
      broadcastSession(io, session);
      if (typeof cb === "function") cb({ ok: true });
    }));

    socket.on("banAgent", (payload, cb) => withLimit(socket, "banAgent", cb, () => {
      const code = payload && String(payload.code).toUpperCase();
      const agentUuid = payload && payload.uuid;
      const session = sessions.get(code);
      if (!session || session.phase !== "agent_ban") {
        if (typeof cb === "function") cb({ ok: false, error: "Wrong phase" });
        return;
      }
      const turn = session.currentTurn;
      const expected = turn === "A" ? session.captainA : session.captainB;
      if (expected !== socket.id) {
        if (typeof cb === "function") cb({ ok: false, error: "Not your turn" });
        return;
      }
      if (!catalog.agents.some((a) => a.uuid === agentUuid) || session.agentBans.includes(agentUuid)) {
        if (typeof cb === "function") cb({ ok: false, error: "Bad agent" });
        return;
      }
      if (session.agentBans.length >= AGENT_BAN_COUNT) {
        if (typeof cb === "function") cb({ ok: false, error: "Ban phase over" });
        return;
      }
      session.agentBans.push(agentUuid);
      if (session.agentBans.length >= AGENT_BAN_COUNT) {
        session.phase = "done";
        clearTurnTimer(session);
      } else {
        session.currentTurn = turn === "A" ? "B" : "A";
        armTurnTimer(session, io);
      }
      broadcastSession(io, session);
      if (typeof cb === "function") cb({ ok: true });
    }));

    // Explicit "I'm leaving for good" — bypasses the reconnect grace so the
    // seat opens up immediately for someone else. Client sends this from the
    // Leave button before closing the socket.
    socket.on("leaveSession", (payload, cb) => withLimit(socket, "leaveSession", cb, () => {
      const code = clean(payload && payload.code, 8).toUpperCase().replace(/\s/g, "") || joinedCode;
      if (!code) { if (typeof cb === "function") cb({ ok: true }); return; }
      evictBySocketId(io, sessions, code, socket.id);
      if (joinedCode === code) joinedCode = null;
      if (typeof cb === "function") cb({ ok: true });
    }));

    socket.on("disconnect", () => {
      if (!joinedCode) return;
      const code = joinedCode;
      const session = sessions.get(code);
      if (!session) return;

      const token = session.socketToken.get(socket.id);
      // No token (legacy / edge case) → fall back to immediate eviction.
      if (!token) { evictBySocketId(io, sessions, code, socket.id); return; }

      const entry = session.tokens.get(token);
      if (!entry) { evictBySocketId(io, sessions, code, socket.id); return; }

      // Mark disconnected and schedule grace eviction. The player keeps their
      // captain/host/team slot for RECONNECT_GRACE_MS so a refresh, Wi-Fi blip
      // or quick tab close doesn't drop them. If they reconnect with the same
      // token before the timer fires, joinSession cancels it and aliases the
      // socket id back into place.
      entry.disconnectedAt = Date.now();
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      entry.graceTimer = setTimeout(() => {
        const s = sessions.get(code);
        if (!s) return;
        const e = s.tokens.get(token);
        // Already reconnected — bail.
        if (!e || e.disconnectedAt === null) return;
        evictBySocketId(io, s, code, e.socketId);
      }, RECONNECT_GRACE_MS);
      // Keep room state intact for other clients (don't broadcast removal).
    });
  });

  const preferred = Number(process.env.PORT) || 3000;
  const maxPort = explicitPortEnv ? preferred : preferred + 30;

  function tryListen(p) {
    server.removeAllListeners("error");
    server.removeAllListeners("listening");
    server.once("error", (err) => {
      if (err.code !== "EADDRINUSE") {
        console.error(err);
        process.exit(1);
      }
      if (explicitPortEnv) {
        console.error(`Port ${p} is already in use.`);
        process.exit(1);
      }
      if (p >= maxPort) {
        console.error("No free port found in range. Exit.");
        process.exit(1);
      }
      console.warn(`Port ${p} is busy — trying ${p + 1}...`);
      tryListen(p + 1);
    });
    server.once("listening", () => {
      server.removeAllListeners("error");
      console.log(`DRAFTIX v${APP_VERSION} listening — open http://localhost:${p}`);
      console.log(`  • Resume on refresh: ${RECONNECT_GRACE_MS / 1000}s grace per disconnected player`);
      console.log(`  • Turn timeout: ${TURN_TIMEOUT_MS / 1000}s`);
      if (!explicitPortEnv && p !== 3000) {
        console.log(`Live Server tip: add ?server=http://127.0.0.1:${p} or use http://localhost:${p}`);
      }
      installShutdownHandlers(server, io, sessions);
      installSessionGc(io, sessions);
    });
    server.listen(p);
  }

  tryListen(preferred);
}

// ─── Process-wide crash handlers ──────────────────────
// Logged synchronously, then exit (the supervisor — pm2/systemd/docker —
// will restart us). Without these, one bad payload can leave the server
// in an undefined state.
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err && err.stack ? err.stack : err);
  // small delay so the log line flushes before exit
  setTimeout(() => process.exit(1), 200).unref();
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason && reason.stack ? reason.stack : reason);
});

// ─── Graceful shutdown ────────────────────────────────
// On SIGTERM (rolling deploys, container stop, pm2 reload) or SIGINT (Ctrl+C):
//   1. tell every connected client that we're going down so they can show
//      a banner and queue a reconnect
//   2. stop accepting new connections
//   3. drain socket.io
//   4. close the HTTP server
//   5. hard-exit after 5s if anything is hung
let shuttingDown = false;
function installShutdownHandlers(server, io, sessions) {
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down gracefully...`);
    try {
      io.emit("serverShutdown", { reason: "Server restarting — please reconnect in a moment." });
    } catch (_) {}
    // give clients ~600ms to receive the broadcast before we tear sockets down
    setTimeout(() => {
      try { io.close(); } catch (_) {}
      try {
        for (const sess of sessions.values()) {
          if (sess && sess._turnTimer) {
            clearTimeout(sess._turnTimer);
            sess._turnTimer = null;
          }
        }
      } catch (_) {}
      server.close(() => {
        console.log("Server closed cleanly.");
        process.exit(0);
      });
    }, 600);
    // hard-stop guard so a hung socket can't block the deploy
    setTimeout(() => {
      console.error("Forcing exit after 5s grace.");
      process.exit(1);
    }, 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

// ─── Stale session GC ─────────────────────────────────
// In-memory sessions live forever if nobody disconnects cleanly. Once every
// SESSION_GC_INTERVAL_MS we sweep sessions whose lastActivity is older than
// SESSION_IDLE_MS and tell remaining clients the room is closed.
function installSessionGc(io, sessions) {
  const IDLE_MS = Number(process.env.SESSION_IDLE_MS) || 2 * 60 * 60 * 1000;     // 2h
  const SWEEP_MS = Number(process.env.SESSION_GC_INTERVAL_MS) || 10 * 60 * 1000; // 10m
  setInterval(() => {
    const now = Date.now();
    let killed = 0;
    for (const [code, sess] of sessions.entries()) {
      const last = sess.lastActivity || sess.createdAt || 0;
      if (now - last > IDLE_MS) {
        try {
          if (sess._turnTimer) { clearTimeout(sess._turnTimer); sess._turnTimer = null; }
          io.to(code).emit("state", { code, closed: true, reason: "idle" });
        } catch (_) {}
        sessions.delete(code);
        killed++;
      }
    }
    if (killed) console.log(`GC: dropped ${killed} idle session(s) (idle > ${Math.floor(IDLE_MS / 60000)}m)`);
  }, SWEEP_MS).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
