import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

export interface UserRecord {
  userId: string;
  email: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

// ── DynamoDB ──────────────────────────────────────────────────────────────────

function getClient() {
  const table = process.env.STATE_TABLE;
  if (!table) return null;
  const ddb = new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  return { doc: DynamoDBDocumentClient.from(ddb), table };
}

async function ddbPut(user: UserRecord): Promise<void> {
  const c = getClient();
  if (!c) return;
  await c.doc.send(new PutCommand({
    TableName: c.table,
    Item: { pk: `user#${user.email}`, ...user },
  }));
}

async function ddbGet(email: string): Promise<UserRecord | null> {
  const c = getClient();
  if (!c) return null;
  const res = await c.doc.send(new GetCommand({ TableName: c.table, Key: { pk: `user#${email}` } }));
  if (!res.Item) return null;
  const { pk: _pk, ...rest } = res.Item as { pk: string } & UserRecord;
  return rest;
}

// ── Local file fallback ───────────────────────────────────────────────────────

const DATA_DIR = process.env.BROWSERCIV_DATA_DIR ?? path.resolve("data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

async function fileGet(email: string): Promise<UserRecord | null> {
  try {
    const text = await fs.readFile(USERS_FILE, "utf8");
    const map = JSON.parse(text) as Record<string, UserRecord>;
    return map[email] ?? null;
  } catch {
    return null;
  }
}

async function filePut(user: UserRecord): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let map: Record<string, UserRecord> = {};
  try {
    const text = await fs.readFile(USERS_FILE, "utf8");
    map = JSON.parse(text) as Record<string, UserRecord>;
  } catch { /* new file */ }
  map[user.email] = user;
  const tmp = `${USERS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(map, null, 2));
  await fs.rename(tmp, USERS_FILE);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveUser(user: UserRecord): Promise<void> {
  if (process.env.STATE_TABLE) {
    await ddbPut(user);
  } else {
    await filePut(user);
  }
}

export async function getUser(email: string): Promise<UserRecord | null> {
  if (process.env.STATE_TABLE) {
    return ddbGet(email);
  }
  return fileGet(email);
}
