# MCP

The MCP server exposes the same domain services as the REST API. It does not query tables on its own.

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

`search_contacts`, `get_contact`, `upsert_contact` — people. Matching is email, then LinkedIn, then the same name at the same company.

`add_lead` — one transaction for a company, contact, note, optional opportunity, and optional next action. A repeated domain or email updates the existing rows.

`add_activity`, `add_note` — append an interaction. Notes are activities of type `note`.

`create_opportunity`, `update_opportunity`, `list_pipeline_stages` — deals on the default pipeline.

`create_next_action`, `complete_next_action`, `get_due_actions` — tasks. `get_due_actions` takes `view`: `overdue`, `today`, `upcoming`, `completed`, or `none`.

`get_recent_activity` — latest interactions.

`get_company_context` — company, people, opportunities, timeline, and open next actions.

`find_stale_relationships` — companies with no recent interaction. `days` defaults to 21.

Matching is the domain and name rules in `docs/architecture.md`. An agent that calls `upsert_company` twice with the same domain gets one company. An agent that calls `add_lead` twice with the same email gets one contact.
