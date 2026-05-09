"""
Entry point for hybrid-model PPO training.
Reads config from env vars or CLI flags, same as train_main.py.

All ObsConfig flags can be set via:
  - CLI flags (--city-buildings, --no-unit-combat, ...)
  - OBS_CONFIG env var: JSON string of ObsConfig fields (takes priority)
"""
import argparse
import asyncio
import json
import os

import aiohttp
import boto3
import torch

from browserciv.hybrid_env import HybridGameEnv
from browserciv.hybrid_model import HybridActorCritic
from browserciv.obs_config import ObsConfig
from browserciv.ppo import Rollout, ppo_update


# ── Arg parsing ───────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="BrowserCiv Hybrid PPO trainer")
    # Server / training
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
    # ObsConfig feature flags
    p.add_argument("--no-unit-combat",   action="store_true", help="Disable unit combat stats in obs")
    p.add_argument("--no-unit-status",   action="store_true", help="Disable unit status (fortified etc)")
    p.add_argument("--no-enemy-combat",  action="store_true", help="Disable enemy combat stats")
    p.add_argument("--city-buildings",   action="store_true", help="Include 27-bit building multi-hot per city")
    p.add_argument("--no-tech-multihot", action="store_true", help="Disable tech multi-hot")
    p.add_argument("--use-cnn",          action="store_true", help="Enable global CNN map branch")
    return p.parse_args()


def _build_obs_config(args) -> ObsConfig:
    env_json = os.environ.get("OBS_CONFIG")
    if env_json:
        return ObsConfig.from_dict(json.loads(env_json))
    return ObsConfig(
        use_unit_combat_stats=not args.no_unit_combat,
        use_unit_status=not args.no_unit_status,
        use_enemy_combat_stats=not args.no_enemy_combat,
        use_city_buildings=args.city_buildings,
        use_tech_multihot=not args.no_tech_multihot,
        use_global_cnn=args.use_cnn,
    )


def _ws_url(http_url: str) -> str:
    return http_url.replace("https://", "wss://").replace("http://", "ws://")


# ── S3 helpers ────────────────────────────────────────────────────────────────

def _s3_download(bucket: str, key: str, local: str) -> bool:
    try:
        boto3.client("s3").download_file(bucket, key, local)
        print(f"[s3] downloaded {key}")
        return True
    except Exception as e:
        print(f"[s3] download skipped ({e})")
        return False


def _s3_upload(bucket: str, key: str, local: str):
    boto3.client("s3").upload_file(local, bucket, key)
    print(f"[s3] uploaded {local} → s3://{bucket}/{key}")


def _s3_put_json(bucket: str, key: str, data: dict):
    boto3.client("s3").put_object(
        Bucket=bucket, Key=key,
        Body=json.dumps(data).encode(),
        ContentType="application/json",
    )


# ── Checkpoint helpers ────────────────────────────────────────────────────────

CKPT_PATH = "/tmp/model.pt"


def _load_ckpt(model: HybridActorCritic, optimizer, obs_config: ObsConfig) -> int:
    if not os.path.exists(CKPT_PATH):
        return 0
    ckpt = torch.load(CKPT_PATH, map_location="cpu")
    saved = ckpt.get("obs_config")
    if saved and saved != obs_config.to_dict():
        raise ValueError(
            f"Checkpoint obs_config mismatch.\n"
            f"  saved  : {saved}\n"
            f"  current: {obs_config.to_dict()}"
        )
    model.load_state_dict(ckpt["model"])
    optimizer.load_state_dict(ckpt["optimizer"])
    ep = ckpt.get("episode", 0)
    print(f"[ckpt] resumed from episode {ep}")
    return ep


def _save_ckpt(model: HybridActorCritic, optimizer, episode: int, obs_config: ObsConfig):
    torch.save({
        "model":      model.state_dict(),
        "optimizer":  optimizer.state_dict(),
        "episode":    episode,
        "obs_config": obs_config.to_dict(),
    }, CKPT_PATH)


# ── Match setup ───────────────────────────────────────────────────────────────

_HTTP_TIMEOUT = aiohttp.ClientTimeout(total=30)


async def _train_setup(http_url: str, map_size: str, strategy: str) -> dict:
    async with aiohttp.ClientSession(timeout=_HTTP_TIMEOUT) as sess:
        async with sess.post(
            f"{http_url}/train-setup",
            json={"mapSize": map_size, "strategy": strategy},
        ) as r:
            r.raise_for_status()
            return await r.json()


async def _train_start(http_url: str, match_id: str, agent_token: str, opponent_id: str, strategy: str):
    async with aiohttp.ClientSession(timeout=_HTTP_TIMEOUT) as sess:
        async with sess.post(
            f"{http_url}/train-start",
            json={"matchId": match_id, "agentToken": agent_token,
                  "opponentId": opponent_id, "strategy": strategy, "noFog": False},
        ) as r:
            r.raise_for_status()


# ── Episode runner ────────────────────────────────────────────────────────────

async def _run_episode(
    env: HybridGameEnv,
    model: HybridActorCritic,
    max_turns: int,
    device: torch.device,
    on_turn=None,
    step_delay: float = 0.0,
) -> tuple[Rollout, dict]:
    rollout = Rollout()
    obs, mask = await env.reset()
    total_reward = 0.0
    turns = 0
    info: dict = {}

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
        "turns":        turns,
        "kills":        info.get("kills", 0),
        "outcome":      info.get("outcome", {}),
    }


