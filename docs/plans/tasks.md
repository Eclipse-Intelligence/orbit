# Tasks plan: connected, quick to act on, and run with the agent

Status: settled with Mark (2026-11-12), written from three Fable reviews of the code and revised after a Fable review of the plan. Mockups approved by Mark (2026-11-12). Nothing is built yet.

## What Tasks becomes

A task is the next thing to do with a person, company or opportunity, and everything needed to do it sits on the task:

- **Always linked.** Every task names the person, company or opportunity it is about, however it was created: by Mark, the assistant, an MCP agent, a workflow, an email, a call summary or a lead. Names in the title, colleagues included, are links.
- **Act from the task.** A call task shows the number with Call and Copy. An email task opens compose to that person, or replies on the linked thread. A meeting task invites or copies the booking link. Done can log what happened and set the next task.
- **Quick to add, opens in place.** Adding a task is a compact card that shows what it understood and who it will link before you save. A task expands inline in the list. The side panel is only for discussion and notes.
- **The agent does the groundwork.** It links records, prepares a call brief or an email draft, suggests the next task when one is done, and puts the day's tasks in the morning brief.

## Decisions settled with Mark (2026-11-12)

1. **The kind of task (call, email, meeting, to do) is worked out from the title, not stored.** It only decides which action comes first; every action is always available. Store it later only if Mark wants to filter by kind.
2. **Inline expand replaces the panel as the default.** The panel stays for discussion, notes and deep links, and stops dimming and blurring the page on desktop.
3. **Only a certain match links on its own.** A unique full name links silently: a contact's first and last name, a company or opportunity name of two or more words, written with its capitals. A first name, a surname, a one-word company name (Zoom, Chase, Monday, Northwind), or a name shared by two records is offered under "Link a person" and never guessed. When Mark types a task himself, a one-word company match is shown on the card before saving, like a first name, and saving confirms it (decided by Mark, 2026-11-12).
4. **What Mark sets stays set.** An id passed on creation is never replaced, and "none" (a workflow step set to link nothing) stays none. Detection only fills a task that arrives with no links at all.
5. **Done becomes E** on the Tasks page to match Mail and Capture, with D kept as an alias. Z undoes.
6. **No new assistant tools.** The assistant is at its cap of 126 (`tests/agent-docs.test.ts:83`), so existing tools are extended.
7. **Clicking a colleague's name opens a direct message with them in Chat.**
8. **Prepare runs automatically each morning for tasks due that day**, as well as on demand.
9. **Phone swipes as in Capture:** left for Done, right for Remind me (decided by Mark, 2026-11-12).

## Phase 0: mockups (approved by Mark, 2026-11-12)

Desktop and phone: the new Add task card, collapsed and expanded rows, the expanded call, email and meeting variants (including a contact with no number and a company-only task), "Link a person", complete with an outcome, the slimmed panel, and tasks on a contact page. The approved mockups are `docs/plans/tasks-mockups.html`; build to them. Every "Choice to approve" at the end of that file is approved, including this refinement of decision 3: when Mark types a task himself, a first name that matches exactly one contact is shown on the card as that person before saving, and Add task confirms the link. Tasks from the assistant, agents, workflows and email never link on a first name.

## Phase 1: every task linked, names are links (one PR, medium, no migration)

### Linking on creation, every route
Every route inserts through `createTaskInDb` (`lib/crm/tasks.ts:277`, the only insert into `crm.tasks`): the Tasks page and Add task, quick capture (`lib/quick-capture.ts:39`), the assistant, MCP, the REST API, workflows, Remind me (`lib/mail/deferrals.ts`), inbox and logged-communication follow-ups (`lib/crm/inbox.ts:795`, `lib/crm/communications.ts:206`), the activity pad's next task (`lib/crm/activity-pad.ts:88`), call insights, leads, the extension and ClickUp import.

- **The rule.** `undefined` means "not given, detect"; `null` means "deliberately none". Detection runs only when company, contact and opportunity are all `undefined`, so a detected contact can never clash with a supplied company (`lib/crm/links.ts`). ClickUp imports always arrive linked or are ignored (`lib/crm/clickup.ts:776`), so they are untouched.
- **Callers follow the rule.** The assistant's `create_task` stops sending `null` for links it left out (`lib/assistant/tools.ts:3314`). Workflow steps set to "none" keep sending `null`.
- **The matcher** moves from `detectPadRecords` (`lib/crm/task-pad.ts:28`, which opens its own `withActor` for a `UserActor`) to `detectTaskRecordsInDb(db, workspaceId, text)`, which runs on the caller's `db`, so it works for user and agent actors alike. It adds opportunities, skips names that belong to workspace members, and links silently only on a unique full name: never a one-word company or opportunity name on the server (the add card shows a one-word company for Mark to confirm). A contact found also fills its company.
- **Cost.** Skipped whenever any id is supplied. Check production contact and company counts first; add a trigram index if the scans are slow.
- **Audit.** The create event's provenance records which links were detected, so webhooks and workflows can tell.
- **Call insights.** An action item that names someone else ("Call Sarah Jones") links to that person, not to the person on the call (`lib/crm/call-insights.ts:752`).
- **Workflows.** New create task steps default to linking the contact when the run has one. Existing steps keep their setting (`lib/workflows/engine.ts:916`).
- **Agents are told.** The assistant's `create_task` gains `opportunityId`, and its description and the prompt guide say to look up and pass the person and company. MCP `create_next_action` already takes all three (`server/mcp/relationships.ts:374`); its description gains the same instruction.
- **Mail follow-ups carry their thread.** Suggested follow-ups (`lib/mail/timeline.ts:170`, `lib/crm/inbox.ts:795`) add the thread link the way Remind me does, so Reply in Phase 3 covers them.
- **Existing tasks.** A one-off backfill applies the same full-name rule to open unlinked tasks, through `withActor` per workspace.
- **Tests:** every route above without ids ends up linked; first-name and shared names stay unlinked; supplied ids and `null` are never overridden; teammate names are skipped; an agent actor can detect.

