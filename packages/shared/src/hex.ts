import { z } from "zod";

export const AxialCoord = z.object({
  q: z.number().int(),
  r: z.number().int(),
});
export type AxialCoord = z.infer<typeof AxialCoord>;

export interface CubeCoord {
  x: number;
  y: number;
  z: number;
}

export function axialToCube(a: AxialCoord): CubeCoord {
  const x = a.q;
  const z = a.r;
  const y = -x - z;
  return { x, y, z };
}

export function cubeToAxial(c: CubeCoord): AxialCoord {
  return { q: c.x, r: c.z };
}

export function distance(a: AxialCoord, b: AxialCoord): number {
  const ac = axialToCube(a);
  const bc = axialToCube(b);
  return Math.max(
    Math.abs(ac.x - bc.x),
    Math.abs(ac.y - bc.y),
    Math.abs(ac.z - bc.z),
  );
}

export const NEIGHBORS: ReadonlyArray<AxialCoord> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function neighbors(a: AxialCoord): AxialCoord[] {
  return NEIGHBORS.map((d) => ({ q: a.q + d.q, r: a.r + d.r }));
}

export function key(a: AxialCoord): string {
  return `${a.q},${a.r}`;
}

const SQRT3 = Math.sqrt(3);

export function axialToPixel(a: AxialCoord, size: number): { x: number; y: number } {
  const x = size * (SQRT3 * a.q + (SQRT3 / 2) * a.r);
  const y = size * ((3 / 2) * a.r);
  return { x, y };
}
