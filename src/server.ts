// PetCheck MCP server — Streamable HTTP, stateless mode.
//
// Stateless = a fresh McpServer + transport per request, no session IDs.
// That is what lets this run on AWS Lambda later: all state lives in the
// store (in memory now, DynamoDB next), never in the server process.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  ACTIVITIES,
  PetCheckError,
  addNote,
  addPet,
  addVetVisit,
  getStatus,
  logCare,
  seedDemoData,
  weeklySummary,
} from "./store.js";
import { HOUSEHOLD_TZ, localParts, now } from "./clock.js";

const SAFETY =
  "PetCheck records and reminds; it never gives veterinary advice. " +
  "If asked about symptoms, doses, food safety or treatment, say to check with a vet.";

const INSTRUCTIONS = `PetCheck is a shared pet care log for a household.
Use log_care when someone says they did a task ("I fed Mochi", "walked the dog").
If log_care returns needs_confirmation, read the message to the user and only call it
again with confirm=true if they say yes.
Use get_status for "has anyone fed the cat?" or "what's left for Biscuit today?".
Use weekly_summary for "how's Mochi doing this week?".
Pass the speaker's name as "by" when known.
Household time zone: ${HOUSEHOLD_TZ}.
${SAFETY}`;

const activity = z
  .enum(ACTIVITIES)
  .describe("feed, walk, meds (medication/supplement), litter, water, groom, or other");
const petName = z
  .string()
  .optional()
  .describe("The pet's name, e.g. Mochi. Can be omitted if the household has only one pet.");
const by = z.string().optional().describe("Name of the household member speaking, e.g. Dad");

/** Wrap store calls so friendly errors are spoken back instead of crashing. */
function run(fn: () => { message: string } & Record<string, unknown>) {
  try {
    const result = fn();
    return {
      content: [{ type: "text" as const, text: result.message }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (err) {
    const text = err instanceof PetCheckError ? err.message : "Sorry, something went wrong in PetCheck.";
    if (!(err instanceof PetCheckError)) console.error(err);
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "petcheck", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "add_pet",
    {
      title: "Add a pet",
      description: "Add a pet to the household with an optional daily routine (feeding times, walks, medication).",
      inputSchema: {
        name: z.string().describe("Pet name, e.g. Mochi"),
        species: z.string().describe("cat, dog, rabbit, ..."),
        routine: z
          .array(
            z.object({
              activity,
              time: z.string().describe("24-hour local time, HH:MM, e.g. 08:00 or 18:30"),
              label: z.string().optional().describe("Short name, e.g. breakfast, heartworm pill"),
            }),
          )
          .optional(),
      },
    },
    async (args) => run(() => addPet(args)),
  );

  server.registerTool(
    "log_care",
    {
      title: "Log a care task",
      description:
        "Record that someone just did a care task for a pet. If the same task was logged for that pet in the " +
        "last 30 minutes, returns status needs_confirmation instead of logging; ask the user, then call again " +
        "with confirm=true only if they say yes.",
      inputSchema: {
        pet: petName,
        activity,
        by,
        detail: z.string().optional().describe("Optional detail, e.g. 'half a can'"),
        confirm: z.boolean().optional().describe("Set true only after the user confirms a duplicate"),
      },
    },
    async (args) => run(() => logCare(args)),
  );

  server.registerTool(
    "get_status",
    {
      title: "Today's status",
      description: "What has been done today and what is still due or overdue, for one pet or all pets.",
      inputSchema: { pet: petName },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => getStatus(args)),
  );

  server.registerTool(
    "add_note",
    {
      title: "Add an observation",
      description:
        "Record an observation about a pet (ate less, threw up, limping, seemed happy). Records only; " + SAFETY,
      inputSchema: { pet: petName, text: z.string().describe("The observation in the user's words"), by },
    },
    async (args) => run(() => addNote(args)),
  );

  server.registerTool(
    "add_vet_visit",
    {
      title: "Add a vet visit",
      description: "Schedule a vet appointment. Convert relative dates like 'next Tuesday' to YYYY-MM-DD first.",
      inputSchema: {
        pet: petName,
        date: z.string().describe("YYYY-MM-DD in the household's local time"),
        time: z.string().optional().describe("HH:MM, 24-hour local time"),
        reason: z.string().optional().describe("e.g. annual checkup, vaccines"),
      },
    },
    async (args) => run(() => addVetVisit(args)),
  );

  server.registerTool(
    "weekly_summary",
    {
      title: "Weekly summary",
      description:
        "Summary of the last 7 days for one pet: how often each routine task was done, missed tasks, notes, " +
        "who helped most, and the next vet visit. Counts notes but never interprets them. " + SAFETY,
      inputSchema: { pet: petName },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => weeklySummary(args)),
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// Stateless mode: no server-initiated streams or sessions to delete.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.get("/health", (_req, res) => {
  res.json({ ok: true, now: now().toISOString(), local: localParts(now()), tz: HOUSEHOLD_TZ });
});

const PORT = Number(process.env.PORT ?? 3000);
if (process.env.SEED !== "false") seedDemoData();
app.listen(PORT, () => {
  console.log(`PetCheck MCP server on http://localhost:${PORT}/mcp  (tz: ${HOUSEHOLD_TZ})`);
});
