"""
All unit/tech/building/terrain identifiers and feature dimensions for the hybrid model.
"""

# ── Unit definitions ──────────────────────────────────────────────────────────

ALL_UNIT_DEFS = [
    "unit.archer", "unit.artillery", "unit.battleship", "unit.cannon",
    "unit.caravel", "unit.catapult", "unit.cavalry", "unit.chariot_archer",
    "unit.composite_bowman", "unit.crossbowman", "unit.frigate", "unit.galleass",
    "unit.gdr", "unit.great_war_infantry", "unit.horseman", "unit.infantry",
    "unit.ironclad", "unit.knight", "unit.lancer", "unit.longswordsman",
    "unit.mech_infantry", "unit.modern_armor", "unit.musketman", "unit.pikeman",
    "unit.rifleman", "unit.settler", "unit.spearman", "unit.swordsman",
    "unit.trebuchet", "unit.trireme", "unit.warrior", "unit.worker",
]
UNIT_DEF_IDX: dict[str, int] = {d: i for i, d in enumerate(ALL_UNIT_DEFS)}
N_UNIT_TYPES = len(ALL_UNIT_DEFS)   # 32 — also used as the "unknown" padding index

# (melee_strength, ranged_strength, range) — zeroes for civilian/no-combat units
UNIT_COMBAT_STATS: dict[str, tuple[int, int, int]] = {
    "unit.archer":             (5,   7, 2),
    "unit.artillery":          (32, 41, 3),
    "unit.battleship":         (50, 55, 3),
    "unit.cannon":             (16, 26, 2),
    "unit.caravel":            (20,  0, 0),
    "unit.catapult":           (4,   8, 2),
    "unit.cavalry":            (34,  0, 0),
    "unit.chariot_archer":     (6,   9, 2),
    "unit.composite_bowman":   (7,  11, 2),
    "unit.crossbowman":        (13, 18, 2),
    "unit.frigate":            (28, 25, 2),
    "unit.galleass":           (11, 15, 2),
    "unit.gdr":                (150, 0, 0),
    "unit.great_war_infantry": (50,  0, 0),
    "unit.horseman":           (12,  0, 0),
    "unit.infantry":           (70,  0, 0),
    "unit.ironclad":           (38,  0, 0),
    "unit.knight":             (20,  0, 0),
    "unit.lancer":             (22,  0, 0),
    "unit.longswordsman":      (21,  0, 0),
    "unit.mech_infantry":      (80,  0, 0),
    "unit.modern_armor":       (100, 0, 0),
    "unit.musketman":          (24,  0, 0),
    "unit.pikeman":            (16,  0, 0),
    "unit.rifleman":           (34,  0, 0),
    "unit.settler":            (0,   0, 0),
    "unit.spearman":           (11,  0, 0),
    "unit.swordsman":          (14,  0, 0),
    "unit.trebuchet":          (8,  14, 2),
    "unit.trireme":            (10,  0, 0),
    "unit.warrior":            (8,   0, 0),
    "unit.worker":             (0,   0, 0),
}
MAX_COMBAT_STRENGTH = 150.0

# ── Tech definitions ──────────────────────────────────────────────────────────

ALL_TECHS = [
    "tech.acoustics", "tech.advanced_ballistics", "tech.agriculture",
    "tech.animal_husbandry", "tech.archery", "tech.architecture",
    "tech.astronomy", "tech.banking", "tech.biology", "tech.bronze_working",
    "tech.calendar", "tech.chemistry", "tech.chivalry", "tech.civil_service",
    "tech.combustion", "tech.compass", "tech.computers", "tech.construction",
    "tech.currency", "tech.drama_and_poetry", "tech.dynamite", "tech.ecology",
    "tech.economics", "tech.education", "tech.electricity", "tech.electronics",
    "tech.fertilizer", "tech.flight", "tech.future_tech", "tech.globalization",
    "tech.guilds", "tech.gunpowder", "tech.horseback_riding",
    "tech.industrialization", "tech.internet", "tech.iron_working",
    "tech.lasers", "tech.machinery", "tech.masonry", "tech.mass_media",
    "tech.mathematics", "tech.metal_casting", "tech.metallurgy",
    "tech.military_science", "tech.mining", "tech.mobile_tactics",
    "tech.nanotechnology", "tech.navigation", "tech.nuclear_fission",
    "tech.optics", "tech.particle_physics", "tech.philosophy", "tech.physics",
    "tech.plastics", "tech.pottery", "tech.printing_press", "tech.radio",
    "tech.railroad", "tech.refrigeration", "tech.replaceable_parts",
    "tech.rifling", "tech.robotics", "tech.rocketry", "tech.sailing",
    "tech.satellites", "tech.scientific_theory", "tech.stealth",
    "tech.steam_power", "tech.steel", "tech.telecommunications",
    "tech.theology", "tech.the_wheel", "tech.trapping", "tech.writing",
]
TECH_IDX: dict[str, int] = {t: i for i, t in enumerate(ALL_TECHS)}
N_TECHS_H = len(ALL_TECHS)  # 74

