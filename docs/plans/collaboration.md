# Collaboration plan: Chat, mentions, shared emails, tasks and docs

Status: draft, revised after two Fable reviews against the code (2026-11-11). Nothing is built yet. Guiding test for every choice: simple, reliable, slick, fast.

## Decisions settled with Mark (2026-11-11)

1. **Shared emails send from the owner only.** The person whose mailbox holds the thread is the only one who can press Send. Invited teammates can read the thread and co-edit its drafts live, but cannot send, reply from it, or change anything in the owner's mailbox. The same in both directions.
2. **Sharing is per thread.** A shared thread stops being private for the people it is shared with. Nothing else in the mailbox is exposed.
3. **Tagging in Docs only works in shared docs.** Tagging someone in a private doc asks to share it with the workspace first. No people tags in daily notes.
4. **Chat is global, like Mail.** One Chat across every workspace. Rooms are private to their members; a room may be linked to a workspace, which limits who can join to that workspace's members.
5. **Name: Chat.** Messages in a room or DM, with Slack-style threads: replying to a message opens a thread on it.
6. **The assignee can hand a task on** to someone else.
7. **The creator is told when someone else completes their task** ("Done by John").
8. **Only the owner adds people to a shared email.**
9. **Attachments on a shared email are visible to the people it is shared with.**
10. **Tagging someone in a task gives them access** to the task, its notes and its discussion.

## The core idea

Rooms, DMs and the discussions under a task, a doc and a shared email are one thing: a conversation of messages, where a message can have thread replies. One set of tables (`crm.chat_*`, avoiding `lib/crm/conversations.ts`, which is calls, and `crm.assistant_conversations`), one composer, one alert path.

| Kind | Who can see it | Check | Shown where |
| --- | --- | --- | --- |
| `room` | Members | `id in (select private.my_chat_ids())` | Chat |
| `dm` | The two people | Same | Chat |
| `task` | Whoever can see the task (owner, creator, owners and admins, and people tagged in it) | `exists` on `crm.tasks` under the caller's own policies | Task panel |
| `doc` | Whoever can see the doc; shared docs only | `exists` on `crm.pages` under the caller's own policies | Doc page |
| `mail_thread` | The owner and the share's members | Share membership helper | Shared email |

## Phase 0: mockups (approved by Mark, 2026-11-11)

The approved mockups are `docs/plans/collaboration-mockups.html`; open it in a browser. Build to them. Every "Choice to approve" listed at the end of that file is approved, and these follow-up decisions are settled:

- **Threads view** shows threads from rooms and DMs only. Task, doc and shared email discussions are not listed there.
- **Rooms:** any member can rename a room, add or remove members, and manage its incoming webhooks. No archive in v1.
- **Shared emails:** the owner removes people one at a time; there is no "stop sharing with everyone".
- **Threads:** no unfollow and no "also send to #room" in v1.
- **Alerts** go out for: mentions, DMs, replies in a thread you follow, tags in tasks and docs, task assigned or handed to you, "Done by John", an email shared with you, and being added to a draft. Room messages without a mention never reach the bell or push.
- **Failed sends** read "Couldn't send. Try again." with Try again as the button.

What the mockups covered:

