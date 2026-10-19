# Conventions

How Orbit is built. Follow these when changing or adding code. `README.md` covers setup and features, and `docs/architecture.md` covers how the pieces fit together.

## Layout

| Path | What lives there |
| --- | --- |
| `app/(crm)/` | Signed-in pages (server components) and their server actions (`"use server"` files such as `records.ts`, `boards.ts`, `workflows/actions.ts`). |
| `app/api/` | Route handlers: the agent REST API (`v1`), webhooks, OAuth callbacks, cron and the Orbit Agent endpoints. |
| `app/login`, `app/join`, `app/book`, `app/auth` | Public pages: sign in, invite acceptance, booking pages, the Supabase email callback. |
| `lib/crm/` | Domain logic. Every function takes an `Actor` and talks to Postgres through `withActor`. |
| `lib/workflows/`, `lib/assistant/`, `lib/enrichment/`, `lib/companion/`, `lib/ai-accounts/` | Feature engines. |
| `lib/*.ts` | Clients for outside services (`llm.ts`, `linear.ts`, `clickup.ts`, `granola.ts`, `microsoft/`) and small shared helpers. |
| `components/_ui/` | Primitives (`Button`, `Input`, `Sheet`, `Popover`, `DropdownMenu`, `Switch`, `Tag`, `Asset`). |
| `components/<area>/` | Feature components, grouped by area (`crm`, `companies`, `workflows`, `assistant`, `auth`). |
| `public/assets/images/<area>/` | SVG icons and images. |
| `supabase/migrations/` | Schema, row-level security and security-definer functions. |
| `tests/` | `node:test` suites that run against a real local Postgres. |
| `companion/` | The Orbit Agent CLI that runs on a user's Mac. |

## Data and security

- Read and write through `lib/crm/*` (or a feature engine), never with ad hoc SQL in a page or action.
- `withActor(actor, db => ...)` runs as `authenticated` (or `crm_agent`) with the user's id in the JWT claims, so row-level security decides what each person can see. Never bypass it for user-facing reads.
- Shared records (companies, contacts, deals, boards, activity) are visible to every workspace member. Private by design: inboxes, calendars, OAuth tokens, assistant conversations, workflow runs, notifications, Granola keys, and tasks (owner or creator only; owners and admins see all).
- Work that must cross users (background sync, invites, workflow dispatch) goes through `private.*` security-definer functions granted only to `crm_app` and called with `query()`. Inside `withActor`, do not call `private.*` functions in a query: `authenticated` has no usage on that schema, only policies can use them.
- Every mutation calls `recordAudit` with a `Provenance`. Audit events feed outbound webhooks and workflow triggers.
- Throw `CrmError(code, message, status)` with a message a person can act on. Server actions return `{ error }` instead of throwing.

## Migrations

- One file per change: `supabase/migrations/YYYYMMDDHHMMSS_name.sql`. Write it so it can run twice (`if not exists`, `drop policy if exists`, `create or replace`).
- Enable and force row-level security on every new table, and grant only what the app needs.
- Apply it to the hosted project before deploying code that depends on it, then record it: `begin; set local role crm_admin; insert into private.schema_migrations (filename) values ('...'); commit;`.
- `npm run db:setup` applies new migrations locally. Tests rebuild their database from every migration.

## UI

- Tailwind only. No CSS modules, no inline style objects except for computed values.
- Always use `Button` from `components/_ui/button` with an explicit `variant`.
- Typography comes from `@layer base` in `app/globals.css` (`h1`, `h2`, `h3`, `p`, and `.lead-style`, `.caption-style`, `.eyebrow-style`). Don't restyle headings or paragraphs per component.
- Icons are SVG files in `public/assets/images`, imported as components through SVGR (`import PlusIcon from "@/public/assets/images/_common/plus.svg"`). No icon libraries. Images, video, Rive and Lottie go through `Asset`.
- Widths for text blocks use `em` (for example `max-w-[47.5em]`).
- Every page works on a 390px wide phone. Check mobile and desktop.
- Every control has an accessible name. Use real `<button>`, `<label>` and `<select>` elements, and `role="alert"` or `role="status"` for messages.
- Use the shared `ease-power*` easings and short durations for motion.

## Writing

- UK English, plain and direct, in the interface, emails, prompts and commit messages.
- No em dashes or en dashes anywhere. Use commas, full stops, colons or brackets.
- No code comments. Name things so the code reads on its own.

## AI

- Model calls go through `lib/llm.ts` (`completeJson`) and the LLM API gateway (`LLM_API_KEY`). Pass a zod schema, a deadline when running in the background, and a `model` only when a step needs a specific one.
- The assistant's tools live in `lib/assistant/tools.ts`. A tool that changes anything sets `write: true` so it goes through an approval card, and has a `describe` for that card.

## Background work

- Use `after()` from `next/server` to keep work out of the response. Guard it with try/catch because it throws outside a request.
- Long jobs carry a deadline and stop starting new steps when time runs short. `/api/cron/sync` (every 10 minutes from Supabase `pg_cron`) and page loads drive syncs and workflow runs.

## Testing and checks

- Before every commit: `npx tsc --noEmit`, `npx eslint .`, `npm test` (needs local Postgres, see `README.md`).
- Add tests in `tests/*.test.ts` for new behaviour in `lib/`. Fake outside APIs by passing `fetchImpl`, never by calling real services.
- For UI changes, run the production build locally and check the page in a browser at desktop and mobile sizes.

## Git

- One branch and pull request per feature, merged into `main` with a merge commit. Delete the branch after merging.
- Commit messages are one sentence describing the change for a user, in the past or present tense, ending with a full stop.
- Vercel deploys `main`. Check the deploy status after merging.
