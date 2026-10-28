# CRM API

Base path: `/api/v1`

Authentication is `Authorization: Bearer <agent token>` (from `npm run agent:create`). Browser cookies and personal tokens (`orbit_…`, which only work with the MCP server) are not accepted. Each credential is limited to 120 requests per minute. A 429 response includes `Retry-After: 60`.

Every request runs as the agent inside its workspace, under row-level security. Agent tokens see every task in the workspace, but never anyone's Mail, calendars, assistant chats, workflows or Knowledge. Every change to companies, contacts, opportunities, activities and tasks is audited with the agent as the actor and the `provenance` you send, and audit events can start workflows and are delivered to webhooks (see [Webhooks](#webhooks)). Nothing is deleted: `DELETE` archives.

Send `Content-Type: application/json`. Unknown fields are rejected. Omitted fields on `PATCH` and upsert are left unchanged. `null` clears an optional field.

Optional `Idempotency-Key` header (printable ASCII, up to 200 characters). Reuse a key only for the same request body.

## Scopes

| Operation | Scope |
| --- | --- |
| List, get, context, due actions, stale relationships | `crm:read` |
| Company create, update, upsert, archive | `companies:write` |
| Contact create, update, upsert, archive | `contacts:write` |
| Opportunity create, update, archive | `opportunities:write` |
| Activity create | `activities:write` |
| Task create, update, complete, archive | `tasks:write` |
| Lead ingestion | `leads:write`, plus the write scope of each record included |
| Filing an email or meeting | `activities:write` (the follow-up task also needs `tasks:write`) |
| Pipeline stages | `opportunities:write` |
| CSV export | `crm:read` |
| CSV import | `companies:write` or `contacts:write` |
| Webhook list and deliveries | `crm:read` |
| Webhook create and archive | `admin` |

`admin` satisfies any of these.

## Endpoints

| Method | Path | Purpose | Scope |
| --- | --- | --- | --- |
| `GET` | `/companies` | List and filter companies | `crm:read` |
| `POST` | `/companies` | Create a company (409 on a duplicate) | `companies:write` |
| `POST` | `/companies/upsert` | Create or update the matching company | `companies:write` |
| `POST` | `/companies/bulk` | Upsert 1 to 50 companies, each on its own | `companies:write` |
| `GET` | `/companies/:id` | One company, archived included | `crm:read` |
| `PATCH` | `/companies/:id` | Partial update | `companies:write` |
| `DELETE` | `/companies/:id` | Archive | `companies:write` |
| `GET` | `/companies/:id/context` | Company, people, deals, timeline, call insights, open tasks | `crm:read` |
| `GET` | `/contacts` | List and filter people | `crm:read` |
| `POST` | `/contacts` | Create a person (409 on a duplicate) | `contacts:write` |
| `POST` | `/contacts/upsert` | Create or update the matching person | `contacts:write` |
| `GET` | `/contacts/:id` | One person | `crm:read` |
| `PATCH` | `/contacts/:id` | Partial update | `contacts:write` |
| `DELETE` | `/contacts/:id` | Archive | `contacts:write` |
| `GET` | `/opportunities` | List deals and board cards | `crm:read` |
| `POST` | `/opportunities` | Create a deal, or a card on a board | `opportunities:write` |
| `GET` | `/opportunities/:id` | One deal or card | `crm:read` |
| `PATCH` | `/opportunities/:id` | Partial update, stage moves included | `opportunities:write` |
| `DELETE` | `/opportunities/:id` | Archive | `opportunities:write` |
| `GET` | `/pipeline` | The default pipeline and its stages | `crm:read` |
| `PUT` | `/pipeline` | Replace the default pipeline's stages | `opportunities:write` |
| `GET` | `/activities` | List activity | `crm:read` |
| `POST` | `/activities` | Append an activity | `activities:write` |
| `POST` | `/communications` | File an email or meeting and suggest a follow-up | `activities:write` |
| `GET` | `/tasks` | List tasks by view | `crm:read` |
| `POST` | `/tasks` | Create a task | `tasks:write` |
| `GET` | `/tasks/:id` | One task | `crm:read` |
| `PATCH` | `/tasks/:id` | Partial update, complete or reopen | `tasks:write` |
| `POST` | `/tasks/:id/complete` | Mark complete | `tasks:write` |
| `DELETE` | `/tasks/:id` | Archive | `tasks:write` |
| `GET` | `/actions` | Tasks for a view, or companies with no open task | `crm:read` |
| `GET` | `/relationships/stale` | Companies with no recent interaction | `crm:read` |
| `POST` | `/leads` | Ingest one lead in one transaction | `leads:write` and each record's scope |
| `POST` | `/leads/bulk` | Ingest 1 to 50 leads, each on its own | `leads:write` and each record's scope |
| `GET` | `/export/:resource` | CSV of `companies`, `contacts`, `opportunities`, `activities` or `tasks` | `crm:read` |
| `POST` | `/import/:resource` | Import `companies` or `contacts` from CSV | `companies:write` or `contacts:write` |
| `GET` | `/webhooks` | List endpoints, without secrets | `crm:read` |
| `POST` | `/webhooks` | Register an endpoint and get its secret once | `admin` |
| `DELETE` | `/webhooks/:id` | Archive an endpoint | `admin` |
| `GET` | `/webhooks/deliveries` | The 50 most recent delivery attempts | `crm:read` |

