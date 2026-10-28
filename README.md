# Orbit

Orbit is a workspace CRM for companies, people, opportunities, conversations, and tasks. The web app, versioned API, and MCP server share one domain service backed by PostgreSQL.

## Requirements

- Node.js 20+
- PostgreSQL 16, local or hosted

Docker is not required. Hosted Supabase Auth is optional.

## Local setup

Create a database and a login the app can use:

```sql
create role crm_app login password 'crm_app_dev' nosuperuser nocreatedb nocreaterole noinherit;
create database crm owner crm_app;
```

The migration creates `crm_app` without a password when it is missing. On a local database, `db:setup` sets the `crm_app` password to the one in `DATABASE_URL`. On hosted Supabase, set and rotate the `crm_app` password yourself.

```bash
npm install
cp .env.example .env.local
npm run db:setup
npm run dev
```

`db:setup` applies `supabase/bootstrap/local-auth.sql` only when `auth.users` does not already exist, applies each CRM migration once, and writes a local user plus an agent token into `.env.local`. Sign in with `DEV_USER_EMAIL` and `DEV_USER_PASSWORD`. The local agent can read and write companies, contacts, leads, activities, opportunities, and tasks. It can also file emails and meetings, import CSV, and register webhooks when the token includes `admin`.

`npm run db:reset` drops the `crm` and `private` schemas and the local auth users, then sets up again. It refuses to run when it detects hosted Supabase Auth.

### Test database

`npm test` uses its own database, `crm_test` on `127.0.0.1:5432`, with the connection strings set in the `test` script in `package.json` (not `.env.local`): it connects as `postgres` with password `postgres` to rebuild the schema, and as `crm_app` with password `crm_app_dev` for the tests. Create it once as `postgres`:

```sql
create database crm_test;
```

The test files that need the database then drop the `crm`, `private` and `public` schemas, apply `supabase/bootstrap/local-auth.sql` and every migration in order, and set the `crm_app` password to `crm_app_dev` (roles are shared by every database on the server, so this is also the password for `crm`). The migrations create the `pgcrypto` and `pg_trgm` extensions, so the server must have them available. Never point the tests at a database you want to keep.

## Accounts and time

Orbit has no open sign-up. Only an account that belongs to a workspace can sign in: `db:setup` creates the local one, and everyone else joins through an invite (see Team and permissions). Dates, typed due times, and the Today and Overdue cut-offs use London time. `NEXT_PUBLIC_TIMEZONE` overrides that at build time if it ever needs to.

## Team and permissions

Settings › Team lists everyone in the workspace. The owner and admins invite people by email: Invite creates a link at `/join/<token>`, emails it from your Outlook when Microsoft is connected (otherwise copy it), and lists it under Waiting to join until it is used, cancelled or 14 days old. Inviting the same address again cancels the old link. The invitee sets their name and password on the join page and is signed straight in. With `SUPABASE_SERVICE_ROLE_KEY` set the login is created already confirmed; without it Supabase emails a confirmation link that returns to `/auth/callback`. Someone who already has an Orbit login joins with their existing password. A link only works for the address it was sent to.

| Role | Can |
| --- | --- |
| Owner | Everything. Can't be removed or demoted, and is the only one who can make admins or change roles. |
| Admin | Everything except changing roles and removing the owner. Invites members, removes members, manages workspace settings (ClickUp, enrichment, webhooks). |
| Member | Uses everything (companies, contacts, deals, boards, tasks, Mail, Capture, Calendar, the assistant, workflows) with their own Microsoft, calendar, Granola and AI connections. Can't change workspace settings or manage people. |

What is shared and what is private:

- Shared with every member: companies, contacts, deals, boards, tags, email templates, and everything logged to a record (emails, calls, meetings, notes, call summaries, filed transcripts), plus meetings from calendars marked Use for CRM that include a contact or company.
- Private to each person: their inbox, calendars and calendar page, OAuth tokens and API keys, email signatures and unsent attachments, assistant conversations, workflow runs and approvals, notifications.
- Tasks belong to their owner and creator. A member sees only tasks assigned to them or that they created, everywhere in Orbit (lists, record pages, search, the assistant). The owner and admins see everyone's, with a Mine or Everyone switch on Tasks once the workspace has more than one person. New tasks are owned by whoever creates them. Reminders, the side menu count and the notifications bell only cover your own tasks and unowned ones. A member can hand back a task they created, but not one someone else gave them.

Removing someone moves their companies, contacts, deals and tasks to whoever removed them, disconnects their Microsoft and calendar accounts, AI account, Orbit Agent and Granola key, and keeps everything they logged.

## Settings

`/settings` opens Settings › General. Each section has its own page, listed down the left on wide screens and as a scrolling tab bar under the header on phones:

| Page | Path | What it holds |
| --- | --- | --- |
| General | `/settings/general` | Your account, About you, My email addresses, and the meeting link for invites |
| Learning | `/settings/learning` | What the assistant has learned, the market watchlist, market notes received and the Grok Bot connection |
| Team | `/settings/team` | Who is in the workspace, their roles, invites (below) |
| Templates and signatures | `/settings/email-templates` | Reusable emails (below) and a signature per sending address |
| Calendars | `/settings/calendars` | Calendar accounts and links, Show and Use for CRM, Add mail for extra Microsoft accounts |
| Booking page | `/settings/booking-page` | Your public booking page at `/book/<link>` (below) |
| Integrations | `/settings/integrations` | Microsoft 365 and Teams calls (managed from Capture), your Granola key, Linear, ClickUp, AI accounts and Orbit Agent, enrichment providers |
| Pipeline | `/settings/pipeline` | Opportunity stages (each board has its own stages, set on the board) |
| Tags and lifecycles | `/settings/tags` | Rename, merge, and delete tags and custom lifecycles |
| API and webhooks | `/settings/api` | Your mail in Claude (personal MCP tokens), REST and MCP addresses, how to issue agent tokens, webhooks and recent deliveries |

Rarely used parts (token instructions, recent webhook deliveries, watched ClickUp lists, and similar) are collapsed until you open them. Old links keep working: `/settings#calendars`, `#pipeline`, `#tags`, `#webhooks`, `#clickup` and the rest open the matching page, and `#meeting-link` scrolls to it on General.

## Email templates

Settings › Templates and signatures keeps emails you send often. A template has a name (up to 120 characters, unique in the workspace ignoring case), a subject (up to 300), a plain-text message (up to 20,000; line breaks are kept), and up to 20 tags, normalised like contact tags. Search matches the name, subject, and message; the tag chips filter the list. Selecting a template opens the editor with a live preview for one of your 20 most recently updated contacts, or for Alex Example at Example Ltd. Duplicate makes "Copy of …" (numbered when that name is taken), and Delete removes it after you confirm.

Tokens are `{{first_name}}` (falls back to the full name, then "there"), `{{last_name}}`, `{{name}}`, and `{{company}}`. Click a token chip to insert it at the cursor; anything else in double braces is flagged and left as typed.

In the email composer on a contact or company, and in the bulk email dialog, Use template lists your templates with search and tag filters. On a contact the subject and message are filled in already personalised for that person; in bulk email the tokens stay and each recipient gets their own version. Both composers accept tokens and personalise them when the email is sent or logged. Save as template stores the current subject and message under a name and tags; on a contact, a field you have not changed since using a template is saved with its tokens rather than the personalised text.

## Microsoft inbox

Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and the redirect URI registered on the Entra app. Delegated permissions are `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `Calendars.ReadWrite`, and `offline_access` (`Mail.ReadWrite` lets Orbit build a draft for attachments over 3 MB; a mailbox connected with only `Mail.Read` still sends smaller ones). Restart the server, open Capture, and connect the mailbox. Received mail is attached to a contact by email address, or to a company by domain. Free-mail domains such as gmail.com are never matched by domain. Mail that matched nothing is attached on a later sync once its sender becomes a contact. From a contact, Send email opens a single pad: To and From lines, a borderless subject, a message that grows as you type, your signature for the chosen address below it (Edit, or Remove for this email), attachments, and a toolbar with Attach, templates, Personalise and Save as template, and Log only and Send (⌘ Enter) on the right. The draft is kept in the browser per contact until it is sent or logged. Signatures are set per sending address in Settings › Templates and signatures, or straight from the pad, and are added below every email from that address, including bulk email and the assistant's; the timeline keeps only the message. Send email delivers through that mailbox, with up to 10 attachments (Attach, 25 MB in total), and bulk email can attach the same files to every message. Files upload from the browser straight to a private Supabase Storage bucket (`email-attachments`, created on first use; needs `SUPABASE_SERVICE_ROLE_KEY`), are attached when the email goes out, and are deleted from storage once sent; unsent ones are removed by the scheduled sync after a day. Up to 3 MB in total goes out in one request; anything bigger is built as a draft with upload sessions and needs `Mail.ReadWrite`, so a mailbox connected earlier is asked to reconnect. The timeline lists the attached file names. A mailbox connected before Mail.Send was granted keeps syncing, but has to be disconnected and connected again before it can send. When `MICROSOFT_REDIRECT_URI` is set, Connect first sends you to that host, so be signed in there.

### Mail mirror

Orbit keeps its own copy of every connected mailbox: the Capture account and each extra Microsoft account with Add mail (Settings › Calendars). It reads every folder except Junk and Outbox, including Sent, Drafts, Archive, Deleted Items and your own folders, with the full message, and fills in the whole history, newest first. Microsoft's change tracking then keeps each folder up to date: new mail, read and flag changes, moves and deletions. Capture shows how far each account has got. The mail is private to you, and the assistant can search all of it (`search_email`), read whole threads (`get_email_thread`) and check how far each mailbox has synced (`get_mail_sync_status`).

The history fills in through `/api/cron/mail` (up to four minutes a run, every five minutes in production; see Scheduling), plus a short catch-up for new mail on every page load and in the scheduled sync. The backfill stops when the database reaches `MAIL_STORAGE_LIMIT_MB` (400 by default); new mail keeps coming in until `MAIL_HARD_STOP_MB` (472 by default), where all mail sync stops and Capture says so. Together they keep a Free Supabase project under its 500 MB read-only limit. On a Pro project, raise it, for example to 50000.

### Mail

Mail (`G` then `M`, at the top of the side menu with your Important unread count) is where you read and work through that copy. Every connected account is in one inbox, with All accounts or a single account at the top, and a coloured dot on each conversation shows which account it came to. Inbox, Snoozed and Scheduled (when they have anything), Sent, Drafts, and More (Archive, Trash and your own folders) sit above the list; search looks through every folder. Mail is grouped into conversations, newest first, and opens in the reading pane straight away because Orbit loads the next few conversations before you get to them. Designed emails show on a white sheet; ordinary emails take Orbit's colours. Attachments are listed under each email and open or download straight from Orbit (PDFs, images and text open in a new tab; anything else downloads). Scripts never run and links open in a new tab.

Keys: `J` and `K` (or the arrows) move through the list, `E` archives (in Archive it moves back to Inbox), `#` or Delete moves to Trash, `U` marks read or unread, `S` flags, `H` snoozes, `Z` undoes the last archive, delete, snooze or send, `/` searches, `Shift R` checks for new mail and Esc goes back to the list on a phone. A conversation you stay on is marked read. Every change shows at once and goes to Outlook in the background; if Outlook refuses, Orbit puts it back and says why. New mail is checked every minute while Mail is open and when you come back to the tab. On a phone, swipe a conversation left to archive it (in Archive or Snoozed, back to Inbox) and right to snooze it; in an open email, swipe right to go back to the list and left for the next email. Compose opens a new email card (see Email from anywhere).

Capture (`G` then `I`, formerly Inbox) is where the Microsoft connection lives, along with everything Orbit has captured and is waiting for you: mail to file to contacts, people you've met, calls and transcripts. `/inbox` redirects there.

### Orbit as an app, and notifications

Orbit installs as an app. On iPhone, open it in Safari, tap Share, then Add to Home Screen; on a Mac, use Safari's File › Add to Dock or Chrome's install button. It opens full screen on Mail, and signing in anywhere lands on Mail too.

