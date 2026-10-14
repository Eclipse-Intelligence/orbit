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

Active companies in a workspace are unique by canonical domain. When neither has a domain, a company also matches another company with the same normalised name. Create and update follow exactly that rule, so creating "Mercury" with `mercury.com` succeeds even when a "Mercury" without a domain exists. Upsert is the one exception: an upsert with a domain that matches no company falls back to a company with the same normalised name and no domain, and attaches the domain to it. The same display name with two different domains stays two companies. Writes take a workspace advisory lock, then unique indexes stop a race.

Name normalisation lowercases, strips accents, keeps letters and digits in any script plus `+` and `#`, and drops a trailing legal suffix such as Inc or GmbH. When an upsert or create gives a website but no domain, the domain comes from the website host, unless that host is a shared one such as LinkedIn, Facebook, Instagram, X, GitHub, Medium, Google Sites, Notion, Wix, Squarespace, or YouTube.

`PATCH` and upsert leave omitted fields alone. An explicit `null` clears an optional field. A domain-only upsert does not replace an existing name. A company or contact write whose values all equal the stored ones changes nothing: no audit event, no webhook, and `updated_at` stays put.

`Idempotency-Key` is stored per workspace and actor. The same key and body replays the stored response. The same key and a different body returns 409.

Deletes archive. `archived_at` is set and the row stays. There is no hard delete on the API.

## Audit

`crm.audit_events` is append-only. A trigger rejects updates and deletes, and those grants are not given out. Mutations write an event with the actor type (`user` or `agent`), agent id, credential id, source, and source URL when the caller provides them. Each event also queues a delivery for every enabled webhook subscribed to that event type. Delivery signs the body with HMAC SHA-256 and retries a failed attempt for about three hours.

## People, opportunities, activity, and tasks

Contacts match an active email, then an active LinkedIn profile, then the same normalised name at the same company. Opportunities use the workspace default pipeline. Omitting the stage picks the first stage. A won or lost stage sets the status, and setting the status to won or lost moves the opportunity to that stage. `opportunity.stage_changed` is written when the stage or status changes.

Activities are append-only: `authenticated` and `crm_agent` can insert them but not update them. A company timeline reads activities stored against that company. Tasks live in `crm.tasks`; the Tasks page (`/tasks`, which `/actions` redirects to) opens on All, every open task with overdue first and undated last. Completing a task sets `completed_at` and leaves that timestamp in place if it is completed again.

`POST /api/v1/leads` and the `add_lead` tool run company, contact, activity, opportunity, and task writes in one transaction, through the same functions the individual endpoints use. A second lead with the same domain and email updates those rows instead of creating new ones.

Company, contact, opportunity, and task references must belong to the same workspace. That check is a trigger, so a foreign id cannot be attached even when the caller's row-level policy would otherwise hide it. It checks a reference only when that reference, the row's company, or its workspace changes, so moving a contact to another company leaves its existing tasks and opportunities editable.

## Conversations

`record_email` and `record_meeting` file an interaction on a contact matched by email, or on a company matched by the email's domain. When that company has no open task, the CRM adds a follow-up due in two days.

The inbox connects one Microsoft mailbox per user. `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` come from an Entra app with delegated `Mail.Read`, `Mail.Send`, `User.Read`, `Calendars.Read`, and `offline_access`. The refresh token is encrypted with `APP_SECRET`. Opening the inbox, or choosing Sync, reads messages received since the last sync (the first sync looks back 14 days, up to 100 messages). From a contact, Send email delivers through that mailbox and files the message on the contact. A mailbox connected before Mail.Send was granted has to be disconnected and connected again. A message attaches to a contact by email address, otherwise to a company by domain. The mailbox's own address is not the contact. A match from the last 48 hours files an email activity and, when the company has no open task, suggests a follow-up. Mail that matches neither stays in the inbox as not attached. Gmail is not connected. The Outlook calendar is described below.

