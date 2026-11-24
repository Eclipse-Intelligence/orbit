# Meta outcomes plan: lead stages to the Conversions API

Status: settled with Mark (2026-11-13), and changed on 2026-11-24 so the opportunity pipeline drives the stages. Mockups approved (`meta-conversions-mockups.html`). The Meta side is set up and a hand-sent test was accepted (see Payload). Nothing is built.

## What Mark asked for

Mark is scaling Meta lead ads. Orbit sends what happened to each Meta lead back to Meta (Conversions API for CRM, "Conversion Leads"), so Meta can report which ads produce proposals and wins, and later optimise for leads that become business, not form fills.

## Decisions settled with Mark

1. **The opportunity pipeline is the funnel** (2026-11-24). The workflow "Meta lead: email, enrich and call" puts every Meta lead's company into Opportunities at New, and sending a proposal moves the opportunity to Proposal. Each stage of the sales pipeline is sent to Meta the first time a lead's opportunity reaches it. Today that's `Lead` (sent when the lead is filed), `Working`, `Proposal` and `Won`.
2. **Lost is never sent** (2026-11-24). Meta advises leaving negative stages out of the funnel, so it adds nothing.
3. **Only Meta lead ad leads are sent.** Everything starts from `crm.meta_leads`; referrals, bookings, website enquiries and hand-made opportunities without a Meta lead are never sent.
4. **Each stage is sent once per lead**, the first time it's reached, with the time it happened. Moving an opportunity back sends nothing and unsends nothing.
5. **Company fallback:** an opportunity at the lead's company counts for the lead whether its contact is the lead, someone else or nobody, but only opportunities created at or after the lead arrived.
6. **Only what Meta needs leaves Orbit:** lead ID, stage, time, hashed email and phone, and value and currency on Won.
7. **The access token is an environment variable** (`META_DATASET_TOKEN`, set in Vercel as Sensitive). The dataset ID is set per workspace in Settings › Tools › Meta lead ads.

## Production facts (checked 2026-11-24)

- **Workspace:** the Ridgeon Consultancy Page (300694049784966) is linked to workspace `92818d54-202f-4b97-adfd-bb7cd2bb8918`.
- **Pipeline:** `Default` (kind `sales`, `cd6e057b-be0f-4f42-af28-96f91c78a17a`): New (0), Working (1), Proposal (2), Won (3, `is_won`), Lost (4, `is_lost`).
- **Workflow:** "Meta lead: email, enrich and call" (`e645bf2e…`, active, trigger `record_created` on contact) has a board step "Add to Opportunities, New" into that pipeline, added on about 2026-11-22. Earlier leads' opportunities were made by hand, by the assistant or by sending a proposal (`operation = proposal_stage`).
- **Leads:** 7 real leads and Meta's verification lead 2597163074137865 (its contact archived 2026-11-11).
- **Meta:** dataset 1608701054328072 (Ridgeon, in the Ridgeon Consultancy business portfolio, also the ridgeon.me pixel). CRM setup started. Graph `v27.0` works.

## What Orbit has today

- **Leads:** `crm.meta_leads` holds `leadgen_id`, `workspace_id`, `contact_id`, `company_id`, `lead_created_at`, `filed_at`. `crm.meta_leads` is readable by admins only (`meta_leads_admin_read`). Filing runs as `authenticated`; its update grant is limited to the filing columns. Graph calls live in `lib/meta.ts` (`metaGraphVersion()`, `graphOrigin()`, `graphFailure`).
- **Opportunities:** `crm.opportunities` has `company_id` (required), `primary_contact_id` (optional), `pipeline_id`, `stage_id`, `status` (`open`, `won`, `lost`), `value`, `currency`, `archived_at`, `created_at`. Stages live in `crm.pipeline_stages` (`position`, `is_won`, `is_lost`), pipelines have `kind` `sales` or `board`. Stage moves come from the board, the opportunity page, the assistant, MCP and the API, workflows (board step), proposals (`lib/proposals/documents.ts`, sending creates or moves an opportunity), bulk changes and undo (`lib/crm/undo.ts`). Stage history today is read back from audit events (`lib/crm/pipeline-history.ts`); there is no stage history table.
- **Merges and moves:** contact and company merges and moves between workspaces don't touch `crm.meta_leads`, and the trigger `private.meta_lead_same_workspace` rejects pointing a lead at a record in another workspace.

