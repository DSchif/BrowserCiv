// Phase 4 E2E: research, tech-gating, unit evolution.
const SERVER = process.env.SERVER ?? "http://localhost:8787";
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
let failed = 0;
function expect(name, cond, detail = "") {
  if (!cond) failed++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
async function post(path, body) {
  const r = await fetch(SERVER + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
function attach(token, store) {
  const ws = new WebSocket(`ws://localhost:8787/ws?token=${token}`);
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "Snapshot") store.state = m.state;
    if (m.type === "IntentAck") store.acks.push(m);
    if (m.type === "IntentReject") store.rejects.push(m);
  });
  return new Promise((resolve) => ws.addEventListener("open", () => resolve(ws)));
}
function send(ws, intent, seq) {
  ws.send(JSON.stringify({ type: "Intent", clientSeq: seq, intent }));
}

async function main() {
  // Lobby + start
  const a = await post("/matches", { hostName: "Alice", mapSize: "small" });
  const b = await post(`/matches/${a.match.id}/join`, { name: "Bob" });
  const aliceStore = { id: a.credential.playerId, state: null, acks: [], rejects: [] };
  const bobStore = { id: b.credential.playerId, state: null, acks: [], rejects: [] };
  const aw = await attach(a.credential.token, aliceStore);
  const bw = await attach(b.credential.token, bobStore);
  await delay(150);
  send(aw, { type: "MatchStart", actorId: aliceStore.id }, 1);
  await delay(200);
  expect("status=in_progress", aliceStore.state.status === "in_progress");

  // Initial tech state — civs start with Agriculture per Civ V convention.
  const me0 = aliceStore.state.players.find(p => p.id === aliceStore.id);
  expect("alice starts with agriculture", Array.isArray(me0.researchedTechs) && me0.researchedTechs.includes("tech.agriculture"));
  expect("alice currentTech is null", me0.currentTech === null);
  expect("alice era is ancient", me0.era === "ancient");

  console.log("--- alice cannot build Swordsman before Iron Working ---");
  const settler = aliceStore.state.units.find(u => u.defId === "unit.settler");
  send(aw, { type: "FoundCity", actorId: aliceStore.id, unitId: settler.id }, 2);
  await delay(200);
  const city = aliceStore.state.cities[0];
  expect("city founded", !!city);

  send(aw, { type: "SetCityProduction", actorId: aliceStore.id, cityId: city.id, item: { kind: "unit", defId: "unit.swordsman" } }, 3);
  await delay(150);
  expect("swordsman production rejected (NOT_BUILDABLE)", aliceStore.rejects.some(r => r.clientSeq === 3 && r.code === "NOT_BUILDABLE"));

  console.log("--- alice researches mining → bronze_working → iron_working ---");
  send(aw, { type: "SetResearch", actorId: aliceStore.id, techId: "tech.mining" }, 4);
  await delay(150);
  expect("set research ack", aliceStore.acks.some(a => a.clientSeq === 4));
  expect("currentTech set to mining", aliceStore.state.players.find(p => p.id === aliceStore.id).currentTech === "tech.mining");

  // iron_working has prereq bronze_working which alice doesn't have
  send(aw, { type: "SetResearch", actorId: aliceStore.id, techId: "tech.iron_working" }, 5);
  await delay(150);
  expect("iron_working rejected (missing prereq)", aliceStore.rejects.some(r => r.clientSeq === 5 && r.code === "MISSING_PREREQ"));

  // Cycle through mining → bronze_working
  let cs = 100;
  let safety = 0;
  let pickedBronze = false;
  let researched = aliceStore.state.players.find(p => p.id === aliceStore.id).researchedTechs;
  while (!researched.includes("tech.bronze_working") && safety++ < 300) {
    if (aliceStore.state.players[aliceStore.state.currentPlayerIndex].id === aliceStore.id) {
      send(aw, { type: "EndTurn", actorId: aliceStore.id }, cs++);
      await delay(40);
    }
    if (aliceStore.state.players[aliceStore.state.currentPlayerIndex].id === bobStore.id) {
      send(bw, { type: "EndTurn", actorId: bobStore.id }, cs++);
      await delay(40);
    }
    researched = aliceStore.state.players.find(p => p.id === aliceStore.id).researchedTechs;
    if (!pickedBronze && researched.includes("tech.mining") && aliceStore.state.players.find(p => p.id === aliceStore.id).currentTech === null) {
      send(aw, { type: "SetResearch", actorId: aliceStore.id, techId: "tech.bronze_working" }, cs++);
      await delay(60);
      pickedBronze = true;
    }
  }
  expect("bronze_working researched", researched.includes("tech.bronze_working"), `cycles=${safety}`);

  console.log("--- alice can now build a Warrior (bronze_working unlocked spearman, but warrior is starting) ---");
  // Wait alice's turn
  while (aliceStore.state.players[aliceStore.state.currentPlayerIndex].id !== aliceStore.id) {
    send(bw, { type: "EndTurn", actorId: bobStore.id }, cs++);
    await delay(60);
  }
  send(aw, { type: "SetCityProduction", actorId: aliceStore.id, cityId: city.id, item: { kind: "unit", defId: "unit.warrior" } }, cs++);
  await delay(150);
  expect("warrior production accepted", aliceStore.state.cities[0].productionItem?.defId === "unit.warrior");

  // Pick iron_working
  send(aw, { type: "SetResearch", actorId: aliceStore.id, techId: "tech.iron_working" }, cs++);
  await delay(150);
  expect("iron_working accepted now", aliceStore.state.players.find(p => p.id === aliceStore.id).currentTech === "tech.iron_working");

  console.log("--- finish iron_working ---");
  safety = 0;
  while (!aliceStore.state.players.find(p => p.id === aliceStore.id).researchedTechs.includes("tech.iron_working") && safety++ < 600) {
    if (aliceStore.state.players[aliceStore.state.currentPlayerIndex].id === aliceStore.id) {
      send(aw, { type: "EndTurn", actorId: aliceStore.id }, cs++);
      await delay(20);
    }
    if (aliceStore.state.players[aliceStore.state.currentPlayerIndex].id === bobStore.id) {
      send(bw, { type: "EndTurn", actorId: bobStore.id }, cs++);
      await delay(20);
    }
  }
  expect("iron_working researched", aliceStore.state.players.find(p => p.id === aliceStore.id).researchedTechs.includes("tech.iron_working"));

  console.log("--- upgrade Warrior → Swordsman path ---");
  while (aliceStore.state.players[aliceStore.state.currentPlayerIndex].id !== aliceStore.id) {
    send(bw, { type: "EndTurn", actorId: bobStore.id }, cs++);
    await delay(40);
  }
  const myWarrior = aliceStore.state.units.find(u => u.ownerId === aliceStore.id && u.defId === "unit.warrior");
  expect("alice has at least one warrior to upgrade", !!myWarrior);
  if (myWarrior) {
    send(aw, { type: "UpgradeUnit", actorId: aliceStore.id, unitId: myWarrior.id }, cs++);
    await delay(150);
    const me = aliceStore.state.players.find(p => p.id === aliceStore.id);
    const goldOk = me.gold >= 60;
    if (goldOk) {
      const stillWarrior = aliceStore.state.units.find(u => u.id === myWarrior.id)?.defId === "unit.warrior";
      expect("warrior upgraded to swordsman", !stillWarrior);
    } else {
      expect("upgrade rejected (NEED_GOLD)", aliceStore.rejects.some(r => r.code === "NEED_GOLD"));
    }
  }

  aw.close(); bw.close();
  console.log();
  if (failed > 0) { console.log(`FAILED: ${failed}`); process.exit(1); }
  console.log("ALL PASS");
}
main().catch(e => { console.error(e); process.exit(1); });
