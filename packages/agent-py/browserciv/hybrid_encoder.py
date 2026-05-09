"""
Hybrid observation encoder.

Produces a flat float32 numpy array whose structure is determined by ObsConfig.
The model uses the same config to unpack the array into branches.
"""
from __future__ import annotations

import numpy as np

from .hybrid_constants import (
    GLOBAL_DIM_H, UNIT_FEAT_DIM, ENEMY_FEAT_DIM, CITY_FEAT_BASE, CITY_BLDG_DIM,
    N_TECHS_H, ALL_TECHS, TECH_IDX, MAP_H, MAP_W, MAP_C, MAP_OFFSET,
    MAX_MY_UNITS_H, MAX_ENEMY_UNITS_H, MAX_MY_CITIES_H, N_PROD_ITEMS,
    UNIT_DEF_IDX, N_UNIT_TYPES, UNIT_COMBAT_STATS, MAX_COMBAT_STRENGTH,
    BUILDING_IDX, N_BUILDINGS,
    TERRAIN_IDX, N_TERRAIN_TYPES,
    ERA_INDEX, HEX_NEIGHBORS,
    ACT_END_TURN, ACT_MOVE_START, ACT_FOUND_CITY_START, ACT_BUILD_IMP_START,
    ACT_RESEARCH_START, ACT_SET_PROD_START, ACT_DIM_H,
    PRODUCTION_UNITS,
)
from .obs_config import ObsConfig

_IMPASSABLE = {"ocean", "deep_ocean", "mountain"}


# ── Public API ────────────────────────────────────────────────────────────────

def hybrid_encode_state(state: dict, cfg: ObsConfig) -> tuple[np.ndarray, np.ndarray]:
    """Return (obs, mask) flat float32 arrays for the hybrid model."""
    viewer_id  = state["viewerId"]
    player     = next((p for p in state["players"] if p["id"] == viewer_id), {})
    opp        = next((p for p in state["players"] if p["id"] != viewer_id), {})
    my_units   = [u for u in state["units"]  if u["ownerId"] == viewer_id]
    enemy_units= [u for u in state["units"]  if u["ownerId"] != viewer_id]
    my_cities  = [c for c in state["cities"] if c["ownerId"] == viewer_id]
    researched = set(player.get("researchedTechs", []))

    obs = np.zeros(cfg.obs_dim(), dtype=np.float32)
    off = 0

    # ── Global ────────────────────────────────────────────────────────────
    g = obs[off:off + GLOBAL_DIM_H]
    total = _city_yield_totals(my_cities)
    g[0]  = _n(player.get("gold", 0), 500)
    g[1]  = _n(player.get("science", 0), 200)   # accumulated toward current tech
    g[2]  = _n(player.get("culture", 0), 200)
    g[3]  = ERA_INDEX.get(player.get("era", "ancient"), 0) / 4.0
    g[4]  = _n(len(my_units), MAX_MY_UNITS_H)
    g[5]  = _n(len(enemy_units), MAX_ENEMY_UNITS_H)
    g[6]  = _n(len(my_cities), MAX_MY_CITIES_H)
    g[7]  = _n(state.get("turnNumber", 0), 500)
    g[8]  = len(researched) / max(N_TECHS_H, 1)
    g[9]  = TECH_IDX.get(player.get("currentTech") or "", 0) / max(N_TECHS_H - 1, 1)
    g[10] = _n(opp.get("gold", 0), 500)
    g[11] = ERA_INDEX.get(opp.get("era", "ancient"), 0) / 4.0
    g[12] = _n(len(enemy_units), MAX_ENEMY_UNITS_H)
    g[13] = _n(total["gold"], 50)
    g[14] = _n(total["science"], 30)
    g[15] = _n(total["production"], 30)
    g[16] = _n(total["food"], 30)
    g[17] = _n(total["culture"], 20)
    g[18] = 1.0 if _is_at_war(state, viewer_id) else 0.0
    g[19] = _n(sum(c.get("population", 1) for c in my_cities), 50)
    g[20] = _n(opp.get("science", 0), 200)
    opp_cities = [c for c in state["cities"] if c["ownerId"] != viewer_id]
    g[21] = _n(len(opp_cities), MAX_MY_CITIES_H)
    # g[22], g[23] reserved
    off += GLOBAL_DIM_H

    # ── My units ──────────────────────────────────────────────────────────
    if cfg.use_my_units:
        for i in range(MAX_MY_UNITS_H):
            b = off + i * UNIT_FEAT_DIM
            if i < len(my_units):
                _enc_unit(obs, b, my_units[i], cfg)
        off += MAX_MY_UNITS_H * UNIT_FEAT_DIM

    # ── Enemy units ───────────────────────────────────────────────────────
    if cfg.use_enemy_units:
        for i in range(MAX_ENEMY_UNITS_H):
            b = off + i * ENEMY_FEAT_DIM
            if i < len(enemy_units):
                _enc_enemy(obs, b, enemy_units[i], cfg)
        off += MAX_ENEMY_UNITS_H * ENEMY_FEAT_DIM

    # ── My cities ─────────────────────────────────────────────────────────
    if cfg.use_my_cities:
        city_dim = cfg.city_feat_dim()
        for i in range(MAX_MY_CITIES_H):
            b = off + i * city_dim
            if i < len(my_cities):
                _enc_city(obs, b, my_cities[i], cfg)
        off += MAX_MY_CITIES_H * city_dim

    # ── Tech multi-hot ────────────────────────────────────────────────────
    if cfg.use_tech_multihot:
        for tid in researched:
            idx = TECH_IDX.get(tid)
            if idx is not None:
                obs[off + idx] = 1.0
        off += N_TECHS_H

    # ── CNN map grid ──────────────────────────────────────────────────────
    if cfg.use_global_cnn and state.get("map"):
        _enc_map_grid(obs, off, state, viewer_id, my_units, enemy_units)
        off += MAP_H * MAP_W * MAP_C

    mask = _compute_mask(state, viewer_id, my_units, my_cities, researched)
    return obs, mask