### Names become links
- In the row and the panel, the linked contact's, company's and opportunity's names in the title render as links, matching the full name, first name or surname ("Call Sarah" with Sarah Jones linked). Matched at render against the task's own links, so no extra queries.
- **Colleagues.** A workspace member's name in the title, and the assignee and tagged people, render as links too (they open a direct message with that person in Chat). Naming a colleague never changes the assignee.
- The row shows the contact and opportunity as well as the company.
- **Link a person.** An unlinked task works out its candidates when it is expanded, not for every row, and offers them in one click.

### Fix the silent 100 limits
- The tasks view and the companies view both stop at 100 with no sign (`lib/crm/relationships.ts:213`, `:225`). `pageWindow` caps a page at 100 (`lib/crm/mutate.ts:38`), so Show more loads the next page.

## Phase 2: the new task list and Add task (one PR, large, no migration)

### Adding a task
The Add task dialog from the bottom-right button (`components/crm/quick-add-forms.tsx:215`) is the weakest screen in Tasks today:
- A header and a divider frame a single field, so it reads as a box inside a box with nothing in it.
- The placeholder wraps onto two lines inside a pill-shaped field.
- The large purple send circle sits off the text line.
- Due, reminder, person, company and assignee are hidden until you type (`components/crm/task-pad.tsx:347`), so the dialog looks empty and gives no hint of what it can do.
- Nothing shows what the task will be linked to until after it is saved.

It becomes a compact command-bar card, the same component at the top of the Tasks page and in the dialog:
- One large borderless title line with a one-line placeholder ("Call Jane Monday 3pm").
- A row of chips always visible underneath: Due, Remind me, Person, Company, Opportunity, Assignee. They start as quiet placeholders and fill in live as the text is understood, with the matched person or company shown by name. An uncertain name shows the choices right there.
- A slim footer: the ClickUp list on the left, and a `Button` "Add task" with its Enter shortcut on the right. No header bar or divider.
- On a phone it opens as a bottom sheet with the keyboard up and the chips scrolling sideways.

