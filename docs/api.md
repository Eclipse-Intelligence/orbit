# Company API

Base path: `/api/v1`

Authentication is `Authorization: Bearer <agent token>`. Browser cookies are not accepted. Each credential is limited to 120 requests per minute. A 429 response includes `Retry-After: 60`.

Send `Content-Type: application/json`. Unknown fields are rejected. Omitted fields on `PATCH` and upsert are left unchanged. `null` clears an optional field.

Optional `Idempotency-Key` header (printable ASCII, up to 200 characters). Reuse a key only for the same request body.

## Scopes

| Operation | Scope |
| --- | --- |
| List, get | `crm:read` |
| Create, update, upsert, archive | `companies:write` |

`admin` satisfies either scope.

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

Codes include `unauthorized` (401), `forbidden` (403), `not_found` (404), `invalid_input` (400), `duplicate_company` (409), `idempotency_conflict` (409), `rate_limited` (429), and `internal_error` (500).
