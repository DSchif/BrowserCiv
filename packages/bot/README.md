# @browserciv/bot

A standalone bot runner for BrowserCiv. Connects to the game server as a real
player over WebSocket, receives the same per-player `MatchView` a human client
sees, and sends back intents.

## Quick start

```bash
# Terminal 1 — game server
pnpm dev:server

# Terminal 2 — bot creates a match and waits for a human (or second bot)
pnpm --filter @browserciv/bot start -- --create --name BotAlpha --wait-for-human --verbose

# Terminal 2b — OR run two bots against each other
pnpm --filter @browserciv/bot start -- --create --name BotAlpha --verbose &
pnpm --filter @browserciv/bot start -- --match <id-from-above> --name BotBeta --verbose
```

## Strategies

| `--strategy` | Description |
|---|---|
| `random` | Makes random but legal moves (default) |
| `http`   | Delegates to an external HTTP server |

## HTTP brain server

With `--strategy http`, the bot POSTs every turn to `--http-url` (default
`http://localhost:5050/step`).

**Request body:**
```json
{ "state": <MatchView>, "playerId": "<string>" }
```

**Expected response:**
```json
{ "intent": <Intent> | null }
```

`null` means "skip this cycle" — the bot will call again on the next snapshot.
Any valid `Intent` from the shared protocol is accepted.

### Minimal Python example

```python
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route("/step", methods=["POST"])
def step():
    body = request.json
    state = body["state"]
    player_id = body["playerId"]
    # TODO: your model here
    return jsonify({"intent": {"type": "EndTurn", "actorId": player_id}})

app.run(port=5050)
```

## Training log

Pass `--log /tmp/game.jsonl` to write one JSONL line per (state, intent) pair:

```json
{
  "episode": 0,
  "step": 42,
  "playerId": "abc123",
  "state": { ... },
  "intent": { "type": "MoveUnit", ... },
  "reward": 3.0
}
```

The reward is a simple scalar: `Δgold + 2×Δscience + Δculture`. You can compute
your own reward offline from the state fields.

## Options

```
--server    <url>   Server base URL         (default: http://localhost:8787)
--match     <id>    Match to join
--create            Create a new match
--name      <str>   Bot player name         (default: Bot)
--size      <str>   Map size (create only)  (default: small)
--no-fog            No fog of war (create only)
--strategy  <str>   random | http           (default: random)
--http-url  <url>   HTTP brain URL          (default: http://localhost:5050/step)
--log       <path>  JSONL training log path
--episode   <n>     Episode number in log   (default: 0)
--verbose           Print turn-by-turn debug output
--wait-for-human    Wait for ≥2 players before sending MatchStart
```