## The model

**`crm.opportunity_stage_entries`**: one row each time an opportunity enters a stage, written by a trigger on `crm.opportunities` (insert, and update when `stage_id` changes), so every path that moves an opportunity is covered without touching callers.

- `id`, `workspace_id`, `opportunity_id` (cascade), `pipeline_id`, `stage_id`, `entered_at` (default `now()`).
- Backfilled once from audit events (`opportunity.created` and `opportunity.stage_changed`, using the stage recorded in each), falling back to the opportunity's `created_at` and current stage.
- RLS forced, members of the workspace read, writes only by the trigger (security definer).

**`crm.meta_lead_outcomes`**: one row per lead and stage.

- `id` (also sent as `event_id`), `workspace_id` (the lead's workspace, which owns the dataset), `lead_id` (→ `crm.meta_leads`, cascade), `stage_name` (what Meta sees), `stage_id` (null for `Lead`), `position` (0 for `Lead`, then the stage's position + 1), `occurred_at`, `value`, `currency`, `opportunity_id`, `status` (`pending`, `sent`, `skipped`, `failed`; `pending` with `attempts > 0` is retrying, `failed` is final), `attempts`, `next_attempt_at`, `claimed_until`, `sent_at`, `error`, `created_at`.
- Unique `(lead_id, stage_name)`.
- RLS forced. `authenticated` may select `workspace_id`, `lead_id`, `stage_name`, `position`, `occurred_at`, `status`, `attempts`, `sent_at`, `value` and `currency` for their workspaces. `opportunity_id` and `error` are read by `crm_app` only; admins see errors through `last_error` on the settings row. Writes only through `private.*` functions granted to `crm_app`.

**`crm.meta_outcome_settings`**, one row per workspace: `dataset_id`, `pipeline_id` (the sales pipeline that drives the funnel; defaults to the workspace's only sales pipeline, chosen in Settings only when there's more than one), `enabled`, `last_error`, `last_error_at`, `alerted_at`. Owners and admins write, members read.

**Additions elsewhere:**

- `crm.meta_leads.email_hash`, `phone_hash` and `outcomes_checked_at`. The hashes are SHA-256 computed in Node at filing from what `leadPerson` picks (`lib/crm/meta-leads.ts`), email trimmed and lower-cased, phone through `normalizePhone` (`lib/phone.ts`) without the `+`, filled for older leads by the runner when it first meets them. The filing update grant gains the two hash columns.
- `private.meta_lead_same_workspace` is redefined (keeping `security definer` and its revoke) to skip its check while `orbit.merging` is on.

## Working out stages

`private.meta_lead_outcomes_due(p_limit, p_contact, p_company)`, a security-definer function, returns stages each lead has reached but not recorded, for workspaces with outcomes on. Given a contact or company it doesn't filter by workspace, so a moved record still finds its lead.

- **The lead:** every filed lead (`filed_at` not null) in a workspace with outcomes on.
- **Lead time:** `coalesce(lead_created_at, filed_at)`.
- **Its opportunities:** unarchived opportunities in the settings' pipeline whose `primary_contact_id` is the lead's contact or whose `company_id` is the lead's company, created at or after the lead time.
- **`Lead`:** reached when the lead is filed, timed at `filed_at`.
- **Every other stage** of the pipeline, except stages marked `is_lost`: reached the first time any of the lead's opportunities entered it (`crm.opportunity_stage_entries`), timed at that `entered_at`. The stage's current name is what Meta sees.
- **Won** (`is_won`): carries `value` and `currency` from the opportunity that reached it first, when it has a value.
- **Settle time:** a pipeline stage is only due 5 minutes after it was entered, and only if that opportunity is still in that stage or has moved further on. A drag made by mistake and undone, or moved straight back, sends nothing.
- **No gaps.** Meta says every earlier stage must be sent before a later one. When a later stage is due, earlier pipeline stages the lead never reached are recorded with the same time, and sent first, in position order.
  - When claiming, an unsent earlier stage (pending, `skipped` or `failed`) older than 6.5 days takes the time of the lead's earliest fresh unsent later stage and goes back to pending. It stays `skipped` or `failed` only when there's no fresh later stage.
  - A later stage never sends while an earlier one is unsent. One batch may carry several stages of the same lead, in order.