`GET /companies`, `/contacts`, `/opportunities`, `/activities` and `/tasks` take `limit` (1 to 100, default 50) and `offset` (up to 10,000). `owner` (or `owner_id`) takes a member id, `unassigned`, or `all` for no filter.

## Companies

`GET /api/v1/companies`

Query: `q`, `lifecycle` (`lead`, `prospect`, `customer`, `churned`, or a custom name; matching ignores case), `health` (`healthy`, `watch`, `at_risk`, or `none` for not set), `owner` (a user id or `unassigned`), `tag` (one tag; matching ignores case and extra spaces), `sort` (`name`, `domain`, `owner`, `interaction`, `strength`, `updated`, `created`, `fit`; default `name`), `order` (`asc` or `desc`; each sort has its own default), `has` and `missing` (comma-separated `domain`, `contacts`, `interactions`), `limit` (1 to 100, default 50), `offset` (max 10000), `include_archived=true`. Each company in the list includes `relationship` (`label`: `strong`, `warm`, `cooling`, `one_sided`, `cold` or `new`, and a `reason`). `icpFit` is the company's ICP fit from 0 to 4 when Web checks has scored it, otherwise null.

Response:

```json
{ "data": [], "total": 0, "limit": 50, "offset": 0 }
```

`POST /api/v1/companies` creates a company. `201` with `{ "company": { ... } }`. A matching active domain, or the same normalised name when neither row has a domain, returns 409 `duplicate_company`. Use upsert to update that row instead.

`GET /api/v1/companies/:id` returns `{ "company": { ... } }`, including archived companies. Another workspace's id is 404.

`PATCH /api/v1/companies/:id` applies a partial update. `200` with `{ "company": { ... } }`.

`DELETE /api/v1/companies/:id` archives the company. `200` with `{ "company": { ... } }`.

`POST /api/v1/companies/upsert` creates or updates the matched company. `200` with:

```json
{ "company": {}, "created": true, "matchedOn": null }
```

`matchedOn` is `domain`, `name`, or `null` when a new row was inserted. Provide a name or a domain.

`POST /api/v1/companies/bulk` accepts `{ "companies": [ ... ], "provenance": { "source": "", "sourceUrl": "" } }` with 1 to 50 companies. Each item is validated on its own. The response is `{ "results": [ { "index": 0, "status": "created", "company": {}, "matchedOn": null } ] }`. `status` is `created`, `updated`, `matched`, or `error`. `matched` means an existing company was found and no fields changed. An error item includes `{ "code", "message" }` and does not roll back the items that succeeded.

## Company fields

`name`, `domain`, `website`, `description`, `industry`, `sizeCategory`, `lifecycle`, `ownerId`, `source`, `sourceReference`, `tags`, and on updates `health` (`healthy`, `watch`, `at_risk` or null) with an optional `healthReason`.

Responses also carry `health`, `healthReason`, `healthAt` and `healthActivityId` (the call it came from; null when set by hand). Health is normally set from call summaries.