# ── Main ──────────────────────────────────────────────────────────────────────

async def _async_main():
    args       = parse_args()
    obs_config = _build_obs_config(args)
    print(f"[hybrid] obs_config = {obs_config}")
    print(f"[hybrid] obs_dim    = {obs_config.obs_dim()}")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[hybrid] device={device}  server={args.server}")

    hidden = [int(x) for x in args.hidden.split(",")]
    model  = HybridActorCritic(obs_config, hidden=hidden).to(device)
    optim  = torch.optim.Adam(model.parameters(), lr=args.lr)

    if args.s3_bucket:
        _s3_download(args.s3_bucket, args.model_key, CKPT_PATH)
    start_ep = _load_ckpt(model, optim, obs_config)

    records: list[dict] = []
    total_episodes = start_ep + args.episodes

    for ep in range(start_ep, total_episodes):
        print(f"[hybrid] episode {ep}: calling train-setup …")
        setup  = await _train_setup(args.server, args.map_size, args.opponent_strategy)

        match_id        = setup["matchId"]
        agent_token     = setup["agentToken"]["token"]
        viewer_id       = setup["agentToken"]["playerId"]
        spectator_token = setup["spectatorToken"]["token"]
        opponent_id     = setup["opponentId"]
        strategy        = setup.get("strategy", args.opponent_strategy)

        if args.s3_bucket and args.live_key:
            _s3_put_json(args.s3_bucket, args.live_key, {
                "episode": ep, "totalEpisodes": total_episodes,
                "turn": 0, "maxTurns": args.max_turns, "reward": 0.0,
                "matchId": match_id, "spectatorToken": spectator_token,
                "agentPlayerId": viewer_id, "cumKills": 0, "cumCaptures": 0, "done": False,
            })

        await _train_start(args.server, match_id, agent_token, opponent_id, strategy)

        env = HybridGameEnv(_ws_url(args.server), agent_token, viewer_id, obs_config)
        await env.connect()

        cumulative_reward = 0.0

        def on_turn(turn: int, reward: float, kills: int = 0):
            nonlocal cumulative_reward
            cumulative_reward = reward
            if args.s3_bucket and args.live_key and turn % 2 == 0:
                try:
                    _s3_put_json(args.s3_bucket, args.live_key, {
                        "episode": ep, "totalEpisodes": total_episodes,
                        "turn": turn, "maxTurns": args.max_turns,
                        "reward": round(reward, 3),
                        "matchId": match_id, "spectatorToken": spectator_token,
                        "agentPlayerId": viewer_id, "cumKills": kills,
                        "cumCaptures": 0, "done": False,
                    })
                except Exception:
                    pass

        rollout, ep_info = await _run_episode(
            env, model, args.max_turns, device,
            on_turn=on_turn, step_delay=args.step_delay,
        )
        await env.close()

        stats = ppo_update(model, optim, rollout, device=device) if len(rollout) > 0 else {}

        winner_id = ep_info["outcome"].get("winnerId")
        outcome   = "WON" if winner_id == viewer_id else ("DRAW" if not winner_id else "LOST")
        rec = {
            "episode":  ep,
            "outcome":  outcome,
            "reward":   round(ep_info["total_reward"], 3),
            "turns":    ep_info["turns"],
            "kills":    ep_info["kills"],
            "captures": 0,
            **{k: round(v, 5) for k, v in stats.items()},
        }
        records.append(rec)
        print(
            f"ep={ep:4d}  reward={rec['reward']:+.2f}  turns={rec['turns']:4d}  "
            f"kills={rec['kills']}  "
            f"policy_loss={stats.get('policy_loss', 0):.4f}  "
            f"entropy={stats.get('entropy', 0):.4f}"
        )

        if args.s3_bucket and (ep + 1) % args.checkpoint_every == 0:
            _save_ckpt(model, optim, ep + 1, obs_config)
            _s3_upload(args.s3_bucket, args.model_key, CKPT_PATH)
            _s3_put_json(args.s3_bucket, args.model_key + ".progress.json", {
                "episode": ep + 1, "totalEpisodes": total_episodes,
                "done": False, "recent": records[-args.checkpoint_every:],
            })

    _save_ckpt(model, optim, total_episodes, obs_config)
    if args.s3_bucket:
        _s3_upload(args.s3_bucket, args.model_key, CKPT_PATH)
        _s3_put_json(args.s3_bucket, args.model_key + ".progress.json", {
            "episode": total_episodes, "totalEpisodes": total_episodes,
            "done": True, "records": records,
        })
        if args.live_key:
            _s3_put_json(args.s3_bucket, args.live_key, {
                "episode": total_episodes, "totalEpisodes": total_episodes,
                "turn": 0, "maxTurns": args.max_turns,
                "reward": records[-1]["reward"] if records else 0.0,
                "matchId": None, "spectatorToken": None, "done": True,
            })

    print("[hybrid] done")


def main():
    asyncio.run(_async_main())


if __name__ == "__main__":
    main()
