import { appendFileSync } from "node:fs";
import type { Intent, MatchView } from "@browserciv/shared";

export interface LogEntry {
  episode: number;
  step: number;
  playerId: string;
  state: MatchView;
  intent: Intent;
  /** Simple scalar reward: gold + science + culture delta from previous state. */
  reward: number;
}

/**
 * Appends one JSONL line per (state, intent) pair.
 * Each line is a self-contained training example:
 *   { episode, step, playerId, state, intent, reward }
 *
 * Compatible with any JSONL reader (pandas, HuggingFace datasets, etc).
 */
export class Logger {
  private step = 0;
  private prevGold = 0;
  private prevScience = 0;
  private prevCulture = 0;

  constructor(
    private path: string,
    private episode: number,
    private playerId: string,
  ) {}

  log(state: MatchView, intent: Intent): void {
    const me = state.players.find((p) => p.id === this.playerId);
    const gold = me?.gold ?? 0;
    const science = me?.science ?? 0;
    const culture = me?.culture ?? 0;
    const reward = (gold - this.prevGold) + (science - this.prevScience) * 2 + (culture - this.prevCulture);
    this.prevGold = gold;
    this.prevScience = science;
    this.prevCulture = culture;

    const entry: LogEntry = {
      episode: this.episode,
      step: this.step++,
      playerId: this.playerId,
      state,
      intent,
      reward,
    };
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }
}
