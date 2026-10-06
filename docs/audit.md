# Prototype audit

The starting point was a Next.js 16 company table. The screens were useful. The data was not.

## Reused

- Sidebar, table, command menu, sheets, dialogs, filters, buttons, tags, and the dark visual system.
- CSV download, including formula-injection escaping in `lib/csv.ts`.
- Zustand, limited to ephemeral UI: which row is open, which dialog is open, and the current page of companies.

## Removed from the product

- `data/companies.ts` and `data/notifications.ts`. Sample companies, fake owners, and a hard-coded current user lived there.
- `lib/companies.ts` previously invented health, activity, and pipeline numbers from a fixed date (`2026-09-14`). Those formulas are gone. The module now only formats and labels real records.
- Sidebar counts, trial and billing copy, and team/reporting/pipeline navigation that did not open a real screen.
- Header tabs for Deals and Forecast, score cards, activity sparklines, and win-probability fields. Those numbers were not recorded events.
- Logo upload on create. There is no storage-backed logo yet.
- The duplicate `app/page.tsx` that rendered the sample list with no session.

## Now recorded

Contacts, opportunities, activities, and next actions are real records. Notifications list due and overdue follow-ups. Quiet lists companies with no recent interaction. CSV import and export cover the core records. Webhooks deliver the audit events. The Microsoft inbox files received mail, and a contact can send through the connected mailbox, once the Entra app credentials are set. Gmail and calendar sync still need an OAuth app you provide.

## Security notes from the prototype

There was no authentication, no tenancy, and no server check. Anyone who could open the page saw the same in-memory list. Search and filters ran only in the browser. That is replaced by a session, workspace membership, and Postgres row-level security.
