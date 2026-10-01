// Local development server app: Express + the Node Streamable HTTP transport.
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { METHOD_NOT_ALLOWED, UNAUTHORIZED, apiKeyOk, buildServer, healthInfo } from "./mcp.js";
import { CORS_HEADERS, handleApi } from "./api.js";
import { PAGES, page } from "./page.js";

export { storage } from "./mcp.js";

export const app = express();
app.use(express.json());

app.use("/mcp", (req, res, next) => {
  if (apiKeyOk(req.header("authorization"), req.header("x-api-key"))) return next();
  res.status(401).json(UNAUTHORIZED);
});

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  // Plain JSON responses (not SSE streams): every PetCheck tool call is a quick request/response.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
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
app.get("/mcp", (_req, res) => {
  res.status(405).json(METHOD_NOT_ALLOWED);
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json(METHOD_NOT_ALLOWED);
});

// Household page API (same handler as Lambda).
app.use("/api", async (req, res) => {
  res.set(CORS_HEADERS);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (!apiKeyOk(req.header("authorization"), req.header("x-api-key"))) {
    res.status(401).json({ error: "Missing or invalid API key." });
    return;
  }
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.query)) if (typeof v === "string") query[k] = v;
  const mcpUrl = process.env.MCP_URL ?? `${req.protocol}://${req.get("host")}/mcp`;
  const r = await handleApi(req.method, req.path, query, req.body, { mcpUrl });
  res.status(r.status).json(r.body);
});

// Pages: household (/), simulated Alexa+ (/alexa), split-screen demo (/demo).
app.get(Object.keys(PAGES), (req, res) => {
  res.type("html").set("cache-control", "no-cache").send(page(req.path)!);
});

app.get("/health", (_req, res) => {
  res.json(healthInfo());
});
