/* global io */

(function () {
  const $ = (id) => document.getElementById(id);

  // ─── App-page footer year + version (best-effort) ───
  (function appPagePolish() {
    const yearEl = document.getElementById("footerYear");
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    const verEl = document.getElementById("footerVersion");
    if (verEl) {
      const base = (function () {
        try {
          const p = new URLSearchParams(location.search).get("server");
          return p || "";
        } catch (_) { return ""; }
      })();
      fetch((base || "") + "/healthz", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j && j.version) verEl.textContent = String(j.version); })
        .catch(() => { /* server might be elsewhere, harmless */ });
    }
  })();

  const landing = $("landing");
  const appShell = $("app");
  const gateError = $("gateError");

  if (typeof io === "undefined") {
    if (gateError) {
      gateError.hidden = false;
      gateError.textContent =
        "Could not load the realtime script (blocked or offline). Allow this page to load scripts from cdn.socket.io, then refresh.";
    }
    return;
  }

  // ─── URL / server discovery helpers ──────────────────
  function searchFromCodeAndServer(code, base) {
    const p = new URLSearchParams();
    if (code) p.set("code", code);
    if (base) p.set("server", base);
    const s = p.toString();
    return s ? "?" + s : "";
  }

  function normalizeDraftServerUrl(u) {
    const raw = String(u || "").trim().replace(/\/+$/, "");
    if (!raw) return "";
    const withScheme = /^https?:\/\//i.test(raw) ? raw : "http://" + raw;
    try {
      const parsed = new URL(withScheme);
      return parsed.protocol + "//" + parsed.host;
    } catch (_) {
      return raw;
    }
  }

  async function pingBase(base) {
    const root = normalizeDraftServerUrl(base);
    if (!root) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 750);
    try {
      const r = await fetch(root + "/", { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!r.ok) return null;
      if (r.headers.get("X-Valorant-Draft") === "1") return root;
    } catch (_) {
      clearTimeout(t);
    }
    return null;
  }

  async function scanDraftPorts() {
    const host = location.hostname;
    const proto = location.protocol === "https:" ? "https:" : "http:";
    const bases = [];
    for (let p = 3000; p <= 3012; p++) bases.push(proto + "//" + host + ":" + p);
    const hits = await Promise.all(bases.map((b) => pingBase(b)));
    for (const h of hits) if (h) return h;
    return null;
  }

  async function resolveServerBase() {
    const qs = new URLSearchParams(location.search);
    const fromQuery = normalizeDraftServerUrl(qs.get("server") || "");
    if (await pingBase(location.origin)) return "";
    const scanned = await scanDraftPorts();
    if (scanned) return normalizeDraftServerUrl(scanned);
    if (fromQuery && (await pingBase(fromQuery))) return fromQuery;
    if (location.protocol === "file:") return "http://127.0.0.1:3000";
    if (fromQuery) return fromQuery;
    return "";
  }

  // ─── Helpers ─────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }
  function initials(name) {
    const t = String(name || "").trim();
    if (!t) return "?";
    const parts = t.split(/\s+/).slice(0, 2);
    return parts.map((p) => p.charAt(0).toUpperCase()).join("") || t.charAt(0).toUpperCase();
  }
  function teamName(state, side) {
    if (!state || !state.teamNames) return side === "A" ? "Team A" : "Team B";
    return state.teamNames[side] || (side === "A" ? "Team A" : "Team B");
  }
  function showError(el, msg) {
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  // ─── Toast notifications ─────────────────────────────
  // Lightweight, dependency-free. Four kinds (success/error/warn/info),
  // auto-dismiss after ~4.5s (longer for errors), manual close, hover to
  // pause the auto-dismiss timer. Stacks in the top-right.
  const toast = (function () {
    let container = null;
    function ensureContainer() {
      if (container && document.body.contains(container)) return container;
      container = document.createElement("div");
      container.className = "toast-stack";
      container.setAttribute("role", "region");
      container.setAttribute("aria-live", "polite");
      container.setAttribute("aria-label", "Notifications");
      document.body.appendChild(container);
      return container;
    }
    const ICONS = { success: "✓", error: "✕", warn: "!", info: "i" };
    function show(text, kind, opts) {
      if (!text) return { dismiss() {} };
      kind = kind || "info";
      const c = ensureContainer();
      const t = document.createElement("div");
      t.className = "toast toast-" + kind;
      t.setAttribute("role", kind === "error" ? "alert" : "status");
      const icon = document.createElement("span");
      icon.className = "toast-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = ICONS[kind] || ICONS.info;
      const txt = document.createElement("span");
      txt.className = "toast-text";
      txt.textContent = String(text);
      const close = document.createElement("button");
      close.className = "toast-close";
      close.setAttribute("aria-label", "Dismiss");
      close.textContent = "×";
      t.append(icon, txt, close);
      c.appendChild(t);
      // animate in on next frame
      requestAnimationFrame(() => t.classList.add("toast-in"));
      const baseDur = kind === "error" ? 6500 : 4500;
      const dur = opts && typeof opts.duration === "number" ? opts.duration : baseDur;
      let timer = null;
      function clear() { if (timer) { clearTimeout(timer); timer = null; } }
      function dismiss() {
        clear();
        t.classList.remove("toast-in");
        t.classList.add("toast-out");
        setTimeout(() => { if (t.parentNode) t.remove(); }, 260);
      }
      function arm() { if (dur > 0) timer = setTimeout(dismiss, dur); }
      t.addEventListener("mouseenter", clear);
      t.addEventListener("mouseleave", arm);
      close.addEventListener("click", dismiss);
      arm();
      return { dismiss };
    }
    return {
      success: (m, o) => show(m, "success", o),
      error:   (m, o) => show(m, "error",   o),
      warn:    (m, o) => show(m, "warn",    o),
      info:    (m, o) => show(m, "info",    o),
    };
  })();

  // ─── Boot ────────────────────────────────────────────
  (async function boot() {
    let serverBase = normalizeDraftServerUrl(await resolveServerBase());

    {
      const cur = new URLSearchParams(location.search);
      const curServer = normalizeDraftServerUrl(cur.get("server") || "");
      const code = cur.get("code") || "";
      if (!serverBase && curServer) {
        history.replaceState({}, "", location.pathname + searchFromCodeAndServer(code, ""));
      } else if (serverBase && curServer !== serverBase) {
        history.replaceState({}, "", location.pathname + searchFromCodeAndServer(code, serverBase));
      }
    }

    function stripStaleCodeFromUrl() {
      history.replaceState({}, "", location.pathname + searchFromCodeAndServer("", serverBase));
    }
    function syncAddressBarToRoomCode(roomCode) {
      if (!roomCode) return;
      history.replaceState({}, "", location.pathname + searchFromCodeAndServer(roomCode, serverBase));
    }

    // ─── Resume tokens (refresh-proof seats) ────────────
    // The server hands us a 22-char token on createSession / joinSession.
    // We keep it in localStorage keyed by session code; on a refresh we send
    // it back with joinSession and the server re-attaches our captain / host
    // / team slot to the new socket. Cleared when:
    //   • the server says the code doesn't exist anymore,
    //   • the user clicks Leave (sends leaveSession first),
    //   • the user joins a totally different code.
    const TOKEN_KEY_PREFIX = "draftix:token:";
    const NICK_KEY = "draftix:nickname";
    function getStoredToken(code) {
      try {
        const v = code ? (localStorage.getItem(TOKEN_KEY_PREFIX + code) || null) : null;
        if (code) console.debug("[draftix] getStoredToken(", code, ") =", v ? v.slice(0, 8) + "…" : null);
        return v;
      } catch (_) { return null; }
    }
    function setStoredToken(code, token) {
      try {
        if (code && token) {
          localStorage.setItem(TOKEN_KEY_PREFIX + code, token);
          console.debug("[draftix] saved token for", code, "=", token.slice(0, 8) + "…");
        }
      } catch (_) {}
    }
    function clearStoredToken(code) {
      try { if (code) localStorage.removeItem(TOKEN_KEY_PREFIX + code); }
      catch (_) {}
    }
    function getStoredNickname() {
      try { return localStorage.getItem(NICK_KEY) || ""; } catch (_) { return ""; }
    }
    function setStoredNickname(nick) {
      try { if (nick) localStorage.setItem(NICK_KEY, nick); } catch (_) {}
    }

    const REJECTED_URL_CODES_KEY = "draftix-rejected-url-codes";
    function loadRejected() {
      try {
        const raw = sessionStorage.getItem(REJECTED_URL_CODES_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(arr) ? arr : []);
      } catch (_) { return new Set(); }
    }
    function saveRejected(set) {
      try { sessionStorage.setItem(REJECTED_URL_CODES_KEY, JSON.stringify([...set].slice(-40))); } catch (_) {}
    }
    const rejectedUrlCodes = loadRejected();
    function clearUrlJoinRejected(code) { rejectedUrlCodes.delete(code); saveRejected(rejectedUrlCodes); }

    const notFoundMsg =
      "That session code is not active. Ask the host for a fresh invite link.";

    const socket = serverBase
      ? io(serverBase, { transports: ["websocket", "polling"] })
      : io({ transports: ["websocket", "polling"] });

    const roomError = $("roomError");
    const mapsSection = $("mapsSection");
    const agentsSection = $("agentsSection");
    const completeModal = $("completeModal");

    let state = null;
    let myCode = null;
    let prevSnap = null;
    /** Per-session-code: have we already shown the "draft complete" modal? */
    let modalShownForCode = null;

    // ─── Turn countdown (clock-skew-tolerant) ───
    // Server sends absolute turnEndsAt + serverNow on each state. We compute
    // the local-clock deadline once per state event, then tick locally.
    let turnLocalDeadline = null;
    let turnTimerInterval = null;
    let lastTurnEndsAt = null;
    function applyTurnDeadline(s) {
      if (!s || !s.turnEndsAt || (s.phase !== "map_ban" && s.phase !== "agent_ban")) {
        stopTurnCountdown();
        return;
      }
      // Re-arm only when the deadline actually changed (so we don't reset the tick on every render).
      if (s.turnEndsAt === lastTurnEndsAt) return;
      lastTurnEndsAt = s.turnEndsAt;
      const msLeftAtSnapshot = Math.max(0, s.turnEndsAt - (s.serverNow || Date.now()));
      turnLocalDeadline = Date.now() + msLeftAtSnapshot;
      renderTurnTimer();
      if (turnTimerInterval) clearInterval(turnTimerInterval);
      turnTimerInterval = setInterval(renderTurnTimer, 250);
    }
    function stopTurnCountdown() {
      if (turnTimerInterval) { clearInterval(turnTimerInterval); turnTimerInterval = null; }
      turnLocalDeadline = null;
      lastTurnEndsAt = null;
      const el = document.getElementById("turnTimer");
      if (el) { el.hidden = true; el.classList.remove("urgent"); }
    }
    function renderTurnTimer() {
      const el = document.getElementById("turnTimer");
      const val = document.getElementById("turnTimerValue");
      if (!el || !val || !turnLocalDeadline) return;
      const leftMs = Math.max(0, turnLocalDeadline - Date.now());
      const totalSec = Math.ceil(leftMs / 1000);
      const mm = Math.floor(totalSec / 60).toString().padStart(2, "0");
      const ss = (totalSec % 60).toString().padStart(2, "0");
      val.textContent = mm + ":" + ss;
      el.hidden = false;
      el.classList.toggle("urgent", leftMs <= 5000 && leftMs > 0);
      el.classList.toggle("expired", leftMs <= 0);
      if (leftMs <= 0 && turnTimerInterval) {
        clearInterval(turnTimerInterval);
        turnTimerInterval = null;
      }
    }

    // ─── Sounds (synth fallback; drop MP3s in public/sounds/) ───
    const draftSounds = (function () {
      const files = { ban: "sounds/ban.mp3", start: "sounds/start.mp3", done: "sounds/done.mp3" };
      let ctx = null;
      function ac() {
        if (ctx) return ctx;
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
        return ctx;
      }
      document.body.addEventListener("click", function () {
        const c = ac(); if (c && c.state === "suspended") c.resume();
      }, { once: true });
      function tone(freq, dur, wave) {
        const a = ac(); if (!a) return;
        if (a.state === "suspended") a.resume();
        const o = a.createOscillator(); const g = a.createGain();
        o.type = wave || "square"; o.frequency.value = freq;
        g.gain.setValueAtTime(0.07, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
        o.connect(g); g.connect(a.destination);
        o.start(a.currentTime); o.stop(a.currentTime + dur);
      }
      const sBan = () => tone(220, 0.07, "square");
      const sStart = () => [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.1, "triangle"), i * 70));
      const sDone = () => [784, 988].forEach((f, i) => setTimeout(() => tone(f, 0.14, "sine"), i * 90));
      function playFile(rel, fallback) {
        const aud = new Audio(rel); aud.volume = 0.35;
        const fail = () => fallback();
        aud.addEventListener("error", fail, { once: true });
        const p = aud.play(); if (p && typeof p.catch === "function") p.catch(fail);
      }
      return {
        ban: () => playFile(files.ban, sBan),
        start: () => playFile(files.start, sStart),
        done: () => playFile(files.done, sDone),
      };
    })();

    // ─── Mute toggle (persisted in localStorage) ───────────
    // Wraps draftSounds so any caller honors the user's preference. The
    // toggle button in the appbar reflects/changes this state.
    const SOUND_KEY = "draftix:soundEnabled";
    const sound = (function () {
      let enabled = true;
      try {
        const v = localStorage.getItem(SOUND_KEY);
        if (v === "false") enabled = false;
      } catch (_) {}
      function set(on) {
        enabled = !!on;
        try { localStorage.setItem(SOUND_KEY, String(enabled)); } catch (_) {}
        applyToggleUi();
      }
      function applyToggleUi() {
        const btn = document.getElementById("btnSoundToggle");
        if (!btn) return;
        btn.setAttribute("aria-pressed", String(enabled));
        btn.title = enabled ? "Sound on (click to mute)" : "Sound muted (click to unmute)";
        const on = btn.querySelector(".sound-on");
        const off = btn.querySelector(".sound-off");
        if (on) on.hidden = !enabled;
        if (off) off.hidden = enabled;
      }
      return {
        ban:   () => { if (enabled) draftSounds.ban(); },
        start: () => { if (enabled) draftSounds.start(); },
        done:  () => { if (enabled) draftSounds.done(); },
        get enabled() { return enabled; },
        toggle() { set(!enabled); },
        applyToggleUi,
      };
    })();
    // Reflect initial state once DOM is ready (button might not exist yet)
    sound.applyToggleUi();

    // ─── Connection status indicator ──────────────────────
    function setConnState(state) {
      const el = document.getElementById("connStatus");
      if (!el) return;
      el.classList.remove("conn-online", "conn-reconnecting", "conn-offline");
      const label = el.querySelector(".conn-label");
      if (state === "online") {
        el.classList.add("conn-online");
        if (label) label.textContent = "Online";
        el.title = "Connected";
      } else if (state === "reconnecting") {
        el.classList.add("conn-reconnecting");
        if (label) label.textContent = "Reconnecting…";
        el.title = "Lost connection — retrying";
      } else {
        el.classList.add("conn-offline");
        if (label) label.textContent = "Offline";
        el.title = "Server unreachable";
      }
    }
    function showServerBanner(text, kind) {
      const b = document.getElementById("serverBanner");
      if (!b) return;
      b.textContent = text;
      b.className = "server-banner " + (kind || "info");
      b.hidden = false;
    }
    function hideServerBanner() {
      const b = document.getElementById("serverBanner");
      if (b) b.hidden = true;
    }

    // ─── Rendering ────────────────────────────────────────
    function setRoleBadge() {
      const badge = $("roleBadge");
      if (!state || !state.me) { badge.textContent = ""; badge.className = "badge"; return; }
      const parts = [];
      if (state.me.isHost) parts.push("Host");
      if (state.me.myTeam === "A") parts.push(state.me.isCaptain ? "Captain A" : "Team A");
      else if (state.me.myTeam === "B") parts.push(state.me.isCaptain ? "Captain B" : "Team B");
      else parts.push("Spectator");
      badge.textContent = parts.join(" · ");
      badge.className =
        "badge" +
        (state.me.isHost ? " host" : "") +
        (state.me.myTeam === "A" ? " cap-a" : state.me.myTeam === "B" ? " cap-b" : "");
    }

    function renderRoster(ul, roster, myId) {
      ul.innerHTML = "";
      if (!roster || !roster.length) {
        const li = document.createElement("li");
        li.className = "empty-slot";
        li.innerHTML = '<span class="dot"></span><span>No players yet</span>';
        ul.appendChild(li);
        return;
      }
      for (const p of roster) {
        if (p.isCaptain) continue; // captain shown in the captain card
        const li = document.createElement("li");
        li.innerHTML =
          '<span class="dot"></span>' +
          '<span>' + escapeHtml(p.nickname) + '</span>' +
          (p.id === myId ? '<span class="me-tag">YOU</span>' : "");
        ul.appendChild(li);
      }
      if (!ul.children.length) {
        const li = document.createElement("li");
        li.className = "empty-slot";
        li.innerHTML = '<span class="dot"></span><span>Captain only</span>';
        ul.appendChild(li);
      }
    }

    function totalMapRounds(s) {
      const total = (s.catalog && s.catalog.maps && s.catalog.maps.length) || 0;
      return Math.max(2, total);
    }

    function currentMapRoundIdx(s) {
      // 0-based current round index during map_ban; after = last
      return Math.min((s.mapBans || []).length, totalMapRounds(s) - 1);
    }

    function renderPhaseHeader() {
      const phaseTitle = $("phaseTitle");
      const phaseRound = $("phaseRound");
      const turnBanner = $("turnBanner");
      const capA = state.captainNames && state.captainNames.A;
      const capB = state.captainNames && state.captainNames.B;

      if (state.phase === "lobby") {
        phaseTitle.textContent = "Lobby";
        phaseRound.textContent = "Waiting for captains";
        turnBanner.textContent = "";
        turnBanner.className = "turn-banner";
        return;
      }
      const tA = teamName(state, "A");
      const tB = teamName(state, "B");
      if (state.phase === "map_ban") {
        const total = totalMapRounds(state);
        const idx = currentMapRoundIdx(state);
        phaseTitle.textContent = "Map Ban Phase";
        phaseRound.textContent = "Round " + (idx + 1) + " of " + total;
        const turn = state.currentTurn;
        const who = turn === "A" ? capA || tA : capB || tB;
        turnBanner.textContent = (turn === "A" ? tA : tB) + " is banning — " + who;
        turnBanner.className = "turn-banner " + (turn === "A" ? "turn-a" : "turn-b");
        return;
      }
      if (state.phase === "side_pick") {
        phaseTitle.textContent = "Side Pick";
        phaseRound.textContent = "Decider: " + ((state.selectedMap && state.selectedMap.name) || "—");
        const picker = state.sidePickerTeam;
        const teamLabel = picker === "A" ? tA : tB;
        turnBanner.textContent = teamLabel + " picks side";
        turnBanner.className = "turn-banner " + (picker === "A" ? "turn-a" : "turn-b");
        return;
      }
      if (state.phase === "agent_ban") {
        const total = 6;
        const idx = Math.min((state.agentBans || []).length, total - 1);
        phaseTitle.textContent = "Agent Ban Phase";
        phaseRound.textContent = "Round " + (idx + 1) + " of " + total;
        const turn = state.currentTurn;
        const who = turn === "A" ? capA || tA : capB || tB;
        turnBanner.textContent = (turn === "A" ? tA : tB) + " is banning — " + who;
        turnBanner.className = "turn-banner " + (turn === "A" ? "turn-a" : "turn-b");
        return;
      }
      if (state.phase === "done") {
        phaseTitle.textContent = "Draft Complete";
        phaseRound.textContent = "Map decided";
        turnBanner.textContent = "✓ Ready to play";
        turnBanner.className = "turn-banner";
        return;
      }
    }

    function renderTeamStatus() {
      const sA = $("statusA");
      const sB = $("statusB");
      const lobby = state.phase === "lobby";
      const done = state.phase === "done";

      // Live-update the team labels from state.teamNames
      const labA = $("teamLabelA");
      const labB = $("teamLabelB");
      if (labA) labA.textContent = teamName(state, "A");
      if (labB) labB.textContent = teamName(state, "B");

      if (lobby) {
        sA.textContent = state.captainA ? "Ready" : "No captain";
        sB.textContent = state.captainB ? "Ready" : "No captain";
        sA.className = "team-status";
        sB.className = "team-status";
        return;
      }
      if (done) {
        sA.textContent = "Done"; sB.textContent = "Done";
        sA.className = "team-status"; sB.className = "team-status";
        return;
      }
      const turn = state.currentTurn;
      sA.textContent = turn === "A" ? "Your turn" : "Waiting…";
      sA.className = "team-status " + (turn === "A" ? "live" : "waiting");
      sB.textContent = turn === "B" ? "Your turn" : "Waiting…";
      sB.className = "team-status " + (turn === "B" ? "live" : "waiting");
    }

    function renderCaptainCards() {
      const capA = state.captainNames && state.captainNames.A;
      const capB = state.captainNames && state.captainNames.B;
      const elA = $("captainNameA");
      const elB = $("captainNameB");
      const avA = $("avatarA");
      const avB = $("avatarB");

      if (capA) { elA.textContent = capA; elA.classList.remove("empty"); avA.textContent = initials(capA); }
      else { elA.textContent = "No captain"; elA.classList.add("empty"); avA.textContent = "A"; }

      if (capB) { elB.textContent = capB; elB.classList.remove("empty"); avB.textContent = initials(capB); }
      else { elB.textContent = "No captain"; elB.classList.add("empty"); avB.textContent = "B"; }
    }

    function renderLobbyActions() {
      const lobby = state.phase === "lobby";
      const actA = $("lobbyActionsA");
      const actB = $("lobbyActionsB");
      const hostStart = $("hostStart");
      const lobbyHint = $("lobbyHint");

      actA.hidden = !lobby;
      actB.hidden = !lobby;
      hostStart.hidden = !(lobby && state.me && state.me.isHost);
      lobbyHint.hidden = !lobby;

      if (!lobby) return;

      const me = state.me || {};
      const capA = !!state.captainNames.A;
      const capB = !!state.captainNames.B;
      const meIsCapA = me.myTeam === "A" && me.isCaptain;
      const meIsCapB = me.myTeam === "B" && me.isCaptain;

      const tA = teamName(state, "A");
      const tB = teamName(state, "B");

      $("btnCapA").disabled = capA && !meIsCapA;
      $("btnCapA").textContent = meIsCapA ? "You are " + tA + " captain" : capA ? tA + " captain taken" : "Claim " + tA + " captain";

      $("btnCapB").disabled = capB && !meIsCapB;
      $("btnCapB").textContent = meIsCapB ? "You are " + tB + " captain" : capB ? tB + " captain taken" : "Claim " + tB + " captain";

      $("btnJoinA").disabled = me.isCaptain;
      $("btnJoinA").textContent = me.myTeam === "A" && !me.isCaptain ? "✓ On " + tA : "Join " + tA;

      $("btnJoinB").disabled = me.isCaptain;
      $("btnJoinB").textContent = me.myTeam === "B" && !me.isCaptain ? "✓ On " + tB : "Join " + tB;

      // Host-only team-name editor
      const editor = $("teamNameEditor");
      if (editor) {
        const showEditor = lobby && me.isHost;
        editor.hidden = !showEditor;
        if (showEditor) {
          // Only refill inputs when they're empty / out-of-sync, so we don't
          // clobber the host's mid-typing characters on broadcasts.
          const inA = $("tnA"); const inB = $("tnB");
          if (inA && document.activeElement !== inA && inA.value.trim() === "") inA.value = state.teamNames ? state.teamNames.A : "";
          if (inB && document.activeElement !== inB && inB.value.trim() === "") inB.value = state.teamNames ? state.teamNames.B : "";
        }
      }
    }

    function renderRosters() {
      const rosters = state.teamRosters || { A: [], B: [] };
      renderRoster($("rosterA"), rosters.A, state.me && state.me.id);
      renderRoster($("rosterB"), rosters.B, state.me && state.me.id);
    }

    function renderGrid(container, items, isBanned, isSelected, canClick, onPick) {
      container.innerHTML = "";
      for (const item of items) {
        const banned = isBanned(item);
        const sel = isSelected ? isSelected(item) : false;
        const div = document.createElement("div");
        div.className = "tile" +
          (banned && !sel ? " banned" : "") +
          (sel ? " selected" : "") +
          (!banned && !sel && canClick ? " clickable" : "") +
          (!banned && !sel && !canClick ? " dim" : "");
        div.innerHTML =
          '<img loading="lazy" src="' + escapeAttr(item.image) + '" alt="" />' +
          (banned || sel ? '<span class="banned-tag">' + (sel ? "PICK" : "BANNED") + "</span>" : "") +
          '<span class="tile-name">' + escapeHtml(item.name) + "</span>";
        if (!banned && !sel && canClick) {
          div.addEventListener("click", () => onPick(item.uuid));
        }
        container.appendChild(div);
      }
    }

    function canActOnTurn(s) {
      if (!s.me || !s.me.myTeam) return false;
      if (!s.me.isCaptain) return false;
      return s.me.myTeam === s.currentTurn;
    }

    function turnSequenceForMaps(total) {
      // Total ban-rounds (including the decider slot at the end).
      // We alternate A,B,A,B... but the decider slot is "neither".
      const seq = [];
      let t = "A";
      for (let i = 0; i < total - 1; i++) { seq.push(t); t = t === "A" ? "B" : "A"; }
      seq.push(null); // decider
      return seq;
    }

    function renderRoundChips() {
      const bar = $("roundChips");
      if (state.phase !== "map_ban" && state.phase !== "agent_ban" && state.phase !== "done") {
        bar.hidden = true;
        return;
      }
      bar.hidden = false;
      bar.innerHTML = "";

      if (state.phase === "agent_ban" || (state.phase === "done" && (state.agentBans || []).length > 0)) {
        const total = 6;
        const agents = (state.catalog && state.catalog.agents) || [];
        const bansArr = state.agentBans || [];
        for (let i = 0; i < total; i++) {
          const team = i % 2 === 0 ? "A" : "B";
          const done = i < bansArr.length;
          const isCurrent = state.phase === "agent_ban" && i === bansArr.length;
          const banName = done ? (agents.find((a) => a.uuid === bansArr[i]) || {}).name || "—" : "";
          const chip = document.createElement("div");
          chip.className = "chip team-" + team.toLowerCase() + (isCurrent ? " current" : "");
          chip.innerHTML =
            '<span class="chip-team-label">' + team + "</span>" +
            '<span class="chip-index">' + (i + 1) + "</span>" +
            '<span class="chip-status">' + (done ? "BANNED" : isCurrent ? "BANNING" : "—") + "</span>" +
            (done ? '<span class="chip-pick">' + escapeHtml(banName) + "</span>" : "");
          bar.appendChild(chip);
        }
        return;
      }

      // Map chips
      const total = totalMapRounds(state);
      const seq = turnSequenceForMaps(total);
      const maps = (state.catalog && state.catalog.maps) || [];
      const bansArr = state.mapBans || [];
      const decider = state.selectedMap;

      for (let i = 0; i < total; i++) {
        const isDecider = i === total - 1;
        const team = seq[i];
        const done = i < bansArr.length;
        const isCurrent = state.phase === "map_ban" && i === bansArr.length;
        const banName = done ? (maps.find((m) => m.uuid === bansArr[i]) || {}).name || "—" : "";

        const chip = document.createElement("div");
        chip.className =
          "chip" +
          (isDecider ? " decider" : team === "A" ? " team-a" : " team-b") +
          (isCurrent ? " current" : "");
        if (isDecider && decider) {
          chip.innerHTML =
            '<span class="chip-team-label">★</span>' +
            '<span class="chip-index">' + (i + 1) + '</span>' +
            '<span class="chip-status">DECIDER</span>' +
            '<span class="chip-pick">' + escapeHtml(decider.name) + '</span>';
        } else if (isDecider) {
          chip.innerHTML =
            '<span class="chip-team-label">★</span>' +
            '<span class="chip-index">' + (i + 1) + '</span>' +
            '<span class="chip-status">DECIDER</span>';
        } else {
          chip.innerHTML =
            '<span class="chip-team-label">' + team + "</span>" +
            '<span class="chip-index">' + (i + 1) + "</span>" +
            '<span class="chip-status">' + (done ? "BANNED" : isCurrent ? "BANNING" : "—") + "</span>" +
            (done ? '<span class="chip-pick">' + escapeHtml(banName) + "</span>" : "");
        }
        bar.appendChild(chip);
      }
    }

    function renderHistory() {
      const ul = $("historyList");
      const maps = (state.catalog && state.catalog.maps) || [];
      const agents = (state.catalog && state.catalog.agents) || [];
      const total = totalMapRounds(state);
      const seq = turnSequenceForMaps(total);

      const rows = [];
      (state.mapBans || []).forEach((uuid, i) => {
        const m = maps.find((x) => x.uuid === uuid);
        const t = seq[i] || "A";
        rows.push({ team: t, target: (m && m.name) || "Map", round: i + 1, kind: "MAP" });
      });
      (state.agentBans || []).forEach((uuid, i) => {
        const a = agents.find((x) => x.uuid === uuid);
        const t = i % 2 === 0 ? "A" : "B";
        rows.push({ team: t, target: (a && a.name) || "Agent", round: i + 1, kind: "AGENT" });
      });
      if (state.phase === "done" && state.selectedMap) {
        rows.push({ team: null, target: state.selectedMap.name, round: "★", kind: "DECIDER" });
      }

      if (!rows.length) {
        ul.innerHTML = '<li class="muted">No actions yet.</li>';
        return;
      }
      ul.innerHTML = rows
        .map((r) => {
          const teamCls = r.team === "A" ? "a" : r.team === "B" ? "b" : "";
          const teamLabel = r.team ? r.team : "★";
          const target = r.kind === "DECIDER" ? "Plays on " + r.target : "Banned " + r.target;
          return (
            '<li><span class="hist-team ' + teamCls + '">' + teamLabel + "</span>" +
            '<span class="hist-target">' + escapeHtml(target) + "</span>" +
            '<span class="hist-round">R' + r.round + "</span></li>"
          );
        })
        .join("");
    }

    // ─── Draft Complete modal ────────────────────────────
    function findCaptain(side) {
      return (state && state.captainNames && state.captainNames[side]) || null;
    }

    function buildModalContent() {
      const maps = (state.catalog && state.catalog.maps) || [];
      const agents = (state.catalog && state.catalog.agents) || [];

      const pickedMap =
        maps.find((m) => state.selectedMap && m.uuid === state.selectedMap.uuid) ||
        state.selectedMap || {};

      const bannedAgents = (state.agentBans || [])
        .map((id) => agents.find((a) => a.uuid === id))
        .filter(Boolean);

      const sidePicker = state.sidePickerTeam || null;
      const sideChosen = state.selectedSide || null;
      const sideLabel = sideChosen
        ? (sideChosen === "attack" ? "⚔ Attack" : "⛨ Defense")
        : "";
      const sideTeamLabel = sidePicker ? teamName(state, sidePicker) : "";

      const mapEl = $("modalMap");
      if (pickedMap && pickedMap.image) {
        mapEl.innerHTML =
          '<span class="modal-map-tag">Decider</span>' +
          (sideLabel
            ? '<span class="modal-map-side ' + (sideChosen === "attack" ? "side-attack" : "side-defense") + '">' +
              escapeHtml(sideLabel) + " · " + escapeHtml(sideTeamLabel) +
              "</span>"
            : "") +
          '<img src="' + escapeAttr(pickedMap.image) + '" alt="" />' +
          '<span class="modal-map-name">' + escapeHtml(pickedMap.name || "—") + "</span>";
      } else {
        mapEl.innerHTML =
          '<span class="modal-map-name" style="position:static; padding:1rem;">' +
          escapeHtml((pickedMap && pickedMap.name) || "—") + "</span>";
      }

      const list = $("modalAgents");
      if (!bannedAgents.length) {
        list.innerHTML = '<li class="empty">No agents banned.</li>';
      } else {
        list.innerHTML = bannedAgents
          .map(function (a) {
            const img = a.icon || a.image || "";
            return (
              "<li>" +
              (img ? '<img class="ag-img" src="' + escapeAttr(img) + '" alt="" />' : '<span class="ag-img"></span>') +
              '<span class="ag-name">' + escapeHtml(a.name) + "</span></li>"
            );
          })
          .join("");
      }

      const capA = findCaptain("A");
      const capB = findCaptain("B");
      const tA = teamName(state, "A");
      const tB = teamName(state, "B");
      $("modalCapA").textContent = (capA ? capA + " · " : "") + tA;
      $("modalCapB").textContent = (capB ? capB + " · " : "") + tB;

      const sub = $("modalSubtitle");
      if (capA && capB) sub.textContent = tA + " vs " + tB + " — battle on " + (pickedMap.name || "the chosen map") + ".";
      else if (pickedMap && pickedMap.name) sub.textContent = "Ready to play on " + pickedMap.name + ".";
      else sub.textContent = "Draft locked in.";
    }

    function openCompleteModal() {
      if (!completeModal) return;
      buildModalContent();
      completeModal.hidden = false;
      completeModal.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-open");
      // Restart entrance animations (re-trigger keyframes)
      const card = completeModal.querySelector(".modal-card");
      if (card) {
        card.style.animation = "none";
        // force reflow
        void card.offsetWidth;
        card.style.animation = "";
      }
      // Focus the close button for a11y
      setTimeout(function () {
        const btn = $("modalClose");
        if (btn) try { btn.focus({ preventScroll: true }); } catch (_) {}
      }, 50);
    }

    function closeCompleteModal(opts) {
      if (!completeModal) return;
      if (completeModal.hidden) return;
      completeModal.hidden = true;
      completeModal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("modal-open");
      if (!(opts && opts.silent)) {
        // user-initiated close — remember it so re-renders don't reopen
        if (state && state.code) modalShownForCode = state.code;
      }
    }

    // ─── Coin-flip overlay ────────────────────────────────
    function playCoinFlip(s) {
      const el = document.getElementById("coinFlip");
      const coin = document.getElementById("coinEl");
      const out  = document.getElementById("coinResult");
      if (!el || !coin || !out) return;
      const winner = s.firstBanner || s.currentTurn || "A";
      const tA = teamName(s, "A");
      const tB = teamName(s, "B");
      el.hidden = false;
      out.textContent = "Flipping…";
      coin.classList.remove("settle-a", "settle-b");
      // force reflow so animation restarts cleanly
      void coin.offsetWidth;
      coin.classList.add(winner === "A" ? "settle-a" : "settle-b");
      // hide the map grid behind it during the flip
      const ms = document.getElementById("mapsSection");
      if (ms) ms.classList.add("dimmed");
      setTimeout(() => {
        out.textContent = (winner === "A" ? tA : tB) + " bans first";
        out.classList.add(winner === "A" ? "result-a" : "result-b");
      }, 2100);
      setTimeout(() => {
        el.hidden = true;
        out.classList.remove("result-a", "result-b");
        if (ms) ms.classList.remove("dimmed");
      }, 3200);
    }

    function render() {
      if (!state || state.closed) {
        landing.hidden = false;
        appShell.hidden = true;
        if (state && state.closed) showError(gateError, "Host left or session ended.");
        return;
      }

      landing.hidden = true;
      appShell.hidden = false;

      $("roomCode").textContent = state.code;
      myCode = state.code;
      setRoleBadge();
      renderPhaseHeader();
      renderTeamStatus();
      renderCaptainCards();
      renderLobbyActions();
      renderRosters();
      renderRoundChips();
      renderHistory();

      const maps = (state.catalog && state.catalog.maps) || [];
      const agents = (state.catalog && state.catalog.agents) || [];
      const mapBanSet = new Set(state.mapBans || []);
      const agentBanSet = new Set(state.agentBans || []);
      const selectedMapUuid = state.selectedMap && state.selectedMap.uuid;

      // Map grid: shown in map_ban / side_pick / done (so the decider stays visible)
      const mapsVisiblePhases = state.phase === "map_ban" || state.phase === "side_pick" || state.phase === "done";
      if (mapsVisiblePhases) {
        mapsSection.hidden = false;
        const remaining = maps.filter((m) => !mapBanSet.has(m.uuid)).length;
        $("mapsHelp").textContent =
          state.phase === "map_ban"
            ? "Maps remaining: " + remaining + " — ban down to one"
            : "Final map decided";
        renderGrid(
          $("mapGrid"),
          maps,
          (m) => mapBanSet.has(m.uuid) && m.uuid !== selectedMapUuid,
          (m) => m.uuid === selectedMapUuid,
          state.phase === "map_ban" && canActOnTurn(state),
          (uuid) => socket.emit("banMap", { code: state.code, uuid }, ackRoom)
        );
      } else {
        mapsSection.hidden = true;
      }

      // Side-pick UI
      const sidePickEl = $("sidePickSection");
      if (sidePickEl) {
        if (state.phase === "side_pick") {
          sidePickEl.hidden = false;
          const tA = teamName(state, "A");
          const tB = teamName(state, "B");
          const pickerName = state.sidePickerTeam === "A" ? tA : tB;
          const me = state.me || {};
          const isMyPick = me.isCaptain && me.myTeam === state.sidePickerTeam;
          $("sidePickHelp").textContent = isMyPick
            ? "Your team picks the starting side on " + ((state.selectedMap && state.selectedMap.name) || "the decider")
            : pickerName + " is picking side on " + ((state.selectedMap && state.selectedMap.name) || "the decider") + "…";
          $("btnSideAttack").disabled = !isMyPick;
          $("btnSideDefense").disabled = !isMyPick;
          $("sidePickCaption").textContent = isMyPick
            ? "Choose your starting side"
            : "Waiting for " + pickerName + " to choose…";
        } else {
          sidePickEl.hidden = true;
        }
      }

      if (state.phase === "agent_ban") {
        agentsSection.hidden = false;
        const remaining = 6 - (state.agentBans || []).length;
        $("agentsHelp").textContent = "Agents to ban: " + remaining + " of 6";
        renderGrid(
          $("agentGrid"),
          agents,
          (a) => agentBanSet.has(a.uuid),
          null,
          canActOnTurn(state),
          (uuid) => socket.emit("banAgent", { code: state.code, uuid }, ackRoom)
        );
      } else {
        agentsSection.hidden = true;
      }

      if (state.phase === "done") {
        if (modalShownForCode !== state.code) {
          openCompleteModal();
          modalShownForCode = state.code;
        }
      } else {
        if (modalShownForCode && modalShownForCode !== state.code) modalShownForCode = null;
        if (state.phase !== "done") closeCompleteModal({ silent: true });
      }

      const statusEl = $("statusLine");
      if (state.phase === "lobby") statusEl.textContent = "Waiting in lobby";
      else if (state.phase === "map_ban") statusEl.textContent = "Map veto live";
      else if (state.phase === "agent_ban") statusEl.textContent = "Agent bans live";
      else if (state.phase === "done") statusEl.textContent = "Draft complete";
    }

    function ackRoom(res) {
      if (res && !res.ok && res.error) {
        showError(roomError, res.error);
        toast.error(res.error);
      } else {
        showError(roomError, "");
      }
    }

    // ─── Socket events ────────────────────────────────────
    socket.on("state", function (s) {
      if (prevSnap && s && !s.closed && prevSnap.code === s.code) {
        if (prevSnap.phase === "lobby" && s.phase === "map_ban") {
          sound.start();
          playCoinFlip(s);
        }
        if ((s.mapBans || []).length > prevSnap.mapBansN) sound.ban();
        if ((s.agentBans || []).length > prevSnap.agentBansN) sound.ban();
        if (s.phase === "done" && prevSnap.phase !== "done") sound.done();
      }

      state = s;
      showError(gateError, "");

      if (s && s.closed) {
        prevSnap = null;
        stopTurnCountdown();
        // The session no longer exists on the server — drop the stored token
        // so a future visit doesn't try to resume into thin air.
        if (s.code) clearStoredToken(s.code);
        // Reset chat — next session gets a clean log.
        renderedChatIds = new Set();
        chatUnread = 0;
        const chatLog = document.getElementById("chatLog");
        if (chatLog) chatLog.innerHTML = '<p class="chat-empty">Say hi to your teammates — messages stay in this session only.</p>';
        const chatBadge = document.getElementById("chatUnread");
        if (chatBadge) { chatBadge.hidden = true; chatBadge.textContent = "0"; }
        const q = serverBase ? searchFromCodeAndServer("", serverBase) : "";
        history.replaceState({}, "", location.pathname + q);
        render();
        return;
      }

      if (s && s.code && !s.closed) {
        syncAddressBarToRoomCode(s.code);
        const jc = $("joinCode");
        if (jc && jc.value.trim().toUpperCase() !== s.code) jc.value = s.code;
      }
      render();
      applyTurnDeadline(s);
      if (s && !s.closed) rebuildChatFromState(s);

      prevSnap = s && !s.closed
        ? { code: s.code, phase: s.phase, mapBansN: (s.mapBans || []).length, agentBansN: (s.agentBans || []).length }
        : null;
    });

    // Track whether we've already shown a "reconnecting" toast so we don't
    // spam the user with one per failed attempt.
    let _reconnectingToastShown = false;
    let _wasOnline = false;

    socket.on("connect_error", function () {
      setConnState("reconnecting");
      showError(
        gateError,
        "Can't connect right now. We'll keep trying — you can also refresh the page."
      );
      if (!_reconnectingToastShown) {
        toast.error("Can't reach the server. Retrying…", { duration: 8000 });
        _reconnectingToastShown = true;
      }
    });

    // Native socket.io lifecycle hooks for the connection indicator.
    socket.on("disconnect", function (reason) {
      // "io client disconnect" = our own .disconnect() call (intentional)
      // "io server disconnect" = server kicked us (graceful shutdown / GC)
      if (reason === "io client disconnect") return;
      setConnState("reconnecting");
      if (_wasOnline && !_reconnectingToastShown) {
        toast.warn("Lost connection — reconnecting…", { duration: 6000 });
        _reconnectingToastShown = true;
      }
      _wasOnline = false;
    });
    socket.io && socket.io.on && socket.io.on("reconnect_attempt", () => setConnState("reconnecting"));
    socket.io && socket.io.on && socket.io.on("reconnect", () => {
      setConnState("online");
      hideServerBanner();
      toast.success("Back online");
      _reconnectingToastShown = false;
      _wasOnline = true;
    });
    socket.io && socket.io.on && socket.io.on("reconnect_failed", () => {
      setConnState("offline");
      toast.error("Couldn't reconnect. Try refreshing the page.");
    });

    // Server-initiated shutdown notice — show a banner so the user knows
    // their reconnect attempts aren't a bug.
    socket.on("serverShutdown", function (payload) {
      const reason = (payload && payload.reason) || "Server restarting. Your session may be ending.";
      showServerBanner(reason, "warn");
      setConnState("reconnecting");
      toast.warn(reason, { duration: 8000 });
    });

    // ─── Chat ─────────────────────────────────────────────
    // Renders the session chat. We track which message IDs we've already shown
    // so a full state sync (which carries chat history) doesn't duplicate
    // anything already received via the lightweight "chat" event.
    let renderedChatIds = new Set();
    let chatUnread = 0;
    function escapeChat(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function formatChatTime(ts) {
      try {
        const d = new Date(ts);
        const h = d.getHours();
        const m = d.getMinutes().toString().padStart(2, "0");
        const ap = h >= 12 ? "PM" : "AM";
        const h12 = ((h + 11) % 12) + 1;
        return h12 + ":" + m + " " + ap;
      } catch (_) { return ""; }
    }
    function renderChatMessage(m) {
      if (!m || renderedChatIds.has(m.id)) return;
      renderedChatIds.add(m.id);
      const log = document.getElementById("chatLog");
      if (!log) return;
      const empty = log.querySelector(".chat-empty");
      if (empty) empty.remove();

      const tag = m.isHost ? "HOST" : m.isCap ? "CAPT" : (m.team ? "TEAM " + m.team : "");
      const teamCls = m.team === "A" ? "chat-team-a" : m.team === "B" ? "chat-team-b" : "chat-team-none";
      const isSelf = state && state.me && m.fromId === state.me.id;
      const li = document.createElement("div");
      li.className = "chat-msg " + teamCls + (isSelf ? " is-self" : "");
      li.innerHTML =
        '<div class="chat-meta">' +
          '<span class="chat-name">' + escapeChat(m.fromName) + '</span>' +
          (tag ? '<span class="chat-tag">' + escapeChat(tag) + '</span>' : "") +
          '<span class="chat-time">' + escapeChat(formatChatTime(m.ts)) + '</span>' +
        '</div>' +
        '<div class="chat-text">' + escapeChat(m.text) + '</div>';
      log.appendChild(li);
      log.scrollTop = log.scrollHeight;

      const dock = document.getElementById("chatDock");
      if (dock && dock.classList.contains("collapsed") && !isSelf) {
        chatUnread += 1;
        const badge = document.getElementById("chatUnread");
        if (badge) {
          badge.hidden = false;
          badge.textContent = String(chatUnread > 99 ? "99+" : chatUnread);
        }
      }
    }
    function rebuildChatFromState(s) {
      // Called after (re)connect or state replacement. Drops the local view
      // and re-renders so out-of-order arrivals don't leave gaps.
      const log = document.getElementById("chatLog");
      if (!log) return;
      const list = Array.isArray(s && s.chat) ? s.chat : [];
      // Only rebuild if we don't already know about every server message —
      // this avoids visual flicker on every state push.
      const unknown = list.filter((m) => !renderedChatIds.has(m.id));
      if (!unknown.length) return;
      // First time we see chat — clear placeholder and play the entire history
      if (renderedChatIds.size === 0) {
        log.innerHTML = "";
        list.forEach(renderChatMessage);
      } else {
        unknown.forEach(renderChatMessage);
      }
    }

    socket.on("chat", function (msg) { renderChatMessage(msg); });

    // Wire dock toggle, form submit, and basic UX
    (function wireChat() {
      const dock = document.getElementById("chatDock");
      const toggle = document.getElementById("chatToggle");
      const body = document.getElementById("chatBody");
      const form = document.getElementById("chatForm");
      const input = document.getElementById("chatInput");
      const badge = document.getElementById("chatUnread");
      if (!dock || !toggle || !body || !form || !input) return;

      function expand() {
        dock.classList.remove("collapsed");
        dock.classList.add("open");
        body.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        chatUnread = 0;
        if (badge) { badge.hidden = true; badge.textContent = "0"; }
        setTimeout(() => input.focus(), 50);
        const log = document.getElementById("chatLog");
        if (log) log.scrollTop = log.scrollHeight;
      }
      function collapse() {
        dock.classList.add("collapsed");
        dock.classList.remove("open");
        body.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }
      toggle.addEventListener("click", function () {
        if (dock.classList.contains("collapsed")) expand(); else collapse();
      });

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        if (!myCode) return;
        if (!socket.connected) return;
        socket.emit("chatMessage", { code: myCode, text }, function (res) {
          if (res && !res.ok && res.error) {
            // Render an inline system-style notice in the log AND a toast
            const log = document.getElementById("chatLog");
            if (log) {
              const err = document.createElement("div");
              err.className = "chat-msg chat-system";
              err.textContent = "Couldn't send: " + res.error;
              log.appendChild(err);
              log.scrollTop = log.scrollHeight;
            }
            toast.error("Chat: " + res.error);
            return;
          }
          input.value = "";
        });
      });
    })();

    // ─── Buttons ───────────────────────────────────────────
    $("btnCreate").addEventListener("click", function () {
      showError(gateError, "");
      if (!socket.connected) {
        showError(gateError, "Not connected yet. Wait a moment or refresh the page.");
        return;
      }
      const nickname = $("nickname").value.trim() || "Host";
      setStoredNickname(nickname);
      socket.emit("createSession", { nickname }, function (res) {
        if (!res || !res.ok) {
          showError(gateError, (res && res.error) || "Could not create");
          return;
        }
        if (res.token) setStoredToken(res.code, res.token);
        syncAddressBarToRoomCode(res.code);
      });
    });

    $("btnJoin").addEventListener("click", function () {
      showError(gateError, "");
      if (!socket.connected) {
        showError(gateError, "Not connected yet. Wait a moment or refresh.");
        return;
      }
      const joinInput = $("joinCode");
      if (!joinInput) return;
      const code = joinInput.value.trim().toUpperCase();
      const nickname = $("nickname").value.trim() || "Player";
      if (!code) { showError(gateError, "Enter a session code"); return; }
      setStoredNickname(nickname);

      const storedToken = getStoredToken(code);
      let answered = false;
      const timer = setTimeout(function () {
        if (answered) return; answered = true;
        showError(gateError, "No reply from the server. Try again in a moment.");
      }, 15000);
      socket.emit("joinSession", { code, nickname, token: storedToken || undefined }, function (res) {
        if (answered) return; answered = true; clearTimeout(timer);
        if (!res || !res.ok) {
          const err = (res && res.error) || "";
          if (err === "Session not found") clearStoredToken(code);
          showError(gateError, err === "Session not found" ? notFoundMsg : err || "Could not join");
          return;
        }
        if (res.token) setStoredToken(res.code, res.token);
        clearUrlJoinRejected(code);
        syncAddressBarToRoomCode(res.code);
      });
    });

    $("btnCapA").addEventListener("click", function () {
      if (!myCode) return;
      socket.emit("claimCaptain", { code: myCode, team: "A" }, ackRoom);
    });
    $("btnCapB").addEventListener("click", function () {
      if (!myCode) return;
      socket.emit("claimCaptain", { code: myCode, team: "B" }, ackRoom);
    });

    $("btnJoinA").addEventListener("click", function () {
      if (!myCode) return;
      socket.emit("setTeam", { code: myCode, team: "A" }, ackRoom);
    });
    $("btnJoinB").addEventListener("click", function () {
      if (!myCode) return;
      socket.emit("setTeam", { code: myCode, team: "B" }, ackRoom);
    });

    $("btnStart").addEventListener("click", function () {
      if (!myCode) return;
      socket.emit("startDraft", { code: myCode }, ackRoom);
    });

    // Team names
    const btnSaveTeamNames = $("btnSaveTeamNames");
    if (btnSaveTeamNames) {
      btnSaveTeamNames.addEventListener("click", function () {
        if (!myCode) return;
        const a = ($("tnA") && $("tnA").value || "").trim();
        const b = ($("tnB") && $("tnB").value || "").trim();
        socket.emit("setTeamNames", { code: myCode, A: a, B: b }, function (res) {
          if (res && res.ok) {
            btnSaveTeamNames.textContent = "Saved ✓";
            setTimeout(() => { btnSaveTeamNames.textContent = "Save names"; }, 1500);
            toast.success("Team names saved");
          } else if (res && res.error) {
            showError($("roomError"), res.error);
            toast.error(res.error);
          }
        });
      });
    }

    // Side pick
    const btnSideA = $("btnSideAttack");
    const btnSideD = $("btnSideDefense");
    function emitPickSide(side) {
      if (!myCode) return;
      socket.emit("pickSide", { code: myCode, side }, ackRoom);
    }
    if (btnSideA) btnSideA.addEventListener("click", () => emitPickSide("attack"));
    if (btnSideD) btnSideD.addEventListener("click", () => emitPickSide("defense"));

    $("btnLeave").addEventListener("click", function () {
      // Hard-leave: tell the server to release our seat immediately (no
      // reconnect grace), wipe the stored token so a future visit starts
      // fresh, then drop back to the landing-style join screen.
      const codeBeforeLeave = (state && state.code) || myCode || "";
      if (codeBeforeLeave) {
        try { socket.emit("leaveSession", { code: codeBeforeLeave }, function () {}); } catch (_) {}
        clearStoredToken(codeBeforeLeave);
      }
      state = null;
      prevSnap = null;
      renderedChatIds = new Set();
      chatUnread = 0;
      const chatLog = document.getElementById("chatLog");
      if (chatLog) chatLog.innerHTML = '<p class="chat-empty">Say hi to your teammates — messages stay in this session only.</p>';
      const chatBadge = document.getElementById("chatUnread");
      if (chatBadge) { chatBadge.hidden = true; chatBadge.textContent = "0"; }
      stripStaleCodeFromUrl();
      const jc = $("joinCode");
      if (jc) jc.value = "";
      render();
      socket.disconnect();
      setTimeout(() => socket.connect(), 100);
    });

    $("btnCopy").addEventListener("click", async function () {
      const url = location.origin + location.pathname + searchFromCodeAndServer(myCode || "", serverBase);
      try {
        await navigator.clipboard.writeText(url);
        $("btnCopy").textContent = "Copied";
        setTimeout(() => { $("btnCopy").textContent = "Copy link"; }, 2000);
      } catch (_) {
        prompt("Copy this link:", url);
      }
    });

    // ─── Modal: close handlers ────────────────────────────
    (function wireModal() {
      if (!completeModal) return;

      $("modalClose").addEventListener("click", function () { closeCompleteModal(); });
      $("modalDoneBtn").addEventListener("click", function () { closeCompleteModal(); });

      const overlay = completeModal.querySelector("[data-modal-dismiss]");
      if (overlay) overlay.addEventListener("click", function () { closeCompleteModal(); });

      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !completeModal.hidden) closeCompleteModal();
      });

      $("modalCopyBtn").addEventListener("click", async function () {
        if (!state) return;
        const summary = gatherDraftSummary();
        const link = location.origin + location.pathname + searchFromCodeAndServer(state.code || "", serverBase);
        const text =
          "DRAFTIX — Draft complete\n" +
          "Session: " + (state.code || "—") + "\n" +
          summary.teamA + " vs " + summary.teamB + "\n" +
          "Captains: " + summary.capA + " vs " + summary.capB + "\n" +
          "Map: " + summary.mapName + "\n" +
          (summary.sideLabel ? "Starting side: " + summary.sideLabel + " (" + summary.sideTeam + ")\n" : "") +
          "Banned agents: " + (summary.bannedNames.length ? summary.bannedNames.join(", ") : "—") + "\n" +
          link;
        const btn = $("modalCopyBtn");
        const original = btn.textContent;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = "Copied!";
          setTimeout(function () { btn.textContent = original; }, 1800);
          toast.success("Draft result copied to clipboard");
        } catch (_) {
          prompt("Copy this result:", text);
          toast.warn("Clipboard blocked — copy from the dialog");
        }
      });

      const dlBtn = $("modalDownloadBtn");
      if (dlBtn) {
        dlBtn.addEventListener("click", async function () {
          if (!state) return;
          const original = dlBtn.textContent;
          dlBtn.disabled = true;
          dlBtn.textContent = "Rendering…";
          try {
            await downloadDraftImage(gatherDraftSummary());
            dlBtn.textContent = "Downloaded ✓";
            toast.success("Image downloaded");
          } catch (e) {
            dlBtn.textContent = "Image failed";
            console.error("Image export failed:", e);
            toast.error("Image export failed — check console");
          } finally {
            setTimeout(() => { dlBtn.disabled = false; dlBtn.textContent = original; }, 2000);
          }
        });
      }
    })();

    // ─── Build the summary used by Copy + Download ────────
    function gatherDraftSummary() {
      const maps = (state.catalog && state.catalog.maps) || [];
      const agents = (state.catalog && state.catalog.agents) || [];
      const pickedMap =
        maps.find((m) => state.selectedMap && m.uuid === state.selectedMap.uuid) ||
        state.selectedMap || {};
      const bannedAgents = (state.agentBans || [])
        .map((id) => agents.find((a) => a.uuid === id))
        .filter(Boolean);
      const side = state.selectedSide || null;
      const sidePicker = state.sidePickerTeam || null;
      return {
        code: state.code || "—",
        teamA: teamName(state, "A"),
        teamB: teamName(state, "B"),
        capA: findCaptain("A") || "—",
        capB: findCaptain("B") || "—",
        mapName: pickedMap.name || "—",
        mapImage: pickedMap.image || null,
        side,
        sideTeam: sidePicker ? teamName(state, sidePicker) : "",
        sideLabel: side ? (side === "attack" ? "Attack" : "Defense") : "",
        bannedAgents,                              // [{ uuid, name, icon, image }]
        bannedNames: bannedAgents.map((a) => a.name),
      };
    }

    // ─── Canvas: render a shareable draft result image ───
    async function downloadDraftImage(summary) {
      const W = 1080, H = 1440;
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");

      // Wait for the page's web fonts to load before drawing. We explicitly
      // pre-load the weights/sizes we actually use so the canvas doesn't fall
      // back to a system serif mid-render.
      try {
        await Promise.all([
          document.fonts.load('900 64px "Saira Condensed"'),
          document.fonts.load('800 84px "Saira Condensed"'),
          document.fonts.load('700 22px "Rajdhani"'),
          document.fonts.load('600 22px "Rajdhani"'),
          document.fonts.ready,
        ]);
      } catch (_) {}

      // Proxy CDN images through our server so the canvas stays untainted.
      // IMPORTANT: when the page is served from a different origin (e.g. Live
      // Server on :5500 while the API runs on :3001), we must prefix the proxy
      // URL with serverBase so the request reaches the API host.
      const PROXY_PREFIX = (serverBase || "") + "/img?url=";
      const proxied = (url) => (url ? PROXY_PREFIX + encodeURIComponent(url) : null);

      function loadImg(url) {
        if (!url) return Promise.resolve(null);
        return new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = url;
        });
      }

      // Background
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#060912");
      bg.addColorStop(1, "#0a1020");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      // Subtle red glow top-right + blue bottom-left
      const glow1 = ctx.createRadialGradient(W * 0.85, -80, 30, W * 0.85, -80, 700);
      glow1.addColorStop(0, "rgba(255,70,85,0.30)"); glow1.addColorStop(1, "rgba(255,70,85,0)");
      ctx.fillStyle = glow1; ctx.fillRect(0, 0, W, H);
      const glow2 = ctx.createRadialGradient(-80, H + 80, 30, -80, H + 80, 700);
      glow2.addColorStop(0, "rgba(74,141,255,0.22)"); glow2.addColorStop(1, "rgba(74,141,255,0)");
      ctx.fillStyle = glow2; ctx.fillRect(0, 0, W, H);

      const PAD = 64;
      // Accent top bar
      ctx.fillStyle = "#FF4655"; ctx.fillRect(PAD, PAD, W - PAD * 2, 4);

      // Wordmark "DRAFTIX"
      ctx.fillStyle = "#ffffff";
      ctx.font = '900 64px "Saira Condensed", "Rajdhani", sans-serif';
      ctx.textBaseline = "top";
      ctx.fillText("DRAFT", PAD, PAD + 24);
      const draftWidth = ctx.measureText("DRAFT").width;
      ctx.fillStyle = "#FF4655";
      ctx.fillText("IX", PAD + draftWidth, PAD + 24);

      // Eyebrow "DRAFT COMPLETE"
      ctx.fillStyle = "#FF4655";
      ctx.font = '700 26px "Rajdhani", sans-serif';
      const eyebrow = "DRAFT COMPLETE";
      ctx.fillText(eyebrow, PAD, PAD + 100);

      // Big title (map + side)
      ctx.fillStyle = "#ffffff";
      ctx.font = '800 84px "Saira Condensed", "Rajdhani", sans-serif';
      ctx.fillText((summary.mapName || "—").toUpperCase(), PAD, PAD + 140);

      // Map splash
      const mapY = PAD + 270;
      const mapH = 460;
      ctx.fillStyle = "#0e1626";
      ctx.fillRect(PAD, mapY, W - PAD * 2, mapH);
      const mapImg = await loadImg(proxied(summary.mapImage));
      if (mapImg) {
        // cover-fit
        const iw = mapImg.width, ih = mapImg.height;
        const targetW = W - PAD * 2, targetH = mapH;
        const ratio = Math.max(targetW / iw, targetH / ih);
        const dw = iw * ratio, dh = ih * ratio;
        const dx = PAD + (targetW - dw) / 2;
        const dy = mapY + (targetH - dh) / 2;
        ctx.drawImage(mapImg, dx, dy, dw, dh);
        const grad = ctx.createLinearGradient(0, mapY, 0, mapY + mapH);
        grad.addColorStop(0, "rgba(0,0,0,0.2)");
        grad.addColorStop(1, "rgba(0,0,0,0.85)");
        ctx.fillStyle = grad; ctx.fillRect(PAD, mapY, W - PAD * 2, mapH);
      }
      // border
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD + 0.5, mapY + 0.5, W - PAD * 2 - 1, mapH - 1);

      // Map name overlay + side tag
      ctx.fillStyle = "#ffffff";
      ctx.font = '800 56px "Saira Condensed", "Rajdhani", sans-serif';
      ctx.fillText((summary.mapName || "").toUpperCase(), PAD + 24, mapY + mapH - 80);

      if (summary.sideLabel) {
        const sideTxt = summary.sideLabel.toUpperCase() + " · " + summary.sideTeam.toUpperCase();
        ctx.font = '700 22px "Rajdhani", sans-serif';
        const tw = ctx.measureText(sideTxt).width + 28;
        const sideX = PAD + 24, sideY = mapY + 24;
        ctx.fillStyle = summary.side === "attack" ? "#FF4655" : "#4a8dff";
        roundRect(ctx, sideX, sideY, tw, 38, 4);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(sideTxt, sideX + 14, sideY + 8);
      }

      // "BANNED AGENTS" section header
      const agY = mapY + mapH + 50;
      ctx.fillStyle = "#7e90b2";
      ctx.font = '700 22px "Rajdhani", sans-serif';
      ctx.fillText("BANNED AGENTS", PAD, agY);

      // Agent row (up to 6 icons)
      const agentImgs = await Promise.all(
        summary.bannedAgents.slice(0, 6).map((a) => loadImg(proxied(a.icon || a.image)))
      );
      const cellSize = 130, gap = 18;
      const startY = agY + 40;
      summary.bannedAgents.slice(0, 6).forEach((a, i) => {
        const x = PAD + i * (cellSize + gap);
        const y = startY;
        ctx.fillStyle = "#131e33";
        roundRect(ctx, x, y, cellSize, cellSize, 8);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,70,85,0.55)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const img = agentImgs[i];
        if (img) {
          ctx.save();
          ctx.beginPath();
          roundRect(ctx, x + 4, y + 4, cellSize - 8, cellSize - 8, 6);
          ctx.clip();
          ctx.drawImage(img, x + 4, y + 4, cellSize - 8, cellSize - 8);
          ctx.restore();
        }
        ctx.fillStyle = "#ffffff";
        ctx.font = '600 18px "Rajdhani", sans-serif';
        const name = (a.name || "").toUpperCase();
        const nameW = ctx.measureText(name).width;
        ctx.fillText(name, x + (cellSize - nameW) / 2, y + cellSize + 12);
      });

      // Teams + captains
      const teamY = startY + cellSize + 90;
      ctx.font = '700 22px "Rajdhani", sans-serif';
      ctx.fillStyle = "#7e90b2";
      ctx.fillText("TEAM A CAPTAIN", PAD, teamY);
      ctx.fillText("TEAM B CAPTAIN", W - PAD - ctx.measureText("TEAM B CAPTAIN").width, teamY);
      ctx.font = '800 40px "Saira Condensed", "Rajdhani", sans-serif';
      ctx.fillStyle = "#FF4655";
      ctx.fillText(summary.teamA.toUpperCase(), PAD, teamY + 34);
      const tBText = summary.teamB.toUpperCase();
      ctx.fillStyle = "#4a8dff";
      ctx.fillText(tBText, W - PAD - ctx.measureText(tBText).width, teamY + 34);
      ctx.font = '600 22px "Rajdhani", sans-serif';
      ctx.fillStyle = "#e7eefb";
      ctx.fillText(summary.capA, PAD, teamY + 88);
      ctx.fillText(summary.capB, W - PAD - ctx.measureText(summary.capB).width, teamY + 88);

      // "VS"
      ctx.fillStyle = "#475873";
      ctx.font = '800 52px "Saira Condensed", "Rajdhani", sans-serif';
      const vsTxt = "VS";
      ctx.fillText(vsTxt, (W - ctx.measureText(vsTxt).width) / 2, teamY + 18);

      // Bottom footer
      const fY = H - PAD - 80;
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(PAD, fY, W - PAD * 2, 1);
      ctx.fillStyle = "#7e90b2";
      ctx.font = '700 20px "Rajdhani", sans-serif';
      ctx.fillText("SESSION CODE", PAD, fY + 18);
      ctx.fillStyle = "#ffffff";
      ctx.font = '800 32px "Share Tech Mono", monospace';
      ctx.fillText(summary.code, PAD, fY + 42);
      ctx.fillStyle = "#FF4655";
      ctx.font = '700 22px "Rajdhani", sans-serif';
      const dom = "draftix.tech";
      ctx.fillText(dom, W - PAD - ctx.measureText(dom).width, fY + 42);

      // Trigger download
      await new Promise((resolve) => {
        canvas.toBlob((blob) => {
          if (!blob) return resolve();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "draftix-" + summary.code + ".png";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          resolve();
        }, "image/png", 0.95);
      });
    }
    function roundRect(ctx, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y,     x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x,     y + h, r);
      ctx.arcTo(x,     y + h, x,     y,     r);
      ctx.arcTo(x,     y,     x + w, y,     r);
      ctx.closePath();
    }

    // Restore nickname across refreshes
    {
      const nickEl = $("nickname");
      const saved = getStoredNickname();
      if (nickEl && saved && !nickEl.value) nickEl.value = saved;
    }

    // Auto-fill join field from URL + auto-resume if we have a token for it
    let pendingResume = null;
    {
      const params = new URLSearchParams(location.search);
      const fromLink = params.get("code");
      if (fromLink) {
        const c = fromLink.trim().toUpperCase();
        if (rejectedUrlCodes.has(c)) {
          stripStaleCodeFromUrl();
        } else {
          $("joinCode").value = c;
          const tok = getStoredToken(c);
          if (tok) pendingResume = { code: c, token: tok };
        }
      }
    }

    socket.on("connect", function () {
      setConnState("online");
      hideServerBanner();
      _wasOnline = true;
      _reconnectingToastShown = false;
      const nickEl = $("nickname");
      const nickname = (nickEl && nickEl.value.trim()) || getStoredNickname() || "Player";

      // 1) Mid-session reconnect (socket dropped, came back) → resume with token
      if (state && state.code && !state.closed) {
        const tok = getStoredToken(state.code);
        socket.emit("joinSession", { code: state.code, nickname, token: tok || undefined }, function (res) {
          if (res && res.ok) {
            if (res.token) setStoredToken(res.code, res.token);
          } else if (res && res.error === "Session not found") {
            clearStoredToken(state.code);
          }
        });
        return;
      }

      // 2) Initial page load with ?code=X and a stored token → auto-resume
      if (pendingResume && pendingResume.code) {
        const { code, token } = pendingResume;
        pendingResume = null;
        console.debug("[draftix] auto-resume attempt", code, "tok=", token ? token.slice(0, 8) + "…" : null);
        socket.emit("joinSession", { code, nickname, token }, function (res) {
          console.debug("[draftix] auto-resume response:", res);
          if (res && res.ok) {
            if (res.token) setStoredToken(res.code, res.token);
            clearUrlJoinRejected(code);
            syncAddressBarToRoomCode(res.code);
            if (res.resumed) toast.success("Welcome back — seat restored", { duration: 2000 });
            else toast.warn("Joined as spectator — your previous seat was already released.", { duration: 3500 });
          } else if (res && res.error === "Session not found") {
            clearStoredToken(code);
          }
        });
      } else if (location.search.includes("code=")) {
        console.debug("[draftix] page loaded with ?code= but no stored token — skip auto-resume");
      }
    });

    // Sound toggle button — wire up after the DOM is in.
    (function wireSoundToggle() {
      const btn = document.getElementById("btnSoundToggle");
      if (!btn) return;
      btn.addEventListener("click", function () {
        sound.toggle();
        toast.info(sound.enabled ? "Sound on" : "Sound muted", { duration: 1800 });
      });
      sound.applyToggleUi();
    })();
  })().catch(function (e) {
    console.error(e);
    if (gateError) {
      gateError.hidden = false;
      gateError.textContent = "Couldn't connect to the service. Try again in a moment.";
    }
  });
})();
