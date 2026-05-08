MAX_MY_UNITS    = 8
MAX_ENEMY_UNITS = 8
MAX_MY_CITIES   = 4
MAX_TECHS       = 30

GLOBAL_DIM     = 20
UNIT_DIM       = 10
ENEMY_UNIT_DIM = 6
CITY_DIM       = 12

OBS_DIM = GLOBAL_DIM + MAX_MY_UNITS * UNIT_DIM + MAX_ENEMY_UNITS * ENEMY_UNIT_DIM + MAX_MY_CITIES * CITY_DIM
# = 20 + 80 + 48 + 48 = 196

# Buildable items (units only for now — always available)
PRODUCTION_ITEMS = ["unit.warrior", "unit.settler", "unit.worker"]
MAX_PRODUCTION_ITEMS = len(PRODUCTION_ITEMS)

# Flat discrete action space layout
ACT_END_TURN         = 0
ACT_MOVE_START       = 1                                                          # 1..48
ACT_FOUND_CITY_START = ACT_MOVE_START + MAX_MY_UNITS * 6                          # 49
ACT_BUILD_IMP_START  = ACT_FOUND_CITY_START + MAX_MY_UNITS                        # 57
ACT_RESEARCH_START   = ACT_BUILD_IMP_START + MAX_MY_UNITS                         # 65
ACT_SET_PROD_START   = ACT_RESEARCH_START + MAX_TECHS                             # 95
ACT_DIM              = ACT_SET_PROD_START + MAX_MY_CITIES * MAX_PRODUCTION_ITEMS  # 107

# Axial hex neighbour offsets (matches game engine)
HEX_NEIGHBORS = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]

ERAS = ["ancient", "classical", "medieval", "industrial", "modern"]
ERA_INDEX = {e: i for i, e in enumerate(ERAS)}

LAND_TERRAINS = {"plains", "hills", "grassland", "forest", "desert", "tundra", "snow"}
