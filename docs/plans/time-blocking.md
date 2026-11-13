# Time blocking plan: tasks on the calendar

Status: settled with Mark (2026-11-12), written from a review of the calendar code and research into Sunsama, Motion, Akiflow, Morgen, Reclaim and Todoist, and revised after three Fable reviews against the code. Mockups approved by Mark (2026-11-12). Nothing is built.

## What Mark asked for

- A task with a date and time appears on the calendar as a block.
- The assistant and MCP agents can put tasks on the calendar.
- The Calendar page's left menu: the connected calendars list collapses by default, and a list of tasks sits in the same place.
- Tasks drag from that list onto the calendar, which sets their date and time.
- Tasks have a duration, 15 minutes by default, changed by dragging the block's edge or in the task.
- A button plans tasks onto the calendar for the next two weeks at once. The AI takes the kind of task into account and groups them, so calls follow each other rather than being spread out.

## Decisions settled with Mark (2026-11-12)

1. **Blocks go into Outlook** as Busy, Private events, so nobody can book a call over them.
2. **Blocks take booking slots** on booking pages.
3. **Preferred times are learned** from what each person does (see Learned times). Working hours are only the outer bounds.
4. **A task's date is the day it is done.** Plan never changes a task's date on its own (see What Plan may change). Dragging by hand can.
5. **Overdue tasks stay on their day** until moved. Plan offers to move them, today first.
6. **Assignee names stay as they are:** hidden while someone is the only member of a workspace.

## What the research says

- **Sunsama** is manual first: drag a task onto the calendar, resize to change the estimate, an optional one-task auto-schedule. External blocks are Busy and can be Private. Done cuts a block short or removes it.
- **Motion** schedules everything and replans continuously. Its main complaint is churn and loss of control: blocks move without asking, and edits in Outlook don't flow back.
- **Neither batches by kind.** Akiflow (Time Slots), Morgen (Frames, with an AI planner that previews then applies) and Reclaim (Habits) group similar work.
- **Copy:** preview, then accept (Morgen); a block placed by hand is locked (Reclaim); Busy meetings block time, Free, declined and all-day events don't; never plan into the past; offer overflow rather than forcing it.
- **Avoid:** background reshuffling, agents filling the calendar, task titles naming contacts leaking onto shared calendars, dozens of tiny events cluttering Outlook.

## What Orbit has today

- **Calendar page** (`app/(crm)/calendar/page.tsx`, `components/crm/calendar-screen.tsx`): day and week views, a desktop grid (`calendar-grid.tsx`, 15 minute slots, `SLOT_MINUTES` in `lib/invite-rules.ts:13`) and a phone agenda (`calendar-agenda.tsx`). The left menu (`CalendarList`, `calendar-screen.tsx:83`) shows on `lg` and in a drawer below. No drag or resize.
- **Events** sync from Microsoft Graph and calendar links into `crm.calendar_events` (owner only, the same in every workspace). Orbit writes to Outlook already (`createGraphEvent`, `moveGraphEvent`, `deleteGraphEvent`; `personalDraft` at `lib/microsoft/calendar.ts:529` makes a Busy event with no guests and a reminder on, but no sensitivity). Writing needs `Calendars.ReadWrite`: the main mailbox and send accounts, not extra calendar accounts or links. Sync deletes rows Graph no longer returns, sparing only future `created_by_orbit` rows beyond its window (`lib/crm/calendar.ts:330-347`; the window is 30 days back, `:51`).
- **Free time:** booking pages compute slots from their own weekly hours and `private.booking_busy`, which reads `crm.calendar_events`. `lib/crm/task-due.ts` (`busyFor`, `freeSlot`, a fixed 09:00 to 17:30 day) sets due dates for workflows, Mail follow-ups, Remind me, the extension and communications. There is no personal working hours setting.
- **Tasks** have `due_at` (always a time; `planTaskDue` returns now for today), `remind_minutes` (an offset from `due_at`), no duration, no "has a time" flag, and no stored kind (Tasks plan decision 1).
- **Assistant:** 126 tools, at the cap. `list_tasks` and `list_calendar_events` are core tools sent on every call; `create_meeting_invite` and the other meeting tools are in the calendar area. `create_task` and `update_task` take `dueAt`. **MCP** has no calendar tools; agent tokens can't read calendars at all, personal tokens act as their person.
- **Drag:** no library. The opportunities board uses `startPointerGesture` (`lib/pointer-gesture.ts`), the pattern to reuse.

## The model

