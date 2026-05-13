// Integration test: host draft operations (undo, rematch, return to lobby).
// Server must be running on localhost:3000.

const { io } = require("socket.io-client");
const URL = process.env.TEST_SERVER_URL || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSock(label) {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  s._label = label;
  s._state = null;
  s.on("state", (st) => { s._state = st; });
  return s;
}

function whenConnected(s) { return new Promise((r) => s.once("connect", r)); }
function emit(s, ev, p) { return new Promise((r) => s.emit(ev, p, r)); }
async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log("  ✓", label);
  else { failures++; console.error("  ✗", label, detail ? "→ " + detail : ""); }
}

function turnSocket(state, capA, capB) {
  return state.currentTurn === "A" ? capA : capB;
}

function nextOpenMap(state) {
  const banned = new Set(state.mapBans || []);
  return state.catalog.maps.find((m) => !banned.has(m.uuid));
}

(async () => {
  console.log("\n[1] Build lobby with host and two captains\n");
  const host = makeSock("host");
  await whenConnected(host);
  const create = await emit(host, "createSession", { nickname: "Host" });
  check("host created session", create && create.ok && create.code, JSON.stringify(create));
  const code = create.code;

  const capA = makeSock("capA");
  const capB = makeSock("capB");
  await Promise.all([whenConnected(capA), whenConnected(capB)]);
  check("capA joined", (await emit(capA, "joinSession", { code, nickname: "Alpha" })).ok);
  check("capB joined", (await emit(capB, "joinSession", { code, nickname: "Bravo" })).ok);
  check("capA claimed A", (await emit(capA, "claimCaptain", { code, team: "A" })).ok);
  check("capB claimed B", (await emit(capB, "claimCaptain", { code, team: "B" })).ok);
  await waitFor(() => host._state && host._state.captainNames.A === "Alpha" && host._state.captainNames.B === "Bravo");

  console.log("\n[2] Use a map-only ruleset, then undo the first ban\n");
  const settings = await emit(host, "setGameSettings", {
    code,
    draftPreset: "custom",
    agentBanCount: 0,
    turnTimeoutMs: 30000,
    autoBanEnabled: true,
    sidePickEnabled: false,
  });
  check("settings saved", settings.ok, JSON.stringify(settings));
  check("draft started", (await emit(host, "startDraft", { code })).ok);
  await waitFor(() => host._state && host._state.phase === "map_ban");

  let actor = turnSocket(host._state, capA, capB);
  let map = nextOpenMap(host._state);
  check("first map ban ok", (await emit(actor, "banMap", { code, uuid: map.uuid })).ok);
  await waitFor(() => host._state && host._state.mapBans.length === 1);
  check("host can undo after ban", host._state.ops && host._state.ops.canUndo === true);
  check("undo ok", (await emit(host, "undoDraftAction", { code })).ok);
  await waitFor(() => host._state && host._state.phase === "map_ban" && host._state.mapBans.length === 0);
  check("map ban rolled back", host._state.mapBans.length === 0);

  console.log("\n[3] Complete map veto, then start a rematch\n");
  while (host._state && host._state.phase === "map_ban") {
    actor = turnSocket(host._state, capA, capB);
    map = nextOpenMap(host._state);
    const res = await emit(actor, "banMap", { code, uuid: map.uuid });
    if (!res.ok) {
      check("map ban during completion", false, JSON.stringify(res));
      break;
    }
    await waitFor(() => host._state && (host._state.phase !== "map_ban" || host._state.mapBans.includes(map.uuid)));
  }
  await waitFor(() => host._state && host._state.phase === "done");
  check("draft completed", host._state.phase === "done");
  check("host can rematch", host._state.ops && host._state.ops.canRematch === true);
  check("rematch ok", (await emit(host, "rematchDraft", { code })).ok);
  await waitFor(() => host._state && host._state.phase === "map_ban" && host._state.mapBans.length === 0);
  check("rematch reset draft bans", host._state.phase === "map_ban" && host._state.mapBans.length === 0);

  console.log("\n[4] Return to lobby without losing captains\n");
  check("return to lobby ok", (await emit(host, "resetDraftToLobby", { code })).ok);
  await waitFor(() => host._state && host._state.phase === "lobby");
  check("phase is lobby", host._state.phase === "lobby");
  check("captains preserved", host._state.captainNames.A === "Alpha" && host._state.captainNames.B === "Bravo");

  for (const s of [host, capA, capB]) s.disconnect();
  await sleep(150);

  console.log(failures === 0 ? "\n✓✓✓ All draft operation checks passed" : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("Crash:", e); process.exit(2); });
