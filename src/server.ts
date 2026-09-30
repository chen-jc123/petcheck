// Local development server: `npm run dev` (memory) or `npm run dev:dynamo`.
import { app, storage } from "./app.js";
import { HOUSEHOLD_TZ } from "./clock.js";

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  const auth = process.env.API_KEY ? ", api key required" : "";
  console.log(`PetCheck MCP server on http://localhost:${PORT}/mcp  (storage: ${storage.mode}, tz: ${HOUSEHOLD_TZ}${auth})`);
});
