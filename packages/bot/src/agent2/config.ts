// ── Reward signals ────────────────────────────────────────────────────────────

export type HierRewardSignal =
  | "cities_owned_delta"
  | "units_owned_delta"
  | "tiles_discovered_delta"
  | "enemy_units_killed"
  | "hp_damage_dealt"
  | "turn_survived"
  | "win"
  | "lose"
  | "tech_researched"
  | "improvement_built"
  | "city_grew"
  | "gold_per_turn_delta"
  | "gold_delta";

export interface HierRewardEntry {
  signal: HierRewardSignal;
  weight: number;
}

// ── Goals ─────────────────────────────────────────────────────────────────────

export type GoalId = "explore" | "expand" | "attack" | "defend" | "develop" | "tech" | "economy";

export interface GoalDef {
  id: GoalId;
  label: string;
  enabled: boolean;
  rewards: HierRewardEntry[];
}

// ── Feature flags ─────────────────────────────────────────────────────────────

export interface StateFeaturesConfig {
  base_features: boolean;
  enemy_units_visible_count: boolean;
  enemy_cities_visible_count: boolean;
  at_war: boolean;
  era_index: boolean;
  turns_since_last_city: boolean;
  total_production_rate: boolean;
  avg_city_hp_fraction: boolean;
}

export interface MoveUnitFeaturesConfig {
  enabled: boolean;
  unseen_neighbors_count: boolean;
  terrain_cost: boolean;
  has_resource: boolean;
  is_melee_attack: boolean;
  num_friendlies_adjacent: boolean;
  num_enemies_adjacent: boolean;
  unit_hp_fraction: boolean;
  unit_movement_fraction: boolean;
}

export interface RangedAttackFeaturesConfig {
  enabled: boolean;
  target_hp_fraction: boolean;
  target_unit_strength: boolean;
  friendly_units_in_range: boolean;
}

export interface FoundCityFeaturesConfig {
  enabled: boolean;
  tile_yield_score: boolean;
  dist_to_nearest_city: boolean;
  resources_in_radius: boolean;
}

export interface SetResearchFeaturesConfig {
  enabled: boolean;
  tech_era_index: boolean;
  tech_unlocks_unit_count: boolean;
  tech_unlocks_building_count: boolean;
}

export interface SetCityProductionFeaturesConfig {
  enabled: boolean;
  is_unit: boolean;
  is_building: boolean;
  is_wonder: boolean;
  item_cost: boolean;
  city_production_per_turn: boolean;
}

export interface DeclareWarFeaturesConfig {
  enabled: boolean;
  enemy_relative_strength: boolean;
  enemy_city_count: boolean;
}

export interface MakePeaceFeaturesConfig {
  enabled: boolean;
  enemy_relative_strength: boolean;
  enemy_city_count: boolean;
}

export interface SimpleIntentFeaturesConfig {
  enabled: boolean;
}

export interface IntentFeaturesConfig {
  MoveUnit: MoveUnitFeaturesConfig;
  RangedAttack: RangedAttackFeaturesConfig;
  FoundCity: FoundCityFeaturesConfig;
  SetResearch: SetResearchFeaturesConfig;
  SetCityProduction: SetCityProductionFeaturesConfig;
  DeclareWar: DeclareWarFeaturesConfig;
  MakePeace: MakePeaceFeaturesConfig;
  EndTurn: SimpleIntentFeaturesConfig;
  Other: SimpleIntentFeaturesConfig;
}

export interface FeaturesConfig {
  state: StateFeaturesConfig;
  intent: IntentFeaturesConfig;
}

// ── Network / training configs ────────────────────────────────────────────────

export interface NetworkConfig {
  hidden: number[];
}

export interface TrainingConfig {
  lr: number;
  epsilon: number;
  epsilon_decay: number;
  epsilon_min: number;
  gamma: number;
}

export interface ManagerConfig {
  network: NetworkConfig;
  training: TrainingConfig;
  goal_horizon: number;
}

