"""Entry point for EC2 spot training. Reads config from env vars or CLI flags."""
import argparse
import asyncio
import json
import os

import aiohttp
import boto3
import numpy as np
import torch

from browserciv.env import GameEnv
from browserciv.model import ActorCritic
from browserciv.ppo import Rollout, ppo_update


# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="BrowserCiv PPO trainer")
    p.add_argument("--server",            default=os.environ.get("GAME_SERVER", "http://localhost:8787"))
    p.add_argument("--episodes",          type=int,   default=int(os.environ.get("EPISODES", "1000")))
    p.add_argument("--max-turns",         type=int,   default=int(os.environ.get("MAX_TURNS", "500")))
    p.add_argument("--lr",                type=float, default=float(os.environ.get("LR", "3e-4")))
    p.add_argument("--hidden",            default=os.environ.get("HIDDEN", "256,128"))
    p.add_argument("--map-size",          default=os.environ.get("MAP_SIZE", "small"))
    p.add_argument("--opponent-strategy", default=os.environ.get("OPPONENT_STRATEGY", "random"))
    p.add_argument("--s3-bucket",         default=os.environ.get("MODEL_BUCKET", ""))
    p.add_argument("--model-key",         default=os.environ.get("MODEL_KEY", "model.pt"))
    p.add_argument("--live-key",          default=os.environ.get("LIVE_KEY", ""))
    p.add_argument("--checkpoint-every",  type=int,   default=int(os.environ.get("CHECKPOINT_EVERY", "50")))
    p.add_argument("--step-delay",        type=float, default=float(os.environ.get("STEP_DELAY", "0")))
    return p.parse_args()


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------

def s3_download(bucket: str, key: str, local: str) -> bool:
    try:
        boto3.client("s3").download_file(bucket, key, local)
        print(f"[s3] downloaded s3://{bucket}/{key}")
        return True
    except Exception as e:
        print(f"[s3] download skipped ({e})")
        return False


def s3_upload(bucket: str, key: str, local: str):
    boto3.client("s3").upload_file(local, bucket, key)
    print(f"[s3] uploaded {local} → s3://{bucket}/{key}")


def s3_put_json(bucket: str, key: str, data: dict):
    boto3.client("s3").put_object(
        Bucket=bucket, Key=key,
        Body=json.dumps(data).encode(),
        ContentType="application/json",
    )


# ---------------------------------------------------------------------------
# Checkpoint helpers
# ---------------------------------------------------------------------------

CKPT_PATH = "/tmp/model.pt"


def load_ckpt(model: ActorCritic, optimizer: torch.optim.Optimizer) -> int:
    if not os.path.exists(CKPT_PATH):
        return 0
    ckpt = torch.load(CKPT_PATH, map_location="cpu")
    model.load_state_dict(ckpt["model"])
    optimizer.load_state_dict(ckpt["optimizer"])
    ep = ckpt.get("episode", 0)
    print(f"[ckpt] resumed from episode {ep}")
    return ep


def save_ckpt(model: ActorCritic, optimizer: torch.optim.Optimizer, episode: int):
    torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict(), "episode": episode}, CKPT_PATH)


# ---------------------------------------------------------------------------
# Match setup via game server
# ---------------------------------------------------------------------------

_HTTP_TIMEOUT = aiohttp.ClientTimeout(total=30)


async def train_setup(http_url: str, map_size: str, strategy: str) -> dict:
    async with aiohttp.ClientSession(timeout=_HTTP_TIMEOUT) as sess:
        async with sess.post(
            f"{http_url}/train-setup",
            json={"mapSize": map_size, "strategy": strategy},
        ) as r:
            r.raise_for_status()
            return await r.json()


async def train_start(http_url: str, match_id: str, agent_token: str, opponent_id: str, strategy: str):
    async with aiohttp.ClientSession(timeout=_HTTP_TIMEOUT) as sess:
        async with sess.post(
            f"{http_url}/train-start",
            json={
                "matchId": match_id,
                "agentToken": agent_token,
                "opponentId": opponent_id,
                "strategy": strategy,
                "noFog": False,
            },
        ) as r:
            r.raise_for_status()


# ---------------------------------------------------------------------------
# Episode runner
# ---------------------------------------------------------------------------

