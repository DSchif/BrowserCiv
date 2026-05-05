import { z } from "zod";

export const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, "must be semver");

export const DisplayText = z.string().min(1).max(2048);

export const Yields = z
  .object({
    food: z.number().int().optional(),
    production: z.number().int().optional(),
    gold: z.number().int().optional(),
    science: z.number().int().optional(),
    culture: z.number().int().optional(),
    happiness: z.number().int().optional(),
  })
  .strict();

export type Yields = z.infer<typeof Yields>;

export const Cost = z
  .object({
    production: z.number().int().nonnegative().optional(),
    gold: z.number().int().nonnegative().optional(),
    science: z.number().int().nonnegative().optional(),
    resources: z.record(z.string(), z.number().int().positive()).optional(),
  })
  .strict();

export type Cost = z.infer<typeof Cost>;
