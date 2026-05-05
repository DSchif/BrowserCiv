import { z } from "zod";
import { AbilityHandlerId } from "./ids.js";

/**
 * Reference to a server-registered ability handler. The handler ID must be present
 * in the server's whitelist registry; params are passed verbatim to the handler.
 *
 * This is the ONLY seam between data-driven content and code. New mechanics that
 * cannot be expressed by existing handlers require adding a handler to the registry.
 */
export const AbilityRef = z
  .object({
    handler_id: AbilityHandlerId,
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type AbilityRef = z.infer<typeof AbilityRef>;
