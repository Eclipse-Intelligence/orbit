# Sales CRM

A workspace CRM for companies. People, conversations, opportunities, and next actions are the direction of the product. This milestone stores companies in PostgreSQL and exposes them to the web app, a versioned API, and an MCP server through one domain service.

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

`db:setup` applies `supabase/bootstrap/local-auth.sql` only when `auth.users` does not already exist, applies the CRM migration, and writes a local user plus an agent token into `.env.local`. Sign in with `DEV_USER_EMAIL` and `DEV_USER_PASSWORD`.

`npm run db:reset` drops the `crm` and `private` schemas and the local auth users, then sets up again. It refuses to run when it detects hosted Supabase Auth.

## Hosted Supabase

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Do not run `supabase/bootstrap/local-auth.sql` there. Apply `supabase/migrations/20261005140000_crm_foundation.sql` with a role that can create schemas. Point `DATABASE_URL` at the `crm_app` role (or another role that can `SET ROLE authenticated` and `SET ROLE crm_agent`). Keep the service role on the server. Do not put it in an agent token or a `NEXT_PUBLIC_` variable.

## Agents

```bash
npm run agent:create -- --name "Research" --scopes crm:read,companies:write
```

The token is printed once. Store it. Revoke a credential by setting `crm.agent_credentials.revoked_at`.

API: `docs/api.md`. MCP: `docs/mcp.md`. Schema and tenancy: `docs/architecture.md`. What was removed from the prototype: `docs/audit.md`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm test` | Company service, API, and MCP tests against the `crm_test` database |
| `npm run db:setup` | Apply schema and seed a local user |
| `npm run db:reset` | Drop local CRM data and set up again |
| `npm run agent:create` | Issue a revocable agent token |
| `npm run mcp` | MCP server over stdio |
