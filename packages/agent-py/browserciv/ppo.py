from dataclasses import dataclass, field
import numpy as np
import torch
import torch.nn.functional as F


@dataclass
class Rollout:
    obs:       list = field(default_factory=list)
    masks:     list = field(default_factory=list)
    actions:   list = field(default_factory=list)
    log_probs: list = field(default_factory=list)
    values:    list = field(default_factory=list)
    rewards:   list = field(default_factory=list)
    dones:     list = field(default_factory=list)

    def add(self, obs, mask, action, log_prob, value, reward, done):
        self.obs.append(obs)
        self.masks.append(mask)
        self.actions.append(int(action))
        self.log_probs.append(float(log_prob))
        self.values.append(float(value))
        self.rewards.append(float(reward))
        self.dones.append(float(done))

    def clear(self):
        for attr in ("obs", "masks", "actions", "log_probs", "values", "rewards", "dones"):
            setattr(self, attr, [])

    def __len__(self):
        return len(self.obs)


def _compute_gae(rewards: list, values: list, dones: list, gamma: float, lam: float) -> np.ndarray:
    n = len(rewards)
    advantages = np.zeros(n, dtype=np.float32)
    last_adv = 0.0
    for t in reversed(range(n)):
        next_val = values[t + 1] if t + 1 < n else 0.0
        delta = rewards[t] + gamma * next_val * (1.0 - dones[t]) - values[t]
        last_adv = delta + gamma * lam * (1.0 - dones[t]) * last_adv
        advantages[t] = last_adv
    return advantages


def ppo_update(
    model,
    optimizer: torch.optim.Optimizer,
    rollout: Rollout,
    *,
    clip_eps: float = 0.2,
    value_coef: float = 0.5,
    entropy_coef: float = 0.01,
    gamma: float = 0.99,
    lam: float = 0.95,
    n_epochs: int = 4,
    batch_size: int = 64,
    device: torch.device | None = None,
) -> dict:
    if device is None:
        device = next(model.parameters()).device

    obs_t    = torch.nan_to_num(torch.tensor(np.array(rollout.obs),   dtype=torch.float32, device=device), nan=0.0)
    masks_t  = torch.nan_to_num(torch.tensor(np.array(rollout.masks), dtype=torch.float32, device=device), nan=0.0)
    acts_t   = torch.tensor(rollout.actions,             dtype=torch.long,    device=device)
    old_lp_t = torch.tensor(rollout.log_probs,           dtype=torch.float32, device=device)

    advantages_np = _compute_gae(rollout.rewards, rollout.values, rollout.dones, gamma, lam)
    returns_np    = advantages_np + np.array(rollout.values, dtype=np.float32)

    adv_t = torch.tensor(advantages_np, device=device)
    ret_t = torch.tensor(returns_np,    device=device)
    adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-8)

    n = obs_t.shape[0]
    totals = {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0, "n": 0}

    for _ in range(n_epochs):
        idx = torch.randperm(n, device=device)
        for start in range(0, n, batch_size):
            b = idx[start : start + batch_size]
            log_prob, value, entropy = model.evaluate_actions(obs_t[b], acts_t[b], masks_t[b])

            ratio  = torch.exp(log_prob - old_lp_t[b])
            surr   = torch.min(ratio * adv_t[b], torch.clamp(ratio, 1 - clip_eps, 1 + clip_eps) * adv_t[b])
            p_loss = -surr.mean()
            v_loss = F.mse_loss(value, ret_t[b])
            loss   = p_loss + value_coef * v_loss - entropy_coef * entropy.mean()

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 0.5)
            optimizer.step()

            totals["policy_loss"] += p_loss.item()
            totals["value_loss"]  += v_loss.item()
            totals["entropy"]     += entropy.mean().item()
            totals["n"]           += 1

    k = max(totals.pop("n"), 1)
    return {key: val / k for key, val in totals.items()}