export interface TacticalConfig {
  network: NetworkConfig;
  training: TrainingConfig;
}

// ── Top-level config ──────────────────────────────────────────────────────────

export interface HierAgentConfig {
  manager: ManagerConfig;
  tactical: TacticalConfig;
  goals: GoalDef[];
  global_rewards: HierRewardEntry[];
  features: FeaturesConfig;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_STATE_FEATURES: StateFeaturesConfig = {
  base_features: true,
  enemy_units_visible_count: true,
  enemy_cities_visible_count: true,
  at_war: true,
  era_index: true,
  turns_since_last_city: true,
  total_production_rate: true,
  avg_city_hp_fraction: true,
};

export const DEFAULT_INTENT_FEATURES: IntentFeaturesConfig = {
  MoveUnit: {
    enabled: true,
    unseen_neighbors_count: true,
    terrain_cost: true,
    has_resource: true,
    is_melee_attack: true,
    num_friendlies_adjacent: true,
    num_enemies_adjacent: true,
    unit_hp_fraction: true,
    unit_movement_fraction: true,
  },
  RangedAttack: { enabled: true, target_hp_fraction: true, target_unit_strength: true, friendly_units_in_range: true },
  FoundCity:    { enabled: true, tile_yield_score: true, dist_to_nearest_city: true, resources_in_radius: true },
  SetResearch:  { enabled: true, tech_era_index: true, tech_unlocks_unit_count: true, tech_unlocks_building_count: true },
  SetCityProduction: { enabled: true, is_unit: true, is_building: true, is_wonder: true, item_cost: true, city_production_per_turn: true },
  DeclareWar:   { enabled: true, enemy_relative_strength: true, enemy_city_count: true },
  MakePeace:    { enabled: true, enemy_relative_strength: true, enemy_city_count: true },
  EndTurn:      { enabled: true },
  Other:        { enabled: true },
};

export const DEFAULT_HIER_CONFIG: HierAgentConfig = {
  manager: {
    network: { hidden: [32, 16] },
    training: { lr: 0.001, epsilon: 1.0, epsilon_decay: 0.99, epsilon_min: 0.1, gamma: 0.95 },
    goal_horizon: 5,
  },
  tactical: {
    network: { hidden: [64, 32] },
    training: { lr: 0.001, epsilon: 1.0, epsilon_decay: 0.995, epsilon_min: 0.05, gamma: 0.95 },
  },
  goals: [
    { id: "explore", label: "Explore", enabled: true, rewards: [{ signal: "tiles_discovered_delta", weight: 1.0 }] },
    { id: "expand",  label: "Expand",  enabled: true, rewards: [{ signal: "cities_owned_delta", weight: 5.0 }, { signal: "tiles_discovered_delta", weight: 0.2 }] },
    { id: "attack",  label: "Attack",  enabled: true, rewards: [{ signal: "enemy_units_killed", weight: 3.0 }, { signal: "hp_damage_dealt", weight: 0.1 }, { signal: "cities_owned_delta", weight: 5.0 }] },
    { id: "defend",  label: "Defend",  enabled: true, rewards: [{ signal: "turn_survived", weight: 0.5 }] },
    { id: "develop", label: "Develop", enabled: true, rewards: [{ signal: "improvement_built", weight: 1.0 }, { signal: "city_grew", weight: 2.0 }, { signal: "gold_per_turn_delta", weight: 0.5 }] },
    { id: "tech",    label: "Tech",    enabled: true, rewards: [{ signal: "tech_researched", weight: 5.0 }, { signal: "units_owned_delta", weight: 0.5 }] },
    { id: "economy", label: "Economy", enabled: false, rewards: [{ signal: "gold_delta", weight: 1.0 }, { signal: "gold_per_turn_delta", weight: 2.0 }] },
  ],
  global_rewards: [
    { signal: "win",  weight: 100.0 },
    { signal: "lose", weight: -100.0 },
  ],
  features: {
    state: DEFAULT_STATE_FEATURES,
    intent: DEFAULT_INTENT_FEATURES,
  },
};