`lifecycle` is `lead`, `prospect`, `customer` or `churned` (their labels such as `Customer` are accepted too), or any other name up to 40 characters, such as `Consultant`; a name that matches an existing one apart from case takes the existing spelling. New companies default to `lead`.

`ownerId` must be a member of the workspace. Domain and website are canonicalised (`https://www.acme.com/about` becomes domain `acme.com`).

Provenance, when sent, is an object:

```json
{ "provenance": { "source": "research-agent", "sourceUrl": "https://example.com/acme" } }
```

It is stored on the audit event. It is not a company column.

## Tags

Companies and contacts carry `tags`, an array of strings, in every response. Sending `tags` on create, `PATCH`, upsert, or bulk replaces the whole list; omit it to leave the tags as they are, and send `[]` or `null` to clear them. Each tag is trimmed, inner whitespace is collapsed to one space, and it is lowercased, so `" Recruit  Lead "` is stored as `"recruit lead"`. Duplicates are dropped. A record holds at most 20 tags of up to 40 characters each, and a tag can't contain `;`. A change that only reorders the same tags is not an update. Tag changes are audited and fire `company.updated` or `contact.updated` webhooks like any other field.

## Errors

```json
{ "error": { "code": "forbidden", "message": "Missing scope companies:write.", "details": {} } }
```

Codes include `unauthorized` (401), `forbidden` (403), `not_found` (404), `invalid_input` (400), `duplicate_company` (409), `duplicate_contact` (409), `conflict` (409, for example a company already on a board), `idempotency_conflict` (409), `rate_limited` (429), and `internal_error` (500).

## Contacts

`GET /api/v1/contacts` with `q`, `company_id`, `owner`, `tag`, `sort` (`name`, `company`, `updated`, `created`; default `name`), `order` (`asc` or `desc`), `has` and `missing` (comma-separated `email`, `phone`, `linkedin`, `company`), `limit`, `offset`, `include_archived=true`.