- `private.meta_lead_outcomes_record(...)` inserts with `on conflict (lead_id, stage_name) do update` only where the row is `skipped` or `failed`.
- The cron scan covers leads filed in the last 90 days (targeted passes have no window), ordered by `outcomes_checked_at` (never checked first), and stamps it.
- Renaming a pipeline stage changes the name sent from then on; stages already sent keep their old name. Settings says so beside the stage list.

## Sending

`lib/crm/meta-outcomes.ts`:

- `runMetaOutcomes({ deadline, fetchImpl, contactId?, companyId? })` records due stages, claims pending rows (`for update skip locked`, a 2 minute `claimed_until` lease, a lead's rows claimed together), and sends them per workspace in position order.
- **Stale events never reach Meta.** One event older than 7 days makes Meta reject the whole request, so rows older than 6.5 days are marked `skipped` before a batch is built.
- **Batches:** up to 100 events.
  - Errors are classified as `graphFailure` does in `lib/meta.ts`. Only code 100 without subcode 33 is an event error: split down to single events while the deadline allows, mark the bad one `failed` with Meta's message, and leave unfinished rows pending. Its lead's later stages wait.
  - Everything else (100/33 unreachable dataset, token, permission, rate limits, 5xx) is a workspace failure: rows stay pending, the workspace backs off and `last_error` is set. If a split ends with every single event rejected, that's a workspace failure too.
- **Payload,** to `POST {graphOrigin()}/{metaGraphVersion()}/{dataset_id}/events` with `access_token = META_DATASET_TOKEN` (export both helpers from `lib/meta.ts`):

  ```json
  {
    "event_name": "Proposal",
    "event_time": 1795500000,
    "event_id": "<outcome row id>",
    "action_source": "system_generated",
    "user_data": { "lead_id": 1234567890123456, "em": ["<sha256>"], "ph": ["<sha256>"] },
    "custom_data": { "event_source": "crm", "lead_event_source": "Orbit", "value": 8500, "currency": "GBP" }
  }
  ```

  - `lead_id` is written into the body as a raw number (too long for a JavaScript number). Confirmed 2026-11-24: Meta accepted `Lead` and `Meeting booked` for verification lead 2597163074137865 this way, on `v27.0` and dataset 1608701054328072 (`events_received: 1`, no messages, shown as Processed with event source `crm`, lead event source `Orbit`, matched on email and lead_id).
  - `value` and `currency` go only on the won stage, and only when the opportunity has a value.
- **Hashes:** `em` and `ph` come from `crm.meta_leads.email_hash` and `phone_hash`. Plain values never leave Orbit. Omitted when empty.
- **Failures:**
  - Retries back off from 5 minutes, doubling, up to 6 hours.
  - A row still pending when it turns 6.5 days old becomes `failed`, unless a later stage re-times it.
  - After 24 hours of failures, owners get one notification (`source = 'meta_outcomes'`) and the card shows `last_error`.
- **When it runs:**
  - `/api/cron/sync` runs outcomes first, until `min(now + 8 s, received + 50 s)`, then gives the sync the rest of its budget (`lib/crm/scheduler.ts`). Only when `META_DATASET_TOKEN` is set and a workspace has outcomes on. Each fetch has a 5 second timeout.
  - The 5 minute settle time means most stages go out on the next cron after it, so there are no `afterCommit` hooks for stage moves. Filing a lead runs a targeted pass for that lead straight away, so `Lead` goes within seconds.
- **Saving the dataset ID, and switching on,** read `GET /{dataset_id}?fields=id` with the token, so a dataset the token can't reach is caught then.
- **Testing:** Meta's CRM test flow uses its verification lead (Test events tab), not a test code. That lead arrives through the normal webhook like any other, so there's no test mode in Orbit.
- Tests fake Meta with `fetchImpl`.

## Merges and moves

- **Merges:** redefine `private.merge_contact_references` and `private.merge_company_references` from their latest definitions (find them with `grep -l "function private.merge_contact_references" supabase/migrations/*.sql | tail -1`, same for companies) so they also repoint `crm.meta_leads.contact_id` and `company_id` with a direct update.
- **Moves to another workspace:** redefine `private.move_records_to_workspace` from its latest definition so `crm.meta_leads.contact_id` and `company_id` follow records merged into an existing one. Plain moves keep ids and copies change nothing.
- **The lead stays in its Page's workspace,** so its stages still go to that workspace's dataset. Opportunities are matched by contact or company id, so a moved opportunity still counts; its pipeline must be the settings' pipeline of the lead's workspace, so in practice a move stops further stages.

## Interface (as the approved mockups, with the pipeline's stages)

- **Settings › Tools › Meta lead ads** (`components/crm/meta-leads-settings.tsx`): a "Send outcomes to Meta" block under Pages with a switch, Dataset ID, a Pipeline select only when the workspace has more than one sales pipeline, a status line ("Token set · 14 sent · Last 13 Nov, 10:02", or "Add META_DATASET_TOKEN to the environment.") and the stages Meta sees (`Lead`, then the pipeline's stages without the first and without lost stages), with "Use these names in Events Manager. Renaming a stage changes the name sent." Owners and admins only change it. The switch stays off until the dataset ID and token are set. Settings changes record an audit event.
- **A lead's contact:** under the existing "Meta lead: …" activity (found through its `metadata.metaLeadId`; `crm.meta_leads` itself is admin-only), a "Sent to Meta" trail of the stages, with dates, grey for not reached and "Retrying" for pending rows with attempts. Final failures and skipped stages show grey.

## Out of scope

- Pushing anything other than lead ad leads.
- Moving opportunities automatically when a meeting is booked (Working stays manual).

## Phases

1. Done 2026-11-24: Meta set up and test events accepted.
2. One PR: migration (three tables, three columns on `crm.meta_leads`, the stage entry trigger and backfill, functions, the trigger fix, merge and move fixes), `lib/crm/meta-outcomes.ts`, the cron slice, the filing pass, settings and the contact trail, README environment variables, tests. Tests: every stage-moving path writes a stage entry (board move, workflow board step, proposal send, bulk, undo, create in a later stage); first reach only; moved back within 5 minutes sends nothing; gaps filled in order; Lost never sent; Won carries value; company fallback and the created-after rule; opportunities in another pipeline ignored; non-Meta opportunities never sent; stale filtering and re-timing; two runners at once; the code 100 split and a 100/33 workspace failure; a token error leaving rows pending; the exact digits of a 17 digit `lead_id` in the body; permanent failure at 6.5 days with one alert; outcomes off recording nothing; the cron budget; merge, move and merge after move; the member trail under RLS; settings only by owners and admins.
3. Production: apply the migration, merge, deploy, enter the dataset ID and switch on.

## Setup for Mark after merging

1. Settings › Tools › Meta lead ads: enter dataset ID 1608701054328072 and switch on.
2. Once events have arrived (the next new lead, or the verification lead moved through the board), Events Manager › the Ridgeon dataset › Continue setup for Conversions API for CRM: order the funnel `Lead`, `Working`, `Proposal`, `Won`.
3. Keep the campaign on the Leads goal. Switch to Conversion leads only when Meta says the campaign is eligible.
