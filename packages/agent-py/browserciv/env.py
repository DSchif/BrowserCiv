import asyncio
import json
import os
import numpy as np
import websockets
import websockets.exceptions

from .constants import ACT_DIM, OBS_DIM
from .encoder import encode_state, decode_action


REWARD_WIN  = float(os.environ.get("REWARD_WIN",   "10.0"))
REWARD_LOSE = float(os.environ.get("REWARD_LOSE", "-10.0"))
REWARD_CITY = float(os.environ.get("REWARD_CITY",   "2.0"))
REWARD_TECH = float(os.environ.get("REWARD_TECH",   "0.5"))
REWARD_KILL = float(os.environ.get("REWARD_KILL",   "1.0"))
REWARD_UNIT = float(os.environ.get("REWARD_UNIT",   "0.3"))
REWARD_TURN = float(os.environ.get("REWARD_TURN",  "-0.01"))

_RECV_TIMEOUT = 30.0   # seconds before we assume the game server is stuck
_MAX_REJECTS  = 10     # consecutive IntentRejects before we abort the step


class GameEnv:
    def __init__(self, server_url: str, match_token: str, viewer_id: str):
        self.server_url = server_url  # e.g. "ws://localhost:8787"
        self.match_token = match_token
        self.viewer_id = viewer_id
        self._ws = None
        self._state: dict | None = None
        self._prev_cities = 0
        self._prev_techs = 0
        self._prev_units = 0
        self._kills = 0
        self._prev_enemy_ids: set[str] = set()
        self._client_seq = 0

    async def connect(self):
        url = f"{self.server_url}/ws?token={self.match_token}"
        # ping_interval keeps the connection alive through ALB's 60s idle timeout
        self._ws = await websockets.connect(url, ping_interval=20, ping_timeout=30)
        self._state = await self._recv_snapshot()

    async def reset(self) -> tuple[np.ndarray, np.ndarray]:
        assert self._state is not None
        player = self._my_player()
        self._prev_cities = len([c for c in self._state["cities"] if c["ownerId"] == self.viewer_id])
        self._prev_techs = len(player.get("researchedTechs", []))
        self._prev_units = len([u for u in self._state["units"] if u["ownerId"] == self.viewer_id])
        self._kills = 0
        self._prev_enemy_ids = {u["id"] for u in self._state["units"] if u["ownerId"] != self.viewer_id}
        return encode_state(self._state)

    async def step(self, action: int) -> tuple[np.ndarray, np.ndarray, float, bool, dict]:
        intent = decode_action(action, self._state, self.viewer_id)
        if intent is None:
            intent = {"type": "EndTurn", "actorId": self.viewer_id}

        self._client_seq += 1
        msg_out = {"type": "Intent", "intent": intent, "clientSeq": self._client_seq}
        await self._ws.send(json.dumps(msg_out))

        reward = REWARD_TURN
        done = False
        info: dict = {}
        reject_count = 0

        while True:
            msg = await self._recv_raw()
            if msg is None:
                print(f"[env] WS timeout/disconnect after {_RECV_TIMEOUT}s (viewer={self.viewer_id[:8]})", flush=True)
                done = True
                break

            t = msg.get("type")
            if t == "Snapshot":
                reject_count = 0
                self._state = msg["state"]
                player = self._my_player()
                new_cities = len([c for c in self._state["cities"] if c["ownerId"] == self.viewer_id])
                new_techs = len(player.get("researchedTechs", []))
                new_units = len([u for u in self._state["units"] if u["ownerId"] == self.viewer_id])
                new_enemy_ids = {u["id"] for u in self._state["units"] if u["ownerId"] != self.viewer_id}
                kills_this_step = len(self._prev_enemy_ids - new_enemy_ids)
                reward += REWARD_CITY * (new_cities - self._prev_cities)
                reward += REWARD_TECH * (new_techs - self._prev_techs)
                reward += REWARD_UNIT * max(0, new_units - self._prev_units)
                reward += REWARD_KILL * kills_this_step
                self._kills += kills_this_step
                self._prev_cities = new_cities
                self._prev_techs = new_techs
                self._prev_units = new_units
                self._prev_enemy_ids = new_enemy_ids

                # Game over: status == "finished"
                if self._state.get("status") == "finished":
                    done = True
                    winner = self._state.get("winnerId")
                    reward += REWARD_WIN if winner == self.viewer_id else REWARD_LOSE
                    info["outcome"] = {"winnerId": winner}
                    break

                # Our turn again
                players = self._state.get("players", [])
                cur = self._state.get("currentPlayerIndex", 0)
                if players and players[cur]["id"] == self.viewer_id:
                    break

            elif t == "IntentReject":
                reject_count += 1
                if reject_count >= _MAX_REJECTS:
                    # Consecutive rejects likely mean we're in a broken state — end episode
                    print(f"[env] {reject_count} consecutive IntentRejects, ending episode", flush=True)
                    done = True
                    break
                # Fall back to EndTurn so the episode keeps moving
                self._client_seq += 1
                fallback = {"type": "Intent", "intent": {"type": "EndTurn", "actorId": self.viewer_id}, "clientSeq": self._client_seq}
                await self._ws.send(json.dumps(fallback))

        info["kills"] = self._kills
        if done:
            obs = np.zeros(OBS_DIM, dtype=np.float32)
            mask = np.zeros(ACT_DIM, dtype=np.float32)
        else:
            obs, mask = encode_state(self._state)

        return obs, mask, reward, done, info

    async def close(self):
        if self._ws:
            try:
                await asyncio.wait_for(self._ws.close(), timeout=5.0)
            except Exception:
                pass
            self._ws = None

    # ------------------------------------------------------------------
    def _my_player(self) -> dict:
        return next((p for p in self._state.get("players", []) if p["id"] == self.viewer_id), {})

    async def _recv_snapshot(self) -> dict:
        while True:
            try:
                raw = await asyncio.wait_for(self._ws.recv(), timeout=30.0)
            except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
                raise RuntimeError("timed out waiting for initial Snapshot")
            msg = json.loads(raw)
            if msg.get("type") == "Snapshot" and msg.get("state"):
                return msg["state"]

    async def _recv_raw(self) -> dict | None:
        try:
            raw = await asyncio.wait_for(self._ws.recv(), timeout=_RECV_TIMEOUT)
            return json.loads(raw)
        except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
            return None
