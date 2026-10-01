// AWS Lambda entry point. Handles two kinds of events:
//
//   1. Function URL requests (payload format 2.0): /mcp, /api/*, /health, and
//      the pages at /, /alexa and /demo
//      /mcp uses the MCP SDK's web-standard transport: the Lambda event becomes a
//      standard Request, the transport returns a standard Response, and that is
//      mapped back to the Lambda result. No Express or Node HTTP emulation needed.
//   2. EventBridge Scheduler: {"petcheck": "check-missed"} every 5 minutes.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { METHOD_NOT_ALLOWED, apiKeyOk, buildServer, healthInfo } from "./mcp.js";
import { authenticate, handleOAuth, mcpAccessError } from "./oauth.js";
import { CORS_HEADERS, handleApi, runMissedCheck } from "./api.js";
import { page } from "./page.js";

interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { domainName: string; http: { method: string } };
}

interface LambdaResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

const json = (statusCode: number, body: unknown): LambdaResult => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

interface ScheduledEvent {
  petcheck: "check-missed";
}

export async function handler(event: FunctionUrlEvent | ScheduledEvent): Promise<LambdaResult | object> {
  if ("petcheck" in event) {
    if (event.petcheck === "check-missed") return runMissedCheck();
    return { error: `unknown scheduled action ${String(event.petcheck)}` };
  }
  return handleHttp(event);
}

async function handleHttp(event: FunctionUrlEvent): Promise<LambdaResult> {
  const method = event.requestContext.http.method.toUpperCase();
  const path = event.rawPath.replace(/\/+$/, "") || "/";
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = v;

  if (path === "/health" && method === "GET") return json(200, healthInfo());
  const html = method === "GET" ? page(path) : undefined;
  if (html) {
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      body: html,
    };
  }

  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";

  if (path.startsWith("/api/")) {
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS };
    if (!apiKeyOk(headers["authorization"], headers["x-api-key"])) {
      return { ...json(401, { error: "Missing or invalid API key." }), headers: { "content-type": "application/json", ...CORS_HEADERS } };
    }
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      return json(400, { error: "Body must be JSON" });
    }
    const r = await handleApi(method, path.slice(4), event.queryStringParameters ?? {}, parsed, {
      // The assistant reaches the MCP server over HTTPS at this same Function URL.
      mcpUrl: process.env.MCP_URL ?? `https://${event.requestContext.domainName}/mcp`,
    });
    return { statusCode: r.status, headers: { "content-type": "application/json", ...CORS_HEADERS }, body: JSON.stringify(r.body) };
  }

  // OAuth 2.1 for Alexa+ (metadata, account-linking page, token endpoint).
  const base = `https://${event.requestContext.domainName}`;
  const oauth = handleOAuth({
    method,
    path,
    query: new URLSearchParams(event.rawQueryString ?? ""),
    headers,
    body,
    base,
  });
  if (oauth) return { statusCode: oauth.status, headers: oauth.headers, body: oauth.body };

  if (path !== "/mcp") return json(404, { error: "Not found. The MCP endpoint is /mcp." });
  const auth = authenticate(headers["authorization"], headers["x-api-key"], `${base}/mcp`);
  if (!auth) return json(401, { jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid credentials." }, id: null });
  if (method !== "POST") return json(405, METHOD_NOT_ALLOWED);
  let parsedBody: unknown;
  try {
    parsedBody = body ? JSON.parse(body) : undefined;
  } catch {
    return json(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  const denied = mcpAccessError(auth, parsedBody);
  if (denied) return json(denied.status, denied.body);

  const url = `https://${event.requestContext.domainName}${path}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const request = new Request(url, { method, headers, body });

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  } catch (err) {
    console.error("MCP request failed:", err);
    return json(500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
