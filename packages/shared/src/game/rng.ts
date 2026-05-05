/**
 * Deterministic 32-bit PRNG (mulberry32). Same seed → same sequence on every
 * platform. State is a plain number so it serializes cleanly into match state.
 */
export type RngState = number;

export function rng(seed: number): RngState {
  // Force into uint32.
  return seed >>> 0;
}

export function next(state: RngState): { value: number; state: RngState } {
  let t = (state + 0x6d2b79f5) >>> 0;
  let x = Math.imul(t ^ (t >>> 15), t | 1);
  x = (x ^ (x + Math.imul(x ^ (x >>> 7), x | 61))) >>> 0;
  const value = (x ^ (x >>> 14)) >>> 0;
  // Return next state and a [0,1) float.
  return { state: t, value: value / 4294967296 };
}

export function nextInt(state: RngState, maxExclusive: number): { value: number; state: RngState } {
  const r = next(state);
  return { state: r.state, value: Math.floor(r.value * maxExclusive) };
}

export function pick<T>(state: RngState, items: readonly T[]): { value: T; state: RngState } {
  const r = nextInt(state, items.length);
  return { state: r.state, value: items[r.value]! };
}
