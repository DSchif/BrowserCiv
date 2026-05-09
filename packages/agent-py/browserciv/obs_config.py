"""ObsConfig: feature-flag dataclass for the hybrid model."""
from __future__ import annotations
import dataclasses

from .hybrid_constants import (
    GLOBAL_DIM_H, UNIT_FEAT_DIM, ENEMY_FEAT_DIM,
    CITY_FEAT_BASE, CITY_BLDG_DIM, N_TECHS_H,
    MAX_MY_UNITS_H, MAX_ENEMY_UNITS_H, MAX_MY_CITIES_H,
    MAP_H, MAP_W, MAP_C,
)


@dataclasses.dataclass
class ObsConfig:
    """
    Feature flags for the hybrid observation encoder.

    Set once at model-creation time and baked into the checkpoint.
    Changing any flag creates an incompatible model.

    Feature groups that are disabled still occupy the same slot width in the
    flat array — the encoder writes zeros instead.  This keeps obs_dim
    stable for use_unit_combat_stats / use_unit_status / use_enemy_combat_stats.
    Flags that change obs_dim (use_city_buildings, use_tech_multihot,
    use_global_cnn) must be fixed for the lifetime of the model.
    """

    # ── Units ──────────────────────────────────────────────────────────────
    use_my_units: bool          = True
    use_unit_combat_stats: bool = True   # strength, ranged_strength, range (slots 10-12)
    use_unit_status: bool       = True   # fortified, attackedThisTurn, charges (slots 6-7,13)

    use_enemy_units: bool          = True
    use_enemy_combat_stats: bool   = True   # strength, ranged_strength, range (slots 5-7)

    # ── Cities ─────────────────────────────────────────────────────────────
    use_my_cities: bool       = True
    use_city_buildings: bool  = False  # 27-bit multi-hot appended per city (+27 per slot → changes obs_dim)

    # ── Tech ───────────────────────────────────────────────────────────────
    use_tech_multihot: bool   = True   # 74-bit researched-tech vector (changes obs_dim)

    # ── Map ────────────────────────────────────────────────────────────────
    use_global_cnn: bool      = False  # full 32×32 hex grid (adds ~18K floats, changes obs_dim)

    # ── Derived dimensions ────────────────────────────────────────────────

    def city_feat_dim(self) -> int:
        return CITY_FEAT_BASE + (CITY_BLDG_DIM if self.use_city_buildings else 0)

    def obs_dim(self) -> int:
        n = GLOBAL_DIM_H
        if self.use_my_units:      n += MAX_MY_UNITS_H * UNIT_FEAT_DIM
        if self.use_enemy_units:   n += MAX_ENEMY_UNITS_H * ENEMY_FEAT_DIM
        if self.use_my_cities:     n += MAX_MY_CITIES_H * self.city_feat_dim()
        if self.use_tech_multihot: n += N_TECHS_H
        if self.use_global_cnn:    n += MAP_H * MAP_W * MAP_C
        return n

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ObsConfig":
        known = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})
