# Meta outcomes plan: lead stages to the Conversions API

Status: settled with Mark (2026-11-13). Mockups approved (`meta-conversions-mockups.html`). Revised after three Fable reviews against the code and Meta's docs. Nothing is built.

## What Mark asked for

Mark is scaling Meta lead ads. Orbit sends what happened to each lead back to Meta (Conversions API for CRM, "Conversion Leads"), so Meta optimises for leads that become business, not form fills.

## Decisions settled with Mark (2026-11-13)

1. **Stages, in order:** `Lead`, `Meeting booked`, `Proposal sent`, `Proposal signed`, `Won`. `Lost` sits outside the order.
2. **Each stage is sent once per lead**, with the time it happened. Reopening or resending a proposal doesn't repeat a stage.
3. **Company fallback:** a meeting, proposal or opportunity with someone else at the lead's company, or an opportunity there with no contact, counts for the lead. Only things created after the lead arrived count, for the lead's own contact too.
4. **Meeting booked counts when booked**, not when held.
5. **Lost only when an opportunity is marked lost.** A declined proposal sends nothing (declines are often re-proposed).
6. **Only what Meta needs leaves Orbit:** lead ID, stage, time, hashed email and phone, and value and currency on Won.
7. **The access token is an environment variable** (`META_DATASET_TOKEN`). The dataset ID and test code are set per workspace in Settings › Tools › Meta lead ads.

## What Orbit has today

- **Leads:** `crm.meta_leads` (`supabase/migrations/20270112900000_meta_lead_ads.sql:42`) holds `leadgen_id`, `workspace_id`, `contact_id`, `company_id`, `lead_created_at`, `filed_at`. Filing never creates an opportunity. Meta Pages link per workspace (`crm.meta_lead_pages`). Graph calls live in `lib/meta.ts` (`v27.0`, `META_ACCESS_TOKEN`).
- **Meetings:** `crm.calendar_events` (`20261020100000_calendar.sql:14`) has `contact_ids uuid[]`, `company_ids uuid[]`, `is_cancelled`, `created_at`, and is private to its owner. Bookings (`lib/booking/book.ts`) and Orbit invites (`lib/crm/invites.ts`) match guests to contacts by `normalized_email` and create contacts when missing. Meetings made in Outlook link when they sync. Linking only matches contacts in the calendar's own workspace (`lib/crm/calendar.ts:547`), and only for calendars used for the CRM. `created_at` is when Orbit first synced the event. Sync writes no audit events.
- **Proposals:** `crm.documents` with `kind = 'proposal'` (NDAs share the table), `contact_id` and `company_id` required, `opportunity_id` optional. Status `draft`, `sent`, `viewed`, `client_signed`, `completed`, `declined`, `withdrawn`, with `sent_at`, `client_signed_at`, `completed_at`. A sent, viewed, declined or withdrawn proposal can go back to draft and be resent (`lib/proposals/documents.ts:589`), which overwrites `sent_at` (`:703`). Sending can create or move an opportunity (`:682`). Audit events `document.sent`, `document.signed`, `document.completed`.
- **Opportunities:** `crm.opportunities` has `company_id` (required), `primary_contact_id` (optional), `status` (`open`, `won`, `lost`), `value`, `currency`, and stages in pipelines of kind `sales` or `board`. `opportunity.stage_changed` records before and after stage and status (`lib/crm/opportunities.ts:533`). There is no won or lost timestamp column; the audit event's `created_at` is the time.
- **Merges:** the contact merge (`private.merge_*` in `20270111400000_review_batch_3.sql`) archives the merged contact and moves tasks, activities, documents, opportunities and calendar events, but not `crm.meta_leads.contact_id`. Company merges don't move `crm.meta_leads.company_id` either.

## The model

New table `crm.meta_lead_outcomes`: one row per lead and stage.

