# PetCheck 🐾

**A shared pet care log for Alexa+.** Anyone in the house says "I fed Mochi," and everyone knows it's done.

> Built for the Amazon Alexa+ track. PetCheck is an MCP server (spec 2025-11-25, Streamable HTTP)
> that any Alexa+ device can call.

## The problem

"Has anyone fed the cat?" gets asked in pet households every day, and the answer is usually a guess.
Pets get fed twice, or they miss a meal or their medication.

## What PetCheck does

| Say this | PetCheck does |
|---|---|
| "I fed Mochi" | Logs it for the whole household |
| "I fed Mochi" (again, 10 minutes later) | "Dad already fed Mochi at 7:52 AM. Log it again?" |
| "Has anyone walked Biscuit?" | Shows what's done today and what's still due |
| "Mochi threw up this morning" | Records the observation (never interprets it) |
| "Vet checkup next Tuesday at 10" | Schedules it and reminds you the day before |
| "How's Mochi doing this week?" | Summarizes meals, walks, meds, missed tasks, notes and the next vet visit |

## Safety rule

PetCheck **records and reminds; it never gives veterinary advice.** Questions about symptoms, doses,
food safety or treatment get "please check with your vet." Repeated observations are counted,
never interpreted.

## MCP tools

| Tool | Purpose |
|---|---|
| `add_pet` | Add a pet and its daily routine |
| `log_care` | Log feed / walk / meds / litter / water / groom; asks before logging a duplicate within 30 min |
| `get_status` | Today's done / due / overdue tasks (read-only) |
| `add_note` | Record an observation |
| `add_vet_visit` | Schedule a vet appointment |
| `weekly_summary` | 7-day summary (read-only) |

## Architecture

```
Simulated Alexa+ page (Web Speech API)
        │ voice → text
        ▼
Backend: LLM (Amazon Bedrock) + MCP client
        │ Streamable HTTP
        ▼
PetCheck MCP server (TypeScript, stateless)  ── AWS Lambda
        ├── DynamoDB (pets, care events, notes, vet visits)
        └── EventBridge Scheduler → missed-task check → household page
```

The server runs in **stateless** Streamable HTTP mode (no session IDs), so it can run on Lambda with all
state kept in the data store.

## Run it locally

Requires Node 20+.

```bash
npm install
npm run smoke         # logic checks, no server needed
npm run test:storage  # persistence checks with a fake database
npm run dev        # starts http://localhost:3000/mcp (with demo pets Mochi and Biscuit)
```

Test with MCP Inspector in a second terminal:

```bash
npm run inspector
```

In the Inspector: **Transport Type** = Streamable HTTP, **URL** = `http://localhost:3000/mcp`, click **Connect**,
then **Tools → List Tools**.

Environment variables: `PORT` (default 3000), `HOUSEHOLD_TZ` (default `America/Detroit`),
`SEED=false` to start with no demo pets.

### Storage: memory or DynamoDB

By default data lives in memory (resets on restart). To use DynamoDB (requires `aws configure`):

```bash
npm run db:create     # one-time: creates the "petcheck" table (free-tier capacity)
npm run db:reset      # load fresh demo data (Mochi, Biscuit, last week's history)
npm run dev:dynamo    # run the server against DynamoDB
npm run db:status     # see what's stored
```

Single-table design: `pk = HH#<household>`, `sk = PET#… | EVT#<time>#… | NOTE#<time>#… | VET#<date>#…`.
Each request loads the household with one Query, runs the same logic, and batch-writes new records.
The server holds no state between requests, so it runs unchanged on AWS Lambda.

Extra variables: `STORAGE=dynamodb`, `TABLE_NAME` (default `petcheck`), `HOUSEHOLD_ID` (default `demo`),
`AWS_REGION` (default `us-east-1`).

## AWS services used

| Service | How PetCheck uses it |
|---|---|
| **Amazon DynamoDB** | Stores pets, care logs, notes and vet visits (single table, provisioned within free tier) |
| AWS Lambda | _next: hosts the MCP server_ |
| Amazon EventBridge Scheduler | _next: missed-task checks_ |
| Amazon Bedrock | _next: LLM for the simulated Alexa+ page_ |

## Region note

_TODO: explain simulated Alexa+ path vs. real device testing._

## Friction log

See [FRICTION_LOG.md](FRICTION_LOG.md).

## License

_TODO: add an open-source license before making the repo public._
