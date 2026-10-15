# Orbit

Orbit is a workspace CRM for companies, people, opportunities, conversations, and tasks. The web app, versioned API, and MCP server share one domain service backed by PostgreSQL.

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

`db:setup` applies `supabase/bootstrap/local-auth.sql` only when `auth.users` does not already exist, applies each CRM migration once, and writes a local user plus an agent token into `.env.local`. Sign in with `DEV_USER_EMAIL` and `DEV_USER_PASSWORD`. The local agent can read and write companies, contacts, leads, activities, opportunities, and tasks. It can also file emails and meetings, import CSV, and register webhooks when the token includes `admin`.

`npm run db:reset` drops the `crm` and `private` schemas and the local auth users, then sets up again. It refuses to run when it detects hosted Supabase Auth.

## Accounts and time

Orbit has no sign-up. Only an account that already belongs to a workspace can sign in; `db:setup` creates the local one. Dates, typed due times, and the Today and Overdue cut-offs use London time. `NEXT_PUBLIC_TIMEZONE` overrides that at build time if it ever needs to.

## Settings

`/settings` opens Settings › General. Each section has its own page, listed down the left on wide screens and as a scrolling tab bar under the header on phones:

| Page | Path | What it holds |
| --- | --- | --- |
| General | `/settings/general` | Your account, My email addresses, and the meeting link for invites |
| Email templates | `/settings/email-templates` | Reusable emails (below) |
| Calendars | `/settings/calendars` | Calendar accounts and links, Show and Use for CRM |
| Integrations | `/settings/integrations` | Microsoft 365, Teams calls and Granola status (managed from Inbox), and the ClickUp settings |
| Pipeline | `/settings/pipeline` | Opportunity stages |
| Tags | `/settings/tags` | Rename, merge, and delete tags |
| API and webhooks | `/settings/api` | REST and MCP addresses, how to issue agent tokens, webhooks and recent deliveries |

Rarely used parts (token instructions, recent webhook deliveries, watched ClickUp lists, and similar) are collapsed until you open them. Old links keep working: `/settings#calendars`, `#pipeline`, `#tags`, `#webhooks`, `#clickup` and the rest open the matching page, and `#meeting-link` scrolls to it on General.

## Email templates

Settings › Email templates keeps emails you send often. A template has a name (up to 120 characters, unique in the workspace ignoring case), a subject (up to 300), a plain-text message (up to 20,000; line breaks are kept), and up to 20 tags, normalised like contact tags. Search matches the name, subject, and message; the tag chips filter the list. Selecting a template opens the editor with a live preview for one of your 20 most recently updated contacts, or for Alex Example at Example Ltd. Duplicate makes "Copy of …" (numbered when that name is taken), and Delete removes it after you confirm.

Tokens are `{{first_name}}` (falls back to the full name, then "there"), `{{last_name}}`, `{{name}}`, and `{{company}}`. Click a token chip to insert it at the cursor; anything else in double braces is flagged and left as typed.

In the email composer on a contact or company, and in the bulk email dialog, Use template lists your templates with search and tag filters. On a contact the subject and message are filled in already personalised for that person; in bulk email the tokens stay and each recipient gets their own version. Both composers accept tokens and personalise them when the email is sent or logged. Save as template stores the current subject and message under a name and tags; on a contact, a field you have not changed since using a template is saved with its tokens rather than the personalised text.

## Microsoft inbox

Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and the redirect URI registered on the Entra app. Delegated permissions are `Mail.Read`, `Mail.Send`, `User.Read`, `Calendars.ReadWrite`, and `offline_access`. Restart the server, open Inbox, and connect the mailbox. Received mail is attached to a contact by email address, or to a company by domain. Free-mail domains such as gmail.com are never matched by domain. Mail that matched nothing is attached on a later sync once its sender becomes a contact. From a contact, Send email delivers through that mailbox. A mailbox connected before Mail.Send was granted keeps syncing, but has to be disconnected and connected again before it can send. When `MICROSOFT_REDIRECT_URI` is set, Connect first sends you to that host, so be signed in there.