- `id` (also sent as `event_id`, so Meta drops duplicates), `workspace_id` (the lead's workspace, which owns the dataset), `lead_id` (→ `crm.meta_leads`, cascade), `stage` (check in the six names), `position` (funnel order), `occurred_at`, `value`, `currency`, `source_type`, `source_id`, `status` (`pending`, `sent`, `skipped`, `failed`; `pending` with `attempts > 0` is retrying, `failed` is final), `attempts`, `next_attempt_at`, `claimed_until`, `sent_at`, `test` (sent with a test code), `error`, `created_at`.
- Unique `(lead_id, stage)`.
- RLS forced. `authenticated` may select only `workspace_id`, `lead_id`, `stage`, `position`, `occurred_at`, `status`, `attempts`, `sent_at`, `value` and `currency`, for workspaces they belong to. `source_type`, `source_id` and `error` are read by `crm_app` only; admins see errors through `last_error` on the settings row. Writes only through `private.*` functions granted to `crm_app`.
- After a contact moves workspace, its trail shows to people who are members of the lead's workspace (Mark is in both).
- `skipped` means too old for Meta when first due. It shows as not sent, never as "Retrying", and doesn't count towards alerts.

`crm.meta_outcome_settings`, one row per workspace: `dataset_id`, `test_code`, `enabled`, `last_error`, `last_error_at`, `alerted_at`. Owners and admins write, members read.

Additions elsewhere:

- `crm.calendar_events.provider_created_at`: Graph's `createdDateTime` (add to `EVENT_FIELDS`, `lib/microsoft/calendar.ts:49`, and to the upsert at `lib/crm/calendar.ts:266` as `coalesce(excluded.provider_created_at, crm.calendar_events.provider_created_at)`), `now()` in `saveCreatedEvent` for bookings and Orbit invites (`lib/crm/invites.ts:459`), and `CREATED` from calendar links (`readFeed`, `lib/ical/events.ts:152`). Today `created_at` is when an event first entered the 30 day sync window. Events with no `provider_created_at` never count as booked.
- `crm.meta_leads.email_hash`, `phone_hash` and `outcomes_checked_at`. The hashes are SHA-256 computed in Node at filing from what `leadPerson` picks (`lib/crm/meta-leads.ts:280`), email trimmed and lower-cased, phone through `normalizePhone` (`lib/phone.ts`) without the `+`, filled for older leads by the runner when it first meets them. The filing update grant (`20270112900000_meta_lead_ads.sql:142`) gains the two columns.
- `private.meta_lead_same_workspace` (`20270112900000_meta_lead_ads.sql:159`) is redefined (keeping `security definer` and its revoke) to skip its check while `orbit.merging` is on, so merges and moves can repoint a lead.
- `crm.opportunities.status_changed_at`: set by a trigger whenever `status` changes (including on insert as won or lost), backfilled from the latest `opportunity.stage_changed` event that set it, else `updated_at`, with `lock_timeout`.

## Working out stages

`private.meta_lead_outcomes_due(p_limit, p_contact, p_company, p_emails)`, a security-definer function, finds stages each lead has reached but not recorded, for workspaces with outcomes on. It reads across users because meetings are private, and returns only ids and times. Given a contact, company or emails it doesn't filter by workspace, so a booking or a moved record in the other workspace finds its lead at once.

- **The lead:** every filed lead (`filed_at` not null) in a workspace with outcomes on. Its contact and company may live in another workspace after a move (see Merges and moves).
- **Lead time:** `coalesce(lead_created_at, filed_at)` decides what counts as after the lead. The Lead stage itself is timed at `filed_at`, when Orbit recorded it.
- **Related:** the lead's contact, or anyone at the lead's company, and created at or after the lead time.

| Stage | Reached when | `occurred_at` |
|---|---|---|
| Lead | the lead is filed | `filed_at` |
| Meeting booked | a calendar event, not cancelled, on a calendar used for the CRM or created by Orbit (the same rule as `linkEvents`, `lib/crm/calendar.ts:526`), booked (`provider_created_at`) and starting after the lead time, where an attendee or the organiser has the email of the lead's contact or of a contact at the lead's company, on the calendar of a member of the lead's workspace. Emails compare on `lower(btrim(email))`, so it works whichever workspace the calendar belongs to. The function returns candidate events with their emails and owner; Node drops own and internal addresses with the existing `ownAddresses` and `internalAddresses` (`lib/crm/calendar.ts:511`, `lib/crm/conversations.ts:530`). | `provider_created_at` |
| Proposal sent | a related proposal (`kind = 'proposal'`) with `sent_at` | earliest `sent_at` |
| Proposal signed | a related proposal with `client_signed_at` or `completed_at` | earliest of those |
| Won | a related, unarchived opportunity in a `sales` pipeline (or no pipeline) with `status = 'won'` | the earliest won `status_changed_at`; that opportunity gives the value |
| Lost | related unarchived sales opportunities exist, all `lost`, none open or won | latest `status_changed_at` |

- **No gaps, settled at claim time.** Meta says every earlier stage must be sent before a later one. Positions: Lead 1, Meeting booked 2, Proposal sent 3, Proposal signed 4, Won 5, Lost 6, and Lost's only earlier stage is Lead.
  - Missing earlier stages are recorded when a later one is found.
  - When claiming, an unsent earlier stage (pending, `skipped` or `failed`) older than 6.5 days takes the time of the lead's earliest fresh unsent later stage, and goes back to pending. It stays `skipped` or `failed` only when there is no fresh later stage.
  - A later stage never sends while an earlier one is unsent. One batch may carry several stages of the same lead, in order.
  - Meta says not to backfill past 7 days, so this only ever uses a current time.
- **Won after Lost:** if Lost was sent and a related opportunity is later won, the missing stages and Won are still sent.
- `private.meta_lead_outcomes_record(...)` inserts with `on conflict (lead_id, stage) do update` only where the row is `skipped` or `failed`.
- The cron scan covers leads filed in the last 90 days (targeted passes have no window), ordered by `outcomes_checked_at` (never checked first) and stamps it, so every lead gets its turn.

## Sending

`lib/crm/meta-outcomes.ts`:

- `runMetaOutcomes({ deadline, fetchImpl, contactId?, companyId?, emails? })` records due stages, claims pending rows (`for update skip locked`, a 2 minute `claimed_until` lease), and sends them per workspace in funnel order. A lead's rows are claimed together, so two runners can't send out of order.
- **Stale events never reach Meta.** One event older than 7 days makes Meta reject the whole request, so rows older than 6.5 days are marked `skipped` before a batch is built.
- **Batches:** up to 100 events.
  - Errors are classified as `graphFailure` does in `lib/meta.ts:150`. Only code 100 without subcode 33 is an event error: split down to single events while the deadline allows, mark the bad one `failed` with Meta's message, and leave unfinished rows pending. Its lead's later stages wait.
  - Everything else (100/33 unreachable dataset, token, permission, rate limits, 5xx) is a workspace failure: rows stay pending, the workspace backs off and `last_error` is set. If a split ends with every single event rejected, that is a workspace failure too.
- **Payload,** to `POST https://graph.facebook.com/{version}/{dataset_id}/events`, with `access_token = META_DATASET_TOKEN` and the version from `metaGraphVersion()` in `lib/meta.ts` (exported for this):

  ```json
  {
    "event_name": "Meeting booked",
    "event_time": 1731500000,
    "event_id": "<outcome row id>",
    "action_source": "system_generated",
    "user_data": { "lead_id": 1234567890123456, "em": ["<sha256>"], "ph": ["<sha256>"] },
    "custom_data": { "event_source": "crm", "lead_event_source": "Orbit", "value": 8500, "currency": "GBP" }
  }
  ```

  - `lead_id` is an integer in Meta's docs. It's too long for a JavaScript number, so the body writes the digits in as a raw numeric token. A test event proves this before the rest is built.
  - `test_event_code` is added while the workspace has a test code.
  - `value` and `currency` go only on Won, and only when the opportunity has a value.
- The URL is built with `graphOrigin()` (`lib/meta.ts:76`), exported with `metaGraphVersion()`.
- **Won and Lost wait 5 minutes** after the change and are rechecked, so an undo (`lib/crm/undo.ts`) sends nothing.
- **Hashes:** `em` and `ph` come from `crm.meta_leads.email_hash` and `phone_hash`. Plain values never leave Orbit.
- **Failures:**
  - Retries back off from 5 minutes, doubling, up to 6 hours.
  - A row still pending when it turns 6.5 days old becomes `failed`, unless a later stage re-times it (see No gaps).
  - After 24 hours of failures, owners get one notification (`source = 'meta_outcomes'`) and the card shows `last_error`.
- **Test mode:** rows sent while a test code is saved stay `sent` and are marked `test`. Meta counts test events as real and keeps only the first copy of an `event_id`, so they're never resent.
- **When it runs:**
  - `/api/cron/sync` runs outcomes first, until `min(now + 8 s, received + 50 s)`, then gives the sync `50 s − elapsed − the lead backup reserve` (`lib/crm/scheduler.ts:26-29`, `:330`). It runs only when `META_DATASET_TOKEN` is set and a workspace has outcomes on. Each fetch has a 5 second timeout.
  - `afterCommit` (`lib/crm/after-commit.ts`) runs a targeted pass for that contact, company or guest emails once any of these commits: `document.sent`, `document.signed`, `document.completed`, `opportunity.stage_changed`, `opportunity.created` (when it's won or lost), a booking, an Orbit invite, or a lead being filed. It's skipped only when no workspace has outcomes on.
- **Saving the dataset ID, and switching on,** read `GET /{dataset_id}?fields=id` with the token, so a dataset the token can't reach is caught then.
- Tests fake Meta with `fetchImpl`.

## Merges and moves

- **Merges:** redefine `private.merge_contact_references` and `private.merge_company_references` from their latest definitions (`20270111400000_review_batch_3.sql:1`, `:170`) so they also repoint `crm.meta_leads.contact_id` and `company_id` with a direct update (`merge_move` filters by workspace, which misses a moved contact's lead).
- **Moves to another workspace:** redefine `private.move_records_to_workspace` from its latest definition (`20270111300000_review_batch_2_crm.sql:409`) so `crm.meta_leads.contact_id` and `company_id` follow records merged into an existing one. Plain moves keep ids and copies change nothing.
- **The lead stays in its Page's workspace,** so its stages still go to that workspace's dataset, which is the one connected to the Page.

## Interface (as the approved mockups)

- **Settings › Tools › Meta lead ads** (`components/crm/meta-leads-settings.tsx`): a "Send outcomes to Meta" block under Pages with a switch, Dataset ID, Test code (placeholder "Optional"), a status line ("Token set · 14 sent · Last 13 Nov, 10:02", or "Add META_DATASET_TOKEN to the environment.") and the stage names ("Use these names in Events Manager."). Owners and admins only change it. The switch stays off until the dataset ID and token are set.
- **A lead's contact:** under the existing "Meta lead: …" activity (found through its `metadata.metaLeadId`, which members can read; `crm.meta_leads` itself is admin-only), a "Sent to Meta" trail of the five stages (Lost replaces the grey ones), with dates, grey for not reached and "Retrying" for pending rows with attempts. Final failures and skipped stages show grey.

## Out of scope

- Pushing anything other than lead ad leads (website leads, offline conversions).
- Editing stage names. They are fixed so Events Manager stays in step.

## Phases

1. One test event to Meta by hand, to confirm `lead_id` as a number and the Graph version.
2. Migration (two tables, five new columns on three tables, functions, the trigger, merge and move fixes), an audit event for settings changes, README environment variables, `lib/crm/meta-outcomes.ts`, cron and `afterCommit` hooks, tests: stale filtering, gap backfill order, two runners at once, a 400 split, merge and move, held then released leads, an opportunity created as won, a booking in the other workspace, the member trail under RLS, more leads than the scan limit, merge after move, Lost and Won after Lost, a proposal resent, a cancelled meeting and one booked before the lead, internal and own addresses ignored, a token error leaving rows pending, the exact digits of a 17 digit `lead_id` in the body, permanent failure at 6.5 days with one alert, outcomes off recording nothing, the cron budget, an Orbit-created event, an unreachable dataset (100/33), and an undo within 5 minutes.
3. Settings block and contact trail, sweep at phone and tablet sizes.

## Setup for Mark after merging

1. Events Manager: create or choose a dataset and connect it to the Ridgeon Consultancy Page. The stage names appear in Events Manager once events arrive; then set up the funnel (Conversion Leads) in this order and leave Lost out of it, as Meta advises for negative stages.
2. Generate the dataset access token and add `META_DATASET_TOKEN` in Vercel.
3. Enter the dataset ID and a test code in Settings › Tools, switch on, check Test events, then clear the test code. Test events count as real, so test with a real lead.
