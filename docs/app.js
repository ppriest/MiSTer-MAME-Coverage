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
  const FILTER_IDS = ["f-q", "f-cov", "f-work", "f-cat", "f-y0", "f-y1", "f-genre", "f-manu", "f-drv", "f-dcov", "f-core", "f-rot", "f-sort"];
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const id of FILTER_IDS) if (p.has(id)) { const el = $("#" + id); if (el) el.value = p.get(id); }
    if (p.has("dir")) S.dir.t = +p.get("dir") || 1;
    if (p.has("tab")) showTab(p.get("tab"), false);
  }
  function writeHash() {
    const p = new URLSearchParams();
    for (const id of FILTER_IDS) { const v = $("#" + id).value; if (v !== "" && v !== $("#" + id).dataset.default) p.set(id, v); }
    if (S.dir.t !== 1) p.set("dir", S.dir.t);
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
  function monthKey(d) { return d.slice(0, 7); }
  function addMonths(key, n) { let [y, m] = key.split("-").map(Number); m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1; return `${y}-${String(m).padStart(2, "0")}`; }

  function renderTimeChart(sinceKey) {
    // Working arcade sets: cumulative count in MAME (by the release that added each set) and on
    // MiSTer (by first MRA). Both lines share one axis; "remaining" is simply the gap between them.
    const titles = S.titles.filter(isArcadeWorking);
    const sets = titles.flatMap(t => t.sets.filter(s => s.working));
    const mameKeys = sets.filter(s => s.mame_date).map(s => monthKey(s.mame_date)).sort();
    const misterKeys = sets.filter(s => s.cores.length && s.date).map(s => monthKey(s.date)).sort();
    if (!mameKeys.length) return;
    const first = sinceKey || mameKeys[0], last = monthKey(new Date().toISOString());
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
    $("#chart-time").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Working arcade sets in MAME and on MiSTer over time">
      <g class="grid">${yTicks.map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>
      <g class="axis"><line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/></g>
      ${yTicks.map(v => `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("")}
      ${years.map(([k, i]) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${k.slice(0, 4)}</text>`).join("")}
      <path class="ref" d="${path("mame")}"/>
      <path d="${path("mister")}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      <text x="${x(rows.length - 1) - 4}" y="${y(end.mame) - 7}" text-anchor="end" fill="var(--text)">${fmt(end.mame)} in MAME</text>
      <text x="${x(rows.length - 1) - 4}" y="${y(end.mister) + (y(end.mister) - y(end.mame) > 30 ? -7 : 14)}" text-anchor="end" fill="var(--text)">${fmt(end.mister)} on MiSTer</text>
      <line class="hover-line" id="time-hover" x1="0" x2="0" y1="${m.t}" y2="${y(0)}" visibility="hidden"/>
      <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="time-hit"/>
    </svg>`;
    $("#legend-time").innerHTML = `<span><i class="line" style="background:var(--text-2)"></i>working arcade sets in MAME</span><span><i class="line" style="background:var(--accent)"></i>of which on MiSTer</span>`;
    const hit = $("#time-hit"), hl = $("#time-hover"), svgEl = $("#chart-time svg");
    hit.addEventListener("mousemove", ev => {
      const r = svgEl.getBoundingClientRect();
      const px = (ev.clientX - r.left) * W / r.width;
      const i = Math.max(0, Math.min(rows.length - 1, Math.round((px - m.l) / (W - m.l - m.r) * (rows.length - 1))));
      hl.setAttribute("x1", x(i)); hl.setAttribute("x2", x(i)); hl.setAttribute("visibility", "visible");
      const row = rows[i];
      showTip(`<b>${row.k}</b><br>in MAME: ${fmt(row.mame)}<br>on MiSTer: ${fmt(row.mister)} (${pct(row.mister, row.mame)})<br>not yet on MiSTer: ${fmt(row.mame - row.mister)}`, ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", () => { hl.setAttribute("visibility", "hidden"); hideTip(); });
    const btn = $("#time-range");
    btn.textContent = sinceKey ? "show full history" : "show since 2018";
    btn.onclick = () => renderTimeChart(sinceKey ? null : "2018-01");
  }

  function renderYearChart() {
    const titles = S.titles.filter(isArcadeWorking);
    const bins = new Map();
    const key = y => { const n = parseInt(y, 10); if (!n) return "n/a"; if (n < 1975) return "≤1974"; if (n > 2005) return "2006+"; return String(n); };
    titles.forEach(t => { const k = key(t.year); const b = bins.get(k) || { k, covered: 0, total: 0 }; b.total++; if (t.covered_working) b.covered++; bins.set(k, b); });
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
      g.addEventListener("click", () => { const y0 = r.k === "≤1974" ? "" : r.k === "2006+" ? "2006" : r.k === "n/a" ? "" : r.k; const y1 = r.k === "≤1974" ? "1974" : r.k === "2006+" ? "" : y0; $("#f-y0").value = y0; $("#f-y1").value = y1; $("#f-cov").value = "no"; applyTitles(); showTab("titles"); });
    });
  }

  function renderGenreChart() {
    const titles = S.titles.filter(isArcadeWorking);
    const bins = new Map();
    titles.forEach(t => { const k = t.genre || "(none)"; const b = bins.get(k) || { k, covered: 0, total: 0 }; b.total++; if (t.covered_working) b.covered++; bins.set(k, b); });
    const rows = Array.from(bins.values()).sort((a, b) => b.total - a.total);
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
    $("#legend-genre").innerHTML = `<span><i style="background:var(--accent)"></i>on MiSTer</span><span><i style="background:var(--accent-2)"></i>not on MiSTer</span><span class="muted">click a genre to list its missing titles</span>`;
    $$("#chart-genre .bar").forEach(g => {
      const r = rows[+g.dataset.i];
      g.addEventListener("mousemove", ev => showTip(`<b>${esc(r.k)}</b><br>on MiSTer: ${fmt(r.covered)} of ${fmt(r.total)} (${pct(r.covered, r.total)})<br>remaining: ${fmt(r.total - r.covered)}`, ev.clientX, ev.clientY));
      g.addEventListener("mouseleave", hideTip);
      g.addEventListener("click", () => { $("#f-genre").value = r.k; $("#f-cov").value = "no"; applyTitles(); showTab("titles"); });
    });
  }

  function renderGenrePctChart() {
    const titles = S.titles.filter(isArcadeWorking);
    const bins = new Map();
    titles.forEach(t => { const k = t.genre || "(none)"; const b = bins.get(k) || { k, covered: 0, total: 0 }; b.total++; if (t.covered_working) b.covered++; bins.set(k, b); });
    const rows = Array.from(bins.values()).map(r => ({ ...r, p: r.covered / r.total })).sort((a, b) => b.p - a.p || b.total - a.total);
    const overall = titles.filter(t => t.covered_working).length / titles.length;
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
    $("#legend-genre-pct").innerHTML = `<span><i style="background:var(--accent)"></i>share of the genre's titles on MiSTer</span><span><i class="line" style="background:var(--text-2)"></i>all genres: ${(100 * overall).toFixed(1)}%</span><span class="muted">click a genre to list its missing titles</span>`;
    $$("#chart-genre-pct .bar").forEach(g => {
      const r = rows[+g.dataset.i];
      g.addEventListener("mousemove", ev => showTip(`<b>${esc(r.k)}</b><br>${(100 * r.p).toFixed(1)}% on MiSTer: ${fmt(r.covered)} of ${fmt(r.total)}<br>remaining: ${fmt(r.total - r.covered)}`, ev.clientX, ev.clientY));
      g.addEventListener("mouseleave", hideTip);
      g.addEventListener("click", () => { $("#f-genre").value = r.k; $("#f-cov").value = "no"; applyTitles(); showTab("titles"); });
    });
  }

  // ---------- titles ----------
  function populateSelects() {
    const manus = new Map(), drvs = new Map(), genres = new Map();
    S.titles.forEach(t => { if (isArcadeWorking(t)) { manus.set(t.manufacturer, (manus.get(t.manufacturer) || 0) + 1); drvs.set(t.sourcefile, (drvs.get(t.sourcefile) || 0) + 1); const g = t.genre || "(none)"; genres.set(g, (genres.get(g) || 0) + 1); } });
    const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
    $("#f-genre").insertAdjacentHTML("beforeend", Array.from(genres).sort((a, b) => b[1] - a[1]).map(([g, n]) => opt(g, `${g} (${n})`)).join(""));
    $("#f-manu").insertAdjacentHTML("beforeend", Array.from(manus).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m, n]) => opt(m, `${m} (${n})`)).join(""));
    $("#f-drv").insertAdjacentHTML("beforeend", Array.from(drvs).sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => opt(d, `${d} (${n})`)).join(""));
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

  function readFilters() {
    return { q: $("#f-q").value.trim().toLowerCase(), cov: $("#f-cov").value, work: $("#f-work").value, cat: $("#f-cat").value,
      y0: +$("#f-y0").value || 0, y1: +$("#f-y1").value || 0, manu: $("#f-manu").value, genre: $("#f-genre").value, drv: $("#f-drv").value, dcov: $("#f-dcov").value, core: $("#f-core").value, rot: $("#f-rot").value, sort: $("#f-sort").value };
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
  function applyDrivers() {
    const q = $("#d-q").value.trim().toLowerCase(), cov = $("#d-cov").value, sort = $("#d-sort").value, dir = S.dir.d;
    let rows = S.data.drivers.filter(d => (!q || d.sourcefile.toLowerCase().includes(q) || d.cores.some(c => coreName(c).toLowerCase().includes(q)))
      && (cov === "all" || (cov === "none" && d.covered === 0) || (cov === "partial" && d.covered > 0 && d.covered < d.titles) || (cov === "notfull" && d.covered < d.titles) || (cov === "full" && d.covered === d.titles)));
    const cmp = {
      remaining: (a, b) => (a.titles - a.covered) - (b.titles - b.covered) || a.sourcefile.localeCompare(b.sourcefile),
      sourcefile: (a, b) => a.sourcefile.localeCompare(b.sourcefile),
      titles: (a, b) => a.titles - b.titles || a.sourcefile.localeCompare(b.sourcefile),
      pct: (a, b) => a.covered / a.titles - b.covered / b.titles || a.sourcefile.localeCompare(b.sourcefile),
      first: (a, b) => (a.first || "9999").localeCompare(b.first || "9999") || a.sourcefile.localeCompare(b.sourcefile),
    }[sort];
    rows.sort((a, b) => dir * cmp(a, b));
    $("#drivers-count").textContent = `${fmt(rows.length)} drivers · ${fmt(rows.reduce((n, d) => n + d.titles - d.covered, 0))} titles remaining · click a driver to list its titles`;
    $("#drivers-table tbody").innerHTML = rows.map(d => `<tr class="${d.covered === 0 ? "uncovered" : d.covered < d.titles ? "partial" : "covered"}" data-d="${esc(d.sourcefile)}">
      <td class="set"><a href="#" data-drv="${esc(d.sourcefile)}">${esc(d.sourcefile)}</a></td>
      <td class="num">${d.covered}/${d.titles}</td>
      <td><span class="pct" title="${pct(d.covered, d.titles)}"><i style="width:${(100 * d.covered / d.titles).toFixed(1)}%"></i></span></td>
      <td class="num">${d.sets_covered}/${d.sets}</td>
      <td>${d.cores.map(id => badge(id)).join("")}${(d.cores_claimed || []).map(id => badge(id)).join("")}</td>
      <td class="num">${d.first || ""}</td></tr>`).join("");
  }
  $("#drivers-table").addEventListener("click", ev => {
    const a = ev.target.closest("a[data-drv]"); if (!a) return; ev.preventDefault();
    $("#f-drv").value = a.dataset.drv; $("#f-cov").value = "all"; applyTitles(); showTab("titles");
  });
  ["d-q", "d-cov", "d-sort"].forEach(id => $("#" + id).addEventListener(id === "d-q" ? "input" : "change", applyDrivers));
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
  FILTER_IDS.forEach(id => { const el = $("#" + id); el.dataset.default = el.value; });
  fetch("data/coverage.json").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(data => {
    S.data = data; S.titles = data.titles; data.cores.forEach(c => S.cores[c.id] = c);
    S.driverByFile = {}; data.drivers.forEach(d => S.driverByFile[d.sourcefile] = d);
    const c = data.meta.counts;
    $("#subtitle").textContent = `MAME ${data.meta.mame_version.replace(/^0/, "0.")} · ${fmt(c.working_arcade_titles)} working arcade titles · ${fmt(c.cores)} MiSTer cores · updated ${data.meta.generated.slice(0, 10)}`;
    $("#mame-ver").textContent = data.meta.mame_version.replace(/^0/, "0.");
    renderTiles(); renderTimeChart(); renderYearChart(); renderGenreChart(); renderGenrePctChart(); populateSelects(); renderStatic();
    readHash();
    $("#f-dir").textContent = S.dir.t > 0 ? "↑" : "↓";
    applyTitles(); applyDrivers(); applyCores();
  }).catch(err => { $("#subtitle").textContent = "Could not load data/coverage.json (" + err + "). Serve this folder over HTTP; browsers block fetch() from file://."; });
})();
