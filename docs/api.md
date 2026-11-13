# CRM API

Base path: `/api/v1`

Authentication is `Authorization: Bearer <agent token>` (from `npm run agent:create`). Browser cookies and personal tokens (`orbit_…`, which only work with the MCP server and quick capture below) are not accepted. Each credential is limited to 120 requests per minute. A 429 response includes `Retry-After: 60`.

Dates and times (`dueAt`, `occurredAt`, `from`, `to` and the rest) are read by `readDateTime` in `lib/time.ts`. A bare date (`2026-11-07`) or a date and time without an offset (`2026-11-07T14:30`) is London time. Slash dates are day, month, year (`07/11/2026` is 7 November), and so are dates with dashes or dots in that order (`07-11-2026`, `07.11.2026`). Month names work too (`7 Nov 2026`, `Saturday 7 November 2026 2:30pm`, `Nov 7, 2026 14:30:15`). An offset or `Z` is kept as sent, and so are RFC 2822 dates with `GMT`, `UTC`, a numeric offset or one of `BST`, `CET`, `CEST`, `EST`, `EDT`, `CST`, `CDT`, `MST`, `MDT`, `PST` and `PDT`, each read as its fixed offset (`Sat, 07 Nov 2026 10:00:00 EST` is 15:00 UTC). A two-digit year, a date without a year, a date that doesn't exist, a London time skipped when the clocks go forward or repeated when they go back (add the offset), or anything else is a 400 that says why.

Every request runs as the agent inside its workspace, under row-level security. Agent tokens see every task in the workspace, but never anyone's Mail, calendars, assistant chats, workflows, Knowledge, private docs or daily notes (only docs shared with the workspace). Every change to companies, contacts, opportunities, activities and tasks is audited with the agent as the actor and the `provenance` you send, and audit events can start workflows and are delivered to webhooks (see [Webhooks](#webhooks)). Nothing is deleted: `DELETE` archives.

Send `Content-Type: application/json`. Unknown fields are rejected. Omitted fields on `PATCH` and upsert are left unchanged. `null` clears an optional field.

Optional `Idempotency-Key` header (printable ASCII, up to 200 characters). Reuse a key only for the same request body.

## Scopes

| Operation | Scope |
| --- | --- |
| List, get, context, due actions, stale relationships | `crm:read` |
| Company create, update, upsert, archive | `companies:write` |
| Contact create, update, upsert, archive | `contacts:write` |
| Opportunity create, update, archive | `opportunities:write` |
| Activity create | `activities:write` |
| Task create, update, complete, archive | `tasks:write` |
| Lead ingestion | `leads:write`, plus the write scope of each record included |
| Filing an email or meeting | `activities:write` (the follow-up task also needs `tasks:write`) |
| Pipeline stages | `opportunities:write` |
| CSV export | `crm:read` |
| CSV import | `companies:write` or `contacts:write` |
| Webhook list and deliveries | `crm:read` |
| Webhook create and archive | `admin` |
| Docs list, search, read, folders | `docs:read` |
| Docs create, change, archive | `docs:write` |

`admin` satisfies any of these.

## Endpoints

| Method | Path | Purpose | Scope |
| --- | --- | --- | --- |
| `GET` | `/companies` | List and filter companies | `crm:read` |
| `POST` | `/companies` | Create a company (409 on a duplicate) | `companies:write` |
| `POST` | `/companies/upsert` | Create or update the matching company | `companies:write` |
| `POST` | `/companies/bulk` | Upsert 1 to 50 companies, each on its own | `companies:write` |
| `GET` | `/companies/:id` | One company, archived included | `crm:read` |
| `PATCH` | `/companies/:id` | Partial update | `companies:write` |
| `DELETE` | `/companies/:id` | Archive | `companies:write` |
| `GET` | `/companies/:id/context` | Company, people, deals, timeline, call insights, open tasks | `crm:read` |
| `GET` | `/contacts` | List and filter people | `crm:read` |
| `POST` | `/contacts` | Create a person (409 on a duplicate) | `contacts:write` |
| `POST` | `/contacts/upsert` | Create or update the matching person | `contacts:write` |
| `GET` | `/contacts/:id` | One person | `crm:read` |
| `PATCH` | `/contacts/:id` | Partial update | `contacts:write` |
| `DELETE` | `/contacts/:id` | Archive | `contacts:write` |
| `GET` | `/opportunities` | List deals and board cards | `crm:read` |
| `POST` | `/opportunities` | Create a deal, or a card on a board | `opportunities:write` |
| `GET` | `/opportunities/:id` | One deal or card | `crm:read` |
| `PATCH` | `/opportunities/:id` | Partial update, stage moves included | `opportunities:write` |
| `DELETE` | `/opportunities/:id` | Archive | `opportunities:write` |
| `GET` | `/pipeline` | The default pipeline and its stages | `crm:read` |
| `PUT` | `/pipeline` | Replace the default pipeline's stages | `opportunities:write` |
| `GET` | `/docs` | List shared docs (`folderId`, `folderId=none`, `tag` with nested tags, `sort` of `edited`, `created` or `title`, `archived=true`, `limit` up to 200, `offset`), or search them with `q` (title prefix, fuzzy title and full text, `limit` up to 50) | `docs:read` |
| `POST` | `/docs` | Create a doc: `title`, `content` (Markdown), `folderId`, `shared`, `provenance`. Always shared with the workspace. 201 | `docs:write` |
| `GET` | `/docs/folders` | Shared folders, with parent and position | `docs:read` |
| `GET` | `/docs/:id` | One doc with its links, mentions and folder path, and its text from `offset` (100,000 characters, with `nextOffset`) | `docs:read` |
| `PATCH` | `/docs/:id` | Any of `title` (rename, rewriting links to it), `content` (replace), `find` with `replace` (and `all`, matched against the text before anything is appended), `append`, `folderId` (null for no folder; with `allowVisibilityChange` when the move changes who sees it), `shared`, `baseRevision` (409 if the doc changed before any of the changes), applied in that order in one transaction, so a refused change leaves the doc as it was | `docs:write` |
| `DELETE` | `/docs/:id` | Archive | `docs:write` |
| `GET` | `/activities` | List activity | `crm:read` |
| `POST` | `/activities` | Append an activity | `activities:write` |
| `POST` | `/communications` | File an email or meeting and suggest a follow-up | `activities:write` |
| `GET` | `/tasks` | List tasks by view | `crm:read` |
| `POST` | `/tasks` | Create a task | `tasks:write` |
| `GET` | `/tasks/:id` | One task | `crm:read` |
| `PATCH` | `/tasks/:id` | Partial update, complete or reopen | `tasks:write` |
| `POST` | `/tasks/:id/complete` | Mark complete | `tasks:write` |
| `DELETE` | `/tasks/:id` | Archive | `tasks:write` |
| `GET` | `/actions` | Tasks for a view, or companies with no open task | `crm:read` |
| `GET` | `/relationships/stale` | Companies with no recent interaction | `crm:read` |
| `POST` | `/leads` | Ingest one lead in one transaction | `leads:write` and each record's scope |
| `POST` | `/leads/bulk` | Ingest 1 to 50 leads, each on its own | `leads:write` and each record's scope |
| `GET` | `/export/:resource` | CSV of `companies`, `contacts`, `opportunities`, `activities` or `tasks` | `crm:read` |
| `POST` | `/import/:resource` | Import `companies` or `contacts` from CSV | `companies:write` or `contacts:write` |
| `GET` | `/webhooks` | List endpoints, without secrets | `crm:read` |
| `POST` | `/webhooks` | Register an endpoint and get its secret once | `admin` |
| `DELETE` | `/webhooks/:id` | Archive an endpoint | `admin` |
| `GET` | `/webhooks/deliveries` | The 50 most recent delivery attempts | `crm:read` |

