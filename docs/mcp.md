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

`search_companies` — `query`, `lifecycle`, `owner_id`, `tag`, `limit`.

`get_company` — `id`.

`upsert_company` — any company field, including `tags`. Omitted fields stay as they are; `tags` replaces the whole list. `provenanceSource` and `provenanceUrl` are written to the audit event.

`search_contacts`, `get_contact`, `upsert_contact` — people. `search_contacts` takes `tag`; `upsert_contact` takes `tags`, which replaces the whole list. Matching is email, then LinkedIn, then the same name at the same company.

`add_lead` — one transaction for a company, contact, note, optional opportunity, and optional task. `companyTags` and `contactTags` replace those records' tags. A repeated domain or email updates the existing rows.

`add_activity`, `add_note` — append an interaction. Notes are activities of type `note`.

`create_opportunity`, `update_opportunity`, `list_pipeline_stages` — deals on the default pipeline.

`create_next_action`, `complete_next_action`, `get_due_actions` — tasks. `get_due_actions` takes `view`: `all` (every open task, overdue first, undated last), `overdue`, `today` (the default), `upcoming`, `completed`, or `none` (companies with no open task).

`get_recent_activity` — latest interactions.

`get_company_context` — company, people, opportunities, timeline, and open tasks.

`find_stale_relationships` — companies with no recent interaction. `days` defaults to 21.

`search_opportunities` — name, company, or stage.

`archive_company`, `archive_contact`, `archive_opportunity`, `archive_next_action` — soft archive.

`update_next_action` — partial update of a task. `completed: true` marks it done.

`record_email`, `record_meeting` — file a conversation by participant email or company, and suggest a follow-up when none is open.

`bulk_add_leads` — up to 50 leads. Each result says `created` or `error`.

`create_webhook` — admin only. Returns the signing secret once.

`list_webhook_deliveries` — recent attempts and the last error.

`configure_pipeline` — replace default stages. Keep one won stage and one lost stage.

Matching is the domain and name rules in `docs/architecture.md`. An agent that calls `upsert_company` twice with the same domain gets one company. An agent that calls `add_lead` twice with the same email gets one contact.
