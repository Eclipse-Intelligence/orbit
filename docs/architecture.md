# Architecture

PostgreSQL is the source of truth. The web UI, REST API, and MCP server call the same company service in `lib/crm/companies.ts`. Matching, partial updates, idempotency, and audit writes are not reimplemented in each client.

```
Browser  -> server actions -> company service -> PostgreSQL
Agent    -> /api/v1        -> company service -> PostgreSQL
Agent    -> /api/mcp       -> company service -> PostgreSQL
```

Zustand holds the open row and the latest page of companies so the table can update before the next refresh. It is not persistence. A reload reads the database.

## Tenancy

Every business row has `workspace_id`. Human sessions resolve a user id, then `withActor` sets the JWT claims and `SET LOCAL ROLE authenticated` for the transaction. Agent sessions set `app.workspace_id` and `SET LOCAL ROLE crm_agent`. Policies use those settings. The table owner is not the role the request runs as, and row-level security is forced.

Business tables are in the `crm` schema so the Supabase Data API does not expose them. Privileged functions live in `private` and are executable by the `crm_app` login, not by `authenticated` or `crm_agent`.

## People and agents

Humans sign in with Supabase Auth when `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set. Without those, a local password session is used. `supabase/bootstrap/local-auth.sql` creates a small `auth.users` table and `auth.uid()`. Do not run that file on a hosted Supabase project.

Agents are rows in `crm.agents`, not user accounts. A credential is a random token stored as a SHA-256 hash. The plaintext is shown once. Revoke it by setting `revoked_at`. Scopes are `crm:read`, `companies:write`, `contacts:write`, `leads:write`, `activities:write`, `opportunities:write`, `tasks:write`, and `admin`. `admin` implies the others. This milestone's API enforces `crm:read` and `companies:write`.

The service role key is never given to an agent. Agents use their own bearer token against this application's API.

## Companies

Active companies in a workspace are unique by canonical domain. A company with no domain can also match another company with the same normalised name and no domain. The same display name with two different domains stays two companies. Writes take a workspace advisory lock, then unique indexes stop a race.

`PATCH` and upsert leave omitted fields alone. An explicit `null` clears an optional field. A domain-only upsert does not replace an existing name.

`Idempotency-Key` is stored per workspace and actor. The same key and body replays the stored response. The same key and a different body returns 409.

Deletes archive. `archived_at` is set and the row stays. There is no hard delete on the API.

## Audit

`crm.audit_events` is append-only. A trigger rejects updates and deletes, and those grants are not given out. Company create, update, and archive write an event with the actor type (`user` or `agent`), agent id, credential id, source, and source URL when the caller provides them. That table is also the future webhook outbox. Delivery, signatures, and retries are not built yet.

## What this milestone does not do

Contacts, opportunities, activities, tasks, lead ingestion, and email sync have tables or a place to land, and no product behaviour yet. Do not treat empty relationship sections as recorded history.
