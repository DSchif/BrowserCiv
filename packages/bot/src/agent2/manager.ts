import { MLP, type LayerCache, type MLPWeights } from "../agent/mlp.js";
import type { GoalId, ManagerConfig } from "./config.js";

export class Manager {
  private net: MLP;
  private enabledGoals: GoalId[];
  private cfg: ManagerConfig;
  epsilon: number;
  totalUpdates = 0;

  constructor(cfg: ManagerConfig, stateFeatureSize: number, enabledGoals: GoalId[]) {
    this.cfg = cfg;
    this.enabledGoals = enabledGoals;
    this.epsilon = cfg.training.epsilon;
    const inputSize = stateFeatureSize + enabledGoals.length;
    this.net = new MLP(inputSize, cfg.network.hidden);
  }

  private goalInputVec(stateFeats: number[], goalId: GoalId): number[] {
    const oneHot = this.enabledGoals.map((g) => (g === goalId ? 1 : 0));
    return [...stateFeats, ...oneHot];
  }

  selectGoal(stateFeats: number[], training = true): GoalId {
    if (this.enabledGoals.length === 0) return "explore";
    if (training && Math.random() < this.epsilon) {
      return this.enabledGoals[Math.floor(Math.random() * this.enabledGoals.length)]!;
    }
    let bestGoal = this.enabledGoals[0]!;
    let bestV = -Infinity;
    for (const g of this.enabledGoals) {
      const { q } = this.net.forward(this.goalInputVec(stateFeats, g));
      if (q > bestV) { bestV = q; bestGoal = g; }
    }
    return bestGoal;
  }

  update(
    stateFeatsAtStart: number[],
    goal: GoalId,
    accReward: number,
    nextStateFeats: number[] | null,
  ): void {
    const phi = this.goalInputVec(stateFeatsAtStart, goal);
    const { q: currentV, cache } = this.net.forward(phi);

    let targetV: number;
    if (nextStateFeats === null) {
      targetV = accReward;
    } else {
      const maxNextV = this.enabledGoals.length > 0
        ? Math.max(...this.enabledGoals.map((g) => {
            const { q } = this.net.forward(this.goalInputVec(nextStateFeats, g));
            return q;
          }))
        : 0;
      targetV = accReward + this.cfg.training.gamma * maxNextV;
    }

    const error = targetV - currentV;
    this.net.tdUpdate(cache as LayerCache[], error, this.cfg.training.lr);
    this.totalUpdates++;
  }

  decayEpsilon(): void {
    this.epsilon = Math.max(
      this.cfg.training.epsilon_min,
      this.epsilon * this.cfg.training.epsilon_decay,
    );
  }

  getEnabledGoals(): GoalId[] { return this.enabledGoals; }

  inputSize(): number {
    return this.net.toJSON().layers[0]?.inSize ?? 0;
  }

  toJSON(): MLPWeights { return this.net.toJSON(); }

  static fromJSON(
    data: MLPWeights,
    cfg: ManagerConfig,
    enabledGoals: GoalId[],
    stateFeatureSize: number,
  ): Manager {
    const m = new Manager(cfg, stateFeatureSize, enabledGoals);
    m.net = MLP.fromJSON(data);
    return m;
  }
}