Teams phone calls come from Graph `getPstnCalls`, which only accepts an app-only token, so Orbit uses the client-credentials flow with the same Entra app and the `CallRecords.Read.All` application permission. The tenant is `MICROSOFT_TENANT` when it names one, otherwise the `tid` claim of the connected mailbox's access token, cached on the sync state. Only rows whose user principal name is the mailbox address (or whose user id is the mailbox user) and whose type is `user_in` or `user_out` count. `crm.call_records` stores one row per call log id per workspace: direction, the other party's number in E.164, start time, duration, and the contact, company, and activity it was filed on. A row with no matching contact phone keeps those empty and is filed on a later sync. `crm.call_sync_state` keeps one row per mailbox connection with the tenant id, the last synced and attempted times, and the last error. Both tables are readable and writable only by the mailbox owner. The CRM layout runs a sync after the response through `after()`, claiming the attempt so Graph is called at most once every five minutes; Sync calls in Inbox forces one. Each sync re-reads from 24 hours before the last sync, and syncs for a connection run one at a time under an advisory lock.

`crm.call_insights` holds at most one summary per call or meeting activity, since activities are append-only and never updated. It stores the workspace, the activity, the contact and company copied from it, the source (`manual` for a pasted transcript, `teams` for a Teams transcript, `granola` for a Granola meeting), the transcript as compact `Speaker: line` text (up to 200,000 characters), the summary, key points, suggested action items, the model, a status (`pending`, `ready`, or `failed`), and the last error. Each action item is `{id, title, owner, dueDate, status, taskId}`: owner is `me`, `them`, or null, the due date is a London calendar day, and accepting one creates a task through the normal task path and records its id. Workspace members and agents can read and insert rows in their workspace, and can update only the summary, key points, action items, model, status, and error; the transcript, links, and source never change. Summarising needs `activities:write` and accepting an action needs `tasks:write`. The model call (`lib/llm.ts`) runs outside the database transaction against `LLM_API_BASE_URL` with `LLM_API_KEY`, times out after 25 seconds, and retries once on a gateway 5xx, a network failure, or a reply that is not the expected JSON. Company context and the contacts page load the summaries for every call they show in one query, without the transcript, which is fetched only when Transcript is opened.

### Automatic transcripts

Transcripts arrive from Granola (`lib/granola.ts`, `lib/crm/granola.ts`) and Teams (`lib/microsoft/transcripts.ts`, `lib/crm/teams-transcripts.ts`). Both go through `lib/crm/conversations.ts`, which records the import, matches people, creates the activity through `createActivityInDb`, and summarises through `summariseCall` outside the import transaction.

| Table | What it holds |
| --- | --- |
| `crm.conversation_imports` | One row per imported transcript. Granola rows are unique per workspace and note id and visible to every member. Teams rows are unique per mailbox owner and transcript id and visible, fileable, and updatable only by that owner (`user_id = private.session_user_id()`). `source` is `granola` or `teams`, `kind` is `meeting` or `call`. Keeps the title, start and end times, participants (`[{name, email}]`), the external link, the transcript as `Speaker: line` text, Granola's own summary, the Teams `call_id`, the status (`pending`, `filed`, `unfiled`, `ignored`), the filed activity, contact and company, the last error, and attempts. Members can insert and update only the import columns, never the workspace, source, or ids. |
| `crm.integration_state` | Granola: one row per workspace, with the member it runs as, the webhook id, and its signing secret (encrypted with `APP_SECRET`). Teams transcripts and the Outlook calendar: one row per mailbox connection and source (unique on `connection_id, source`), readable only by its owner; transcripts keep the Graph subscription id (unique), expiry, and `clientState` (encrypted), and the calendar keeps `scope_missing`. All keep last synced and attempted times and the last error. |
| `crm.webhook_receipts` | Granola delivery ids seen in the last ten minutes, unique per workspace, so a replayed delivery is acknowledged and ignored. |
| `crm.call_records.teams_call_id` | The `callId` from the PSTN call log, which equals a transcript's `callId`. Set on new rows and filled on existing rows the next time a sync sees them. |

Matching: a Granola note matches attendees and calendar invitees against contacts by email, then companies by domain, skipping free-mail domains, the note owner, every workspace member, and the owner's and members' own domains. A match files a `meeting` activity and the import as `filed`, otherwise `unfiled`. A Teams transcript is stored as `pending` and attaches to the activity of the call record with the same `teams_call_id`; this is retried on every transcript sync and every Teams call sync, and a transcript still pending after 48 hours becomes `unfiled`. Filing a Teams transcript from Inbox creates the call activity on the chosen contact and links the call record to it; a call record that arrives later for that call reuses the filed activity instead of logging a second call. A note or transcript that fails to import is stored as `pending` with its error and attempt count and retried on later syncs; after three attempts it becomes `unfiled`. Item failures do not hold back `last_synced_at`; only a failed listing or running out of time does. Summaries are retried at most three times for errors that leave no summary row, and a summary left `pending` for more than three minutes (a run that was cut off) is picked up again and shows Try again on the timeline.

