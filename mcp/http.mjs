import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBrainMcp } from "./index.mjs";

/**
 * Serves one stateless Streamable HTTP MCP request. The caller has already
 * authenticated the OAuth client; tools reach the service over loopback.
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {unknown} body
 * @param {Pick<Parameters<typeof createBrainMcp>[0], "baseUrl" | "token" | "cliente">} options
 */
export async function handleMcp(
  request,
  response,
  body,
  { baseUrl, token, cliente },
) {
  const server = createBrainMcp({ baseUrl, token, cliente });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.once("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
