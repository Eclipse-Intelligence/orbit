# Architecture

PostgreSQL is the source of truth. The web UI, REST API, and MCP server call the same company service in `lib/crm/companies.ts`. Matching, partial updates, idempotency, and audit writes are not reimplemented in each client.

```
Browser  -> server actions -> domain services -> PostgreSQL
Agent    -> /api/v1        -> domain services -> PostgreSQL
Agent    -> /api/mcp       -> domain services -> PostgreSQL
```

Zustand holds which panel is open. Lists are rendered from the database. A reload reads PostgreSQL again.

## Tenancy

Every business row has `workspace_id`. Human sessions resolve a user id, then `withActor` sets the JWT claims and `SET LOCAL ROLE authenticated` for the transaction. Agent sessions set `app.workspace_id` and `SET LOCAL ROLE crm_agent`. Policies use those settings. The table owner is not the role the request runs as, and row-level security is forced.

Business tables are in the `crm` schema so the Supabase Data API does not expose them. Privileged functions live in `private` and are executable by the `crm_app` login, not by `authenticated` or `crm_agent`.

## People and agents

Humans sign in with Supabase Auth when `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set. Without those, a local password session is used. `supabase/bootstrap/local-auth.sql` creates a small `auth.users` table and `auth.uid()`. Do not run that file on a hosted Supabase project.

Agents are rows in `crm.agents`, not user accounts. A credential is a random token stored as a SHA-256 hash. The plaintext is shown once. Revoke it by setting `revoked_at`. Scopes are `crm:read`, `companies:write`, `contacts:write`, `leads:write`, `activities:write`, `opportunities:write`, `tasks:write`, and `admin`. `admin` implies the others. A lead ingestion checks `leads:write` and the write scope of each record it actually creates or updates.

The service role key is never given to an agent. Agents use their own bearer token against this application's API.

## Companies

Active companies in a workspace are unique by canonical domain. A company with no domain can also match another company with the same normalised name and no domain. The same display name with two different domains stays two companies. Writes take a workspace advisory lock, then unique indexes stop a race.

`PATCH` and upsert leave omitted fields alone. An explicit `null` clears an optional field. A domain-only upsert does not replace an existing name.

`Idempotency-Key` is stored per workspace and actor. The same key and body replays the stored response. The same key and a different body returns 409.

Deletes archive. `archived_at` is set and the row stays. There is no hard delete on the API.

## Audit

`crm.audit_events` is append-only. A trigger rejects updates and deletes, and those grants are not given out. Company create, update, and archive write an event with the actor type (`user` or `agent`), agent id, credential id, source, and source URL when the caller provides them. That table is also the future webhook outbox. Delivery, signatures, and retries are not built yet.

## People, opportunities, activity, and next actions

Contacts match an active email, then an active LinkedIn profile, then the same normalised name at the same company. Opportunities use the workspace default pipeline. Omitting the stage picks the first stage. A won or lost stage sets the status, and setting the status to won or lost moves the opportunity to that stage. `opportunity.stage_changed` is written when the stage or status changes.

Activities are append-only. A company timeline reads activities stored against that company. Next actions are tasks. Completing one sets `completed_at` and leaves that timestamp in place if it is completed again.

`POST /api/v1/leads` and the `add_lead` tool run company, contact, activity, opportunity, and next-action writes in one transaction, through the same functions the individual endpoints use. A second lead with the same domain and email updates those rows instead of creating new ones.

Company, contact, opportunity, and task references must belong to the same workspace. That check is a trigger, so a foreign id cannot be attached even when the caller's row-level policy would otherwise hide it.

## What this milestone does not do

Email and calendar sync, webhook delivery, and reporting beyond due and stale lists are not built. An empty timeline means no interaction has been recorded.
