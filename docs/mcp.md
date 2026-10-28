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

## Personal tokens and mail

Settings › API and webhooks › Your mail in Claude creates a personal token (`orbit_…`, shown once, stored as a SHA-256 hash in `crm.personal_tokens`, owner-only, revocable, up to 10 a person). Send it to `POST /api/mcp` like an agent token. It signs in as that person through `private.authenticate_personal_token`, so every tool runs under their row-level security, with the scopes of their role and a limit of 120 requests a minute per token. A personal token also gets the mail tools below; workspace agent tokens never do, because mail is private to each person. stdio (`npm run mcp`) stays agent-only.

To add it to Claude Code:

```bash
claude mcp add --transport http orbit https://orbit.geteclipse.co/api/mcp --header "Authorization: Bearer orbit_..."
```

Mail tools. None of them sends email.

`mail_accounts`: the person's mailboxes and sending addresses, with ids for `mail_save_draft`.

`mail_search`: `query` (every folder) or `view` (`inbox`, `important`, `other`, `news`, `calendar`, `snoozed`, `sent`, `drafts`, `archive`, `trash`), `account_id`, `limit` (up to 50). Returns thread keys, senders, snippets and whether Orbit has a reply ready.

`mail_get_thread`: `key`. Every message as plain text without quoted history, with message ids, plus saved drafts, Orbit's prepared reply and any follow-up reminder.

`mail_read_attachments`: `message_id`. The attachment list and the text Orbit can read from them.

`mail_ask`: `question`, optional `account_id`. Ask AI over the person's email and attachments, with sources.

`mail_save_draft`: `mode` (`new`, `reply`, `reply_all`, `forward`), `message_id` for replies and forwards, `draft_id` to update, `from`, `to`, `cc`, `bcc`, `subject`, `body` (plain text; Orbit adds the signature and read tracking). Saves an Outlook draft that shows in Orbit for the person to review and send. Returns `sent: false`.

`mail_discard_draft`: `draft_id`.

## stdio

```bash
npm run mcp
```

That reads `CRM_AGENT_TOKEN` from the environment or `.env.local` and speaks MCP on stdin/stdout. Do not log into that process's stdout.

## Tools

A token with only the `market:write` scope (the Grok Bot token from Settings › Learning) sees just two tools: `get_watchlist`, which returns the topics, competitors, people, target accounts and sources to research, and `add_market_notes`, which takes `notes` (1 to 50, each `{kind, headline, summary?, url?, about?, publishedAt?}` with kind `news`, `post`, `launch`, `hire`, `funding`, `signal`, `research` or `other`) and returns `{added, duplicates, rejected}`. Other tokens see both alongside the CRM tools; an agent needs `market:write` (or `admin`) to add notes.

`search_companies`: `query`, `lifecycle` (built in or custom), `owner_id`, `tag`, `limit`.

`get_company`: `id`.

`upsert_company`: any company field except health (set from call summaries, or by REST `PATCH` and the app), including `tags` and any lifecycle name. Omitted fields stay as they are; `tags` replaces the whole list. `provenanceSource` and `provenanceUrl` are written to the audit event.

`search_contacts`, `get_contact`, `upsert_contact`: people. `search_contacts` takes `tag`; `upsert_contact` takes `tags`, which replaces the whole list. Matching is email, then LinkedIn, then the same name at the same company.

`add_lead`: one transaction for a company, contact, note, optional opportunity, and optional task. `companyTags` and `contactTags` replace those records' tags. A repeated domain or email updates the existing rows.

`add_activity`, `add_note`: append an interaction. Notes are activities of type `note`.

`create_opportunity`, `update_opportunity`, `list_pipeline_stages`: deals on the default pipeline.

`create_next_action`, `complete_next_action`, `get_due_actions`: tasks. `get_due_actions` takes `view`: `all` (every open task, overdue first, undated last), `overdue`, `today` (the default), `upcoming`, `completed`, or `none` (companies with no open task).

`get_recent_activity`: latest interactions.

`get_company_context`: company, people, opportunities, timeline, and open tasks.

`find_stale_relationships`: companies with no recent interaction. `days` defaults to 21.

`search_opportunities`: name, company, or stage.

`archive_company`, `archive_contact`, `archive_opportunity`, `archive_next_action`: soft archive.

`merge_companies`, `merge_contacts`: `keep_id`, `merge_id`, plus `provenanceSource` and `provenanceUrl`. One transaction moves every reference from the duplicate to the kept record (people, deals and board cards, tasks, activity, emails, calls, proposals, knowledge, market notes, signals, calendar links), fills the kept record's empty fields without overwriting, combines tags and archives the duplicate. A contact keeps its own email; a different one from the duplicate goes into the notes. Returns `kept`, `merged`, `moved` (rows per table), `filled` and `tagsAdded`. Refuses a record merged with itself, one in another workspace, or an archived one. Records one `company.merged` or `contact.merged` audit event (also a webhook event) with the moved row ids, so the merge can be traced or reversed.

`update_next_action`: partial update of a task. `completed: true` marks it done.

`record_email`, `record_meeting`: file a conversation by participant email or company, and suggest a follow-up when none is open.

`bulk_add_leads`: up to 50 leads. Each result says `created` or `error`.

`create_webhook`: admin only. Returns the signing secret once.

`list_webhook_deliveries`: recent attempts and the last error.

`configure_pipeline`: replace default stages. Keep one won stage and one lost stage.

Matching is the domain and name rules in `docs/architecture.md`. An agent that calls `upsert_company` twice with the same domain gets one company. An agent that calls `add_lead` twice with the same email gets one contact.

Proposals and NDAs (`server/mcp/proposals.ts`):

`list_proposals`: `status` (`all`, `draft`, `open`, `sent`, `viewed`, `client_signed`, `completed`, `declined`, `withdrawn`, `expired`), `company_id`, `contact_id`, `kind`, `search`. Up to 100, newest first.

`get_proposal`: `id`. Products, wording, status, the client's link once sent, signatures and events.

`list_products`, `list_proposal_templates`: what a proposal can use. Only active templates can be used.

`create_proposal`: `template_id`, `company_id`, `contact_id` (someone at that company), `currency` (`GBP` or `USD`), `items` (`productId`, `quantity`, `unitPrice`, `description`), `title`. Agent tokens pass `owner_id`, the member who sends and countersigns. Returns `missing` fields and `placeholders` to fix before sending.

`update_proposal`: a draft's `title`, `currency`, `valid_until`, `items` or `blocks` (tabs and sections, described in the tool).

`revise_proposal`: `id`. Makes a sent, declined or withdrawn one a draft again so it can be edited. The client can't sign until a person sends it again.

`update_proposal_steps`: `id`, `action` (`add`, `done`, `undone`, `remove`), `step_id`, `title`, `side` (`client` or `us`), `due_date`. Changes the live Next steps plan.

`get_proposal_template`, `create_proposal_template` (`name`, `kind`, `starter` or `copy_of`, `blocks`, `accent`, `valid_days`, `status`), `update_proposal_template` (`id`, `name`, `status`, `accent`, `valid_days`, `blocks`). Default Next steps are items on a template's steps block.

`save_product`: create a product, or update it with `id`: `name`, `description`, `price_gbp`, `price_usd`, `billing`.

No tool sends or signs. A person sends from the proposal in Orbit (or approves the assistant's `send_proposal`), the client signs on their page, and a member countersigns in Orbit.
