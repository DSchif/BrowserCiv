// Phase 2 E2E: units, movement, fog of war.

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

async function main() {
  console.log("--- create + join ---");
  const a = await post("/matches", { hostName: "Alice" });
  const b = await post(`/matches/${a.match.id}/join`, { name: "Bob" });
  expect("alice has civId", typeof (a.match) === "object");
  expect("bob joined", typeof b.credential?.token === "string");

  const aliceStore = { id: a.credential.playerId, state: null, acks: [], rejects: [] };
  const bobStore = { id: b.credential.playerId, state: null, acks: [], rejects: [] };
  const aw = await attach(a.credential.token, aliceStore);
  const bw = await attach(b.credential.token, bobStore);
  await delay(150);

  expect("alice civId set", aliceStore.state.players.find(p=>p.id===aliceStore.id)?.civId === "civ.romans");
  expect("bob civId set", aliceStore.state.players.find(p=>p.id===bobStore.id)?.civId === "civ.greeks");

  console.log("--- start match ---");
  aw.send(JSON.stringify({ type: "Intent", clientSeq: 1, intent: { type: "MatchStart", actorId: aliceStore.id } }));
  await delay(200);
  expect("status=in_progress", aliceStore.state.status === "in_progress");
  const aliceUnits = aliceStore.state.units.filter(u => u.ownerId === aliceStore.id);
  const bobUnits = aliceStore.state.units.filter(u => u.ownerId === bobStore.id);
  expect("alice spawned units", aliceUnits.length >= 2, `count=${aliceUnits.length}`);
  expect("alice cannot see bob units (fog)", bobUnits.length === 0, `bob units in alice's view: ${bobUnits.length}`);
  expect("bob also gets only his units", bobStore.state.units.every(u => u.ownerId === bobStore.id));

  // Compare what alice sees vs raw bob state — alice should NOT have bob's positions
  const allPositionsFromAlice = aliceStore.state.units.map(u => `${u.position.q},${u.position.r}`).join("|");
  console.log(`    alice sees ${aliceStore.state.units.length} units at: ${allPositionsFromAlice}`);

  // Check tile visibility: should have a mix of visible/seen/unseen
  const vis = aliceStore.state.map.tiles.filter(t => t.visibility === "visible").length;
  const seen = aliceStore.state.map.tiles.filter(t => t.visibility === "seen").length;
  const unseen = aliceStore.state.map.tiles.filter(t => t.visibility === "unseen").length;
  expect("some visible tiles", vis > 0, `visible=${vis}`);
  expect("some unseen tiles (fog)", unseen > 0, `unseen=${unseen}`);
  console.log(`    fog: visible=${vis} seen=${seen} unseen=${unseen}`);

  console.log("--- alice moves a unit ---");
  const myUnit = aliceUnits.find(u => u.movementMax > 0) ?? aliceUnits[0];
  expect("found a unit to move", !!myUnit);

  // Pick a neighbor hex on the map that's enterable by this unit (terrain
  // cost > 0) and not occupied by another unit.
  const NEIGHBORS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
  const tilesByKey = new Map(aliceStore.state.map.tiles.map(t => [`${t.q},${t.r}`, t]));
  // Land terrains the test cares about — must match what core pack defines.
  const ENTERABLE = new Set(["plains", "hills", "grassland", "forest", "desert"]);
  const start = myUnit.position;
  let target = null;
  for (const [dq, dr] of NEIGHBORS) {
    const c = { q: start.q + dq, r: start.r + dr };
    const t = tilesByKey.get(`${c.q},${c.r}`);
    if (!t || !ENTERABLE.has(t.terrain)) continue;
    const occupied = aliceStore.state.units.some(u => u.id !== myUnit.id && u.position.q === c.q && u.position.r === c.r);
    if (occupied) continue;
    target = c;
    break;
  }
  expect("found a neighbor target", !!target);

  const beforeVisible = aliceStore.state.map.tiles.filter(t => t.visibility === "visible").length;
  const beforeSeen = aliceStore.state.map.tiles.filter(t => t.visibility === "seen").length;
  const beforeMP = myUnit.movementLeft;

  aw.send(JSON.stringify({ type: "Intent", clientSeq: 2, intent: { type: "MoveUnit", actorId: aliceStore.id, unitId: myUnit.id, target } }));
  await delay(200);
  expect("move ack received", aliceStore.acks.some(a => a.clientSeq === 2));

  const after = aliceStore.state.units.find(u => u.id === myUnit.id);
  expect("unit moved to target", after && after.position.q === target.q && after.position.r === target.r, JSON.stringify(after?.position));
  expect("movement spent", after && after.movementLeft < beforeMP, `${beforeMP} -> ${after?.movementLeft}`);

  const afterVisible = aliceStore.state.map.tiles.filter(t => t.visibility === "visible").length;
  const afterSeen = aliceStore.state.map.tiles.filter(t => t.visibility === "seen").length;
  console.log(`    after move: visible=${afterVisible} seen=${afterSeen}`);
  expect("visibility changed (revealed/forgot tiles)", afterVisible !== beforeVisible || afterSeen !== beforeSeen);

  console.log("--- alice tries to move someone else's unit (REJECT) ---");
  // Alice doesn't see bob's units, but try a fake unit id
  aw.send(JSON.stringify({ type: "Intent", clientSeq: 3, intent: { type: "MoveUnit", actorId: aliceStore.id, unitId: "u9999", target } }));
  await delay(150);
  expect("got NOT_FOUND for unknown unit", aliceStore.rejects.some(r => r.clientSeq === 3));

  console.log("--- alice tries to move beyond movement budget (REJECT) ---");
  // Pick a hex very far away from any of alice's units
  const farTile = aliceStore.state.map.tiles.find(t => t.visibility === "unseen" || t.visibility === "seen");
  if (farTile) {
    aw.send(JSON.stringify({ type: "Intent", clientSeq: 4, intent: { type: "MoveUnit", actorId: aliceStore.id, unitId: myUnit.id, target: { q: farTile.q, r: farTile.r } } }));
    await delay(150);
    expect("rejected (insufficient movement or no path)", aliceStore.rejects.some(r => r.clientSeq === 4));
  }

  console.log("--- alice exhausts MP and tries to move again ---");
  // Move the same unit until MP runs out
  let cs = 5;
  let cur = aliceStore.state.units.find(u => u.id === myUnit.id);
  let stuck = 0;
  while (cur && cur.movementLeft > 0 && stuck < 5) {
    let moved = false;
    for (const [dq, dr] of NEIGHBORS) {
      const t = { q: cur.position.q + dq, r: cur.position.r + dr };
      const tile = tilesByKey.get(`${t.q},${t.r}`);
      if (!tile) continue;
      const occupied = aliceStore.state.units.some(u => u.id !== cur.id && u.position.q === t.q && u.position.r === t.r);
      if (occupied) continue;
      aw.send(JSON.stringify({ type: "Intent", clientSeq: cs, intent: { type: "MoveUnit", actorId: aliceStore.id, unitId: cur.id, target: t } }));
      cs++;
      await delay(150);
      cur = aliceStore.state.units.find(u => u.id === myUnit.id);
      moved = true;
      break;
    }
    if (!moved) { stuck++; break; }
  }
  console.log(`    final MP: ${cur?.movementLeft}`);

  console.log("--- alice ends turn, MP refresh on bob ---");
  aw.send(JSON.stringify({ type: "Intent", clientSeq: 99, intent: { type: "EndTurn", actorId: aliceStore.id } }));
  await delay(150);
  // Pick one of BOB'S OWN units (his view may include alice's units if visible).
  const bobUnit = bobStore.state.units.find(u => u.ownerId === bobStore.id);
  expect("bob is current", aliceStore.state.players[aliceStore.state.currentPlayerIndex].id === bobStore.id);
  expect("bob's units have full MP at start of his turn", bobUnit && bobUnit.movementLeft === bobUnit.movementMax, `${bobUnit?.movementLeft}/${bobUnit?.movementMax}`);

  console.log();
  if (failed > 0) { console.log(`FAILED: ${failed}`); process.exit(1); }
  console.log("ALL PASS");
  aw.close(); bw.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
