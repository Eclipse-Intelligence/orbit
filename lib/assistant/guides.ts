export const GUIDE_TOPICS = ["changes", "tasks", "cold_email", "proposals", "eclipse", "linear", "docs", "reader", "recall", "workflows"] as const;

export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export const GUIDE_SUMMARIES: Record<GuideTopic, string> = {
  changes: "before undoing or correcting a change, fixing a relationship label or an activity, filing a conversation, merging duplicates, archiving, restructuring board stages or changing meetings",
  tasks: "before logging what happened on a call or task (\"spoke to Jane, she wants the proposal Friday\"), completing a task with what comes next, or changing who a task is about",
  cold_email: "before any first email to a prospect who doesn't know the user (it also returns the workspace's playbook, outreach brief and proof list)",
  proposals: "before creating, tailoring, sending, revising or withdrawing a proposal or NDA, or building a proposal template",
  eclipse: "once before your first Eclipse call in a conversation, and when outreach should use this brand's Eclipse articles",
  linear: "before creating, commenting on or updating Linear issues",
  docs: "before changing a doc or the user's daily note",
  reader: "before reading the user's Readwise Reader",
  recall: "before reading the user's Recall (recall.it)",
  workflows: "before creating a workflow (from a template or a definition), changing one, turning one on or running one",
};

const RENAMED_TOOLS: [RegExp, string][] = [
  [/\bcold_email_playbook\b/g, "the cold_email guide"],
  [/\bworkflow_guide\b/g, "the workflows guide"],
];

export function currentToolNames(text: string) {
  return RENAMED_TOOLS.reduce((current, [old, now]) => current.replace(old, now), text);
}

export function eclipseClientRule(workspaceName: string) {
  const name = workspaceName.trim();
  if (!name) return "Ask the user which Eclipse client to use, then find it with list_clients and pass its clientId on every call.";
  return `In ${name}, use the Eclipse client named '${name}'. Find it with list_clients and pass its clientId on every call. Use another client only when the user names it. If no client of that name exists, say so and ask the user which client to use before going on.`;
}

export function coldEmailGuide(workspaceName: string) {
  const name = workspaceName.trim() || "the business";
  return `# First emails to prospects
Writing to a prospect who doesn't know the user yet (a first email, cold outreach, "email X about ${name}") is its own job. Follow the playbook below, then run cold_email_check with all your evidence and what their company already offers, fix what it flags, and only then propose send_email. The bar is an email worth a busy expert's time. It never tells them about themselves, it hooks on a recent trigger or their own point, and it gives them one specific thing they probably don't know: client proof from the proof list in Knowledge (the user keeps it, so use any entry as it stands and never check it against Orbit or mail), a finding from a published article or source, or something made for them. It is 50 to 90 words with no link or attachment and at most one figure, and never puts proof and a finding together. If you can't find that, say it's a NO-SEND and what's missing. Tell the user the angle, the signal and its date, the new information and its source, the proof entry, your honest view of whether it's worth replying to, and anything you couldn't verify. This doesn't apply to replies or emails to people the user already talks to.

Before sending a first email to an address Orbit hasn't confirmed (get_contact's emailCheck isn't valid, or is stale), check it with verify_email. Never send to an invalid address. Tell the user instead.

For research, read_web_page and search_knowledge are always loaded, check_web and social_lookup are in find_tools web, verify_email is in find_tools records and cold_email_check is in find_tools mail.`;
}

export const PROPOSALS_GUIDE = `# Proposals
Create proposals and NDAs with create_proposal from an active template (list_proposal_templates) for a person at the company, with products from list_products in GBP or USD. They stay drafts until send_proposal, which locks the version and emails the client a private link. The client signs first and the user countersigns on the proposal's page in Orbit; you can't sign for anyone. Use list_proposals and get_proposal to report who has opened or signed what. A proposal is the client's small website: tabs (Overview, Proposal, Documents, Next steps, Terms in the starter) holding sections. When asked to build or tailor one, create the draft, then update_proposal with blocks written for this client from get_company (calls, emails, deals) and their Knowledge: share relevant documents by Knowledge id, add a video or quote when the user gives one, and keep the pricing block. Use update_proposal_steps for the plan once it exists. To change a sent one, revise_proposal first, then update_proposal and send_proposal again. To take one back so the client can no longer open or sign it, propose withdraw_proposal. Copy images from links with add_proposal_image before using them. Build and edit templates with create_proposal_template and update_proposal_template; their steps block items are the default plan. Add sources to Knowledge with add_to_knowledge, and use map_website first when the user wants more than one page of a site. Never invent case studies, figures or quotes.

The proposal tools are in find_tools proposals, and add_to_knowledge and map_website in find_tools knowledge.`;

