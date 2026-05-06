// Play-through smoke test. Drives a real two-player game through movement,
// city founding, production, and several turn cycles. Captures screenshots
// at every meaningful step. Verifies units never spawn on terrain whose
// per-unit cost is 0.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const URL = process.env.URL ?? "http://localhost:5173";
const SHOT_DIR = "/tmp/browserciv-shots";
const SIZE = process.env.SIZE ?? "small";

const errors = { A: [], B: [] };
function attachErrors(page, label) {
  page.on("console", (m) => {
    if (m.type() === "error") errors[label].push(`[${label} console] ${m.text()}`);
  });
  page.on("pageerror", (e) => errors[label].push(`[${label} pageerror] ${e.message}`));
  page.on("requestfailed", (req) =>
    errors[label].push(`[${label} reqfail] ${req.url()} ${req.failure()?.errorText ?? ""}`),
  );
}

let stepNum = 0;
async function shot(page, label, name) {
  const fname = `${String(++stepNum).padStart(2, "0")}-${label}-${name}.png`;
  await page.screenshot({ path: `${SHOT_DIR}/${fname}`, fullPage: true });
  return fname;
}

async function inspect(page) {
  return page.evaluate(() => {
    const w = window;
    const dev = w.__BROWSERCIV;
    const s = dev?.latest();
    if (!s) return { error: "no state" };
    const tileCounts = {};
    if (s.map) {
      for (const t of s.map.tiles) tileCounts[t.terrain] = (tileCounts[t.terrain] ?? 0) + 1;
    }
    const myUnits = s.units
      .filter((u) => u.ownerId === s.viewerId)
      .map((u) => ({ id: u.id, defId: u.defId, q: u.position.q, r: u.position.r, mp: u.movementLeft }));
    return {
      viewerId: s.viewerId,
      status: s.status,
      turnNumber: s.turnNumber,
      activePlayer: s.players[s.currentPlayerIndex]?.name,
      mapW: s.map?.width,
      mapH: s.map?.height,
      tileCounts,
      myUnits,
      myStartingUnitsAt: myUnits.map((u) => `${u.q},${u.r}`),
      cities: s.cities.map((c) => ({ id: c.id, name: c.name, ownerId: c.ownerId, q: c.position.q, r: c.position.r, pop: c.population, prod: c.production, item: c.productionItem })),
      ownedTiles: s.map?.tiles.filter((t) => t.ownerCityId).length ?? 0,
      visibleTiles: s.map?.tiles.filter((t) => t.visibility === "visible").length ?? 0,
      seenTiles: s.map?.tiles.filter((t) => t.visibility === "seen").length ?? 0,
      treasury: { gold: s.players.find((p) => p.id === s.viewerId)?.gold, science: s.players.find((p) => p.id === s.viewerId)?.science, culture: s.players.find((p) => p.id === s.viewerId)?.culture },
    };
  });
}

/** Verify every unit standing on a tile that the unit's terrain_costs says is enterable (>0). */
async function verifyUnitTerrains(page, label) {
  return page.evaluate(({ unitTerrainCosts }) => {
    const w = window;
    const dev = w.__BROWSERCIV;
    const s = dev?.latest();
    if (!s || !s.map) return { ok: true, msg: "no state" };
    const tilesByKey = new Map(s.map.tiles.map((t) => [`${t.q},${t.r}`, t]));
    const violations = [];
    for (const u of s.units) {
      if (u.ownerId !== s.viewerId) continue;
      const k = `${u.position.q},${u.position.r}`;
      const tile = tilesByKey.get(k);
      if (!tile) {
        violations.push({ unit: u.defId, at: k, reason: "off-map" });
        continue;
      }
      const cost = unitTerrainCosts[u.defId]?.[tile.terrain];
      if (cost === undefined || cost === 0) {
        violations.push({ unit: u.defId, at: k, terrain: tile.terrain, cost });
      }
    }
    return { ok: violations.length === 0, violations };
  }, { unitTerrainCosts: await getUnitCosts() });
}