### The list
- **Inline expand.** One row open at a time. Shows due, reminder and assignee as editable chips, quick dates (Tomorrow, Next week from `taskSnoozeChoices`), the description, the linked records, and the action strip from Phase 3. Title and description edit in place. Starts from the markup removed in `cee18de`.
- **Shared fields.** Extract `TaskFields` from `components/crm/task-panel.tsx` so the row and the panel never diverge.
- **Keyboard on the Tasks page.** j/k move (the expansion follows when open), Enter or Space expand (the existing `task-expand` entry, `lib/shortcuts.ts:141`, becomes true again), Shift+Enter or O open fully, E done (D alias), H Remind me, Z undo, Esc collapse. Update the help.
- **Keyboard on record pages.** E (Edit) and j/k (next and previous record) keep their record meaning (`lib/shortcuts.ts:152-155`). Task rows there are opened and completed by click or tap.
- **Rows.** One-line description preview on wider screens. Done takes effect at once, with undo. Group headings in All: Overdue, Today, Upcoming, No date.
- **Panel.** A new non-modal option on `SheetContent` (about 20 call sites keep today's default). Without the focus trap, list shortcuts are ignored while typing in the panel, and clicking another row switches the panel to that task. No repeated footer, Done on the title circle, a wider panel on iPad.
- **Record pages.** Tasks on contact, company and opportunity pages use the same row, so they can be expanded, completed and opened.
- **Phone.** Tap expands; Open goes to the full-width sheet. Swipes as in Capture: left for Done, right for Remind me.
- **Safari.** Animate the expansion with `grid-template-rows` only. Run the WebKit sweep.

## Phase 3: act from the task (one PR, medium, no migration)

- **Contact strip.** Name, job title, phone and email, loaded by extending `TASK_SQL`. Call opens Teams (`teamsCallUrl`, `lib/phone.ts:19`) on desktop and `tel:` on phones; Copy uses `CopyButton`.
- **No number.** A contact with no phone shows "No number" with Ask Orbit to find it (the assistant's `find_contact_details`). A company-only task offers the company's contacts to pick from, which also links the task.
- **Email.** Opens compose to the contact (`openComposer`, `components/mail/compose-dock.tsx:328`), with Use template. A task from an email offers Reply on that thread (`threadHref(key, "reply")`, `lib/mail/view.ts:191`), shown only when the thread is in the viewer's mailbox.
- **Meeting.** Invite opens `InviteDialog` with the contact as guest. Copy booking link.
- **Primary action by kind.** Call tasks lead with Call, email tasks with Email, meeting tasks with Invite.
- **Context.** Opportunity stage and value, the last activity and the viewer's own last email with the person, loaded when the task opens.
- **Done with an outcome.** On a linked task, Done offers a short note that goes on the timeline ("Shows on Jane's timeline") and a next task, reusing `ActivityPad` with `fixedContact` and `fixedCompany`. Skipping it just completes.
- **Edit links.** Change the contact, company or opportunity from the task. The add card also detects opportunities.

## Phase 4: the assistant and agents (one PR, small to medium, no migration)

- **The assistant knows the open task.** Add `task` to `PAGE_FOCUS_KINDS` (`lib/assistant/page-context.ts:11`) with the title, description, linked records with phone and email, opportunity stage and last activity. Widen the path gate (`page-context.ts:406`) so this works on record pages too. An Ask Orbit button on the task.
- **Extend existing tools.** The assistant's `update_task` relinks company, contact and opportunity. MCP `update_next_action` already can (`server/mcp/operations.ts:126`).
- **Call outcome in one message.** A guide in `lib/assistant/guides.ts` so "spoke to Jane, she wants the proposal Friday" becomes log activity, complete the task and create the next one, as cards in one turn.
- **Checks.** Update `docs/assistant.md` and `docs/mcp.md`, the offline harness, and add eval tasks for linking and call outcomes.

## Phase 5: Prepare (one PR, medium, migration)

- **Call tasks** get a brief: who they are, last contact, opportunity stage, open points from the last call, talking points.
- **Email tasks** get a draft that opens in compose. Nothing is sent until Send.
- One `completeJson` call using the voice and context the prepared replies already use (`lib/mail/prepare.ts`).
- **Stored per person.** A new `crm.task_preparations` table keyed on task and user, with RLS on the user, because a brief is built from that person's mail and voice and tasks can be reassigned or seen by creators, admins and tagged people. Each viewer prepares their own.
- On demand, and automatically each morning for tasks due that day. The background run goes through `/api/cron/mail` (not the one-minute `mail-due`), behind its own personal setting in Settings › Tasks, on by default.

## Phase 6: proactive (two PRs, small to medium, one migration)

- **Morning brief** lists overdue and due-today tasks, and suggests a task for each opportunity that has gone quiet (`lib/learning/nightly.ts`, renaming its "Deals gone quiet" to "Opportunities gone quiet"). "Create those" in the dock makes them through approval cards.
- **Next step** starter workflow on `task_completed`: the AI proposes the next task, approved before it is created.
- **Reminders reach a locked phone** through web push from the cron. Needs a migration for a "reminder sent" marker so a push is sent once (today's reminders are a browser poll, `components/crm/task-reminders.tsx:58`).
- **Smarter Mail follow-ups**: titled from the email, not "Follow up with X".

## Phase 7: a real thread link (one PR, medium, migration)

- Add `mail_thread_key` to `crm.tasks`, replacing the markdown link in the description. Backfill by parsing existing descriptions.
- Follow the migration rules: check the table size on production, `lock_timeout`, an idempotent backfill in batches.
- The subject is resolved for each viewer. A teammate or admin without access to the thread sees "Email" and no subject, which closes today's small leak of the subject through the description.
- Add task from a Mail thread pins the thread.

## Cross-cutting

- **Privacy.** Contact details are shared records, so showing them is fine. Anything from Mail (last email, thread subject, Reply) is read as the viewer through `withActor`, never joined into `TASK_SQL`. Preparations are private to the person who made them.
- **Audit.** Detected links are part of the create event and marked as detected. Relinking is an update with provenance.
- **Checks.** Each phase: `tsc`, `eslint`, the related tests, the production build at desktop and phone sizes, `npm run sweep`, and a WebKit sweep for Phase 2.

## Order

1. Phase 0 mockups, approved.
2. Phase 1 first: it fixes unlinked agent tasks and the silent limits, and everything after depends on links.
3. Phases 2 and 3 together, since the action strip lives in the expanded row.
4. Phase 4, then 5, then 6 and 7.

## Copy changes to veto

Open, Open discussion, Remind me (on tasks), Link a person, No number, Shows on Jane's timeline, Ask Orbit, Prepare, Show more, Opportunities gone quiet, and the Done shortcut moving to E on the Tasks page.
