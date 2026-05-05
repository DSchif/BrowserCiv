import { z } from "zod";
import { AbilityRef } from "./ability.js";
import { DisplayText } from "./common.js";
import { VictoryConditionId } from "./ids.js";

export const VictoryCondition = z
  .object({
    id: VictoryConditionId,
    name: DisplayText,
    description: DisplayText.optional(),
    /** Handler returns boolean against game state. */
    check: AbilityRef,
  })
  .strict();

export type VictoryCondition = z.infer<typeof VictoryCondition>;
