# CRM API

Base path: `/api/v1`

Authentication is `Authorization: Bearer <agent token>`. Browser cookies are not accepted. Each credential is limited to 120 requests per minute. A 429 response includes `Retry-After: 60`.

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
| Next action create, update, complete, archive | `tasks:write` |
| Lead ingestion | `leads:write`, plus the write scope of each record included |

`admin` satisfies any of these.

## Companies

`GET /api/v1/companies`

Query: `q`, `lifecycle` (`lead`, `prospect`, `customer`, `churned`), `owner` (a user id or `unassigned`), `sort` (`name`, `domain`, `updated`, `created`), `order` (`asc` or `desc`), `limit` (1–100, default 50), `offset` (max 10000), `include_archived=true`.

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

`POST /api/v1/companies/bulk` accepts `{ "companies": [ ... ], "provenance": { "source": "", "sourceUrl": "" } }` with 1–50 companies. Each item is validated on its own. The response is `{ "results": [ { "index": 0, "status": "created", "company": {}, "matchedOn": null } ] }`. `status` is `created`, `updated`, `matched`, or `error`. `matched` means an existing company was found and no fields changed. An error item includes `{ "code", "message" }` and does not roll back the items that succeeded.

## Company fields

`name`, `domain`, `website`, `description`, `industry`, `sizeCategory`, `lifecycle`, `ownerId`, `source`, `sourceReference`.

`ownerId` must be a member of the workspace. Domain and website are canonicalised (`https://www.acme.com/about` becomes domain `acme.com`).

Provenance, when sent, is an object:

```json
{ "provenance": { "source": "research-agent", "sourceUrl": "https://example.com/acme" } }
```

It is stored on the audit event. It is not a company column.

## Errors

```json
{ "error": { "code": "forbidden", "message": "Missing scope companies:write.", "details": {} } }
```

Codes include `unauthorized` (401), `forbidden` (403), `not_found` (404), `invalid_input` (400), `duplicate_company` (409), `duplicate_contact` (409), `idempotency_conflict` (409), `rate_limited` (429), and `internal_error` (500).

## Contacts

`GET /api/v1/contacts` with `q`, `company_id`, `owner`, `limit`, `offset`, `include_archived=true`.

`POST /api/v1/contacts` creates a person. A name, email, phone, or LinkedIn profile is required. Matching email or LinkedIn returns 409 `duplicate_contact`.

`POST /api/v1/contacts/upsert` matches email, then LinkedIn, then the same name at the same company. `200` with `{ "contact", "created", "matchedOn" }`. `matchedOn` is `email`, `linkedin`, `name`, or `null`.

`GET`, `PATCH`, and `DELETE /api/v1/contacts/:id` read, partially update, and archive. `DELETE` sets `archived_at`.

## Opportunities

`GET /api/v1/opportunities` with `q`, `company_id`, `status` (`open`, `won`, `lost`).

`POST /api/v1/opportunities` requires `companyId` and `name`. Omitting `stageId` uses the first stage of the default pipeline. A won or lost stage sets `status`. Setting `status` to `won` or `lost` moves the opportunity to that stage. Value is a non-negative amount with up to two decimal places. Currency is a three-letter code and defaults to `USD`.

`GET /api/v1/pipeline` returns the default pipeline and its stages.

`GET`, `PATCH`, and `DELETE /api/v1/opportunities/:id` read, partially update, and archive. A stage change writes an `opportunity.stage_changed` audit event.

## Activities

`GET /api/v1/activities` with `q`, `company_id`, `contact_id`, `opportunity_id`, `type`.

`POST /api/v1/activities` appends an interaction. Types are `email`, `meeting`, `call`, `note`, `research`, `linkedin`, `agent_update`, and `other`. A title or body is required, and the row must point at a company, contact, or opportunity. There is no update or delete.

## Next actions

`GET /api/v1/tasks` with `q`, `company_id`, `owner`, and `view` (`overdue`, `today`, `upcoming`, `completed`). `today` includes open actions with no due date. `completed` is the last 14 days.

`GET /api/v1/actions?view=` returns the same tasks. `view=none` returns companies that have no open next action.

`POST /api/v1/tasks` creates one. `PATCH /api/v1/tasks/:id` updates it. `completed: true` sets `completed_at` without moving an existing completion time. `completed: false` reopens it.

`POST /api/v1/tasks/:id/complete` marks it complete. `DELETE /api/v1/tasks/:id` archives it.

## Leads

`POST /api/v1/leads` accepts any of `company`, `contact`, `note`, `activity`, `opportunity`, and `task`. Company and contact use the upsert rules. The note becomes a research activity when `activity` is omitted. The opportunity and next action attach to the company and contact from the same request. The response is one object with `company`, `contact`, `activity`, `opportunity`, `task`, and the created/matched flags. The whole request is one transaction.

## Context

`GET /api/v1/companies/:id/context` returns the company, its contacts, opportunities, recent activities, open next actions, `lastInteraction`, `openTaskCount`, and `relationshipStatus` (`new`, `active`, `quiet`, or `needs_action`).

`GET /api/v1/relationships/stale` lists companies with no interaction in the last 21 days. `days` and `limit` are optional.

## Import and export

`GET /api/v1/export/companies`, `/contacts`, `/opportunities`, `/activities`, and `/tasks` return CSV.

`POST /api/v1/import/companies` and `POST /api/v1/import/contacts` accept `text/csv` or `{ "csv": "..." }`. Up to 50 rows. Companies match by domain. Contacts match by the usual contact rules and attach to a company with the same domain or name. A column that is absent stays as it is. An empty cell clears that field.

## Communications

`POST /api/v1/communications` accepts `{ "kind": "email" | "meeting", "title", "body", "participantEmails", "companyId", "contactId" }`. It files the activity and, when the company has no open next action, creates a suggested follow-up. Requires `activities:write`. The follow-up also requires `tasks:write`.

## Bulk leads

`POST /api/v1/leads/bulk` accepts `{ "leads": [ ... ], "provenance": {} }` with 1–50 leads. Each lead uses the single-lead rules and is saved on its own. The response is `{ "results": [ { "index": 0, "status": "created", "lead": {} } ] }`. `status` is `created` or `error`.

## Pipeline

`PUT /api/v1/pipeline` replaces the default pipeline stages. Send every stage to keep, with exactly one `isWon` and one `isLost`. Include `id` to update an existing stage. A stage that still has opportunities cannot be removed. Requires `opportunities:write`.

## Webhooks

`POST /api/v1/webhooks` requires `admin`. Body: `{ "url", "events": ["lead.created"], "description" }`. `201` returns `{ "endpoint", "secret" }`. The secret is shown once. URLs must be `https`, except `http://127.0.0.1` and `http://localhost` for development.

`GET /api/v1/webhooks` lists endpoints without the secret. `DELETE /api/v1/webhooks/:id` archives one. `GET /api/v1/webhooks/deliveries` lists recent attempts.

A delivery is `POST` JSON with headers `X-CRM-Event`, `X-CRM-Event-Id`, `X-CRM-Timestamp`, and `X-CRM-Signature: v1=<hex>`. The signature is HMAC SHA-256 of `{timestamp}.{body}` using the endpoint secret. A non-2xx response is retried for about three hours.
