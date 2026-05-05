import { MatchRuntime } from "./runtime.js";

const matches = new Map<string, MatchRuntime>();

export function putMatch(rt: MatchRuntime): void {
  matches.set(rt.state.id, rt);
}

export function getMatch(id: string): MatchRuntime | undefined {
  return matches.get(id);
}

export function listLobbies(): MatchRuntime[] {
  return [...matches.values()].filter((m) => m.state.status === "lobby");
}

export function deleteMatch(id: string): void {
  matches.delete(id);
}

export function allMatches(): MatchRuntime[] {
  return [...matches.values()];
}
