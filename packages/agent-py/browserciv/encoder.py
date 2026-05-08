import numpy as np
from .constants import (
    OBS_DIM, ACT_DIM, GLOBAL_DIM, UNIT_DIM, ENEMY_UNIT_DIM, CITY_DIM,
    MAX_MY_UNITS, MAX_ENEMY_UNITS, MAX_MY_CITIES, MAX_TECHS,
    ACT_END_TURN, ACT_MOVE_START, ACT_FOUND_CITY_START,
    ACT_BUILD_IMP_START, ACT_RESEARCH_START, ACT_SET_PROD_START,
    PRODUCTION_ITEMS, MAX_PRODUCTION_ITEMS,
    HEX_NEIGHBORS, ERA_INDEX,
)

UNIT_DEFS = [
    "unit.settler", "unit.worker", "unit.warrior",
    "unit.swordsman", "unit.musketman", "unit.rifleman",
]
UNIT_DEF_IDX = {d: i for i, d in enumerate(UNIT_DEFS)}
_IMPASSABLE = {"ocean", "deep_ocean", "mountain"}


def encode_state(state: dict) -> tuple[np.ndarray, np.ndarray]:
    viewer_id = state["viewerId"]
    player = next((p for p in state["players"] if p["id"] == viewer_id), {})
    opp = next((p for p in state["players"] if p["id"] != viewer_id), {})

    my_units = [u for u in state["units"] if u["ownerId"] == viewer_id]
    enemy_units = [u for u in state["units"] if u["ownerId"] != viewer_id]
    my_cities = [c for c in state["cities"] if c["ownerId"] == viewer_id]
    researched = set(player.get("researchedTechs", []))

    obs = np.zeros(OBS_DIM, dtype=np.float32)

    # Global features (20)
    obs[0]  = _norm(player.get("gold", 0), 500)
    obs[1]  = _norm(player.get("science", 0), 200)
    obs[2]  = _norm(player.get("culture", 0), 200)
    obs[3]  = ERA_INDEX.get(player.get("era", "ancient"), 0) / 4.0
    obs[4]  = _norm(len(my_units), MAX_MY_UNITS)
    obs[5]  = _norm(len(enemy_units), MAX_ENEMY_UNITS)
    obs[6]  = _norm(len(my_cities), MAX_MY_CITIES)
    obs[7]  = _norm(state.get("turnNumber", 0), 500)
    obs[8]  = len(researched) / max(MAX_TECHS, 1)
    obs[9]  = _norm(player.get("currentResearchProgress", 0), 100)
    obs[10] = _norm(opp.get("gold", 0), 500)
    obs[11] = ERA_INDEX.get(opp.get("era", "ancient"), 0) / 4.0
    obs[12] = _norm(len(enemy_units), MAX_ENEMY_UNITS)
    obs[13] = _norm(sum(c.get("goldYield", 0) for c in my_cities), 30)
    obs[14] = _norm(sum(c.get("scienceYield", 0) for c in my_cities), 30)
    # 15-19 spare

    offset = GLOBAL_DIM

    # My units (MAX_MY_UNITS × UNIT_DIM = 80)
    for i in range(MAX_MY_UNITS):
        b = offset + i * UNIT_DIM
        if i < len(my_units):
            u = my_units[i]
            pos = u.get("position", {})
            obs[b + 0] = UNIT_DEF_IDX.get(u.get("defId", ""), 0) / max(len(UNIT_DEFS) - 1, 1)
            obs[b + 1] = _norm(pos.get("q", 0), 50)
            obs[b + 2] = _norm(pos.get("r", 0), 50)
            obs[b + 3] = _norm(u.get("movementLeft", 0), 3)
            obs[b + 4] = _norm(u.get("hp", 100), 100)
            obs[b + 5] = 1.0
            obs[b + 6] = 1.0 if u.get("defId") == "unit.settler" else 0.0
            obs[b + 7] = 1.0 if u.get("defId") == "unit.worker" else 0.0
    offset += MAX_MY_UNITS * UNIT_DIM

    # Enemy units (MAX_ENEMY_UNITS × ENEMY_UNIT_DIM = 48)
    for i in range(MAX_ENEMY_UNITS):
        b = offset + i * ENEMY_UNIT_DIM
        if i < len(enemy_units):
            u = enemy_units[i]
            pos = u.get("position", {})
            obs[b + 0] = UNIT_DEF_IDX.get(u.get("defId", ""), 0) / max(len(UNIT_DEFS) - 1, 1)
            obs[b + 1] = _norm(pos.get("q", 0), 50)
            obs[b + 2] = _norm(pos.get("r", 0), 50)
            obs[b + 3] = _norm(u.get("hp", 100), 100)
            obs[b + 4] = ERA_INDEX.get(u.get("era", "ancient"), 0) / 4.0
            obs[b + 5] = 1.0
    offset += MAX_ENEMY_UNITS * ENEMY_UNIT_DIM

    # My cities (MAX_MY_CITIES × CITY_DIM = 48)
    for i in range(MAX_MY_CITIES):
        b = offset + i * CITY_DIM
        if i < len(my_cities):
            c = my_cities[i]
            pos = c.get("position", {})
            obs[b + 0] = _norm(pos.get("q", 0), 50)
            obs[b + 1] = _norm(pos.get("r", 0), 50)
            obs[b + 2] = _norm(c.get("population", 1), 20)
            obs[b + 3] = _norm(c.get("productionAccumulated", 0), 200)
            obs[b + 4] = _norm(c.get("goldYield", 0), 30)
            obs[b + 5] = _norm(c.get("scienceYield", 0), 20)
            obs[b + 6] = _norm(c.get("productionYield", 0), 20)
            obs[b + 7] = _norm(c.get("foodYield", 0), 20)
            obs[b + 8] = 1.0
            prod_item = c.get("productionItem")
            prod_defid = prod_item.get("defId", "") if prod_item else ""
            obs[b + 9]  = 0.0 if not prod_item else 1.0
            obs[b + 10] = PRODUCTION_ITEMS.index(prod_defid) / max(MAX_PRODUCTION_ITEMS - 1, 1) if prod_defid in PRODUCTION_ITEMS else 0.0

    mask = compute_mask(state, viewer_id, my_units, my_cities, researched)
    return obs, mask