`GET /companies`, `/contacts`, `/opportunities`, `/activities` and `/tasks` take `limit` (1 to 100, default 50) and `offset` (up to 10,000). `limit` and `offset` must be whole numbers, and dates must be real calendar dates (no 30 February); anything else is a 400 `invalid_input` that usually names the field in `details.field`. `GET /docs` and `GET /docs/:id` follow the same rule: a `limit` or `offset` that isn't a whole number is a 400, not an empty page. `owner` (or `owner_id`) takes a member id, `unassigned`, or `all` for no filter.

## Companies

`GET /api/v1/companies`

Query: `q`, `lifecycle` (`lead`, `prospect`, `customer`, `churned`, or a custom name; matching ignores case), `health` (`healthy`, `watch`, `at_risk`, or `none` for not set), `owner` (a user id or `unassigned`), `tag` (one tag; matching ignores case and extra spaces), `sort` (`name`, `domain`, `owner`, `interaction`, `strength`, `updated`, `created`, `fit`; default `name`), `order` (`asc` or `desc`; each sort has its own default), `has` and `missing` (comma-separated `domain`, `contacts`, `interactions`), `quiet=true` (gone quiet: no interaction in the last 21 days on the company or any of its people, or none at all), `limit` (1 to 100, default 50), `offset` (max 10000), `include_archived=true`. Each company in the list includes `relationship` (`label`: `strong`, `warm`, `cooling`, `one_sided`, `cold` or `new`, and a `reason`). `icpFit` is the company's ICP fit from 0 to 4 when Web checks has scored it, otherwise null.

Response:

```json
{ "data": [], "total": 0, "limit": 50, "offset": 0 }
```

`POST /api/v1/companies` creates a company. `201` with `{ "company": { ... } }`. A matching active domain, or the same normalised name when neither row has a domain, returns 409 `duplicate_company`. Use upsert to update that row instead.

`GET /api/v1/companies/:id` returns `{ "company": { ... } }`, including archived companies. Another workspace's id is 404.

`PATCH /api/v1/companies/:id` applies a partial update. `200` with `{ "company": { ... } }`.

`DELETE /api/v1/companies/:id` archives the company. `200` with `{ "company": { ... } }`.

`POST /api/v1/companies/upsert` creates or updates the matched company. `200` with:

```json
{ "company": {}, "created": true, "matchedOn": null }
```

`matchedOn` is `domain`, `linkedin`, `name`, or `null` when a new row was inserted. An upsert matches the domain first, then `linkedinUrl` (the same LinkedIn company, school or showcase page), then the same normalised name on a company without a domain. A company matched on its LinkedIn page keeps its own domain and website when the upsert gives a different domain. When the domain matches one company and the LinkedIn page another, the domain's company is updated and the LinkedIn page stays where it is. A LinkedIn page belongs to one active company in a workspace: creating or updating another company with it returns 409 `duplicate_company` with `details.existingId` and `details.matchedOn` `linkedin`. Provide a name or a domain.

`POST /api/v1/companies/bulk` accepts `{ "companies": [ ... ], "provenance": { "source": "", "sourceUrl": "" } }` with 1 to 50 companies. Each item is validated on its own. The response is `{ "results": [ { "index": 0, "status": "created", "company": {}, "matchedOn": null } ] }`. `status` is `created`, `updated`, `matched`, or `error`. `matched` means an existing company was found and no fields changed. An error item includes `{ "code", "message" }` and does not roll back the items that succeeded.

