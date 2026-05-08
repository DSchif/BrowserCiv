import torch
import torch.nn as nn
from torch.distributions import Categorical
from .constants import OBS_DIM, ACT_DIM


class ActorCritic(nn.Module):
    def __init__(self, hidden: list[int] | None = None):
        super().__init__()
        sizes = hidden or [256, 128]

        layers: list[nn.Module] = []
        in_dim = OBS_DIM
        for h in sizes:
            layers += [nn.Linear(in_dim, h), nn.LayerNorm(h), nn.ReLU()]
            in_dim = h
        self.trunk = nn.Sequential(*layers)

        self.actor_head = nn.Linear(in_dim, ACT_DIM)
        self.critic_head = nn.Linear(in_dim, 1)

        nn.init.orthogonal_(self.actor_head.weight, gain=0.01)
        nn.init.zeros_(self.actor_head.bias)
        nn.init.orthogonal_(self.critic_head.weight, gain=1.0)
        nn.init.zeros_(self.critic_head.bias)

    def forward(self, obs: torch.Tensor, mask: torch.Tensor | None = None):
        obs = torch.nan_to_num(obs, nan=0.0, posinf=1.0, neginf=-1.0)
        x = self.trunk(obs)
        logits = self.actor_head(x)
        if mask is not None:
            logits = logits + (1.0 - mask) * -1e9
        value = self.critic_head(x).squeeze(-1)
        return logits, value

    def get_action(self, obs: torch.Tensor, mask: torch.Tensor | None = None):
        logits, value = self(obs, mask)
        dist = Categorical(logits=logits)
        action = dist.sample()
        return action, dist.log_prob(action), value

    def evaluate_actions(self, obs: torch.Tensor, actions: torch.Tensor, mask: torch.Tensor | None = None):
        logits, value = self(obs, mask)
        dist = Categorical(logits=logits)
        return dist.log_prob(actions), value, dist.entropy()
