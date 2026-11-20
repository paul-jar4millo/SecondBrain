import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBrainMcp } from "./index.mjs";

/**
 * Serves one stateless Streamable HTTP MCP request. The caller has already
 * authenticated the OAuth client; tools reach the service over loopback.
 */
export async function atenderMcp(
  request,
  response,
  cuerpo,
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
  await transport.handleRequest(request, response, cuerpo);
}
