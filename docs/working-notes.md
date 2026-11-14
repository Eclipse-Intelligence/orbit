# Working notes

These are the habits and decisions settled with Mark while building Orbit. Read them alongside `CONVENTIONS.md` before you start. Where the two differ, these notes are the newer decision.

## How to work

- **Answer questions first.** When Mark asks "why is X?" or "does it?", answer and stop. Offer a change, but don't start editing until he says so.
- **Don't change what wasn't asked for.** Test what a change could break as well as what it adds. If a change touches a shared hook or primitive, check every place that uses it.
- **Keep designs simple.** Each setting lives in one obvious place, either "this workspace" or "you, everywhere". No shared value with per-workspace overrides. Mock up structural changes before building them.
- **Mockups first for big features.** Get them approved before writing code.

### Checks before merging

- **Tests:** run `npx tsc --noEmit`, `npx eslint .` and the test files related to the change:

  ```bash
  LLM_API_KEY= TYPESAFE_API_KEY= DATABASE_URL=postgres://crm_app:crm_app_dev@127.0.0.1:5432/crm_test DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/crm_test APP_SECRET=test-secret-value npx tsx --test --test-concurrency=1 tests/<area>*.test.ts
  ```

  The full `npm test` takes 10 to 15 minutes; run it when a change is broad.

