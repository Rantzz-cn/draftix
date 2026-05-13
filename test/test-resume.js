// Integration test: token-based seat resume.
// Continuously tracks the latest state for each socket (since socket.io
// emits state on every broadcast, the "current" state is what matters).

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
async function waitFor(predicate, timeoutMs = 2000) {
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

(async () => {
  console.log("\n[1] Host creates a session\n");
  const host = makeSock("host");
  await whenConnected(host);
  const create = await emit(host, "createSession", { nickname: "HostBoss" });
  check("createSession returned token", !!create.token, "got: " + JSON.stringify(create));
  const code = create.code, hostTok = create.token;
  console.log("    code =", code, "hostTok =", hostTok.slice(0, 10) + "…");

  console.log("\n[2] Captain joins and claims team A\n");
  const cap = makeSock("cap");
  await whenConnected(cap);
  const join1 = await emit(cap, "joinSession", { code, nickname: "Cappy" });
  check("captain join returned token", !!join1.token);
  const capTok = join1.token;
  console.log("    capTok =", capTok.slice(0, 10) + "…");
  const claim = await emit(cap, "claimCaptain", { code, team: "A" });
  check("claimCaptain ok", claim.ok, JSON.stringify(claim));
  await waitFor(() => host._state && host._state.captainNames && host._state.captainNames.A === "Cappy", 1500);
  check("host sees Cappy as captain A", host._state && host._state.captainNames && host._state.captainNames.A === "Cappy",
        "captainNames=" + JSON.stringify(host._state && host._state.captainNames));

  console.log("\n[3] Captain refreshes (new socket, same token)\n");
  cap.disconnect();
  await sleep(150);
  const cap2 = makeSock("cap2");
  await whenConnected(cap2);
  const resume = await emit(cap2, "joinSession", { code, nickname: "Cappy", token: capTok });
  check("resume join ok", resume.ok, JSON.stringify(resume));
  check("server flagged resumed:true", resume.resumed === true);
  await waitFor(() => cap2._state && cap2._state.me, 1500);
  check("resumed socket sees isCaptain=true", cap2._state && cap2._state.me && cap2._state.me.isCaptain === true,
        "me=" + JSON.stringify(cap2._state && cap2._state.me));
  check("resumed socket sees myTeam='A'", cap2._state && cap2._state.me && cap2._state.me.myTeam === "A",
        "me=" + JSON.stringify(cap2._state && cap2._state.me));
  await waitFor(() => host._state && host._state.captainNames && host._state.captainNames.A === "Cappy", 1500);
  check("host still sees Cappy as captain A after refresh", host._state.captainNames.A === "Cappy");

  console.log("\n[4] Host refreshes\n");
  host.disconnect();
  await sleep(150);
  const host2 = makeSock("host2");
  await whenConnected(host2);
  const hostResume = await emit(host2, "joinSession", { code, nickname: "HostBoss", token: hostTok });
  check("host resume ok", hostResume.ok && hostResume.resumed === true, JSON.stringify(hostResume));
  await waitFor(() => host2._state && host2._state.me, 1500);
  check("resumed host sees isHost=true", host2._state.me && host2._state.me.isHost === true);

  console.log("\n[5] Stranger joins (no token) — should NOT inherit any seat\n");
  const stranger = makeSock("stranger");
  await whenConnected(stranger);
  const sj = await emit(stranger, "joinSession", { code, nickname: "Rando" });
  check("stranger join ok", sj.ok);
  check("stranger NOT marked resumed", sj.resumed !== true);
  check("stranger got a fresh token", !!sj.token && sj.token !== capTok && sj.token !== hostTok);
  await waitFor(() => stranger._state && stranger._state.me, 1500);
  check("stranger isCaptain=false", !stranger._state.me.isCaptain);
  check("stranger isHost=false", !stranger._state.me.isHost);

  console.log("\n[6] Stale token (wrong session) is ignored, falls back to fresh join\n");
  const liar = makeSock("liar");
  await whenConnected(liar);
  const fakeTok = "x".repeat(22);
  const lj = await emit(liar, "joinSession", { code, nickname: "Liar", token: fakeTok });
  check("stale-token join still ok", lj.ok);
  check("stale-token NOT marked resumed", lj.resumed !== true);
  check("stale-token issued a fresh new token", !!lj.token && lj.token !== fakeTok);

  console.log("\n[7] Explicit leaveSession releases the seat immediately\n");
  await emit(cap2, "leaveSession", { code });
  await waitFor(() => host2._state && host2._state.captainNames && host2._state.captainNames.A === null, 1500);
  check("captain A slot is empty after leaveSession", host2._state.captainNames.A === null,
        "captainNames=" + JSON.stringify(host2._state.captainNames));

  // Cleanup
  for (const s of [host2, stranger, liar]) s.disconnect();
  await sleep(200);

  console.log(failures === 0 ? "\n✓✓✓ All resume checks passed" : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("Crash:", e); process.exit(2); });
