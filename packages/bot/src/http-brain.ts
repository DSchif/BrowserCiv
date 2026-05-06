import type { Intent, MatchView } from "@browserciv/shared";
import type { Brain } from "./brain.js";

/**
 * HTTP brain adapter.
 *
 * On each turn, POSTs the current MatchView to `url` and expects a JSON
 * response of shape { intent: Intent | null }.
 *
 * This lets you run your model in any language/framework as a plain HTTP
 * server.  Example Python server contract:
 *
 *   POST /step
 *   Body:  { "state": <MatchView>, "playerId": "<string>" }
 *   Reply: { "intent": <Intent> | null }
 *
 * The bot runner handles retries and fallback to EndTurn on error.
 */
export function makeHttpBrain(url: string, timeoutMs = 5000): Brain {
  return async (state: MatchView, playerId: string): Promise<Intent | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, playerId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error(`[http-brain] ${res.status} from ${url}`);
        return { type: "EndTurn", actorId: playerId };
      }
      const body = (await res.json()) as { intent: Intent | null };
      return body.intent ?? null;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        console.error(`[http-brain] timeout after ${timeoutMs}ms`);
      } else {
        console.error(`[http-brain] error:`, err);
      }
      return { type: "EndTurn", actorId: playerId };
    } finally {
      clearTimeout(timer);
    }
  };
}
