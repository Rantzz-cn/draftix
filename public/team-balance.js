/**
 * DRAFTIX — lobby team balancer (client-only).
 * Internal MMR scale: Iron 1 = 0 … Radiant = 25 (split math only).
 */
(function () {
  "use strict";

  const RANK_OPTIONS = [
    ["Iron 1", 0],
    ["Iron 2", 1],
    ["Iron 3", 2],
    ["Bronze 1", 3],
    ["Bronze 2", 4],
    ["Bronze 3", 5],
    ["Silver 1", 6],
    ["Silver 2", 7],
    ["Silver 3", 8],
    ["Gold 1", 9],
    ["Gold 2", 10],
    ["Gold 3", 11],
    ["Unranked", 12],
    ["Platinum 1", 13],
    ["Platinum 2", 14],
    ["Platinum 3", 15],
    ["Diamond 1", 16],
    ["Diamond 2", 17],
    ["Diamond 3", 18],
    ["Ascendant 1", 19],
    ["Ascendant 2", 20],
    ["Ascendant 3", 21],
    ["Immortal 1", 22],
    ["Immortal 2", 23],
    ["Immortal 3", 24],
    ["Radiant", 25],
  ];

  const DEFAULT_MMR = 12;
  const MIN_ROWS = 5;

  const playersEl = document.getElementById("players");
  const hintEl = document.getElementById("modeHint");
  const splitHintEl = document.getElementById("splitHint");
  const modalBody = document.getElementById("modalBody");
  const dialogTitle = document.getElementById("pbDialogTitle");
  const dialog = document.getElementById("resultDialog");
  const rosterCountEl = document.getElementById("rosterCount");
  const modalCopy = document.getElementById("modalCopy");
  const tpl = document.getElementById("rowTpl");

  let lastPlainText = "";

  function getPerTeam() {
    const el = document.querySelector('input[name="pbMode"]:checked');
    const v = el ? Number(el.value) : 5;
    return v >= 2 && v <= 5 ? v : 5;
  }

  function getSplitStrategy() {
    const el = document.querySelector('input[name="pbSplit"]:checked');
    return el && el.value === "random" ? "random" : "rank";
  }

  function rankSelectHtml(selectedMmr) {
    let html = "";
    const sel = Number(selectedMmr);
    for (const [label, mmr] of RANK_OPTIONS) {
      html +=
        '<option value="' +
        mmr +
        '"' +
        (sel === mmr ? " selected" : "") +
        ">" +
        label +
        "</option>";
    }
    return html;
  }

  function addRow(name, mmr) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const nameIn = node.querySelector(".pb-name");
    const rankSel = node.querySelector(".pb-rank");
    nameIn.value = name || "";
    rankSel.innerHTML = rankSelectHtml(mmr !== undefined ? mmr : DEFAULT_MMR);
    nameIn.addEventListener("input", updateRosterCount);
    rankSel.addEventListener("change", updateRosterCount);
    node.querySelector(".pb-remove").addEventListener("click", () => {
      if (playersEl.children.length > MIN_ROWS) {
        node.remove();
        updateRosterCount();
      }
    });
    playersEl.appendChild(node);
    updateRosterCount();
  }

  function countNamedPlayers() {
    let n = 0;
    for (const row of playersEl.querySelectorAll(".pb-row")) {
      if (row.querySelector(".pb-name").value.trim()) n++;
    }
    return n;
  }

  function updateRosterCount() {
    const n = countNamedPlayers();
    rosterCountEl.textContent =
      n + " named player" + (n === 1 ? "" : "s") + " · " + playersEl.children.length + " rows";
  }

  function readPlayers() {
    const rows = playersEl.querySelectorAll(".pb-row");
    const list = [];
    for (const row of rows) {
      const name = row.querySelector(".pb-name").value.trim();
      const sel = row.querySelector(".pb-rank");
      const mmr = Number(sel.value);
      const label = sel.options[sel.selectedIndex]
        ? sel.options[sel.selectedIndex].text
        : "Unranked";
      if (!name) continue;
      list.push({
        name,
        mmr: Number.isFinite(mmr) ? mmr : DEFAULT_MMR,
        label,
      });
    }
    return list;
  }

  function sumMmr(team) {
    return team.reduce((s, p) => s + p.mmr, 0);
  }

  function teamStatsLine(team) {
    if (!team.length) return "—";
    const avg = sumMmr(team) / team.length;
    return "Avg " + avg.toFixed(1) + " · Total " + sumMmr(team);
  }

  function snakeSplit(sortedStarters) {
    const teamA = [];
    const teamB = [];
    for (let i = 0; i < sortedStarters.length; i++) {
      const p = sortedStarters[i];
      const m = i % 4;
      if (m === 0 || m === 3) teamA.push(p);
      else teamB.push(p);
    }
    return { teamA, teamB };
  }

  function fisherYates(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /**
   * @param {"rank"|"random"} strategy
   */
  function splitTeams(players, perTeam, strategy) {
    const cap = perTeam * 2;
    if (strategy === "random") {
      const shuffled = fisherYates([...players]);
      if (shuffled.length <= cap) {
        const nA = Math.ceil(shuffled.length / 2);
        return {
          teamA: shuffled.slice(0, nA),
          teamB: shuffled.slice(nA),
          bench: [],
          mode: "random",
        };
      }
      const starters = shuffled.slice(0, cap);
      const bench = shuffled.slice(cap);
      const sortedStarters = [...starters].sort((a, b) => b.mmr - a.mmr);
      return { ...snakeSplit(sortedStarters), bench, mode: "random" };
    }
    const sorted = [...players].sort((a, b) => b.mmr - a.mmr);
    let starters;
    let bench;
    if (sorted.length > cap) {
      starters = sorted.slice(0, cap);
      bench = sorted.slice(cap);
    } else {
      starters = sorted;
      bench = [];
    }
    return { ...snakeSplit(starters), bench, mode: "rank" };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildPlainText(result, perTeam) {
    const cap = perTeam * 2;
    const n = result.teamA.length + result.teamB.length + result.bench.length;
    const style = result.mode === "random" ? "Random mix" : "By rank";
    const lines = [
      "DRAFTIX team balancer — " + perTeam + "v" + perTeam + " (" + style + ")",
      "Players: " + n + (n > cap ? " (" + (n - cap) + " benched)" : ""),
      "",
      "Team A (" + result.teamA.length + ") — " + teamStatsLine(result.teamA),
    ];
    for (const p of result.teamA) lines.push("- " + p.name + " (" + p.label + ")");
    lines.push("", "Team B (" + result.teamB.length + ") — " + teamStatsLine(result.teamB));
    for (const p of result.teamB) lines.push("- " + p.name + " (" + p.label + ")");
    if (result.bench.length) {
      lines.push("", "Bench (" + result.bench.length + ")");
      for (const p of result.bench) lines.push("- " + p.name + " (" + p.label + ")");
    }
    return lines.join("\n");
  }

  function renderTeamsHtml(result, perTeam) {
    const cap = perTeam * 2;
    const n = result.teamA.length + result.teamB.length + result.bench.length;
    const diff = Math.abs(sumMmr(result.teamA) - sumMmr(result.teamB));
    const modeLine =
      result.mode === "random"
        ? "Random mix — shuffled who sits when overfull; starters snaked by rank. Full lobby = random halves."
        : "By rank — strongest field first, extras bench lowest rated, then snake draft.";

    let html =
      '<p class="pb-meta">' +
      n +
      " player" +
      (n === 1 ? "" : "s") +
      " · " +
      perTeam +
      "v" +
      perTeam +
      (n > cap ? " · " + (n - cap) + " benched" : n < cap ? " · short lobby" : " · full lobby") +
      " · ΔMMR " +
      diff +
      " · " +
      modeLine +
      "</p>";

    function card(team, title, cls) {
      let block =
        '<div class="pb-team ' +
        cls +
        '"><h3>' +
        title +
        " (" +
        team.length +
        ')</h3><p class="pb-team-mmr">' +
        teamStatsLine(team) +
        "</p><ul>";
      for (const p of team) {
        block +=
          "<li><strong>" +
          escapeHtml(p.name) +
          "</strong> · " +
          escapeHtml(p.label || "—") +
          "</li>";
      }
      block += "</ul></div>";
      return block;
    }

    html +=
      '<div class="pb-teams">' +
      card(result.teamA, "Team A", "pb-team-a") +
      card(result.teamB, "Team B", "pb-team-b") +
      "</div>";

    if (result.bench.length) {
      html +=
        '<div class="pb-bench"><h3>Bench (' +
        result.bench.length +
        ")</h3><p>Not in this " +
        perTeam +
        "v" +
        perTeam +
        " line-up. Rotate in next game or run again.</p><ul>" +
        result.bench
          .map(
            (p) =>
              "<li><strong>" +
              escapeHtml(p.name) +
              "</strong> · " +
              escapeHtml(p.label || "—") +
              "</li>"
          )
          .join("") +
        "</ul></div>";
    }
    return html;
  }

  function closeDialog() {
    if (dialog.open) dialog.close();
  }

  function openTeamsModal(result, perTeam) {
    dialogTitle.textContent = "Teams";
    modalBody.innerHTML = renderTeamsHtml(result, perTeam);
    lastPlainText = buildPlainText(result, perTeam);
    modalCopy.disabled = false;
    dialog.showModal();
    modalCopy.focus();
  }

  function openErrorModal(message) {
    dialogTitle.textContent = "Need more players";
    modalBody.innerHTML = '<p class="pb-warn">' + escapeHtml(message) + "</p>";
    lastPlainText = "";
    modalCopy.disabled = true;
    dialog.showModal();
    document.getElementById("modalClose").focus();
  }

  function updateHint() {
    const per = getPerTeam();
    const cap = per * 2;
    hintEl.textContent =
      "Full lobby for this mode is " +
      cap +
      " players. With more than " +
      cap +
      ", extras bench (see Split style). With fewer, team sizes can be uneven.";
  }

  function updateSplitHint() {
    splitHintEl.textContent =
      getSplitStrategy() === "random"
        ? "Random order picks who sits when the lobby is overfull; starters are then snaked by rank. If everyone fits one match, both sides are random halves."
        : "Players are ordered by rank; the lowest-rated extras bench when overfull, then starters are snaked for even totals.";
  }

  function copyResult(btn) {
    if (!lastPlainText || btn.disabled) return;
    const text = lastPlainText;
    function done(ok) {
      btn.classList.toggle("pb-copy--done", ok);
      const prev = btn.textContent;
      btn.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove("pb-copy--done");
      }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true)).catch(() => fallback());
    } else fallback();

    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        done(document.execCommand("copy"));
      } catch (_) {
        done(false);
      }
      document.body.removeChild(ta);
    }
  }

  document.getElementById("splitTeams").addEventListener("click", () => {
    const per = getPerTeam();
    const players = readPlayers();
    if (players.length < 2) {
      openErrorModal("Add at least two players with names in the roster.");
      return;
    }
    openTeamsModal(splitTeams(players, per, getSplitStrategy()), per);
  });

  document.getElementById("addPlayer").addEventListener("click", () => addRow("", DEFAULT_MMR));

  document.getElementById("clearRoster").addEventListener("click", () => {
    closeDialog();
    for (const row of playersEl.querySelectorAll(".pb-row")) {
      row.querySelector(".pb-name").value = "";
      const rankSel = row.querySelector(".pb-rank");
      rankSel.innerHTML = rankSelectHtml(DEFAULT_MMR);
    }
    lastPlainText = "";
    updateRosterCount();
  });

  document.getElementById("modalClose").addEventListener("click", closeDialog);
  document.getElementById("dialogX").addEventListener("click", closeDialog);
  modalCopy.addEventListener("click", () => copyResult(modalCopy));

  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeDialog();
  });

  for (const radio of document.querySelectorAll('input[name="pbMode"]')) {
    radio.addEventListener("change", updateHint);
  }
  for (const radio of document.querySelectorAll('input[name="pbSplit"]')) {
    radio.addEventListener("change", updateSplitHint);
  }

  for (let i = 0; i < MIN_ROWS; i++) addRow("", DEFAULT_MMR);
  updateHint();
  updateSplitHint();
})();
