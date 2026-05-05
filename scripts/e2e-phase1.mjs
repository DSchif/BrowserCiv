// Phase 1 E2E: simulates two browser clients via REST + WebSocket.
// Uses Node 22's built-in WebSocket and fetch.

const SERVER = process.env.SERVER ?? "http://localhost:8787";

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

let failed = 0;
function expect(name, cond, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failed++;
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  console.log("--- create match (Alice) ---");
  const create = await fetch(`${SERVER}/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostName: "Alice" }),
  }).then((r) => r.json());
  expect("match created", !!create.match?.id);
  expect("alice has token", !!create.credential?.token);

  console.log("--- join (Bob) ---");
  const join = await fetch(`${SERVER}/matches/${create.match.id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Bob" }),
  }).then((r) => r.json());
  expect("bob joined", !!join.credential?.token);
  expect("playerCount=2", join.match.playerCount === 2);

  const aliceStore = { id: create.credential.playerId, state: null, acks: [], rejects: [] };
  const bobStore = { id: join.credential.playerId, state: null, acks: [], rejects: [] };

  function attach(token, store, label) {
    const ws = new WebSocket(`ws://localhost:8787/ws?token=${token}`);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "Snapshot") store.state = m.state;
      if (m.type === "IntentAck") store.acks.push(m);
      if (m.type === "IntentReject") store.rejects.push(m);
    });
    return new Promise((resolve) => ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "Hello", matchId: create.match.id, playerId: store.id, lastSeq: 0 }));
      resolve(ws);
    }));
  }

  console.log("--- both connect ---");
  const aliceWs = await attach(create.credential.token, aliceStore, "ALICE");
  const bobWs = await attach(join.credential.token, bobStore, "BOB");
  await delay(150);

  expect("alice received snapshot", !!aliceStore.state);
  expect("bob received snapshot", !!bobStore.state);
  expect("status=lobby", aliceStore.state?.status === "lobby");
  expect("alice connected=true on her view", aliceStore.state?.players.find(p=>p.id===aliceStore.id)?.connected === true);

  console.log("--- alice (host) starts match ---");
  aliceWs.send(JSON.stringify({ type: "Intent", clientSeq: 1, intent: { type: "MatchStart", actorId: aliceStore.id } }));
  await delay(200);
  expect("status=in_progress", aliceStore.state?.status === "in_progress");
  expect("turn=1", aliceStore.state?.turnNumber === 1);
  expect("alice active first", aliceStore.state?.players[aliceStore.state.currentPlayerIndex]?.id === aliceStore.id);
  expect("map generated", (aliceStore.state?.map?.tiles?.length ?? 0) > 100);
  const aliceStart = aliceStore.state?.players.find(p=>p.id===aliceStore.id)?.startingHex;
  const bobStart = aliceStore.state?.players.find(p=>p.id===bobStore.id)?.startingHex;
  expect("alice has starting hex", !!aliceStart, JSON.stringify(aliceStart));
  expect("bob has starting hex", !!bobStart, JSON.stringify(bobStart));
  expect("starts differ", aliceStart && bobStart && (aliceStart.q !== bobStart.q || aliceStart.r !== bobStart.r));

  console.log("--- bob attempts to start (should REJECT — not host) ---");
  bobWs.send(JSON.stringify({ type: "Intent", clientSeq: 1, intent: { type: "MatchStart", actorId: bobStore.id } }));
  await delay(150);
  expect("bob got reject for non-host start", bobStore.rejects.some(r => r.code === "BAD_STATE" || r.code === "NOT_HOST"));

  console.log("--- bob attempts EndTurn out-of-turn (should REJECT) ---");
  bobWs.send(JSON.stringify({ type: "Intent", clientSeq: 2, intent: { type: "EndTurn", actorId: bobStore.id } }));
  await delay(150);
  expect("bob got NOT_YOUR_TURN", bobStore.rejects.some(r => r.code === "NOT_YOUR_TURN"));

  console.log("--- alice ends turn ---");
  aliceWs.send(JSON.stringify({ type: "Intent", clientSeq: 2, intent: { type: "EndTurn", actorId: aliceStore.id } }));
  await delay(150);
  expect("bob now active", aliceStore.state?.players[aliceStore.state.currentPlayerIndex]?.id === bobStore.id);

  console.log("--- bob ends turn (should advance to turn 2) ---");
  bobWs.send(JSON.stringify({ type: "Intent", clientSeq: 3, intent: { type: "EndTurn", actorId: bobStore.id } }));
  await delay(150);
  expect("turn=2 after full cycle", aliceStore.state?.turnNumber === 2);
  expect("alice active again", aliceStore.state?.players[aliceStore.state.currentPlayerIndex]?.id === aliceStore.id);

  console.log("--- determinism check: same seed → same map ---");
  const seed = 12345;
  const a = await fetch(`${SERVER}/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName: "A", seed }) }).then(r=>r.json());
  await fetch(`${SERVER}/matches/${a.match.id}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "B" }) });
  const b = await fetch(`${SERVER}/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName: "A", seed }) }).then(r=>r.json());
  await fetch(`${SERVER}/matches/${b.match.id}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "B" }) });
  const aw = new WebSocket(`ws://localhost:8787/ws?token=${a.credential.token}`);
  const bw = new WebSocket(`ws://localhost:8787/ws?token=${b.credential.token}`);
  let aState = null, bState = null;
  aw.addEventListener("message", ev => { const m = JSON.parse(ev.data); if (m.type === "Snapshot") aState = m.state; });
  bw.addEventListener("message", ev => { const m = JSON.parse(ev.data); if (m.type === "Snapshot") bState = m.state; });
  await new Promise(r => aw.addEventListener("open", r));
  await new Promise(r => bw.addEventListener("open", r));
  await delay(100);
  aw.send(JSON.stringify({ type: "Intent", clientSeq: 1, intent: { type: "MatchStart", actorId: a.credential.playerId } }));
  bw.send(JSON.stringify({ type: "Intent", clientSeq: 1, intent: { type: "MatchStart", actorId: b.credential.playerId } }));
  await delay(200);
  const sameTiles = JSON.stringify(aState.map.tiles) === JSON.stringify(bState.map.tiles);
  expect("same seed yields same map", sameTiles);
  aw.close(); bw.close();

  aliceWs.close();
  bobWs.close();

  console.log();
  if (failed > 0) {
    console.log(`FAILED: ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("ALL PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
