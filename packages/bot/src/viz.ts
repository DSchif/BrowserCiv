#!/usr/bin/env tsx
/**
 * BrowserCiv episode dump visualizer.
 *
 * Usage:
 *   pnpm viz -- packages/bot/runs/run-2026-05-06T12-00-00
 *   pnpm viz -- --port 3456 packages/bot/runs/run-2026-05-06T12-00-00
 */

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--");
const portIdx = args.indexOf("--port");
const PORT = portIdx !== -1 ? parseInt(args[portIdx + 1]!, 10) : 3333;
const rawDir = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--port");

function resolveDir(p: string): string | null {
  const candidates = [
    resolve(p),
    resolve(process.env["INIT_CWD"] ?? process.cwd(), p),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const absRunDir = rawDir ? resolveDir(rawDir) : null;

if (!absRunDir) {
  console.error("Usage: pnpm viz -- [--port <n>] <run-directory>");
  if (rawDir) console.error(`  Could not find: ${rawDir}`);
  process.exit(1);
}

function listEpisodeFiles(): string[] {
  if (!absRunDir) return [];
  return readdirSync(absRunDir)
    .filter((f) => f.startsWith("episode-") && f.endsWith(".json"))
    .sort();
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>BrowserCiv Episode Viewer</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f1a; color: #e0e0f0; font-family: 'Segoe UI', monospace; }
  header { background: #1a1a2e; padding: 16px 24px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #333; }
  header h1 { font-size: 1.2rem; color: #a0c8ff; flex: 1; }
  .ep-info { font-size: 0.9rem; color: #ccc; }
  .ep-info span { color: #ffd700; font-weight: bold; }
  .nav { display: flex; align-items: center; gap: 10px; }
  button { background: #2a2a4a; color: #e0e0f0; border: 1px solid #555; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
  button:hover:not(:disabled) { background: #3a3a6a; }
  button:disabled { opacity: 0.4; cursor: default; }
  input[type=range] { width: 200px; accent-color: #a0c8ff; }
  .summary { background: #161628; padding: 10px 24px; display: flex; gap: 24px; flex-wrap: wrap; font-size: 0.85rem; border-bottom: 1px solid #333; }
  .stat { display: flex; flex-direction: column; }
  .stat-label { color: #888; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { color: #ffd700; font-size: 1.1rem; font-weight: bold; }
  .charts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 16px; }
  .chart-box { background: #1a1a2e; border-radius: 8px; padding: 12px; border: 1px solid #2a2a4a; }
  .chart-box h3 { font-size: 0.8rem; color: #a0c8ff; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.08em; }
  canvas { max-height: 200px; }
  @media (max-width: 1100px) { .charts { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>BrowserCiv Episode Viewer</h1>
  <div class="ep-info">Episode <span id="epNum">—</span> of <span id="epTotal">—</span></div>
  <div class="nav">
    <button id="btnFirst" onclick="goTo(0)">|&lt;</button>
    <button id="btnPrev" onclick="goTo(currentIdx - 1)">&lt; Prev</button>
    <input type="range" id="slider" min="0" value="0" oninput="goTo(+this.value)">
    <button id="btnNext" onclick="goTo(currentIdx + 1)">Next &gt;</button>
    <button id="btnLast" onclick="goTo(episodes.length - 1)">&gt;|</button>
  </div>
</header>
<div class="summary" id="summary"></div>
<div class="charts" id="charts">
  <div class="chart-box"><h3>Cities</h3><canvas id="cCities"></canvas></div>
  <div class="chart-box"><h3>Units</h3><canvas id="cUnits"></canvas></div>
  <div class="chart-box"><h3>Cumulative Kills</h3><canvas id="cKills"></canvas></div>
  <div class="chart-box"><h3>Cumulative City Captures</h3><canvas id="cCaptures"></canvas></div>
  <div class="chart-box"><h3>Gold / Turn</h3><canvas id="cGold"></canvas></div>
  <div class="chart-box"><h3>Tiles Explored (%)</h3><canvas id="cTiles"></canvas></div>
  <div class="chart-box"><h3>Techs Researched</h3><canvas id="cTechs"></canvas></div>
  <div class="chart-box"><h3>Population</h3><canvas id="cPop"></canvas></div>
  <div class="chart-box"><h3>Production / Turn</h3><canvas id="cProd"></canvas></div>
  <div class="chart-box"><h3>Buildings Built</h3><canvas id="cBuildings"></canvas></div>
  <div class="chart-box"><h3>Science / Turn</h3><canvas id="cSci"></canvas></div>
  <div class="chart-box"><h3>Food / Turn</h3><canvas id="cFood"></canvas></div>
</div>
<script>
let episodes = [];
let currentIdx = 0;
const chartInstances = {};

async function init() {
  const res = await fetch('/api/episodes');
  episodes = await res.json();
  const slider = document.getElementById('slider');
  slider.max = episodes.length - 1;
  document.getElementById('epTotal').textContent = episodes.length;
  if (episodes.length > 0) goTo(0);
}

async function goTo(idx) {
  if (idx < 0 || idx >= episodes.length) return;
  currentIdx = idx;
  document.getElementById('slider').value = idx;
  document.getElementById('epNum').textContent = idx + 1;
  document.getElementById('btnPrev').disabled = idx === 0;
  document.getElementById('btnFirst').disabled = idx === 0;
  document.getElementById('btnNext').disabled = idx === episodes.length - 1;
  document.getElementById('btnLast').disabled = idx === episodes.length - 1;

  const ep = await fetch('/api/episode/' + idx).then(r => r.json());
  renderSummary(ep);
  renderCharts(ep);
}

function renderSummary(ep) {
  const lastTurn = ep.turns[ep.turns.length - 1];
  const stats = [
    { label: 'Episode', value: ep.episode },
    { label: 'Outcome', value: ep.outcome },
    { label: 'Reward', value: ep.totalReward.toFixed(1) },
    { label: 'Turns', value: lastTurn?.turn ?? '—' },
    { label: 'Total Kills', value: ep.totalKills },
    { label: 'City Captures', value: ep.totalCaptures },
    { label: 'Final Cities', value: lastTurn?.agent?.cities ?? '—' },
    { label: 'Final Techs', value: lastTurn?.agent?.techs ?? '—' },
  ];
  document.getElementById('summary').innerHTML = stats.map(s =>
    '<div class="stat"><span class="stat-label">' + s.label + '</span><span class="stat-value">' + s.value + '</span></div>'
  ).join('');
}

const CHART_COLORS = {
  agent: 'rgba(100, 180, 255, 0.9)',
  opp:   'rgba(255, 100, 100, 0.7)',
  agentFill: 'rgba(100, 180, 255, 0.15)',
  oppFill:   'rgba(255, 100, 100, 0.1)',
};

function mkLine(label, data, color, fill) {
  return { label, data, borderColor: color, backgroundColor: fill ?? 'transparent',
           borderWidth: 2, pointRadius: 0, tension: 0.3, fill: fill != null };
}

function updateChart(id, labels, datasets) {
  if (chartInstances[id]) {
    chartInstances[id].data.labels = labels;
    chartInstances[id].data.datasets = datasets;
    chartInstances[id].update('none');
  } else {
    const ctx = document.getElementById(id).getContext('2d');
    chartInstances[id] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        animation: false,
        plugins: { legend: { labels: { color: '#ccc', boxWidth: 12, font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: '#888', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: '#222' } },
          y: { ticks: { color: '#888', font: { size: 10 } }, grid: { color: '#222' } },
        },
      },
    });
  }
}

function renderCharts(ep) {
  const turns = ep.turns;
  const labels = turns.map(t => t.turn);

  updateChart('cCities', labels, [
    mkLine('Agent', turns.map(t => t.agent.cities), CHART_COLORS.agent, CHART_COLORS.agentFill),
    mkLine('Opponent', turns.map(t => t.opponent?.cities ?? 0), CHART_COLORS.opp, CHART_COLORS.oppFill),
  ]);
  updateChart('cUnits', labels, [
    mkLine('Agent', turns.map(t => t.agent.units), CHART_COLORS.agent, CHART_COLORS.agentFill),
    mkLine('Opponent', turns.map(t => t.opponent?.units ?? 0), CHART_COLORS.opp, CHART_COLORS.oppFill),
  ]);
  updateChart('cKills', labels, [
    mkLine('Cum. Kills', turns.map(t => t.cumKills), CHART_COLORS.agent, CHART_COLORS.agentFill),
  ]);
  updateChart('cCaptures', labels, [
    mkLine('Cum. Captures', turns.map(t => t.cumCaptures), '#ffd700', 'rgba(255,215,0,0.1)'),
  ]);
  updateChart('cGold', labels, [
    mkLine('Agent', turns.map(t => t.agent.goldPerTurn), CHART_COLORS.agent),
    mkLine('Opponent', turns.map(t => t.opponent?.goldPerTurn ?? 0), CHART_COLORS.opp),
  ]);
  updateChart('cTiles', labels, [
    mkLine('% Explored', turns.map(t => +(t.seenTiles / t.totalTiles * 100).toFixed(1)), '#a0ffa0'),
  ]);
  updateChart('cTechs', labels, [
    mkLine('Agent', turns.map(t => t.agent.techs), CHART_COLORS.agent),
    mkLine('Opponent', turns.map(t => t.opponent?.techs ?? 0), CHART_COLORS.opp),
  ]);
  updateChart('cPop', labels, [
    mkLine('Agent', turns.map(t => t.agent.totalPopulation), CHART_COLORS.agent),
    mkLine('Opponent', turns.map(t => t.opponent?.totalPopulation ?? 0), CHART_COLORS.opp),
  ]);
  updateChart('cProd', labels, [
    mkLine('Agent', turns.map(t => t.agent.productionPerTurn), CHART_COLORS.agent),
    mkLine('Opponent', turns.map(t => t.opponent?.productionPerTurn ?? 0), CHART_COLORS.opp),
  ]);
  updateChart('cBuildings', labels, [
    mkLine('Agent', turns.map(t => t.agent.totalBuildings), CHART_COLORS.agent),
    mkLine('Opponent', turns.map(t => t.opponent?.totalBuildings ?? 0), CHART_COLORS.opp),
  ]);
  updateChart('cSci', labels, [
    mkLine('Agent', turns.map(t => t.agent.sciencePerTurn), CHART_COLORS.agent),
    mkLine('Opponent', turns.map(t => t.opponent?.sciencePerTurn ?? 0), CHART_COLORS.opp),
  ]);
  updateChart('cFood', labels, [
    mkLine('Agent', turns.map(t => t.agent.foodPerTurn), CHART_COLORS.agent),
    mkLine('Opponent', turns.map(t => t.opponent?.foodPerTurn ?? 0), CHART_COLORS.opp),
  ]);
}

init();
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  if (url.pathname === "/api/episodes") {
    const files = listEpisodeFiles();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(files));
    return;
  }

  const epMatch = url.pathname.match(/^\/api\/episode\/(\d+)$/);
  if (epMatch) {
    const idx = parseInt(epMatch[1]!, 10);
    const files = listEpisodeFiles();
    if (idx < 0 || idx >= files.length) {
      res.writeHead(404); res.end("Not found"); return;
    }
    const data = readFileSync(resolve(absRunDir, files[idx]!), "utf8");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(data);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\nBrowserCiv Episode Viewer`);
  console.log(`  Run dir: ${absRunDir}`);
  console.log(`  Episodes: ${listEpisodeFiles().length}`);
  console.log(`  Open: http://localhost:${PORT}\n`);
});
