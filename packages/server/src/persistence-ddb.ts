import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { ContentPack, MatchState } from "@browserciv/shared";
import type { GuestCredential } from "./auth.js";
import { MatchRuntime } from "./runtime.js";

/**
 * Single-table layout — one DDB table holds match snapshots and tokens
 * keyed by `pk`. Match items: pk="match#<id>", attribute `state`. Token
 * items: pk="token#<token>", attributes `playerId` + `matchId`.
 */
const TOKENS_PK = "tokens#all";

interface TableClient {
  doc: DynamoDBDocumentClient;
  table: string;
}

let cached: TableClient | null = null;

function getClient(): TableClient {
  if (cached) return cached;
  const table = process.env.STATE_TABLE;
  if (!table) throw new Error("STATE_TABLE env var is required for DDB persistence");
  const region = process.env.AWS_REGION ?? "us-east-1";
  const ddb = new DynamoDBClient({ region });
  const doc = DynamoDBDocumentClient.from(ddb);
  cached = { doc, table };
  return cached;
}

export function isDdbEnabled(): boolean {
  return !!process.env.STATE_TABLE;
}

export async function persistMatchDdb(rt: MatchRuntime): Promise<void> {
  const { doc, table } = getClient();
  await doc.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk: `match#${rt.state.id}`,
        state: rt.state,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

export async function persistTokensDdb(tokens: GuestCredential[]): Promise<void> {
  const { doc, table } = getClient();
  await doc.send(
    new PutCommand({
      TableName: table,
      Item: { pk: TOKENS_PK, tokens, updatedAt: new Date().toISOString() },
    }),
  );
}

export async function loadAllMatchesDdb(content: ContentPack): Promise<MatchRuntime[]> {
  const { doc, table } = getClient();
  // Scan is fine while match count is small. If this becomes hot, switch to
  // a GSI or partition prefix scan with a `pk begins_with "match#"` filter.
  const out: MatchRuntime[] = [];
  let last: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(pk, :p)",
        ExpressionAttributeValues: { ":p": "match#" },
        ExclusiveStartKey: last,
      }),
    );
    for (const item of res.Items ?? []) {
      const state = item.state as MatchState | undefined;
      if (!state) continue;
      out.push(new MatchRuntime(state, content));
    }
    last = res.LastEvaluatedKey;
  } while (last);
  return out;
}

export async function loadTokensDdb(): Promise<GuestCredential[]> {
  const { doc, table } = getClient();
  const res = await doc.send(
    new GetCommand({ TableName: table, Key: { pk: TOKENS_PK } }),
  );
  const item = res.Item;
  if (!item || !Array.isArray(item.tokens)) return [];
  return item.tokens as GuestCredential[];
}

export async function deleteMatchDdb(matchId: string): Promise<void> {
  const { doc, table } = getClient();
  await doc.send(
    new DeleteCommand({ TableName: table, Key: { pk: `match#${matchId}` } }),
  );
}