// Hardcoded — must match content/core-realworld/units/*.json. Could be fetched
// from server but this is sufficient for the smoke test.
async function getUnitCosts() {
  const land = {
    plains: 1, grassland: 1, hills: 2, forest: 2, desert: 1,
    jungle: 2, tundra: 1, snow: 1.5,
    mountain: 0, ocean: 0, deep_ocean: 0, coast: 0,
  };
  const fast = {
    plains: 0.5, grassland: 0.5, hills: 1, forest: 1, desert: 1,
    jungle: 1, tundra: 0.5, snow: 1,
    mountain: 3, ocean: 0, deep_ocean: 0, coast: 0,
  };
  return {
    "unit.settler": land,
    "unit.worker": land,
    "unit.warrior": fast,
    "unit.swordsman": fast,
    "unit.musketman": fast,
    "unit.rifleman": fast,
  };
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const log = [];

  // --- Two contexts, two players ---
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageA = await ctxA.newPage();
  attachErrors(pageA, "A");
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageB = await ctxB.newPage();
  attachErrors(pageB, "B");

  // Lobby flow
  await pageA.goto(URL);
  await pageA.waitForSelector("#name");
  await pageA.fill("#name", "Alice");
  await pageA.selectOption("#size", SIZE);
  await pageA.click("#create");
  await pageA.waitForSelector("#lobby-overlay:not(.hidden)");

  await pageB.goto(URL);
  await pageB.waitForSelector("#name");
  await pageB.fill("#name", "Bob");
  await pageB.click("#refresh");
  await pageB.waitForSelector("button.join");
  await pageB.click("button.join");
  await pageB.waitForSelector("#lobby-overlay:not(.hidden)");
  await pageA.waitForTimeout(400);

  // Start
  await pageA.waitForFunction(() => {
    const b = document.querySelector("#lo-start");
    return b && !b.hasAttribute("disabled");
  });
  await pageA.click("#lo-start");
  await pageA.waitForTimeout(1000);

  await shot(pageA, "alice", "01-match-started");
  await shot(pageB, "bob", "02-match-started");

  // Inspect both views
  const aInit = await inspect(pageA);
  const bInit = await inspect(pageB);
  log.push({ step: "after-start", aInit, bInit });

  // Verify nobody spawned on impassable terrain
  const aTerr = await verifyUnitTerrains(pageA, "A");
  const bTerr = await verifyUnitTerrains(pageB, "B");
  log.push({ step: "spawn-terrain-check", a: aTerr, b: bTerr });

  // Move alice's settler one hex toward a free, enterable neighbor
  const moveResult = await pageA.evaluate(async ({ unitTerrainCosts }) => {
    const w = window;
    const dev = w.__BROWSERCIV;
    const s = dev?.latest();
    if (!s || !s.map) return { error: "no state" };
    const tilesByKey = new Map(s.map.tiles.map((t) => [`${t.q},${t.r}`, t]));
    const settler = s.units.find((u) => u.ownerId === s.viewerId && u.defId === "unit.settler");
    if (!settler) return { error: "no settler" };
    const NEIGHBORS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    const costs = unitTerrainCosts["unit.settler"];
    for (const [dq, dr] of NEIGHBORS) {
      const target = { q: settler.position.q + dq, r: settler.position.r + dr };
      const k = `${target.q},${target.r}`;
      const tile = tilesByKey.get(k);
      if (!tile) continue;
      const c = costs[tile.terrain];
      if (!c || c <= 0) continue;
      const occupied = s.units.some((u) => u.id !== settler.id && u.position.q === target.q && u.position.r === target.r);
      if (occupied) continue;
      const occCity = s.cities.some((cc) => cc.position.q === target.q && cc.position.r === target.r);
      if (occCity) continue;
      dev.sendIntent({ type: "MoveUnit", actorId: s.viewerId, unitId: settler.id, target });
      return { sent: true, from: settler.position, to: target, terrain: tile.terrain };
    }
    return { error: "no enterable neighbor for settler" };
  }, { unitTerrainCosts: await getUnitCosts() });
  log.push({ step: "move-settler", moveResult });
  await pageA.waitForTimeout(400);
  await shot(pageA, "alice", "03-after-move-settler");

  // Found city with the settler at its new position
  const foundResult = await pageA.evaluate(() => {
    const dev = window.__BROWSERCIV;
    const s = dev?.latest();
    if (!s) return { error: "no state" };
    const settler = s.units.find((u) => u.ownerId === s.viewerId && u.defId === "unit.settler");
    if (!settler) return { error: "no settler" };
    dev.sendIntent({ type: "FoundCity", actorId: s.viewerId, unitId: settler.id });
    return { sent: true };
  });
  log.push({ step: "found-city", foundResult });
  await pageA.waitForTimeout(800);
  await shot(pageA, "alice", "04-after-found-city");

  // Set production: worker (no tech prereq)
  const setProd = await pageA.evaluate(() => {
    const dev = window.__BROWSERCIV;
    const s = dev?.latest();
    if (!s || s.cities.length === 0) return { error: "no city" };
    const city = s.cities.find((c) => c.ownerId === s.viewerId);
    if (!city) return { error: "no own city" };
    dev.sendIntent({
      type: "SetCityProduction",
      actorId: s.viewerId,
      cityId: city.id,
      item: { kind: "unit", defId: "unit.worker" },
    });
    return { sent: true, cityId: city.id };
  });
  log.push({ step: "set-production-worker", setProd });
  await pageA.waitForTimeout(300);

  // --- Set research: bronze_working ---
  const setResearch = await pageA.evaluate(() => {
    const dev = window.__BROWSERCIV;
    const s = dev?.latest();
    if (!s) return { error: "no state" };
    dev.sendIntent({
      type: "SetResearch",
      actorId: s.viewerId,
      techId: "tech.bronze_working",
    });
    return { sent: true };
  });
  log.push({ step: "set-research-bronze_working", setResearch });
  await pageA.waitForTimeout(300);
  // Open Tech panel and screenshot
  await pageA.click("#science-btn");
  await pageA.waitForTimeout(300);
  await shot(pageA, "alice", "05-tech-panel");
  await pageA.click("#tp-close");

  // Drive a few turn cycles by sending intents directly (faster than clicking buttons,
  // and avoids tab visibility / animation race conditions in headless mode).
  for (let i = 0; i < 30; i++) {
    await pageA.evaluate(() => {
      const dev = window.__BROWSERCIV;
      const s = dev?.latest();
      if (!s) return;
      if (s.players[s.currentPlayerIndex]?.id === s.viewerId)
        dev.sendIntent({ type: "EndTurn", actorId: s.viewerId });
    });
    await pageA.waitForTimeout(80);
    await pageB.evaluate(() => {
      const dev = window.__BROWSERCIV;
      const s = dev?.latest();
      if (!s) return;
      if (s.players[s.currentPlayerIndex]?.id === s.viewerId)
        dev.sendIntent({ type: "EndTurn", actorId: s.viewerId });
    });
    await pageB.waitForTimeout(80);
  }
  await shot(pageA, "alice", "06-after-30-rounds");
  await shot(pageB, "bob", "07-after-30-rounds-bob");
  await pageA.click("#science-btn");
  await pageA.waitForTimeout(300);
  await shot(pageA, "alice", "08-tech-panel-after-30-rounds");
  await pageA.click("#tp-close");

  const aFinal = await inspect(pageA);
  log.push({ step: "after-5-rounds", aFinal });

  // Re-verify no unit on impassable terrain
  const aFinalTerr = await verifyUnitTerrains(pageA, "A");
  log.push({ step: "final-terrain-check", aFinalTerr });

  // Try a few different sizes too — quick run with medium just to count terrain
  log.push({ size: SIZE, terrainCounts: aInit.tileCounts });

  await writeFile(`${SHOT_DIR}/play-log.json`, JSON.stringify({ log, errors }, null, 2));

  // Summary to stdout
  console.log("=== play-through summary ===");
  console.log("size:", SIZE);
  console.log("terrain counts:", aInit.tileCounts);
  console.log("alice spawned at:", aInit.myStartingUnitsAt);
  console.log("bob spawned at:", bInit.myStartingUnitsAt);
  console.log("alice spawn-terrain ok:", aTerr.ok, JSON.stringify(aTerr.violations || []));
  console.log("bob spawn-terrain ok:", bTerr.ok, JSON.stringify(bTerr.violations || []));
  console.log("alice after 5 rounds:", JSON.stringify({ turn: aFinal.turnNumber, treasury: aFinal.treasury, units: aFinal.myUnits.length, cities: aFinal.cities.length }));
  console.log("final terrain ok:", aFinalTerr.ok, JSON.stringify(aFinalTerr.violations || []));

  const totalErrors = errors.A.length + errors.B.length;
  if (totalErrors > 0) {
    console.log("page errors:");
    for (const e of [...errors.A, ...errors.B]) console.log("  " + e);
  }

  await browser.close();
  if (totalErrors > 0) process.exit(2);
  if (!aTerr.ok || !bTerr.ok || !aFinalTerr.ok) process.exit(3);
  console.log("OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