- The `@` picker: people first, then records.
- Chat on desktop and phone: sidebar, room, thread panel (side panel on desktop, pushed screen on phone), DMs, Threads view, room settings, empty states.
- The task panel and the doc discussion panel, desktop and phone.
- A shared email in the teammate's Mail and the owner's share control.
- A co-edited draft as the teammate sees it ("Only Mark can send", and the draft's attachments listed, with only Mark able to add or remove them).
- The share-to-tag dialog in Docs.

## Phase 1: alerts and people mentions (one PR, medium)

### Alerts
- **Copy the Meta leads pattern** (`lib/crm/meta-leads.ts:865-906`): for each recipient, act as them through `memberActor`, write the bell row and the `push_log` key in one transaction, then push. This runs from `afterCommit` (`lib/crm/context.ts:20-36`, which already wraps `after()` with try/catch). No new definer function.
- **One shared `alertMembers(actor, recipients, alert)`** wrapping that, with recipients processed in parallel under a time budget.
- **Which workspace the bell row lands in:** tasks and docs use the subject's workspace, because `tasks` and `docs` links are rewritten into a workspace switch (`lib/open-link.ts`, `alertLink` in `lib/crm/workspaces.ts:44`). Chat and shared mail use the recipient's home workspace. `chat` isn't in `OPEN_SECTIONS`, so its links already open unchanged.
- **Bell sources:** `sendAlert` gains a `source`. The bell queries that hard-code `source = 'mail'` (`lib/workflows/store.ts:586`, `:607`) also accept `chat` and `mail_share` in every workspace.
- **Alert text is generic** for every kind ("Sam mentioned you in #sales", "Mark shared an email with you"), never message or email content, because bell rows outlive access.
- **One setting:** a "Teammates" push switch, stored as a column on `crm.mail_preferences` and read as `lib/mail/notify.ts:26` does. The bell always records.
- **iOS push:** each push carries a tag per conversation, so a burst of replies replaces itself, and the app badge is the combined unread count.

### Live bell and live counts
- **Add an `alert` event to `LiveEvent`** and thread it through `watchLiveActivity` (`lib/docs/live/client.ts:490`, which today keeps only `writing`), on the existing `docs-person:<uid>` channel.
- **No new store.** The bell is already a client component fed through `AttentionProvider` (`app/(crm)/layout.tsx:109`, `:144`). It adds a `listNotificationsAction`, called on the event and on focus (as `components/mail/mail-unread.tsx` does), and merges new rows with its local read state.
- **Without Realtime** (local dev without a service key), poll every 60 seconds while the page is visible.
- **One batched broadcast call** per commit for all recipients, instead of one HTTP call per topic (`lib/docs/live/broadcast.ts:69-76`).

### People mentions
- Add `member` to `MENTION_KINDS` (`lib/mentions.ts:1` and its regex at `:8`), the three Docs regexes (`lib/docs/markdown.ts:17`, `lib/docs/editor/syntax.ts:10`, `lib/docs/editor/plan.ts:31`), the three `Record<MentionKind>` maps, the `page_links` kind check, and `recordHref` (`lib/docs/routes.ts:84-90`).
- People come from `listMembers` (`lib/crm/companies.ts:602`). `searchMentionsAction` returns them as their own group.

## Phase 2: Chat (one PR, large)

### Tables
- `crm.chat_conversations`: `id`, `kind`, `workspace_id` (rooms only: the optional link, `on delete set null`), `name`, `task_id` / `page_id` / `mail_share_id` (one per kind, cascading with the subject), `dm_key` (the two user ids sorted, unique), `created_by`, `created_at`, `archived_at`. Partial unique indexes give one discussion per task, page and share.
- `crm.chat_members`: `conversation_id`, `user_id`, `last_read_at`. Used by rooms and DMs only.
- `crm.chat_messages`: `id`, `conversation_id`, `parent_id` (thread root, one level), `author_user_id`, `author_name`, `client_key`, `body` (light Markdown), `mentions uuid[]`, `reply_count`, `last_reply_at`, `edited_at`, `deleted_at`, `created_at`.
  - Unique `(author_user_id, client_key)`.
  - Index `(conversation_id, created_at desc, id desc) where deleted_at is null`.
  - Index `(parent_id, created_at, id)`.
- `crm.chat_thread_reads`: `message_id`, `user_id`, `last_read_at`, index `(user_id, last_read_at)`. Having a row means you follow the thread: you started it, replied or were mentioned.
- `reply_count` and `last_reply_at` are kept by a security-definer trigger on insert and delete. No one updates another person's message.

### Creating, and row-level security
- **Creation goes through definer functions** called with `query()`, because under membership-only visibility the creator can't see a new row before their member row exists:
  - `private.chat_create_room(actor, name, workspace, members)`: members must share a workspace with the actor, or be in the linked workspace.
  - `private.chat_open_dm(actor, other)`: an upsert on `dm_key`, so two people starting a DM at once get the same one.
  - Task, doc and mail discussions are created on first message with an upsert on the partial unique index, then selected.
- **Policies:** enabled and forced. Select through the table above. Insert own messages only into conversations you can see. Edit and delete own messages only. Visibility never uses `workspace_id in (select private.user_workspace_ids())`.
- **Leaving a workspace** removes you from rooms linked to it. Nothing else is removed; DMs and unlinked rooms keep their history, with `author_name` stored on each message.
- Chat is personal data like Mail: no `recordAudit`, no outbound webhooks. `private.move_personal_rows` needs no change; a test checks chat survives a person moving workspace.

### Live
- **`chat:<id>` topics,** added to `parseTopic` and `canonicalTopic` (`lib/docs/live/protocol.ts:44-59`), `relay-access.ts`, the relay route's event list, and new `realtime.messages` select and insert policies through `private.my_chat_ids()`. `chat:<id>` carries typing only (presence isn't allowed).
- **The server is the authority.** Messages are written by a server action, then broadcast once per commit as a `chat` event on each member's person channel only, never on `chat:<id>`: members can write to that topic, so payloads there can't be trusted, and a removed member may still be joined to it. A removed member's writes are refused and a `removed` event is sent; Realtime only checks policy at join, so clients can't be trusted to drop themselves.