Background work runs without a session. `private.background_members()` lists workspace members; each workspace acts as every member who owns a connected mailbox (or as its owner when none does), through the same `UserActor` and row-level security as a signed-in page. Public routes do the cheap check first: `private.granola_webhook_targets()` returns the stored Granola signing secrets in one query, the Standard Webhooks signature (HMAC SHA-256 over `id.timestamp.body`, timestamps within five minutes) is checked against them, and only then is the delivery id recorded and the note fetched in `after()`; a delivery with no note id runs the normal rate-limited sync. The Graph routes echo `validationToken` as `text/plain`, reject more than 50 notifications per request, resolve all subscription ids with one call to `private.transcript_subscriptions(ids)`, accept a notification only when its `clientState` matches, answer 202, and fetch the transcript in `after()`. Lifecycle events renew (`reauthorizationRequired`), recreate (`subscriptionRemoved`), or poll (`missed`). These security-definer functions are executable only by `crm_app`. `/api/cron/sync` checks `Authorization: Bearer <CRON_SECRET>` in constant time. Every background path carries a deadline about 50 seconds from the start of the request: the model call timeout shrinks to fit and skips its retry when time is short, Graph paging and Granola rate-limit backoff stop early, and no step starts without enough time left.

### Outlook calendar

`lib/microsoft/calendar.ts` reads Graph `GET /me/calendarView` for 30 days back to 60 days ahead with `$select` limited to the fields below, `$top=100`, and `Prefer: outlook.timezone="UTC"`, follows `@odata.nextLink` (only on graph.microsoft.com) for at most ten pages, and stops early when the request deadline is close. It does not use `calendarView/delta`, because a delta link keeps the window of its first request and does not accept `$select`, and the window here rolls forward. `lib/crm/calendar.ts` runs the sync: the CRM layout through `after()`, the `calendar` cron step, and Sync calendar in Inbox (forced), at most once every five minutes per connection, one at a time under an advisory lock.

| Table | What it holds |
| --- | --- |
| `crm.calendar_events` | One row per Graph event id per mailbox connection (`provider_event_id`, unique with `connection_id`): the owner, iCal uid, subject, start and end (UTC), all-day and cancelled flags, location, Outlook web link, join URL (`onlineMeeting.joinUrl`, falling back to `onlineMeetingUrl`), organizer (`{name, email}`), attendees (`[{name, email, response}]`, rooms left out), and the linked `contact_ids` and `company_ids` (GIN-indexed). Only the owning user can read, insert, update, or delete rows (`user_id = private.session_user_id()`); agents have no access. |
| `crm.hidden_attendees` | Addresses a user hid from People you've met, keyed by user, workspace, and email, visible only to that user. |

