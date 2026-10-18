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
  const FILTER_IDS = ["f-q", "f-cov", "f-sup", "f-work", "f-cat", "f-y0", "f-y1", "f-m0y", "f-m0m", "f-m1y", "f-m1m", "f-a0y", "f-a0m", "f-a1y", "f-a1m", "f-genre", "f-manu", "f-drv", "f-dcov", "f-core", "f-db", "f-rot", "f-sort"];
  const DRIVER_IDS = ["d-q", "d-cov", "d-genre", "d-sort"];
  const CORE_IDS = ["c-q", "c-src", "c-bin", "c-sort"];
  const UNMATCHED_IDS = ["u-q", "u-hb"];
  const ALL_IDS = [...FILTER_IDS, ...DRIVER_IDS, ...CORE_IDS, ...UNMATCHED_IDS];
  const DIRS = { dir: "t", ddir: "d", cdir: "c" };   // hash key -> S.dir key
  function resetControls() {
    ALL_IDS.forEach(id => { const el = $("#" + id); el.value = el.dataset.default ?? ""; });
    S.dir = { t: 1, d: -1, c: 1 };
    S.wlView = "requested";
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const id of ALL_IDS) if (p.has(id)) { const el = $("#" + id); if (el) el.value = p.get(id); }
    for (const [k, d] of Object.entries(DIRS)) if (p.has(k)) S.dir[d] = +p.get(k) || S.dir[d];
    S.wlView = p.get("wl") === "fulfilled" ? "fulfilled" : "requested";   // Wishlist: Requested / Fulfilled
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
    if (S.wlView === "fulfilled") p.set("wl", "fulfilled");
    history.replaceState(null, "", "#" + p.toString());
  }

  // ---------- tabs ----------
  function showTab(name, update = true) {
    $$(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
    $$(".tab").forEach(t => t.hidden = t.id !== "tab-" + name);
    if (update) writeHash();
    if (name === "wishlist" && S.api && S.api.tried) refreshWishlist();   // fresh votes whenever the tab is opened
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
  const srcOf = id => (S.cores[id] && S.cores[id].source) || id.split(":")[0];
  const coreName = id => (S.cores[id] && S.cores[id].name) || id;
  function badge(id, extra) {
    const c = S.cores[id] || { name: id, source: id.split(":")[0], source_title: "" };
    const title = `${c.binary_only ? "binary-only · " : ""}${c.source_title || c.source}${c.repo ? " · " + c.repo : ""}${extra && extra.date ? " · since " + extra.date + (extra.date_quality !== "git" ? " (approx.)" : "") : ""}`;
    const cls = ["badge", "src-" + c.source, extra && extra.wip ? "wip" : ""].join(" ");
    const inner = `${esc(c.name)}${c.binary_only ? ' <span class="flag">bin</span>' : ""}${extra && extra.alt ? ' <span class="flag">alt</span>' : ""}${extra && extra.wip ? ' <span class="flag">wip</span>' : ""}`;
    // a core links to its source: its repository, else the page of its database
    const href = c.url || ((S.data && S.data.meta.source_info || {})[c.source] || {}).page;
    return href ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}">${inner}</a>` : `<span class="${cls}" title="${esc(title)}">${inner}</span>`;
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
    // MAME totals ignore the "MiSTer source code" filter (it says nothing about MAME); it only
    // narrows what counts as being on MiSTer.
    const f = readFilters();
    const titles = S.titles.filter(t => titleMatches(t, { ...f, sup: "" }));
    const setOk = f.work === "all" ? () => true : f.work === "notworking" ? s => !s.working : s => s.working;
    const baseCovered = f.work === "working" ? t => t.ncovered_working > 0 : t => t.covered;
    const tsup = f.work === "working" ? t => t.support_working : t => t.support;
    const covered = t => baseCovered(t) && (!f.sup || tsup(t) === f.sup);
    const setCovered = s => s.cores.length > 0 && (!f.sup || s.support === f.sup);
    const date = f.work === "working" ? t => t.date_working : t => t.date;
    return { titles, setOk, covered, setCovered, date, work: f.work };
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
    if (enabled) { renderTimeChart(); renderYearChart(); renderGenreChart(); renderCoresChart(); }
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
    const misterKeys = sets.filter(s => sc.setCovered(s) && s.date).map(s => monthKey(s.date)).sort();
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

  // Cores over time, stacked: the three big databases from the bottom, everything else on top. A core is
  // dated by its first MRA. It follows the Titles filters: the cores that load at least one set of a filtered title.
  const CORE_SERIES = [
    { src: "dist", color: "var(--accent)" },
    { src: "jt", color: "var(--accent-2)" },
    { src: "coinop", color: "var(--muted)" },
    { src: null, color: "var(--accent-3)", label: "Unofficial" },
  ];
  function renderCoresChart() {
    const titles = S.data.meta.sources || {};
    const series = CORE_SERIES.map(sr => ({ ...sr, label: sr.label || (titles[sr.src] || sr.src), keys: [] }));
    let undated = 0;
    const sc = chartScope(), ids = new Set();
    sc.titles.forEach(t => t.sets.forEach(s => { if (sc.setOk(s) && sc.setCovered(s)) s.cores.forEach(r => ids.add(r.core)); }));
    Array.from(ids).map(id => S.cores[id]).filter(Boolean).forEach(c => {
      if (!c.first_date) { undated++; return; }
      (series.find(sr => sr.src === c.source) || series[3]).keys.push(monthKey(c.first_date));
    });
    const first = "2019-10", last = monthKey(new Date().toISOString());
    const months = []; for (let k = first; k <= last; k = addMonths(k, 1)) months.push(k);
    series.forEach(sr => {
      const m = new Map(months.map(k => [k, 0])); let c = 0;
      sr.keys.forEach(k => { if (k < first) c++; else if (m.has(k)) m.set(k, m.get(k) + 1); });
      sr.cum = months.map(k => (c += m.get(k)));
    });
    // cumulative tops, bottom to top
    const tops = months.map((_, i) => { let t = 0; return series.map(sr => (t += sr.cum[i])); });
    const total = tops.at(-1).at(-1);
    const W = 640, H = 260, m = { t: 22, r: 16, b: 28, l: 48 };
    const step = Math.max(1, Math.ceil(total / 4 / 50) * 50);
    const ymax = Math.ceil(total / step) * step;
    const x = i => m.l + (W - m.l - m.r) * (i / Math.max(1, months.length - 1));
    const y = v => m.t + (H - m.t - m.b) * (1 - v / ymax);
    const area = j => {
      const top = months.map((_, i) => `${x(i).toFixed(1)} ${y(tops[i][j]).toFixed(1)}`);
      const bot = months.map((_, i) => `${x(i).toFixed(1)} ${y(j ? tops[i][j - 1] : 0).toFixed(1)}`).reverse();
      return "M" + top.join("L") + "L" + bot.join("L") + "Z";
    };
    const yTicks = []; for (let v = 0; v <= ymax; v += step) yTicks.push(v);
    const years = months.map((k, i) => [k, i]).filter(([k]) => k.endsWith("-01"));
    $("#chart-cores").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Number of cores over time by database, stacked">
      <g class="grid">${yTicks.map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>
      ${yTicks.map(v => `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("")}
      ${years.map(([k, i]) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${k.slice(0, 4)}</text>`).join("")}
      ${series.map((sr, j) => `<path d="${area(j)}" fill="${sr.color}" fill-opacity=".85" stroke="var(--surface)" stroke-width="1"/>`).join("")}
      <text x="${x(months.length - 1) - 4}" y="${y(total) - 7}" text-anchor="end" fill="var(--text)">${fmt(total)} cores</text>
      <line class="hover-line" id="cores-hover" x1="0" x2="0" y1="${m.t}" y2="${y(0)}" visibility="hidden"/>
      <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="cores-hit"/>
    </svg>`;
    $("#legend-cores").innerHTML = series.slice().reverse().map(sr => `<span><i style="background:${sr.color}"></i>${esc(sr.label)}: ${fmt(sr.cum.at(-1))} (${pct(sr.cum.at(-1), total)})</span>`).join("")
      + (undated ? `<span class="muted">${fmt(undated)} cores without an MRA date are not counted</span>` : "");
    const hit = $("#cores-hit"), hl = $("#cores-hover"), svgEl = $("#chart-cores svg");
    hit.addEventListener("mousemove", ev => {
      const r = svgEl.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width;
      const i = Math.max(0, Math.min(months.length - 1, Math.round((px - m.l) / (W - m.l - m.r) * (months.length - 1))));
      hl.setAttribute("x1", x(i)); hl.setAttribute("x2", x(i)); hl.setAttribute("visibility", "visible");
      showTip(`<b>${months[i]}</b>: ${fmt(tops[i].at(-1))} cores<br>` + series.slice().reverse().map(sr => `${esc(sr.label)}: ${fmt(sr.cum[i])} (${pct(sr.cum[i], tops[i].at(-1))})`).join("<br>"), ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", () => { hl.setAttribute("visibility", "hidden"); hideTip(); });
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
    const ayears = Array.from(new Set(S.titles.filter(t => t.date).map(t => t.date.slice(0, 4)))).sort();
    const ayopts = ayears.map(y => opt(y, y)).join("");
    $("#f-a0y").insertAdjacentHTML("beforeend", ayopts); $("#f-a1y").insertAdjacentHTML("beforeend", ayopts);
    $("#f-a0m").insertAdjacentHTML("beforeend", mopts); $("#f-a1m").insertAdjacentHTML("beforeend", mopts);
    const cores = S.data.cores.slice().sort((a, b) => a.name.localeCompare(b.name));
    $("#f-core").insertAdjacentHTML("beforeend", cores.map(c => opt(c.id, `${c.name} · ${c.source}`)).join(""));
    const srcs = new Map(); S.data.cores.forEach(c => srcs.set(c.source, c.source_title));
    $("#f-db").insertAdjacentHTML("beforeend", Array.from(srcs).sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => opt(k, v)).join(""));
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
    if (f.db && !t.cores.some(id => srcOf(id) === f.db)) return false;
    if (f.sup && (f.work === "working" ? t.support_working : t.support) !== f.sup) return false;
    if (f.y0 && (!+t.year || +t.year < f.y0)) return false;
    if (f.y1 && (!+t.year || +t.year > f.y1)) return false;
    if (f.m0 && (!t.mame_date || t.mame_date.slice(0, 7) < f.m0)) return false;
    if (f.m1 && (!t.mame_date || t.mame_date.slice(0, 7) > f.m1)) return false;
    if (f.a0 || f.a1) {   // "On MiSTer since": first MiSTer support (of working sets when the view is working-only)
      const ad = f.work === "working" ? t.date_working : t.date;
      if (!ad) return false;
      if (f.a0 && ad.slice(0, 7) < f.a0) return false;
      if (f.a1 && ad.slice(0, 7) > f.a1) return false;
    }
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
    return { q: $("#f-q").value.trim().toLowerCase(), cov: $("#f-cov").value, work: $("#f-work").value, cat: $("#f-cat").value, sup: $("#f-sup").value,
      y0: +$("#f-y0").value || 0, y1: +$("#f-y1").value || 0, m0: monthFrom("f-m0y", "f-m0m", "01"), m1: monthFrom("f-m1y", "f-m1m", "12"),
      a0: monthFrom("f-a0y", "f-a0m", "01"), a1: monthFrom("f-a1y", "f-a1m", "12"),
      manu: $("#f-manu").value, genre: $("#f-genre").value, drv: $("#f-drv").value, dcov: $("#f-dcov").value, core: $("#f-core").value, db: $("#f-db").value, rot: $("#f-rot").value, sort: $("#f-sort").value };
  }

  function applyTitles() {
    const f = readFilters();
    let rows = S.titles.filter(t => titleMatches(t, f));
    const dir = S.dir.t;
    const cmp = {
      desc: (a, b) => a.desc.localeCompare(b.desc),
      name: (a, b) => a.name.localeCompare(b.name),
      year: (a, b) => (a.year || "").localeCompare(b.year || "") || a.desc.localeCompare(b.desc),
      manufacturer: (a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.desc.localeCompare(b.desc),
      genre: (a, b) => (a.genre || "~").localeCompare(b.genre || "~") || a.desc.localeCompare(b.desc),
      sourcefile: (a, b) => a.sourcefile.localeCompare(b.sourcefile) || a.desc.localeCompare(b.desc),
      date: (a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.desc.localeCompare(b.desc),
      nsets: (a, b) => a.nsets - b.nsets || a.desc.localeCompare(b.desc),
    }[f.sort];
    rows.sort((a, b) => dir * cmp(a, b));
    markSort("titles-table", f.sort, dir);
    S.filtered = rows; S.shown = 0;
    renderCharts();
    $("#titles-table tbody").innerHTML = "";
    $("#titles-count").textContent = `${fmt(rows.length)} titles` + (f.work === "working" ? ` · ${fmt(rows.reduce((n, t) => n + t.nworking, 0))} working sets` : ` · ${fmt(rows.reduce((n, t) => n + t.nsets, 0))} sets`);
    renderMoreTitles();
    renderChips();
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
        <td class="act">${t.cores.length ? `<button type="button" class="launch" data-launch="${esc(launchScript(t))}" title="launch on my MiSTer via Zaparoo">▶</button>` : ""}</td>
        <td>${esc(t.desc)}</td>
        <td class="set">${esc(t.name)}</td>
        <td class="num">${esc(t.year)}</td>
        <td>${esc(t.manufacturer)}</td>
        <td title="${esc(t.genre_raw ? t.genre_raw + " (" + t.genre_source + ")" : "no category in any source")}">${esc(t.genre || "")}${t.mature ? ' <span class="flag">18+</span>' : ""}</td>
        <td class="set">${esc(t.sourcefile)}</td>
        <td class="num" title="sets covered / sets">${ncov}/${nsets}${(f.work === "working" ? t.support_working : t.support) === "binary" ? ' <span class="flag" title="binary-only: every core loading it is distributed without public source">bin</span>' : ""}</td>
        <td class="num">${t.date || ""}</td>
        <td>${t.cores.map(id => badge(id)).join("")}</td>
        <td class="act">${ncov < nsets ? plus1("title", t.name) : ""}</td>
      </tr>${S.open.has(t.name) ? detailRow(t) : ""}`;
    }).join("");
    $("#titles-table tbody").insertAdjacentHTML("beforeend", html);
    fillHardware($("#titles-table tbody"));
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
    return `<tr class="detail"><td colspan="12"><table><thead><tr><th>Set</th><th>Description</th><th>MAME</th><th>Cores (date first seen; ≈ approximate)</th></tr></thead><tbody>${rows}</tbody></table>
      ${t.sourcefile ? `<div class="hwslot" data-hwfile="${esc(t.sourcefile)}"></div>` : ""}${galleryHtml([t], true)}</td></tr>`;
  }

  $("#titles-table").addEventListener("click", ev => {
    const tr = ev.target.closest("tr[data-t]"); if (!tr) return;
    if (ev.target.closest("a, button")) return;
    const name = tr.dataset.t, t = S.titles.find(x => x.name === name);
    if (S.open.has(name)) { S.open.delete(name); tr.nextElementSibling?.classList.contains("detail") && tr.nextElementSibling.remove(); tr.firstElementChild.textContent = "▸"; }
    else { S.open.add(name); tr.insertAdjacentHTML("afterend", detailRow(t)); tr.firstElementChild.textContent = "▾"; fillHardware(tr.nextElementSibling); document.dispatchEvent(new Event("shot-hide")); }
  });
  $("#titles-more").addEventListener("click", renderMoreTitles);
  $("#f-dir").addEventListener("click", () => { S.dir.t *= -1; $("#f-dir").textContent = S.dir.t > 0 ? "↑" : "↓"; applyTitles(); });
  $("#f-reset").addEventListener("click", () => { FILTER_IDS.forEach(id => { const el = $("#" + id); el.value = el.dataset.default ?? ""; }); S.dir.t = 1; $("#f-dir").textContent = "↑"; applyTitles(); });
  // ---------- active-filter chips, quick filters, collapsible panel ----------
  const CHIP_LABELS = { "f-cov": "Coverage", "f-work": "MAME status", "f-cat": "Category", "f-sup": "MiSTer source", "f-db": "Database",
    "f-core": "Core", "f-dcov": "Driver coverage", "f-genre": "Genre", "f-manu": "Manufacturer", "f-drv": "Driver", "f-rot": "Orientation" };
  const CHIP_RANGES = [
    { label: "Year", ids: ["f-y0", "f-y1"], text: v => `${v[0] || "…"}–${v[1] || "…"}` },
    { label: "In MAME since", ids: ["f-m0y", "f-m0m", "f-m1y", "f-m1m"], text: v => `${[v[0], v[1]].filter(Boolean).join("-") || "…"} – ${[v[2], v[3]].filter(Boolean).join("-") || "…"}` },
    { label: "On MiSTer since", ids: ["f-a0y", "f-a0m", "f-a1y", "f-a1m"], text: v => `${[v[0], v[1]].filter(Boolean).join("-") || "…"} – ${[v[2], v[3]].filter(Boolean).join("-") || "…"}` },
  ];
  const isSet = id => { const el = $("#" + id); return el.value !== (el.dataset.default ?? ""); };
  const optText = id => { const el = $("#" + id); const o = el.options && el.options[el.selectedIndex]; return o ? o.textContent.replace(/\s*\(\d[\d,]*\)$/, "") : el.value; };
  const clearIds = ids => ids.forEach(id => { const el = $("#" + id); el.value = el.dataset.default ?? ""; });
  function renderChips() {
    const chips = [];
    Object.keys(CHIP_LABELS).filter(isSet).forEach(id => chips.push({ label: CHIP_LABELS[id], text: optText(id), ids: [id] }));
    CHIP_RANGES.filter(r => r.ids.some(isSet)).forEach(r => chips.push({ label: r.label, text: r.text(r.ids.map(id => $("#" + id).value)), ids: r.ids }));
    S.chips = chips;
    const html = chips.length
      ? `<span class="lbl">Filters:</span>` + chips.map((c, i) => `<span class="chip"><b>${esc(c.label)}</b> ${esc(c.text)}<button type="button" data-chip="${i}" title="remove ${esc(c.label)}" aria-label="remove ${esc(c.label)} filter">×</button></span>`).join("") + `<button type="button" class="clear" data-clear>Clear all</button>`
      : "";
    if (S.chipsHtml !== html) { S.chipsHtml = html; $("#chips").innerHTML = html; }   // untouched when unchanged, so a click is never swallowed by a re-render
    const n = $("#f-nactive"); n.hidden = !chips.length; n.textContent = chips.length;
  }
  $("#chips").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.hasAttribute("data-clear")) { $("#f-reset").click(); return; }
    const c = S.chips[+b.dataset.chip]; if (c) { clearIds(c.ids); applyTitles(); }
  });
  const PRESETS = [
    { label: "Not on MiSTer", set: { "f-cov": "no" } },
    { label: "Partly covered", set: { "f-cov": "partial" } },
    { label: "Drivers with no core", set: { "f-cov": "no", "f-dcov": "none" } },
    { label: "Binary-only", set: { "f-cov": "yes", "f-sup": "binary" } },
    { label: "Added this month", set: () => { const d = new Date(); return { "f-a0y": String(d.getFullYear()), "f-a0m": String(d.getMonth() + 1).padStart(2, "0") }; } },
    { label: "Vertical, not on MiSTer", set: { "f-cov": "no", "f-rot": "v" } },
  ];
  $("#presets").innerHTML = `<span class="lbl">Quick:</span>` + PRESETS.map((p, i) => `<button type="button" data-preset="${i}">${esc(p.label)}</button>`).join("");
  $("#presets").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-preset]"); if (!b) return;
    const p = PRESETS[+b.dataset.preset], set = typeof p.set === "function" ? p.set() : p.set;
    clearIds(FILTER_IDS.filter(id => id !== "f-q" && id !== "f-sort"));
    Object.entries(set).forEach(([id, v]) => { $("#" + id).value = v; });
    applyTitles();
  });
  function setPanel(open) {
    $("#filter-panel").hidden = !open; $("#f-toggle").setAttribute("aria-expanded", String(open)); $("#f-caret").textContent = open ? "▴" : "▾";
    try { localStorage.setItem("filters-open", open ? "1" : "0"); } catch (e) { /* storage unavailable */ }
  }
  $("#f-toggle").addEventListener("click", () => setPanel($("#filter-panel").hidden));
  try { if (localStorage.getItem("filters-open") === "1") setPanel(true); } catch (e) { /* storage unavailable */ }
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
    markSort("drivers-table", sort, dir);
    const grem = genre ? ` · ${fmt(rows.reduce((n, d) => n + gstat(d).titles - gstat(d).covered, 0))} ${genre} titles remaining` : "";
    writeHash();
    $("#drivers-count").textContent = `${fmt(rows.length)} drivers · ${fmt(rows.reduce((n, d) => n + d.titles - d.covered, 0))} titles remaining${grem} · click a driver to list its titles`;
    $("#drivers-table tbody").innerHTML = rows.map(d => { const g = gstat(d); return `<tr class="${d.covered === 0 ? "uncovered" : d.covered < d.titles ? "partial" : "covered"}" data-d="${esc(d.sourcefile)}">
      <td class="set"><button type="button" class="hwtoggle" aria-expanded="false" data-hw="${esc(d.sourcefile)}" title="hardware: CPUs, sound chips, clocks, options">▸</button><a href="#" data-drv="${esc(d.sourcefile)}">${esc(d.sourcefile)}</a></td>
      <td class="num">${d.covered}/${d.titles}</td>
      <td><span class="pct" title="${pct(d.covered, d.titles)}"><i style="width:${(100 * d.covered / d.titles).toFixed(1)}%"></i></span></td>
      <td class="num">${d.sets_covered}/${d.sets}</td>
      ${genre ? `<td class="num" title="${esc(genre)} titles on MiSTer / in the driver">${g.covered}/${g.titles}</td><td class="num" title="${esc(genre)} sets on MiSTer / in the driver">${g.sets_covered}/${g.sets}</td>` : ""}
      <td class="num">${d.first || ""}</td>
      <td>${d.cores.map(id => badge(id)).join("")}${(d.cores_claimed || []).map(id => badge(id)).join("")}</td>
      <td class="act">${d.covered < d.titles ? plus1("driver", d.sourcefile) : ""}</td></tr>`; }).join("");
    S.hwOpen.forEach(f => { const b = $(`#drivers-table .hwtoggle[data-hw="${CSS.escape(f)}"]`); if (b) showHardware(b, true); });
  }

  // ---------- driver hardware (twist-open on the Drivers tab) ----------
  // docs/data/hardware/<first letter of the driver path>.json (made from a local MAME, see docs/data/hardware/README.md): per
  // driver, the CPUs, sound chips, other devices and slots MAME declares for its sets, and the hardware comments of the driver
  // source. Each part is loaded on the first twist-open of one of its drivers.
  S.hwOpen = new Set(); S.hwShards = {};
  function loadHardware(file) {
    const c = file.slice(0, 1).toLowerCase(), k = c >= "a" && c <= "z" ? c : "0";      // the key rule of the data files
    if (!S.hwShards[k]) S.hwShards[k] = fetch(`data/hardware/${k}.json`, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    return S.hwShards[k];
  }
  // Fills the .hwslot placeholders under root with the hardware summary of their driver.
  function fillHardware(root) {
    root.querySelectorAll(".hwslot[data-hwfile]:not([data-filled])").forEach(el => {
      el.dataset.filled = "1";
      const file = el.dataset.hwfile;
      el.innerHTML = '<p class="muted">loading hardware…</p>';
      loadHardware(file).then(h => { el.innerHTML = hardwareHtml(file, h); },
        e => { el.innerHTML = `<p class="muted">hardware information is not available (${esc(String(e.message || e))})</p>`; });
    });
  }
  // Screenshot gallery: at most SHOT_MAX images, beneath the other information of a twist-open. For one title both of its
  // shots; for a driver or a core one shot per title (in-game, else title screen), titles on MiSTer first.
  const SHOT_MAX = 50;
  function galleryHtml(titles, both) {
    if (!IMAGE_BASE) return "";
    const withImg = titles.filter(t => t.img && (t.img.ingame || t.img.title));
    if (!withImg.length) return "";
    const items = both
      ? withImg.flatMap(t => ["title", "ingame"].filter(k => t.img[k]).map(k => ({ t, k })))
      : withImg.slice().sort((x, y) => (y.covered - x.covered) || x.desc.localeCompare(y.desc)).map(t => ({ t, k: t.img.ingame ? "ingame" : "title" }));
    const shown = items.slice(0, SHOT_MAX);
    const note = items.length > shown.length ? ` <span class="muted">(first ${shown.length} of ${fmt(items.length)})</span>` : "";
    return `<div class="gallery-box"><h4>Screenshots${note}</h4><div class="gallery">${shown.map(({ t, k }) => `<figure title="${esc(t.desc)} (${esc(t.year)})" data-src="${esc(IMAGE_BASE + "/" + t.img[k])}" data-n="${t.screens || 1}" data-port="${t.rotate === 90 || t.rotate === 270 ? 1 : 0}">
      <img loading="lazy" src="${esc(IMAGE_BASE + "/" + t.img[k])}" alt="${esc(t.desc)}" onerror="this.closest('figure').remove()">
      <figcaption>${esc(t.desc)}${both ? ` <span class="muted">${k === "title" ? "title screen" : "in game"}</span>` : ""}</figcaption></figure>`).join("")}</div></div>`;
  }
  function clockText(hz) {
    if (!hz) return "";
    const n = v => String(+v.toFixed(6));
    return hz >= 1e6 ? `${n(hz / 1e6)} MHz` : hz >= 1e3 ? `${n(hz / 1e3)} kHz` : `${hz} Hz`;
  }
  function hwRows(rows, total, withClock) {
    return rows.map(r => {
      const clocks = (r.clocks || []).filter(c => c[0]);
      const multi = clocks.length > 1;
      const clock = withClock && clocks.length ? clocks.map(c => clockText(c[0]) + (multi ? ` <span class="muted">(${fmt(c[1])} ${c[1] === 1 ? "set" : "sets"})</span>` : "")).join(", ") : "";
      const opt = r.sets < total ? `<span class="opt" title="${r.sets} of the driver's ${total} sets have it: a variant, or optional">in ${fmt(r.sets)} of ${fmt(total)} sets</span>` : "";
      return `<li><span class="chipname">${r.count > 1 ? r.count + " × " : ""}${esc(r.name)}</span>${clock ? ` <span class="clock">${clock}</span>` : ""} ${opt}</li>`;
    }).join("");
  }
  function hardwareHtml(file, h) {
    const d = h.drivers[file];
    if (!d) return '<p class="muted">no hardware information for this driver</p>';
    const sect = (title, html) => html ? `<div class="hwsect"><h4>${title}</h4><ul>${html}</ul></div>` : "";
    const slots = Object.entries(d.slots || {}).map(([k, v]) => `<li><span class="chipname">${esc(k)}</span> <span class="muted">${v.map(esc).join(", ")}</span></li>`).join("");
    const notes = (d.notes || []).length
      ? `<details class="hwnotes"><summary>Notes from the driver source <span class="muted">(comments and diagrams, as written)</span></summary>${d.notes.map(n => `<pre>${esc(n)}</pre>`).join("")}</details>` : "";
    const src = `https://github.com/mamedev/mame/blob/master/src/mame/${file}`;
    return `<div class="hwgrid">
        ${sect("CPUs", hwRows(d.cpus, d.sets, true))}
        ${sect("Sound", hwRows(d.sound, d.sets, true))}
        ${sect("Other devices", hwRows(d.devices.filter(r => !/^neocart_/.test(r.name)), d.sets, false))}
        ${sect("Selectable options (slots)", slots)}
      </div>
      <p class="muted hwsrc">From MAME ${esc(h.mame)}'s declarations for the driver's ${fmt(d.sets)} ${d.sets === 1 ? "set" : "sets"}; a chip marked <span class="opt">in N of M sets</span> is a variant or optional. Source: <a href="${esc(src)}" target="_blank" rel="noopener">${esc(file)}</a>.</p>
      ${notes}`;
  }
  function showHardware(btn, open) {
    const tr = btn.closest("tr"), file = btn.dataset.hw;
    let next = tr.nextElementSibling;
    const has = next && next.classList.contains("hw");
    if (!open) { if (has) next.remove(); btn.setAttribute("aria-expanded", "false"); S.hwOpen.delete(file); return; }
    S.hwOpen.add(file);
    btn.setAttribute("aria-expanded", "true");
    if (has) return;
    const row = document.createElement("tr");
    row.className = "hw";
    row.innerHTML = `<td colspan="${tr.cells.length}"><div class="hwslot" data-hwfile="${esc(file)}"></div>${galleryHtml(S.titles.filter(t => t.sourcefile === file))}</td>`;
    tr.after(row);
    fillHardware(row);
  }
  $("#drivers-table").addEventListener("click", ev => {
    const hb = ev.target.closest("button.hwtoggle");
    if (hb) { showHardware(hb, hb.getAttribute("aria-expanded") !== "true"); return; }
    const a = ev.target.closest("a[data-drv]"); if (!a) return; ev.preventDefault();
    $("#f-drv").value = a.dataset.drv; $("#f-cov").value = "all"; $("#f-genre").value = $("#d-genre").value; applyTitles(); showTab("titles");
  });
  ["d-q", "d-cov", "d-genre", "d-sort"].forEach(id => $("#" + id).addEventListener(id === "d-q" ? "input" : "change", applyDrivers));
  $("#d-dir").addEventListener("click", () => { S.dir.d *= -1; $("#d-dir").textContent = S.dir.d > 0 ? "↑" : "↓"; applyDrivers(); });
  $("#d-reset").addEventListener("click", () => { DRIVER_IDS.forEach(id => { const el = $("#" + id); el.value = el.dataset.default ?? ""; }); S.dir.d = -1; $("#d-dir").textContent = "↓"; applyDrivers(); });

  // ---------- cores ----------
  function applyCores() {
    const q = $("#c-q").value.trim().toLowerCase(), src = $("#c-src").value, bin = $("#c-bin").value, sort = $("#c-sort").value, dir = S.dir.c;
    let rows = S.data.cores.filter(c => (!src || c.source === src) && (!bin || (bin === "binary") === !!c.binary_only) && (!q || [c.name, c.repo, c.rbf, ...(c.mame_drivers || [])].join(" ").toLowerCase().includes(q)));
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name),
      source: (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
      ntitles: (a, b) => a.ntitles - b.ntitles || a.name.localeCompare(b.name),
      nsets: (a, b) => a.nsets - b.nsets || a.name.localeCompare(b.name),
      first_date: (a, b) => (a.first_date || "9999").localeCompare(b.first_date || "9999") || a.name.localeCompare(b.name),
      build_date: (a, b) => (a.build_date || "0000").localeCompare(b.build_date || "0000") || a.name.localeCompare(b.name),
    }[sort];
    rows.sort((a, b) => dir * cmp(a, b));
    markSort("cores-table", sort, dir);
    writeHash();
    $("#cores-count").textContent = `${fmt(rows.length)} cores · click a core to list its titles`;
    $("#cores-table tbody").innerHTML = rows.map(c => `<tr data-c="${esc(c.id)}">
      <td class="exp" title="show details">${S.openCores.has(c.id) ? "▾" : "▸"}</td>
      <td><a href="#" data-core="${esc(c.id)}">${esc(c.name)}</a>${c.binary_only ? ' <span class="flag" title="binary-only: no public source known">bin</span>' : ""}${c.channel && c.channel !== "default" ? ` <span class="flag">${esc(c.channel)}</span>` : ""}</td>
      <td><span class="badge src-${esc(c.source)}">${esc(c.source_title)}</span></td>
      <td class="set">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.repo)}</a>` : '<span class="muted">not published</span>'}</td>
      <td class="set">${(c.mame_drivers || []).map(esc).join("<br>")}</td>
      <td class="num">${c.ntitles}</td><td class="num">${c.nsets}</td>
      <td class="num">${c.first_date || ""}</td><td class="num">${c.build_date || ""}</td>
      <td>${c.reading ? esc(c.reading) + (c.score != null ? ` <span class="flag">${c.score}</span>` : "") : '<span class="muted">' + esc(c.status || "") + "</span>"}</td></tr>${S.openCores.has(c.id) ? coreDetail(c) : ""}`).join("");
    fillHardware($("#cores-table tbody"));
  }
  // Twist-open of a core: what it is, the hardware of the system(s) it implements, then screenshots of its titles.
  S.openCores = new Set();
  function coreDetail(c) {
    const ts = S.titles.filter(t => t.cores.includes(c.id));
    const byDrv = new Map(); ts.forEach(t => { if (t.sourcefile) byDrv.set(t.sourcefile, (byDrv.get(t.sourcefile) || 0) + 1); });
    const drivers = Array.from(byDrv).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const hw = drivers.slice(0, 3).map(([d, n]) => `<h3 class="hwdrv"><a href="#" data-drv="${esc(d)}">${esc(d)}</a> <span class="muted">(${fmt(n)} ${n === 1 ? "title" : "titles"} on this core)</span></h3><div class="hwslot" data-hwfile="${esc(d)}"></div>`).join("");
    const rest = drivers.length > 3 ? `<p class="muted">and ${drivers.length - 3} more drivers: ${drivers.slice(3).map(([d]) => esc(d)).join(", ")}</p>` : "";
    return `<tr class="detail"><td colspan="10">
      <p class="muted">${esc(c.source_title)}${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.repo)}</a>` : ""}${c.binary_only ? " · binary-only" : ""} · ${fmt(ts.length)} ${ts.length === 1 ? "title" : "titles"}, ${fmt(c.nsets)} sets</p>
      ${hw}${rest}${galleryHtml(ts)}</td></tr>`;
  }
  $("#cores-table").addEventListener("click", ev => {
    const tr = ev.target.closest("tr[data-c]");
    if (tr && !ev.target.closest("a, button")) {
      const id = tr.dataset.c, c = S.cores[id];
      if (S.openCores.has(id)) { S.openCores.delete(id); tr.nextElementSibling?.classList.contains("detail") && tr.nextElementSibling.remove(); tr.firstElementChild.textContent = "▸"; }
      else { S.openCores.add(id); tr.insertAdjacentHTML("afterend", coreDetail(c)); tr.firstElementChild.textContent = "▾"; fillHardware(tr.nextElementSibling); }
      return;
    }
    const d = ev.target.closest("a[data-drv]");
    if (d) { ev.preventDefault(); $("#f-drv").value = d.dataset.drv; $("#f-cov").value = "all"; $("#f-genre").value = ""; applyTitles(); showTab("titles"); return; }
    const a = ev.target.closest("a[data-core]"); if (!a) return; ev.preventDefault();
    $("#f-core").value = a.dataset.core; $("#f-cov").value = "all"; $("#f-cat").value = "all"; $("#f-work").value = "all"; applyTitles(); showTab("titles");
  });
  ["c-q", "c-src", "c-bin", "c-sort"].forEach(id => $("#" + id).addEventListener(id === "c-q" ? "input" : "change", applyCores));
  $("#c-dir").addEventListener("click", () => { S.dir.c *= -1; $("#c-dir").textContent = S.dir.c > 0 ? "↑" : "↓"; applyCores(); });
  $("#c-reset").addEventListener("click", () => { CORE_IDS.forEach(id => { const el = $("#" + id); el.value = el.dataset.default ?? ""; }); S.dir.c = 1; $("#c-dir").textContent = "↑"; applyCores(); });

  // ---------- wishlist (votes live in the /api functions; the page works without them) ----------
  S.api = { ok: false, votes: { title: new Map(), driver: new Map() }, mine: { title: new Set(), driver: new Set() }, list: { titles: [], drivers: [] } };
  const plus1 = (kind, key) => {
    if (!S.api.ok) return S.api.tried ? `<button type="button" class="plus1" disabled title="the wishlist service is not reachable (${esc(S.api.error || "unknown")}); see /api/health">+1</button>` : "";
    const n = S.api.votes[kind].get(key) || 0, voted = S.api.mine[kind].has(key);
    return `<button type="button" class="plus1${voted ? " voted" : ""}" data-kind="${kind}" data-key="${esc(key)}" title="${voted ? "you asked for this; click to change or withdraw" : "ask for this to be ported to MiSTer"}">+1${n ? `<span class="n">${n}</span>` : ""}</button>`;
  };
  function refreshPlus1() {
    $$("button.plus1").forEach(b => {
      const kind = b.dataset.kind, key = b.dataset.key, n = S.api.votes[kind].get(key) || 0, voted = S.api.mine[kind].has(key);
      b.classList.toggle("voted", voted); b.innerHTML = `+1${n ? `<span class="n">${n}</span>` : ""}`;
    });
  }
  const jget = async url => { const r = await fetch(url, { headers: { Accept: "application/json" } }); if (!r.ok) throw new Error(r.status); return r.json(); };
  async function loadWishlist(fresh = false) {
    try {
      const [w, m] = await Promise.all([jget("api/wishlist" + (fresh ? "?_=" + Date.now() : "")), jget("api/mine")]);
      S.api.list = w;
      S.api.votes = { title: new Map(w.titles.map(x => [x.key, x.votes])), driver: new Map(w.drivers.map(x => [x.key, x.votes])) };
      S.api.mine = { title: new Set(m.titles), driver: new Set(m.drivers) };
      S.api.ok = true;
    } catch (e) { S.api.ok = false; S.api.error = String(e.message || e); console.warn("wishlist API unavailable:", S.api.error); }
    S.api.tried = true;
  }
  let wlBusy = false;
  async function refreshWishlist() {
    if (wlBusy) return; wlBusy = true;
    try { await loadWishlist(true); renderWishlist(); refreshPlus1(); } finally { wlBusy = false; }
  }
  const ago = iso => iso ? iso.slice(0, 10) : "";
  const voters = v => (v.voters || []).map(x => `<span class="badge" title="${esc(x.at)}">${esc(x.nickname)}</span>`).join("") + (v.votes > (v.voters || []).length ? ` <span class="flag">+${v.votes - v.voters.length} more</span>` : "");
  // A request is fulfilled once it is on MiSTer: a title when its main (parent) set is, a driver when at least one of its titles is.
  const titleDone = v => { const t = S.titles.find(x => x.name === v.key); if (!t) return false; const p = t.sets.find(s => s.name === t.name); return p ? p.cores.length > 0 : t.ncovered > 0; };
  const driverDone = v => { const d = S.driverByFile[v.key]; return !!d && d.covered > 0; };
  function renderWishlist() {
    const note = $("#wishlist-note");
    $$("#wl-view button").forEach(b => { const on = b.dataset.view === S.wlView; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    if (!S.api.ok) { $("#wl-drivers tbody").innerHTML = ""; $("#wl-titles tbody").innerHTML = '<tr><td colspan="9" class="muted">The wishlist service is not reachable right now (' + esc(S.api.error || "unknown") + '). Open /api/health to see what is missing.</td></tr>'; return; }
    const fulfilled = S.wlView === "fulfilled";
    const none = c => `<tr><td colspan="${c}" class="muted">${fulfilled ? "Nothing fulfilled yet." : "No requests yet."}</td></tr>`;
    const all = { drivers: S.api.list.drivers, titles: S.api.list.titles };
    const nFul = all.drivers.filter(driverDone).length + all.titles.filter(titleDone).length;
    $("#wl-n-fulfilled").textContent = `(${nFul})`; $("#wl-n-requested").textContent = `(${all.drivers.length + all.titles.length - nFul})`;
    $$("#wl-view button").forEach(b => { const on = b.dataset.view === S.wlView; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    const action = (kind, v, done) => done ? `<span class="n" title="votes">${v.votes ?? ""}</span>` : plus1(kind, v.key);
    const dr = all.drivers.filter(v => driverDone(v) === fulfilled);
    $("#wl-drivers tbody").innerHTML = dr.length ? dr.map((v, i) => { const d = S.driverByFile[v.key]; return `<tr>
      <td class="num">${i + 1}</td><td class="set"><a href="#" data-wl-drv="${esc(v.key)}">${esc(v.key)}</a></td>
      <td class="num">${d ? `${d.covered}/${d.titles}` : ""}</td><td class="act">${action("driver", v, fulfilled)}</td>
      <td>${voters(v)}</td><td class="num" title="first vote ${esc(ago(v.first_vote))}">${esc(ago(v.last_vote))}</td></tr>`; }).join("") : none(6);
    const ti = all.titles.filter(v => titleDone(v) === fulfilled);
    $("#wl-titles tbody").innerHTML = ti.length ? ti.map((v, i) => { const t = S.titles.find(x => x.name === v.key); return `<tr>
      <td class="num">${i + 1}</td><td>${t ? `<a href="#" data-wl-title="${esc(v.key)}">${esc(t.desc)}</a>` : ""}</td><td class="set">${esc(v.key)}</td>
      <td class="num">${t ? esc(t.year) : ""}</td><td>${t ? esc(t.manufacturer) : ""}</td><td class="num">${t ? `${t.ncovered_working}/${t.nworking}` : ""}</td>
      <td class="act">${action("title", v, fulfilled)}</td><td>${voters(v)}</td><td class="num" title="first vote ${esc(ago(v.first_vote))}">${esc(ago(v.last_vote))}</td></tr>`; }).join("") : none(9);
  }
  $("#wl-view").addEventListener("click", ev => { const b = ev.target.closest("button[data-view]"); if (!b) return; S.wlView = b.dataset.view; writeHash(); renderWishlist(); refreshPlus1(); });
  $("#tab-wishlist").addEventListener("click", ev => {
    const d = ev.target.closest("a[data-wl-drv]"), t = ev.target.closest("a[data-wl-title]");
    if (!d && !t) return; ev.preventDefault();
    clearIds(FILTER_IDS.filter(id => id !== "f-q" && id !== "f-sort"));
    if (d) $("#f-drv").value = d.dataset.wlDrv; else $("#f-q").value = t.dataset.wlTitle;
    $("#f-cat").value = "all"; $("#f-work").value = "all"; applyTitles(); showTab("titles");
  });
  // the +1 dialog
  const vd = $("#vote-dialog"); let voting = null;
  function openVote(kind, key) {
    const label = kind === "title" ? ((S.titles.find(x => x.name === key) || {}).desc || key) : key;
    voting = { kind, key };
    let nick = "Anonymous"; try { nick = localStorage.getItem("wl-nick") || nick; } catch (e) { /* storage unavailable */ }
    const voted = S.api.mine[kind].has(key);
    $("#vote-title").textContent = voted ? "Your request" : "Request a port";
    $("#vote-what").textContent = `${kind === "title" ? "Title" : "Driver"}: ${label}${kind === "title" ? " (" + key + ")" : ""}`;
    $("#vote-nick").value = nick; $("#vote-err").hidden = true;
    $("#vote-ok").textContent = voted ? "Update" : "+1"; $("#vote-withdraw").hidden = !voted;
    vd.showModal(); $("#vote-nick").select();
  }
  async function sendVote(method) {
    const body = { kind: voting.kind, key: voting.key, nickname: $("#vote-nick").value };
    const r = await fetch("api/vote", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || r.status);
    S.api.votes[voting.kind].set(voting.key, out.votes);
    S.api.mine[voting.kind][out.voted ? "add" : "delete"](voting.key);
    try { if (out.voted) localStorage.setItem("wl-nick", $("#vote-nick").value.trim() || "Anonymous"); } catch (e) { /* storage unavailable */ }
    vd.close(); refreshPlus1();
    await loadWishlist(true); renderWishlist(); refreshPlus1();
  }
  const voteErr = e => { $("#vote-err").textContent = `Could not save: ${e.message}`; $("#vote-err").hidden = false; };
  $("#vote-form").addEventListener("submit", ev => { ev.preventDefault(); sendVote("POST").catch(voteErr); });
  $("#vote-withdraw").addEventListener("click", () => sendVote("DELETE").catch(voteErr));
  $("#vote-cancel").addEventListener("click", () => vd.close());
  // ZapScript for a title: the exact MRA of the best set/core pair (parents first, no alternatives or WIP), else a title lookup.
  function launchScript(t) {
    let best = null, rank = 9;
    for (const s of t.sets) for (const c of s.cores || []) {
      if (!c.mra) continue;
      const r = (c.alt ? 2 : 0) + (c.wip ? 1 : 0) + (s.parent ? 0 : 4);
      if (r < rank) { rank = r; best = c.mra; }
    }
    return best ? best : "**launch.title:Arcade/" + t.desc;
  }
  $("#slop-jump").addEventListener("click", ev => { ev.preventDefault(); const box = $("#slopbox"); box.open = true; box.scrollIntoView({ behavior: "smooth", block: "start" }); });
  // ---------- clickable column headings ----------
  // A heading with data-sort sorts its table: the first click ascending, the second descending, the active one marked with an arrow.
  function markSort(tableId, key, dir) {
    $$(`#${tableId} th[data-sort]`).forEach(th => {
      const on = th.dataset.sort === key;
      th.classList.toggle("sort-asc", on && dir > 0); th.classList.toggle("sort-desc", on && dir < 0);
      th.setAttribute("aria-sort", on ? (dir > 0 ? "ascending" : "descending") : "none");
    });
  }
  const HEAD_SORTS = {      // tables whose sort lives in a control (and the URL hash): select, direction key + button, re-render
    "titles-table": { sel: "#f-sort", dir: "t", btn: "#f-dir", apply: () => applyTitles() },
    "drivers-table": { sel: "#d-sort", dir: "d", btn: "#d-dir", apply: () => applyDrivers() },
    "cores-table": { sel: "#c-sort", dir: "c", btn: "#c-dir", apply: () => applyCores() },
  };
  S.tsort = { "databases-table": { key: "titles", dir: -1 }, "unmatched-table": { key: "set", dir: 1 } };   // the others keep their own state
  const TSORT_APPLY = { "databases-table": () => renderDatabases(), "unmatched-table": () => applyUnmatched() };
  document.addEventListener("click", ev => {
    const th = ev.target.closest("th[data-sort]"); if (!th) return;
    const tableId = th.closest("table").id, key = th.dataset.sort, c = HEAD_SORTS[tableId];
    if (c) {
      if ($(c.sel).value === key) S.dir[c.dir] *= -1; else { $(c.sel).value = key; S.dir[c.dir] = 1; }
      $(c.btn).textContent = S.dir[c.dir] > 0 ? "↑" : "↓"; c.apply();
    } else {
      const t = S.tsort[tableId];
      if (t.key === key) t.dir *= -1; else { t.key = key; t.dir = 1; }
      TSORT_APPLY[tableId]();
    }
  });
  // downloader.ini databases: the list published under /downloader-ini/ (built by tools/downloader_databases.py).
  const slopCopy = (btn, text, done) => { try { navigator.clipboard.writeText(text).then(() => { btn.textContent = done; }); } catch (e) { /* clipboard unavailable */ } };
  $("#slop-copy").addEventListener("click", ev => slopCopy(ev.target, $("#slop-ini").textContent, "Copied"));
  fetch("downloader-ini/status.json", { cache: "no-cache" }).then(r => r.json()).then(st => {
    $("#slop-ini").textContent = st.install;
    if (st.description) $("#slop-desc").textContent = st.description + ".";
    const ok = st.sources.filter(s => s.section);
    $("#slop-list").innerHTML = ok.map((s, i) => `<li><a href="${esc(s.home)}" target="_blank" rel="noopener">${esc(s.name)}</a> <code>${esc(s.db_id)}</code> <button type="button" data-i="${i}">Copy section</button></li>`).join("");
    $("#slop-list").addEventListener("click", ev => { const b = ev.target.closest("button[data-i]"); if (b) slopCopy(b, ok[+b.dataset.i].section, "Copied"); });
    $("#slop-checked").textContent = `${ok.length} database${ok.length === 1 ? "" : "s"}. Last checked ${st.checked}.`;
  }).catch(() => { $("#slop-ini").textContent = ""; });
  // Zaparoo launch: the address lives only in this browser's localStorage.
  // Accepts "192.168.1.5", "http://192.168.1.5/", "http://192.168.1.5:7497/path": keeps just host[:port].
  const zhost = s => { s = (s || "").trim(); if (!s) return ""; try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "http://" + s).host || s; } catch (e) { return s.replace(/^[a-z]+:\/\//i, "").replace(/[\/?#].*$/, ""); } };
  const zd = $("#zap-dialog"), zget = () => { try { return zhost(localStorage.getItem("zaparoo-host")); } catch (e) { return ""; } };
  const zopen = () => { $("#zap-host").value = zget(); zd.showModal(); };
  const zlabel = () => { const h = zget(); $("#zap-settings").textContent = h ? `⚙ Local MiSTer: ${h}` : "⚙ Local MiSTer IP address"; };
  zlabel();
  $("#zap-settings").addEventListener("click", zopen);
  $("#zap-copy").addEventListener("click", ev => { const b = ev.target; try { navigator.clipboard.writeText($("#zap-cfg").textContent).then(() => { b.textContent = "Copied"; }); } catch (e) { /* clipboard unavailable */ } });
  $("#zap-cancel").addEventListener("click", () => zd.close());
  $("#zap-form").addEventListener("submit", () => { try { localStorage.setItem("zaparoo-host", zhost($("#zap-host").value)); } catch (e) { /* storage unavailable */ } zlabel(); });
  document.addEventListener("click", ev => {
    const b = ev.target.closest("button.launch"); if (!b) return;
    ev.stopPropagation();
    let host = zget(); if (!host) { zopen(); return; }
    if (!/^[a-z]+:\/\//i.test(host)) host = "http://" + host;
    if (!/:\d+$/.test(host)) host += ":7497";
    // Opened as a navigation, not fetch(): an https page may not fetch() a plain-http LAN address, but it may open one.
    const w = window.open(`${host.replace(/\/$/, "")}/run/${encodeURIComponent(b.dataset.launch)}`, "zaparoo", "popup,width=420,height=240");
    // Zaparoo answers with an empty page when it accepts the request and with an error text ("Forbidden", ...) when it
    // refuses. A cross-origin popup cannot be read, so leave it open for the person to look at.
    if (!w) { b.textContent = "popup blocked"; setTimeout(() => { b.textContent = "▶"; }, 2500); }
  });
  document.addEventListener("click", ev => { const b = ev.target.closest("button.plus1"); if (b) { ev.stopPropagation(); openVote(b.dataset.kind, b.dataset.key); } });

  // ---------- screenshot preview on hover: title screen + in-game shot, loaded only when you rest on a title ----------
  // File names are hashed (tools/shots.py); each title's `img` (from data/images.json) names its images.
  const IMAGE_BASE = ($('meta[name="image-base"]') || {}).content?.replace(/\/+$/, "") || "";
  if (IMAGE_BASE && matchMedia("(hover: hover)").matches) {
    const card = $("#shot"), figs = Array.from(card.querySelectorAll("figure")), cap = card.querySelector(".cap");
    const HOVER_ON = "#titles-table tbody tr[data-t] td:nth-child(3), #titles-table tbody tr[data-t] td:nth-child(4), #wl-titles a[data-wl-title]";
    let timer, cur = null, byName = null;
    const imgs = key => { byName = byName || new Map(S.titles.map(t => [t.name, t])); return (byName.get(key) || {}).img; };   // title.img = {title, ingame} file names
    const hide = () => { clearTimeout(timer); cur = null; card.hidden = true; };
    const place = ev => { const w = card.offsetWidth || 500, h = card.offsetHeight || 220; let x = ev.clientX + 18, y = ev.clientY + 14; if (x + w > innerWidth - 8) x = ev.clientX - w - 18; if (y + h > innerHeight - 8) y = innerHeight - h - 8; card.style.left = Math.max(8, x) + "px"; card.style.top = Math.max(8, y) + "px"; };
    function show(key, label, ev) {
      const have = imgs(key); if (!have) return;
      cur = key; let pending = 0, ok = 0; cap.textContent = label;
      const shown = figs.filter(f => have[f.dataset.kind]); pending = shown.length;
      figs.forEach(f => { f.hidden = true; });
      shown.forEach(f => {
        const img = f.querySelector("img");
        const done = good => {
          if (cur !== key) return;
          if (good) { f.hidden = false; ok++; if (card.hidden) card.hidden = false; place(ev); }
          if (--pending === 0 && ok === 0) hide();
        };
        img.onload = () => done(true); img.onerror = () => done(false);
        img.src = `${IMAGE_BASE}/${have[f.dataset.kind]}`;
      });
    }
    document.addEventListener("mouseover", ev => {
      const a = ev.target.closest(HOVER_ON); if (!a) return;
      const key = a.closest("tr[data-t]")?.dataset.t || a.dataset.wlTitle; if (!key || key === cur) return;
      if (!imgs(key) || (a.closest("#titles-table") && S.open.has(key))) return;       // a twisted-open title shows its screenshots instead
      const t = S.titles.find(x => x.name === key);
      clearTimeout(timer); timer = setTimeout(() => show(key, t ? `${t.desc} (${t.year}, ${t.manufacturer})` : key, ev), 250);
    });
    document.addEventListener("shot-hide", hide);
    document.addEventListener("mousemove", ev => { if (!card.hidden) place(ev); });
    document.addEventListener("mouseout", ev => { if (ev.target.closest(HOVER_ON)) hide(); });
    addEventListener("scroll", () => { if (!card.hidden) hide(); }, { passive: true });
  }

  // ---------- screenshot proportions ----------
  // A single-screen shot is 4:3 (landscape) or 3:4 (portrait) on the monitor, whatever the pixel aspect of the capture (there is no
  // 16:9), so it is shown at exactly that shape; only multi-screen shots (8:3, 4:1 and the like) keep their own.
  const nearShape = img => {
    const r = img.naturalWidth / img.naturalHeight;
    return r >= 1 && r <= 2.3 ? 4 / 3 : r >= 0.43 && r < 1 ? 3 / 4 : 0;      // 0 = multi-screen strips (8:3, 4:1 and wider/taller), left as they are
  };
  // Multi-screen machines (the title's `screens` from MAME's -listxml, `rotate` for the orientation of each screen): a shot may show
  // all of the screens or only some, side by side or stacked. Work out how many it shows from its proportions, and show each as its
  // own 4:3 (or 3:4) display.
  const LB_GAP = 0.03;                                       // the gap between displays, in display widths (or heights)
  function inferScreens(ratio, n, port) {
    const pr = port ? 3 / 4 : 4 / 3;
    let best = { k: 1, horiz: true, d: Math.abs(Math.log(ratio / pr)) };
    for (let k = 2; k <= n; k++) {
      const dh = Math.abs(Math.log(ratio / (k * pr))), dv = Math.abs(Math.log(ratio / (pr / k)));
      if (dh < best.d) best = { k, horiz: true, d: dh };
      if (dv < best.d) best = { k, horiz: false, d: dv };
    }
    return best;
  }
  const fitBox = (ratio, maxW, maxH) => { const w = Math.min(maxW, maxH * ratio); return [w, w / ratio]; };
  function fitLightbox(img) {                       // the zoomed shot: as large as the window allows, in its shown shape
    if (!img.naturalWidth) return;
    const dlg = img.closest("dialog");
    const n = dlg.dataset.broken ? 1 : +img.dataset.n || 1, port = img.dataset.port === "1";
    const nat = img.naturalWidth / img.naturalHeight;
    const inf = n > 1 ? inferScreens(nat, n, port) : { k: 1, horiz: true };
    img.dataset.k = inf.k; img.dataset.horiz = inf.horiz ? 1 : 0;
    const pr = port ? 3 / 4 : 4 / 3, span = inf.k + (inf.k - 1) * LB_GAP;
    const ratio = inf.k > 1 ? (inf.horiz ? span * pr : pr / span) : nearShape(img) || nat;
    const maxW = Math.max(200, innerWidth - (innerWidth <= 640 ? 112 : 150)), maxH = Math.max(150, innerHeight - 64);
    const [w, h] = fitBox(ratio, maxW, maxH);
    img.style.width = Math.round(w) + "px"; img.style.height = Math.round(h) + "px";
    const vert = inf.k > 1 ? port : ratio < 1;                             // a 3:4 (rotated) display: its scanlines run vertically
    const pitch = vert ? w / img.naturalWidth : h / img.naturalHeight;     // screen pixels per scanline (flat, single display)
    const sl = img.parentElement.querySelector(".lb-scan");
    sl.classList.toggle("vert", vert);
    sl.style.setProperty("--ph", pitch.toFixed(3) + "px"); sl.hidden = inf.k > 1 || pitch < 2;      // too fine to draw when shrunk
    document.dispatchEvent(new Event("lb-render"));
  }
  document.addEventListener("load", ev => {          // load does not bubble: capture it
    const img = ev.target;
    if (!(img instanceof HTMLImageElement) || !img.naturalWidth || img.dataset.crop) return;
    const fig = img.closest(".gallery figure");
    if (fig) {
      const n = +fig.dataset.n || 1, port = fig.dataset.port === "1", inf = n > 1 ? inferScreens(img.naturalWidth / img.naturalHeight, n, port) : { k: 1 };
      if (inf.k > 1) { splitFigure(fig, img, inf.k, inf.horiz, port); return; }
      const shape = nearShape(img);
      img.style.aspectRatio = shape ? String(shape) : "";
    } else if (img.closest("#shot")) {
      const shape = nearShape(img);
      img.style.width = shape ? img.naturalWidth + "px" : ""; img.style.aspectRatio = shape ? String(shape) : "";
    } else if (img.closest("#lightbox")) fitLightbox(img);
  }, true);
  // A gallery shot of k displays becomes k panels, each showing its part of the picture at the shape of one display.
  function splitFigure(fig, img, k, horiz, port) {
    const box = document.createElement("div");
    box.className = "multi " + (horiz ? "h" : "v");
    box.style.gridTemplateColumns = horiz ? `repeat(${k}, 1fr)` : "1fr";
    for (let i = 0; i < k; i++) {
      const scr = document.createElement("span"), part = document.createElement("img");
      scr.className = "scr"; scr.style.aspectRatio = port ? "3 / 4" : "4 / 3";
      part.dataset.crop = "1"; part.alt = img.alt; part.src = img.currentSrc || img.src;
      if (horiz) { part.style.width = k * 100 + "%"; part.style.height = "100%"; part.style.left = -i * 100 + "%"; }
      else { part.style.width = "100%"; part.style.height = k * 100 + "%"; part.style.top = -i * 100 + "%"; }
      scr.appendChild(part); box.appendChild(scr);
    }
    img.replaceWith(box);
  }
  addEventListener("resize", () => { const lb = $("#lightbox img"); if (lb && $("#lightbox").open) fitLightbox(lb); });

  // ---------- click-to-zoom on gallery screenshots ----------
  // A click opens the shot large in a modal dialog; ← → (or the buttons) step through the same gallery, Esc or a click outside closes.
  (function () {
    const dlg = document.createElement("dialog");
    dlg.id = "lightbox"; dlg.setAttribute("aria-label", "Screenshot");
    dlg.innerHTML = '<button type="button" class="lb-close" aria-label="Close">×</button><button type="button" class="lb-prev" aria-label="Previous">‹</button><figure><div class="lb-frame"><img alt=""><span class="lb-scan"></span><canvas class="lb-crt" hidden></canvas></div><figcaption></figcaption></figure><button type="button" class="lb-next" aria-label="Next">›</button><span class="lb-fxs"><button type="button" class="lb-fx" data-fx="scan" title="scanlines (S)"></button><button type="button" class="lb-fx" data-fx="crt" title="CRT curve (C)"></button></span>';
    document.body.appendChild(dlg);
    const img = dlg.querySelector("img"), cap = dlg.querySelector("figcaption"), cv = dlg.querySelector(".lb-crt");
    const fxScan = dlg.querySelector('[data-fx="scan"]'), fxCrt = dlg.querySelector('[data-fx="crt"]');
    let set = [], i = 0;
    // Scanlines (one dark line per pixel row of the original) and a CRT curve over the zoomed shot; the choices are remembered.
    const stored = k => { try { return localStorage.getItem(k) !== "0"; } catch (e) { return true; } };
    const store = (k, on) => { try { localStorage.setItem(k, on ? "1" : "0"); } catch (e) { /* ignore */ } };
    let scan = stored("lb-scanlines"), crt = stored("lb-crt"), crtBroken = false;
    const label = () => { fxScan.textContent = scan ? "Scanlines: on" : "Scanlines: off"; fxCrt.textContent = crtBroken ? "CRT curve: unavailable" : crt ? "CRT curve: on" : "CRT curve: off"; fxCrt.disabled = crtBroken; if (crtBroken) dlg.dataset.broken = "1"; };
    const setScan = on => { scan = on; store("lb-scanlines", on); label(); render(); };
    const setCrt = on => { crt = on; store("lb-crt", on); label(); render(); };

    // The curve is a WebGL shader (barrel distortion, scanlines that follow it, a vignette, nearest-neighbour sampling). Its texture
    // is a separate CORS image so a host without CORS headers only loses the curve, never the zoom.
    let gl = null, prog = null, tex = null, texSrc = "", texImg = null;
    const initGl = () => {
      gl = cv.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
      if (!gl) throw new Error("no WebGL");
      const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p; varying vec2 uv; void main(){ uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }"));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `precision mediump float; varying vec2 uv; uniform sampler2D tex;
        uniform float n; uniform float horiz; uniform float gap; uniform float curve; uniform float rows; uniform float scan; uniform float vert;
        void main(){
          // n displays side by side (horiz) or stacked, each its own CRT; a is the position along the row of displays
          float a = horiz > .5 ? uv.x : 1. - uv.y;
          float b = horiz > .5 ? uv.y : uv.x;
          float pw = (1. - gap * (n - 1.)) / n;
          float idx = floor(a / (pw + gap));
          float loc = a - idx * (pw + gap);
          if (idx >= n || loc > pw) { gl_FragColor = vec4(0.); return; }       // between the displays: transparent
          loc /= pw;
          vec2 p = horiz > .5 ? vec2(loc, b) : vec2(b, 1. - loc);               // this display, origin bottom left
          vec2 c = p * 2. - 1.;
          vec2 o = abs(c.yx) / vec2(6., 4.) * curve;
          vec2 s = (c + c * o * o) * .5 + .5;                                  // barrel: the corners fall off the glass
          float e = min(min(s.x, 1. - s.x), min(s.y, 1. - s.y));
          if (e < 0.) { gl_FragColor = vec4(0.); return; }                    // off the glass: transparent
          vec2 q = vec2(s.x, 1. - s.y);                                        // in the display, origin top left
          vec2 t = horiz > .5 ? vec2((idx + q.x) / n, q.y) : vec2(q.x, (idx + q.y) / n);
          vec3 col = texture2D(tex, t).rgb;
          col *= 1. - scan * .5 * (1. - sin(3.14159 * fract(mix(s.y, s.x, vert) * rows)));
          float v = 16. * s.x * s.y * (1. - s.x) * (1. - s.y);
          col *= .55 + .45 * pow(v, .25);                                       // vignette
          float al = smoothstep(0., .004, e);                                   // a soft edge to the screen
          gl_FragColor = vec4(col * 1.08 * al, al);                             // premultiplied
        }`));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    const flat = () => { cv.hidden = true; img.style.opacity = ""; };       // the plain zoom (with the CSS scanline overlay)
    function render() {
      const sl = dlg.querySelector(".lb-scan");
      sl.style.display = scan && !sl.hidden && !(crt && !crtBroken && !cv.hidden) ? "" : "none";
      const k = +img.dataset.k || 1;                                      // displays in this shot
      if ((!crt && k < 2) || crtBroken || !img.src || !img.naturalWidth || !dlg.open) { flat(); sl.style.display = scan && !sl.hidden ? "" : "none"; return; }
      const url = img.currentSrc || img.src;
      const draw = () => {
        try {
          if (!gl) initGl();
          const dpr = Math.min(2, devicePixelRatio || 1), w = img.clientWidth, h = img.clientHeight;
          cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + "px"; cv.style.height = h + "px";
          gl.viewport(0, 0, cv.width, cv.height);
          gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, texImg);      // throws SecurityError when the host sends no CORS headers
          const horiz = img.dataset.horiz !== "0", gapP = k > 1 ? LB_GAP : 0;
          const pw = 1 / (k + (k - 1) * gapP);                                       // a display's share of the row of displays
          const vert = k > 1 ? img.dataset.port === "1" : h > w;                     // rotated display: vertical scanlines
          const dispW = k > 1 && horiz ? w * pw : w, dispH = k > 1 && !horiz ? h * pw : h;    // one display on screen
          const srcW = k > 1 && horiz ? texImg.naturalWidth / k : texImg.naturalWidth, srcH = k > 1 && !horiz ? texImg.naturalHeight / k : texImg.naturalHeight;
          const pitch = vert ? dispW / srcW : dispH / srcH;
          const u = (name, v) => gl.uniform1f(gl.getUniformLocation(prog, name), v);
          u("n", k); u("horiz", horiz ? 1 : 0); u("gap", gapP * pw); u("curve", crt ? 1 : 0);
          u("rows", vert ? srcW : srcH); u("vert", vert ? 1 : 0); u("scan", scan && pitch >= 2 ? 1 : 0);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          cv.hidden = false; img.style.opacity = "0";
          sl.style.display = "none";
        } catch (e) { crtBroken = true; label(); flat(); sl.style.display = scan && !sl.hidden ? "" : "none"; }
      };
      if (texSrc === url && texImg && texImg.complete && texImg.naturalWidth) { draw(); return; }
      texSrc = url; texImg = new Image(); texImg.crossOrigin = "anonymous";
      texImg.onload = () => { if (texSrc === url) draw(); };
      texImg.onerror = () => { if (texSrc === url) { crtBroken = true; label(); flat(); } };
      texImg.src = url;
    }
    document.addEventListener("lb-render", render);
    label();
    const show = n => {
      i = (n + set.length) % set.length;
      const fig = set[i];
      img.dataset.n = fig.dataset.n || "1"; img.dataset.port = fig.dataset.port || "0";
      img.src = fig.dataset.src; img.alt = fig.querySelector("img")?.alt || "";
      cap.textContent = fig.querySelector("figcaption")?.textContent || img.alt;
      dlg.classList.toggle("single", set.length < 2);
    };
    document.addEventListener("click", ev => {
      const t = ev.target.closest(".gallery figure"); if (!t || !t.dataset.src) return;
      set = Array.from(t.closest(".gallery").querySelectorAll("figure"));
      show(set.indexOf(t)); dlg.showModal();
    });
    dlg.addEventListener("click", ev => {
      if (ev.target.closest(".lb-prev")) show(i - 1);
      else if (ev.target.closest(".lb-next")) show(i + 1);
      else if (ev.target.closest('[data-fx="scan"]')) setScan(!scan);
      else if (ev.target.closest('[data-fx="crt"]')) setCrt(!crt);
      else if (ev.target.closest(".lb-close") || ev.target === dlg) dlg.close();      // the backdrop is the dialog itself
      else if (ev.target === img || ev.target === cv) dlg.close();
    });
    dlg.addEventListener("keydown", ev => {
      if (ev.key === "ArrowLeft" && set.length > 1) { ev.preventDefault(); show(i - 1); }
      else if (ev.key === "ArrowRight" && set.length > 1) { ev.preventDefault(); show(i + 1); }
      else if (ev.key === "s" || ev.key === "S") setScan(!scan);
      else if (ev.key === "c" || ev.key === "C") { if (!crtBroken) setCrt(!crt); }
    });
    dlg.addEventListener("close", () => { img.removeAttribute("src"); cv.hidden = true; img.style.opacity = ""; });
  })();

  // ---------- databases ----------
  function renderDatabases() {
    const info = S.data.meta.source_info || {}, titles = S.data.meta.sources || {};
    const agg = new Map(Object.keys(titles).map(k => [k, { cores: 0, titles: 0, sets: 0 }]));
    S.data.cores.forEach(c => { const a = agg.get(c.source); if (a) a.cores++; });
    S.titles.filter(isArcadeWorking).forEach(t => {
      const seen = new Set();
      t.sets.forEach(s => { if (!s.working) return; const here = new Set(s.cores.map(r => srcOf(r.core))); here.forEach(k => { const a = agg.get(k); if (a) { a.sets++; seen.add(k); } }); });
      seen.forEach(k => agg.get(k).titles++);
    });
    const ts = S.tsort["databases-table"], dkey = { name: ([k]) => titles[k].toLowerCase(), cores: ([, a]) => a.cores, titles: ([, a]) => a.titles, sets: ([, a]) => a.sets }[ts.key];
    const rows = Array.from(agg).sort((a, b) => ts.dir * ((x, y) => x < y ? -1 : x > y ? 1 : 0)(dkey(a), dkey(b)) || b[1].titles - a[1].titles);
    markSort("databases-table", ts.key, ts.dir);
    const link = u => u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https:\/\//, ""))}</a>` : '<span class="muted">—</span>';
    // The database's text is its own URL; the link opens it in the Downloader DB inspector.
    const dbLink = u => u ? `<a href="https://theypsilon.github.io/DB-Inspector_MiSTer/#db=${u}" target="_blank" rel="noopener" title="inspect this database">${esc(u.replace(/^https:\/\//, ""))}</a>` : '<span class="muted">—</span>';
    $("#databases-table tbody").innerHTML = rows.map(([k, a]) => `<tr>
      <td><a href="#" data-db="${esc(k)}">${esc(titles[k])}</a></td>
      <td class="num">${fmt(a.cores)}</td><td class="num">${fmt(a.titles)}</td><td class="num">${fmt(a.sets)}</td>
      <td class="set">${link((info[k] || {}).page)}</td><td class="set">${dbLink((info[k] || {}).db_url)}</td></tr>`).join("");
  }
  $("#databases-table").addEventListener("click", ev => {
    const a = ev.target.closest("a[data-db]"); if (!a) return; ev.preventDefault();
    $("#f-db").value = a.dataset.db; $("#f-cov").value = "all"; $("#f-cat").value = "arcade"; $("#f-work").value = "working"; applyTitles(); showTab("titles");
  });

  // ---------- unmatched + about ----------
  function applyUnmatched() {
    const words = $("#u-q").value.trim().toLowerCase().split(/\s+/).filter(Boolean), hb = $("#u-hb").value;
    const rows = S.data.unmatched.filter(u => {
      if (hb === "hide" && u.hbmame) return false;
      if (hb === "only" && !u.hbmame) return false;
      const hay = (u.set + " " + u.cores.map(id => coreName(id) + " " + id).join(" ") + (u.hbmame ? " homebrew hacks hbmame " + (u.desc || "") + " " + (u.manufacturer || "") + " " + (u.parent || "") : "")).toLowerCase();
      return words.every(w => hay.includes(w));
    });
    const us = S.tsort["unmatched-table"], ukey = { set: u => u.set, desc: u => (u.desc || "").toLowerCase(), year: u => u.year || "", manufacturer: u => (u.manufacturer || "").toLowerCase(), ncores: u => u.cores.length }[us.key];
    rows.sort((a, b) => us.dir * ((x, y) => x < y ? -1 : x > y ? 1 : 0)(ukey(a), ukey(b)) || a.set.localeCompare(b.set));
    markSort("unmatched-table", us.key, us.dir);
    const h = S.data.meta.hbmame || {}, nhb = S.data.unmatched.filter(u => u.hbmame).length;
    $("#unmatched-count").textContent = `${fmt(rows.length)} of ${fmt(S.data.unmatched.length)} sets`;
    $("#unmatched-note").textContent = "Set names found in MiSTer MRAs that do not exist in this MAME version: hacks, homebrew, renamed or removed sets, or MRA typos." +
      (h.version ? ` ${fmt(nhb)} of them are in HBMAME ${h.version} and are labelled homebrew/hacks.` : "");
    $("#unmatched-table tbody").innerHTML = rows.map(u => `<tr><td class="set">${esc(u.set)}${u.hbmame ? ' <span class="flag" title="exists in HBMAME ' + esc(h.version || "") + '">homebrew/hacks</span>' : ""}</td><td>${esc(u.desc || "")}${u.parent ? ` <span class="flag">clone of ${esc(u.parent)}</span>` : ""}</td><td class="num">${esc(u.year || "")}</td><td>${esc(u.manufacturer || "")}</td><td>${u.cores.map(id => badge(id)).join("")}</td></tr>`).join("");
    writeHash();
  }
  $("#u-hb").addEventListener("change", applyUnmatched);
  $("#u-reset").addEventListener("click", () => { UNMATCHED_IDS.forEach(id => { const el = $("#" + id); el.value = el.dataset.default ?? ""; }); applyUnmatched(); });
  function renderStatic() {

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
  fetch("data/coverage.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(data => {
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
    applyTitles(); applyDrivers(); applyCores(); renderDatabases(); applyUnmatched();
    loadWishlist().then(() => { applyTitles(); applyDrivers(); renderWishlist(); });
    // A pasted or back/forward hash applies without a reload (writeHash uses replaceState, so
    // the page's own filter changes do not fire this).
    addEventListener("hashchange", () => { S.booting = true; resetControls(); readHash(); S.booting = false; applyTitles(); applyDrivers(); applyCores(); applyUnmatched(); if (S.api && S.api.list) { renderWishlist(); refreshPlus1(); } });
  }).catch(err => { $("#subtitle").textContent = "Could not load data/coverage.json (" + err + "). Serve this folder over HTTP; browsers block fetch() from file://."; });
})();
