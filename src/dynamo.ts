// DynamoDB backend — single-table design.
//
//   pk = HH#<householdId>
//   sk = PET#<id> | EVT#<isoTime>#<id> | NOTE#<isoTime>#<id> | VET#<date>#<id> | ALERT#<isoTime>#<id>
//   pk = MARKET (the care network, shared by every household)
//   sk = REQ#<isoTime>#<id> | CLAIM#<isoTime>#<id>
//
// One Query loads a whole household and one the care network (both small, so this stays cheap), and new
// records are written with BatchWrite. Records are only ever added, never
// updated, which keeps concurrent writes from different devices safe.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Change, Kind } from "./store.js";
import type { Backend, HouseholdState } from "./storage.js";

export const TABLE_NAME = process.env.TABLE_NAME ?? "petcheck";
export const HOUSEHOLD_ID = process.env.HOUSEHOLD_ID ?? "demo";
export const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const pk = () => `HH#${HOUSEHOLD_ID}`;
export const MARKET_PK = "MARKET";
const isMarket = (kind: Kind) => kind === "request" || kind === "claim";

function sortKey(c: Change): string {
  const it = c.item as unknown as Record<string, string>;
  switch (c.kind) {
    case "pet":
      return `PET#${it.id}`;
    case "event":
      return `EVT#${it.at}#${it.id}`;
    case "note":
      return `NOTE#${it.at}#${it.id}`;
    case "visit":
      return `VET#${it.date}#${it.id}`;
    case "alert":
      return `ALERT#${it.at}#${it.id}`;
    case "request":
      return `REQ#${it.postedAt}#${it.id}`;
    case "claim":
      return `CLAIM#${it.at}#${it.id}`;
  }
}

/** All raw items for this household (handles pagination). */
export async function queryHousehold(): Promise<Record<string, unknown>[]> {
  return queryPartition(pk());
}

/** All raw items under one partition key (handles pagination). */
export async function queryPartition(partition: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": partition },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** BatchWrite in chunks of 25, retrying anything DynamoDB throttles. */
export async function batchWrite(requests: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let pending: Record<string, unknown>[] | undefined = requests.slice(i, i + 25);
    for (let attempt = 0; pending && pending.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      if (attempt > 6) throw new Error("DynamoDB kept throttling writes; try again shortly.");
      const res = await doc.send(new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: pending as never } }));
      pending = res.UnprocessedItems?.[TABLE_NAME] as Record<string, unknown>[] | undefined;
    }
  }
}

export function dynamoBackend(): Backend {
  return {
    async loadAll(): Promise<HouseholdState> {
      const state: HouseholdState = { pets: [], events: [], notes: [], visits: [], alerts: [], requests: [], claims: [] };
      const [household, market] = await Promise.all([queryHousehold(), queryPartition(MARKET_PK)]);
      for (const raw of [...household, ...market]) {
        const { pk: _pk, sk: _sk, kind, ...record } = raw as Record<string, unknown> & { kind: Kind };
        if (kind === "pet") state.pets.push(record as never);
        else if (kind === "event") state.events.push(record as never);
        else if (kind === "note") state.notes.push(record as never);
        else if (kind === "visit") state.visits.push(record as never);
        else if (kind === "alert") state.alerts.push(record as never);
        else if (kind === "request") state.requests.push(record as never);
        else if (kind === "claim") state.claims.push(record as never);
      }
      // Pets come back in sort-key order; keep the order they were added.
      state.pets.sort((a, b) => a.id.localeCompare(b.id));
      return state;
    },

    async saveChanges(changes: Change[]): Promise<void> {
      await batchWrite(
        changes.map((c) => ({
          PutRequest: { Item: { pk: isMarket(c.kind) ? MARKET_PK : pk(), sk: sortKey(c), kind: c.kind, ...c.item } },
        })),
      );
    },
  };
}