Every sync upserts the events it read. After a complete read it deletes the connection's events that Graph no longer returned (removed, moved out of the window, or older than it); a partial read only drops events that ended before the window. Cancelled meetings are kept with `is_cancelled` and hidden everywhere. Links are recomputed for all of the connection's events on every sync and after Create contact: an organizer or attendee who is not internal (the workspace members' addresses, their other addresses, and their non-free-mail domains, plus the mailbox address) links the active contact with that email and that contact's company, plus active companies with that domain unless it is a free-mail domain.

Missing permission: a connection made before `Calendars.Read` was added keeps working for mail. A token refresh never sends `scope`, so old connections keep refreshing. When the token response's `scope` lacks `Calendars.Read` (or `Calendars.ReadWrite`), or Graph answers 403 `ErrorAccessDenied`, the sync sets `scope_missing` and stops without an error; Inbox and the Meetings card then ask to reconnect. Reconnecting clears the flag and runs a forced sync after the redirect. Orbit does not decode Graph access tokens, since Microsoft documents them as opaque to clients.

Meetings card: up to five meetings that have not ended (the first shown as Next) and five that have, for the contact (`contact_ids`) or company (`company_ids`). A Granola `meeting` activity within two hours of the start, on the same contact (or, on a company page, on the company or one of the meeting's contacts), is linked as Notes in Granola. People you've met: outside organizers and attendees of the user's non-cancelled events, without an active contact or a hidden entry, grouped by address with their last and next meeting, people met most recently first, then upcoming-only people, at most 25. Create contact checks the address is in the user's calendar and goes through `createContactFromAttendee`, the same path Unfiled conversations uses.

### ClickUp

`lib/clickup.ts` is the API v2 client (personal token in `Authorization` without a scheme, `CLICKUP_API_TOKEN`, base `CLICKUP_API_BASE_URL`): user, workspaces, the space › folder › list hierarchy (cached five minutes per process), list statuses and custom fields, task create, update and get, the filtered workspace task search, custom field values, and webhooks. On 429 it waits until `X-RateLimit-Reset` (at most 15 seconds) only when the request deadline leaves room, otherwise it gives up for this run. `lib/crm/clickup.ts` holds the sync.

| Column | What it holds |
| --- | --- |
| `crm.tasks.clickup_task_id` | The linked ClickUp task, unique per workspace when set. |
| `crm.tasks.clickup_list_id` | The list the task lives in. Set without a task id, it means "create this task in ClickUp" and the sync keeps trying until it succeeds. |
| `crm.tasks.clickup_url`, `clickup_synced_at`, `clickup_error` | The ClickUp link, the last successful exchange, and the last error shown on the Orbit task. |
| `crm.tasks.clickup_sync` | The last values both sides agreed on (`title`, `dueAt`, `done`), ClickUp's `date_updated` at that point, when Orbit last wrote to ClickUp (`pushedAt`), and a short-lived claim while the task is being created (`creatingAt`). |
| `crm.integration_state` (`source = 'clickup'`) | One row per workspace: the member it runs as, the ClickUp workspace (`team_id`), the token owner's ClickUp user id, the default list, the watched lists, the last list used in a form, the list names for the pickers (`list_choices`), the webhook id, its secret (encrypted with `APP_SECRET`) and scope (`team`, `space:<id>`, or `list:<id>`), the last sync, and the last error. |
| `crm.webhook_receipts` (`source = 'clickup'`) | `webhook_id:history item ids` (or `webhook_id:event:task_id` for deletions) seen in the last day. |

Merging is three-way against `clickup_sync`. A field Orbit changed since the last agreement is sent to ClickUp; a field ClickUp changed is written to the Orbit task through `updateTaskInDb`, with the audit source `clickup`; when both changed, the later of the task's `updated_at` and ClickUp's `date_updated` wins. A ClickUp task whose `date_updated` is not newer than the stored one is skipped, so Orbit's own writes coming back through the poll or the webhook change nothing, and a webhook event dated within 15 seconds of Orbit's last write to that task is dropped without fetching it. Imported tasks are created with `createTaskInDb`; while an Orbit-created task is being sent (`creatingAt` within two minutes), a ClickUp task in the same list with the same title is not imported, so the webhook for Orbit's own create cannot make a copy. Due dates are London time: midnight means a date without a time (`due_date_time: false`); from ClickUp, `due_date_time: false`, or a time of exactly 00:00 or 04:00 London when the flag is missing, becomes midnight. Done means a status of type `done` or `closed`.

Each sync claims the row with a five-minute gap (the cron and Sync now force it), lists tasks in the watched lists and in lists that hold linked tasks, updated since the last complete sync less five minutes (14 days the first time), 100 a page, closed tasks and subtasks included, then sends up to 20 pending or changed tasks, then re-reads up to five linked open tasks not checked for six hours, archiving any whose ClickUp task is gone. Running out of time keeps `last_synced_at` where it was. `private.clickup_webhook_targets()` returns the stored webhook secrets for the public route; it is a security-definer function executable only by `crm_app`.

## Quiet relationships

A company is quiet when its latest activity is older than 21 days, or it has never had one. Company context also reports a relationship status: `new`, `active`, `quiet`, or `needs_action`.

## What is left for you

The hosted project is Orbit (`xuvofoydyewbloybrmas`) in `eu-west-1`. The app connects through the session pooler as `crm_app`, and webhook delivery uses `crm_admin`. Do not run `supabase/bootstrap/local-auth.sql` there. The Microsoft inbox starts once the Entra app credentials are in the environment. Automatic transcripts need `GRANOLA_API_KEY`, `CallTranscripts.Read.All`, `SITE_URL`, `CRON_SECRET`, and the Supabase `pg_cron` job in the README. ClickUp needs `CLICKUP_API_TOKEN`, the migration `20261018100000_clickup.sql`, and the lists chosen in Settings. Gmail and calendar sync are still separate.
