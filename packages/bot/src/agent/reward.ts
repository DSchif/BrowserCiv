import type { MatchView } from "@browserciv/shared";

export type RewardFn = (prev: MatchView, next: MatchView, playerId: string) => number;

/**
 * City + unit maximisation reward.
 *
 * Each new city is worth 5 points; each new unit is worth 1 point.
 * A small per-step penalty (-0.02) encourages the agent to move quickly
 * rather than idling.
 */
export const cityAndUnitReward: RewardFn = (
  prev: MatchView,
  next: MatchView,
  playerId: string,
): number => {
  const prevCities = prev.cities.filter((c) => c.ownerId === playerId).length;
  const nextCities = next.cities.filter((c) => c.ownerId === playerId).length;
  const prevUnits = prev.units.filter((u) => u.ownerId === playerId).length;
  const nextUnits = next.units.filter((u) => u.ownerId === playerId).length;

  return (nextCities - prevCities) * 5 + (nextUnits - prevUnits) * 1 - 0.02;
};

/** Sparse terminal reward: +100 for winning, -100 for losing, 0 draw. */
export const winLoseReward: RewardFn = (
  _prev: MatchView,
  next: MatchView,
  playerId: string,
): number => {
  if (next.status !== "finished") return 0;
  if (next.winnerId === playerId) return 100;
  if (next.winnerId === null) return 0;
  return -100;
};

/** Combine two reward functions (sum). */
export function combineRewards(...fns: RewardFn[]): RewardFn {
  return (prev, next, playerId) =>
    fns.reduce((sum, fn) => sum + fn(prev, next, playerId), 0);
}