async def run_episode(
    env: GameEnv,
    model: ActorCritic,
    max_turns: int,
    device: torch.device,
    on_turn=None,
    step_delay: float = 0.0,
) -> tuple[Rollout, dict]:
    rollout = Rollout()
    obs, mask = await env.reset()
    total_reward = 0.0
    turns = 0

    for _ in range(max_turns):
        obs_t  = torch.tensor(obs,  dtype=torch.float32, device=device).unsqueeze(0)
        mask_t = torch.tensor(mask, dtype=torch.float32, device=device).unsqueeze(0)

        with torch.no_grad():
            action, log_prob, value = model.get_action(obs_t, mask_t)

        next_obs, next_mask, reward, done, info = await env.step(action.item())
        rollout.add(obs, mask, action.item(), log_prob.item(), value.item(), reward, done)
        total_reward += reward
        turns += 1
        obs, mask = next_obs, next_mask

        if on_turn:
            on_turn(turns, total_reward, info.get("kills", 0))

        if step_delay > 0:
            await asyncio.sleep(step_delay)

        if done:
            break

    return rollout, {
        "total_reward": total_reward,
        "turns": turns,
        "kills": info.get("kills", 0),
        "outcome": info.get("outcome", {}),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def ws_url(http_url: str) -> str:
    return http_url.replace("https://", "wss://").replace("http://", "ws://")


async def async_main():
    args = parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[train] device={device}  server={args.server}")

    hidden = [int(x) for x in args.hidden.split(",")]
    model = ActorCritic(hidden=hidden).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    if args.s3_bucket:
        s3_download(args.s3_bucket, args.model_key, CKPT_PATH)
    start_ep = load_ckpt(model, optimizer)

    records: list[dict] = []
    total_episodes = start_ep + args.episodes

    for ep in range(start_ep, total_episodes):
        # Each episode creates a fresh match via the game server
        print(f"[train] episode {ep}: calling train-setup …")
        setup = await train_setup(args.server, args.map_size, args.opponent_strategy)

        match_id = setup["matchId"]
        agent_token = setup["agentToken"]["token"]
        viewer_id   = setup["agentToken"]["playerId"]
        spectator_token = setup["spectatorToken"]["token"]
        opponent_id = setup["opponentId"]
        strategy    = setup.get("strategy", args.opponent_strategy)

        # Write initial live.json so sim-server picks up spectator token immediately
        if args.s3_bucket and args.live_key:
            s3_put_json(args.s3_bucket, args.live_key, {
                "episode": ep,
                "totalEpisodes": total_episodes,
                "turn": 0,
                "maxTurns": args.max_turns,
                "reward": 0.0,
                "matchId": match_id,
                "spectatorToken": spectator_token,
                "agentPlayerId": viewer_id,
                "cumKills": 0,
                "cumCaptures": 0,
                "done": False,
            })

        await train_start(args.server, match_id, agent_token, opponent_id, strategy)

        env = GameEnv(ws_url(args.server), agent_token, viewer_id)
        await env.connect()

        cumulative_reward = 0.0

        def on_turn(turn: int, reward: float, kills: int = 0):
            nonlocal cumulative_reward
            cumulative_reward = reward
            if args.s3_bucket and args.live_key and turn % 5 == 0:
                # Write every 5 turns to stay responsive without hammering S3
                try:
                    s3_put_json(args.s3_bucket, args.live_key, {
                        "episode": ep,
                        "totalEpisodes": total_episodes,
                        "turn": turn,
                        "maxTurns": args.max_turns,
                        "reward": round(reward, 3),
                        "matchId": match_id,
                        "spectatorToken": spectator_token,
                        "agentPlayerId": viewer_id,
                        "cumKills": kills,
                        "cumCaptures": 0,
                        "done": False,
                    })
                except Exception:
                    pass  # don't let S3 writes interrupt training

        rollout, ep_info = await run_episode(env, model, args.max_turns, device, on_turn=on_turn, step_delay=args.step_delay)
        await env.close()

        stats: dict = {}
        if len(rollout) > 0:
            stats = ppo_update(model, optimizer, rollout, device=device)

        winner_id = ep_info["outcome"].get("winnerId")
        if not winner_id:
            outcome = "DRAW"
        elif winner_id == viewer_id:
            outcome = "WON"
        else:
            outcome = "LOST"

        rec = {
            "episode": ep,
            "outcome": outcome,
            "reward": round(ep_info["total_reward"], 3),
            "turns": ep_info["turns"],
            "kills": ep_info["kills"],
            "captures": 0,
            **{k: round(v, 5) for k, v in stats.items()},
        }
        records.append(rec)
        print(
            f"ep={ep:4d}  reward={rec['reward']:+.2f}  turns={rec['turns']:4d}  "
            f"kills={rec['kills']}  policy_loss={stats.get('policy_loss', 0):.4f}  "
            f"entropy={stats.get('entropy', 0):.4f}"
        )

        if args.s3_bucket and (ep + 1) % args.checkpoint_every == 0:
            save_ckpt(model, optimizer, ep + 1)
            s3_upload(args.s3_bucket, args.model_key, CKPT_PATH)
            s3_put_json(args.s3_bucket, args.model_key + ".progress.json", {
                "episode": ep + 1,
                "totalEpisodes": total_episodes,
                "done": False,
                "recent": records[-args.checkpoint_every:],
            })

    # Final save
    save_ckpt(model, optimizer, total_episodes)
    if args.s3_bucket:
        s3_upload(args.s3_bucket, args.model_key, CKPT_PATH)
        s3_put_json(args.s3_bucket, args.model_key + ".progress.json", {
            "episode": total_episodes,
            "totalEpisodes": total_episodes,
            "done": True,
            "records": records,
        })
        if args.live_key:
            s3_put_json(args.s3_bucket, args.live_key, {
                "episode": total_episodes,
                "totalEpisodes": total_episodes,
                "turn": 0,
                "maxTurns": args.max_turns,
                "reward": records[-1]["reward"] if records else 0.0,
                "matchId": None,
                "spectatorToken": None,
                "done": True,
            })

    print("[train] done")


def main():
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
