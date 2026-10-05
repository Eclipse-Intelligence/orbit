# MCP

The MCP server exposes the same company service as the REST API. It does not query tables on its own.

## HTTP

`POST /api/mcp` with `Authorization: Bearer <agent token>` and a Streamable HTTP JSON-RPC body. `GET` returns 405. The server is stateless: each request builds a server for that agent and closes it with the response.

A client configuration:

```json
{
  "mcpServers": {
    "crm": {
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer crm_..." }
    }
  }
}
```

## stdio

```bash
npm run mcp
```

That reads `CRM_AGENT_TOKEN` from the environment or `.env.local` and speaks MCP on stdin/stdout. Do not log into that process's stdout.

## Tools

`search_companies` — `query`, `lifecycle`, `owner_id`, `limit`.

`get_company` — `id`.

`upsert_company` — any company field. Omitted fields stay as they are. `provenanceSource` and `provenanceUrl` are written to the audit event.

Matching is the domain and name rules in `docs/architecture.md`. An agent that calls `upsert_company` twice with the same domain gets one company.