### UI
- **Navigation:** Chat in the sidebar with an unread badge, not filtered by workspace. Workspace labels on rooms only for people in more than one workspace.
- **Sidebar:** Threads, Rooms, Direct messages. Unread in bold, mention counts as badges. One query from `chat_members` with a lateral, capped unread and mention count.
- **Composer:** `components/assistant/mention-input.tsx` (people and records). An unsent draft is kept per room. Enter sends, Shift+Enter adds a new line.
- **Optimistic send:** the message appears at once with a `client_key`, and the server's broadcast replaces it rather than duplicating it. A failed send shows Retry in place.
- **Reading:** an unread divider, keyset pages on scroll, scroll position held when older messages load above, and a jump to the latest message.
- **Messages:** edit and delete your own (Up arrow edits your last message), and Reply in thread. Roots show the reply count, avatars and last reply time.
- **Keyboard first,** listed in the shortcuts sheet.
- **Phone:** list, then room, then thread as pushed screens. The composer sits above the keyboard using the `visualViewport` handling in `components/mail/compose-dock.tsx:172`. Tested in Safari on iPhone and iPad.
- **Not in v1:** group DMs (use a room), files, reactions, pinning, room topics, per-room notification levels, search beyond the current room.

## Phase 3: Chat from outside (three PRs, medium each)

1. **MCP and assistant.**
   - `server/mcp/chat.ts`: `chat_list`, `chat_read`, `chat_post`, for every personal token, with no extra switch: Chat only reaches teammates and messages can be edited or deleted, unlike email.
   - Posts take an optional `idempotency_key`, stored as `client_key`, never `replayOrRun`, whose responses the whole workspace can read. Rate limit through `private.consume_rate_limit` with `query()` after the dedupe check.
   - **The assistant gets one tool, `team_chat`, with a `read` or `post` action.** The assistant is at its 126 tool limit (`tests/agent-docs.test.ts:79`), so two tools would fail the test. Posting goes through the approval card, and chat text is fenced as external content (`EXTERNAL_TOOLS`, `lib/assistant/tools.ts:5842`).
   - Update `docs/mcp.md` and `docs/assistant.md`.
