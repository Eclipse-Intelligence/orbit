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

The migration also creates `crm_app` when it is missing, with the local development password above. Change that password outside local development.

```bash
npm install
cp .env.example .env.local
npm run db:setup
npm run dev
```

`db:setup` applies `supabase/bootstrap/local-auth.sql` only when `auth.users` does not already exist, applies each CRM migration once, and writes a local user plus an agent token into `.env.local`. Sign in with `DEV_USER_EMAIL` and `DEV_USER_PASSWORD`. The local agent can read and write companies, contacts, leads, activities, opportunities, and next actions. It can also file emails and meetings, import CSV, and register webhooks when the token includes `admin`.

`npm run db:reset` drops the `crm` and `private` schemas and the local auth users, then sets up again. It refuses to run when it detects hosted Supabase Auth.

## Microsoft inbox

Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and the redirect URI registered on the Entra app. Delegated permissions are `Mail.Read`, `Mail.Send`, `User.Read`, and `offline_access`. Restart the server, open Inbox, and connect the mailbox. Received mail is attached to a contact by email address, or to a company by domain. From a contact, Send email delivers through that mailbox. A mailbox connected before Mail.Send was granted has to be disconnected and connected again.

## Hosted Supabase

The Orbit project is `xuvofoydyewbloybrmas` in `eu-west-1`: `https://xuvofoydyewbloybrmas.supabase.co`.

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the project URL and the publishable key. Point `DATABASE_URL` at `crm_app` and `DATABASE_ADMIN_URL` at `crm_admin` on the session pooler (`aws-0-eu-west-1.pooler.supabase.com`, port 5432), with `sslmode=require`. The database name is `postgres`. Do not run `supabase/bootstrap/local-auth.sql` there. The CRM migrations are already applied. Keep the service role on the server. Do not put it in an agent token or a `NEXT_PUBLIC_` variable.

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
