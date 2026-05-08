import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ContentPack, MatchState } from "@browserciv/shared";
import { MatchRuntime } from "./runtime.js";
import type { GuestCredential } from "./auth.js";
import {
  isDdbEnabled,
  loadAllMatchesDdb,
  loadTokensDdb,
  persistMatchDdb,
  persistTokensDdb,
  deleteMatchDdb,
} from "./persistence-ddb.js";

const DATA_DIR = process.env.BROWSERCIV_DATA_DIR ?? path.resolve("data");
const MATCHES_DIR = path.join(DATA_DIR, "matches");
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");

interface MatchFile {
  version: 1;
  state: MatchState;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(MATCHES_DIR, { recursive: true });
}

async function atomicWrite(file: string, body: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, file);
}

export async function persistMatch(rt: MatchRuntime): Promise<void> {
  try {
    if (isDdbEnabled()) {
      await persistMatchDdb(rt);
      return;
    }
    await ensureDir();
    const file = path.join(MATCHES_DIR, `${rt.state.id}.json`);
    const body: MatchFile = { version: 1, state: rt.state };
    await atomicWrite(file, JSON.stringify(body));
  } catch (e) {
    console.error("[persistence] match save failed:", (e as Error).message);
  }
}

export async function persistTokens(tokens: GuestCredential[]): Promise<void> {
  try {
    if (isDdbEnabled()) {
      await persistTokensDdb(tokens);
      return;
    }
    await ensureDir();
    await atomicWrite(TOKENS_FILE, JSON.stringify({ version: 1, tokens }));
  } catch (e) {
    console.error("[persistence] token save failed:", (e as Error).message);
  }
}

export async function loadAllMatches(content: ContentPack): Promise<MatchRuntime[]> {
  if (isDdbEnabled()) {
    try {
      return await loadAllMatchesDdb(content);
    } catch (e) {
      console.error("[persistence] DDB match load failed:", (e as Error).message);
      return [];
    }
  }
  try {
    await ensureDir();
  } catch {
    return [];
  }
  let files: string[];
  try {
    files = await fs.readdir(MATCHES_DIR);
  } catch {
    return [];
  }
  const out: MatchRuntime[] = [];
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(MATCHES_DIR, name);
    try {
      const text = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(text) as MatchFile;
      if (parsed.version !== 1 || !parsed.state) continue;
      out.push(new MatchRuntime(parsed.state, content));
    } catch (e) {
      console.error(`[persistence] failed to load ${name}:`, (e as Error).message);
    }
  }
  return out;
}

export async function loadTokens(): Promise<GuestCredential[]> {
  if (isDdbEnabled()) {
    try {
      return await loadTokensDdb();
    } catch (e) {
      console.error("[persistence] DDB token load failed:", (e as Error).message);
      return [];
    }
  }
  try {
    const text = await fs.readFile(TOKENS_FILE, "utf8");
    const parsed = JSON.parse(text) as { version?: number; tokens?: GuestCredential[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) return [];
    return parsed.tokens;
  } catch {
    return [];
  }
}

export async function deleteMatchFile(matchId: string): Promise<void> {
  try {
    await fs.unlink(path.join(MATCHES_DIR, `${matchId}.json`));
  } catch {
    /* ignore */
  }
}

export async function deleteMatchPersisted(matchId: string): Promise<void> {
  if (isDdbEnabled()) {
    await deleteMatchDdb(matchId);
  } else {
    await deleteMatchFile(matchId);
  }
}
