/**
 * DRAFTIX /status.html — polls /healthz (CSP-safe external script).
 */
(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };

  function fmtUptime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var d = Math.floor(sec / 86400);
    sec -= d * 86400;
    var h = Math.floor(sec / 3600);
    sec -= h * 3600;
    var m = Math.floor(sec / 60);
    sec -= m * 60;
    if (d) return d + "d " + h + "h " + m + "m";
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + sec + "s";
    return sec + "s";
  }
  function fmtNumber(n) {
    n = Number(n);
    if (!isFinite(n)) return "—";
    return n.toLocaleString("en-US");
  }
  function fmtTime(ms) {
    ms = Number(ms);
    if (!isFinite(ms)) return "—";
    var s = Math.round(ms / 1000);
    return s + "s";
  }
  function fmtClock(d) {
    d = d || new Date();
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  var failures = 0;

  function setOffline(msg) {
    $("pulse").className = "pulse offline";
    $("title").textContent = "Server unreachable";
    $("kStatus").textContent = "OFFLINE";
    $("kStatus").style.color = "#ff6a78";
    $("kStatusSub").textContent = msg || "No response from /healthz";
    var eb = $("errorBox");
    eb.hidden = false;
    eb.textContent = msg || "Cannot reach /healthz. The server may be restarting.";
  }

  function applyData(data) {
    $("errorBox").hidden = true;
    $("pulse").className = "pulse online";
    $("title").textContent = "All systems operational";
    $("kStatus").textContent = data.ok ? "ONLINE" : "DEGRADED";
    $("kStatus").style.color = data.ok ? "#4ade80" : "#facc15";
    $("kStatusSub").textContent = data.ok
      ? "Accepting traffic"
      : "Server responded but reported issues";
    $("kVersion").textContent = data.version ? "v" + data.version : "—";
    $("kUptime").textContent = fmtUptime(data.uptimeSec);
    $("kSessions").textContent = fmtNumber(data.sessions);
    $("kCodes").textContent = fmtNumber(data.codesIssued);
    var cat = data.catalog || {};
    $("kCatalog").textContent = (cat.maps || 0) + " maps · " + (cat.agents || 0) + " agents";
    $("kTurn").textContent = fmtTime(data.turnTimeoutMs) + " per ban";
    $("lastUpdate").textContent = fmtClock();
  }

  function tick() {
    fetch("/healthz", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        failures = 0;
        applyData(data);
      })
      .catch(function (e) {
        failures++;
        if (failures <= 1) setOffline(e.message);
      });
  }

  tick();
  setInterval(tick, 5000);
})();