## Company fields

`name`, `domain`, `website`, `description`, `industry`, `sizeCategory`, `linkedinUrl` (a LinkedIn company page, stored as `https://www.linkedin.com/company/<slug>`; `/school/<slug>` and `/showcase/<slug>` pages are kept as they are), `lifecycle`, `ownerId`, `source`, `sourceReference`, `tags`, and on updates `health` (`healthy`, `watch`, `at_risk` or null) with an optional `healthReason`.

Responses also carry `health`, `healthReason`, `healthAt` and `healthActivityId` (the call it came from; null when set by hand). Health is normally set from call summaries.

`lifecycle` is `lead`, `prospect`, `customer` or `churned` (their labels such as `Customer` are accepted too), or any other name up to 40 characters, such as `Consultant`; a name that matches an existing one apart from case takes the existing spelling. New companies default to `lead`.

`ownerId` must be a member of the workspace. Domain and website are canonicalised (`https://www.acme.com/about` becomes domain `acme.com`).

Provenance, when sent, is an object:

```json
{ "provenance": { "source": "research-agent", "sourceUrl": "https://example.com/acme" } }
```

It is stored on the audit event. It is not a company column.

## Tags

Companies and contacts carry `tags`, an array of strings, in every response. Sending `tags` on create, `PATCH`, upsert, or bulk replaces the whole list; omit it to leave the tags as they are, and send `[]` or `null` to clear them. Each tag is trimmed, inner whitespace is collapsed to one space, and it is lowercased, so `" Recruit  Lead "` is stored as `"recruit lead"`. Duplicates are dropped. A record holds at most 20 tags of up to 40 characters each, and a tag can't contain `;`. A change that only reorders the same tags is not an update. Tag changes are audited and fire `company.updated` or `contact.updated` webhooks like any other field.

## Errors

```json
{ "error": { "code": "forbidden", "message": "Missing scope companies:write.", "details": {} } }
```

Codes include `unauthorized` (401), `forbidden` (403), `not_found` (404), `invalid_input` (400), `duplicate_company` (409), `duplicate_contact` (409), `conflict` (409, for example a company already on a board), `idempotency_conflict` (409), `rate_limited` (429), and `internal_error` (500).

## Contacts

`GET /api/v1/contacts` with `q`, `company_id`, `owner`, `tag`, `sort` (`name`, `company`, `updated`, `created`; default `name`), `order` (`asc` or `desc`), `has` and `missing` (comma-separated `email`, `phone`, `linkedin`, `company`), `limit`, `offset`, `include_archived=true`.