Notifications for new mail work on iPhone (iOS 16.4 or later, opened from the Home Screen icon) and on desktop browsers, even when Orbit is closed. Turn them on from the prompt at the top of Mail or in Settings › General › Notifications (Turn on for this device, then Send a test), and choose Important only (the default: people you know, conversations you're in and calendar replies), All new mail, or Off. Outlook tells Orbit about new inbox mail straight away, so a notification usually arrives within seconds; tapping it opens the conversation. Several at once are grouped. The app icon shows the Important unread count. Settings › General › Notifications also sets meeting reminders (Off, when it starts, or 5, 10, 15 or 30 minutes before; 10 by default), each with the meeting's join link one tap away, and an optional alert the first time someone opens an email you sent. Orbit also notifies you when a workflow is waiting for your approval (tapping it opens the approval), when a scheduled email can't send, when nobody has replied by a reminder (also in the bell) and when a snoozed email comes back; turning mail notifications Off silences the last two. Meeting reminders come from the one-minute `/api/cron/mail-due` job, so calendars synced at least every ten minutes are covered. A sent email's read status sits on the right of the reply buttons: Unread, or Read by and the person's name, with every open on hover.

### Split inbox and triage

Mail opens on Important. The inbox is split into Important, Other, News and Calendar (a split shows when it has mail), with unread counts, and `Tab` and `Shift Tab` move between them; More holds All inbox, Snoozed, Scheduled, Sent, Drafts, Archive, Trash and your folders. The side menu's Mail count is Important only.

Where an email goes, in order: your own choice for that sender or domain; Calendar for meeting replies and invitations; Important for anyone who is a contact in Orbit and for any conversation you have written in; News for automated senders such as no-reply, newsletters, notifications and receipts; Other for what Outlook's Focused Inbox puts in Other; and Important for everything else. In the reading pane, the split button (for example Other) moves a sender, or everyone at their domain, to another split from now on.

`X` selects the highlighted conversation (or ⌘-click a row), `⌘ A` selects every loaded one, and Esc clears the selection. With a selection, `E`, `#`, `U`, `S` and `H` (and the bar above the list) archive, delete, mark read or unread, flag or snooze them all at once, with Undo.

### Remind me, Send later and Undo send

Send is instant: the email closes, "Sent" shows with Undo (or `Z`) for ten seconds, and Outlook gets it after that. If Outlook refuses, an alert offers the draft back. Leaving the page during those ten seconds sends it straight away.

`H` (Remind me), the clock in the reading pane, or swiping a conversation right on a phone, asks when you want it back: later today, this evening, tomorrow, this weekend, next week or a date and time. Orbit moves the conversation to a Snoozed folder in that Outlook mailbox (made on first use), and at that time moves it back to the inbox, unread, at the top with a Reminder tag. Snoozed lists what is waiting and when it comes back; `E` there returns a conversation now.

The clock next to Send is Send later: the email stays a draft in Outlook and goes out at the chosen time, listed under Scheduled, where opening it lets you edit it, Unschedule it or Send now. The bell next to Send is Remind me if no reply (1, 2 or 3 days, or a week): if nobody but you has written in the conversation by then, it comes back to the top of the inbox tagged No reply, with a notification. Scheduled sends, snoozes and reminders run from the one-minute `/api/cron/mail-due` job, the five-minute `/api/cron/mail` job (see Scheduling), and Mail's own minute check while it is open.

### AI in Mail

Each conversation opens with a short summary of what it is about and where it stands, and, when something is waiting on you, a Next line saying what to do. Summaries are made the first time you open a conversation and kept until new mail arrives; a single short email gets none.

In any reply or compose card, `⌘ J` (or the sparkle next to Send) asks AI to write the email. Type a few words (for example "yes, Thursday works") or nothing at all, and it writes the message in your voice from the conversation, what Orbit knows about the people (job, company, lifecycle, health, recent activity) and how your recent sent emails read. With a draft already written, it polishes it. Missing details come back in [square brackets] rather than being made up, and Undo puts your text back. The signature is still added on sending.

Type a question in the Mail search box (anything ending in a question mark, or starting with words like what, when or who) and press Enter, or press `⌘ Enter` or Ask: Orbit searches your mail for the answer and replies in a sentence or two, with the emails it used listed underneath to open. Plain words still search as before. All three need `LLM_API_KEY` and are limited per person to keep costs in check.

### Sending from other addresses

Settings › Templates and signatures › Send from other addresses adds an address that isn't a Microsoft account, such as Neo, so Orbit can send as it. Choose Neo (or Other and give the SMTP server, and optionally an IMAP server), enter the address, the name people see and its password, and pick the connected mailbox its mail already arrives in (for example by forwarding). Orbit checks the login before saving and keeps the password encrypted. The address then appears in From, has its own signature, and a reply to an email that was sent to it uses it automatically. Orbit writes the email as an Outlook draft in that mailbox as usual, then sends it through the address's own mail server, keeps a copy in the mailbox's Sent Items and in the provider's Sent folder, and logs it on the contact. Read statuses, Undo send, Send later and AI writing all work with it.

### Prepared replies and automatic reminders

Orbit reads new email in Important and, when a real person is waiting on you, gets a reply ready before you open it. The conversation shows a sparkle in the list and Orbit has a reply ready under the latest email: Edit and send opens it in the reply box, Dismiss hides it. Replies are written in your voice from your recent sent mail, use what the CRM and recent call notes say about the people, and leave [square brackets] for anything you must fill in. When you edit a prepared reply before sending, Orbit keeps the difference and learns from it for the next ones. Nothing is ever sent without you pressing Send, and the instructions in an email are never followed.

When you send an email that asks something, Orbit sets a No reply reminder for you (3 working days by default; weekends don't count, and it lands in working hours). The conversation shows when Orbit will remind you, with Don't remind me. If nobody replies, the conversation comes back to the top of the inbox with a follow-up already written. Both live in Settings › Templates and signatures › Prepared replies and reminders, where you can turn prepared replies off or change or stop the reminders. They run after mail syncs (straight away when Outlook reports new mail, and after each user's sync in the five-minute `/api/cron/mail` job), look back 48 hours, and stop at 60 prepared emails a day.

When someone asks to meet, the prepared reply offers three free times on different days from your calendars (inside your booking page hours, or 9:00 to 17:30 on weekdays, at least four hours ahead, for your booking page's meeting length), and your booking link when the page is on. The times are checked against your calendar again when you open the conversation and when you press Edit and send, and replaced if any has filled up.

The calendar button above an email reads the conversation and opens Send invite with the title, the time they agreed or proposed, the length, a note and the people in the conversation already filled in. Check it and press Send invites.

Orbit also reads the attachments in a conversation: PDFs, Word, Excel and PowerPoint files, and text, CSV and HTML files, up to 25 MB and ten per email. Prepared replies, Write with AI and the summary above a conversation use what they say (a reply to "see the attached terms" can refer to the terms), and Ask AI can answer from any attachment Orbit has read, naming the file. Images, scanned PDFs without a text layer and other formats are skipped. What Orbit reads is kept privately for you so each file is only downloaded once.

Claude (or any app that speaks MCP) can work with your mail too. In Settings › API and webhooks › Your mail in Claude, create a token and add it to Claude with the command shown. Claude can then search and read your email and attachments, ask questions about it, and save drafts that appear in Orbit for you to check and send. It can never send email itself, and you can revoke the token at any time. See `docs/mcp.md`.

### Replies and read statuses

`R` replies, `A` replies to all and `F` forwards, or use the buttons under the conversation. Reply goes to the sender (or, on your own email, to the people you sent it to); reply all adds everyone else on the latest email except you. Type names or addresses in To, Cc and Bcc: Orbit suggests contacts and people who have emailed you. The reply is sent from the account the conversation is in, with that address's signature (Remove signature drops it for this email), attachments, and `⌘ Enter` to send. Outlook's own quoted history goes below your message, so the thread reads as it would in Outlook.

Drafts made outside Orbit (in Outlook, or by another app connected to the mailbox) show in the conversation as Draft made outside Orbit, with Edit in Orbit (it opens in the reply box, with dashes turned into commas, and replaces the original once saved) and Delete draft. Drafts are real Outlook drafts. A second and a half after you stop typing, Orbit saves the draft in that mailbox's Drafts folder, so it is on your phone and in Outlook too. Open the conversation again, in Orbit or after a reload, and the draft is back where you left it. Discard deletes it from Outlook. Replies to people who are contacts are logged on their timeline, like any other email from Orbit.

Read statuses show when people open what you send from Mail. Your own emails in a conversation show "Read by Priya · 3 times" (or "Read" when there were several recipients, or "Not read yet"); hover or click it for each time and the app or device, and the list marks sent conversations that have been read with an eye. Orbit adds a tiny invisible image to each reply, and records an open when it loads, ignoring opens in the first five seconds, from the network you use Orbit on, and repeats within two minutes. Apps that block images can miss a read, and Apple Mail can show one early. Turn it off in Settings › Templates and signatures. Rich text and replying to one email in the middle of a thread come later.

### Email from anywhere

Compose on Mail, `C` then `M` anywhere, and Send email in the plus menu (or `Q`) open a new email as a card that floats over the page. Open as many as six at once, each to someone different: drag a card by its top bar, minimise it to a pill in the corner, and send each when you're ready (`⌘ Enter`). A card has From (any connected account), To, Cc and Bcc with suggestions, a subject, the message, the signature for that address and attachments. Paste or drag an image (a CleanShot screenshot, for example) into the message and it is uploaded and marked `[Image: name]` where you dropped it; when the email is sent the marker becomes the picture, embedded in the email so everyone sees it, and other dropped files become attachments. Dragging a link to a file on your computer is refused, because no one else could open it. Each card is an Outlook draft saved as you type, so closing it keeps the draft; the Drafts view in Mail opens it again with Continue writing, and the trash icon deletes it. Opened on a contact's page, To starts with that person.

### Every email on the contact

Every email to or from a contact is logged on that contact's activity, whichever mailbox it is in and whichever app sent it (Orbit, Outlook or your phone). After each mail sync, Orbit files emails from a contact (on the sender) and emails you sent (on each contact in To and Cc), with the text of the message without the quoted history. Drafts and junk are skipped, and each email is filed once even if it was also logged when you sent it from a contact. Emails from the last 60 days are caught up a hundred at a time; older ones are not filed. Catch-up filings older than a day don't start "An activity is logged" workflows. Logged emails are activities, so everyone in the workspace can see them on the contact.

### Outlook calendar

Orbit reads the connected user's Outlook calendars (30 days back to 60 days ahead) and shows meetings from the calendars marked Use for CRM (the default calendar unless you change it) on the matching contacts and companies.

1. On the Entra app, add the Microsoft Graph delegated permission `Calendars.ReadWrite` (API permissions, Add a permission, Microsoft Graph, Delegated permissions). It includes reading, so `Calendars.Read` can stay or go. Grant admin consent if your tenant requires it.
2. A mailbox connected before `Calendars.Read` was added keeps syncing mail, but Capture shows "Reconnect Microsoft to include your calendar". A mailbox connected with only `Calendars.Read` keeps syncing mail and the calendar, but the invite dialog shows "Reconnect Microsoft to send invites". In both cases choose Reconnect Microsoft in Capture and accept the new permission. There is no need to disconnect first.

Contact and company pages then show a Meetings card with the next meeting, up to five upcoming and five recent ones (London time), an Open in Outlook link, and a Join link for online meetings. A past meeting that has Granola notes for the same contact within two hours links to those notes on the timeline instead. Capture lists People you've met who aren't in Orbit: outside attendees from those meetings with no contact yet. Create contact adds them, with a company made from their email domain unless it is a free-mail domain, and Hide removes someone from the list for you. Calendars are private: other workspace members only see your meetings that come from a calendar marked Use for CRM and include one of their contacts or companies, on that contact's or company's Meetings card. The Calendar page, People you've met and everything else stay yours.

### Meeting invites

Orbit sends meeting invitations through Outlook: the event is created in the default calendar of the mailbox connected in Capture, and Outlook emails the invitation to every guest from that mailbox, exactly as if you had sent it from Outlook. Replies and new-time proposals arrive in that mailbox.

1. Add `Calendars.ReadWrite` and reconnect as described above.
2. Open Settings › General, Meeting link, and paste your Whereby room (any `https://` link up to 500 characters works). Leave it empty if you don't want a link.
3. Choose New event on the Calendar page, click an empty slot in the day or week grid (it opens at that time, rounded down to 15 minutes), or use the calendar button next to Call in Teams on a contact (the contact needs an email address).

The dialog takes a title (Eclipse × the contact's name when you start from a contact), a date and start time in London time, a duration of 15 to 90 minutes, guests (search contacts by name or email, or type any address and press Enter; your own addresses, including those in Settings › General, My email addresses, are never invited; up to 50 guests), notes, and Add meeting link. With the link on, the invite's location is the link and its body ends with "Join: <link>". After sending, the event shows on the Calendar page straight away, and each guest who is a contact gets an "Invited … to …" meeting activity. A meeting you organise that hasn't started yet has Cancel meeting in its details: Outlook sends the cancellation, with your optional message, to every guest, and each guest contact gets a "Cancelled …" activity.

### Booking page

`/book/<link>` is a public page where anyone can book a call with you, without signing in. Settings, Booking page shows the full address with Copy (for example `https://orbit.geteclipse.co/book/mark`). The assistant is always given your full booking page address and your meeting link, so it can put them in emails, and workflows can insert them as Your booking page link and Your meeting link. It shows a looping background video (or a soft animated gradient), and a panel with your photo, name, title and intro, a month calendar with the days that have free times, the times for the chosen day in the visitor's own time zone (they can switch zones), and Name, Email and an optional Note. Booking creates the meeting in the default calendar of the mailbox connected in Capture, exactly like an invite you send yourself: Outlook emails the invitation from your mailbox with your meeting link, the event appears on the Calendar page, the visitor becomes a contact (with a company from their email domain unless it is a free-mail domain; your own addresses and domains never do), and the contact gets a "Booked via your booking page" meeting activity. Outlook doesn't tell the organiser about meetings created in their own calendar, so Orbit does: you get a notification in the bell and a "New booking: <name>, <time>" email sent from your mailbox to itself, with the time, the meeting link, their note and a link to their record. The page then turns into a confirmation with the time in their zone and in London.

1. Connect Microsoft in Capture with `Calendars.ReadWrite` (see Meeting invites) and add your Whereby link in Settings › General.
2. Open Settings › Booking page. Pick the link (lowercase letters, numbers and hyphens, 3 to 40 characters; common words like `admin` or `settings` are reserved), set the title (default "Book a call with <first name>"), intro, meeting length (15, 20, 30, 45 or 60 minutes), buffer around meetings, minimum notice, how many days ahead people can book, and your weekly hours in London time. Turn the page on and save. Copy and Open use `SITE_URL`.
3. Optionally upload a photo (JPEG, PNG or WebP up to 1 MB; it is cropped to a circle) and a background video.

Free times come from every calendar Orbit syncs for you (Microsoft and calendar links), ignoring cancelled events and events shown as Free, with the buffer kept before and after each busy event. Just before booking, Orbit checks the stored calendar again and asks Outlook for the live calendar around that time, so a time taken in the meantime is refused with "That time was just taken. Pick another.". When the page is off or the link is unknown, visitors get a not-found page. If Microsoft isn't connected or can't create meetings, visitors see "Booking is temporarily unavailable" and Settings shows the reason. Visitors are limited to 10 time lookups a minute and 5 booking attempts an hour per IP address, and 3 bookings a day per email address.

Background video: paste a direct `https://` link to an `.mp4` you host yourself (Vercel Blob, S3, Cloudflare R2 or similar; a short, muted, compressed loop of a few MB works best) and use Preview to check it plays. Stock sites such as Pixabay block playback on other websites, so their links can stop working. Orbit doesn't store videos: Vercel functions can't return large files, and serving video from Postgres would be slow and expensive. The optional still image is shown while the video loads, to visitors who prefer reduced motion, and instead of the gradient when there is no video. If the video fails to load, the still image or gradient stays.

Domain: the page lives on Orbit's own domain, at `SITE_URL/book/<link>`. To give it a friendlier address, add another domain (for example `meet.example.com`) to the Vercel project; `/book/<link>` works on every domain the project serves, and setting `SITE_URL` to that domain makes Settings show it (`SITE_URL` is also used for webhooks, so only change it if Orbit should live there). The page is never indexed by search engines.

### More calendars and the Calendar page

The Calendar page shows a day or week (London time) across every connected calendar, with a checkbox per calendar to show or hide it. On a phone it shows the selected day as a list. Click an event for its time, calendar, location, organiser and attendees (each linked to their contact, or with Create contact), Join, Open in Outlook (Open event for a calendar link's event that has its own URL), and Granola notes when a Granola meeting overlaps it.

Your main calendars come from the Microsoft account connected in Capture; nothing needs reconnecting. To add calendars from other Microsoft accounts (another work tenant, or a personal Outlook.com account), open Settings, Calendars, and choose Connect another Microsoft account. That account only grants `User.Read` and `Calendars.Read` (plus `openid` and `offline_access`), never mail, until you choose Add mail on it: Microsoft then asks for `Mail.Send` and `Mail.ReadWrite` too, and the account appears in a From menu on Send email (contacts and companies) and bulk email. The main mailbox stays the default sender; the timeline records which address each email came from, and the assistant can send from any allowed address (`list_email_senders`, `send_email` with `from`). Once Add mail is on, Orbit also mirrors that account's mail (see Mail mirror), so replies to it show in Mail. It reuses the same redirect URI, so there is nothing new to register. Settings lists every account with its calendars: Show controls the Calendar page, and Use for CRM decides which calendars feed the Meetings cards and People you've met (only the main account's default calendar is on at first). Disconnect removes an extra account with its calendars and events.

Accounts outside the Entra app's own tenant only work when the app allows them:

1. In Entra, App registrations, Orbit, Authentication (or Manifest), set Supported account types to accounts in any organisational directory, and also personal Microsoft accounts if you want Outlook.com calendars (`signInAudience` `AzureADMultipleOrgs` or `AzureADandPersonalMicrosoftAccount`).
2. Keep `MICROSOFT_TENANT` unset or `common` so other tenants and personal accounts can sign in. A single tenant id there limits every connection to that tenant.
3. If the other organisation blocks user consent, its admin has to consent to Orbit in that tenant first.

Until then the connection ends with "This Microsoft account's organisation doesn't allow Orbit yet", and nothing is saved. Connecting the main mailbox's own address as an extra account is refused.

### Google Calendar, iCloud and other calendars by link

Any calendar that publishes an iCal (ICS) link can be added read-only, with no developer setup: open Settings, Calendars, choose Add calendar by link, paste the link, and optionally give it a name (otherwise the calendar's own name is used). Orbit fetches it straight away and refuses links that don't return a calendar.

- Google Calendar: on a computer, Settings, Settings for my calendars, pick the calendar, Integrate calendar, and copy Secret address in iCal format. Treat it like a password; Reset there invalidates the old link, after which you remove the calendar in Orbit and add the new link.
- iCloud: at icloud.com/calendar, open the calendar's info button, turn on Public Calendar, and Copy. Anyone with that link can see the calendar.
- Anything else: an `https://` or `webcal://` link (`webcal://` is read as `https://`).

The link is stored encrypted with `APP_SECRET`, and Settings only shows its host (for example `calendar.google.com/…`). Each link is one calendar, synced with the others (at most every five minutes, 30 days back to 60 days ahead; the server's conditional `ETag`/`Last-Modified` answers are used for up to six hours, then it is read in full so new repeats come into the window). Use for CRM starts off; turn it on to feed Meetings cards and People you've met. Events are read-only, and Google's secret address can lag behind the live calendar, sometimes by a few hours. Remove deletes the link with its events.

### Teams calls

Orbit logs Teams phone calls (Teams Phone with a Calling Plan) as `call` activities on the contact whose phone matches the other party, so calls never need logging by hand.

1. Give the mailbox user a Teams Phone licence and a Calling Plan, and assign them a phone number in the Teams admin center.
2. On the same Entra app, add the Microsoft Graph application permission `CallRecords.Read.All` (API permissions, Add a permission, Microsoft Graph, Application permissions), then choose Grant admin consent. A delegated permission does not work for call records.
3. Optionally set `MICROSOFT_TENANT` to the tenant id or domain (for example `contoso.onmicrosoft.com`). With the default `common`, Orbit reads the tenant from the connected mailbox's token.
4. Connect the mailbox in Capture if it is not connected yet. No reconnect is needed after adding the permission.

Orbit syncs in the background after a CRM page loads, at most once every five minutes, and Capture has Sync calls for an immediate sync. Each sync re-reads the last 24 hours because Microsoft can publish call logs late. Outgoing calls match the number dialled and incoming calls match the caller, in any UK format (`07…`, `+44…`, `0044…`). A call with no matching contact is kept and logged once a contact gets that number. Conference calls and other users' calls are skipped. If Capture says to grant `CallRecords.Read.All`, step 2 is missing or consent has not been granted yet.

### Call summaries

Orbit can turn a call or meeting transcript into a short summary, key points, and suggested tasks, stored against the activity. Action items that are yours become tasks on the contact automatically and, when ClickUp is set up with a default list, ClickUp tasks too. Items for the other person, or with no clear owner, stay in the summary with an "Add as task" button. It uses the llmapi.ai gateway (OpenAI-compatible chat completions). Set `LLM_API_KEY`. Optionally set `LLM_MODEL` (default `claude-haiku-5-5`) and `LLM_API_BASE_URL` (default `https://api.llmapi.ai/v1`).

On a call in a contact's or company's activity, choose Add transcript, paste the transcript (plain text or the Teams `.vtt` text), and choose Summarise. Teams `.vtt` files are reduced to `Speaker: line` text first. Each suggested task has Add as task, which creates a task on the call's contact and company due at 09:00 London time on the stated day, and Dismiss. The transcript stays on the call under Transcript. A summary that fails keeps the transcript and shows the error with Try again.

### Account health

Every summary also judges how the relationship stands after the call, from the other side: Healthy (engaged, on track), Watch (concerns, hesitation, slipping timelines) or At risk (frustration, talk of cancelling, not renewing or competitors), with a one-sentence reason. The call shows it under Sentiment, and the company takes it as its Health, unless the company already has a health from a later call or one set by hand after the call. Health is a separate signal from the Relationship label below, and both feed it: a call judged At risk makes a recent relationship Cooling.

### Relationship

Every company and contact has a Relationship label with a one-line reason, shown on the company page (under Relationship), under a contact's name, in the Relationship column of Companies, on Quiet and on Tasks. It reads the whole exchange, not just the last date: when they last replied (separately from when you last wrote), how many of your emails went unanswered in a row, meetings and calls held, and the tone of their recent emails and calls. Automatic replies, bounces and internal notes don't count as contact.

| Label | Means |
| --- | --- |
| Strong | They replied or met in the last 30 days, at least twice in the last 90, and the tone is good (or three or more times) |
| Warm | Two-way within the last 60 days, but slower or neutral |
| Cooling | Nothing back from them for 60 to 180 days, or their latest message or call sounded unhappy |
| One-sided | Three or more of your emails in a row without a reply (two if they have been quiet for 60 days), or they have never replied or met |
| Cold | Nothing from them for over 180 days |
| New | No exchange yet, or a single email from you in the last two weeks |

After each mail sync, Orbit reads up to 12 new emails from contacts (the last 120 days) with the AI and marks each positive, neutral or negative, and whether it was an automatic reply. Call summaries already carry their own sentiment. The assistant, `GET /api/v1/companies` and the MCP `search_companies` tool include each company's `relationship`.

Health shows on the company page (with the reason and where it came from, and a menu to set it by hand), as a column and a filter on Companies (At risk, Watch, Healthy, Not set), and on board and opportunity cards. Each change is recorded as a company update, so workflows can react with When a field changes, Health, changes to At risk; the starter template Follow up when a client turns at risk notifies the account owner and adds a check-in task for the next day. Calls summarised before health existed are judged once each by the scheduled sync, one per run. The assistant can filter companies by health and set it when asked.

What is sent to the gateway: the transcript, the call or meeting date, your name, the contact's name, job title and company, and the activity's title. Nothing else from the CRM is sent. Meetings get the same panel as calls, and pasting a transcript still works for anything Orbit did not import itself.

## Automatic transcripts

Transcripts from Teams calls and Granola meetings arrive on their own and are summarised like a pasted transcript. Anything Orbit cannot match to a contact or company waits in Capture under Unfiled conversations, where File to… puts it on a contact (and summarises it) and Ignore hides it. Capture also shows when each source last synced, its last error, and Sync now.

Environment:

| Variable               | What it does                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GRANOLA_API_KEY`      | Granola personal API key (`grn_…`, Business plan). Leave empty to turn Granola off.                                     |
| `GRANOLA_API_BASE_URL` | Optional. Overrides the Granola API base URL (default `https://public-api.granola.ai`).                                  |
| `CRON_SECRET`          | Shared secret for `/api/cron/sync` (and the other cron routes, see Environment variables). The scheduler sends `Authorization: Bearer <CRON_SECRET>`. Without it the route returns 503. |
| `ECLIPSE_MCP_TOKEN`, `ECLIPSE_MCP_URL` | Optional. Lets the assistant use the Eclipse app through its MCP server (the URL defaults to `https://app.geteclipse.co/api/mcp`). |
| `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` | Optional. Jev grading in the assistant's cold email check. |
| `MINDCASE_API_KEY`, `MINDCASE_MONTHLY_LIMIT_USD` | Optional. LinkedIn and X lookups for the assistant and workflows through Mindcase, with a monthly spend limit in dollars (default 20). |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | Optional. Lets the assistant open pages that need JavaScript or block plain requests in a Browserbase browser. |
| `SUPADATA_API_KEY` | Optional. Reads YouTube transcripts through Supadata when YouTube won't share a video's captions with Orbit directly, and transcribes episodes Orbit can't split. |
| `SITE_URL` | Production origin, for example `https://orbit.geteclipse.co`. Teams subscriptions are only created when it is set and uses https, and the Granola webhook is registered on it. |

### Granola

Each person can connect their own Granola in Settings › Integrations: paste a personal API key (checked against Granola before it is saved, stored encrypted, visible only to them) and their notes sync as theirs. The server-wide `GRANOLA_API_KEY` keeps working for the member whose email owns it. Set `GRANOLA_API_KEY` and restart. Notes go into the workspace with a member whose email is the note owner's email, or into the only workspace when there is one. Each sync lists notes updated since the last sync less an hour (the first sync looks back 14 days) and imports each new note with its transcript. A note is filed as a `meeting` activity on the first attendee or calendar invitee whose email is a contact, otherwise on a company matched by email domain (free-mail domains such as gmail.com never match). Workspace members, and anyone at the note owner's or a member's own domain, are never matched, so internal meetings stay unfiled instead of landing on your own company. The meeting is titled after the note or the calendar event, dated at the scheduled start, lists the attendees, and links back with Open in Granola. Granola's own summary is kept and shown on unfiled conversations. A note is imported once; later edits in Granola do not change it. A note that fails to import is recorded with its error and retried on the next syncs; after three failures it moves to Unfiled conversations with the error, and it never holds back the rest of the sync.

Enable instant Granola sync in Capture registers `/api/granola/webhook` with Granola for `note.generated` events and stores the signing secret encrypted. When Granola says webhooks are not available for the workspace, Orbit keeps checking every 10 minutes instead. The webhook route checks the signature before doing anything else, ignores a delivery id it has already seen, and never calls Granola before the request is verified.

### Teams transcripts

1. On the Entra app, add the Microsoft Graph application permission `CallTranscripts.Read.All` and choose Grant admin consent. `CallRecords.Read.All` stays, because transcripts are matched to calls through the call log.
2. In the Teams admin center, the calling policy for the mailbox user must allow recording and transcription for calls. Transcription has to be started on the call (from the call's More actions menu) for a transcript to exist.
3. Set `SITE_URL` to the production https origin so Orbit can subscribe to new transcripts. Without it Orbit still polls.

Each mailbox owner's transcripts, sync state, and subscription are their own: other workspace members cannot see or file a transcript until it is filed on a contact, after which it is part of the shared timeline like any other activity. Orbit reads the user's ad hoc call transcripts (Graph `getAllTranscripts`) since the last sync less six hours (the first sync looks back 7 days). A transcript waits until its Teams call log appears, then attaches to that call's activity and is summarised. If the call never matches a contact within 48 hours, it moves to Unfiled conversations; filing it there also links the call log. Orbit keeps a Graph change notification subscription for new transcripts (two days, renewed when less than a day is left, recreated if Microsoft removes it). Microsoft only notifies about transcripts started after the subscription existed; polling picks up the rest. If Capture says to grant `CallTranscripts.Read.All`, step 1 is missing; if it says your admin has turned off API access to Teams transcripts, the tenant blocks Graph access to transcripts.

## ClickUp

Orbit keeps its tasks and ClickUp tasks in step, both ways.

1. In ClickUp, open your avatar › Settings › Apps, and under API Token choose Generate (or Regenerate), then Copy. The token starts with `pk_`.
2. In Vercel, add it as `CLICKUP_API_TOKEN` under Settings › Environment Variables and redeploy. Locally, put it in `.env.local` and restart.
3. In Orbit, open Settings › Integrations, ClickUp. Pick the default list for new tasks, tick the lists to watch, and choose Save ClickUp settings.
4. On each list where you create tasks for contacts, add a text custom field named `Orbit` (or `CRM`). Put the contact's email, the company's domain, or the Orbit link to the record in it.
5. Optional: with `SITE_URL` set to Orbit's https address, choose Enable instant ClickUp sync. Without it, Orbit checks ClickUp every 10 minutes and whenever a page loads (at most every 5 minutes).

| Variable                | What it does                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CLICKUP_API_TOKEN`     | ClickUp personal API token (`pk_…`). Leave empty to turn ClickUp off.                                         |
| `CLICKUP_API_BASE_URL`  | Optional. Overrides the ClickUp API base URL (default `https://api.clickup.com/api/v2`), for tests or a local fake. |

From Orbit to ClickUp: the add-task forms on a company page and on Tasks have Add to ClickUp, on by default once ClickUp is set up, with a list picker that remembers the last list used. The ClickUp task gets the title, the due date (London time; a due time of exactly midnight is sent as a date without a time), an assignee (the ClickUp member whose email matches the Orbit task's owner, including their other addresses; the token's owner when the task is unassigned or belongs to them; nobody when the owner isn't in ClickUp), and a description with the contact or company name and a line `Orbit: <SITE_URL>/contacts/<id>` (or `/companies/<id>`). If the list has a text, URL, or email field named Orbit or CRM, Orbit fills it with that link (an email field gets the contact's email). Later changes to the title, due date, and done state are sent too: done picks the list's first status of type done or closed, reopening picks its first open status. Archiving in Orbit leaves the ClickUp task alone. If ClickUp fails, the Orbit task is still saved, the error shows on the task, and Orbit tries again on the next sync. Linked tasks show a ClickUp link.

From ClickUp to Orbit: a new task in a watched list becomes an Orbit task, owned by the workspace member whose email matches its first ClickUp assignee (otherwise the token's owner), when Orbit can tell who it is for, checked in this order: the Orbit or CRM field holds an Orbit record link, a contact's email, or a company's domain; the description holds an Orbit record link; the description holds a contact's email (your own and other members' addresses are skipped). Tasks Orbit cannot place are left alone. Linked tasks keep their title, due date, and done state in step; when the same field changed on both sides, the later edit wins. Deleting the task in ClickUp archives the Orbit task.

Instant sync registers one ClickUp webhook, pointing at `/api/clickup/webhook`, for task created, updated, deleted, status, due date, and moved events. It covers a single list or space when everything you chose lives there, otherwise the whole workspace, and Orbit ignores tasks outside your lists. The route checks `X-Signature` (HMAC SHA-256 of the body with the webhook's secret, stored encrypted) before doing anything else, ignores deliveries it has already seen and events more than a day old, and answers straight away; the task is fetched afterwards. Changing the lists in Settings moves the webhook to match.

### Scheduling

`GET` or `POST /api/cron/sync` with `Authorization: Bearer <CRON_SECRET>` runs, for each workspace with a connected mailbox, extra calendar account or calendar link, Granola, or ClickUp: mail sync (filing for Capture), a 15-second new-mail catch-up of the Mail mirror, Teams call sync, calendar sync (every connected account and calendar link; links sync even without the Microsoft app), Teams transcript sync and subscription upkeep, Granola sync, ClickUp sync (watched lists since the last sync less five minutes, then pending and failed pushes), and pending summaries. Each step runs on its own, so one failing does not stop the rest, and the run stops starting new steps after about 50 seconds. Mail sync only starts with at least 15 seconds left, and model calls, Graph, Granola and ClickUp requests are cut short so the run fits. It then retries due webhook deliveries, removes unsent email attachments older than a day, judges the health of one call summarised before health existed (up to 12 seconds), runs due workflows for up to 8 seconds, and returns a JSON report of counts and errors per mailbox owner. CRM pages also sync and run workflows in the background after they load. `GET` or `POST /api/cron/workflows` with the same header runs only workflows, for up to 50 seconds, if you want a tighter schedule for them.

`vercel.json` has a daily Vercel cron as a backstop (Hobby plans allow one run a day; Vercel sends `CRON_SECRET` as the bearer token). For every 10 minutes, schedule it from Supabase with `pg_cron` and `pg_net`. Run this in the SQL editor, replacing `<SITE_URL>` with Orbit's address and `<CRON_SECRET>` with the value set on Vercel (production already has this job, named `orbit-sync`):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'orbit-sync',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := '<SITE_URL>/api/cron/sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <CRON_SECRET>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
```

Check runs with `select * from cron.job_run_details order by start_time desc limit 10;` and responses with `select * from net._http_response order by created desc limit 10;`. Stop it with `select cron.unschedule('orbit-sync');`. Running `cron.schedule` again with the same name replaces the job, which is how to rotate the secret.

Mail needs two more jobs, made the same way with their own name, schedule and path (production has both):

| Job | Schedule | Path | What it does |
| --- | --- | --- | --- |
| `orbit-mail` | `*/5 * * * *` (every five minutes) | `/api/cron/mail` | Syncs every connected mailbox into the Mail mirror (backfill included, up to four minutes a run), then for each user sends due mail and prepares replies and reminders (`prepareMail`). |
| `orbit-mail-due` | `* * * * *` (every minute) | `/api/cron/mail-due` | Sends scheduled emails, brings snoozed conversations back, raises No reply reminders and sends meeting reminders. |
| `orbit-learn` | `*/10 1-5 * * *` (every ten minutes, 1am to 6am UTC) | `/api/cron/learn` | Nightly learning (see Learning). Each part runs once a day, so the extra runs only pick up what an earlier run didn't finish. |

## Contact enrichment

Orbit can find a missing work email, LinkedIn profile or phone number for a contact. It asks providers one after another and stops at the first one that finds it. A provider without an API key is skipped.

| Provider | Key | Finds | Checks emails |
| --- | --- | --- | --- |
| context.dev | `CONTEXT_DEV_API_KEY` | Email, LinkedIn | No |
| Hunter | `HUNTER_API_KEY` | Email, LinkedIn | Yes |
| Enrow | `ENROW_API_KEY` | Email, phone | Yes |
| Icypeas | `ICYPEAS_API_KEY` | Email, LinkedIn | Yes |

The default email order is context.dev, Hunter, Enrow, Icypeas. The default LinkedIn order is context.dev, Icypeas, Hunter. Phone numbers come from Enrow only. To change the email or LinkedIn order, open Settings › Integrations, Contact enrichment, and use the arrows. Only owners and admins can change the order; members can see it. A provider with no key is listed as "skipped, no key".

What counts as a find:

- Emails on free-mail domains such as gmail.com are never saved.
- A context.dev email is kept only when the match score is at least 70, the email is on the company's domain (or a subdomain of it), and an email checker says it can receive mail. The checkers are tried in this order: Enrow, Icypeas, Hunter. With no checker set up, context.dev emails are never saved and the next provider is tried.
- A Hunter email counts when Hunter marks it valid or scores it 90 or more. An Enrow email counts when Enrow qualifies it as valid. An Icypeas email counts when its certainty is `ultra_sure`, `very_sure` or `probable`.
- A context.dev LinkedIn profile needs a match score of at least 70.
- Phone numbers are stored in international format, with UK numbers assumed when there is no country code.
- When a search for one field also turns up another (for example a LinkedIn profile while looking for an email), Orbit saves it too, as long as that field is empty. Phone numbers are only saved by a phone search.

A lookup is skipped when the field is already filled in, when the contact has no first and last name (taken from the full name when needed), or when Orbit has nothing to tell it where the person works. It uses the company's domain, then the company website, then the domain of the contact's own work email, then the company name. A phone search can also run with only a LinkedIn profile.

Where to start a lookup:

- **Contacts list (wide screens):** the sparkle icon in an empty Email or Phone cell.
- **Contact page:** Find email, Find phone and Find LinkedIn under Details.
- **Company page:** Find email next to a person with no email in People.
- **Contacts bulk bar:** Find emails, Find LinkedIn and Find phones, six people per request with progress as they go. Find phones asks first: Enrow charges 40 credits for each number it finds and nothing when it finds none.

These buttons only appear when at least one provider for that field has a key. After a lookup, the icon shows Not found or Couldn't search; hover to see the result and which providers were tried. Found values are saved through the normal contact update, so they are audited and trigger webhooks like any other edit. If another contact already has that email, the lookup fails with "Another contact already has …". Every lookup is recorded, whatever the result.

Each person can run 300 lookups per clock hour (a contact or company counts as one, a "Fill in now" round as five). One contact lookup gets up to 75 seconds, and a single request takes up to six contacts or five companies. Lookups need a signed-in person: agents and the REST API have no enrichment endpoint.

## Company details and logos

With `CONTEXT_DEV_API_KEY` set, Orbit fills in companies from context.dev by domain (the company's domain, or else its website's host). It only fills fields that are empty: website, description (or the slogan), industry, size, LinkedIn, phone, address and logo. It also keeps context.dev's brand profile on the company and replaces it on every successful lookup: the slogan, social profiles, careers, pricing, blog, contact, terms and privacy links, sectors, employee count, contact email, stock ticker, brand colours and a backdrop image.

The company page uses the first brand colour to tint the header, shows the backdrop image above it, and shows the slogan and social icons under the name. Details gains Sectors, Employees, Email, Stock and Links (Careers, Pricing, Blog and Contact).

Companies are filled in:

- **Automatically** when a company is created (in the app, by import, or through the API or MCP) or gains a domain, when the key is set and "Fill in new companies automatically" is on in Settings › Integrations, Contact enrichment (on by default). It runs after the response, so saving never waits for it.
- **On the company page,** with Find company details or Refresh details.
- **From the Companies bulk bar,** with Find details, five companies per request.
- **From Settings,** with Fill in existing companies, Fill in now (owners and admins only), five at a time through every active company with a domain or website that has never been checked, skipping lookups that failed in the last hour. Each costs about 10 context.dev credits.

A company context.dev doesn't know is marked as checked, so it isn't tried again.

### Web checks

With `PARALLEL_API_KEY` set, Orbit can answer questions about each company from the live web with the Parallel Decisions API, at $0.001 a company. It only adds to what context.dev finds and never replaces it. Settings › Integrations, Web checks has four switches, all off to start, that only owners and admins can change:

- **Tag new companies.** Each rule is a tag and a question, such as "agency" with "Is the company a marketing, content or SEO agency?". After context.dev runs on a new company, Orbit asks every rule the company doesn't already match and adds the tag when the answer is at least 85% likely. It never removes a tag.
- **Fill gaps.** When context.dev leaves size or industry empty, Orbit asks for them. Size is one of 1-10, 11-50, 51-200, 201-1000 or 1000+. Industry is picked from the industries the workspace already uses, so it stays consistent. Either is saved only at 70% or more, and only if the field is still empty.
- **Weekly signals.** Once a week, Orbit checks every customer, prospect and company with an open deal against the signals listed (six to start: Raised money, New leader, Acquired or merged, Layoffs, Launch, Hiring in marketing; remove them or add your own). A signal at 80% or more becomes a market note on the company with how likely it is, the best source link and that page's title (never text from the page), so it reaches market memory and the morning brief. When another company's note already uses the same link, the note is kept without the link. The same signal isn't raised again for that company for 90 days. The checks run in the 10 minute sync, a few companies at a time.

- **ICP fit.** Scores each company from 0 (not a fit) to 4 (strong fit) against your ideal customer, with up to eight source links shown under ICP fit on the company page. The ideal customer is the text in the box. Turning ICP fit on with the box empty fills it from what Orbit has learned (ICP, audience, why we win and why we lose notes from Learning), and Use what Orbit has learned refreshes it, so scores only change when an admin saves a new description. Companies gain a Fit column you can sort by (Best ICP fit on phones). When the description changes, companies are due for rescoring, and the company page marks an old score.

Only the company's name, domain and website are sent to Parallel, plus your ideal customer description for ICP fit. Check existing companies runs the tag rules and gap filling through every company with a website that hasn't been checked. A check that comes back with no answer changes nothing.

### Logos

A company's stored logo comes from context.dev, and Orbit only accepts https URLs on `context.dev` or `brand.dev` hosts. A company with no stored logo but with a domain can still show one through context.dev Logo Link: copy the Public Client ID from context.dev › Logo Link, restrict it to Orbit's domain, and add it in Vercel as `NEXT_PUBLIC_CONTEXT_LOGO_CLIENT_ID`. Settings shows "Logos in lists" as On or Not set up. Without a logo, Orbit shows the company's initial. Orbit never downloads or stores logo images: it keeps only the URL, and the browser loads the image straight from context.dev, unoptimised.

### Lifecycle

Every company has one lifecycle. Lead, Prospect, Customer and Churned are built in, and new companies start as Lead. Click the lifecycle on a company (or use Edit) to pick another one or type a new name, such as Consultant or Personal, which then appears for every company, in the Lifecycle filter on Companies, and in workflow triggers and steps. Names ignore case, so "consultant" joins an existing "Consultant". Settings › Tags and lifecycles renames or deletes your own lifecycles (deleting one moves its companies to Lead); the built-in ones stay, and a won deal still makes a company a Customer.

### Company from an email

When you edit a contact that has no company, leaving the Email field checks its domain. A free-mail domain suggests nothing. If a company in Orbit has that domain (or its parent, for a three-part host such as `uk.acme.com`, but not for `acme.co.uk`), Orbit offers "Works at Acme? Link to Acme". Otherwise Orbit asks context.dev about the address and may offer a card with the company's logo, name and Add company. A company added this way has the source `context.dev` and is filled in straight away.

## Sorting and filtering lists

The Contacts list (`/contacts`) and the Companies list (`/`) keep their sort and filters in the URL, so a link or a reload shows the same view. Default values are left out of the URL, and any change goes back to page 1. Each page shows 100 rows, and each list remembers its last URL for the browser tab, so going back to the list from a record keeps the view.

| Parameter | Contacts | Companies |
| --- | --- | --- |
| `sort` | `name` (default), `company`, `updated`, `created` | `name` (default), `domain`, `owner`, `interaction`, `strength`, `updated`, `created`, `fit` |
| `order` | `asc` or `desc` | `asc` or `desc` |
| `has`, `missing` | Comma-separated: `email`, `phone`, `linkedin`, `company` | Comma-separated: `domain`, `contacts`, `interactions` |
| Other | `q`, `tag`, `owner`, `company_id`, `page`, `include_archived=true` | `q`, `tag`, `owner`, `lifecycle`, `health` (`healthy`, `watch`, `at_risk`, `none`), `page`, `include_archived=true` |

Name, company, domain and owner sort A to Z; updated, created, interaction and strength sort newest first, and fit sorts the best ICP fit first. Records without a company, domain, owner or interaction go last, except `strength` in ascending order (Longest since contact), which puts never-contacted companies first. Ties are sorted by name. Click a column header to sort and again to reverse; on phones a Sort menu replaces the headers. Filter (F) sets each field to Any, Has or No. `GET /api/v1/contacts` and `GET /api/v1/companies` accept the same parameters (use `limit` and `offset` instead of `page`).

## Tasks

The Tasks page (`/tasks`, `G` then `T`; `/actions` redirects there) opens on All: every open task, overdue first and undated last. The task pad at the top turns a line such as "Call Jane Monday 3pm, remind me 1 hour before" into a task: the due date and reminder are highlighted as you type, `@` links a person or company, and companies and contacts named in the text are offered as links. When the wording about time is unclear and `LLM_API_KEY` is set, the model reads the title, due time and reminder instead. The same pad is on a company page and in Quick add (`Q`).

A task with a due time can have a reminder: at the due time, 5, 10, 15 or 30 minutes, 1 or 2 hours, 24 hours, 2 days or a week before. While Orbit is open, it checks every minute and shows an alert with Open tasks and Dismiss, plus a browser notification once you choose Turn on browser alerts. Reminders cover tasks you own and unowned ones.

## Activity pad

The activity pad logs a call, email, meeting or note from a line of text, such as "Called @Jane, wants pricing by Friday". Type `@` to tag a person or company; every activity needs one, except where the pad is already tied to a record. Press Enter to save. It is at the top of the Activities page (C then A opens it), in a contact's and a company's activity (tied to that record), and on a board card's panel (tied to the card's company).

As you type, Orbit highlights what it understood:

- **Type** (blue). "Called", "rang", "spoke to" and similar mean a call; "emailed", "replied to" an email; "met", "meeting", "catch-up", "coffee with", "demo with", "zoom" a meeting. The earliest match wins, and anything else is a note.
- **When** (green). "yesterday", "yesterday afternoon", "this morning", "on Tuesday", "last Tuesday", "3 days ago", "last week", "today", and times such as "at 3pm" or "14:30", in London time. Morning is 09:30, afternoon 14:00, evening 18:00. An earlier day with no time is logged at 12:00, today with no time at the current time, and no date or time at all means now.
- **Follow-up** (amber). Phrases such as "by Friday", "follow up next week", "chase them in 3 days" or "get back to her tomorrow". The due date is read like the task pad, at 09:00 unless a time is given.

The chips under the pad change the type and time, remove a tagged record, and turn the follow-up task on (off until you click it; the title defaults to "Follow up with <first name>"). The task is linked to the same contact and company and, when ClickUp is set up, created in the last list you used.

With `LLM_API_KEY` set, Orbit sends the text to the model about a second after you stop typing, when the text is at least 140 characters or contains a follow-up and you aren't dictating. The reply can fill in the type, suggest the follow-up's title and due date, and give a long entry a short title. The body is always what you typed. The microphone button uses the browser's speech recognition (UK English) where the browser supports it; the audio never reaches Orbit's server.

On the Activities page, clicking into the pad lists up to four meetings that ended in the last 18 hours and haven't been logged, as "How did <meeting> go?". Only meetings from calendars used for CRM that include a contact or company count. Choosing one fills in "Met @Jane: ", sets the type to meeting and the time to the meeting's start, and links the activity to that event.

## Bulk actions

On the Contacts and Companies lists, a checkbox appears when you point at a row. Shift-click selects a range, the header checkbox (or Cmd+A) selects the page, and on touch screens Select shows the checkboxes. The selection clears when the page, search, tag, sort or filters change.

| Action | Key | What it does |
| --- | --- | --- |
| Email (Contacts) or Email people (Companies) | E | Opens the bulk email dialog for the selected people, or every active person at the selected companies. Needs Microsoft connected in Capture. Sends to up to 50 people, about two seconds apart, skipping people with no email or a duplicate address. |
| Tag | L | Adds a tag to the selection, or removes one it already has. |
| Find emails, Find LinkedIn, Find phones (Contacts) | | Runs enrichment for the selection. |
| Find details (Companies) | | Fills in the selected companies from context.dev. |
| Export selected | | Downloads `contacts-selected-<date>.csv` or `companies-selected-<date>.csv`. |
| Archive | Delete | Asks first, then archives. Undo (Z) restores them for the next 10 seconds. |

Each record is handled on its own; when some fail, the notice says how many and gives the first reason. One action handles up to 100 records.

## Quiet

The Quiet page (`/quiet`, `G` then `Q`) lists up to 100 companies with no interaction in the last 21 days, or none at all, with when you were last in touch and how many open tasks each has.

## Keyboard shortcuts and the command palette

`⌘ K` (or `⌘ /`) opens the command palette: search companies, people and opportunities, go to a page or a Settings section, create a record, or run a command for the current page. `?` lists every shortcut. `G` then a letter goes to a page (`M` Mail, `O` Companies, `C` Contacts, `P` Opportunities, `T` Tasks, `I` Capture, `L` Calendar, `A` Activities, `Q` Quiet, `S` Settings), and `C` then a letter creates something (`T` task, `C` contact, `O` company, `P` opportunity, `M` email, `E` meeting invite, `A` activity).

## Assistant

Every CRM page has an "Ask Orbit anything" bar at the bottom. Click it or press `O` to open the assistant; `Esc` minimises it. It answers from Orbit's data using tools, and proposes changes for you to approve. It works as you, with your role's permissions and the same row-level security as the app.

Set `LLM_API_KEY` to turn it on. Without it, every request returns "Set LLM_API_KEY in Vercel to use the assistant.", including for ChatGPT and Claude account models.

### About you

Settings › General, About you tells the assistant who it's helping: your role, a few lines about you, what you care about (your interests and the views you hold) and how you write. Your role is shown to everyone in the workspace, so each person's assistant knows who does what; everything else is private to you (`crm.personal_context`, readable and writable only by its owner). Add your LinkedIn profile and website and press Draft from my LinkedIn and website: Orbit reads the site and its About page, your LinkedIn profile and recent posts (through Mindcase, recorded in data usage) and drafts the fields for you to check. Nothing is saved until you save. The assistant gets it at the start of every conversation, with your colleagues' names and roles, and Mail's Write with AI, prepared replies and follow-up nudges use your role, about and writing notes when drafting for you. With nothing filled in, the assistant may suggest it once.

### Models

The model picker groups models by where they run:

| Group | Models | Runs through |
| --- | --- | --- |
| Orbit | Sonnet 5.5 (default), Opus 5.5, Haiku 5.5, GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra, Grok 4.7, Gemini 4 Argon | The llmapi.ai gateway (OpenAI-compatible chat completions) with `LLM_API_KEY` |
| Claude account | Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 | Orbit Agent on your Mac, on your Claude plan (below) |
| ChatGPT account | GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Astra, GPT-6 Luna | Your ChatGPT sign-in (below) |

The account groups only appear once the account is connected. Reasoning is Low, Medium (default), High, Extra high or Max. Each model offers only the levels it supports: Gemini goes up to High, and Grok and ChatGPT models go up to Extra high. A level a model doesn't support drops to the nearest lower one it does. The dock remembers your model, reasoning and web search choice in the browser.

### How a turn works

1. You send a message (up to 200,000 characters). Any changes still waiting for approval in that chat are cancelled first.
2. The model gets the system prompt (who you are, today's date and time in London, what Eclipse does, the tool list and answer style) and the chat so far. In a very long chat, older tool results are shortened and the earliest messages are left out.
3. Read tools the model asks for run straight away and in parallel, and the dock shows each one as it runs (for example "Checking tasks"). Their results go back to the model, which can call more tools.
4. The turn ends when the model replies without tools, or when it proposes changes. A turn stops after 40 model calls, and pauses with "I ran out of time on this step" when less than 15 seconds of its five-minute budget is left. Say "carry on" to continue. Stop ends the turn on the server too, not just in the browser. A read tool that runs for more than 90 seconds is stopped (approved actions always run to the end, and each one runs only once even if it is confirmed twice), a turn that has read more than the model can hold stops with "carry on", and if the model gateway is briefly unavailable the call is retried once.

Replies are markdown, with links to the records they mention. Copy copies a reply as plain text, and Stop ends the request in the browser. If the connection drops, the dock keeps checking the chat and shows the answer when it is saved.

| Read (run straight away) | Actions (need your approval) |
| --- | --- |
| `get_overview`, `search_records`, `list_companies`, `get_company`, `list_contacts`, `get_contact`, `list_tasks`, `get_pipeline`, `list_boards`, `get_board`, `list_workflows`, `get_workflow`, `get_workflow_run`, `list_workflow_approvals`, `test_workflow`, `list_opportunities`, `list_activities`, `get_call_transcript`, `list_calendar_events`, `get_capture`, `search_email`, `get_email_thread`, `get_mail_sync_status`, `list_quiet_relationships`, `list_tags`, `list_lifecycles`, `list_team_members`, `list_email_templates`, `list_email_senders`, `get_settings`, `list_proposals`, `get_proposal`, `list_products`, `workflow_guide`, `list_proposal_templates`, `linear_search_issues`, `linear_get_issue` | `create_task`, `update_task`, `complete_task`, `log_activity`, `create_company`, `update_company`, `update_companies`, `create_contact`, `update_contact`, `update_contacts`, `create_opportunity`, `add_to_board`, `create_board`, `update_board`, `set_board_stages`, `delete_board`, `move_card`, `remove_from_board`, `create_workflow`, `update_workflow`, `set_workflow_status`, `share_workflow`, `delete_workflow`, `run_workflow`, `decide_workflow_approval`, `update_opportunity`, `tag_records`, `save_email_draft`, `send_email`, `mail_action`, `create_meeting_invite`, `create_proposal`, `update_proposal`, `send_proposal`, `save_product`, `linear_create_issue`, `linear_comment`, `linear_update_issue` |

`update_companies` and `update_contacts` make the same change to up to 100 records in one call. `send_email` sends through Orbit Mail once you approve its card, which shows the whole email: a new email to contacts or any address, or a reply (`replyToEmailId`, to the sender, or everyone with `replyAll`, plus any `to` and `cc`), from the main mailbox or another address given in `from`, with that address's signature. It is saved in Sent and logged on the contacts' timelines. When you ask the assistant to write or reply to an email, it proposes the send, so approving the card sends it. `save_email_draft` saves a draft in Orbit Mail and the mailbox's Outlook Drafts without sending, for when you ask for a draft or want to edit it first; `send_email` with its `draftId` sends that draft later. `list_email_senders` lists the addresses Orbit Mail can send from. `create_meeting_invite` goes through the same path as Meeting invites. `create_task` goes to the default ClickUp list unless told not to. `set_board_stages` takes a board's full stage list in order (existing stages by id, new ones without, left-out ones removed once they have no cards); without a board id it changes the Opportunities stages and keeps their probabilities unless given new ones. `create_workflow` and `update_workflow` take a template key or shared workflow id, or a definition as nested `steps` (`then`/`else` on If, `body` on For each item) or as `nodes` and `edges`; it is laid out on the canvas and checked like a saved one. `test_workflow` is a read because test runs only report what actions would do. `create_proposal` makes a draft from an active template for someone at a company, and `send_proposal` sends it from your mailbox; neither can sign. Writes are recorded with source `assistant`.

### Approving changes

Proposed changes appear as cards under the reply, each with a title and the fields it will set. Record ids are shown as names (companies, people, tasks, opportunities, stages, boards, workflows and team members).

- **One change:** a card with Confirm and Cancel.
- **Several changes:** one "N changes" card. Every change starts ticked; untick any you want to skip. Confirm all (or Confirm N) runs the ticked ones and cancels the rest. Cancel all cancels everything. The card shows the first five changes, and Show all lists the rest.

Approved changes run one after another on the server. Each shows Done, Didn't work (with the reason) or Cancelled. Once nothing is left waiting, the model gets the results and carries on, usually with a short summary. If you send a new message instead, the waiting changes are cancelled and the model is told you moved on.

### Reading web pages, Eclipse articles and docs

The assistant can open any public web page or document with `read_web_page`: a link you give it, a prospect's website, a news story or a search result. Orbit first fetches the page from its own server, after checking the address resolves to a public internet address (private, local and cloud metadata addresses are refused, after every redirect too), and gives the assistant the title, description, the main text (the `<article>` or `<main>` part when there is one) and the links on the page, so it can click through. When that fetch is refused (401, 403, 429 or 503), times out, or the page has almost no text because it is drawn with JavaScript, Orbit opens it in a real browser on Browserbase (with Browserbase's proxies when the site blocked the plain request), waits for it to load, reads it and releases the browser straight away. Set `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` to turn this on; without them, short pages come back as they are and blocked ones say so. PDF, Word, PowerPoint and Excel files (up to 50 MB) are read as text. Sites that forbid automated reading, LinkedIn in particular, may still refuse. This works whether web search is on or off; web search is for finding pages you don't have the address of.

With `PARALLEL_API_KEY` set, the assistant can also check facts with `check_web` before it states them or writes to someone: yes or no questions (how likely, 0 to 100), pick-one questions and scores about a company or person, answered from the live web in about a second with the sources used, for $0.001 a call. No answer is treated as unknown, never as no.

`social_lookup` reads LinkedIn and X through Mindcase (mindcase.co) as structured data, since LinkedIn blocks ordinary page reading: a LinkedIn profile (headline, location, about and recent roles, the reliable way to check someone's current job), a LinkedIn company, recent LinkedIn posts, an X profile or recent X posts. Give it a link or handle, or a contact or company and it uses the LinkedIn link Orbit has. Mindcase charges per record (a LinkedIn profile is $0.004, a tweet $0.00025); every lookup is logged in `crm.data_usage` with its cost, and lookups stop for the month once the workspace reaches `MINDCASE_MONTHLY_LIMIT_USD` (default $20). Workflow Ask AI steps have Read their LinkedIn profile, which adds the contact's current profile to the prompt; Spot job changes and Check if someone moved use it.

### Knowledge

Knowledge holds documents and links for the assistant to search, each tagged to a company (the Knowledge section on the company page) or to Eclipse (Settings › Knowledge). Upload PDF, Word, PowerPoint, Excel, text, HTML, subtitle (VTT, SRT) and audio files up to 50 MB, or add a link. Links to YouTube videos read the captions, and links to podcast episodes (Apple Podcasts, an episode page or an audio file) read the transcript the show publishes in its feed, or transcribe the audio through the LLM gateway (`universal-2`, in 9 MB pieces for long MP3s). Spotify doesn't share episode audio. Add website maps a whole site (its robots.txt sitemaps, or its links when it has none, keeping to the site and honouring robots.txt) and lets you choose which pages to add. Each page is read in full, and pages of one site are grouped in the list. YouTube refuses some requests from servers, so set `SUPADATA_API_KEY` to read any video.

Call and meeting transcripts join their company's Knowledge when the call summary is ready, and opening a company page adds up to 25 of its earlier summarised calls each time. Removed transcripts stay removed. Mail is private, so attachments are only added when you ask: the book button next to a readable attachment in the Mail reader adds it to the company of anyone on the thread, or to Eclipse.

Each item is read in the background, split into overlapping passages of about 1,200 characters, embedded with `text-embedding-3-small` into `crm.knowledge_chunks` (pgvector, HNSW) and summarised. The assistant's `search_knowledge` ranks passages by meaning and by keyword together (reciprocal rank fusion), and falls back to keyword search when embeddings are unavailable. `read_knowledge` reads an item 100,000 characters at a time, and `get_company` lists a company's items with their summaries. Items are shared with the workspace, and adding or removing one is audited.

### Eclipse app

The assistant can work in the Eclipse app through Eclipse's MCP server (`https://app.geteclipse.co/api/mcp`), with the token in `ECLIPSE_MCP_TOKEN`. Eclipse has over 300 tools, so the assistant doesn't load them all: `eclipse_guide` returns Eclipse's guide for agents (clients, previews and costs, operations, errors), `eclipse_tools` searches the tools by what you want to do and returns their exact inputs, `eclipse_read` runs read-only tools (`get_`, `list_`, `search_`, `browse_`, GEO reports and tools whose description says they change nothing) and previews tools that cost money or have consequences without running them, and `eclipse_action` runs everything else after you approve the card, adding Eclipse's `confirm` and a fresh retry key for tools that need them. Calls run as the token's owner, so Eclipse charges any cost to that account. The tool list is cached for ten minutes and the guide for an hour; results over 200,000 characters are cut.

### Writing to prospects

Everything Orbit's AI writes (assistant answers, emails and drafts, Mail's drafts and prepared replies, and workflow AI steps) follows the same house rules from `lib/writing-style.ts`: no em or en dashes, no colon in the middle of a sentence, and an article is never called a "piece".

For a first email to someone who doesn't know you yet, the assistant reads `cold_email_playbook` (in `lib/assistant/cold-email.ts`). The standard is an email a busy expert finds worth replying to: it never tells them about themselves (what their company, products or role are; the research is for choosing what to say), it takes their own point one step further with something specific they probably don't know (a number, finding or example quoted exactly from an article it has read in full), includes the link so they get the value without replying, doesn't pitch what their company already offers (it reads their website first), and ends with one question about their own work. When it can't find something new and specific, it says it's a NO-SEND and what's missing. The playbook includes a worked example and the Eclipse outreach brief (no customer results are approved yet; figures from Eclipse's own articles may be quoted exactly with the link). Before proposing the send it runs `cold_email_check`, which checks value as well as format. Rules: length (40 to 120 words), one closing question, the useful thing included rather than offered ("Shall I send you the article?" fails, and an article mentioned without its link fails), every figure appearing word for word in the evidence, no meeting ask, no filler or hype, no dashes, no colons mid-sentence and never "piece". A rule also fails more than one sentence about them, or a long one. Grading: Jev (TypeSafe, when `TYPESAFE_API_KEY` is set) answers whether it avoids telling them what they already know about themselves, whether it tells them something new, gives value without a reply, avoids pitching what their company already offers, has a question about their work, is worth a busy expert's reply, matches the evidence, keeps claims within the brief and has an honest subject; if Jev isn't set up or fails, Orbit's own AI answers the value questions. The assistant fixes what fails, at most twice, and tells you the signal, the new information and its source, and its honest view of whether it's worth replying to.

`eclipse_articles` lists Eclipse's articles at https://geteclipse.co/articles (from the site map, newest first, with summaries), finds them by topic and reads them in full. The assistant uses them as sales collateral: when writing outreach or a follow-up, it looks for an article that fits the prospect and uses it as the reason to get in touch, with its exact link. `eclipse_docs` reads the Eclipse documentation at https://docs.geteclipse.co (the `llms.txt` index and each page as markdown) so it can check how a feature works before explaining it. Both are cached for an hour.

### Web search

The globe button (Web) turns web search on for the chat, and the setting is saved with the chat. Gateway models get `web_search_options`, ChatGPT models the `web_search` tool, and Claude account models Claude Code's `WebSearch` tool. Up to 30 cited pages show as links under the reply. With web search off, the assistant says you can turn it on when a question needs the web.

### Tagging records with @

Type `@` in the message box to tag a person, company, task or opportunity. Before you type a name, the list shows four recently updated people and three companies. As you type, it searches up to five people, four companies, three tasks and three opportunities: names that start with what you typed come first, then names with a word starting with it, then names that contain it.

A tagged record is stored in the message as `@[Name](kind:uuid)`, where kind is `contact`, `company`, `task` or `opportunity`. The model sees it as `Name [person id <uuid>]` (`company`, `task` or `opportunity` for the others) and uses the id directly instead of searching. In the chat, tags show as chips that link to the record.

### Learning

Orbit learns every night so the assistant doesn't start from scratch. Settings › Learning shows everything it has learned, with sources, and lets you pin, edit, add or forget any note.

- **About you** (private to each person, `crm.memories` with `scope = 'personal'`): preferences, corrections, standing instructions, people and goals, learned from your assistant conversations, the actions you approve or decline, and how you edit prepared replies.
- **The business** (shared): ICP and audience, buying triggers, objections and the answers that worked, competitors, pricing reactions, messaging that gets replies, and win and loss patterns, learned from deal stage changes, won and lost deals, call summaries, the tone of emails received and logged notes and meetings. It never reads anyone's private mail mirror.
- **The market** (shared): themes, competitor moves, launches, funding and buying signals on accounts, learned from market notes. Market notes not touched for 60 days are retired unless pinned.
- **Morning brief** (per person, `crm.daily_briefs`): written after the shared learning, shown at the top of Capture and read by the assistant with `get_daily_brief`, with what changed in the market, accounts to act on and what Orbit learned.

`/api/cron/learn` (the `orbit-learn` job) runs each part once a day per workspace and member. A market run that finds no new notes before 3am UK time doesn't count, so notes Grok Bot sends around 1am are still learned that night, and the brief waits for them. Each run gives the model the existing notes most related to that night's material as well as the most recent, so it updates rather than duplicates. On Sunday nights the business, market and personal runs also tidy their memory: the model merges duplicates and retires stale or contradicted notes, then the oldest, least confident learned notes are retired to keep at most 150 business, 150 market and 100 personal notes. Pinned notes and notes people wrote are never changed. Market notes that were learned more than 90 days ago are deleted. Every model call treats the material as untrusted and returns additions, updates and retirements; learning never rewrites or retires notes you pinned or wrote. Owners and admins can press Learn now to run all four parts straight away; members run their own and their brief. The assistant gets a briefing in every conversation, sent as information before the chat rather than in its instructions: pinned notes, then the best notes per scope by confidence, freshness and kind (ICP, objections, instructions and the like count for more), and notes related to the latest messages. It is capped at about 6,000 tokens however many notes exist, and has `recall`, `get_daily_brief`, `remember`, `forget`, `list_watchlist` and `update_watchlist`.

**Grok Bot.** The watchlist (topics, competitors, people, target accounts and sources) tells Grok Bot what to research. An owner or admin creates its token in Settings › Learning; the token has only the `market:write` scope, and the MCP server then offers it just `get_watchlist` and `add_market_notes` (up to 50 notes a call; a link Orbit already has is skipped). Add it in Grok Bot under Settings, Plugins as a custom MCP server pointing at `/api/mcp` with `Authorization: Bearer <token>`, and create a nightly routine with the instructions shown on the page. Replacing the token revokes the old one.

### Chats and privacy

Every chat is saved. Past chats lists your 100 most recent, Delete removes a chat and its messages, and New chat starts again. The dock reopens the last chat for the rest of the browser session. A chat's title is its first message, cut to 80 characters.

Chats are private to the person who wrote them. Other workspace members, including owners and admins, can't read them, and agent tokens and the MCP server have no access. What goes to the model provider: the system prompt (your name and email, today's date, the Eclipse summary and the tool list), the chat so far, and the results of the tools it called.

The assistant does not read `LLM_MODEL`; that only sets the default for call summaries and other single model calls. `LLM_API_BASE_URL` (default `https://api.llmapi.ai/v1`) applies to both.

## AI accounts

Settings › Integrations, AI accounts lets each person use their own Claude or ChatGPT plan in the assistant. Models from a connected account appear in the model picker, and usage counts against that plan. Accounts are per person: nobody else in the workspace can use or see yours.

### ChatGPT

1. Choose Connect next to ChatGPT. Orbit shows a code and an Open ChatGPT sign-in button (`https://auth.openai.com/codex/device`).
2. Sign in there and enter the code. The Settings page checks every few seconds and shows Connected as <your email> once you approve. The code lasts 15 minutes.

Orbit uses the device sign-in from OpenAI's Codex and needs a ChatGPT account attached to the sign-in. The access and refresh tokens are encrypted with `APP_SECRET`. A token is refreshed when it has less than two minutes left, or once when ChatGPT answers 401; if renewal fails, Settings shows the error and the assistant asks you to reconnect. Assistant turns on GPT-6.1 Sol, GPT-6 Astra or GPT-6 Luna go to ChatGPT's Codex Responses endpoint (`https://chatgpt.com/backend-api/codex/responses`) with `store: false`. Disconnect deletes the tokens.

### Claude (Orbit Agent)

Claude account models run through Orbit Agent, a small command-line program on your Mac. It answers with your own signed-in Claude Code, so it only works while it is running.

1. Install Claude Code and sign in: run `claude`, then `/login` if it asks. Orbit Agent needs Node.js 20 or later.
2. In Settings › Integrations, AI accounts, choose Pair a Mac. Orbit shows a command with a one-time code that works for 10 minutes:

   ```bash
   npx -y --package=https://orbit.geteclipse.co/downloads/orbit-agent.tgz orbit-agent --pair ABCD-EFGH --install
   ```

   On any other Orbit address the command uses that address for the package and adds `--url <address>`.
3. Run it in Terminal. The Settings page updates when the Mac connects. On its first run, npx downloads the package and its dependencies (the Claude Agent SDK and zod).

The command ends with `--install`, which sets Orbit Agent up as a background service on the Mac (a LaunchAgent in `~/Library/LaunchAgents/co.geteclipse.orbit-agent.plist`): it starts when you log in and restarts if it stops, so Terminal can be closed. It fetches the latest Orbit Agent each time it starts and logs to `~/Library/Logs/orbit-agent.log`. `orbit-agent --uninstall` stops that, and `--logout` also forgets the pairing. Without `--install` it runs only while the Terminal window is open. If it isn't running, the assistant says when the Mac was last seen and gives the command to start it. The pairing is saved in `~/.config/orbit-agent/config.json`, which only your user can read.

| Option | What it does |
| --- | --- |
| `--pair CODE` | Pair this Mac with a code from Settings. Without a saved pairing and without `--pair`, it asks for the code. |
| `--url URL` | Orbit address. Default `https://orbit.geteclipse.co`. |
| `--name NAME` | How the Mac appears in Orbit. Default: the computer's host name. |
| `--install` | Set Orbit Agent up as a background service (LaunchAgent) and start it. |
| `--uninstall` | Stop the background service and remove it. |
| `--logout` | Forget this Mac's pairing. |
| `--help`, `--version` | Show help or the version. |

On start it checks that Claude Code is signed in, and says so if Claude Code is using an API key rather than your plan. Settings lists each paired Mac as Running, or with when it was last seen. Remove unpairs a Mac at once; the agent then stops and asks to be paired again. If no paired Mac is running, a Claude turn ends with "Start Orbit Agent on your Mac to use your Claude account."

Claude Code runs with Orbit's tools only, plus web search when it is on. It has no file, shell or other built-in tools, and loads no user or project settings. Its working folder is `~/.config/orbit-agent/workspace`. Proposed changes still come back to Orbit for your approval and run on Orbit's server, not on the Mac. Orbit Agent removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY` from the environment it gives Claude Code, so Claude Code uses your Claude login.

### Assistant and Orbit Agent routes

| Method | Path | Auth | What it does |
| --- | --- | --- | --- |
| `POST` | `/api/assistant` | Signed-in session; 60 requests per 10 minutes per person | Send a message or decide on proposed changes. Streams NDJSON events. |
| `GET` | `/api/assistant/probe` | `Authorization: Bearer <CRON_SECRET>` | Checks tool calling (and, with `search=1`, web search) on each model |
| `POST` | `/api/companion/pair` | None; one-time pairing code in the body; 10 attempts per 10 minutes per IP | Swaps a pairing code for an agent token |
| `GET` | `/api/companion/me` | `Authorization: Bearer oa_…` | The paired Mac, its user and workspace |
| `GET` | `/api/companion/next` | `Authorization: Bearer oa_…` | Waits up to 25 seconds for the next job |
| `POST` | `/api/companion/jobs/{id}/tool` | `Authorization: Bearer oa_…`, job claimed by this Mac | Runs one read tool as the paired user |
| `POST` | `/api/companion/jobs/{id}/complete` | `Authorization: Bearer oa_…`, job claimed by this Mac | Saves the answer |
| `POST` | `/api/companion/jobs/{id}/fail` | `Authorization: Bearer oa_…`, job claimed by this Mac | Marks the job failed with a message |

Every `/api/companion` route allows 600 requests a minute per Mac and answers with `cache-control: no-store`.

## Opportunities

### Stage history and stalled deals

Stage history is read back from the `opportunity.stage_changed` audit events, and creating a deal counts as entering its first stage. A deal's page lists each stage it has been in, the date it entered and the days it spent there. A deal is stalled when it is open and nothing has happened for 7 days since it entered its stage: no activity or filed email on the deal, its company or its contact, and no open task due within the last 7 days or later (a task long overdue doesn't count; only tasks you can see count). The assistant has `get_deal_history`, `pipeline_report` (per stage: deals now, entries, median and average days, moves forward, won, lost, back and stalled, and conversion to won, plus the win rate since a date, 90 days by default) and `stalled_deals`. The morning brief lists your stalled deals and unassigned ones under Deals gone quiet.

## Boards

Boards sit under Opportunities in the side menu and track clients through stages of your choosing, for example Onboarding. New board (at the bottom of the tree) creates one with To start, In progress and Done. Click the board title to rename it, double-click a stage to rename it, use the + between columns to add a stage, and drag columns to reorder them. Settings on the board edits the name and stages, deletes the board (its cards are archived), and has Add companies when a deal is won.

Adding happens in place, with no pop-up. On a board, Add company at the foot of a stage (or a click on a stage's empty space) opens a card there: type to find a company, or add a new one, then pick a contact at it or add a new person, and press Enter. The card stays open for the next one, and Esc closes it. The list view has the same row under the list, with a stage picker; Opportunities works the same way and also takes a name (the company's, if left blank) and a value. Contacts and Companies have an add row at the end of the list (name, then email and company, or name and website), and the Add button in the header jumps to it.

A card is a company, at most once per board, with a main contact and a due date. The main contact (and an opportunity's primary contact) must work at that company: the contact search only lists the chosen company's people, picking a contact first fills in their company, and changing the company clears a contact who doesn't work there. Cards drag between stages like opportunities, and there is a list view too. Opening a card shows the activity pad, the company's recent activity and open tasks, and Remove from board. The company page lists the boards it is on.

When an opportunity is marked won, its company becomes a Customer, and every board with Add companies when a deal is won gets a card for it in its first stage. The assistant can create, rename and delete boards, change their stages and auto-add setting, add companies, and move or remove cards.

## Proposals and NDAs

Proposals in the side menu has three tabs: Proposals, Templates and Products.

Products are what you sell: a name, a description, a price in pounds, dollars or both, and one-off, monthly or yearly billing. Archived products stay on proposals that already use them.

Templates are Draft, Active or Archived, and only active ones can be used. A proposal template can be split into tabs (Add tab), so the client gets a small website: the starter has Overview, Proposal, Documents and Terms, and signing is a Sign tab that Review and sign opens from anywhere. Besides text, pricing and terms, Add section offers a video (YouTube, Loom or Vimeo), an image, documents chosen from the company's or Eclipse's Knowledge (each open is logged on the proposal's timeline and alerts you, and the signed PDF lists them with a fingerprint), your booking page built into the page with the client's name and email filled in, questions, a quote, the team and an embed (Figma, Google Slides, Typeform, Miro, Canva and similar). Next steps is a shared plan: the template sets the starting steps (who does each and how many days after the proposal is created), each proposal keeps its own live list in Next steps on the proposal page, the client ticks off their own steps on their page (you get an alert, and it shows on the timeline), and Email sends them their open steps. Steps aren't part of the signed version. The client page also records how long the client spends on each tab while it's in view (signed-in Orbit users aren't counted): the proposal page shows the total and the split, each visit shows on the timeline, and get_proposal gives it to the assistant. The assistant can write every kind of section with update_proposal, sharing documents by their Knowledge id, and change a sent proposal's plan with update_proposal_steps. Empty sections and tabs are hidden from the client. Cover, image and team photos are uploaded to a public `proposal-media` bucket. Start from a proposal, a mutual NDA or a one-way NDA, or copy one you have. A template is a list of sections (cover, text, pricing table and terms, with an optional link to terms on your website), your logo, a colour and how many days a proposal stays valid. Upload the logo on the template (PNG, JPEG or SVG; Orbit turns it into a PNG): it shows at the top of the client's page, on the cover and on the PDF, so different templates can carry different brands. Drafts pick up a changed logo, and sent copies keep the logo they were sent with. Text takes fields such as `{{contact.firstName}}`, `{{company.name}}` and `{{proposal.total}}` through Insert field, and simple formatting: a blank line between paragraphs, `- ` for bullets, `## ` for a subheading, `**bold**` and `[text](https://…)` for links.

Create proposal on a company or contact (or New proposal on the Proposals page) asks for the person at the company, an active template, the currency, and the products and quantities. Every proposal needs a company and someone who works there. Creating a proposal also puts the company in the Proposal stage on Opportunities: if the company has one open deal, the proposal is linked to it and the deal moves to Proposal (deals already past Proposal stay where they are); if it has none, a deal named after the company is added at Proposal, with the contact, owner and the first year's value (one-off plus twelve months plus yearly), and linked to the proposal. NDAs don't touch Opportunities. The draft opens in Orbit with a preview of exactly what the client will see: change the title, currency, valid until date, prices, quantities and wording there. Changes to a draft never touch the template. Orbit won't send while a field is missing (for example a contact with no job title) or while text in square brackets, such as the starter's `[Describe the first deliverable]`, is still there.

Send locks a numbered version, keeps a fingerprint and a PDF of it, and makes a private link at `/p/<link>`. It emails the link from your mailbox with your signature, or Copy link only gives you the link to send yourself. Make changes on a sent proposal turns it back into a draft while the client keeps seeing the sent version, and sending it again makes version 2 on the same link (a new link only if the contact's email changed).

The client page is a light, mobile-friendly page with Download PDF and Review and sign. The client confirms their name, job title and company, types their name as their signature, ticks that they agree to the proposal and the terms it includes (an NDA's wording says the agreement), and selects Agree and sign. They can also decline with a reason. Then you countersign from the proposal in Orbit (the owner, an owner of the workspace or an admin can), with your job title and typed name. Both of you then have the signed PDF, which ends with a signing certificate: the fingerprint, who signed, when, from which IP address and browser, and every view. The client is emailed the signed copy.

Opens and signatures show on the proposal's timeline. You get a notification in the bell and a push notification when it is first opened (and again if it is reopened more than an hour later), when the client signs and when they decline. Views by people signed in to Orbit don't count. A proposal past its valid until date shows as expired and can no longer be signed.

Status shows on the company and contact pages (Proposals), on the Proposals page with filters (drafts, waiting, signed, declined or expired), and on Opportunities as a Proposal tag on each deal in the list and a line on each card on the board. The assistant and the MCP server can list, create and change proposals and products. The assistant can also send one once you approve it; through MCP you send it from Orbit. Signing is always done by a person. Have a solicitor check the NDA and terms wording before you use them.

## Workflows

Workflows automate work around your records. Each person builds their own on the Workflows page, and runs use that person's permissions. Share as a template (under More on a workflow) lets everyone in the workspace copy it. Orbit's starter templates are Follow up when a client turns at risk, Product requests to Linear, Spot job changes (each month, check the contacts you've been quietest with on the web, and when someone has moved and you approve, note it, move them to their new company and create two follow-up tasks) and Check if someone moved when an email bounces.

A workflow is built on a canvas, like n8n. It always starts with a When node (the trigger). The list on the left holds every other node: click one to add it below the selected node (already connected), or drag it onto the canvas. Connect nodes by dragging from the dot under a node to the next one. If has a Yes and a No output, and For each item has Each item and Done. Click a node to edit just that node in the panel on the right; Backspace or Delete removes the selected node or connection. Nodes can be dragged anywhere, and the canvas pans and zooms. On a phone, Add node opens the list and a node's settings open in a sheet.

| Trigger | Fires when |
| --- | --- |
| A call summary is ready | A call or meeting summary finishes (Granola, Teams, or a pasted transcript) |
| A record is created | A company or contact is created |
| A field changes | A chosen company or contact field changes, optionally to a set value |
| A deal or card changes stage | On Opportunities or a board, optionally to a chosen stage |
| A company is added to a board | A card is added to the chosen board |
| An activity is logged | Optionally of one type (call, email, meeting, note) |
| A task is completed | Any task you can see |
| Run from a record | You choose it from the lightning button on a company or contact page |
| On a schedule | Daily, weekly or monthly (day 1 to 28) at a time, London time |
| A proposal changes | A proposal or NDA is sent, opened for the first time, signed by the client, fully signed or declined, optionally only for proposals or only for NDAs. It gives the proposal's title, value, status, links and who signed. |
| An email arrives | A new email in your inbox: any email from a contact, a reply to an email you sent, a bounce (the contact is the person whose address bounced), or an automatic reply such as out of office or "I've left". It runs privately for you and gives the email's subject, sender, text and link. |

"Only when it's mine" limits a trigger to your own calls, changes and tasks. Email triggers are always yours alone: another member's workflows never see your mail.

| Node | What it does |
| --- | --- |
| Ask AI | Sends a prompt to the LLM API with the model you choose and returns the named answers you define (text, number, yes or no, list, or one of a set of choices). Each answer becomes a field for later steps. Search the web lets it look things up (news, LinkedIn, company sites) and adds a sources answer with the addresses it used. Give it what Orbit knows adds the record's details, recent activity, deals and your recent emails with the contact. Read their LinkedIn profile adds the contact's current LinkedIn profile, read through Mindcase. Emails and web pages are treated as material to read, never as instructions. |
| Check the web | Asks the live web through Parallel (with `PARALLEL_API_KEY`), for $0.001 a check. Each question is yes or no (how likely, 0 to 100), pick one of your options (the option, or empty when the evidence doesn't settle it, plus its confidence) or a score on your levels (0 for the first level, to one decimal), and becomes a field for later steps, such as an If on the likelihood. A question with no answer is empty. It sends the run's company name, domain and website, the questions and the optional About text, and also gives the sources it used. It runs in test runs too. |
| If, Continue only if | Branch on a condition, or stop this path unless it is true (is, is not, contains, is empty, more than, less than). |
| For each item | Runs the nodes connected to Each item once per item of a list, then carries on from Done. |
| Wait | Pauses for minutes, hours or days. |
| Wait for approval | Optional. Pauses until you approve or reject it on the Workflows page; rejecting stops the run. The approval shows in the bell, as a count next to Workflows in the side menu, and as a push notification on every device with notifications on; tapping it opens the approval. |
| Find records | Lists up to 100 companies or contacts by lifecycle, tag, owner, open deal, how long since you were last in touch and a search, ordered by longest since last contact, oldest, newest or name. Skip records found in the last N days so a weekly or monthly run works through a long list in batches. Give its records to For each item, and inside the loop the company and contact nodes act on each record in turn. |
| Find or create record | Finds a company (by domain, then name) or a contact (by email), or creates it. New companies are enriched when auto-enrichment is on. Its id lets later nodes use it, for example Update record setting a contact's Company to `{{steps.upsert_record_1.id}}` to move them; it can also become the run's company or contact. |
| Create task, Add note, Update record | Act on the run's company or contact. Tasks can go to ClickUp too. Update record covers lifecycle, health, owner, industry, size, source, description, name, domain, website, LinkedIn and phone on companies, and owner, job title, company, source, notes, name, email, phone and LinkedIn on contacts. |
| Add to or move on a board | Puts the company on a board or moves its card. |
| Notify someone | Sends an in-app notification to you, the record's owner, or a member. |
| Send email | Emails the run's contact from your mailbox and logs it. |
| Create proposal | Drafts a proposal for the run's contact at their company from an active template, in pounds or dollars. With AI picks from the call, it reads the call summary and transcript (or the record's recent history) and picks products and quantities from your live product list, with optional guidance on how to choose, so there is no product list to keep up to date in a prompt. Or, with Always the products I tick, it uses those. It outputs the proposal link, title, total, products and why it chose them, for a Notify someone step. If nothing fits, it stops without a draft. Nothing is sent, and test runs create nothing. |
| Create Linear issue | Creates an issue in the Linear team. |
| Send to a webhook | Posts to an https address, such as a Slack incoming webhook, Zapier or Make: your own body with fields, or the run's company, contact and node results as JSON. Private and local addresses are refused. |

Every text field has Insert field, which adds a value such as `{{company.name}}`, `{{call.summary}}`, `{{steps.ai_1.health}}` or `{{loop.item}}`, from the trigger and the nodes above it. Lists are written one item per line. A path simply ends at a node with nothing connected below it.

Test run runs a workflow against a record you choose: AI and logic run for real, and actions only show what they would have done. The Runs tab lists runs; selecting one marks each node on the canvas as Done, Failed or Waiting and shows every node's result. Failed runs notify you with the reason. A workflow's own changes never trigger it again, and runs set off by other workflows stop three levels deep.

Event triggers run straight away; email triggers start when the mail arrives (Outlook tells Orbit about new mail within seconds, and the five-minute mail job catches the rest). Waits, approvals and schedules continue when someone uses Orbit and on every `/api/cron/sync` call (every 10 minutes in production), so they can be up to ten minutes late. `/api/cron/workflows` runs only workflows if you want them more often.

## Linear

Set `LINEAR_API_KEY` to a Linear personal API key (Linear, Settings, Security and access) and redeploy. Settings › Integrations shows whether it is connected and which team issues go to. `LINEAR_TEAM_KEY` picks the team by its key (default `CNT`). The assistant can search and read issues freely, but only creates, comments on or updates them when you ask, through an approval card; created issues can link back to the Orbit company. Workflows can create issues with the Create Linear issue step. Every issue is created with the server key, so Linear shows its owner as the author.

## Notifications

The bell shows workflow updates (approvals waiting, failed runs, Notify someone steps) above your due tasks. Opening it marks the updates read. The Workflows item in the side menu shows how many approvals are waiting for you.

## Search engines

`robots.txt` disallows every path and the sitemap is empty, so search engines don't index Orbit. `/llms.txt` is public and lists Orbit's name, description and the Companies page.

## Environment variables

Every variable Orbit reads. `.env.example` lists them with comments (aliases such as `SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SITE_URL` are noted here).

| Variable | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL`, `DATABASE_ADMIN_URL` | Everything | `crm_app` and `crm_admin` (or `postgres` locally). |
| `APP_SECRET` | Everything | At least 16 characters. Signs local sessions and encrypts stored tokens, keys and calendar links. |
| `DEV_USER_EMAIL`, `DEV_USER_PASSWORD`, `CRM_AGENT_TOKEN` | Local development | Written by `db:setup`. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Hosted sign-in, email attachments (Storage) | Unset means local password sessions and no attachments. |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | Invites, email attachments | Server only. Creates confirmed logins for invitees, and signs uploads to and reads from the private `email-attachments` Storage bucket. |
| `SITE_URL` (or `NEXT_PUBLIC_SITE_URL`) | Links in emails, ClickUp, Linear and invites; webhooks and Teams subscriptions | The https origin, with or without `https://`. |
| `CRON_SECRET` | `/api/cron/sync`, `/api/cron/workflows`, `/api/cron/mail`, `/api/cron/mail-due`, `/api/assistant/probe` | Bearer secret. |
| `MAIL_STORAGE_LIMIT_MB` | Mail mirror | Optional. The database size at which the mail backfill pauses (default 400). Raise it on a Pro Supabase project. |
| `MAIL_HARD_STOP_MB` | Mail mirror | Optional. The database size at which all mail sync stops, new mail included (default 18% above `MAIL_STORAGE_LIMIT_MB`, so 472 on the defaults). |
| `NEXT_PUBLIC_TIMEZONE` | Optional | Default `Europe/London`. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT`, `MICROSOFT_REDIRECT_URI` | Mail, Capture, calendar, invites, Teams | See Microsoft inbox. |
| `LLM_API_KEY`, `LLM_API_BASE_URL`, `LLM_MODEL` | Assistant, call summaries, Mail AI (summaries, prepared replies, Write with AI, Ask, invites from a thread), activity and task pads, workflow AI steps | Default gateway `https://api.llmapi.ai/v1`, default model `claude-haiku-5-5` (the assistant and workflow steps pick their own). |
| `GRANOLA_API_KEY`, `GRANOLA_API_BASE_URL` | Granola for the key's owner | Others connect their own key in Settings. |
| `CLICKUP_API_TOKEN`, `CLICKUP_API_BASE_URL` | ClickUp | |
| `LINEAR_API_KEY`, `LINEAR_TEAM_KEY`, `LINEAR_API_URL` | Linear | Team key default `CNT`. |
| `CONTEXT_DEV_API_KEY`, `HUNTER_API_KEY`, `ENROW_API_KEY`, `ICYPEAS_API_KEY` | Enrichment | Each key turns its provider on. |
| `PARALLEL_API_KEY` | Web checks | Turns on the Parallel Decisions API for tagging, filling gaps, weekly signals and ICP fit, the Check the web workflow step, and the assistant's `check_web`. |
| `NEXT_PUBLIC_CONTEXT_LOGO_CLIENT_ID` | Logos in lists | context.dev Logo Link public client id. |

## Hosted Supabase

The Orbit project is `xuvofoydyewbloybrmas` in `eu-west-1`: `https://xuvofoydyewbloybrmas.supabase.co`.

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the project URL and the publishable key. Point `DATABASE_URL` at `crm_app` and `DATABASE_ADMIN_URL` at `crm_admin` on the session pooler (`aws-0-eu-west-1.pooler.supabase.com`, port 5432), with `sslmode=require`. The database name is `postgres`. Do not run `supabase/bootstrap/local-auth.sql` there. Apply new migrations before deploying code that depends on them: run `npm run db:setup` with the hosted variables. It applies each migration not yet listed in `private.schema_migrations` and recomputes company match keys. If a migration fails with `must be owner`, run that file in the SQL editor, insert its filename into `private.schema_migrations`, and run `db:setup` again. Turn off new-user sign-ups in the Supabase Auth settings as well, and set `SUPABASE_SERVICE_ROLE_KEY` (the project's secret key) so invites can create logins without a confirmation email. Without it, invites fall back to Supabase sign-up, which needs sign-ups on and `<SITE_URL>/auth/callback` in Authentication, URL Configuration, Redirect URLs. Keep the service role on the server. Do not put it in an agent token or a `NEXT_PUBLIC_` variable.

## Agents

```bash
npm run agent:create -- --name "Research" --scopes crm:read,companies:write
```

The token is printed once. Store it. Revoke a credential by setting `crm.agent_credentials.revoked_at`.

API: `docs/api.md`. MCP: `docs/mcp.md`. Schema and tenancy: `docs/architecture.md`. What was removed from the prototype: `docs/audit.md`.

## Scripts

| Script                 | What it does                                               |
| ---------------------- | ---------------------------------------------------------- |
| `npm run dev`          | Next.js dev server                                         |
| `npm run build`        | Production build                                           |
| `npm start`            | Serve the production build                                 |
| `npm run lint`         | ESLint                                                     |
| `npm test`             | Domain, API, and MCP tests against the `crm_test` database |
| `npm run db:setup`     | Apply schema and seed a local user                         |
| `npm run db:reset`     | Drop local CRM data and set up again                       |
| `npm run agent:create` | Issue a revocable agent token                              |
| `npm run mcp`          | MCP server over stdio                                      |
| `npm run companion:pack` | Bundle the Orbit Agent into `public/downloads/orbit-agent.tgz` (part of `build`) |