def hybrid_decode_action(action: int, state: dict, viewer_id: str) -> dict | None:
    """Decode a hybrid action index → game Intent dict (None → send EndTurn)."""
    my_units  = [u for u in state["units"]  if u["ownerId"] == viewer_id]
    my_cities = [c for c in state["cities"] if c["ownerId"] == viewer_id]

    if action == ACT_END_TURN:
        return {"type": "EndTurn", "actorId": viewer_id}

    if ACT_MOVE_START <= action < ACT_FOUND_CITY_START:
        unit_idx, dir_idx = divmod(action - ACT_MOVE_START, 6)
        if unit_idx >= len(my_units):
            return None
        u = my_units[unit_idx]
        dq, dr = HEX_NEIGHBORS[dir_idx]
        return {
            "type": "MoveUnit", "actorId": viewer_id, "unitId": u["id"],
            "target": {"q": u["position"]["q"] + dq, "r": u["position"]["r"] + dr},
        }

    if ACT_FOUND_CITY_START <= action < ACT_BUILD_IMP_START:
        unit_idx = action - ACT_FOUND_CITY_START
        if unit_idx >= len(my_units):
            return None
        return {"type": "FoundCity", "actorId": viewer_id, "unitId": my_units[unit_idx]["id"]}

    if ACT_BUILD_IMP_START <= action < ACT_RESEARCH_START:
        unit_idx = action - ACT_BUILD_IMP_START
        if unit_idx >= len(my_units):
            return None
        return {"type": "BuildImprovement", "actorId": viewer_id, "unitId": my_units[unit_idx]["id"]}

    if ACT_RESEARCH_START <= action < ACT_SET_PROD_START:
        tech_idx = action - ACT_RESEARCH_START
        if tech_idx >= len(ALL_TECHS):
            return None
        return {"type": "SetResearch", "actorId": viewer_id, "techId": ALL_TECHS[tech_idx]}

    if ACT_SET_PROD_START <= action < ACT_DIM_H:
        city_idx, item_idx = divmod(action - ACT_SET_PROD_START, N_PROD_ITEMS)
        if city_idx >= len(my_cities) or item_idx >= len(PRODUCTION_UNITS):
            return None
        return {
            "type": "SetCityProduction",
            "actorId": viewer_id,
            "cityId": my_cities[city_idx]["id"],
            "item": {"kind": "unit", "defId": PRODUCTION_UNITS[item_idx]},
        }

    return None


# ── Entity encoding helpers ───────────────────────────────────────────────────

def _enc_unit(obs: np.ndarray, b: int, u: dict, cfg: ObsConfig) -> None:
    pos    = u.get("position", {})
    def_id = u.get("defId", "")
    obs[b + 0] = 1.0   # valid
    obs[b + 1] = float(UNIT_DEF_IDX.get(def_id, N_UNIT_TYPES))
    obs[b + 2] = _n(pos.get("q", 0), 50)
    obs[b + 3] = _n(pos.get("r", 0), 50)
    obs[b + 4] = _n(u.get("hp", 100), 100)
    obs[b + 5] = _n(u.get("movementLeft", 0), 3)
    if cfg.use_unit_status:
        obs[b + 6] = 1.0 if u.get("fortified") else 0.0
        obs[b + 7] = 1.0 if u.get("attackedThisTurn") else 0.0
    obs[b + 8] = 1.0 if def_id == "unit.settler" else 0.0
    obs[b + 9] = 1.0 if def_id == "unit.worker"  else 0.0
    if cfg.use_unit_combat_stats:
        s, rs, r = UNIT_COMBAT_STATS.get(def_id, (0, 0, 0))
        obs[b + 10] = _n(s,  MAX_COMBAT_STRENGTH)
        obs[b + 11] = _n(rs, MAX_COMBAT_STRENGTH)
        obs[b + 12] = _n(r,  5)
    if cfg.use_unit_status:
        charges_used = sum((u.get("attackChargesUsed") or {}).values())
        obs[b + 13] = _n(charges_used, 5)