### A task's time
- **One time.** The task's date and time is when it is done and where it sits on the calendar. Dragging a block changes it.
- **Timed or date only.** A new column `due_has_time boolean not null default false`.
  - Date-only tasks store London midnight of their day. Views treat them as due through the end of that day, so one due today isn't overdue until tomorrow. The overdue checks to update: `lib/crm/tasks.ts:542`, `lib/crm/action-needed.ts:147`, `lib/crm/relationships.ts:154`, `lib/crm/task-views.ts:84`, `lib/extension/records.ts:126`.
  - Only timed tasks appear on the grid. Date-only tasks sit in the task list under their day.
  - **Existing tasks:** those with a reminder stay timed; the rest become date only and their `due_at` moves to London midnight of the same day, without marking them for a ClickUp push. Orbit has a handful.
  - **Every route, one rule each:**
    - Add task card: a time typed or picked makes it timed; a day alone ("Call Jane Monday") is date only. The parser and its AI fallback prompt (`lib/crm/task-pad.ts:271`) stop defaulting to 09:00.
    - Task fields, quick dates and Remind me on a task (`task-snooze.ts`, `snoozeTask`): keep the task's kind. A date-only task moves to another date; a timed task keeps its time of day.
    - Dragging onto the grid, Schedule, or applying a plan: timed.
    - Workflows, Mail follow-up suggestions, call summaries, leads, the extension and Quick capture: date only. `task-due.ts` keeps choosing the day and drops the time.
    - Mail Remind me (`lib/mail/deferrals.ts`): the email itself comes back at the chosen moment, so its "Check in with" task is date only, on that day. It doesn't become an Outlook block or take a booking slot.
    - ClickUp inbound: timed only when ClickUp's due date has a time (`fromClickUpDue`, `due_date_time`); `toClickUpDue` reads `due_has_time`.
    - REST, MCP and the assistant: `dueDate` (date only) or `dueAt` (timed). Descriptions say to send a time only when the person gave one. Agent-token tasks are unowned, so they never reach anyone's calendar until someone takes them.
  - **Output:** tasks carry `dueDate` and `dueHasTime` in the API, MCP, assistant, workflow variables (`lib/workflows/engine.ts:312`), spreadsheets and the extension, because London midnight in summer is the previous day in UTC.
