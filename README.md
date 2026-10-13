# Orbit

Orbit is a workspace CRM for companies, people, opportunities, conversations, and next actions. The web app, versioned API, and MCP server share one domain service backed by PostgreSQL.

## Requirements

- Node.js 20+
- PostgreSQL 16, local or hosted

Docker is not required. Hosted Supabase Auth is optional.

## Local setup

Create a database and a login the app can use:

```sql
create role crm_app login password 'crm_app_dev' nosuperuser nocreatedb nocreaterole noinherit;
create database crm owner crm_app;
```

The migration creates `crm_app` without a password when it is missing. On a local database, `db:setup` sets the `crm_app` password to the one in `DATABASE_URL`. On hosted Supabase, set and rotate the `crm_app` password yourself.

```bash
npm install
cp .env.example .env.local
npm run db:setup
npm run dev
```

`db:setup` applies `supabase/bootstrap/local-auth.sql` only when `auth.users` does not already exist, applies each CRM migration once, and writes a local user plus an agent token into `.env.local`. Sign in with `DEV_USER_EMAIL` and `DEV_USER_PASSWORD`. The local agent can read and write companies, contacts, leads, activities, opportunities, and next actions. It can also file emails and meetings, import CSV, and register webhooks when the token includes `admin`.

`npm run db:reset` drops the `crm` and `private` schemas and the local auth users, then sets up again. It refuses to run when it detects hosted Supabase Auth.

## Accounts and time

Orbit has no sign-up. Only an account that already belongs to a workspace can sign in; `db:setup` creates the local one. Dates, typed due times, and the Today and Overdue cut-offs use London time. `NEXT_PUBLIC_TIMEZONE` overrides that at build time if it ever needs to.

## Microsoft inbox

Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and the redirect URI registered on the Entra app. Delegated permissions are `Mail.Read`, `Mail.Send`, `User.Read`, and `offline_access`. Restart the server, open Inbox, and connect the mailbox. Received mail is attached to a contact by email address, or to a company by domain. Free-mail domains such as gmail.com are never matched by domain. Mail that matched nothing is attached on a later sync once its sender becomes a contact. From a contact, Send email delivers through that mailbox. A mailbox connected before Mail.Send was granted keeps syncing, but has to be disconnected and connected again before it can send. When `MICROSOFT_REDIRECT_URI` is set, Connect first sends you to that host, so be signed in there.

### Teams calls

Orbit logs Teams phone calls (Teams Phone with a Calling Plan) as `call` activities on the contact whose phone matches the other party, so calls never need logging by hand.

1. Give the mailbox user a Teams Phone licence and a Calling Plan, and assign them a phone number in the Teams admin center.
2. On the same Entra app, add the Microsoft Graph application permission `CallRecords.Read.All` (API permissions, Add a permission, Microsoft Graph, Application permissions), then choose Grant admin consent. A delegated permission does not work for call records.
3. Optionally set `MICROSOFT_TENANT` to the tenant id or domain (for example `contoso.onmicrosoft.com`). With the default `common`, Orbit reads the tenant from the connected mailbox's token.
4. Connect the mailbox in Inbox if it is not connected yet. No reconnect is needed after adding the permission.

Orbit syncs in the background after a CRM page loads, at most once every five minutes, and Inbox has Sync calls for an immediate sync. Each sync re-reads the last 24 hours because Microsoft can publish call logs late. Outgoing calls match the number dialled and incoming calls match the caller, in any UK format (`07…`, `+44…`, `0044…`). A call with no matching contact is kept and logged once a contact gets that number. Conference calls and other users' calls are skipped. If Inbox says to grant `CallRecords.Read.All`, step 2 is missing or consent has not been granted yet.

### Call summaries

Orbit can turn a call transcript into a short summary, key points, and suggested next actions, stored against the call activity. It uses the llmapi.ai gateway (OpenAI-compatible chat completions). Set `LLM_API_KEY`. Optionally set `LLM_MODEL` (default `claude-haiku-5-5`) and `LLM_API_BASE_URL` (default `https://api.llmapi.ai/v1`).

On a call in a contact's or company's activity, choose Add transcript, paste the transcript (plain text or the Teams `.vtt` text), and choose Summarise. Teams `.vtt` files are reduced to `Speaker: line` text first. Each suggested action has Add as next action, which creates a next action on the call's contact and company due at 09:00 London time on the stated day, and Dismiss. The transcript stays on the call under Transcript. A summary that fails keeps the transcript and shows the error with Try again.

What is sent to the gateway: the transcript, the call date, your name, the contact's name, job title and company, and the call's title. Nothing else from the CRM is sent. Fetching transcripts from Teams automatically comes next.

## Hosted Supabase

The Orbit project is `xuvofoydyewbloybrmas` in `eu-west-1`: `https://xuvofoydyewbloybrmas.supabase.co`.

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the project URL and the publishable key. Point `DATABASE_URL` at `crm_app` and `DATABASE_ADMIN_URL` at `crm_admin` on the session pooler (`aws-0-eu-west-1.pooler.supabase.com`, port 5432), with `sslmode=require`. The database name is `postgres`. Do not run `supabase/bootstrap/local-auth.sql` there. Apply new migrations before deploying code that depends on them: run `npm run db:setup` with the hosted variables. It applies each migration not yet listed in `private.schema_migrations` and recomputes company match keys. If a migration fails with `must be owner`, run that file in the SQL editor, insert its filename into `private.schema_migrations`, and run `db:setup` again. Turn off new-user sign-ups in the Supabase Auth settings as well. Keep the service role on the server. Do not put it in an agent token or a `NEXT_PUBLIC_` variable.

## Agents

```bash
npm run agent:create -- --name "Research" --scopes crm:read,companies:write
```

The token is printed once. Store it. Revoke a credential by setting `crm.agent_credentials.revoked_at`.

API: `docs/api.md`. MCP: `docs/mcp.md`. Schema and tenancy: `docs/architecture.md`. What was removed from the prototype: `docs/audit.md`.

## Scripts

| Script                 | What it does                                               |
| ---------------------- | ---------------------------------------------------------- |
| `npm run dev`          | Next.js dev server                                         |
| `npm run build`        | Production build                                           |
| `npm run lint`         | ESLint                                                     |
| `npm test`             | Domain, API, and MCP tests against the `crm_test` database |
| `npm run db:setup`     | Apply schema and seed a local user                         |
| `npm run db:reset`     | Drop local CRM data and set up again                       |
| `npm run agent:create` | Issue a revocable agent token                              |
| `npm run mcp`          | MCP server over stdio                                      |
