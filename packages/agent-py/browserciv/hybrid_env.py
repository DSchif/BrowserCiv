"""HybridGameEnv: GameEnv subclass that uses the hybrid encoder/decoder."""
from __future__ import annotations

import numpy as np

from .env import GameEnv
from .hybrid_constants import ACT_DIM_H
from .hybrid_encoder import hybrid_encode_state, hybrid_decode_action
from .obs_config import ObsConfig


class HybridGameEnv(GameEnv):
    """Drop-in replacement for GameEnv that uses the hybrid observation encoder."""

    def __init__(self, server_url: str, match_token: str, viewer_id: str, obs_config: ObsConfig):
        super().__init__(server_url, match_token, viewer_id)
        self._obs_cfg = obs_config

    def _encode_state(self, state: dict) -> tuple[np.ndarray, np.ndarray]:
        return hybrid_encode_state(state, self._obs_cfg)

    def _decode_action(self, action: int, state: dict) -> dict | None:
        return hybrid_decode_action(action, state, self.viewer_id)

    def _zero_obs(self) -> tuple[np.ndarray, np.ndarray]:
        return (
            np.zeros(self._obs_cfg.obs_dim(), dtype=np.float32),
            np.zeros(ACT_DIM_H, dtype=np.float32),
        )
