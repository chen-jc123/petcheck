// Local development server app: Express + the Node Streamable HTTP transport.
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { METHOD_NOT_ALLOWED, UNAUTHORIZED, apiKeyOk, buildServer, healthInfo } from "./mcp.js";

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

app.get("/health", (_req, res) => {
  res.json(healthInfo());
});
