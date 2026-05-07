import type { ContentPack, Intent, MatchView } from "@browserciv/shared";
import { getLegalIntents } from "@browserciv/shared";
import { MLP, type LayerCache, type MLPWeights } from "../agent/mlp.js";
import type { GoalId, IntentFeaturesConfig, TacticalConfig } from "./config.js";
import {
  goalOneHot,
  intentSpecificFeatures,
  intentTypeOneHot,
  tacticalFeatureVector,
} from "./intent-features.js";

export class Tactical {
  private net: MLP;
  private cfg: TacticalConfig;
  private enabledGoals: GoalId[];
  epsilon: number;
  totalUpdates = 0;

  constructor(cfg: TacticalConfig, inputSize: number, enabledGoals: GoalId[]) {
    this.cfg = cfg;
    this.enabledGoals = enabledGoals;
    this.epsilon = cfg.training.epsilon;
    this.net = new MLP(inputSize, cfg.network.hidden);
  }

  private phi(
    stateFeats: number[],
    goalId: GoalId,
    intent: Intent,
    view: MatchView,
    playerId: string,
    intentCfg: IntentFeaturesConfig,
    content: ContentPack,
  ): number[] {
    const goalVec = goalOneHot(goalId, this.enabledGoals);
    return tacticalFeatureVector(stateFeats, goalVec, intent, view, playerId, intentCfg, content);
  }

  selectIntent(
    legal: Intent[],
    stateFeats: number[],
    goalId: GoalId,
    view: MatchView,
    playerId: string,
    intentCfg: IntentFeaturesConfig,
    content: ContentPack,
    training = true,
  ): Intent {
    if (training && Math.random() < this.epsilon) {
      return legal[Math.floor(Math.random() * legal.length)]!;
    }
    let best = legal[0]!;
    let bestQ = -Infinity;
    for (const intent of legal) {
      const features = this.phi(stateFeats, goalId, intent, view, playerId, intentCfg, content);
      const { q } = this.net.forward(features);
      if (q > bestQ) { bestQ = q; best = intent; }
    }
    return best;
  }

  update(
    phi: number[],
    reward: number,
    nextStateFeats: number[] | null,
    nextGoalId: GoalId,
    nextLegal: Intent[],
    nextView: MatchView | null,
    playerId: string,
    intentCfg: IntentFeaturesConfig,
    content: ContentPack,
  ): void {
    const { q: currentQ, cache } = this.net.forward(phi);

    let targetQ: number;
    if (nextStateFeats === null || nextView === null) {
      targetQ = reward;
    } else {
      // Sample at most 20 intents for bootstrap — late game can have hundreds,
      // scoring all of them dominates CPU time at no meaningful learning benefit.
      const MAX_BOOTSTRAP = 20;
      const sample = nextLegal.length > MAX_BOOTSTRAP
        ? nextLegal.slice().sort(() => Math.random() - 0.5).slice(0, MAX_BOOTSTRAP)
        : nextLegal;
      const maxNextQ = sample.length > 0
        ? Math.max(...sample.map((intent) => {
            const nextPhi = this.phi(nextStateFeats, nextGoalId, intent, nextView, playerId, intentCfg, content);
            const { q } = this.net.forward(nextPhi);
            return q;
          }))
        : 0;
      targetQ = reward + this.cfg.training.gamma * maxNextQ;
    }

    const error = targetQ - currentQ;
    this.net.tdUpdate(cache as LayerCache[], error, this.cfg.training.lr);
    this.totalUpdates++;
  }

  decayEpsilon(): void {
    this.epsilon = Math.max(
      this.cfg.training.epsilon_min,
      this.epsilon * this.cfg.training.epsilon_decay,
    );
  }

  inputSize(): number {
    return this.net.toJSON().layers[0]?.inSize ?? 0;
  }

  toJSON(): MLPWeights { return this.net.toJSON(); }

  static fromJSON(
    data: MLPWeights,
    cfg: TacticalConfig,
    inputSize: number,
    enabledGoals: GoalId[],
  ): Tactical {
    const t = new Tactical(cfg, inputSize, enabledGoals);
    t.net = MLP.fromJSON(data);
    return t;
  }
}