### Outlook calendar

Orbit reads the connected user's Outlook calendars (30 days back to 60 days ahead) and shows meetings from the calendars marked Use for CRM (the default calendar unless you change it) on the matching contacts and companies.

1. On the Entra app, add the Microsoft Graph delegated permission `Calendars.ReadWrite` (API permissions, Add a permission, Microsoft Graph, Delegated permissions). It includes reading, so `Calendars.Read` can stay or go. Grant admin consent if your tenant requires it.
2. A mailbox connected before `Calendars.Read` was added keeps syncing mail, but Inbox shows "Reconnect Microsoft to include your calendar". A mailbox connected with only `Calendars.Read` keeps syncing mail and the calendar, but the invite dialog shows "Reconnect Microsoft to send invites". In both cases choose Reconnect Microsoft in Inbox and accept the new permission. There is no need to disconnect first.

Contact and company pages then show a Meetings card with the next meeting, up to five upcoming and five recent ones (London time), an Open in Outlook link, and a Join link for online meetings. A past meeting that has Granola notes for the same contact within two hours links to those notes on the timeline instead. Inbox lists People you've met who aren't in Orbit: outside attendees from those meetings with no contact yet. Create contact adds them, with a company made from their email domain unless it is a free-mail domain, and Hide removes someone from the list for you. Calendars are private: other workspace members never see your meetings.

### Meeting invites

Orbit sends meeting invitations through Outlook: the event is created in the default calendar of the mailbox connected in Inbox, and Outlook emails the invitation to every guest from that mailbox, exactly as if you had sent it from Outlook. Replies and new-time proposals arrive in that mailbox.

1. Add `Calendars.ReadWrite` and reconnect as described above.
2. Open Settings › General, Meeting link, and paste your Whereby room (any `https://` link up to 500 characters works). Leave it empty if you don't want a link.
3. Choose New event on the Calendar page, click an empty slot in the day or week grid (it opens at that time, rounded down to 15 minutes), or use the calendar button next to Call in Teams on a contact (the contact needs an email address).

