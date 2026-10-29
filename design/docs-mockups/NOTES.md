# Docs mockups: design notes

Static mockups for a Docs area in Orbit. They are built from Orbit's own sidebar pieces, `SectionHeader`, `Button`, `Kbd`, `CommandDialog`, `Popover`, `Radio`, `Switch` and `CopyButton`, with sample data and no backend. Route: `/docs-mockup/<screen>` on branch `worktree-agent-a58c2af2c3fb8ad35` (screens: main, link-picker, quick-open, quick-open-search, share, daily, history, approval, phone-folders, phone-list, phone-note, phone-picker).

## Screens

| File | What it shows |
| --- | --- |
| 01-desktop-note-open-live.png | Three panes with Q4 partner strategy open: live preview, `[[link]]`, `#tags`, `@Acme` chip, presence, Priya's cursor, the assistant writing, backlinks, Shared in the header |
| 02-desktop-wikilink-picker.png | `[[Acme renewal` mid-typing, with matching notes, a heading, a daily note and Create |
| 03a-desktop-quick-open-recent.png | ⌘K with nothing typed: recent notes and actions |
| 03b-desktop-quick-open-search.png | ⌘K with "acme": title matches, notes that mention @Acme, and actions |
| 04-desktop-share-folder.png | Share popover on the private Clients folder, with shared marks in the tree and list |
| 05-desktop-daily-note.png | Today's daily note: month calendar, list of days, timed entries, a capture line |
| 06-desktop-version-history.png | History panel (people, the assistant and an MCP agent) with an inline diff |
| 07a to 07d-phone-*.png | Phone stack: folders and tags, note list, open note with presence, `[[` picker |
| 08-desktop-assistant-approval.png | The assistant's approval card for a doc edit, with a diff, in the existing dock style |

## Key decisions

**Layout.** Docs follows Mail: global sidebar, list pane, then the editor in Mail's inset reading card. The right side of the card holds a panel you can switch on or off (Backlinks and details, or Version history), so the three panes stay three. The note text column is capped at 38em (about 70 characters at 16px), so it reads well with the panel open or closed.

**Sidebar.** Docs is its own section under the main nav, built like Opportunities and its boards: a Docs row with a + button, then an indented tree. Daily notes comes first, then folders, then a quiet TAGS label and the tag tree. Folders are where a note lives, and they carry who can see it. Tags cut across folders, are written inline, nest with `/`, and never change who can see a note. You only see tags from notes you can open.

**Private and shared.** Everything is private by default, so the UI only marks the exception:
- a blue people icon on shared folders and notes;
- the owner's avatar on folders a teammate shared with you;
- a note shared from inside a private folder gets its own icon in the list.

The editor header always says which it is (Private with a lock, or Shared in blue), and that button is the control for it. The share popover has two choices with plain consequences, says when a note inside is already shared, and states that the assistant and MCP agents follow the same rule. Daily notes are always private, and this is said where you write them.

**Presence.** People are circles with initials in their own colour. Agents are rounded squares: the Orbit assistant in Orbit violet with a sparkle, MCP agents in neutral grey with braces. In the text:
- a person's cursor is a thin bar in their colour with a small square name tag beside it;
- the assistant's cursor glows violet, its label is a pill with a sparkle and three "typing" dots, and the words it has just written get a soft violet wash.

You can tell an agent from a person at a glance, even in a small avatar stack. The note list shows "Orbit assistant is writing" on the note it is working in.

**Live preview.** Markdown symbols show only on the line with your cursor. In screen 1 that is the Northwind bullet, where `-`, `[[` and `]]` are visible and faint. Everywhere else the rendering is clean. Heading and checkbox markers hang in the left margin, Bear style, so the text never jumps sideways as the cursor moves.

**Three kinds of link, three looks:**
- `[[note]]` links are underlined in violet, with a dashed underline when the note doesn't exist yet;
- `#tags` are quiet grey pills;
- `@` records reuse the assistant's purple mention chip, with a building, person or deal icon.

**Reading styles.** The editor needs its own type scale (30px title, 19px section headings, 16px body with 1.7 line height), set up as one `noteType` map in `components/docs-mockup/editor.tsx`. In the real build these would become `.note-*` classes in `globals.css` next to the existing `.paper .doc-*` styles. Everything around the editor uses the global type scale.

**Daily notes.** These are a journal, not a document. Each entry is stamped with the time in the margin, along a faint timeline. Enter adds a new entry. A calendar and a list of days sit in the list pane, and the editor header has buttons for the previous day, today and the next day. Today's meetings from Calendar appear under the date as plain links.

**`[[` picker.** It shows notes, headings inside notes and daily notes. If you are about to link a private note from a shared one, it warns you in amber ("Teammates will see the title only"). Create always sits at the bottom, with ⇧↵.

**Version history.** Versions are grouped by day. Each one says who made it, what changed, and who asked for it when an agent did the work (for example "Asked by Mark" or "Mark's MCP token"). Selecting a version shows an inline diff in the note with a green bar in the margin, a Show changes switch, Restore and Back to live. Orbit saves a version before every agent edit, so Restore can undo any agent change.

**Approval card.** This is the existing action card with a diff block added, using the same pill buttons. It also says the note is shared and that Priya is in it, so you know who will see the change. A second button, Open in Docs, lets you review the change in place first.

## Open questions for the owner

1. **⌘N and ⌘K.** Browsers keep ⌘N for a new window, so web pages can't use it (it would work only in the installed app). Orbit's own style would be `C then N`, like `C then M` for Compose. ⌘K is also already Orbit's command palette. The mockup shows ⌘K inside Docs as the same palette with notes listed first. Is that right, or should Docs have its own key?
2. **How agent edits land.** In screen 1 the assistant types live, after the edit was approved. Should approved edits stream in with a visible cursor (as shown), or appear all at once? And should there be a per-note setting, "Let the assistant edit without asking"?
3. **Sharing.** Is shared always "everyone can edit", or do you want a View only option? The mockup assumes edit, like shared CRM records.
4. **Teammates' shared folders.** They currently sit in everyone's tree, marked with the owner's avatar. Would you rather they live under a separate "Shared with me" heading?
5. **Where backlinks live.** They are in the right panel so they are always in view. The alternative is Bear and Obsidian's approach: at the end of the note, with the panel used only for history.
6. **Phone picker.** On a phone the `[[` picker sits above the keyboard, with a row of `[[`, `#`, `@`, checkbox and heading buttons. The keyboard isn't drawn in the mockup.
