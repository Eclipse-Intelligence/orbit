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

`crm.audit_events` is append-only. A trigger rejects updates and deletes, and those grants are not given out. Mutations write an event with the actor type (`user` or `agent`), agent id, credential id, source, and source URL when the caller provides them. Each event also queues a delivery for every enabled webhook subscribed to that event type. Delivery signs the body with HMAC SHA-256 and retries a failed attempt for about three hours.

## People, opportunities, activity, and next actions

Contacts match an active email, then an active LinkedIn profile, then the same normalised name at the same company. Opportunities use the workspace default pipeline. Omitting the stage picks the first stage. A won or lost stage sets the status, and setting the status to won or lost moves the opportunity to that stage. `opportunity.stage_changed` is written when the stage or status changes.

Activities are append-only. A company timeline reads activities stored against that company. Next actions are tasks. Completing one sets `completed_at` and leaves that timestamp in place if it is completed again.

`POST /api/v1/leads` and the `add_lead` tool run company, contact, activity, opportunity, and next-action writes in one transaction, through the same functions the individual endpoints use. A second lead with the same domain and email updates those rows instead of creating new ones.

Company, contact, opportunity, and task references must belong to the same workspace. That check is a trigger, so a foreign id cannot be attached even when the caller's row-level policy would otherwise hide it.

## Conversations

`record_email` and `record_meeting` file an interaction on a contact matched by email, or on a company matched by the email's domain. When that company has no open next action, the CRM adds a follow-up due in two days.

The inbox connects one Microsoft mailbox per user. `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` come from an Entra app with delegated `Mail.Read`, `User.Read`, and `offline_access`. The refresh token is encrypted with `APP_SECRET`. Opening the inbox, or choosing Sync, reads messages received since the last sync (the first sync looks back 14 days, up to 100 messages). A message attaches to a contact by email address, otherwise to a company by domain. The mailbox's own address is not the contact. A match from the last 48 hours files an email activity and, when the company has no open next action, suggests a follow-up. Mail that matches neither stays in the inbox as not attached. Gmail and calendar sync are not connected.

## Quiet relationships

A company is quiet when its latest activity is older than 21 days, or it has never had one. Company context also reports a relationship status: `new`, `active`, `quiet`, or `needs_action`.

## What is left for you

Hosted Supabase is not provisioned from this environment. Point the app at your project when you have one, and do not run `supabase/bootstrap/local-auth.sql` there. The Microsoft inbox starts once the Entra app credentials are in the environment. Gmail and calendar sync are still separate.