- **Duration.** `duration_minutes int not null default 15 check (duration_minutes between 5 and 480)`. Dragging snaps to 15 minutes; the task's Duration chip offers 5, 10, 15, 30, 45, 60 and a custom value. Resizing a block changes it.
- **Reminders** apply to timed tasks only and follow the block when it moves (the browser poll keys on `dueAt` already, `components/crm/task-reminders.tsx:65`; Tasks Phase 6's push marker must reset on a move). Setting a reminder on a date-only task asks for a time.
- **Kind** comes from the shared title-based helper Tasks Phase 3 adds (`lib/crm/task-kind.ts`): call, email, meeting or other.
- **Which tasks show on a person's calendar:** open, timed tasks they own, from every workspace they're in (read per workspace through `withActor`, since the calendar is personal). Unassigned tasks show in the task list and become theirs when dragged on. Tasks they created, are tagged in or see as an admin never appear. The workspace is named on a block only for people in more than one workspace. Done tasks show greyed for the rest of that day.
- **Placed-by marker:** `scheduled_by text check (scheduled_by in ('person','planner'))`, null when date only. Dragging, Schedule, a time typed or picked, and a moved Outlook block write `person`; Plan's Apply and an approved assistant or MCP plan write `planner`. A person's block is never moved by Plan.

### On the Calendar page
- **Left menu:** two sections. **Calendars** (today's list) collapses by default, remembered per browser. **Tasks** lists open tasks the person owns or that are unassigned, grouped Overdue, Today, This week, Later, No date, each with its kind icon, linked person and duration. Phones and tablets get it in the same drawer.
- **Blocks** look different from meetings: a tinted card with the done circle, title, linked person and duration. Overdue blocks keep their day with an overdue mark. Clicking opens the Tasks panel; the circle completes it with Undo.
- **Drag** a task from the list onto the grid to give it a date, time and duration. Drag a block to move it, its bottom edge to resize it, and back onto the list to make it date only again.
  - Desktop with a mouse. iPad by long-press to pick up, with auto-scroll at the grid's edges.
  - Keyboard and phones: a **Schedule** action in the task picks a free slot from a short list (next free 15 minutes today, tomorrow morning, and so on) or a date and time.
  - The phone agenda shows blocks in time order among meetings.
- **Clashes:** a block placed by hand over a meeting is allowed (Mark is authoritative) and shown with "Clashes with {meeting}". A meeting that later lands on a block flags it; nothing moves on its own. Only Plan avoids meetings.

### Plan my two weeks
- A **Plan** button on the Calendar page builds a **preview** for today and the next 14 days. Proposed blocks show dashed on the grid with a side list: placed, Overdue and Couldn't fit. Mark can drag or remove proposals, then **Apply** writes them in one go, or **Cancel**. The preview lives in the browser until applied.
- **What Plan may change** (decision 4):
  - A date-only task in the window gets a time **on its own day**. If that day is full it goes under Couldn't fit.
  - A task with no date gets a day and a time anywhere in the window.
  - A timed task is already on the calendar and is left alone. **Replan my blocks** moves blocks Plan placed earlier, but only to another time on the same day. Blocks a person placed never move.
  - **Overdue** tasks, timed or date only, stay where they are until Mark acts (decision 5). The preview lists them under Overdue with a suggested slot today, or the next free day if today is full, each with Move or Leave, plus Move all.
  - **Couldn't fit** offers Next free day and Outside hours (both change only with Mark's click) or Leave.
- **How blocks are placed** (a deterministic packer in `lib/crm/plan-tasks.ts`, tested without a model):
  - Inside working hours, skipping Busy and tentative meetings (Free, declined and all-day events don't block), days off (weekends follow working hours, Monday to Friday by default) and bank holidays (`lib/crm/working-days.ts`), never in the past, with a 5 minute gap after meetings, using wall-clock time so the clock change is handled.
  - Learned times first, then the rest of working hours.
  - **Grouping:** calls go back to back in one run, then emails in another, each run up to 6 tasks or 90 minutes before a break. Meeting tasks (book a meeting) join the calls. Other tasks are placed singly.
- **Where the AI helps:** one `completeJson` call (zod schema, a 20 second deadline) orders and groups the work: which tasks belong together and which are most pressing, and a suggested duration for tasks still at the default 15 (never one Mark set), shown in the preview. The packer then places every block and checks it is free, so the model can never double-book, invent a slot or change a date. If the call fails or there is no key, the packer orders by kind, due date and priority alone.
- **Working hours:** a personal section in Settings › Calendars, "you, everywhere", defaulting to 09:00 to 17:30 Monday to Friday. Only Plan and Schedule read them. `task-due.ts` keeps its fixed hours, and booking pages keep their own.

### Learned times (decision 3)
- Each person's preferred time of day per kind (call, email, other) is learned from what they do, over the last 90 days:
  - **Strongest:** tasks they gave a time by hand, dragged or moved (audit events with `actor_user_id` and the operations `update_task` from the web, drag and Schedule; never Plan's Apply or `calendar_sync`, so Plan doesn't teach itself).
  - **Medium:** when they book meetings and calls with contacts (`calendar_events` with `contact_ids`).
  - **Weak:** when they complete tasks of that kind (`completed_at`), weighted low because ticking happens in batches.
- One indexed audit query per workspace per Plan run builds a spread over the week's half-hours. A personal table `crm.schedule_preferences` (user-keyed, RLS to that user) caches it and holds the Reset time, after which signals count again from scratch.
- Until there are about ten signals for a kind, defaults apply: calls late morning, emails after lunch.
- The preview explains where it helps ("Calls in the morning, as you usually do"). Settings › Calendars shows what has been learned, with Reset.

### Outlook (decision 1)
- Blocks go to the person's main Outlook calendar through a new `taskBlockDraft`: Busy, `sensitivity: private`, reminder off (Orbit sends task reminders), titled with the task title, no `contact_ids`, so a Use for CRM calendar never shows it to teammates.
- **The link:** the task keeps the provider event id (`tasks.calendar_event_ref`), and the synced event row carries `task_id` (`on delete set null`), so the grid draws it once, as the task block. Sync never deletes a row that carries `task_id` in either delete branch, and a Move always updates the event by its stored id, so an overdue block older than the sync window never loses its link or gets a duplicate.
- **Lifecycle:**
  - Done shortens the event to the completion time, or removes it if it hadn't started; completing after the block ended leaves the event alone. This runs server-side in the complete path after Tasks Phase 2's held Done commits, never blocking the beacon. Reopen restores it if it's still ahead.
  - Making the task date only or deleting it removes the event. Reassigning a timed task to someone else makes it date only and removes the event, so nothing is written into a colleague's Outlook unasked.
- **Read back on sync:** a block moved or resized in Outlook moves or resizes the task (`scheduled_by` becomes `person`), and one deleted in Outlook makes the task date only.
  - A missing block counts as deleted only when it starts inside the sync window and was written before that fetch began.
  - Sync acts as the owner through `memberActor` for the task's workspace, skips the task if they have left it, audits with provenance `calendar_sync`, and updates ClickUp.
- **Other readers of block events:** `isPersonalEvent` excludes them, so `move_meeting` and `cancel_meeting` never bypass the task; calendar "starting soon" alerts skip them; `busyFor` and Mail send scheduling (`lib/mail/scheduling.ts`) filter them out.
- **Write access** is read as invites do (`lib/crm/invite-senders.ts`). Without it (calendar links or a read-only account), blocks show in Orbit only, with "Reconnect to put task blocks in Outlook".
- **Booking slots (decision 2):** Outlook blocks already reach `private.booking_busy` through `calendar_events`. It is redefined to also include the owner's open, timed tasks from every workspace that have no Outlook event yet (no write access, or before Phase 5 ships), excluding done tasks.
- The planner ignores its own unlocked blocks when replanning; `task-due.ts` ignores task blocks.

### Assistant and agents (no new assistant tools)
- `create_task` and `update_task` gain `dueDate` and `durationMinutes`; `dueAt` stays timed and writes `scheduled_by` `person` (Mark approved the card).
- `update_task` takes either `taskId` or a `schedule` list (`taskId`, `at`, `durationMinutes`): `required` is dropped and `run` checks exactly one is given. The approval card lists every block with its task name. A `schedule` entry follows Plan's rules: a dated task keeps its day (an overdue one may move only with the card naming the new day), each slot is checked against working hours and Busy meetings, applying is all or nothing in one transaction, entries write `scheduled_by` `planner`, and each task gets its own audit event.
- "Plan my next two weeks" from the assistant: it reads tasks (`list_tasks`) and meetings (`list_calendar_events`), proposes a `schedule` list grouping calls, and Mark approves the card. `list_calendar_events` merges task blocks from tasks (not only from Outlook rows), marked as tasks, so it works before Phase 5 and without write access. Core tool schemas grow only by the new fields.
- **MCP:** `create_next_action` and `update_next_action` take `dueDate` and `durationMinutes`. New `plan_tasks` (read, the packer's proposal) and `schedule_tasks` (write, the same rules as the `schedule` list, so a dated task keeps its day and overdue moves are refused unless the call names the new day) are registered only for personal tokens (`actor.type === "user"` in `server/mcp/server.ts`).
- Agents creating tasks with a date only never touch the calendar, so they can't flood it.

## Phases

0. **Mockups** (approved by Mark, 2026-11-12; `docs/plans/time-blocking-mockups.html`, build to them, and every "Choice to approve" in that file is approved, including no Plan on phones, "Remove the time", and Outlook blocks noted "From Orbit" with a link to the task): the left menu with Calendars collapsed and Tasks; blocks on the week grid, including overdue and clash marks; drag, resize and long-press on iPad; the Plan preview with grouped calls, Overdue and Couldn't fit; Replan my blocks; the Duration chip and Schedule; the phone agenda; Settings › Calendars working hours and Learned times.
1. **Timed tasks and duration** (one PR, medium, migration): `due_has_time`, `duration_minutes`, `scheduled_by`; date-only views, overdue checks, reminders and existing data; every route's rule; Duration and Schedule in the task; assistant, MCP, API fields and output; docs.
2. **Blocks on the calendar** (one PR, medium): owned timed tasks from every workspace on the grid and agenda; open and complete from a block; the left menu with collapsed Calendars and the Tasks list; `list_calendar_events` merging blocks.
3. **Drag and resize** (one PR, medium): list to grid, move, resize, back to list, long-press on iPad, auto-scroll; a shared drag hook built on `startPointerGesture`; WebKit sweep.
4. **Plan** (one PR, large, migration): working hours, the packer with grouping, the AI ordering step, the preview with Overdue, Couldn't fit and Replan my blocks, Apply, `update_task` `schedule`, MCP `plan_tasks` and `schedule_tasks`.
5. **Learned times** (one PR, medium, migration): `crm.schedule_preferences`, signals, Settings › Calendars with Reset, the packer preferring them.
6. **Outlook and booking** (one PR, medium, migration): `taskBlockDraft`, the link columns, lifecycle, read back on sync, other readers, `private.booking_busy`.

Migrations follow the working notes: check the size of `crm.tasks` and `crm.calendar_events` on production, `lock_timeout`, rerunnable, applied before the code ships. This fits after Tasks Phase 3; Tasks Phases 4 to 7 can follow or interleave.

## Copy changes to veto

Calendars, Tasks (left menu sections), Plan, Apply, Cancel, Overdue, Move, Move all, Leave, Couldn't fit, Next free day, Outside hours, Replan my blocks, Schedule, Duration, Working hours, Learned times, Reset, Reconnect to put task blocks in Outlook, "Pick a time for the reminder", "Clashes with {meeting}", "Calls in the morning, as you usually do".
