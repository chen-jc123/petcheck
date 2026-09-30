// AWS Lambda entry point (Function URL, payload format 2.0).
//
// Uses the MCP SDK's web-standard transport: the Lambda event becomes a
// standard Request, the transport returns a standard Response, and that is
// mapped back to the Lambda result. No Express or Node HTTP emulation needed.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { METHOD_NOT_ALLOWED, UNAUTHORIZED, apiKeyOk, buildServer, healthInfo } from "./mcp.js";

interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
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

export async function handler(event: FunctionUrlEvent): Promise<LambdaResult> {
  const method = event.requestContext.http.method.toUpperCase();
  const path = event.rawPath.replace(/\/+$/, "") || "/";
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = v;

  if (path === "/health" && method === "GET") return json(200, healthInfo());
  if (path !== "/mcp") return json(404, { error: "Not found. The MCP endpoint is /mcp." });
  if (!apiKeyOk(headers["authorization"], headers["x-api-key"])) return json(401, UNAUTHORIZED);
  if (method !== "POST") return json(405, METHOD_NOT_ALLOWED);

  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  let parsedBody: unknown;
  try {
    parsedBody = body ? JSON.parse(body) : undefined;
  } catch {
    return json(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

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