def _enc_enemy(obs: np.ndarray, b: int, u: dict, cfg: ObsConfig) -> None:
    pos    = u.get("position", {})
    def_id = u.get("defId", "")
    obs[b + 0] = 1.0
    obs[b + 1] = float(UNIT_DEF_IDX.get(def_id, N_UNIT_TYPES))
    obs[b + 2] = _n(pos.get("q", 0), 50)
    obs[b + 3] = _n(pos.get("r", 0), 50)
    obs[b + 4] = _n(u.get("hp", 100), 100)
    if cfg.use_enemy_combat_stats:
        s, rs, r = UNIT_COMBAT_STATS.get(def_id, (0, 0, 0))
        obs[b + 5] = _n(s,  MAX_COMBAT_STRENGTH)
        obs[b + 6] = _n(rs, MAX_COMBAT_STRENGTH)
        obs[b + 7] = _n(r,  5)


def _enc_city(obs: np.ndarray, b: int, c: dict, cfg: ObsConfig) -> None:
    pos         = c.get("position", {})
    yields      = c.get("perTurnYields", {})
    food_thresh = max(c.get("foodToGrow", 1), 1)
    cult_thresh = max(c.get("cultureToExpand", 1), 1)
    prod_item   = c.get("productionItem")
    buildings   = c.get("buildings", [])

    obs[b +  0] = 1.0
    obs[b +  1] = _n(pos.get("q", 0), 50)
    obs[b +  2] = _n(pos.get("r", 0), 50)
    obs[b +  3] = _n(c.get("population", 1), 20)
    obs[b +  4] = _n(c.get("production", 0), 200)  # production accumulated
    obs[b +  5] = min(c.get("food", 0) / food_thresh, 1.0)
    obs[b +  6] = _n(yields.get("gold", 0), 30)
    obs[b +  7] = _n(yields.get("science", 0), 20)
    obs[b +  8] = _n(yields.get("production", 0), 20)
    obs[b +  9] = _n(yields.get("food", 0), 20)
    obs[b + 10] = _n(yields.get("culture", 0), 10)
    obs[b + 11] = _n(c.get("hp", 200), 200)
    obs[b + 12] = min(c.get("cultureAccumulated", 0) / cult_thresh, 1.0)
    obs[b + 13] = _n(len(buildings), N_BUILDINGS)
    obs[b + 14] = 1.0 if prod_item else 0.0
    if prod_item:
        def_id = (prod_item.get("defId") or "")
        idx    = PRODUCTION_UNITS.index(def_id) if def_id in PRODUCTION_UNITS else 0
        obs[b + 15] = float(idx) / max(N_PROD_ITEMS - 1, 1)
    if cfg.use_city_buildings:
        for bldg_id in buildings:
            bldg_idx = BUILDING_IDX.get(bldg_id)
            if bldg_idx is not None:
                obs[b + CITY_FEAT_BASE + bldg_idx] = 1.0


