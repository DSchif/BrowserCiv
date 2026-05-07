// Live browser smoke test using Playwright. Drives two contexts through
// Create→Join→Start, captures screenshots and console errors. Reads
// screenshots are placed in /tmp/browserciv-shots/ for visual inspection.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const URL = process.env.URL ?? "http://localhost:5173";
const SHOT_DIR = "/tmp/browserciv-shots";

const errors1 = [];
const errors2 = [];

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  // --- Host (Alice) ---
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageA = await ctxA.newPage();
  pageA.on("console", (msg) => {
    if (msg.type() === "error") errors1.push(`[A console.error] ${msg.text()}`);
  });
  pageA.on("pageerror", (e) => errors1.push(`[A pageerror] ${e.message}`));
  pageA.on("requestfailed", (req) => {
    errors1.push(`[A requestfailed] ${req.url()} ${req.failure()?.errorText ?? ""}`);
  });

  await pageA.goto(URL);
  await pageA.waitForSelector('button[data-tab="register"]');
  await pageA.click('button[data-tab="register"]');
  await pageA.fill("#reg-username", `smkalice${Date.now()}`);
  await pageA.fill("#reg-password", "testpass");
  await pageA.click("#reg-submit");
  await pageA.waitForSelector("#name");
  await pageA.fill("#name", "Alice");
  await pageA.selectOption("#size", "small");
  await pageA.screenshot({ path: `${SHOT_DIR}/01-lobby-alice.png`, fullPage: true });
  await pageA.click("#create");
  await pageA.waitForSelector("#lobby-overlay:not(.hidden)");
  await pageA.waitForTimeout(500);
  await pageA.screenshot({ path: `${SHOT_DIR}/02-match-alice-lobby.png`, fullPage: true });

  // --- Joiner (Bob) ---
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("console", (msg) => {
    if (msg.type() === "error") errors2.push(`[B console.error] ${msg.text()}`);
  });
  pageB.on("pageerror", (e) => errors2.push(`[B pageerror] ${e.message}`));

  await pageB.goto(URL);
  await pageB.waitForSelector('button[data-tab="register"]');
  await pageB.click('button[data-tab="register"]');
  await pageB.fill("#reg-username", `smkbob${Date.now()}`);
  await pageB.fill("#reg-password", "testpass");
  await pageB.click("#reg-submit");
  await pageB.waitForSelector("#name");
  await pageB.fill("#name", "Bob");
  await pageB.click("#refresh");
  await pageB.waitForSelector("button.join", { timeout: 5000 });
  await pageB.click("button.join");
  await pageB.waitForSelector("#lobby-overlay:not(.hidden)");
  await pageB.waitForTimeout(800);
  await pageA.waitForTimeout(800);
  await pageA.screenshot({ path: `${SHOT_DIR}/03-match-alice-with-bob.png`, fullPage: true });

  // --- Host starts ---
  // Wait for #start to be enabled
  await pageA.waitForFunction(
    () => {
      const btn = document.querySelector("#lo-start");
      return btn && !btn.hasAttribute("disabled");
    },
    { timeout: 10000 },
  );
  await pageA.click("#lo-start");
  await pageA.waitForTimeout(1500);
  await pageB.waitForTimeout(1500);
  await pageA.screenshot({ path: `${SHOT_DIR}/04-match-started-alice.png`, fullPage: true });
  await pageB.screenshot({ path: `${SHOT_DIR}/05-match-started-bob.png`, fullPage: true });

  // --- Inspect Alice's view, then drive a FoundCity intent through the dev hook ---
  const inspect = await pageA.evaluate(() => {
    const w = window;
    const dev = w.__BROWSERCIV;
    const s = dev?.latest();
    if (!s) return { error: "no state" };
    const ownUnits = s.units
      .filter((u) => u.ownerId === s.viewerId)
      .map((u) => ({ id: u.id, defId: u.defId, q: u.position.q, r: u.position.r }));
    return {
      viewerId: s.viewerId,
      status: s.status,
      ownUnits,
      cityCount: s.cities.length,
      visibleTiles: s.map?.tiles.filter((t) => t.visibility === "visible").length ?? 0,
    };
  });
  console.log("alice inspect:", JSON.stringify(inspect));

  // Found city with the settler
  const foundResult = await pageA.evaluate(() => {
    const w = window;
    const dev = w.__BROWSERCIV;
    const s = dev?.latest();
    if (!s) return { error: "no state" };
    const settler = s.units.find(
      (u) => u.ownerId === s.viewerId && u.defId === "unit.settler",
    );
    if (!settler) return { error: "no settler" };
    dev.selectUnit(settler.id);
    dev.sendIntent({
      type: "FoundCity",
      actorId: s.viewerId,
      unitId: settler.id,
    });
    return { sent: true, settlerId: settler.id };
  });
  console.log("found result:", JSON.stringify(foundResult));
  await pageA.waitForTimeout(800);
  await pageB.waitForTimeout(800);

  await pageA.screenshot({ path: `${SHOT_DIR}/06-after-found-city-alice.png`, fullPage: true });
  await pageB.screenshot({ path: `${SHOT_DIR}/07-after-found-city-bob.png`, fullPage: true });

  // Capture state after founding
  const stateA = await pageA.evaluate(() => {
    const w = window;
    const dev = w.__BROWSERCIV;
    const s = dev?.latest();
    if (!s) return null;
    return {
      cityCount: s.cities.length,
      cityName: s.cities[0]?.name,
      cityPosQ: s.cities[0]?.position.q,
      cityPosR: s.cities[0]?.position.r,
      ownedTiles: s.map?.tiles.filter((t) => t.ownerCityId).length ?? 0,
      visibleTiles: s.map?.tiles.filter((t) => t.visibility === "visible").length ?? 0,
    };
  });
  console.log("alice after found:", JSON.stringify(stateA));

  // --- End turn cycle, then a second cycle so production can tick ---
  if (await pageA.$('#end:not([disabled])')) {
    await pageA.click("#end");
    await pageA.waitForTimeout(400);
  }
  if (await pageB.$('#end:not([disabled])')) {
    await pageB.click("#end");
    await pageB.waitForTimeout(400);
  }
  await pageA.screenshot({ path: `${SHOT_DIR}/08-after-turn-cycle.png`, fullPage: true });

  await writeFile(
    `${SHOT_DIR}/run.log`,
    JSON.stringify(
      { inspect, foundResult, stateA, errors1, errors2 },
      null,
      2,
    ),
  );

  await browser.close();

  console.log(`screenshots in ${SHOT_DIR}`);
  if (errors1.length || errors2.length) {
    console.log("ERRORS:");
    for (const e of [...errors1, ...errors2]) console.log("  " + e);
    process.exit(1);
  }
  console.log("no console / page errors");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
