import { z } from "zod";
import { DisplayText } from "./common.js";
import { Id } from "./ids.js";

export const TypeId = Id.brand<"TypeId">();
export type TypeId = z.infer<typeof TypeId>;

/**
 * A combat / unit Type. Used both:
 * - As an attack flavor (e.g. `type.piercing`, `type.gunpowder`, `type.electric`)
 * - As a unit defensive flavor (e.g. `type.armored`, `type.cavalry`, `type.water_unit`)
 *
 * Effectiveness pairs (attacker type → defender type → multiplier) live in
 * pack.effectiveness. Missing pairs default to 1.0×.
 */
export const TypeDef = z
  .object({
    id: TypeId,
    name: DisplayText,
    description: DisplayText.optional(),
    /** Optional UI hint (hex color). */
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  })
  .strict();

export type TypeDef = z.infer<typeof TypeDef>;

/** A single multiplier rule. Defaults to 1.0× if a pair has no entry. */
export const Effectiveness = z
  .object({
    attacker: TypeId,
    defender: TypeId,
    multiplier: z.number().min(0).max(10),
  })
  .strict();

export type Effectiveness = z.infer<typeof Effectiveness>;

// (Attack shape lives inline in UnitDef.attacks — see schemas/unit.ts.)
