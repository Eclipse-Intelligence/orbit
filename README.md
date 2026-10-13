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

What is sent to the gateway: the transcript, the call or meeting date, your name, the contact's name, job title and company, and the activity's title. Nothing else from the CRM is sent. Meetings get the same panel as calls, and pasting a transcript still works for anything Orbit did not import itself.

## Automatic transcripts

Transcripts from Teams calls and Granola meetings arrive on their own and are summarised like a pasted transcript. Anything Orbit cannot match to a contact or company waits in Inbox under Unfiled conversations, where File to… puts it on a contact (and summarises it) and Ignore hides it. Inbox also shows when each source last synced, its last error, and Sync now.

Environment:

| Variable               | What it does                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GRANOLA_API_KEY`      | Granola personal API key (`grn_…`, Business plan). Leave empty to turn Granola off.                                     |
| `GRANOLA_API_BASE_URL` | Optional. Overrides the Granola API base URL (default `https://public-api.granola.ai`).                                  |
| `CRON_SECRET`          | Shared secret for `/api/cron/sync`. The scheduler sends `Authorization: Bearer <CRON_SECRET>`. Without it the route returns 503. |
| `SITE_URL` | Production origin, for example `https://orbit-mark-ridgeons-projects.vercel.app`. Teams subscriptions are only created when it is set and uses https, and the Granola webhook is registered on it. |

### Granola

Set `GRANOLA_API_KEY` and restart. Notes go into the workspace with a member whose email is the note owner's email, or into the only workspace when there is one. Each sync lists notes updated since the last sync less an hour (the first sync looks back 14 days) and imports each new note with its transcript. A note is filed as a `meeting` activity on the first attendee or calendar invitee whose email is a contact, otherwise on a company matched by email domain (free-mail domains such as gmail.com never match). Workspace members, and anyone at the note owner's or a member's own domain, are never matched, so internal meetings stay unfiled instead of landing on your own company. The meeting is titled after the note or the calendar event, dated at the scheduled start, lists the attendees, and links back with Open in Granola. Granola's own summary is kept and shown on unfiled conversations. A note is imported once; later edits in Granola do not change it. A note that fails to import is recorded with its error and retried on the next syncs; after three failures it moves to Unfiled conversations with the error, and it never holds back the rest of the sync.

Enable instant Granola sync in Inbox registers `/api/granola/webhook` with Granola for `note.generated` events and stores the signing secret encrypted. When Granola says webhooks are not available for the workspace, Orbit keeps checking every 10 minutes instead. The webhook route checks the signature before doing anything else, ignores a delivery id it has already seen, and never calls Granola before the request is verified.

### Teams transcripts

1. On the Entra app, add the Microsoft Graph application permission `CallTranscripts.Read.All` and choose Grant admin consent. `CallRecords.Read.All` stays, because transcripts are matched to calls through the call log.
2. In the Teams admin center, the calling policy for the mailbox user must allow recording and transcription for calls. Transcription has to be started on the call (from the call's More actions menu) for a transcript to exist.
3. Set `SITE_URL` to the production https origin so Orbit can subscribe to new transcripts. Without it Orbit still polls.

Each mailbox owner's transcripts, sync state, and subscription are their own: other workspace members cannot see or file them. Orbit reads the user's ad hoc call transcripts (Graph `getAllTranscripts`) since the last sync less six hours (the first sync looks back 7 days). A transcript waits until its Teams call log appears, then attaches to that call's activity and is summarised. If the call never matches a contact within 48 hours, it moves to Unfiled conversations; filing it there also links the call log. Orbit keeps a Graph change notification subscription for new transcripts (two days, renewed when less than a day is left, recreated if Microsoft removes it). Microsoft only notifies about transcripts started after the subscription existed; polling picks up the rest. If Inbox says to grant `CallTranscripts.Read.All`, step 1 is missing; if it says your admin has turned off API access to Teams transcripts, the tenant blocks Graph access to transcripts.

### Scheduling

`GET` or `POST /api/cron/sync` with `Authorization: Bearer <CRON_SECRET>` runs, for each workspace with a connected mailbox or Granola: mail sync, Teams call sync, Teams transcript sync and subscription upkeep, Granola sync, and pending summaries. Each step runs on its own, so one failing does not stop the rest, and the run stops starting new steps after about 50 seconds. Mail sync only starts with at least 15 seconds left, and model calls, Graph and Granola requests are cut short so the run fits. It returns a JSON report of counts and errors per mailbox owner. CRM pages also sync in the background after they load.

`vercel.json` has a daily Vercel cron as a backstop (Hobby plans allow one run a day; Vercel sends `CRON_SECRET` as the bearer token). For every 10 minutes, schedule it from Supabase with `pg_cron` and `pg_net`. Run this in the SQL editor, replacing `<CRON_SECRET>` with the value set on Vercel:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'orbit-sync',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://orbit-mark-ridgeons-projects.vercel.app/api/cron/sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <CRON_SECRET>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
```

Check runs with `select * from cron.job_run_details order by start_time desc limit 10;` and responses with `select * from net._http_response order by created desc limit 10;`. Stop it with `select cron.unschedule('orbit-sync');`. Running `cron.schedule` again with the same name replaces the job, which is how to rotate the secret.

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