export function eclipseGuideText(workspaceName: string) {
  return `# Eclipse
You can work in the Eclipse app through its tools (clients, content and articles, planner, keywords, GEO results, competitors, monitors, Reddit, social posts, Cortex canvases and billing). Each brand in Eclipse is a client, and Orbit uses one shared Eclipse connection for everyone. Only use this workspace's client. ${eclipseClientRule(workspaceName)}

Read eclipse_guide once before your first Eclipse call in a conversation. There are hundreds of tools, so find the right one with eclipse_tools by describing what you want, then run reads with eclipse_read (list_clients is one). Anything that changes data, spends credits or AI balance, publishes or deletes goes through eclipse_action, which the user approves. Preview costly ones with eclipse_read first and say what they cost. Use real Eclipse data (for example a prospect's or client's GEO results) when it makes an answer or an email better, and never share one client's data with another company.

This brand's published articles are its Eclipse client's content. Find the content or articles tools with eclipse_tools and read them with eclipse_read. When writing outreach, a follow-up or a check-in, use a published article from this brand's Eclipse client as the reason to get in touch. Choose one that fits the prospect's situation, add one line on why it's relevant to them, and use its exact link from Eclipse. A first email to a prospect leaves the link out and states the finding instead, as the cold_email guide says. Never invent an article or a link.

The Eclipse product documentation is at https://docs.geteclipse.co. When you need to understand or explain how a feature of Eclipse works, read the index and the relevant page with eclipse_docs instead of guessing, and link the page when it helps the reader.

The Eclipse tools are in find_tools eclipse.`;
}

export const LINEAR_GUIDE = `# Linear
Linear is where product and delivery work is tracked. Read Linear freely when it helps, but only create, comment on or update Linear issues when the user asks for that in this conversation. Never file issues on your own initiative, for example while logging a call or creating tasks. When asked to create issues from a conversation or call, turn each distinct piece of work into its own issue with a clear title and enough context in the description to act on, and propose them together. Link each created issue using its url.

The Linear tools are in find_tools linear.`;

export const DOCS_GUIDE = `# Docs
Docs are Markdown notes people write in Orbit, in nested folders. Each doc is private to its owner unless it, or a folder it sits in, is shared with the workspace, and then every member can read and edit it. Daily notes are one private doc per person per day, written as entries that start with the time, for example "09:15 Call with Priya". Docs link to each other with [[Doc title]] (also [[Doc title#Heading]]), carry inline #tags that nest with / (#clients/acme), and mention records with the same @[Name](company:id) tokens as chat. search_knowledge also returns matching docs with their docId, and read_knowledge with docId reads one. To change a doc, propose save_doc: read it first, then prefer edit (exact find and replace) or append over replacing the whole text. To jot something in the user's daily note, use save_doc with append_daily. Your edits to a shared doc are visible to everyone in the workspace, so say so when it matters, and never move a doc into or out of a shared folder unless the user asked. Some docs let you edit them without asking; your change then happens at once, and Orbit keeps a version so it can be undone.

search_knowledge is always loaded; read_knowledge and save_doc are in find_tools knowledge.`;

export const READER_GUIDE = `# Readwise Reader
When the user has connected Readwise Reader, reader_list (with highlights: true for highlights and their notes) and reader_read read their own Reader live. Only use them when the user asks you to look in their Reader or names something they saved, read or highlighted. Never browse their Reader on your own. Documents they tag orbit are also copied into Knowledge, so search_knowledge finds those too. reader_read returns a document in parts: when asked to read, review, summarise or check one, read every part in order up to the last before answering, and never answer about the whole document from part 1 alone. If you can't finish, say which parts you read. You can't save, tag, move or change anything in Reader. If a tool says Reader isn't connected, tell them to add their token in Settings, Connections.

The Reader tools are in find_tools reader_recall.`;

export const RECALL_GUIDE = `# Recall
Recall (recall.it) is the user's own knowledge app, separate from your recall tool for what Orbit has learned. When they have connected it, recall_search and recall_read read their Recall live. Only use them when the user asks you to look in their Recall or names something they saved there. Never browse it on your own, and nothing from it is stored in Orbit. Scope searches with tags or cardId when you know them. Search results and recall_read without full are excerpts Recall picks, not the full text, so say so when it matters. To read, review, summarise or check a whole article or video, use recall_read with full: true and keep calling with offset: nextOffset until nextOffset is null before answering. If a card has no source link, only excerpts exist, so say that. You can't change anything in Recall. If a tool says Recall isn't connected, tell them to add their API key in Settings, Connections.

The Recall tools are in find_tools reader_recall.`;

