import { loadEnvFile } from "./load-env";

loadEnvFile(".env.local");

const token = process.env.CRM_AGENT_TOKEN;
if (!token) {
  console.error("Set CRM_AGENT_TOKEN. npm run agent:create prints a token once.");
  process.exit(1);
}

async function main() {
  const { authenticateAgent } = await import("@/lib/auth/agent");
  const { createCrmMcpServer } = await import("@/server/mcp/server");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const actor = await authenticateAgent(
    new Request("http://localhost/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const server = createCrmMcpServer(actor);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "MCP server failed to start.");
  process.exit(1);
});
