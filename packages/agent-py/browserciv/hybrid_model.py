"""
HybridActorCritic: multi-branch actor-critic for BrowserCiv.

Architecture:
  global branch   : MLP over 24 scalar features          → 64-dim
  my_units branch : entity encoder (mean+max pool)        → 64-dim
  enemy branch    : entity encoder (mean+max pool)        → 64-dim
  cities branch   : city encoder   (mean+max pool)        → 64-dim
  tech branch     : linear projection of 74-bit multi-hot → 32-dim  (optional)
  CNN branch      : small ConvNet over 32×32 hex grid     → 128-dim (optional)

All enabled branch outputs are concatenated → joint trunk MLP → actor / critic heads.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.distributions import Categorical

from .hybrid_constants import (
    GLOBAL_DIM_H, UNIT_FEAT_DIM, ENEMY_FEAT_DIM, N_TECHS_H,
    MAP_H, MAP_W, MAP_C,
    MAX_MY_UNITS_H, MAX_ENEMY_UNITS_H, MAX_MY_CITIES_H,
    N_UNIT_TYPES, ACT_DIM_H,
)
from .obs_config import ObsConfig


# ── Shared helpers ────────────────────────────────────────────────────────────

def _mlp(in_dim: int, hidden: list[int]) -> nn.Sequential:
    layers: list[nn.Module] = []
    prev = in_dim
    for h in hidden:
        layers += [nn.Linear(prev, h), nn.LayerNorm(h), nn.ReLU()]
        prev = h
    return nn.Sequential(*layers)


# ── Branch modules ────────────────────────────────────────────────────────────

class _EntityEncoder(nn.Module):
    """
    Encodes a variable-size padded entity set → fixed-dim vector.

    Input layout per entity slot:
      [0]   valid flag  (1.0 = real entity, 0.0 = padding)
      [1]   type index  (int stored as float; used for embedding lookup)
      [2:]  other float features

    Output: concat(masked_mean_pool, masked_max_pool) of shape (B, 2*hidden_dim).
    """

    def __init__(self, feat_dim: int, type_emb_dim: int, hidden_dim: int, n_types: int):
        super().__init__()
        # n_types used as padding_idx so unknown type → zero embedding
        self.type_emb = nn.Embedding(n_types + 1, type_emb_dim, padding_idx=n_types)
        # input = other features + type embedding (valid flag is only for masking)
        self.mlp = nn.Sequential(
            nn.Linear((feat_dim - 2) + type_emb_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
        )
        self.out_dim = hidden_dim * 2

    def forward(self, entities: torch.Tensor) -> torch.Tensor:
        # entities: (B, max_e, feat_dim)
        valid    = entities[:, :, 0:1]                                         # (B, max_e, 1)
        type_idx = entities[:, :, 1].long().clamp(0, self.type_emb.num_embeddings - 1)
        other    = entities[:, :, 2:]                                          # (B, max_e, feat-2)
        emb      = self.type_emb(type_idx)                                     # (B, max_e, E)
        x        = torch.cat([other, emb], dim=-1)
        h        = self.mlp(x)                                                 # (B, max_e, H)

        # masked mean pool
        n_valid   = valid.sum(dim=1).clamp(min=1.0)                           # (B, 1)
        mean_pool = (h * valid).sum(dim=1) / n_valid                          # (B, H)

        # masked max pool — padding slots filled with -inf so they never win
        h_inf    = h + (1.0 - valid) * (-1e9)
        max_pool, _ = h_inf.max(dim=1)                                         # (B, H)

        return torch.cat([mean_pool, max_pool], dim=-1)                        # (B, 2H)


class _CityEncoder(nn.Module):
    """City set encoder — no type embedding, uniform entity MLP + mean/max pool."""

    def __init__(self, feat_dim: int, hidden_dim: int):
        super().__init__()
        self.mlp = nn.Sequential(
            nn.Linear(feat_dim - 1, hidden_dim),   # drop valid flag
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
        )
        self.out_dim = hidden_dim * 2

    def forward(self, cities: torch.Tensor) -> torch.Tensor:
        valid = cities[:, :, 0:1]
        x     = cities[:, :, 1:]
        h     = self.mlp(x)

        n_valid   = valid.sum(dim=1).clamp(min=1.0)
        mean_pool = (h * valid).sum(dim=1) / n_valid
        h_inf     = h + (1.0 - valid) * (-1e9)
        max_pool, _ = h_inf.max(dim=1)

        return torch.cat([mean_pool, max_pool], dim=-1)


class _CNNEncoder(nn.Module):
    """Small CNN for MAP_C × MAP_H × MAP_W → fixed embedding."""

    def __init__(self, in_channels: int, out_dim: int = 128):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(in_channels, 32, 3, padding=1), nn.ReLU(),
            nn.Conv2d(32, 64, 3, padding=1),          nn.ReLU(),
            nn.Conv2d(64, 64, 3, stride=2, padding=1), nn.ReLU(),  # halve spatial dims
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
        )
        self.proj    = nn.Linear(64, out_dim)
        self.out_dim = out_dim

    def forward(self, grid: torch.Tensor) -> torch.Tensor:
        # grid: (B, C, H, W)
        return F.relu(self.proj(self.conv(grid)))


# ── Main model ────────────────────────────────────────────────────────────────

class HybridActorCritic(nn.Module):
    """
    Multi-branch actor-critic.

    Parameters
    ----------
    cfg : ObsConfig
        Feature flags — must match the encoder used to produce observations.
        Baked into the checkpoint; mismatches at load time raise ValueError.
    hidden : list[int]
        Hidden layer sizes for the joint trunk MLP (default [256, 128]).
    """

    def __init__(self, cfg: ObsConfig, hidden: list[int] | None = None):
        super().__init__()
        self.cfg    = cfg
        hidden      = hidden or [256, 128]
        TYPE_EMB    = 8
        ENT_HIDDEN  = 32
        CITY_HIDDEN = 32

        # ── Global branch ─────────────────────────────────────────────────
        self.global_mlp = _mlp(GLOBAL_DIM_H, [64, 64])
        trunk_in = 64

        # ── Unit / enemy branches ─────────────────────────────────────────
        if cfg.use_my_units:
            self.unit_enc = _EntityEncoder(UNIT_FEAT_DIM, TYPE_EMB, ENT_HIDDEN, N_UNIT_TYPES)
            trunk_in += self.unit_enc.out_dim

        if cfg.use_enemy_units:
            self.enemy_enc = _EntityEncoder(ENEMY_FEAT_DIM, TYPE_EMB, ENT_HIDDEN, N_UNIT_TYPES)
            trunk_in += self.enemy_enc.out_dim

        # ── City branch ───────────────────────────────────────────────────
        if cfg.use_my_cities:
            self.city_enc = _CityEncoder(cfg.city_feat_dim(), CITY_HIDDEN)
            trunk_in += self.city_enc.out_dim

        # ── Tech branch ───────────────────────────────────────────────────
        if cfg.use_tech_multihot:
            self.tech_proj = nn.Sequential(nn.Linear(N_TECHS_H, 32), nn.ReLU())
            trunk_in += 32

        # ── CNN branch ────────────────────────────────────────────────────
        if cfg.use_global_cnn:
            self.cnn_enc = _CNNEncoder(MAP_C, out_dim=128)
            trunk_in += 128

        # ── Joint trunk ───────────────────────────────────────────────────
        self.trunk      = _mlp(trunk_in, hidden)
        self.actor_head = nn.Linear(hidden[-1], ACT_DIM_H)
        self.critic_head= nn.Linear(hidden[-1], 1)

        # Weight init
        nn.init.orthogonal_(self.actor_head.weight, gain=0.01)
        nn.init.zeros_(self.actor_head.bias)
        nn.init.orthogonal_(self.critic_head.weight, gain=1.0)
        nn.init.zeros_(self.critic_head.bias)

    # ------------------------------------------------------------------

    def _unpack(self, obs: torch.Tensor):
        """Split flat obs tensor into per-branch tensors."""
        B   = obs.size(0)
        off = 0

        g = obs[:, off:off + GLOBAL_DIM_H]; off += GLOBAL_DIM_H

        units = None
        if self.cfg.use_my_units:
            n     = MAX_MY_UNITS_H * UNIT_FEAT_DIM
            units = obs[:, off:off + n].view(B, MAX_MY_UNITS_H, UNIT_FEAT_DIM)
            off  += n

        enemies = None
        if self.cfg.use_enemy_units:
            n       = MAX_ENEMY_UNITS_H * ENEMY_FEAT_DIM
            enemies = obs[:, off:off + n].view(B, MAX_ENEMY_UNITS_H, ENEMY_FEAT_DIM)
            off    += n

        cities = None
        if self.cfg.use_my_cities:
            cdim   = self.cfg.city_feat_dim()
            n      = MAX_MY_CITIES_H * cdim
            cities = obs[:, off:off + n].view(B, MAX_MY_CITIES_H, cdim)
            off   += n

        tech = None
        if self.cfg.use_tech_multihot:
            tech = obs[:, off:off + N_TECHS_H]
            off += N_TECHS_H

        map_grid = None
        if self.cfg.use_global_cnn:
            n        = MAP_H * MAP_W * MAP_C
            map_grid = obs[:, off:off + n].view(B, MAP_C, MAP_H, MAP_W)

        return g, units, enemies, cities, tech, map_grid

    def _encode(self, obs: torch.Tensor) -> torch.Tensor:
        obs = torch.nan_to_num(obs, nan=0.0, posinf=1.0, neginf=-1.0)
        g, units, enemies, cities, tech, map_grid = self._unpack(obs)

        parts = [self.global_mlp(g)]
        if units    is not None: parts.append(self.unit_enc(units))
        if enemies  is not None: parts.append(self.enemy_enc(enemies))
        if cities   is not None: parts.append(self.city_enc(cities))
        if tech     is not None: parts.append(self.tech_proj(tech))
        if map_grid is not None: parts.append(self.cnn_enc(map_grid))

        return self.trunk(torch.cat(parts, dim=-1))

    def forward(self, obs: torch.Tensor, mask: torch.Tensor | None = None):
        x      = self._encode(obs)
        logits = self.actor_head(x)
        if mask is not None:
            logits = logits + (1.0 - mask) * -1e9
        value = self.critic_head(x).squeeze(-1)
        return logits, value

    def get_action(self, obs: torch.Tensor, mask: torch.Tensor | None = None):
        """Sample an action. Returns (action, log_prob, value)."""
        logits, value = self(obs, mask)
        dist   = Categorical(logits=logits)
        action = dist.sample()
        return action, dist.log_prob(action), value

    def evaluate_actions(
        self, obs: torch.Tensor, actions: torch.Tensor, mask: torch.Tensor | None = None
    ):
        """For PPO update. Returns (log_probs, values, entropy)."""
        logits, value = self(obs, mask)
        dist = Categorical(logits=logits)
        return dist.log_prob(actions), value, dist.entropy()