def _enc_map_grid(
    obs: np.ndarray, off: int, state: dict, viewer_id: str,
    my_units: list, enemy_units: list,
) -> None:
    my_pos    = {(u["position"]["q"], u["position"]["r"]) for u in my_units}
    enemy_pos = {(u["position"]["q"], u["position"]["r"]) for u in enemy_units}
    my_city_pos = {
        (c["position"]["q"], c["position"]["r"])
        for c in state.get("cities", []) if c["ownerId"] == viewer_id
    }
    enemy_city_pos = {
        (c["position"]["q"], c["position"]["r"])
        for c in state.get("cities", []) if c["ownerId"] != viewer_id
    }

    for tile in state["map"]["tiles"]:
        q, r = tile["q"], tile["r"]
        row  = r + MAP_OFFSET
        col  = q + MAP_OFFSET
        if not (0 <= row < MAP_H and 0 <= col < MAP_W):
            continue

        b = off + (row * MAP_W + col) * MAP_C

        # terrain one-hot (channels 0-11)
        tidx = TERRAIN_IDX.get(tile.get("terrain", "plains"), 0)
        obs[b + tidx] = 1.0

        obs[b + N_TERRAIN_TYPES]     = 1.0 if tile.get("resource")    else 0.0
        obs[b + N_TERRAIN_TYPES + 1] = 1.0 if tile.get("improvement") else 0.0

        vis_val = {"unseen": 0.0, "seen": 0.5, "visible": 1.0}
        obs[b + N_TERRAIN_TYPES + 2] = vis_val.get(tile.get("visibility", "unseen"), 0.0)

        if   (q, r) in my_city_pos:    obs[b + N_TERRAIN_TYPES + 3] = 1.0
        elif (q, r) in enemy_city_pos: obs[b + N_TERRAIN_TYPES + 3] = 0.5

        obs[b + N_TERRAIN_TYPES + 4] = 1.0 if (q, r) in my_pos    else 0.0
        obs[b + N_TERRAIN_TYPES + 5] = 1.0 if (q, r) in enemy_pos else 0.0


# ── Action mask ───────────────────────────────────────────────────────────────

def _compute_mask(
    state: dict, viewer_id: str, my_units: list, my_cities: list, researched: set
) -> np.ndarray:
    mask = np.zeros(ACT_DIM_H, dtype=np.float32)

    players = state.get("players", [])
    cur_idx = state.get("currentPlayerIndex", 0)
    if not players or players[cur_idx]["id"] != viewer_id:
        return mask

    mask[ACT_END_TURN] = 1.0

    tiles: dict[str, dict] = {}
    if state.get("map"):
        for t in state["map"]["tiles"]:
            tiles[f"{t['q']},{t['r']}"] = t

    own_pos  = {(u["position"]["q"], u["position"]["r"]) for u in state["units"] if u["ownerId"] == viewer_id}
    city_pos = {(c["position"]["q"], c["position"]["r"]) for c in state["cities"]}

    for i, u in enumerate(my_units[:MAX_MY_UNITS_H]):
        if u.get("movementLeft", 0) <= 0:
            continue
        uq, ur = u["position"]["q"], u["position"]["r"]
        for di, (dq, dr) in enumerate(HEX_NEIGHBORS):
            tq, tr = uq + dq, ur + dr
            tile = tiles.get(f"{tq},{tr}")
            if not tile or tile.get("terrain") in _IMPASSABLE:
                continue
            if (tq, tr) in own_pos:
                continue
            mask[ACT_MOVE_START + i * 6 + di] = 1.0

        def_id = u.get("defId", "")
        if def_id == "unit.settler" and (uq, ur) not in city_pos:
            mask[ACT_FOUND_CITY_START + i] = 1.0
        if def_id == "unit.worker":
            mask[ACT_BUILD_IMP_START + i] = 1.0

    # Research — prefer state["availableTechs"] if present, else compute from tech list
    avail = state.get("availableTechs") or _derive_available_techs(state, researched)
    cur_tech = next(
        (p.get("currentTech") for p in state["players"] if p["id"] == viewer_id), None
    )
    for tech in avail:
        tid = tech.get("id", "")
        if tid in researched or tid == cur_tech:
            continue
        tidx = TECH_IDX.get(tid)
        if tidx is not None:
            mask[ACT_RESEARCH_START + tidx] = 1.0

    # Set production
    for ci, city in enumerate(my_cities[:MAX_MY_CITIES_H]):
        if city.get("productionItem"):
            continue
        for pi in range(N_PROD_ITEMS):
            mask[ACT_SET_PROD_START + ci * N_PROD_ITEMS + pi] = 1.0

    return mask


def _derive_available_techs(state: dict, researched: set) -> list[dict]:
    techs = state.get("techs") or []
    available = []
    for t in techs:
        tid = t.get("id", "")
        if tid in researched:
            continue
        prereqs = t.get("prereqs") or t.get("prerequisites") or []
        if all(p in researched for p in prereqs):
            available.append(t)
    return available


# ── Utilities ─────────────────────────────────────────────────────────────────

def _n(val: float, scale: float) -> float:
    return float(val) / scale if scale else 0.0


def _is_at_war(state: dict, viewer_id: str) -> bool:
    for key, status in (state.get("diplomacy") or {}).items():
        if viewer_id in key and status == "war":
            return True
    return False


def _city_yield_totals(cities: list) -> dict:
    totals = {"gold": 0.0, "science": 0.0, "production": 0.0, "food": 0.0, "culture": 0.0}
    for c in cities:
        y = c.get("perTurnYields") or {}
        for k in totals:
            totals[k] += y.get(k, 0)
    return totals
