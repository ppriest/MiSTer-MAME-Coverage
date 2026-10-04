/* MiSTer × MAME coverage — static client. Reads data/coverage.json, everything else runs here. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const fmt = n => n.toLocaleString("en-US");
  const pct = (a, b) => b ? (100 * a / b).toFixed(1) + "%" : "–";

  const S = { data: null, cores: {}, titles: [], shown: 0, PAGE: 250, dir: { t: 1, d: -1, c: 1 }, open: new Set() };

  // ---------- state in the URL hash ----------
  // Every control on the Titles, Drivers and Cores tabs, plus each tab's sort direction and the
  // open tab, so a view can be linked or restored. Only values that differ from the default are
  // written.
  const FILTER_IDS = ["f-q", "f-cov", "f-work", "f-cat", "f-y0", "f-y1", "f-m0y", "f-m0m", "f-m1y", "f-m1m", "f-genre", "f-manu", "f-drv", "f-dcov", "f-core", "f-rot", "f-sort"];
  const DRIVER_IDS = ["d-q", "d-cov", "d-genre", "d-sort"];
  const CORE_IDS = ["c-q", "c-src", "c-sort"];
  const ALL_IDS = [...FILTER_IDS, ...DRIVER_IDS, ...CORE_IDS];
  const DIRS = { dir: "t", ddir: "d", cdir: "c" };   // hash key -> S.dir key
  function resetControls() {
    ALL_IDS.forEach(id => { const el = $("#" + id); el.value = el.dataset.default ?? ""; });
    S.dir = { t: 1, d: -1, c: 1 };
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const id of ALL_IDS) if (p.has(id)) { const el = $("#" + id); if (el) el.value = p.get(id); }
    for (const [k, d] of Object.entries(DIRS)) if (p.has(k)) S.dir[d] = +p.get(k) || S.dir[d];
    if (p.has("tab")) showTab(p.get("tab"), false);
    $("#f-dir").textContent = S.dir.t > 0 ? "↑" : "↓"; $("#d-dir").textContent = S.dir.d > 0 ? "↑" : "↓"; $("#c-dir").textContent = S.dir.c > 0 ? "↑" : "↓";
  }
  function writeHash() {
    if (S.booting) return;
    const p = new URLSearchParams();
    for (const id of ALL_IDS) { const v = $("#" + id).value; if (v !== "" && v !== $("#" + id).dataset.default) p.set(id, v); }
    const defaults = { t: 1, d: -1, c: 1 };
    for (const [k, d] of Object.entries(DIRS)) if (S.dir[d] !== defaults[d]) p.set(k, S.dir[d]);
    const tab = $(".tabs [aria-selected=true]").dataset.tab;
    if (tab !== "titles") p.set("tab", tab);
    history.replaceState(null, "", "#" + p.toString());
  }

  // ---------- tabs ----------
  function showTab(name, update = true) {
    $$(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
    $$(".tab").forEach(t => t.hidden = t.id !== "tab-" + name);
    if (update) writeHash();
  }
  $$(".tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------- tooltip ----------
  const tip = $("#tooltip");
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(x + 14, innerWidth - w - 8) + "px";
    tip.style.top = (y + 14 + h > innerHeight ? y - h - 10 : y + 14) + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- helpers over the data ----------
  const isArcadeWorking = t => t.category === "arcade" && t.working;
  const coreName = id => (S.cores[id] && S.cores[id].name) || id;
  function badge(id, extra) {
    const c = S.cores[id] || { name: id, source: id.split(":")[0], source_title: "" };
    const title = `${c.source_title || c.source}${c.repo ? " · " + c.repo : ""}${extra && extra.date ? " · since " + extra.date + (extra.date_quality !== "git" ? " (approx.)" : "") : ""}`;
    const cls = ["badge", "src-" + c.source, extra && extra.wip ? "wip" : ""].join(" ");
    return `<span class="${cls}" title="${esc(title)}">${esc(c.name)}${extra && extra.alt ? ' <span class="flag">alt</span>' : ""}${extra && extra.wip ? ' <span class="flag">wip</span>' : ""}</span>`;
  }

  // ---------- tiles ----------
  function renderTiles() {
    const c = S.data.meta.counts;
    const tiles = [
      { v: pct(c.working_arcade_titles_covered, c.working_arcade_titles), l: "of working arcade titles on MiSTer", s: `${fmt(c.working_arcade_titles_covered)} of ${fmt(c.working_arcade_titles)}`, m: c.working_arcade_titles_covered / c.working_arcade_titles },
      { v: fmt(c.working_arcade_titles - c.working_arcade_titles_covered), l: "titles remaining", s: "parent sets with no MRA on any core" },
      { v: pct(c.working_arcade_sets_covered, c.working_arcade_sets), l: "of working arcade sets on MiSTer", s: `${fmt(c.working_arcade_sets_covered)} of ${fmt(c.working_arcade_sets)} incl. clones`, m: c.working_arcade_sets_covered / c.working_arcade_sets },
      { v: fmt(c.cores), l: "arcade cores", s: "across all databases and repositories" },
    ];
    $("#tiles").innerHTML = tiles.map(t => `<div class="tile"><div class="v">${t.v}</div><div class="l">${t.l}</div><div class="s">${t.s}</div>${t.m != null ? `<div class="meter"><i style="width:${(100 * t.m).toFixed(1)}%"></i></div>` : ""}</div>`).join("");
  }

  // ---------- charts ----------
  // The charts follow the Titles filters, Coverage included. When the filters match no title at
  // all the charts box is collapsed and disabled. chartScope() returns the titles and how to
  // count their sets.
  function chartScope() {
    const f = readFilters();
    const titles = S.titles.filter(t => titleMatches(t, f));
    const setOk = f.work === "all" ? () => true : f.work === "notworking" ? s => !s.working : s => s.working;
    const covered = f.work === "working" ? t => t.ncovered_working > 0 : t => t.covered;
    const date = f.work === "working" ? t => t.date_working : t => t.date;
    return { titles, setOk, covered, date, work: f.work };
  }
  function renderCharts() {
    const box = $("#charts-box"), note = $("#charts-note");
    const enabled = S.filtered.length > 0;
    S.chartsLock = true;
    if (!enabled) {
      box.open = false; box.classList.add("disabled");
      note.textContent = "";
    } else {
      box.classList.remove("disabled");
      note.textContent = "for the titles matching the filters above";
      let open = true; try { open = localStorage.getItem("charts-open") !== "0"; } catch (e) { /* storage unavailable */ }
      box.open = open;
    }
    S.chartsLock = false;
    if (enabled) { renderTimeChart(); renderYearChart(); renderGenreChart(); renderGenrePctChart(); }
  }

  function monthKey(d) { return d.slice(0, 7); }
  function addMonths(key, n) { let [y, m] = key.split("-").map(Number); m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1; return `${y}-${String(m).padStart(2, "0")}`; }

  function renderTimeChart() {
    // Sets of the filtered titles: cumulative count in MAME (by the release that added each set)
    // and on MiSTer (by first MRA). Both lines share one axis; "remaining" is the gap between them.
    const sinceKey = S.timeSince;
    const sc = chartScope();
    const f = readFilters();
    const sets = sc.titles.flatMap(t => t.sets.filter(sc.setOk));
    const mameKeys = sets.filter(s => s.mame_date).map(s => monthKey(s.mame_date)).sort();
    const misterKeys = sets.filter(s => s.cores.length && s.date).map(s => monthKey(s.date)).sort();
    if (!mameKeys.length) { $("#chart-time").innerHTML = '<p class="muted">no titles match</p>'; $("#legend-time").innerHTML = ""; return; }
    // The x axis spans the whole history (or 2018 on) whatever the filters, so a drag selection
    // stays where it was made.
    if (!S.timeFirst) S.timeFirst = S.titles.filter(t => t.mame_date).map(t => monthKey(t.mame_date)).sort()[0];
    const first = sinceKey || S.timeFirst, last = monthKey(new Date().toISOString());
    const months = []; for (let k = first; k <= last; k = addMonths(k, 1)) months.push(k);
    const count = keys => { const m = new Map(months.map(k => [k, 0])); let before = 0; keys.forEach(k => { if (k < first) before++; else if (m.has(k)) m.set(k, m.get(k) + 1); }); let c = before; return months.map(k => (c += m.get(k))); };
    const inMame = count(mameKeys), onMister = count(misterKeys);
    const rows = months.map((k, i) => ({ k, mame: inMame[i], mister: onMister[i] }));
    const total = sets.length;

    const W = 640, H = 260, m = { t: 22, r: 16, b: 28, l: 48 };
    const x = i => m.l + (W - m.l - m.r) * (i / Math.max(1, rows.length - 1));
    const y = v => m.t + (H - m.t - m.b) * (1 - v / total);
    const path = key => rows.map((r, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(r[key]).toFixed(1)).join("");
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(total * f));
    const every = rows.length > 240 ? 5 : rows.length > 120 ? 2 : 1;
    const years = rows.map((r, i) => [r.k, i]).filter(([k]) => k.endsWith("-01") && (+k.slice(0, 4)) % every === 0);
    const end = rows.at(-1);
    const idx = k => Math.max(0, Math.min(rows.length - 1, months.indexOf(k) < 0 ? (k < first ? 0 : rows.length - 1) : months.indexOf(k)));
    const band = (f.m0 || f.m1) ? `<rect class="band" x="${x(idx(f.m0 || first))}" y="${m.t}" width="${Math.max(2, x(idx(f.m1 || last)) - x(idx(f.m0 || first)))}" height="${H - m.t - m.b}"/>` : "";
    $("#chart-time").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Working arcade sets in MAME and on MiSTer over time">
      ${band}
      <g class="grid">${yTicks.map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>
      <g class="axis"><line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/></g>
      ${yTicks.map(v => `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("")}
      ${years.map(([k, i]) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${k.slice(0, 4)}</text>`).join("")}
      <path class="ref" d="${path("mame")}"/>
      <path d="${path("mister")}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      <text x="${x(rows.length - 1) - 4}" y="${y(end.mame) - 7}" text-anchor="end" fill="var(--text)">${fmt(end.mame)} in MAME</text>
      <text x="${x(rows.length - 1) - 4}" y="${y(end.mister) + (y(end.mister) - y(end.mame) > 30 ? -7 : 14)}" text-anchor="end" fill="var(--text)">${fmt(end.mister)} on MiSTer</text>
      <line class="hover-line" id="time-hover" x1="0" x2="0" y1="${m.t}" y2="${y(0)}" visibility="hidden"/>
      <rect class="brush" id="time-brush" x="0" y="${m.t}" width="0" height="${H - m.t - m.b}" visibility="hidden"/>
      <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="time-hit"/>
    </svg>`;
    $("#legend-time").innerHTML = `<span><i class="line" style="background:var(--text-2)"></i>${sc.work === "working" ? "working " : ""}sets in MAME (filtered titles)</span><span><i class="line" style="background:var(--accent)"></i>of which on MiSTer</span>`;
    const hit = $("#time-hit"), hl = $("#time-hover"), br = $("#time-brush"), svgEl = $("#chart-time svg");
    const indexAt = ev => { const r = svgEl.getBoundingClientRect(); const px = (ev.clientX - r.left) * W / r.width; return Math.max(0, Math.min(rows.length - 1, Math.round((px - m.l) / (W - m.l - m.r) * (rows.length - 1)))); };
    let drag = null;   // start index while the mouse button is down
    hit.addEventListener("mousemove", ev => {
      const i = indexAt(ev);
      hl.setAttribute("x1", x(i)); hl.setAttribute("x2", x(i)); hl.setAttribute("visibility", "visible");
      if (drag !== null) {
        const a = Math.min(drag, i), b = Math.max(drag, i);
        br.setAttribute("x", x(a)); br.setAttribute("width", Math.max(1, x(b) - x(a))); br.setAttribute("visibility", "visible");
        showTip(`<b>${rows[a].k} – ${rows[b].k}</b><br>release to filter "In MAME since"`, ev.clientX, ev.clientY);
        return;
      }
      const row = rows[i];
      showTip(`<b>${row.k}</b><br>in MAME: ${fmt(row.mame)}<br>on MiSTer: ${fmt(row.mister)} (${pct(row.mister, row.mame)})<br>not yet on MiSTer: ${fmt(row.mame - row.mister)}`, ev.clientX, ev.clientY);
    });
    hit.addEventListener("mousedown", ev => { if (ev.button === 0) { drag = indexAt(ev); ev.preventDefault(); } });
    const finish = ev => {
      if (drag === null) return;
      const i = indexAt(ev), a = Math.min(drag, i), b = Math.max(drag, i);
      drag = null; br.setAttribute("visibility", "hidden"); hideTip();
      if (b > a) { setMonthRange(rows[a].k, rows[b].k); applyTitles(); }
    };
    hit.addEventListener("mouseup", finish);
    hit.addEventListener("mouseleave", ev => { hl.setAttribute("visibility", "hidden"); if (drag !== null) finish(ev); else hideTip(); });
    const btn = $("#time-range");
    btn.textContent = sinceKey ? "show full history" : "show since 2018";
    btn.onclick = () => { S.timeSince = sinceKey ? null : "2018-01"; renderTimeChart(); };
  }

  function renderYearChart() {
    const sc = chartScope();
    const bins = new Map();
    const key = y => { const n = parseInt(y, 10); if (!n) return "n/a"; if (n < 1975) return "≤1974"; if (n > 2005) return "2006+"; return String(n); };
    sc.titles.forEach(t => { const k = key(t.year); const b = bins.get(k) || { k, covered: 0, total: 0 }; b.total++; if (sc.covered(t)) b.covered++; bins.set(k, b); });
    if (!bins.size) { $("#chart-year").innerHTML = '<p class="muted">no titles match</p>'; $("#legend-year").innerHTML = ""; return; }
    const order = Array.from(bins.keys()).sort((a, b) => (a === "≤1974" ? -1 : b === "≤1974" ? 1 : a === "n/a" ? 1 : b === "n/a" ? -1 : a.localeCompare(b)));
    const rows = order.map(k => bins.get(k));
    const max = Math.max(...rows.map(r => r.total));
    const W = 640, H = 260, m = { t: 12, r: 10, b: 30, l: 40 };
    const bw = (W - m.l - m.r) / rows.length;
    const y = v => m.t + (H - m.t - m.b) * (1 - v / max);
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(max * f));
    const bars = rows.map((r, i) => {
      const x0 = m.l + i * bw + 1, w = Math.max(2, bw - 2);
      const yc = y(r.covered), yt = y(r.total);
      return `<g class="bar" data-i="${i}">
        <rect x="${x0}" y="${yt}" width="${w}" height="${Math.max(0, yc - yt - (r.covered ? 2 : 0))}" fill="var(--accent-2)" rx="2"/>
        <rect x="${x0}" y="${yc}" width="${w}" height="${Math.max(0, y(0) - yc)}" fill="var(--accent)" rx="2"/>
        <rect x="${x0 - 1}" y="${m.t}" width="${w + 2}" height="${H - m.t - m.b}" fill="transparent"/>
      </g>`;
    }).join("");
    const labelEvery = rows.length > 20 ? 3 : rows.length > 12 ? 2 : 1;
    $("#chart-year").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Covered and not covered titles by release year">
      <g class="grid">${yTicks.map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>
      ${yTicks.map(v => `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("")}
      ${bars}
      <g class="axis"><line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/></g>
      ${rows.map((r, i) => i % labelEvery === 0 ? `<text x="${m.l + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle">${r.k}</text>` : "").join("")}
    </svg>`;
    $("#legend-year").innerHTML = `<span><i style="background:var(--accent)"></i>on MiSTer</span><span><i style="background:var(--accent-2)"></i>not on MiSTer</span>`;
    $$("#chart-year .bar").forEach(g => {
      const r = rows[+g.dataset.i];
      g.addEventListener("mousemove", ev => showTip(`<b>${r.k}</b><br>on MiSTer: ${fmt(r.covered)} of ${fmt(r.total)} (${pct(r.covered, r.total)})<br>remaining: ${fmt(r.total - r.covered)}`, ev.clientX, ev.clientY));
      g.addEventListener("mouseleave", hideTip);
      g.addEventListener("click", () => { const y0 = r.k === "≤1974" ? "" : r.k === "2006+" ? "2006" : r.k === "n/a" ? "" : r.k; const y1 = r.k === "≤1974" ? "1974" : r.k === "2006+" ? "" : y0; $("#f-y0").value = y0; $("#f-y1").value = y1; applyTitles(); showTab("titles"); });
    });
  }

  function renderGenreChart() {
    const sc = chartScope();
    const bins = new Map();
    sc.titles.forEach(t => { const k = t.genre || "(none)"; const b = bins.get(k) || { k, covered: 0, total: 0 }; b.total++; if (sc.covered(t)) b.covered++; bins.set(k, b); });
    const rows = Array.from(bins.values()).sort((a, b) => b.total - a.total);
    if (!rows.length) { $("#chart-genre").innerHTML = '<p class="muted">no titles match</p>'; $("#legend-genre").innerHTML = ""; return; }
    const max = Math.max(...rows.map(r => r.total));
    const W = 640, rowH = 18, m = { t: 6, r: 56, b: 22, l: 96 };
    const H = m.t + rows.length * rowH + m.b;
    const x = v => m.l + (W - m.l - m.r) * v / max;
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(max * f));
    const bars = rows.map((r, i) => {
      const y0 = m.t + i * rowH + 2, h = rowH - 4;
      const xc = x(r.covered), xt = x(r.total);
      return `<g class="bar" data-i="${i}">
        <text x="${m.l - 6}" y="${y0 + h - 4}" text-anchor="end">${esc(r.k)}</text>
        <rect x="${m.l}" y="${y0}" width="${Math.max(0, xc - m.l)}" height="${h}" fill="var(--accent)" rx="2"/>
        <rect x="${xc + (r.covered ? 2 : 0)}" y="${y0}" width="${Math.max(0, xt - xc - (r.covered ? 2 : 0))}" height="${h}" fill="var(--accent-2)" rx="2"/>
        <text x="${xt + 5}" y="${y0 + h - 4}" fill="var(--text)">${pct(r.covered, r.total)}</text>
        <rect x="${m.l}" y="${y0 - 2}" width="${W - m.l - m.r}" height="${rowH}" fill="transparent"/>
      </g>`;
    }).join("");
    $("#chart-genre").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Covered and not covered titles by genre">
      <g class="grid">${xTicks.map(v => `<line x1="${x(v)}" x2="${x(v)}" y1="${m.t}" y2="${H - m.b}"/>`).join("")}</g>
      ${bars}
      ${xTicks.map(v => `<text x="${x(v)}" y="${H - 6}" text-anchor="middle">${fmt(v)}</text>`).join("")}
    </svg>`;
    $("#legend-genre").innerHTML = `<span><i style="background:var(--accent)"></i>on MiSTer</span><span><i style="background:var(--accent-2)"></i>not on MiSTer</span><span class="muted">click a genre to filter to it</span>`;
    $$("#chart-genre .bar").forEach(g => {
      const r = rows[+g.dataset.i];
      g.addEventListener("mousemove", ev => showTip(`<b>${esc(r.k)}</b><br>on MiSTer: ${fmt(r.covered)} of ${fmt(r.total)} (${pct(r.covered, r.total)})<br>remaining: ${fmt(r.total - r.covered)}`, ev.clientX, ev.clientY));
      g.addEventListener("mouseleave", hideTip);
      g.addEventListener("click", () => { $("#f-genre").value = r.k; applyTitles(); showTab("titles"); });
    });
  }

  function renderGenrePctChart() {
    const sc = chartScope();
    const titles = sc.titles;
    const bins = new Map();
    titles.forEach(t => { const k = t.genre || "(none)"; const b = bins.get(k) || { k, covered: 0, total: 0 }; b.total++; if (sc.covered(t)) b.covered++; bins.set(k, b); });
    const rows = Array.from(bins.values()).map(r => ({ ...r, p: r.covered / r.total })).sort((a, b) => b.p - a.p || b.total - a.total);
    if (!rows.length) { $("#chart-genre-pct").innerHTML = '<p class="muted">no titles match</p>'; $("#legend-genre-pct").innerHTML = ""; return; }
    const overall = titles.filter(sc.covered).length / titles.length;
    const W = 640, rowH = 18, m = { t: 6, r: 110, b: 22, l: 96 };
    const H = m.t + rows.length * rowH + m.b;
    const x = v => m.l + (W - m.l - m.r) * v;
    const bars = rows.map((r, i) => {
      const y0 = m.t + i * rowH + 2, h = rowH - 4;
      return `<g class="bar" data-i="${i}">
        <text x="${m.l - 6}" y="${y0 + h - 4}" text-anchor="end">${esc(r.k)}</text>
        <rect x="${m.l}" y="${y0}" width="${Math.max(0, x(r.p) - m.l)}" height="${h}" fill="var(--accent)" rx="2"/>
        <text x="${x(r.p) + 5}" y="${y0 + h - 4}" fill="var(--text)">${(100 * r.p).toFixed(0)}% <tspan fill="var(--text-2)">of ${fmt(r.total)}</tspan></text>
        <rect x="${m.l}" y="${y0 - 2}" width="${W - m.l - m.r}" height="${rowH}" fill="transparent"/>
      </g>`;
    }).join("");
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    $("#chart-genre-pct").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Percentage of titles on MiSTer by genre">
      <g class="grid">${ticks.map(v => `<line x1="${x(v)}" x2="${x(v)}" y1="${m.t}" y2="${H - m.b}"/>`).join("")}</g>
      ${bars}
      <line class="ref-line" x1="${x(overall)}" x2="${x(overall)}" y1="${m.t}" y2="${H - m.b}"/>
      ${ticks.map(v => `<text x="${x(v)}" y="${H - 6}" text-anchor="middle">${100 * v}%</text>`).join("")}
    </svg>`;
    $("#legend-genre-pct").innerHTML = `<span><i style="background:var(--accent)"></i>share of the genre's titles on MiSTer</span><span><i class="line" style="background:var(--text-2)"></i>all genres: ${(100 * overall).toFixed(1)}%</span><span class="muted">click a genre to filter to it</span>`;
    $$("#chart-genre-pct .bar").forEach(g => {
      const r = rows[+g.dataset.i];
      g.addEventListener("mousemove", ev => showTip(`<b>${esc(r.k)}</b><br>${(100 * r.p).toFixed(1)}% on MiSTer: ${fmt(r.covered)} of ${fmt(r.total)}<br>remaining: ${fmt(r.total - r.covered)}`, ev.clientX, ev.clientY));
      g.addEventListener("mouseleave", hideTip);
      g.addEventListener("click", () => { $("#f-genre").value = r.k; applyTitles(); showTab("titles"); });
    });
  }

  // ---------- titles ----------
  function populateSelects() {
    const manus = new Map(), drvs = new Map(), genres = new Map();
    S.titles.forEach(t => { if (isArcadeWorking(t)) { manus.set(t.manufacturer, (manus.get(t.manufacturer) || 0) + 1); drvs.set(t.sourcefile, (drvs.get(t.sourcefile) || 0) + 1); const g = t.genre || "(none)"; genres.set(g, (genres.get(g) || 0) + 1); } });
    const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
    const gopts = Array.from(genres).sort((a, b) => b[1] - a[1]).map(([g, n]) => opt(g, `${g} (${n})`)).join("");
    $("#f-genre").insertAdjacentHTML("beforeend", gopts);
    $("#d-genre").insertAdjacentHTML("beforeend", gopts);
    $("#f-manu").insertAdjacentHTML("beforeend", Array.from(manus).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m, n]) => opt(m, `${m} (${n})`)).join(""));
    $("#f-drv").insertAdjacentHTML("beforeend", Array.from(drvs).sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => opt(d, `${d} (${n})`)).join(""));
    const years = Array.from(new Set(S.titles.filter(t => t.mame_date).map(t => t.mame_date.slice(0, 4)))).sort();
    const yopts = years.map(y => opt(y, y)).join("");
    const mopts = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map(m => opt(m, m)).join("");
    $("#f-m0y").insertAdjacentHTML("beforeend", yopts); $("#f-m1y").insertAdjacentHTML("beforeend", yopts);
    $("#f-m0m").insertAdjacentHTML("beforeend", mopts); $("#f-m1m").insertAdjacentHTML("beforeend", mopts);
    const cores = S.data.cores.slice().sort((a, b) => a.name.localeCompare(b.name));
    $("#f-core").insertAdjacentHTML("beforeend", cores.map(c => opt(c.id, `${c.name} · ${c.source}`)).join(""));
    const srcs = new Map(); S.data.cores.forEach(c => srcs.set(c.source, c.source_title));
    $("#c-src").insertAdjacentHTML("beforeend", Array.from(srcs).sort().map(([k, v]) => opt(k, v)).join(""));
  }

  function titleMatches(t, f) {
    if (f.cat !== "all" && t.category !== f.cat) return false;
    if (f.work === "working" && !t.working) return false;
    if (f.work === "notworking" && t.working) return false;
    if (f.work === "good" && t.status !== "good") return false;
    const covered = f.work === "working" ? t.ncovered_working > 0 : t.covered;
    const nsets = f.work === "working" ? t.nworking : t.nsets;
    const ncov = f.work === "working" ? t.ncovered_working : t.ncovered;
    if (f.cov === "yes" && !covered) return false;
    if (f.cov === "no" && covered) return false;
    if (f.cov === "partial" && !(covered && ncov < nsets)) return false;
    if (f.y0 && (!+t.year || +t.year < f.y0)) return false;
    if (f.y1 && (!+t.year || +t.year > f.y1)) return false;
    if (f.m0 && (!t.mame_date || t.mame_date.slice(0, 7) < f.m0)) return false;
    if (f.m1 && (!t.mame_date || t.mame_date.slice(0, 7) > f.m1)) return false;
    if (f.manu && t.manufacturer !== f.manu) return false;
    if (f.genre && (t.genre || "(none)") !== f.genre) return false;
    if (f.drv && t.sourcefile !== f.drv) return false;
    if (f.dcov) {
      const d = S.driverByFile[t.sourcefile];
      const state = !d || d.covered === 0 ? "none" : d.covered < d.titles ? "partial" : "full";
      if (f.dcov === "some" ? state === "none" : state !== f.dcov) return false;
    }
    if (f.core && !t.cores.includes(f.core)) return false;
    if (f.rot === "h" && (t.rotate === 90 || t.rotate === 270)) return false;
    if (f.rot === "v" && !(t.rotate === 90 || t.rotate === 270)) return false;
    if (f.q) {
      const hay = (t.desc + " " + t.name + " " + t.manufacturer + " " + t.sourcefile + " " + t.sets.map(s => s.name + " " + s.desc).join(" ")).toLowerCase();
      if (!f.q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  }

  // "In MAME since" range: a year select plus a month select each end; a year alone means the whole year.
  function monthFrom(yid, mid, fallbackMonth) {
    const y = $("#" + yid).value; if (!y) return "";
    return y + "-" + ($("#" + mid).value || fallbackMonth);
  }
  function setMonthRange(from, to) {   // "YYYY-MM" or "" each
    $("#f-m0y").value = from ? from.slice(0, 4) : ""; $("#f-m0m").value = from ? from.slice(5, 7) : "";
    $("#f-m1y").value = to ? to.slice(0, 4) : ""; $("#f-m1m").value = to ? to.slice(5, 7) : "";
  }

  function readFilters() {
    return { q: $("#f-q").value.trim().toLowerCase(), cov: $("#f-cov").value, work: $("#f-work").value, cat: $("#f-cat").value,
      y0: +$("#f-y0").value || 0, y1: +$("#f-y1").value || 0, m0: monthFrom("f-m0y", "f-m0m", "01"), m1: monthFrom("f-m1y", "f-m1m", "12"),
      manu: $("#f-manu").value, genre: $("#f-genre").value, drv: $("#f-drv").value, dcov: $("#f-dcov").value, core: $("#f-core").value, rot: $("#f-rot").value, sort: $("#f-sort").value };
  }

  function applyTitles() {
    const f = readFilters();
    let rows = S.titles.filter(t => titleMatches(t, f));
    const dir = S.dir.t;
    const cmp = {
      desc: (a, b) => a.desc.localeCompare(b.desc),
      year: (a, b) => (a.year || "").localeCompare(b.year || "") || a.desc.localeCompare(b.desc),
      manufacturer: (a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.desc.localeCompare(b.desc),
      genre: (a, b) => (a.genre || "~").localeCompare(b.genre || "~") || a.desc.localeCompare(b.desc),
      sourcefile: (a, b) => a.sourcefile.localeCompare(b.sourcefile) || a.desc.localeCompare(b.desc),
      date: (a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.desc.localeCompare(b.desc),
      nsets: (a, b) => a.nsets - b.nsets || a.desc.localeCompare(b.desc),
    }[f.sort];
    rows.sort((a, b) => dir * cmp(a, b));
    S.filtered = rows; S.shown = 0;
    renderCharts();
    $("#titles-table tbody").innerHTML = "";
    $("#titles-count").textContent = `${fmt(rows.length)} titles` + (f.work === "working" ? ` · ${fmt(rows.reduce((n, t) => n + t.nworking, 0))} working sets` : ` · ${fmt(rows.reduce((n, t) => n + t.nsets, 0))} sets`);
    renderMoreTitles();
    writeHash();
  }

  function renderMoreTitles() {
    const f = readFilters();
    const slice = S.filtered.slice(S.shown, S.shown + S.PAGE);
    const html = slice.map(t => {
      const nsets = f.work === "working" ? t.nworking : t.nsets, ncov = f.work === "working" ? t.ncovered_working : t.ncovered;
      const cls = ncov === 0 ? "uncovered" : ncov < nsets ? "partial" : "covered";
      return `<tr class="${cls}${t.working ? "" : " nw"}" data-t="${esc(t.name)}">
        <td class="exp" title="show sets">${S.open.has(t.name) ? "▾" : "▸"}</td>
        <td>${esc(t.desc)}</td>
        <td class="set">${esc(t.name)}</td>
        <td class="num">${esc(t.year)}</td>
        <td>${esc(t.manufacturer)}</td>
        <td title="${esc(t.genre_raw ? t.genre_raw + " (" + t.genre_source + ")" : "no category in any source")}">${esc(t.genre || "")}${t.mature ? ' <span class="flag">18+</span>' : ""}</td>
        <td class="set">${esc(t.sourcefile)}</td>
        <td class="num" title="sets covered / sets">${ncov}/${nsets}</td>
        <td>${t.cores.map(id => badge(id)).join("")}</td>
        <td class="num">${t.date || ""}</td>
      </tr>${S.open.has(t.name) ? detailRow(t) : ""}`;
    }).join("");
    $("#titles-table tbody").insertAdjacentHTML("beforeend", html);
    S.shown += slice.length;
    $("#titles-more").hidden = S.shown >= S.filtered.length;
    $("#titles-more").textContent = `Show more (${fmt(S.filtered.length - S.shown)} left)`;
  }

  function detailRow(t) {
    const rows = t.sets.map(s => `<tr${s.working ? "" : ' class="nw"'}>
      <td class="set">${esc(s.name)}</td><td>${esc(s.desc)}</td>
      <td class="status-${esc(s.status)}">${esc(s.status)}${s.working ? "" : " (not working)"}</td>
      <td>${s.cores.length ? s.cores.map(r => badge(r.core, r) + `<span class="flag">${r.date ? r.date + (r.date_quality !== "git" ? "≈" : "") : ""}</span> `).join("") : '<span class="muted">—</span>'}</td>
    </tr>`).join("");
    return `<tr class="detail"><td colspan="10"><table><thead><tr><th>Set</th><th>Description</th><th>MAME</th><th>Cores (date first seen; ≈ approximate)</th></tr></thead><tbody>${rows}</tbody></table></td></tr>`;
  }

  $("#titles-table").addEventListener("click", ev => {
    const tr = ev.target.closest("tr[data-t]"); if (!tr) return;
    if (ev.target.closest("a")) return;
    const name = tr.dataset.t, t = S.titles.find(x => x.name === name);
    if (S.open.has(name)) { S.open.delete(name); tr.nextElementSibling?.classList.contains("detail") && tr.nextElementSibling.remove(); tr.firstElementChild.textContent = "▸"; }
    else { S.open.add(name); tr.insertAdjacentHTML("afterend", detailRow(t)); tr.firstElementChild.textContent = "▾"; }
  });
  $("#titles-more").addEventListener("click", renderMoreTitles);
  $("#f-dir").addEventListener("click", () => { S.dir.t *= -1; $("#f-dir").textContent = S.dir.t > 0 ? "↑" : "↓"; applyTitles(); });
  $("#f-reset").addEventListener("click", () => { FILTER_IDS.forEach(id => { const el = $("#" + id); el.value = el.dataset.default ?? ""; }); S.dir.t = 1; $("#f-dir").textContent = "↑"; applyTitles(); });
  let qTimer; $("#f-q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(applyTitles, 150); });
  FILTER_IDS.filter(id => id !== "f-q").forEach(id => $("#" + id).addEventListener("change", applyTitles));

  // ---------- drivers ----------
  // Per driver and genre: working arcade titles and sets, and how many are on MiSTer.
  function driverGenreStats() {
    if (S.driverGenre) return S.driverGenre;
    const m = new Map();
    S.titles.filter(isArcadeWorking).forEach(t => {
      const g = t.genre || "(none)";
      let byG = m.get(t.sourcefile); if (!byG) { byG = new Map(); m.set(t.sourcefile, byG); }
      let st = byG.get(g); if (!st) { st = { titles: 0, covered: 0, sets: 0, sets_covered: 0 }; byG.set(g, st); }
      st.titles++; if (t.ncovered_working > 0) st.covered++; st.sets += t.nworking; st.sets_covered += t.ncovered_working;
    });
    S.driverGenre = m;
    return m;
  }
  const ZERO = { titles: 0, covered: 0, sets: 0, sets_covered: 0 };

  function applyDrivers() {
    const q = $("#d-q").value.trim().toLowerCase(), cov = $("#d-cov").value, genre = $("#d-genre").value, dir = S.dir.d;
    const gs = genre ? driverGenreStats() : null;
    const gstat = d => (gs && gs.get(d.sourcefile) && gs.get(d.sourcefile).get(genre)) || ZERO;
    const opt = $("#d-sort-genre");
    opt.hidden = !genre; opt.textContent = genre ? `titles remaining (${genre})` : "titles remaining (genre)";
    if (!genre && $("#d-sort").value === "gremaining") $("#d-sort").value = "remaining";
    const sort = $("#d-sort").value;
    $$("#drivers-table th.gcol").forEach((th, i) => { th.hidden = !genre; th.textContent = genre ? `${genre} ${i ? "sets" : "titles"}` : ""; });
    let rows = S.data.drivers.filter(d => (!q || d.sourcefile.toLowerCase().includes(q) || d.cores.some(c => coreName(c).toLowerCase().includes(q)))
      && (cov === "all" || (cov === "none" && d.covered === 0) || (cov === "partial" && d.covered > 0 && d.covered < d.titles) || (cov === "notfull" && d.covered < d.titles) || (cov === "full" && d.covered === d.titles))
      && (!genre || gstat(d).titles > 0));
    const cmp = {
      remaining: (a, b) => (a.titles - a.covered) - (b.titles - b.covered) || a.sourcefile.localeCompare(b.sourcefile),
      gremaining: (a, b) => (gstat(a).titles - gstat(a).covered) - (gstat(b).titles - gstat(b).covered) || gstat(a).titles - gstat(b).titles || a.sourcefile.localeCompare(b.sourcefile),
      sourcefile: (a, b) => a.sourcefile.localeCompare(b.sourcefile),
      titles: (a, b) => a.titles - b.titles || a.sourcefile.localeCompare(b.sourcefile),
      pct: (a, b) => a.covered / a.titles - b.covered / b.titles || a.sourcefile.localeCompare(b.sourcefile),
      first: (a, b) => (a.first || "9999").localeCompare(b.first || "9999") || a.sourcefile.localeCompare(b.sourcefile),
    }[sort];
    rows.sort((a, b) => dir * cmp(a, b));
    const grem = genre ? ` · ${fmt(rows.reduce((n, d) => n + gstat(d).titles - gstat(d).covered, 0))} ${genre} titles remaining` : "";
    writeHash();
    $("#drivers-count").textContent = `${fmt(rows.length)} drivers · ${fmt(rows.reduce((n, d) => n + d.titles - d.covered, 0))} titles remaining${grem} · click a driver to list its titles`;
    $("#drivers-table tbody").innerHTML = rows.map(d => { const g = gstat(d); return `<tr class="${d.covered === 0 ? "uncovered" : d.covered < d.titles ? "partial" : "covered"}" data-d="${esc(d.sourcefile)}">
      <td class="set"><a href="#" data-drv="${esc(d.sourcefile)}">${esc(d.sourcefile)}</a></td>
      <td class="num">${d.covered}/${d.titles}</td>
      <td><span class="pct" title="${pct(d.covered, d.titles)}"><i style="width:${(100 * d.covered / d.titles).toFixed(1)}%"></i></span></td>
      <td class="num">${d.sets_covered}/${d.sets}</td>
      ${genre ? `<td class="num" title="${esc(genre)} titles on MiSTer / in the driver">${g.covered}/${g.titles}</td><td class="num" title="${esc(genre)} sets on MiSTer / in the driver">${g.sets_covered}/${g.sets}</td>` : ""}
      <td>${d.cores.map(id => badge(id)).join("")}${(d.cores_claimed || []).map(id => badge(id)).join("")}</td>
      <td class="num">${d.first || ""}</td></tr>`; }).join("");
  }
  $("#drivers-table").addEventListener("click", ev => {
    const a = ev.target.closest("a[data-drv]"); if (!a) return; ev.preventDefault();
    $("#f-drv").value = a.dataset.drv; $("#f-cov").value = "all"; $("#f-genre").value = $("#d-genre").value; applyTitles(); showTab("titles");
  });
  ["d-q", "d-cov", "d-genre", "d-sort"].forEach(id => $("#" + id).addEventListener(id === "d-q" ? "input" : "change", applyDrivers));
  $("#d-dir").addEventListener("click", () => { S.dir.d *= -1; $("#d-dir").textContent = S.dir.d > 0 ? "↑" : "↓"; applyDrivers(); });

  // ---------- cores ----------
  function applyCores() {
    const q = $("#c-q").value.trim().toLowerCase(), src = $("#c-src").value, sort = $("#c-sort").value, dir = S.dir.c;
    let rows = S.data.cores.filter(c => (!src || c.source === src) && (!q || [c.name, c.repo, c.rbf, ...(c.mame_drivers || [])].join(" ").toLowerCase().includes(q)));
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name),
      source: (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
      ntitles: (a, b) => a.ntitles - b.ntitles || a.name.localeCompare(b.name),
      nsets: (a, b) => a.nsets - b.nsets || a.name.localeCompare(b.name),
      first_date: (a, b) => (a.first_date || "9999").localeCompare(b.first_date || "9999") || a.name.localeCompare(b.name),
      build_date: (a, b) => (a.build_date || "0000").localeCompare(b.build_date || "0000") || a.name.localeCompare(b.name),
    }[sort];
    rows.sort((a, b) => dir * cmp(a, b));
    writeHash();
    $("#cores-count").textContent = `${fmt(rows.length)} cores · click a core to list its titles`;
    $("#cores-table tbody").innerHTML = rows.map(c => `<tr>
      <td><a href="#" data-core="${esc(c.id)}">${esc(c.name)}</a>${c.channel && c.channel !== "default" ? ` <span class="flag">${esc(c.channel)}</span>` : ""}</td>
      <td><span class="badge src-${esc(c.source)}">${esc(c.source_title)}</span></td>
      <td class="set">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.repo)}</a>` : '<span class="muted">not published</span>'}</td>
      <td class="set">${(c.mame_drivers || []).map(esc).join("<br>")}</td>
      <td class="num">${c.ntitles}</td><td class="num">${c.nsets}</td>
      <td class="num">${c.first_date || ""}</td><td class="num">${c.build_date || ""}</td>
      <td>${c.reading ? esc(c.reading) + (c.score != null ? ` <span class="flag">${c.score}</span>` : "") : '<span class="muted">' + esc(c.status || "") + "</span>"}</td></tr>`).join("");
  }
  $("#cores-table").addEventListener("click", ev => {
    const a = ev.target.closest("a[data-core]"); if (!a) return; ev.preventDefault();
    $("#f-core").value = a.dataset.core; $("#f-cov").value = "all"; $("#f-cat").value = "all"; $("#f-work").value = "all"; applyTitles(); showTab("titles");
  });
  ["c-q", "c-src", "c-sort"].forEach(id => $("#" + id).addEventListener(id === "c-q" ? "input" : "change", applyCores));
  $("#c-dir").addEventListener("click", () => { S.dir.c *= -1; $("#c-dir").textContent = S.dir.c > 0 ? "↑" : "↓"; applyCores(); });

  // ---------- unmatched + about ----------
  function renderStatic() {
    $("#unmatched-table tbody").innerHTML = S.data.unmatched.map(u => `<tr><td class="set">${esc(u.set)}</td><td>${u.cores.map(id => badge(id)).join("")}</td></tr>`).join("");
    const m = S.data.meta;
    const repos = m.repos.filter(r => r.mras > 0).length;
    $("#about-meta").innerHTML = `<table>
      <tr><td>Generated</td><td>${esc(m.generated)}</td></tr>
      <tr><td>MAME</td><td>${esc(m.mame_build)}</td></tr>
      <tr><td>alamone results</td><td>${esc(m.alamone_generated)}</td></tr>
      <tr><td>Repositories read</td><td>${m.repos.length} (${repos} with MRAs${m.repo_errors.length ? `, ${m.repo_errors.length} unreachable: ${m.repo_errors.map(e => esc(e[0])).join(", ")}` : ""})</td></tr>
      <tr><td>Working arcade titles</td><td>${fmt(m.counts.working_arcade_titles)} (${fmt(m.counts.working_arcade_sets)} sets)</td></tr>
    </table>`;
  }

  // ---------- boot ----------
  ALL_IDS.forEach(id => { const el = $("#" + id); el.dataset.default = el.value; });
  fetch("data/coverage.json").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(data => {
    S.data = data; S.titles = data.titles; data.cores.forEach(c => S.cores[c.id] = c);
    S.driverByFile = {}; data.drivers.forEach(d => S.driverByFile[d.sourcefile] = d);
    const c = data.meta.counts;
    $("#subtitle").textContent = `MAME ${data.meta.mame_version.replace(/^0/, "0.")} · ${fmt(c.working_arcade_titles)} working arcade titles · ${fmt(c.cores)} MiSTer cores · updated ${data.meta.generated.slice(0, 10)}`;
    $("#mame-ver").textContent = data.meta.mame_version.replace(/^0/, "0.");
    renderTiles(); populateSelects(); renderStatic();
    const box = $("#charts-box");
    box.addEventListener("toggle", () => { if (S.chartsLock || box.classList.contains("disabled")) return; try { localStorage.setItem("charts-open", box.open ? "1" : "0"); } catch (e) { /* ignore */ } });
    box.querySelector("summary").addEventListener("click", ev => { if (box.classList.contains("disabled")) ev.preventDefault(); });
    S.booting = true;   // the hash is read once; applying the tabs must not rewrite it half-read
    readHash();
    S.booting = false;
    applyTitles(); applyDrivers(); applyCores();
    // A pasted or back/forward hash applies without a reload (writeHash uses replaceState, so
    // the page's own filter changes do not fire this).
    addEventListener("hashchange", () => { S.booting = true; resetControls(); readHash(); S.booting = false; applyTitles(); applyDrivers(); applyCores(); });
  }).catch(err => { $("#subtitle").textContent = "Could not load data/coverage.json (" + err + "). Serve this folder over HTTP; browsers block fetch() from file://."; });
})();
