import { validatePack } from "@browserciv/content-validator";
import type { ContentPack } from "@browserciv/shared";
import * as path from "node:path";

let cached: ContentPack | null = null;

const PACK_DIR =
  process.env.CONTENT_PACK_DIR ??
  path.resolve(process.cwd(), "../../content/core-realworld");

export async function loadContentPack(): Promise<ContentPack> {
  if (cached) return cached;
  const result = await validatePack(PACK_DIR);
  if (!result.ok || !result.pack) {
    const issues = result.issues
      .map((i) => `${[i.file, i.path].filter(Boolean).join(":")} — ${i.message}`)
      .join("\n  ");
    throw new Error(`content pack failed validation:\n  ${issues}`);
  }
  cached = result.pack;
  return cached;
}

export function getContentPack(): ContentPack {
  if (!cached) throw new Error("content pack not loaded");
  return cached;
}