2. **Workflow step "Post to Chat".** Posts as the workflow owner into a room they belong to, with `client_key` built from run id, step id and loop indexes, so a reclaimed run (`20261104100000_workflows.sql:299`) never double-posts. Register it in `STEP_TYPES`, `SIDE_EFFECTS` (`engine.ts:814`), the labels, `variables.ts`, `workflow-editor.tsx`, `canvas/node-meta.ts`, `step-config.tsx` and the assistant's workflow help.
3. **Incoming webhooks into a room.**
   - Room settings › Add incoming webhook gives a URL `/api/chat/hooks/<id>` and a secret shown once (stored as a hash). Senders use `Authorization: Bearer <secret>`, which Zapier and Make support. No `?key=`.
   - Body `{ "text", "title"?, "url"? }`; other JSON is shown as a formatted block. Hook messages never carry mentions.
   - One `query()` into `private.chat_hook_post` does the lookup, rate limit, `Idempotency-Key` dedupe and insert. Hooks can be paused, rotated and deleted.
   - Google Analytics reaches #alerts through Zapier or Make.

Deferred: agent tokens in Chat, REST `/api/v1/chat`, signed hooks.

## Phase 4: Tasks (one PR, medium)

- **Assign:**
  - An Assign control in the task pad and task panel, listing workspace members.
  - The task pad action takes `ownerId` (`app/(crm)/task-pad.ts:29-36`). `owner_id` stays the assignee.
- **Task panel:** a `Sheet` with title, description, due date, assignee, linked records and the discussion. On phone it is a full-screen sheet.
- **Tagging gives access.** Tagging a workspace member in a task discussion adds them to `crm.task_participants (task_id, user_id, added_by, created_at)`.
  - The tasks select policy gains `id in (select private.my_task_ids())`, a definer helper over that table, so participants see the task, its description and notes, and its discussion.
  - Participants are not in `tasks_update_member`'s `using` clause, so they can read and discuss but not edit, complete or reassign. A participant can be made the assignee like anyone else.
  - Anyone who can see the task can tag others. Owners, creators, admins and the participant themselves can remove a participant.