# ── Building definitions ──────────────────────────────────────────────────────

ALL_BUILDINGS = [
    "building.amphitheater", "building.bank", "building.barracks",
    "building.broadcast_tower", "building.colosseum", "building.factory",
    "building.forge", "building.granary", "building.hospital",
    "building.hydro_plant", "building.library", "building.lighthouse",
    "building.market", "building.nuclear_plant", "building.observatory",
    "building.opera_house", "building.public_school", "building.recycling_center",
    "building.research_lab", "building.shrine", "building.stable",
    "building.stadium", "building.stock_exchange", "building.temple",
    "building.university", "building.walls", "building.workshop",
]
BUILDING_IDX: dict[str, int] = {b: i for i, b in enumerate(ALL_BUILDINGS)}
N_BUILDINGS = len(ALL_BUILDINGS)  # 27

# ── Terrain definitions ───────────────────────────────────────────────────────

ALL_TERRAINS = [
    "plains", "hills", "grassland", "forest", "desert", "tundra", "snow",
    "ocean", "deep_ocean", "mountain", "ice", "coast",
]
TERRAIN_IDX: dict[str, int] = {t: i for i, t in enumerate(ALL_TERRAINS)}
N_TERRAIN_TYPES = len(ALL_TERRAINS)  # 12

# ── Entity caps ───────────────────────────────────────────────────────────────

MAX_MY_UNITS_H    = 16
MAX_ENEMY_UNITS_H = 16
MAX_MY_CITIES_H   = 8

# ── Feature dimensions (fixed per slot; some sub-fields zeroed when flag disabled) ──

GLOBAL_DIM_H   = 24  # global scalar features (always on)
UNIT_FEAT_DIM  = 14  # per my-unit slot; indices 10-13 zeroed if flags off
ENEMY_FEAT_DIM = 8   # per enemy-unit slot; indices 5-7 zeroed if flag off
CITY_FEAT_BASE = 16  # city base features (always when use_my_cities=True)
CITY_BLDG_DIM  = N_BUILDINGS  # appended per city when use_city_buildings=True

# ── CNN map grid ──────────────────────────────────────────────────────────────

MAP_H      = 32          # grid height
MAP_W      = 32          # grid width
MAP_OFFSET = 16          # (q, r) → (r + MAP_OFFSET, q + MAP_OFFSET)
MAP_C      = N_TERRAIN_TYPES + 6  # 18 channels: terrain(12)+resource+improvement+visibility+owner+my_unit+enemy_unit

# ── Production items ──────────────────────────────────────────────────────────

PRODUCTION_UNITS = ["unit.warrior", "unit.settler", "unit.worker"]
N_PROD_ITEMS     = len(PRODUCTION_UNITS)  # 3

# ── Action space ─────────────────────────────────────────────────────────────

ACT_END_TURN         = 0
ACT_MOVE_START       = 1                                                    # 1..96
ACT_FOUND_CITY_START = ACT_MOVE_START + MAX_MY_UNITS_H * 6                 # 97
ACT_BUILD_IMP_START  = ACT_FOUND_CITY_START + MAX_MY_UNITS_H               # 113
ACT_RESEARCH_START   = ACT_BUILD_IMP_START + MAX_MY_UNITS_H                # 129
ACT_SET_PROD_START   = ACT_RESEARCH_START + N_TECHS_H                      # 203
ACT_DIM_H            = ACT_SET_PROD_START + MAX_MY_CITIES_H * N_PROD_ITEMS # 227

HEX_NEIGHBORS = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
ERA_INDEX     = {"ancient": 0, "classical": 1, "medieval": 2, "industrial": 3, "modern": 4}
