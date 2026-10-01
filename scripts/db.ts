// DynamoDB helper.
//   npm run db:create   create the table (free-tier sized) and wait until it's ready
//   npm run db:reset    delete this household's data and load fresh demo data
//   npm run db:status   show table status and how many records the household has
//   npm run db:demo     like db:reset, plus today's tasks so far marked done (dinners left open)
//                       so the household page starts tidy for recording the demo video

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { HOUSEHOLD_ID, REGION, TABLE_NAME, batchWrite, queryHousehold } from "../src/dynamo.js";
import { seedDemoData, seedTodaySoFar, takeChanges } from "../src/store.js";
import { dynamoBackend } from "../src/dynamo.js";

const client = new DynamoDBClient({ region: REGION });

async function create() {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        // 5 read / 5 write capacity units is inside the DynamoDB always-free tier.
        BillingMode: "PROVISIONED",
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        Tags: [{ Key: "project", Value: "petcheck" }],
      }),
    );
    console.log(`Creating table "${TABLE_NAME}" in ${REGION}...`);
  } catch (err) {
    if (err instanceof ResourceInUseException) console.log(`Table "${TABLE_NAME}" already exists.`);
    else throw err;
  }
  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: TABLE_NAME });
  console.log(`✔ Table "${TABLE_NAME}" is ACTIVE.`);
}

async function reset(withToday = false) {
  const existing = await queryHousehold();
  await batchWrite(existing.map((it) => ({ DeleteRequest: { Key: { pk: it.pk, sk: it.sk } } })));
  console.log(`Deleted ${existing.length} records for household "${HOUSEHOLD_ID}".`);
  seedDemoData();
  const today = withToday ? seedTodaySoFar() : 0;
  const changes = takeChanges();
  await dynamoBackend().saveChanges(changes);
  console.log(`✔ Loaded ${changes.length} demo records (Mochi, Biscuit and last week's history).`);
  if (withToday) {
    console.log(`✔ Marked ${today} of today's tasks done so far. Both dinners are left open:`);
    console.log(`  Dad's "I fed Mochi" counts as Mochi's dinner; Biscuit's dinner is the 7 PM missed-task scene.`);
  }
}

async function status() {
  const t = await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
  const items = await queryHousehold();
  const count = (k: string) => items.filter((i) => i.kind === k).length;
  console.log(`Table "${TABLE_NAME}" (${REGION}): ${t.Table?.TableStatus}`);
  console.log(
    `Household "${HOUSEHOLD_ID}": ${count("pet")} pets, ${count("event")} care logs, ` +
      `${count("note")} notes, ${count("visit")} vet visits, ${count("alert")} alerts`,
  );
}

const cmd = process.argv[2];
const commands: Record<string, () => Promise<void>> = { create, reset: () => reset(false), demo: () => reset(true), status };
if (!commands[cmd]) {
  console.error("Usage: tsx scripts/db.ts <create|reset|demo|status>");
  process.exit(1);
}
commands[cmd]().catch((err) => {
  console.error(`✖ ${err.name ?? "Error"}: ${err.message}`);
  process.exit(1);
});
