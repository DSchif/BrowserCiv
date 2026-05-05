import { z } from "zod";
import { AbilityRef } from "./ability.js";
import { DisplayText } from "./common.js";
import { DiplomacyActionId } from "./ids.js";

/**
 * State requirements for a diplomacy action. The engine evaluates these
 * server-side before permitting the action.
 */
export const DiplomacyStateRequirement = z
  .object({
    relationship: z
      .enum(["any", "peace", "war", "open_borders", "ally"])
      .default("any"),
    not_relationship: z
      .array(z.enum(["peace", "war", "open_borders", "ally"]))
      .default([]),
  })
  .strict();

export const DiplomacyAction = z
  .object({
    id: DiplomacyActionId,
    name: DisplayText,
    description: DisplayText.optional(),
    requires_state: DiplomacyStateRequirement.default({
      relationship: "any",
      not_relationship: [],
    }),
    /** Effects applied when the action is accepted. */
    effects: z.array(AbilityRef).default([]),
  })
  .strict();

export type DiplomacyAction = z.infer<typeof DiplomacyAction>;