def compute_mask(state: dict, viewer_id: str, my_units: list, my_cities: list, researched: set) -> np.ndarray:
    mask = np.zeros(ACT_DIM, dtype=np.float32)

    players = state.get("players", [])
    cur_idx = state.get("currentPlayerIndex", 0)
    if not players or players[cur_idx]["id"] != viewer_id:
        return mask

    mask[ACT_END_TURN] = 1.0

    tiles_by_key: dict[str, dict] = {}
    if state.get("map"):
        for t in state["map"]["tiles"]:
            tiles_by_key[f"{t['q']},{t['r']}"] = t

    own_positions: set[tuple] = {(u["position"]["q"], u["position"]["r"]) for u in state["units"] if u["ownerId"] == viewer_id}
    city_positions: set[tuple] = {(c["position"]["q"], c["position"]["r"]) for c in state["cities"]}

    for i, u in enumerate(my_units[:MAX_MY_UNITS]):
        if u.get("movementLeft", 0) <= 0:
            continue
        uq, ur = u["position"]["q"], u["position"]["r"]

        for dir_idx, (dq, dr) in enumerate(HEX_NEIGHBORS):
            tq, tr = uq + dq, ur + dr
            tile = tiles_by_key.get(f"{tq},{tr}")
            if not tile:
                continue
            if tile.get("terrain") in _IMPASSABLE:
                continue
            if (tq, tr) in own_positions:
                continue
            mask[ACT_MOVE_START + i * 6 + dir_idx] = 1.0

        if u.get("defId") == "unit.settler" and (uq, ur) not in city_positions:
            mask[ACT_FOUND_CITY_START + i] = 1.0

        if u.get("defId") == "unit.worker":
            mask[ACT_BUILD_IMP_START + i] = 1.0

    all_techs = state.get("availableTechs") or []
    current_research = state.get("currentResearch") or ""
    for j, tech in enumerate(all_techs[:MAX_TECHS]):
        tid = tech.get("id", "")
        if tid in researched or tid == current_research:
            continue
        if all(p in researched for p in tech.get("prerequisites", [])):
            mask[ACT_RESEARCH_START + j] = 1.0

    # Set city production — only when city has nothing queued (prevents production churn)
    for ci, city in enumerate(my_cities[:MAX_MY_CITIES]):
        if city.get("productionItem"):
            continue
        for pi in range(MAX_PRODUCTION_ITEMS):
            mask[ACT_SET_PROD_START + ci * MAX_PRODUCTION_ITEMS + pi] = 1.0

    return mask


def decode_action(action: int, state: dict, viewer_id: str) -> dict | None:
    my_units = [u for u in state["units"] if u["ownerId"] == viewer_id]
    all_techs = state.get("availableTechs") or []

    if action == ACT_END_TURN:
        return {"type": "EndTurn", "actorId": viewer_id}

    if ACT_MOVE_START <= action < ACT_FOUND_CITY_START:
        offset = action - ACT_MOVE_START
        unit_idx, dir_idx = divmod(offset, 6)
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
        if tech_idx >= len(all_techs):
            return None
        return {"type": "SetResearch", "actorId": viewer_id, "techId": all_techs[tech_idx]["id"]}

    if ACT_SET_PROD_START <= action < ACT_DIM:
        offset = action - ACT_SET_PROD_START
        city_idx, item_idx = divmod(offset, MAX_PRODUCTION_ITEMS)
        my_cities = [c for c in state["cities"] if c["ownerId"] == viewer_id]
        if city_idx >= len(my_cities):
            return None
        return {
            "type": "SetCityProduction",
            "actorId": viewer_id,
            "cityId": my_cities[city_idx]["id"],
            "item": {"kind": "unit", "defId": PRODUCTION_ITEMS[item_idx]},
        }

    return None


def _norm(val: float, scale: float) -> float:
    return float(val) / scale if scale else 0.0