Contact fields: `companyId`, `firstName`, `lastName`, `email`, `phone`, `jobTitle`, `linkedinUrl`, `location` (free text up to 200 characters, such as `Bristol, England`), `salesNavigatorUrl` (a Sales Navigator lead link, stored as `https://www.linkedin.com/sales/lead/<id>`), `ownerId`, `source`, `sourceReference`, `notes`, `tags`. Tags follow the rules in [Tags](#tags).

`POST /api/v1/contacts` creates a person. A name, email, phone, LinkedIn profile or Sales Navigator lead is required. Matching email, LinkedIn or Sales Navigator lead returns 409 `duplicate_contact` (a lead link belongs to one active contact in a workspace).

`POST /api/v1/contacts/upsert` matches email, then LinkedIn, then Sales Navigator lead, then the same name at the same company. `200` with `{ "contact", "created", "matchedOn" }`. `matchedOn` is `email`, `linkedin`, `sales_navigator`, `name`, or `null`.

`GET`, `PATCH`, and `DELETE /api/v1/contacts/:id` read, partially update, and archive. `DELETE` sets `archived_at`.

## Opportunities

`GET /api/v1/opportunities` with `q`, `company_id`, `pipeline_id` (a board id, or the default pipeline's id), `status` (`open`, `won`, `lost`), `limit`, `offset`, `include_archived=true`. Without `pipeline_id` it returns opportunities and board cards together; each row has `pipelineId`, `pipelineName` and `pipelineKind` (`sales` or `board`).

Opportunity fields: `companyId`, `pipelineId`, `name`, `stageId`, `status`, `value` (a number or a numeric string), `currency`, `probability`, `expectedCloseDate` (YYYY-MM-DD), `primaryContactId`, `ownerId`, `source`.

`POST /api/v1/opportunities` requires `companyId` and, on the default pipeline, `name`. `pipelineId` adds a card to a board instead: the name defaults to the company's, a company can be on a board once (409 `conflict` otherwise), and board stages have no won or lost. `primaryContactId` must be a contact who works at `companyId`; a create, or a `PATCH` that changes the company or contact, fails with 400 `invalid_input` (`field: primaryContactId`) otherwise. Omitting `stageId` uses the first stage of the pipeline. Marking a sales opportunity won also makes the company a customer and adds it to boards set to Add companies when an opportunity is won. A won or lost stage sets `status`. Setting `status` to `won` or `lost` moves the opportunity to that stage. Value is a non-negative amount with up to two decimal places. Currency is a three-letter code and defaults to `GBP`.

`GET /api/v1/pipeline` returns the default pipeline and its stages.

`GET`, `PATCH`, and `DELETE /api/v1/opportunities/:id` read, partially update, and archive. A stage change writes an `opportunity.stage_changed` audit event.

## Activities

`GET /api/v1/activities` with `q`, `company_id`, `contact_id`, `opportunity_id`, `type`, `actor_user_id` (the member who logged it), `actor_agent_id` (the agent that logged it), `from` and `to` (a date such as `2026-11-03`, read in London time, or an ISO date and time; a date-only `to` includes that whole day), `limit`, `offset`, newest first.

Every activity includes `actorUserId`, `actorAgentId`, and `actorName`: the full name (or email) of the workspace member who logged it, or the name of the agent that created it. `actorName` is `null` when neither can be resolved, for example after the member leaves the workspace.

`POST /api/v1/activities` appends an interaction. Types are `email`, `meeting`, `call`, `note`, `research`, `linkedin`, `agent_update`, and `other`. Fields: `type`, `title`, `body`, `occurredAt`, `companyId`, `contactId`, `opportunityId`, `metadata` (an object). A title or body is required, and the row must point at a company, contact, or opportunity. When `companyId` is missing or null, it is taken from the contact, or else the opportunity. The API doesn't send meeting invites: people send them in the app or through the assistant, which choose the From address (see Invite senders in `docs/architecture.md`). Recording a meeting that already happened goes through `POST /communications`. There is no update or delete in the API. People can edit an activity in the app or through the assistant, which fires `activity.updated` with the changed `fields` and their `before` and `after` values, and delete (archive) one, which fires `activity.archived`.

## Tasks

Task fields: `title`, `description`, `dueDate` or `dueAt` (see Due day or time below), `durationMinutes` (5 to 480; new tasks take 15), `remindMinutes` (0, 5, 10, 15, 30, 60, 120, 1440, 2880 or 10080, before the due time; needs a due time), `priority` (`low`, `normal`, `high`), `ownerId`, `companyId`, `contactId`, `opportunityId`, and on `PATCH` `completed`.

`GET /api/v1/tasks` with `q`, `company_id`, `owner`, `include_archived=true`, `limit`, `offset`, and `view` (`all`, `overdue`, `today`, `upcoming`, `completed`). Without `view` it returns every open task. `all` is every open task (not completed, not archived) whatever its due date: overdue first, then by due date, undated last, then high, normal, low priority and oldest first. `today` includes open tasks with no due date. `completed` is the last 14 days.

`GET /api/v1/actions?view=` returns the same tasks, the first 100, with `total` (how many match), and defaults to `today` when `view` is missing or not recognised. `view=all` returns every open task in the order above. `view=none` returns companies that have no open task, the 100 most recently updated, with `total`. Page through more tasks with `GET /api/v1/tasks` and `offset`. The Tasks page shows the first 100 and a Show more button for the next 100.

Agent tokens see every task in the workspace; people in the app only see tasks they own or created unless they are an owner or admin, plus tasks they are tagged in, which they can read but not change (changing, completing, reassigning or archiving one returns 403 `forbidden`). Task lists and counts never include tasks someone is only tagged in. `POST /api/v1/tasks` creates one (unowned unless `ownerId` is given; that member is told, as is a new `ownerId` set with `PATCH`, and the creator is told when someone else completes it). A `dueAt` without a `Z` or offset is read as London time, and `today` and `overdue` are cut at midnight London time. `GET /api/v1/tasks/:id` returns `{ "task": { ... } }`, and `PATCH /api/v1/tasks/:id` updates it. `completed: true` sets `completed_at` without moving an existing completion time. `completed: false` reopens it.

### Due day or time

A task is either date only or timed.

- `dueDate` (`2026-11-14`) makes it date only: due any time that London day, stored at London midnight. It isn't overdue until the day is over.
- `dueAt` with a time (`2026-11-14T14:30`, or an ISO instant) makes it timed, and later puts it on its owner's calendar. A bare date in `dueAt` is read as `dueDate`.
- Send a time only when the person gave one. Sending a value in both `dueDate` and `dueAt` returns 400 `invalid_input`. A `null` counts as absent when the other has a value, so `{ "dueDate": "2026-12-01", "dueAt": null }` is date only. `null` on its own clears the due date.
- A reminder needs a time: `remindMinutes` on a date-only task returns 400 "Pick a time for the reminder." Making a task date only removes its reminder.
- Tasks carry `dueAt` (London midnight for a date-only task), `dueDate` (the London day, because London midnight in summer is the previous day in UTC), `dueHasTime`, `durationMinutes` and `scheduledBy` (`person` when someone gave it a time, `planner` when Orbit's planner placed it, null when date only).
- On the Calendar page people drag tasks onto the grid, move blocks, resize them and drag them back onto the task list. A drop on the grid writes the time and duration with `scheduledBy` `person` (resizing alone does too; moving a block Plan placed to another day at the same time of day keeps `planner`, here and through `PATCH`), and makes an unassigned task the dragger's; a drop on the list makes the task date only on the same day, which clears `scheduledBy` and the reminder. Each is a `task.updated` event with operation `drag_task`; a drop that changes nothing records nothing, and a done task returns 400 `invalid_input`. Plan never moves a block with `scheduledBy` `person`, so don't send a new `dueAt` for one unless the person asks.
- Agent-token tasks are unowned, so a timed one reaches nobody's calendar until someone takes it. A task created with `dueDate` alone never touches anyone's calendar.
- **Outlook:** a timed task with an owner also becomes a Busy, Private event in the owner's main Outlook calendar (the task title, no reminder, no guests, a "From Orbit." link back to the task), when their mailbox allows calendar writes; otherwise it shows in Orbit only. Tasks carry `inOutlook`, true while that event exists. Orbit writes it after the response: moving or resizing the task moves the event, Done removes it if the block hadn't started, shortens it to the completion time during the block and leaves it after, reopening puts it back if the block is still ahead, and date only or archiving removes it. Only the owner sets a clock time on their own task: a write that gives a task a time or a new owner, where the result would be timed and owned by someone other than the person making the change, saves it date only on that day (clearing the reminder). So creating a task for a colleague with a time, setting a time on someone else's task, or reassigning a timed task gives them a date-only task, and nothing reaches their Outlook unasked. In plain terms: when someone other than the owner writes a new time on the owner's timed task, the task becomes date only on the new day. Agent tokens have no person, so a time they send for an owned task is always saved date only; unowned tasks keep their time. Only the owner can change the length of their timed task: `durationMinutes` from anyone else (including agent tokens) returns 403 "Only the owner can change the length of a timed task." Undo puts a time back only when the change being undone set the time and the owner together (a hand-over); undoing only an owner change, or only a time change on a task someone else now owns, follows the rule, so they get it date only. Removing someone from a workspace hands their tasks to the person removing them as date-only tasks. A teammate's timed ClickUp task arrives date only in Orbit and ClickUp keeps its time. Moving or resizing the event in Outlook moves the task on the next calendar sync (`scheduledBy` `person`, a `task.updated` event with operation `calendar_sync` from `microsoft`), and deleting it there makes the task date only. Booking pages count each block once, at the task's time. If Outlook can't be written (a read-only account, a revoked token or a refusal), Orbit keeps trying with a back-off and the task's own time stays authoritative; calendar sync never reverts it meanwhile.
- **Plan** (the Calendar page, the assistant's `update_task` `schedule` list, and the MCP tools `plan_tasks` and `schedule_tasks` for personal tokens) places the person's own tasks for today and the next 14 days inside their working hours (Settings › Calendars, personal, 09:00 to 17:30 Monday to Friday by default), skipping meetings with 5 minutes after each (every meeting blocks except free, working elsewhere, declined and all-day ones), bank holidays and the past; working days come from working hours, so weekends are off by default. Calls and meeting tasks go back to back and emails together, first at the times the person usually does them, learned over the last 90 days from times they gave their own tasks by hand in the app, meetings they organised with contacts and their own tasks they ticked off (up to three periods a kind; late morning for calls and after lunch for emails until there are about ten), an undated task taking the earliest of those in the next 3 working days, up to 6 tasks or 90 minutes a run, with a break before the next run of the same kind; other tasks go singly. A date-only task gets a time on its own day, an undated one any day; timed tasks stay put, and Replan my blocks moves only blocks with `scheduledBy` `planner`, on the same day. Overdue tasks stay where they are until someone moves them. Applying writes every block in one transaction, all or nothing, with `scheduledBy` `planner` and a `task.updated` event each (operation `plan_tasks` from the Calendar page, `schedule_tasks` from the assistant and MCP), then pushes to ClickUp. A schedule from an agent is refused if a dated task would change day, an overdue one moves without `moveDay` naming the new day, a block the person placed would move (unless it is overdue and `moveDay` names the new day), or a slot falls outside working hours or over a blocking meeting or another block. From the Calendar page, a proposal the person dragged is written with `scheduledBy` `person`, since dragging is placing by hand, and a block the person placed keeps `person` after an overdue move. An `at` more than a year ahead is refused. Writes through the API, MCP, agents and the assistant never teach Plan these times, and a `provenance.source` of `web` is dropped, since only the app's own pages are the web.

`POST /api/v1/tasks/:id/complete` marks it complete. Completing is idempotent: completing a task that is already done (here, or with `completed: true`) succeeds and returns the task unchanged with no audit event, so no second `task.completed` webhook, "Done by" alert or `task_completed` workflow. Likewise `completed: false` on an open task changes nothing. Someone who can't change the task still gets 403 `forbidden`. `DELETE /api/v1/tasks/:id` archives it. Each task also carries `clickupTaskId`, `clickupListId`, `clickupUrl`, and `clickupError` (null when it is not linked to ClickUp). It also carries the linked contact's `contactJobTitle`, `contactPhone` and `contactEmail` and the linked company's own `companyPhone`, read live from those records (null when there is no such link or value); they are read only on a task, so change them on the contact or company. Changes made through the API reach ClickUp on the next sync.

### Linking tasks

Every way of creating a task (`POST /api/v1/tasks`, MCP, the assistant, workflows, Mail, call summaries, leads, the extension, Quick capture and the app) follows one rule. When `companyId`, `contactId` and `opportunityId` are all left out, Orbit reads the title and links the task only to a name it is sure of, written with the same capitals as in Orbit: a contact's full first and last name that no other contact shares, a company's full name of two or more words that only one company has, or one opportunity's full name of two or more words. A one-word company name (Zoom, Chase, Northwind) is never linked this way; the app's task pad shows it as a chip to confirm, and Link a person offers it. A contact found also links their company. When one name sits inside a longer one ("Jane Doe Consulting"), the longer one wins before anything else is checked, a name never matches part of a hyphenated one ("Anna Smith-Jones" is not Anna Smith), and a company named in full is never replaced by a different company the named contact works at (the contact is then left out). A first name, a surname, a name in lower case, a name two records share, two different people in one title, and anyone whose name matches a workspace member are never linked. What Orbit finds never stops a task being created: if the links it found don't fit together, the task is created unlinked. Any id you send is kept as sent, and `null` means deliberately none, so sending any one of the three turns the reading off. The `task.created` audit event (and its webhook `data`) carries `detectedLinks`, the fields Orbit filled in this way, such as `["companyId", "contactId"]`. It sits with the event's changes rather than its provenance because audit events store only the provenance's operation, source and source URL. Each task also carries `contactFirstName` and `contactLastName` alongside `contactName`, the contact's `contactJobTitle`, `contactPhone` and `contactEmail`, and the company's own `companyPhone`.

In the app, an unlinked task's panel offers Link a person: contacts whose first name, surname or full name is in the title, in any case and with or without 's (never a contact who shares a teammate's full name), companies named in full, a line saying when a name matches several contacts, and Someone else to search for anyone. Linking one is an ordinary update (`operation` `link_task`), refused once the task is linked.

## Leads

`POST /api/v1/leads` accepts any of `company`, `contact`, `note`, `activity`, `opportunity`, and `task`. The lead's `task` takes `dueDate` or `dueAt` like a task. Leads are listed among the routes that set a date only, but an explicit `dueAt` with a time is honoured as timed, the same as `POST /api/v1/tasks`, because the caller gave a time; it keeps its `remindMinutes`. A `dueDate`, or a bare date in `dueAt`, is date only, and any reminder is dropped rather than refusing the lead. Company and contact use the upsert rules. The note becomes a research activity when `activity` is omitted. The opportunity and task attach to the company and contact from the same request. The response is one object with `company`, `contact`, `activity`, `opportunity`, `task`, and the created/matched flags. The whole request is one transaction.

## Context

`GET /api/v1/companies/:id/context` returns the company, its contacts, opportunities, recent activities, open tasks, `lastInteraction`, `openTaskCount`, `relationshipStatus` (`new`, `active`, `quiet`, or `needs_action`), and `timeline`: the company's activities plus those of its current contacts, newest first. `insights` maps the id of each call in the timeline that has a summary to its summary, key points, suggested actions, status, and `sentiment` (`healthy`, `watch`, `at_risk` or null) with `sentimentReason` (the transcript is not included). The company carries `health`, `healthReason`, `healthAt` and `healthActivityId`.

`GET /api/v1/relationships/stale` lists companies with no interaction in the last 21 days. `days` and `limit` are optional whole numbers; anything else is a 400 `invalid_input`.

## Import and export

`GET /api/v1/export/companies`, `/contacts`, `/opportunities`, `/activities`, and `/tasks` return CSV, paged through 100 rows at a time, up to 10,000 rows (`EXPORT_ROW_LIMIT` in `lib/csv.ts`), and stops reading after 50 seconds (`EXPORT_BUDGET_MS`) so it finishes inside the route's 60 second limit. The ceiling is there because the list reads cap their offset at 10,000 (each deeper `OFFSET` page re-reads every row before it) and the whole file is built in memory for one response. Every export sets `X-Export-Rows` (rows in the file), `X-Export-Total` (rows that matched) and `X-Export-Truncated` (`true` when rows were left out); a cut-off export also sets `X-Export-Note`, such as "Exported 10,000 of 12,345 contacts, the limit for one export." or "Exported 4,200 of 9,000 tasks, ran out of time." The app's Export buttons show the same note.

`POST /api/v1/import/companies` and `POST /api/v1/import/contacts` accept `text/csv` or `{ "csv": "..." }`. Up to 50 rows. Companies match by domain. Contacts match by the usual contact rules and attach to a company with the same domain or name. A column that is absent, or a cell that is empty, leaves that field as it is. Exports include a `Tags` column with tags separated by `; `. Contact exports include `Location` and `Sales Navigator`, and imports read those columns too. On import a non-empty `Tags` cell (split on `;`) replaces that record's tags. Without the matching write scope the import returns 403.

## Communications

`POST /api/v1/communications` accepts `{ "kind": "email" | "meeting", "title", "body", "participantEmails", "companyId", "contactId" }`. It files the activity and, when it happened in the last 48 hours and the company has no open task, creates a suggested follow-up task. Requires `activities:write`. The follow-up also requires `tasks:write`.

## Bulk leads

`POST /api/v1/leads/bulk` accepts `{ "leads": [ ... ], "provenance": {} }` with 1 to 50 leads. Each lead uses the single-lead rules and is saved on its own. The response is `{ "results": [ { "index": 0, "status": "created", "lead": {} } ] }`. `status` is `created` or `error`.

## Pipeline

`PUT /api/v1/pipeline` replaces the default pipeline stages. Send every stage to keep, with exactly one `isWon` and one `isLost`. Include `id` to update an existing stage. A stage that still has opportunities cannot be removed. Requires `opportunities:write`.

## Quick capture

`POST /api/quick` adds to the token owner's daily note or makes them a task. It's built for an iPhone Shortcut (setup steps are in Settings, API tokens). Authentication is `Authorization: Bearer <personal token>` (`orbit_…`); agent tokens are refused, because daily notes are private. The body is JSON `{ "text", "to" }`, form fields with the same names, or plain text. `to` is `daily` (the default; also `note`, `journal` or `jot`) or `task` (also `todo`). Text is up to 4,000 characters.

- `daily` appends a timed entry to today's daily note (London time), creating the note if needed, and live editors see it straight away.
- `task` makes a task owned by the token's owner. The first line is the title (up to 200 characters) and the rest is the description.

The reply is plain text for the Shortcut to show, for example `Added to today's note at 08:20.` or `Added a task: Send the proposal`. Errors are plain text with status `400` (nothing to add, or an unknown `to`), `401` (missing or revoked token) or `429` (more than 120 requests a minute).

## Webhooks

`POST /api/v1/webhooks` requires `admin`. Body: `{ "url", "events": ["lead.created"], "description" }`. `201` returns `{ "endpoint", "secret" }`. The secret is shown once. URLs must be `https` and resolve to public addresses: loopback, private, link-local (including cloud metadata), CGNAT, multicast and their IPv6 forms (including IPv4-mapped addresses) are refused when the webhook is saved and checked again on every delivery, once before the request and again on the addresses resolved when the connection is made. A host that can't be found fails the delivery; a lookup that fails for another reason is retried with the usual backoff. Deliveries don't follow redirects: a 3xx response counts as a failed attempt. For development, `WEBHOOKS_ALLOW_PRIVATE_TARGETS=1` allows `http` and local addresses outside production.

`events` (1 to 30) takes any of `company.created`, `company.updated`, `company.archived`, `company.merged`, `company.undone`, `company.ai_field_changed`, `company.moved_out`, `company.moved_in`, `company.copied`, `contact.created`, `contact.updated`, `contact.archived`, `contact.merged`, `contact.undone`, `contact.moved_out`, `contact.moved_in`, `contact.copied`, `lead.created`, `opportunity.created`, `opportunity.updated`, `opportunity.stage_changed`, `opportunity.archived`, `opportunity.undone`, `activity.created`, `activity.updated`, `activity.archived`, `activity.undone`, `task.created`, `task.completed`, `task.reopened`, `task.updated`, `task.archived`, `task.undone`, `task.participant_added`, `task.participant_removed` (someone was tagged on a task or removed from it; `data.participant` has their `userId`), the Docs events `page.created`, `page.updated`, `page.moved`, `page.shared`, `page.archived`, `page.restored`, `page_folder.created`, `page_folder.updated`, `page_folder.moved`, `page_folder.shared`, `page_folder.archived` and `page_folder.restored`, or `*` for every event. Docs events fire only for docs and folders shared with the workspace (or that were shared until that change), carry the title or name and never the text, and `page.updated` fires when a version is saved (at most every 10 minutes while a person types, on every rename and on every agent edit). Restoring a record from the archive fires `*.updated` with `fields: ["archivedAt"]`. When someone undoes a change through the assistant, the change it puts back fires its normal event first, then `*.undone` fires with `data` of `{ "undoes", "undoneEventType", "restored" }`: the id of the audit event that was undone, its type, and a sentence saying what was put back.

`company.ai_field_changed` fires when the shown answer of an AI field changes for a company, including its first answer. `data` is `{ "fields": ["ai:<field id>"], "before": { "ai:<field id>": "Yes" }, "after": { "ai:<field id>": "No" }, "aiField": { "id", "label" } }`, with values as shown in Orbit (numbers formatted, options joined with commas) and null for Unknown or no answer yet. Answers found on the web carry `source` `parallel` and the actor of whichever sync or person started the check; answers set by hand carry no source and the person who set them. Changing a field's type or options clears its web answers without firing this event; the new answers fire it as they arrive.

`company.merged` and `contact.merged` carry how many rows moved from each table and which fields were filled; the archived duplicate also fires `company.archived` or `contact.archived` with `mergedInto`.

Moving a company or contact to another workspace (Move to workspace in the app, or the assistant and MCP tool `move_records_to_workspace`) fires `company.moved_out` or `contact.moved_out` in the workspace it left, with `{ name, toWorkspace: { id, name }, targetId, mergedInto }`, and `company.moved_in` or `contact.moved_in` in the workspace it joined, on `targetId`, with `{ name, fromWorkspace, fromId, merged }` (plus `filled`, `tagsAdded`, `before` and `after` when it merged into a record that was already there). Company events also carry `deals` (each moved deal's `id`, `targetId`, `name` and the `stage` it landed on) and, on a move, `boardCardsRemoved`. A move never fires `*.created` for the records that moved. When a company moves without its contacts, each contact left behind fires `contact.updated` in the source with `{ fields: ["companyId"], before, after, companyMovedTo }`; undo refuses it. When a person moves without their company and colleagues stay behind, the company is copied for them: that fires `company.copied` in the source and `company.created` in the target. A copy fires `company.copied` or `contact.copied` in the source (`{ name, toWorkspace, targetId, merged }`). In the target, a new record fires `company.created` or `contact.created` with `{ after, copiedFrom: { workspaceId, workspaceName, id } }`, and a record that was already there and took the copy's empty details fires `company.updated` or `contact.updated` with `{ fields, before, after, copiedFrom }` instead (nothing fires when it took nothing). Copied deals fire `opportunity.created` with `{ after, copiedFrom }`, where `copiedFrom.id` is the source deal. There is no REST endpoint for moving: agent tokens belong to one workspace, and a move needs a person who is in both.

An endpoint subscribed to `*` also receives every other audited event, which can't be chosen by name: for example `knowledge.added`, `knowledge.updated` and `knowledge.removed` (Knowledge isn't in the agent API; these carry the item's title, kind, scope and company), `board.*`, `document.*` for proposals and NDAs, `template.*`, `product.*`, `email_template.*`, `proof_entry.created`, `proof_entry.updated` and `proof_entry.archived` (the proof list for cold emails; they carry the client, the result, whether they can be named and the review date) and `call_summary.ready`. Changes to a person's own mailbox are not audited and never fire webhooks.

`GET /api/v1/webhooks` lists endpoints without the secret. `DELETE /api/v1/webhooks/:id` archives one. `GET /api/v1/webhooks/deliveries` lists recent attempts.

A delivery is `POST` JSON of `{ "id", "type", "createdAt", "workspaceId", "entity": { "type", "id" }, "actor": { "type", "userId", "agentId" }, "source", "sourceUrl", "data" }`, where `data` is the audit event's changes, with headers `X-CRM-Event`, `X-CRM-Event-Id`, `X-CRM-Timestamp`, and `X-CRM-Signature: v1=<hex>`. The signature is HMAC SHA-256 of `{timestamp}.{body}` using the endpoint secret. Deliveries go out right after the change that queued them. A non-2xx response is retried after 1, 5, 30 and 120 minutes, and marked failed after the fifth attempt; retries run on the next delivery or the scheduled sync (every 10 minutes), whichever comes first.

Deliveries from the assistant carry `source` `assistant`, or `email` for changes an agent mailbox job ran (see Agent mailbox in `docs/assistant.md`). Changes made from the LinkedIn capture Chrome extension carry `source` `linkedin_extension`, the person as the actor, and the LinkedIn page as `sourceUrl`.

## LinkedIn capture extension API

`/api/extension/*` serves only the LinkedIn capture Chrome extension (see LinkedIn capture in `docs/architecture.md`). It isn't part of the agent API: agent and personal tokens are refused there, and its browser credentials (`olx_…`) are refused everywhere else. Requests with an `Origin` other than `chrome-extension://<id>` for an ID in `LINKEDIN_EXTENSION_ID` get 403 `origin_not_allowed`, and so does any `POST` without an `Origin` (Chrome sends it on the extension's `POST`s but not its `GET`s, which need the browser credential anyway). Only those origins get CORS headers.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/pair` | Start connecting: a code, a secret and the Orbit page to approve it on (`/connect/chrome`, without the code, which the person types there). Up to 10 from one address every 10 minutes |
| `POST` | `/pair/redeem` | `{ code, secret }`: 202 while waiting, 200 with the credential once approved (once only), 410 when expired, used or cancelled |
| `GET` | `/me` | The browser, the person and each allowed workspace with its members, boards and stages, and lifecycles |
| `GET` | `/lookup?url=&linkedinUrl=&name=&company=&companyUrl=&domain=` | In Orbit, possible match or not, in every allowed workspace (`linkedinUrl` is the public profile link on a lead page). Possible people are in `candidates`, possible companies in `companyCandidates` |
| `POST` | `/capture` | Save a person (`kind: person`) or company (`kind: company`), or link a possible match (`kind: link` for a person, `kind: link_company` for a company) |
| `POST` | `/diff` | What differs between the page and the record; with `apply` it saves the ticked fields |
| `POST` | `/task`, `/note`, `/log`, `/log/check` | Add a task (yours), a note, a LinkedIn message or the ticked on-screen messages as one activity, and check which were logged before |
| `POST` | `/revoke` | Sign this browser out |

Every call except `pair`, `pair/redeem`, `me`, `lookup` and `revoke` names its workspace in `X-Orbit-Workspace`; one the browser wasn't given, or that the person has left, gets 403 `workspace_not_allowed`. Each browser is limited to 300 requests a minute.

## Agent mailbox webhook

`POST /api/machinemail/webhook` receives MachineMail events for the agent mailbox. It isn't part of the agent API and takes no Orbit token: Settings › Tools, Agent mailbox registers it with MachineMail for `message.received` on the mailbox's inbox, and MachineMail signs every delivery.

- `X-MachineMail-Signature: t=<unix seconds>,v1=<hex>` must be HMAC SHA-256 of `{t}.{raw body}` with the webhook's secret, compared in constant time, and `t` within 300 seconds of Orbit's clock. Otherwise the answer is `401` and nothing is stored.
- `X-MachineMail-Event-Id` must match the body's `event_id` (`400` if not). An event id already handled answers `200` with `{ "duplicate": true }`.
- Bodies over 5 MB get `413`. `webhook.test`, events that aren't `message.received*` and messages for another inbox answer `200` and are ignored. `message.received.quarantined`, `.spam`, `.unauthenticated` and `.blocked` are stored and refused (`acted: false`) even from a listed sender, and so is mail without a trust report, without `direction: "inbound"`, from more than one address or from the mailbox itself.
- Every message is stored. Only mail from an address on the list that passes DMARC, or DKIM for the sender's domain or a subdomain (and not marked unaligned by MachineMail), starts work, after the response (`after()`). The answer is `200` with `{ "ok": true, "stored": true, "acted": true | false }`, well within MachineMail's 10 seconds.

## Chat incoming webhooks

`POST /api/chat/hooks/<hook id>` posts into a Chat room from tools like Zapier or Make. It isn't part of the agent API and takes no Orbit token: a member of the room adds the hook in Room settings › Incoming webhooks and gets its URL and a secret, shown once (see Incoming webhooks in `docs/architecture.md`).

- `Authorization: Bearer <secret>`, checked before the body is parsed. A secret in the query string (`key`, `secret`, `token`) is refused with `400`.
- Body (JSON, up to 32 KB): `{ "text", "title"?, "url"? }` posts a card. `text` up to 10,000 characters, `title` up to 200, `url` http or https without a username or password. Any other JSON (nested at most 20 levels) is posted as a formatted block, cut at 8,000 characters.
- `Idempotency-Key` (optional): a repeat key for the same hook answers `200` with the first message's id and `"duplicate": true` and posts nothing.
- `201` returns `{ "ok": true, "id", "conversationId", "duplicate": false }`. Errors are `{ "error" }`: `400` invalid body, `401` wrong or missing secret, `404` unknown or deleted hook or archived room, `409` paused, `413` too large, `429` more than 30 posts a minute from that hook. Every response is `no-store`.
- Hook messages never carry mentions and never alert anyone; they count as unread like any other room message. Any room member can delete one.
