// Small JSON API next to /mcp, shared by the local server and Lambda:
//
//   GET  /api/today[?time=HH:MM]          everything the household page shows for today
//   POST /api/check-missed {time?: HH:MM} run the missed-task check now (demo / manual)
//
// `time` pretends it's that time today, so the demo can jump to 6:30 PM and run
// the *real* check logic. Both endpoints require the API key when one is set.
//
// Also exported: runMissedCheck(), which EventBridge Scheduler triggers every 5 minutes.

import { localParts, localToDate, now, setDemoOffset } from "./clock.js";
import { storage } from "./mcp.js";
import { notifyOwner } from "./notify.js";
import { PetCheckError, checkMissedTasks, todayView, type Alert } from "./store.js";

export interface ApiResult {
  status: number;
  body: unknown;
}

/** Offset (ms) that makes now() read `time` today in the household time zone. */
function offsetFor(time?: string): number {
  if (!time) return 0;
  if (!/^\d{1,2}:\d{2}$/.test(time)) throw new PetCheckError(`time "${time}" should look like 18:30`);
  const target = localToDate(localParts(new Date()).date, time.padStart(5, "0"));
  return target.getTime() - Date.now();
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
    return { status: 404, body: { error: "Unknown API route. Try GET /api/today or POST /api/check-missed." } };
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
