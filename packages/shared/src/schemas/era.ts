import { z } from "zod";
import { DisplayText } from "./common.js";
import { EraId, TechId } from "./ids.js";

export const Era = z
  .object({
    id: EraId,
    name: DisplayText,
    description: DisplayText.optional(),
    /** Lower is earlier. */
    order: z.number().int(),
    /** Researching any of these techs unlocks this era for that civ. */
    unlocked_by_techs: z.array(TechId).default([]),
  })
  .strict();

export type Era = z.infer<typeof Era>;
