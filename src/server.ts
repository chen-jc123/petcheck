// Local development server: `npm run dev` (memory) or `npm run dev:dynamo`.
import "./env.js";
import { app, storage } from "./app.js";
import { startMissedCheckSchedule } from "./api.js";
import { HOUSEHOLD_TZ } from "./clock.js";
import { modelConfig } from "./models.js";

/** Which engine the simulated Alexa+ will use, for the startup line. */
function assistantEngine(): string {
  try {
    const cfg = modelConfig((process.env.ASSISTANT_ENGINE ?? "auto").toLowerCase());
    return cfg ? `${cfg.model} via ${cfg.label}` : "rules engine";
  } catch (err) {
    return `not configured: ${(err as Error).message}`;
  }
}

const PORT = Number(process.env.PORT ?? 3000);
/** Missed-task check interval, like EventBridge Scheduler on AWS; 0 turns it off. */
const CHECK_EVERY_MIN = Number(process.env.CHECK_EVERY_MIN ?? 5);

app.listen(PORT, () => {
  const auth = process.env.API_KEY ? ", api key required" : "";
  console.log(`PetCheck MCP server on http://localhost:${PORT}/mcp  (storage: ${storage.mode}, tz: ${HOUSEHOLD_TZ}${auth})`);
  console.log(`Simulated Alexa+ at http://localhost:${PORT}/demo  (assistant: ${assistantEngine()})`);
  if (CHECK_EVERY_MIN > 0) {
    startMissedCheckSchedule(CHECK_EVERY_MIN * 60_000);
    console.log(`Missed-task check runs every ${CHECK_EVERY_MIN} min (CHECK_EVERY_MIN=0 turns it off)`);
  }
});