Contact fields: `companyId`, `firstName`, `lastName`, `email`, `phone`, `jobTitle`, `linkedinUrl`, `ownerId`, `source`, `sourceReference`, `notes`, `tags`. Tags follow the rules in [Tags](#tags).

`POST /api/v1/contacts` creates a person. A name, email, phone, or LinkedIn profile is required. Matching email or LinkedIn returns 409 `duplicate_contact`.

`POST /api/v1/contacts/upsert` matches email, then LinkedIn, then the same name at the same company. `200` with `{ "contact", "created", "matchedOn" }`. `matchedOn` is `email`, `linkedin`, `name`, or `null`.

`GET`, `PATCH`, and `DELETE /api/v1/contacts/:id` read, partially update, and archive. `DELETE` sets `archived_at`.

## Opportunities

`GET /api/v1/opportunities` with `q`, `company_id`, `pipeline_id` (a board id, or the default pipeline's id), `status` (`open`, `won`, `lost`), `limit`, `offset`, `include_archived=true`. Without `pipeline_id` it returns opportunities and board cards together; each row has `pipelineId`, `pipelineName` and `pipelineKind` (`sales` or `board`).

Opportunity fields: `companyId`, `pipelineId`, `name`, `stageId`, `status`, `value` (a number or a numeric string), `currency`, `probability`, `expectedCloseDate` (YYYY-MM-DD), `primaryContactId`, `ownerId`, `source`.

`POST /api/v1/opportunities` requires `companyId` and, on the default pipeline, `name`. `pipelineId` adds a card to a board instead: the name defaults to the company's, a company can be on a board once (409 `conflict` otherwise), and board stages have no won or lost. `primaryContactId` must be a contact who works at `companyId`; a create, or a `PATCH` that changes the company or contact, fails with 400 `invalid_input` (`field: primaryContactId`) otherwise. Omitting `stageId` uses the first stage of the pipeline. Marking a sales opportunity won also makes the company a customer and adds it to boards set to Add companies when a deal is won. A won or lost stage sets `status`. Setting `status` to `won` or `lost` moves the opportunity to that stage. Value is a non-negative amount with up to two decimal places. Currency is a three-letter code and defaults to `GBP`.

`GET /api/v1/pipeline` returns the default pipeline and its stages.

`GET`, `PATCH`, and `DELETE /api/v1/opportunities/:id` read, partially update, and archive. A stage change writes an `opportunity.stage_changed` audit event.

## Activities

`GET /api/v1/activities` with `q`, `company_id`, `contact_id`, `opportunity_id`, `type`, `limit`, `offset`, newest first.

Every activity includes `actorUserId`, `actorAgentId`, and `actorName`: the full name (or email) of the workspace member who logged it, or the name of the agent that created it. `actorName` is `null` when neither can be resolved, for example after the member leaves the workspace.

`POST /api/v1/activities` appends an interaction. Types are `email`, `meeting`, `call`, `note`, `research`, `linkedin`, `agent_update`, and `other`. Fields: `type`, `title`, `body`, `occurredAt`, `companyId`, `contactId`, `opportunityId`, `metadata` (an object). A title or body is required, and the row must point at a company, contact, or opportunity. There is no update or delete in the API. People can edit an activity in the app or through the assistant, which fires `activity.updated` with the changed `fields` and their `before` and `after` values, and delete (archive) one, which fires `activity.archived`.

## Tasks

Task fields: `title`, `description`, `dueAt`, `remindMinutes` (0, 5, 10, 15, 30, 60, 120, 1440, 2880 or 10080, before the due time), `priority` (`low`, `normal`, `high`), `ownerId`, `companyId`, `contactId`, `opportunityId`, and on `PATCH` `completed`.

`GET /api/v1/tasks` with `q`, `company_id`, `owner`, `include_archived=true`, `limit`, `offset`, and `view` (`all`, `overdue`, `today`, `upcoming`, `completed`). Without `view` it returns every open task. `all` is every open task (not completed, not archived) whatever its due date: overdue first, then by due date, undated last, then high, normal, low priority and oldest first. `today` includes open tasks with no due date. `completed` is the last 14 days.

`GET /api/v1/actions?view=` returns the same tasks, up to 100, and defaults to `today` when `view` is missing or not recognised. `view=all` returns every open task in the order above. `view=none` returns companies that have no open task.

Agent tokens see every task in the workspace; people in the app only see tasks they own or created unless they are an owner or admin. `POST /api/v1/tasks` creates one (unowned unless `ownerId` is given). A `dueAt` without a `Z` or offset is read as London time, and `today` and `overdue` are cut at midnight London time. `GET /api/v1/tasks/:id` returns `{ "task": { ... } }`, and `PATCH /api/v1/tasks/:id` updates it. `completed: true` sets `completed_at` without moving an existing completion time. `completed: false` reopens it.

`POST /api/v1/tasks/:id/complete` marks it complete. `DELETE /api/v1/tasks/:id` archives it. Each task also carries `clickupTaskId`, `clickupListId`, `clickupUrl`, and `clickupError` (null when it is not linked to ClickUp). Changes made through the API reach ClickUp on the next sync.

## Leads

`POST /api/v1/leads` accepts any of `company`, `contact`, `note`, `activity`, `opportunity`, and `task`. Company and contact use the upsert rules. The note becomes a research activity when `activity` is omitted. The opportunity and task attach to the company and contact from the same request. The response is one object with `company`, `contact`, `activity`, `opportunity`, `task`, and the created/matched flags. The whole request is one transaction.

## Context

`GET /api/v1/companies/:id/context` returns the company, its contacts, opportunities, recent activities, open tasks, `lastInteraction`, `openTaskCount`, `relationshipStatus` (`new`, `active`, `quiet`, or `needs_action`), and `timeline`: the company's activities plus those of its current contacts, newest first. `insights` maps the id of each call in the timeline that has a summary to its summary, key points, suggested actions, status, and `sentiment` (`healthy`, `watch`, `at_risk` or null) with `sentimentReason` (the transcript is not included). The company carries `health`, `healthReason`, `healthAt` and `healthActivityId`.

`GET /api/v1/relationships/stale` lists companies with no interaction in the last 21 days. `days` and `limit` are optional.

## Import and export

`GET /api/v1/export/companies`, `/contacts`, `/opportunities`, `/activities`, and `/tasks` return CSV.

`POST /api/v1/import/companies` and `POST /api/v1/import/contacts` accept `text/csv` or `{ "csv": "..." }`. Up to 50 rows. Companies match by domain. Contacts match by the usual contact rules and attach to a company with the same domain or name. A column that is absent, or a cell that is empty, leaves that field as it is. Exports include a `Tags` column with tags separated by `; `. On import a non-empty `Tags` cell (split on `;`) replaces that record's tags. Without the matching write scope the import returns 403.

## Communications

`POST /api/v1/communications` accepts `{ "kind": "email" | "meeting", "title", "body", "participantEmails", "companyId", "contactId" }`. It files the activity and, when it happened in the last 48 hours and the company has no open task, creates a suggested follow-up task. Requires `activities:write`. The follow-up also requires `tasks:write`.

## Bulk leads

`POST /api/v1/leads/bulk` accepts `{ "leads": [ ... ], "provenance": {} }` with 1 to 50 leads. Each lead uses the single-lead rules and is saved on its own. The response is `{ "results": [ { "index": 0, "status": "created", "lead": {} } ] }`. `status` is `created` or `error`.

## Pipeline

`PUT /api/v1/pipeline` replaces the default pipeline stages. Send every stage to keep, with exactly one `isWon` and one `isLost`. Include `id` to update an existing stage. A stage that still has opportunities cannot be removed. Requires `opportunities:write`.

## Webhooks

`POST /api/v1/webhooks` requires `admin`. Body: `{ "url", "events": ["lead.created"], "description" }`. `201` returns `{ "endpoint", "secret" }`. The secret is shown once. URLs must be `https`, except `http://127.0.0.1` and `http://localhost` for development.

`events` (1 to 30) takes any of `company.created`, `company.updated`, `company.archived`, `company.merged`, `company.undone`, `contact.created`, `contact.updated`, `contact.archived`, `contact.merged`, `contact.undone`, `lead.created`, `opportunity.created`, `opportunity.updated`, `opportunity.stage_changed`, `opportunity.archived`, `opportunity.undone`, `activity.created`, `activity.updated`, `activity.archived`, `activity.undone`, `task.created`, `task.completed`, `task.reopened`, `task.updated`, `task.archived` and `task.undone`, or `*` for every event. Restoring a record from the archive fires `*.updated` with `fields: ["archivedAt"]`. When someone undoes a change through the assistant, the change it puts back fires its normal event first, then `*.undone` fires with `data` of `{ "undoes", "undoneEventType", "restored" }`: the id of the audit event that was undone, its type, and a sentence saying what was put back.

`company.merged` and `contact.merged` carry how many rows moved from each table and which fields were filled; the archived duplicate also fires `company.archived` or `contact.archived` with `mergedInto`.

An endpoint subscribed to `*` also receives every other audited event, which can't be chosen by name: for example `knowledge.added`, `knowledge.updated` and `knowledge.removed` (Knowledge isn't in the agent API; these carry the item's title, kind, scope and company), `board.*`, `document.*` for proposals and NDAs, `template.*`, `product.*`, `email_template.*` and `call_summary.ready`. Changes to a person's own mailbox are not audited and never fire webhooks.

`GET /api/v1/webhooks` lists endpoints without the secret. `DELETE /api/v1/webhooks/:id` archives one. `GET /api/v1/webhooks/deliveries` lists recent attempts.

A delivery is `POST` JSON of `{ "id", "type", "createdAt", "workspaceId", "entity": { "type", "id" }, "actor": { "type", "userId", "agentId" }, "source", "sourceUrl", "data" }`, where `data` is the audit event's changes, with headers `X-CRM-Event`, `X-CRM-Event-Id`, `X-CRM-Timestamp`, and `X-CRM-Signature: v1=<hex>`. The signature is HMAC SHA-256 of `{timestamp}.{body}` using the endpoint secret. Deliveries go out right after the change that queued them. A non-2xx response is retried after 1, 5, 30 and 120 minutes, and marked failed after the fifth attempt; retries run on the next delivery or the scheduled sync (every 10 minutes), whichever comes first.