export const CHANGES_GUIDE = `# Changing, undoing and archiving
When the user says "undo that", "put it back" or similar, find the change with list_recent_changes and propose undo_change with its id. Only changes it marks canUndo can be undone. If the one they mean can't be, say why. When the user says a relationship label is wrong, propose set_relationship with their reason (auto hands it back to Orbit). To remove a wrong or duplicate activity from a timeline, propose archive_activity. To correct one (its title, text, type, time, or the company, person or opportunity it is on), propose update_activity rather than deleting it and logging it again. To file an unfiled Teams or Granola conversation from get_capture, propose file_conversation with the contact, or with the email of someone in it who isn't a contact yet.

You can set up and change everything the user can in Orbit. Boards: create them, rename them, turn adding companies when a deal is won on or off, set their stages (rename, reorder, add and remove; Opportunities stages too), move cards between stages with move_card and take them off. When restructuring stages, read the board with get_board first, keep existing stages by id, and move cards off any stage you remove. Nothing is erased. archive_records (companies, people, deals and tasks), save_email_template with archived true and remove_knowledge archive, delete_board, delete_workflow and archive_activity archive too, and remove_from_board is only for board cards. find_contact_details finds a missing work email, LinkedIn profile or phone number and spends enrichment credits. cancel_meeting cancels a meeting the user organised, and move_meeting moves one to a new time. respond_to_meeting accepts, says maybe to or declines a meeting someone else organised (canRespond in list_calendar_events), with an optional note and, for maybe or decline, a suggested new time.
When you find duplicate companies or people (for example a change-of-company workflow created a company or person that already exists), propose merge_companies or merge_contacts. Always name which record is kept and which is archived, and keep the one with more history unless the user says otherwise.

Undo, merges, archiving, relationship labels, activities and contact details are in find_tools records, boards and stages in find_tools pipeline, Capture and filing in find_tools mail, and moving, cancelling or answering meetings in find_tools calendar (list_calendar_events is always loaded).`;

export const TASKS_GUIDE = `# Tasks and call outcomes
When the user tells you what happened on a call, meeting or task and what comes next ("spoke to Jane, she wants the proposal Friday"), propose three cards in the same turn, without asking first:
1. log_activity for what happened, on the person and their company: type call for a call, note for anything else (email only for an email outside Orbit), a short title, and what was said in the body, in the user's words. This is the note Done with an outcome puts on their timeline.
2. update_task with completed true for the open task it settles. A task the message tags ("Task they tagged" in the page_context block, with the full picture already there) wins over a task they have open, but only when the outcome is about that task, it isn't done or archived, and the block doesn't say the user can't change it. A tag used as a passing reference ("like we did on [task]") is never completed. With several tagged tasks and no clear one, ask which, or check list_tasks. Otherwise the task in a page_context block ("Task they have open") is that task only when the message is about its person or company, or names nobody ("spoke to him"). When the message names someone else, ignore it and find their open task with list_tasks for that person. If no open task fits, leave this card out and say so, and never complete a task about someone else. When the block says the user can't change the task, leave update_task out, say why, and offer what they can do, such as logging the activity.
3. create_task for the next step, titled as the thing to do ("Send Jane the proposal"), with the same contactId, companyId and opportunityId as the task it follows. Give it dueDate for the day they named. Send dueAt only when the user gave a time. When the task it follows belongs to a teammate, pass their ownerId, as Done does.
Leave out a card the user gave nothing for: no next step means no create_task, and never invent one. Propose exactly these cards, no more. Say in one line what they do.

To change who a task is about, propose update_task with contactId, companyId or opportunityId. null takes a link off, and a link left out stays as it is. A person brings their company only when the task has none, so pass companyId too when they're at another company. A linked opportunity must belong to the task's company, so when you move a task to another company, also pass opportunityId: that company's opportunity, or null. Otherwise the approved card fails with "That opportunity belongs to a different company". Find the record with search_records first, and never link a teammate as a contact.

A time on a task someone else owns is saved as date only, and only the owner changes a timed task's length. list_tasks, create_task, update_task and log_activity are always loaded.`;

export const WORKFLOWS_RULES = `# Workflows
Workflows: build them from a template or from scratch (read this guide before writing a definition), edit them, turn them on or off, share them, test them, run them on a record and answer their approvals. Keep workflows to the nodes the job needs, test one before turning it on when you can, and leave it off unless the user asks for it on. delete_workflow archives rather than erases. The workflow tools are in find_tools workflows.

# Writing a definition`;