- **Lists stay clean.** Many task reads rely on row-level security alone (record pages, counts, the assistant's `list_tasks`). "Mine" counts only tasks you own. Tasks you are tagged in get their own Tagged filter, and record pages and counts don't change, because their queries filter on owner explicitly. Each of these reads is checked and tested.
- **Handing a task on:** the assignee can reassign, as the update policy already allows (`20261103100000_team.sql:354-364`).
  - Today the request fails afterwards because the previous assignee can no longer see the row (`lib/crm/tasks.ts:281-293`).
  - Fix: in the same transaction, the person handing it on becomes a participant, so they keep sight of it and its discussion.
  - `tests/team.test.ts:132` changes from expecting the refusal to expecting the hand-on.
- **Alerts, sent from `lib/crm/tasks.ts`** so every route that assigns (app, MCP, REST, assistant, workflows) alerts the same way:
  - assigned to you, or handed to you (not self)
  - tagged in a task
  - the creator, when someone else completes their task: "Done by John"
  - ClickUp imports never alert.

## Phase 5: Docs (one PR, medium)

- `@people` in the editor for members of the doc's workspace.
- **Enforced on the server:** `commitPage` and `createDoc` (which calls `writeIndex` directly, `lib/docs/store.ts:732`) turn `member` tokens into plain text `@Name` unless the page is shared and not a daily note. So MCP, REST, the assistant, paste and daily appends can't tag in private docs, and no dead chips remain.
- **Share and tag:** picking a person in a private doc opens a `ConfirmDialog`. Share and tag shares the doc, inserts the token and returns focus to the editor. Cancel inserts nothing and returns focus.
- **Alerts for new tags only:** before `writeIndex` replaces the links, read the current `member` links and diff in the same transaction. Alert newly added people from `afterCommit`, with a `push_log` key of page, person and day. Live saves every few seconds add nothing new after the first, so no pending table or debounce is needed.
- **Discussion panel** on shared docs, full-screen sheet on phone.

## Phase 6: Shared email threads and notes (one PR, large)

- **Tables:**
  - `crm.mail_shares`: `id`, `owner_user_id`, `source_id`, `thread_key`, `created_at`.
  - `crm.mail_share_members`: `share_id`, `user_id`, `added_by`.
  - Only the owner adds and removes people. Candidates share a workspace with the owner.
- **No new policies on mail tables and no migration on `crm.mail_messages`;** `mail_messages_thread_idx` already serves the lookup.
- **Reading:** two definer functions, called with `query()`.
  - `private.shared_threads(user)` lists threads shared with you, one row per thread, no bodies.
  - `private.shared_thread(user, share_id)` returns the messages.
  - Both leave out drafts, trash and junk, Bcc, `web_link` and `provider_message_id`, which `getThread` would return (`lib/mail/threads.ts:334-341`).
- **Owner code paths stay untouched.** Shared rows never reach archive, Remind me, reply, prepared replies, summaries or read statuses.
- **Attachments are visible to teammates.** Opening one needs the owner's Microsoft token (`lib/mail/attachments.ts:41`), so the attachment route gains a shared branch:
  - `private.shared_message_owner(user, share_id, message_id)` checks the caller is in the share and the message belongs to the shared thread (not a draft, not trash or junk), and returns the owner.
  - The server then fetches that one attachment read-only as the owner, through `memberActor` and `mailSourceToken`, the same way background sync uses the owner's token.
  - Nothing else in the owner's mailbox can be reached this way.
  - If the owner's mailbox needs reconnecting, the teammate sees "Couldn't open the attachment. Mark needs to reconnect their mailbox."
- **Teammate's Mail:** a Shared section with the owner's avatar and "Shared by Mark", not in Capture, read only.
- **Updates:** when mail sync adds a message to a shared thread, it sends one `mail_share` event to the members' person channels. `mail_versions` only covers the owner.
- **Notes:** the `mail_thread` discussion. Tagging someone not in the share asks "Add Sam to this thread?", and only the owner can confirm.
- **Removal:** refused on the server from then on, plus a `removed` event to that person.
- **Safari:** no opacity, transform or height animation on the email iframe or its close ancestors; the notes panel sits outside them.

## Phase 7a: the server keeps the text of a shared draft (one PR, medium to large)

The riskiest phase. It ships and settles before live editing.

- **Sharing a draft:** a reply draft in a shared thread, or a new email (the share starts with the draft and gains its `thread_key` when sent). Adds `draft_id` to `mail_shares`.
- **The share is the stable key.** It is repointed wherever a draft row is recreated: after an Outlook 404 (`compose.ts:384-387`), a 404 during send (`:1050`), or From changing mailbox (`:362-369`). `finishSend` (`:913`) moves the share onto the sent thread. If the owner discards the draft, the share's draft goes, and teammates see "Mark discarded the draft".
- **Teammates write through `private.merge_shared_draft`,** a definer function. It locks the row `for update` and refuses while `send_at`, `sending_at` or `send_attempted_at` is set (the 10 minute `SENDING_FRESH` rule, `compose.ts:1489`). It never touches `content_hash`. Teammates have no access to `crm.mail_drafts` otherwise (`mail_drafts_owner`).
- **When the owner saves or sends a shared draft,** `storeDraft` substitutes the row's subject and body before computing the hash (`compose.ts:379-381`). The browser's copy can then never overwrite teammates' edits on any send path.
- **The assistant (`sendForAgent`, `:1537`) and MCP `mail_save_draft`** refuse to change the body of a shared draft, so the approval card never shows text that won't be sent. `mail_send` with `draft_id` already reads the row.
- **Owner-only fields** (From, To, Cc, Bcc, attachments, signature, Send later, follow-up) come only from the owner.
- **Held drafts and the closing `keepalive` save are off for shared drafts.**
- **Undo and scheduled sends:**
  - Pressing Send broadcasts "sending", so teammates' editors go read-only (never by opacity or height), and Undo broadcasts "editing".
  - A scheduled draft stays read-only for teammates until the owner cancels the schedule.
- **SMTP sending addresses:** after sending, the share follows `sent_internet_id` to the thread.
- **Unshared drafts follow today's path unchanged,** covered by the existing mail tests plus new ones for each send path.

## Phase 7b: live co-editing of shared drafts (one PR, large)

- **Body only is live;** the subject is last write wins.
- **Reuse the Docs live client:**
  - Both editors are plain-text CodeMirror, and `LiveSession` takes its transport and server by injection.
  - New: `crm.mail_share_live (share_id, ydoc, generation)`, a `syncLiveDraft` that merges under lock through `merge_shared_draft`, and a `draft:<share_id>` topic in the protocol and policies.
- **Editor:** `components/mail/body-editor.tsx` replaces the document when its prop changes. In live mode the Yjs binding owns the text. Cursors come from `lib/docs/editor/presence`.
- **Safari:** remote edits while typing on iOS (composition) are the main risk. Test on iPhone and iPad before merging.
- **Tokens:** only the owner's autosave and Send write to Outlook. Teammates never use the owner's token.

## Cross-cutting

- **Copy:** Chat, Reply in thread, Shared by Mark, Only Mark can send, Tagged, Done by John, Share and tag, Add to this thread, Teammates. Errors read "Couldn't X. Try again." No em or en dashes.
- **Multi-workspace rule:** only people in more than one workspace see workspace labels.
- **Migrations:** named after `20270114100000`, safe to run twice, `lock_timeout` where needed, applied to production before the code.
- **Docs to update:** `README.md`, `docs/architecture.md`, `docs/mcp.md`, `docs/assistant.md`, and the privacy list in `CONVENTIONS.md`.
- **Tests** (real local Postgres):
  - Chat: policies per kind, creation functions, DM race, leaving a workspace, moving workspace, keyset paging, reply counts.
  - Alerts: alerts as recipient, landing workspace, source filters.
  - Chat from outside: MCP posting and retries, the assistant tool count, workflow step retry, hook auth, dedupe and rate limit.
  - Tasks: assignment, tag and completion alerts from every path, ClickUp silent, participants read and discuss but can't edit, handing on keeps the previous assignee as a participant, Mine and record counts unchanged by tags.
  - Shared attachments: a teammate opens an attachment in the shared thread, and is refused for any message outside it, a draft, or after removal.
  - Docs: tags stripped in private and daily docs for every write path, tag diff.
  - Shared mail: `shared_thread` excludes drafts, trash, junk, Bcc and other threads.
  - Shared drafts: merge refused while scheduled or sending, every send path carries the merged text, the share survives recreation and moves after send.
  - The offline assistant harness.
- **Checks per PR:** `npx tsc --noEmit`, `npx eslint .`, related tests, `npm run sweep` (WebKit for Mail), a Fable review with the 800 line rule.

## Order

| Phase | PRs | Size | Depends on |
| --- | --- | --- | --- |
| 0. Mockups | | Small | |
| 1. Alerts and people mentions | 1 | Medium | 0 |
| 2. Chat | 1 | Large | 1 |
| 3. Chat from outside | 3 | Medium each | 2 |
| 4. Tasks | 1 | Medium to large | 1 |
| 5. Docs | 1 | Medium | 1 |
| 6. Shared email threads and notes | 1 | Large | 1, 2 |
| 7a. Server keeps the text of shared drafts | 1 | Medium to large | 6 |
| 7b. Live co-editing | 1 | Large | 7a |

Phases 4 and 5 can run beside 2 and 3.

## Open questions for Mark

None. Every decision is settled; next is Phase 0, the mockups.
