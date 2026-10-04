// Small JSON API next to /mcp, shared by the local server and Lambda:
//
//   GET  /api/today[?time=HH:MM]          everything the household page shows for today
//   POST /api/check-missed {time?: HH:MM} run the missed-task check now (demo / manual)
//   POST /api/assistant {text, speaker, history, time?}  simulated Alexa+ turn (Bedrock + MCP client)
//   POST /api/log {pet, activity, by, confirm?, time?}  quick-log from the household page (same
//                                         logic as the log_care tool, including the duplicate check)
//
// `time` pretends it's that time today, so the demo can jump to 6:30 PM and run
// the *real* check logic. Both endpoints require the API key when one is set.
//
// Also exported: runMissedCheck(), which EventBridge Scheduler triggers every 5 minutes.

import { isDemoTime, now, offsetForTime, setDemoOffset, withDemoTime } from "./clock.js";
import { storage } from "./mcp.js";
import { notifyOwner } from "./notify.js";
import { ACTIVITIES, PetCheckError, checkMissedTasks, logCare, todayView, type Activity, type Alert } from "./store.js";
import { runAssistant, type AssistantRequest } from "./assistant.js";

export interface ApiResult {
  status: number;
  body: unknown;
}

/** Offset (ms) that makes now() read `time` today in the household time zone. */
function offsetFor(time?: string): number {
  if (!time) return 0;
  if (!isDemoTime(time)) throw new PetCheckError(`time "${time}" should look like 18:30`);
  return offsetForTime(time);
}

/** Run fn with the clock shifted to `time` (if given), then restore it. */
function atTime<T>(time: string | undefined, fn: () => T): () => T {
  const offset = offsetFor(time);
  return () => {
    setDemoOffset(offset);
    try {
      return fn();
    } finally {
      setDemoOffset(0);
    }
  };
}

export async function runMissedCheck(time?: string): Promise<{ checkedAt: string; alerts: Alert[]; notified: number }> {
  let checkedAt = "";
  const alerts = await storage.run(
    atTime(time, () => {
      checkedAt = now().toISOString();
      return checkMissedTasks();
    }),
  );
  const notified = await notifyOwner(alerts);
  if (alerts.length) console.log(`missed-task check: ${alerts.length} new alert(s), ${notified} notified`);
  return { checkedAt, alerts, notified };
}

export async function handleApi(
  method: string,
  path: string,
  query: Record<string, string | undefined>,
  body: unknown,
  ctx: { mcpUrl?: string } = {},
): Promise<ApiResult> {
  try {
    const p = path.replace(/\/+$/, "");
    if (method === "GET" && p === "/today") {
      const view = await storage.run(atTime(query.time, () => todayView()));
      return { status: 200, body: view };
    }
    if (method === "POST" && p === "/check-missed") {
      const time = (body as { time?: string } | undefined)?.time ?? query.time;
      return { status: 200, body: await runMissedCheck(time) };
    }
    if (method === "POST" && p === "/log") {
      const b = (body ?? {}) as { pet?: string; activity?: string; by?: string; confirm?: boolean; time?: string };
      if (!b.activity || !(ACTIVITIES as readonly string[]).includes(b.activity)) {
        throw new PetCheckError(`activity should be one of ${ACTIVITIES.join(", ")}`);
      }
      const r = await storage.run(
        atTime(b.time, () =>
          logCare({ pet: b.pet, activity: b.activity as Activity, by: b.by?.slice(0, 40), confirm: Boolean(b.confirm) }),
        ),
      );
      return { status: 200, body: r };
    }
    if (method === "POST" && p === "/assistant") {
      if (!ctx.mcpUrl) return { status: 500, body: { error: "MCP URL unknown" } };
      try {
        // Optional demo clock: the turn (and its MCP tool calls) run as if it's `time` today.
        const time = (body as { time?: string } | undefined)?.time;
        if (time !== undefined && !isDemoTime(time)) throw new PetCheckError(`time "${time}" should look like 17:40`);
        const r = await withDemoTime(time, () =>
          runAssistant(body as AssistantRequest, { mcpUrl: ctx.mcpUrl!, apiKey: process.env.API_KEY, demoTime: time }),
        );
        return { status: 200, body: r };
      } catch (err) {
        if (err instanceof PetCheckError) throw err;
        const e = err as { name?: string; message?: string };
        console.error("assistant error:", err);
        // Surface Bedrock setup problems clearly (model access, region, permissions).
        return { status: 502, body: { error: `${e.name ?? "Error"}: ${e.message ?? "assistant failed"}` } };
      }
    }
    return { status: 404, body: { error: "Unknown API route. Try GET /api/today, POST /api/check-missed or POST /api/assistant." } };
  } catch (err) {
    if (err instanceof PetCheckError) return { status: 400, body: { error: err.message } };
    console.error("API error:", err);
    return { status: 500, body: { error: "Internal error" } };
  }
}

/** CORS headers so a household page hosted anywhere can call the API. */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-api-key, authorization",
};
