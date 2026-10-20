// PetCheck MCP definitions: the 10 tools (6 for the household's care log, 4 for the
// care network), storage, and the API-key / health helpers. Transport-agnostic, shared by:
//   src/app.ts     Express + Node transport (local dev)
//   src/lambda.ts  Web-standard transport (AWS Lambda Function URL)
//
// Stateless = a fresh McpServer + transport per request, no session IDs, and
// all data in the storage layer (memory, file or DynamoDB), never in the process.

import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ACTIVITIES,
  PetCheckError,
  addNote,
  addPet,
  addVetVisit,
  getStatus,
  logCare,
  weeklySummary,
  type Alert,
} from "./store.js";
import { createStorage } from "./storage.js";
import { SERVICES, acceptCareRequest, careRequestStatus, findCareRequests, postCareRequest } from "./market.js";
import { notifyOwner } from "./notify.js";
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
When nobody at home can do it ("we're away this weekend"), post_care_request asks nearby pet
sitters for help: read the draft back and post it only after they say yes. Pet sitters use
find_care_requests and accept_care_request to find and take jobs, then log_care for their visits.
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

export const storage = await createStorage();

/** Run a store call (loading/saving via the storage mode) and speak friendly errors instead of crashing. */
async function run(fn: () => { message: string } & Record<string, unknown>) {
  try {
    const result = await storage.run(fn);
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

  // --- The care network: households post requests, nearby sitters find and take them ---

  const service = z
    .enum(SERVICES)
    .describe("walk (dogs only), drop_in (a short visit), feeding, overnight (sitter stays the night), boarding (pet stays at the sitter's), grooming");
  const date = z.string().describe("YYYY-MM-DD in the household's local time");

  server.registerTool(
    "post_care_request",
    {
      title: "Ask nearby sitters for help",
      description:
        "Turn what a household member asked for into a care request that nearby pet sitters can take, e.g. " +
        "'we're away this weekend, find someone to walk Biscuit twice a day'. The location comes from the " +
        "device automatically; never ask for an address. Call it WITHOUT confirm first: it returns the draft " +
        "(status needs_confirmation) to read back. Call again with the same arguments and confirm=true only " +
        "after they say yes; that publishes it.",
      inputSchema: {
        pets: z.array(z.string()).optional().describe("Pet names; omit for every pet the service fits"),
        service,
        start_date: date,
        end_date: date.optional().describe("Last day, YYYY-MM-DD; omit for a single day"),
        times: z.array(z.string()).optional().describe("Visit times each day, HH:MM 24-hour; omit for the usual times"),
        pay_per_visit: z.number().optional().describe("USD per visit (per night for overnight/boarding); omit to suggest the typical local rate"),
        notes: z.string().optional().describe("Anything the sitter should know, e.g. 'Biscuit pulls on the leash'"),
        by,
        confirm: z.boolean().optional().describe("Set true only after the user approves the draft"),
      },
    },
    async (args) => run(() => postCareRequest(args)),
  );

  server.registerTool(
    "find_care_requests",
    {
      title: "Find jobs for a pet sitter",
      description:
        "For a pet sitter: open care requests near their device that fit what they asked for (distance, services, " +
        "kinds of pets, days, minimum pay, and no clash with jobs they already took), nearest first, with how " +
        "many others didn't fit and why. Each job has a code like R-1037 to take it with accept_care_request.",
      inputSchema: {
        max_distance_miles: z.number().optional().describe("Default 5"),
        services: z.array(z.enum(SERVICES)).optional(),
        species: z.array(z.string()).optional().describe("Kinds of pets they take, e.g. ['dog']; jobs with any other pet are skipped"),
        from_date: date.optional(),
        to_date: date.optional(),
        min_pay: z.number().optional().describe("Minimum USD per visit"),
        sitter: z.string().optional().describe("The sitter's name, to skip jobs that clash with their bookings"),
        limit: z.number().optional().describe("How many to return, default 3"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => findCareRequests(args)),
  );

  server.registerTool(
    "accept_care_request",
    {
      title: "Take a job",
      description:
        "For a pet sitter: take an open care request by its code (e.g. R-1037) once they've chosen it. Fails if " +
        "someone else took it first or it clashes with their bookings. The household is notified.",
      inputSchema: {
        code: z.string().describe("The request code, e.g. R-1037"),
        sitter: z.string().describe("The sitter's name"),
      },
    },
    async (args) => {
      const out = await run(() => acceptCareRequest(args));
      const alert = (out.structuredContent as { alert?: Alert } | undefined)?.alert;
      if (alert) await notifyOwner([alert]).catch((err) => console.error("owner notification failed:", err));
      return out;
    },
  );

  server.registerTool(
    "care_request_status",
    {
      title: "Care requests and bookings",
      description:
        "Without sitter: this household's care requests and who took them ('has anyone taken our request?'). " +
        "With sitter: that sitter's upcoming bookings.",
      inputSchema: { sitter: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => careRequestStatus(args)),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Auth + health (shared by both entry points)
// ---------------------------------------------------------------------------

/**
 * Optional API key. When API_KEY is set (always, on Lambda), /mcp requires
 *   Authorization: Bearer <key>   or   x-api-key: <key>
 * so a public URL can't be written to by strangers.
 */
const API_KEY = process.env.API_KEY;

function keyMatches(given: string | undefined): boolean {
  if (!API_KEY || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function apiKeyOk(authorization: string | undefined, xApiKey: string | undefined): boolean {
  if (!API_KEY) return true;
  return keyMatches(authorization?.replace(/^Bearer\s+/i, "")) || keyMatches(xApiKey);
}

export const UNAUTHORIZED = { jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid API key." }, id: null };
export const METHOD_NOT_ALLOWED = { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null };

export function healthInfo() {
  return {
    ok: true,
    storage: storage.mode,
    auth: API_KEY ? "api-key" : "none",
    now: now().toISOString(),
    local: localParts(now()),
    tz: HOUSEHOLD_TZ,
  };
}
