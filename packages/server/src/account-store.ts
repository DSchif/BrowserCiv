import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export interface UserRecord {
  userId: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  isAdmin?: boolean;
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
    Item: { pk: `user#${user.username.toLowerCase()}`, ...user },
  }));
}

async function ddbGet(username: string): Promise<UserRecord | null> {
  const c = getClient();
  if (!c) return null;
  const res = await c.doc.send(new GetCommand({ TableName: c.table, Key: { pk: `user#${username.toLowerCase()}` } }));
  if (!res.Item) return null;
  const { pk: _pk, ...rest } = res.Item as { pk: string } & UserRecord;
  return rest;
}

async function ddbList(): Promise<UserRecord[]> {
  const c = getClient();
  if (!c) return [];
  const res = await c.doc.send(new ScanCommand({
    TableName: c.table,
    FilterExpression: "begins_with(pk, :prefix)",
    ExpressionAttributeValues: { ":prefix": "user#" },
  }));
  return (res.Items ?? []).map(({ pk: _pk, ...rest }) => rest as UserRecord);
}

async function ddbSetAdmin(username: string, isAdmin: boolean): Promise<void> {
  const c = getClient();
  if (!c) return;
  await c.doc.send(new UpdateCommand({
    TableName: c.table,
    Key: { pk: `user#${username.toLowerCase()}` },
    UpdateExpression: "SET isAdmin = :v",
    ExpressionAttributeValues: { ":v": isAdmin },
  }));
}

// ── Local file fallback ───────────────────────────────────────────────────────

const DATA_DIR = process.env.BROWSERCIV_DATA_DIR ?? path.resolve("data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

async function fileGet(username: string): Promise<UserRecord | null> {
  try {
    const text = await fs.readFile(USERS_FILE, "utf8");
    const map = JSON.parse(text) as Record<string, UserRecord>;
    return map[username.toLowerCase()] ?? null;
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
  map[user.username.toLowerCase()] = user;
  const tmp = `${USERS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(map, null, 2));
  await fs.rename(tmp, USERS_FILE);
}

async function fileList(): Promise<UserRecord[]> {
  try {
    const text = await fs.readFile(USERS_FILE, "utf8");
    return Object.values(JSON.parse(text) as Record<string, UserRecord>);
  } catch {
    return [];
  }
}

async function fileSetAdmin(username: string, isAdmin: boolean): Promise<void> {
  const user = await fileGet(username);
  if (!user) return;
  await filePut({ ...user, isAdmin });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveUser(user: UserRecord): Promise<void> {
  if (process.env.STATE_TABLE) {
    await ddbPut(user);
  } else {
    await filePut(user);
  }
}

export async function getUser(username: string): Promise<UserRecord | null> {
  if (process.env.STATE_TABLE) {
    return ddbGet(username);
  }
  return fileGet(username);
}

export async function listUsers(): Promise<UserRecord[]> {
  if (process.env.STATE_TABLE) {
    return ddbList();
  }
  return fileList();
}

export async function setUserAdmin(username: string, isAdmin: boolean): Promise<void> {
  if (process.env.STATE_TABLE) {
    await ddbSetAdmin(username, isAdmin);
  } else {
    await fileSetAdmin(username, isAdmin);
  }
}
