// Phase 3 E2E: cities, production, gold, growth.
const SERVER = process.env.SERVER ?? "http://localhost:8787";
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
let failed = 0;
function expect(name, cond, detail = "") {
  if (!cond) failed++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
let authToken = null;
async function post(path, body) {
  const headers = { "content-type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const r = await fetch(SERVER + path, { method: "POST", headers, body: JSON.stringify(body) });
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
  const reg = await post("/account/register", { username: `e2e_p3_${Date.now()}`, password: "testpass" });
  authToken = reg.token;
  const a = await post("/matches", { hostName: "Alice" });
  const b = await post(`/matches/${a.match.id}/join`, { name: "Bob" });
  const aliceStore = { id: a.credential.playerId, state: null, acks: [], rejects: [] };
  const bobStore = { id: b.credential.playerId, state: null, acks: [], rejects: [] };
  const aw = await attach(a.credential.token, aliceStore);
  const bw = await attach(b.credential.token, bobStore);
  await delay(150);

  console.log("--- start match ---");
  send(aw, { type: "MatchStart", actorId: aliceStore.id }, 1);
  await delay(200);
  expect("status=in_progress", aliceStore.state.status === "in_progress");
  expect("alice has gold field", typeof aliceStore.state.players.find(p=>p.id===aliceStore.id).gold === "number");

  console.log("--- alice founds city with her settler ---");
  const settler = aliceStore.state.units.find(u => u.defId === "unit.settler");
  expect("alice has a settler", !!settler);
  send(aw, { type: "FoundCity", actorId: aliceStore.id, unitId: settler.id }, 2);
  await delay(200);
  expect("found ack", aliceStore.acks.some(a => a.clientSeq === 2));
  expect("alice has 1 city", aliceStore.state.cities.length === 1);
  expect("settler consumed", !aliceStore.state.units.some(u => u.id === settler.id));
  const city = aliceStore.state.cities[0];
  expect("city pop=1", city.population === 1);
  expect("city has worked tiles or yields", city.workedTiles.length >= 0 && (city.perTurnYields.food !== undefined || city.perTurnYields.production !== undefined));

  console.log("--- bob cannot see alice's city (fog) ---");
  expect("bob sees 0 cities", bobStore.state.cities.length === 0);

  console.log("--- alice sets production: worker (no tech prereq) ---");
  send(aw, { type: "SetCityProduction", actorId: aliceStore.id, cityId: city.id, item: { kind: "unit", defId: "unit.worker" } }, 3);
  await delay(150);
  const cAfter = aliceStore.state.cities[0];
  expect("production set", cAfter.productionItem?.defId === "unit.worker");

  console.log("--- alice ends turn, bob ends turn (cycle one round) ---");
  send(aw, { type: "EndTurn", actorId: aliceStore.id }, 4);
  await delay(150);
  send(bw, { type: "EndTurn", actorId: bobStore.id }, 1);
  await delay(150);
  expect("turn=2", aliceStore.state.turnNumber === 2);
  // After alice's economy processes at start of T2, prod should accumulate.
  const c2 = aliceStore.state.cities[0];
  expect("production accumulated", c2.production > 0, `production=${c2.production}`);

  console.log("--- advance turns until worker completes ---");
  let safety = 0;
  let workerCount = aliceStore.state.units.filter(u => u.ownerId === aliceStore.id && u.defId === "unit.worker").length;
  const initialWorkers = workerCount;
  while (workerCount === initialWorkers && safety++ < 80) {
    send(aw, { type: "EndTurn", actorId: aliceStore.id }, 100 + safety * 2);
    await delay(60);
    send(bw, { type: "EndTurn", actorId: bobStore.id }, 100 + safety * 2 + 1);
    await delay(60);
    workerCount = aliceStore.state.units.filter(u => u.ownerId === aliceStore.id && u.defId === "unit.worker").length;
  }
  expect("worker produced", workerCount > initialWorkers, `workers: ${initialWorkers} → ${workerCount}`);
  console.log(`    completed in ${safety} turns; alice has ${aliceStore.state.players.find(p=>p.id===aliceStore.id).gold} gold`);

  console.log("--- alice cannot found city with a worker (REJECT) ---");
  // Worker doesn't have settler trait, so FoundCity should reject.
  const worker = aliceStore.state.units.find(u => u.ownerId === aliceStore.id && u.defId === "unit.worker");
  if (worker) {
    send(aw, { type: "FoundCity", actorId: aliceStore.id, unitId: worker.id }, 999);
    await delay(150);
    expect("worker cannot found city", aliceStore.rejects.some(r => r.clientSeq === 999));
  }

  console.log("--- territory: alice's tiles have ownerCityId ---");
  const ownedTiles = aliceStore.state.map.tiles.filter(t => t.ownerCityId);
  expect("some tiles owned", ownedTiles.length > 0, `count=${ownedTiles.length}`);
  expect("owned by alice's city", ownedTiles.every(t => t.ownerCityId === city.id));

  aw.close(); bw.close();
  console.log();
  if (failed > 0) { console.log(`FAILED: ${failed}`); process.exit(1); }
  console.log("ALL PASS");
}
main().catch(e => { console.error(e); process.exit(1); });