- **Shared test database:** two agents using `crm_test` at the same time break each other's runs. Give each parallel run its own database, for example `createdb crm_test_<name>`, then use the command above with that name in both URLs.
- **No real-model evals.** Mark doesn't run `npm run eval` against the real LLM API, and doesn't want to be asked for the key. Check assistant changes with the offline harness (`tests/assistant-evals.test.ts`) and unit tests. Adding tasks under `evals/tasks` is still fine.
- **Never call real services from tests.** Always run with `LLM_API_KEY` and `TYPESAFE_API_KEY` empty. `npm test` already blanks them.
- **Phone sweep for UI changes.** Run `npm run sweep` against a running app. It checks the core flows on iPhone (390x844) and iPad (820x1180) sizes: Mail, the assistant, quick add, a record page, the board, an opportunity, Tasks, Calendar, Settings, Workflows and the menus. Check that things are visible, not just present.
- **Safari.** Mark uses Safari on his Mac, iPhone and iPad. Treat any change to how emails or iframes render as Safari-risky.
  - Never animate opacity, transform or height on the email iframe or its close ancestors. That made plain emails go blank in Safari (fixed in PR #296).
  - Run `BROWSER=webkit npm run sweep` (after `npx playwright install webkit`) or ask Mark to check in Safari before merging.

### Reviews

- **Fable review with the 800 line rule.** For anything non-trivial, launch one reviewer agent on Fable. It measures the changed lines and spawns one sub-agent per 800 lines (rounded up), each owning a coherent group of files. Give it file and PR pointers, not your conclusions. When Fable is rate-limited, use Opus 5.5 with the same structure.
- **Send fixes back to the agent that built the branch.** Re-review until there are no blockers. Several features needed three rounds.
- **Review the whole area once it's finished.** After the last PR for a feature area, run one review across the whole area, not just the per-PR diffs: workspaces, concurrent requests, retries, and every route that writes the record (web, API, MCP, assistant, workflows, background jobs).
- **Close every review point before merging.** Each point is either fixed or explicitly accepted by Mark. Never leave one as a nit or an open question. Every round of fixes gets re-reviewed.

### Migrations

- **One file per change**, written so it can run twice. Check the size of the tables it touches on production first. Use `lock_timeout`, `create index concurrently` (in its own statement), and no long transactions on busy tables like `crm.mail_messages`.
- **Applying to production:**
  1. Try the Supabase MCP `apply_migration` with the schema SQL only. It is often declined.
  2. If it is declined, give Mark the full SQL inline in one block, with the record insert at the end:

     ```sql
     begin; set local role crm_admin; insert into private.schema_migrations (filename) values ('...'); commit;
     ```

  3. After he says it's done, check with a read query that the objects actually exist, not just the record row.
- **Redefining a function** such as `private.move_personal_rows`: start from its latest definition in `supabase/migrations`, not an older one. Make sure whichever migration runs last on production keeps every branch's changes.

### Merging and deploys

- **Branches:** one branch and PR per feature, merged with a merge commit.
- **Deploys:** check them with `gh api repos/Eclipse-Intelligence/orbit/commits/<sha>/statuses`. If a merge lands but Vercel never builds it (this happened after a GitHub 502), trigger a production deployment from the full commit sha with the Vercel MCP `create_deployment`.
- **Cleanup:** confirm the merge (`gh pr view --json state,mergedAt`) before deleting a branch or worktree. Never chain clean-up after a merge with `;`.
- **Agent worktrees:** these sit on branches named `worktree-agent-<id>`. A bare `git push` from one updates nothing. Push with `git push origin HEAD:<pr-branch>` and check with `git ls-remote --heads origin <pr-branch>`.
- **Linear:** the backlog is the Linear project Orbit (P-CNT-6) in the Cntent team. Write PR references there as full GitHub URLs, because a bare `#123` links to the wrong repository. Comment on the project when a feature ships.

## Product decisions

### Copy

- **Terse, internal copy.** Orbit is an internal tool. Keep labels as short as or shorter than they were. No taglines or marketing lines, except on client-facing pages (`/p` proposals, `/book`). List copy changes in your summary so they can be vetoed.
- **Settled terms:**
  - **Opportunity** everywhere, never "deal".
  - **Ideal customer** for the ICP text, and **Fit** for the score.
  - Brand **Tone**, which is separate from the personal "How you write".
  - **Settings › Email** in cross-links, never a bare "in Email".
  - **Add Microsoft account**, not "Add account". Keep the line "Reconnect only accepts this address."
  - **Remind me**, not Snooze.
  - Errors read **"Couldn't X. Try again."** Use **Save** and **Saved**.
  - **Delete** destroys something. **Remove** takes it out of a group. Exits are labelled **Cancel**.
- **Lines to keep:** lines about who can see something, outward effects ("Nothing is sent until you press Send.") and preconditions.

### AI

- **Context is unrestricted.** No caps on what the assistant or AI features read unless there is a stated technical reason: model window, provider limit or time budget. Cost alone is not a reason for the chat. Don't accept review suggestions that trim context.
- **What Mark enters is authoritative.** No approval fields, review dates or cross-checks against his own data. Guard only against invention.
- **Keep existing providers.** New APIs add capabilities or fill gaps; they never replace or overwrite context.dev, Mindcase, Hunter and the like unless they're clearly better and Mark agrees.
- **The Web switch** in the assistant only stops model web search. Page reading, `check_web` and LinkedIn lookups stay available.
- **Claude-plan models** run through Orbit Agent (`companion/`) on Mark's Mac. Don't revisit that decision.

### Workspaces

- Mark runs two workspaces, Eclipse and Mark Ridgeon. Only owners create workspaces.
- **Mail and calendar are personal**, the same in every workspace. Switching workspace never hides email.
- **Only people in more than one workspace see any sign of other workspaces**: menus, labels, Move to, pickers, held Meta leads.
- **Personal:** daily notes, About you, signatures, AI accounts, Orbit Agent.
- **Per workspace:** Docs, business notes, email templates, ClickUp, enrichment, assistant chats.

### Mail and Capture

- **Superhuman is the reference for Mail:** keyboard first, optimistic, floating compose cards over modals, borderless, swipes on phones. The inbox page is called Capture (`/capture`).
- **Capture only asks about mail from people Mark might do business with.**
  - Anyone he has written to or met always shows.
  - When in doubt, show.
  - Debt collector domains are hidden whole, as he asked.
  - Only strictly automated senders are hidden without asking the AI.

### Other pages

- **Calendar:** event descriptions are private to the event's owner. A join link found only in a description shows to the owner and to invited teammates, matched on proven addresses.
- **Booking page (`/book`):** the card over a full-screen background is intentional. Don't centre it or fill the sides.
- **iOS home screen icon:** keep the inlined data URI in `lib/apple-touch-icon.ts`. iPadOS 27.2 shows a letter otherwise.
- **Docs:** private by default with one-click sharing. It has `[[links]]`, `#tags`, `@records`, daily notes and live co-editing, including agents.

## Open follow-ups

- **Meta Lead Ads** is live for the Ridgeon Consultancy Page (webhook on the app's Page object, `leadgen` subscribed, Page subscribed to the app). `META_ACCESS_TOKEN` must be a long-lived Page token or System User token; a Graph Explorer token expires within hours.
- **Meta lead behaviour:**
  - Phone-only resubmissions create a new contact each time.
  - The held-Page list stops at 50.
  - The daily held-lead reminder repeats until it is sorted.
  - The Graph version `v27.0` is unconfirmed.
- **Capture:** memories learned before a thread was marked Personal aren't removed.
- **Calendar:**
  - Proven addresses trust Microsoft Graph's `mail` field.
  - Calendar links (ICS) can lag up to six hours.
  - The Calendar page sends every event's notes to the browser.
- **Mail errors:**
  - `lib/mail` `GraphMailError` still shows raw Graph text.
  - `inbox.ts`, `follow-ups.ts` and the agent mailbox still use `Error.message`.
  - Some SQL `raise` messages still say "Pick…" or "deals".
- **Open decision:** should proposal and workflow emails get read statuses? Today they follow the read status setting.
- **Safari checks:** instant send, contact emails, and the calendar notes clamp.
- **Live drafts:** a rebuild after the live state passes 1MB drops keystrokes typed during that sync (rare; bodies are capped at 20,000 characters).
