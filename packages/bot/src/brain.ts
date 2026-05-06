import type { Intent, MatchView } from "@browserciv/shared";

/**
 * The only contract an AI brain must fulfil.
 *
 * Called once whenever it becomes this bot's turn (or whenever the state
 * changes while it is already the bot's turn — e.g. after a unit move the
 * runner calls the brain again so it can issue the next action).
 *
 * Return null / undefined to do nothing this cycle (runner will call again
 * on the next snapshot).  Return an Intent to send it immediately.
 * Return EndTurn to end the turn.
 *
 * The runner keeps calling the brain after each ack until it returns null or
 * EndTurn — so a brain that always returns null will just idle and never
 * progress; it must eventually return EndTurn.
 */
export type Brain = (
  state: MatchView,
  playerId: string,
) => Intent | null | Promise<Intent | null>;