The dialog takes a title (Eclipse × the contact's name when you start from a contact), a date and start time in London time, a duration of 15 to 90 minutes, guests (search contacts by name or email, or type any address and press Enter; your own addresses, including those in Settings › General, My email addresses, are never invited; up to 50 guests), notes, and Add meeting link. With the link on, the invite's location is the link and its body ends with "Join: <link>". After sending, the event shows on the Calendar page straight away, and each guest who is a contact gets an "Invited … to …" meeting activity. A meeting you organise that hasn't started yet has Cancel meeting in its details: Outlook sends the cancellation, with your optional message, to every guest, and each guest contact gets a "Cancelled …" activity.

### More calendars and the Calendar page

The Calendar page shows a day or week (London time) across every connected calendar, with a checkbox per calendar to show or hide it. On a phone it shows the selected day as a list. Click an event for its time, calendar, location, organiser and attendees (each linked to their contact, or with Create contact), Join, Open in Outlook (Open event for a calendar link's event that has its own URL), and Granola notes when a Granola meeting overlaps it.

Your main calendars come from the Microsoft account connected in Inbox; nothing needs reconnecting. To add calendars from other Microsoft accounts (another work tenant, or a personal Outlook.com account), open Settings, Calendars, and choose Connect another Microsoft account. That account only grants `User.Read` and `Calendars.Read` (plus `openid` and `offline_access`), never mail. It reuses the same redirect URI, so there is nothing new to register. Settings lists every account with its calendars: Show controls the Calendar page, and Use for CRM decides which calendars feed the Meetings cards and People you've met (only the main account's default calendar is on at first). Disconnect removes an extra account with its calendars and events.

Accounts outside the Entra app's own tenant only work when the app allows them:

1. In Entra, App registrations, Orbit, Authentication (or Manifest), set Supported account types to accounts in any organisational directory, and also personal Microsoft accounts if you want Outlook.com calendars (`signInAudience` `AzureADMultipleOrgs` or `AzureADandPersonalMicrosoftAccount`).
2. Keep `MICROSOFT_TENANT` unset or `common` so other tenants and personal accounts can sign in. A single tenant id there limits every connection to that tenant.
3. If the other organisation blocks user consent, its admin has to consent to Orbit in that tenant first.

Until then the connection ends with "This Microsoft account's organisation doesn't allow Orbit yet", and nothing is saved. Connecting the main mailbox's own address as an extra account is refused.

### Google Calendar, iCloud and other calendars by link

Any calendar that publishes an iCal (ICS) link can be added read-only, with no developer setup: open Settings, Calendars, choose Add calendar by link, paste the link, and optionally give it a name (otherwise the calendar's own name is used). Orbit fetches it straight away and refuses links that don't return a calendar.

- Google Calendar: on a computer, Settings, Settings for my calendars, pick the calendar, Integrate calendar, and copy Secret address in iCal format. Treat it like a password; Reset there invalidates the old link, after which you remove the calendar in Orbit and add the new link.
- iCloud: at icloud.com/calendar, open the calendar's info button, turn on Public Calendar, and Copy. Anyone with that link can see the calendar.
- Anything else: an `https://` or `webcal://` link (`webcal://` is read as `https://`).

The link is stored encrypted with `APP_SECRET`, and Settings only shows its host (for example `calendar.google.com/…`). Each link is one calendar, synced with the others (at most every five minutes, 30 days back to 60 days ahead; the server's conditional `ETag`/`Last-Modified` answers are used for up to six hours, then it is read in full so new repeats come into the window). Use for CRM starts off; turn it on to feed Meetings cards and People you've met. Events are read-only, and Google's secret address can lag behind the live calendar, sometimes by a few hours. Remove deletes the link with its events.

### Teams calls

Orbit logs Teams phone calls (Teams Phone with a Calling Plan) as `call` activities on the contact whose phone matches the other party, so calls never need logging by hand.

1. Give the mailbox user a Teams Phone licence and a Calling Plan, and assign them a phone number in the Teams admin center.
2. On the same Entra app, add the Microsoft Graph application permission `CallRecords.Read.All` (API permissions, Add a permission, Microsoft Graph, Application permissions), then choose Grant admin consent. A delegated permission does not work for call records.
3. Optionally set `MICROSOFT_TENANT` to the tenant id or domain (for example `contoso.onmicrosoft.com`). With the default `common`, Orbit reads the tenant from the connected mailbox's token.
4. Connect the mailbox in Inbox if it is not connected yet. No reconnect is needed after adding the permission.

Orbit syncs in the background after a CRM page loads, at most once every five minutes, and Inbox has Sync calls for an immediate sync. Each sync re-reads the last 24 hours because Microsoft can publish call logs late. Outgoing calls match the number dialled and incoming calls match the caller, in any UK format (`07…`, `+44…`, `0044…`). A call with no matching contact is kept and logged once a contact gets that number. Conference calls and other users' calls are skipped. If Inbox says to grant `CallRecords.Read.All`, step 2 is missing or consent has not been granted yet.

### Call summaries

Orbit can turn a call or meeting transcript into a short summary, key points, and suggested tasks, stored against the activity. Action items that are yours become tasks on the contact automatically and, when ClickUp is set up with a default list, ClickUp tasks too. Items for the other person, or with no clear owner, stay in the summary with an "Add as task" button. It uses the llmapi.ai gateway (OpenAI-compatible chat completions). Set `LLM_API_KEY`. Optionally set `LLM_MODEL` (default `claude-haiku-5-5`) and `LLM_API_BASE_URL` (default `https://api.llmapi.ai/v1`).

On a call in a contact's or company's activity, choose Add transcript, paste the transcript (plain text or the Teams `.vtt` text), and choose Summarise. Teams `.vtt` files are reduced to `Speaker: line` text first. Each suggested task has Add as task, which creates a task on the call's contact and company due at 09:00 London time on the stated day, and Dismiss. The transcript stays on the call under Transcript. A summary that fails keeps the transcript and shows the error with Try again.

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

## ClickUp

Orbit keeps its tasks and ClickUp tasks in step, both ways.

1. In ClickUp, open your avatar › Settings › Apps, and under API Token choose Generate (or Regenerate), then Copy. The token starts with `pk_`.
2. In Vercel, add it as `CLICKUP_API_TOKEN` under Settings › Environment Variables and redeploy. Locally, put it in `.env.local` and restart.
3. In Orbit, open Settings › Integrations, ClickUp. Pick the default list for new tasks, tick the lists to watch, and choose Save ClickUp settings.
4. On each list where you create tasks for contacts, add a text custom field named `Orbit` (or `CRM`). Put the contact's email, the company's domain, or the Orbit link to the record in it.
5. Optional: with `SITE_URL` set to Orbit's https address, choose Enable instant ClickUp sync. Without it, Orbit checks ClickUp every 10 minutes and whenever a page loads (at most every 5 minutes).

| Variable                | What it does                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CLICKUP_API_TOKEN`     | ClickUp personal API token (`pk_…`). Leave empty to turn ClickUp off.                                         |
| `CLICKUP_API_BASE_URL`  | Optional. Overrides the ClickUp API base URL (default `https://api.clickup.com/api/v2`), for tests or a local fake. |

From Orbit to ClickUp: the add-task forms on a company page and on Tasks have Add to ClickUp, on by default once ClickUp is set up, with a list picker that remembers the last list used. The ClickUp task gets the title, the due date (London time; a due time of exactly midnight is sent as a date without a time), you as assignee, and a description with the contact or company name and a line `Orbit: <SITE_URL>/contacts/<id>` (or `/companies/<id>`). If the list has a text, URL, or email field named Orbit or CRM, Orbit fills it with that link (an email field gets the contact's email). Later changes to the title, due date, and done state are sent too: done picks the list's first status of type done or closed, reopening picks its first open status. Archiving in Orbit leaves the ClickUp task alone. If ClickUp fails, the Orbit task is still saved, the error shows on the task, and Orbit tries again on the next sync. Linked tasks show a ClickUp link.

From ClickUp to Orbit: a new task in a watched list becomes an Orbit task when Orbit can tell who it is for, checked in this order: the Orbit or CRM field holds an Orbit record link, a contact's email, or a company's domain; the description holds an Orbit record link; the description holds a contact's email (your own and other members' addresses are skipped). Tasks Orbit cannot place are left alone. Linked tasks keep their title, due date, and done state in step; when the same field changed on both sides, the later edit wins. Deleting the task in ClickUp archives the Orbit task.

Instant sync registers one ClickUp webhook for task created, updated, deleted, status, due date, and moved events. It covers a single list or space when everything you chose lives there, otherwise the whole workspace, and Orbit ignores tasks outside your lists. The route checks `X-Signature` (HMAC SHA-256 of the body with the webhook's secret, stored encrypted) before doing anything else, ignores deliveries it has already seen and events more than a day old, and answers straight away; the task is fetched afterwards. Changing the lists in Settings moves the webhook to match.

### Scheduling

`GET` or `POST /api/cron/sync` with `Authorization: Bearer <CRON_SECRET>` runs, for each workspace with a connected mailbox, extra calendar account or calendar link, Granola, or ClickUp: mail sync, Teams call sync, calendar sync (every connected account and calendar link; links sync even without the Microsoft app), Teams transcript sync and subscription upkeep, Granola sync, ClickUp sync (watched lists since the last sync less five minutes, then pending and failed pushes), and pending summaries. Each step runs on its own, so one failing does not stop the rest, and the run stops starting new steps after about 50 seconds. Mail sync only starts with at least 15 seconds left, and model calls, Graph, Granola and ClickUp requests are cut short so the run fits. It returns a JSON report of counts and errors per mailbox owner. CRM pages also sync in the background after they load.

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
