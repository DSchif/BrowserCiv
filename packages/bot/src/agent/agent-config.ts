export type RewardSignal =
  | "cities_owned_delta"
  | "units_owned_delta"
  | "tiles_discovered_delta"
  | "enemy_units_killed"
  | "hp_damage_dealt"
  | "turn_survived"
  | "win"
  | "lose";

export interface RewardEntry {
  signal: RewardSignal;
  weight: number;
}

export interface AgentConfig {
  network: { hidden: number[] };
  rewards: RewardEntry[];
  training: {
    lr?: number;
    epsilon_decay?: number;
    epsilon_min?: number;
    gamma?: number;
  };
}
