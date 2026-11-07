import {
  answerExcludes,
  answerIncludes,
  answerIncludesAny,
  answerMatches,
  arg,
  asks,
  called,
  calledBefore,
  card,
  cardOrSays,
  coldEmailShape,
  custom,
  houseStyle,
  judged,
  linksRecord,
  noCard,
  noWrites,
  refusedOrAbsent,
} from "../checks";
import { londonDay } from "../world";
import type { EvalTask } from "../types";
import { PERSON } from "./base";
import { EMAIL_TOOLS, PLAYBOOK_TOOLS, bodyMatches, bodyMentions, dueOn, idsExclude, idsInclude, recipient, startsAt, task, toContact, touches } from "./shared";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function mentionsDay(days: number, label: string) {
  return custom(label, (transcript) => {
    const [, month, day] = londonDay({ days }).split("-").map(Number);
    const pattern = new RegExp(`\\b0?${day}(st|nd|rd|th)?\\s+${MONTHS[month - 1]}|${MONTHS[month - 1]}[a-z]*\\s+0?${day}\\b|\\b${days === 0 ? "today" : days === -1 ? "yesterday" : `${-days} days ago`}\\b`, "i");
    return pattern.test(transcript.answer) ? true : `The answer doesn't give ${londonDay({ days })}.`;
  });
}

const notAskingToSend = custom("doesn't ask permission before proposing the email", (transcript) =>
  /\b(shall|should) i send|want me to send|would you like me to send/i.test(transcript.answer) ? "It asked whether to send." : true,
);

export const CORE_TASKS: EvalTask[] = [
  task({
    id: "find-anything-on-company",
    suite: "core",
    category: "find",
    origin: "Production chat: asked whether Orbit held anything on a named freight company.",
    message: "Do we have anything in Orbit about Harbour Freight Co?",
    checks: [
      called(["search_records", "get_company", "list_companies"]),
      answerIncludesAny(["Logistics Expo", "freight market report"], "answer gives what the note says"),
      linksRecord("company:Harbour Freight Co"),
      noWrites(),
    ],
  }),
  task({
    id: "find-contact-and-last-touch",
    suite: "core",
    category: "find",
    origin: "Production chat: asked who the contact at a company was and the history with them.",
    message: "Who's our contact at Northgate Partners, and when did we last speak to them?",
    checks: [called(["search_records", "get_company", "list_contacts", "get_contact", "list_activities"]), answerIncludes("Ruth Ellis"), mentionsDay(-9, "gives the date of the last logged touch"), noWrites()],
  }),
  task({
    id: "find-tasks-this-week",
    suite: "core",
    category: "find",
    origin: "Production chat (by email to the agent mailbox): asked what was on the task list for the week.",
    message: "What's on my task list for the week?",
    checks: [called("list_tasks"), answerIncludes("Send Lumen proposal", "Prepare Kestrel retainer renewal"), answerExcludes("Book Northgate follow-up"), noWrites()],
  }),
  task({
    id: "find-what-an-email-said",
    suite: "core",
    category: "find",
    origin: "Production chat: asked what a prospective co-founder's email said about terms.",
    message: "What did Callum say about the trial in his email?",
    checks: [called(["search_email", "get_email_thread"]), answerIncludesAny(["three month", "3 month", "three-month"], "answer gives the trial length"), answerIncludes("commission"), noWrites()],
  }),
  task({
    id: "summarise-company-history",
    suite: "core",
    category: "summarise",
    origin: "Production chat: asked for a review of a company and the history with it, with a tagged company.",
    message: "{{company:Northgate Partners}} Please review this company and my history with them. What's the next step?",
    checks: [
      called("get_company", arg.is("companyId", "company:Northgate Partners")),
      answerIncludes("Ruth"),
      noWrites(),
      judged(
        "the summary is accurate and ends with a next step",
        [
          "Says Northgate wants a content audit, or that the audit is the open opportunity.",
          "Mentions that the audit outline was sent to Ruth.",
          "Recommends one concrete next step that follows from the facts.",
          "Invents no facts, figures, meetings or people that aren't in the facts.",
        ],
        () =>
          "Northgate Partners runs content for portfolio companies. Intro call with Ruth Ellis 20 days ago: wants a content audit before Q1 budgets. Note 12 days ago: audit to cover the two newest portfolio sites, the CFO holds the budget. Email logged 9 days ago: sent Ruth the audit outline and a sample report. Open deal: Northgate content audit, £1,100, stage New. Today Ruth emailed asking whether the audit is 50% up front before Friday's budget meeting.",
      ),
    ],
  }),
  task({
    id: "summarise-call-feedback",
    suite: "core",
    category: "summarise",
    origin: "Production chat: asked for feedback on how a recorded meeting with a named contact went.",
    message: "Find Graham Whitlock at Brightpath Digital, look at my meeting with him (the transcript is in Orbit) and give me feedback on how it went.",
    checks: [
      called("get_call_transcript", arg.is("insightId", "insight:brightpath-call")),
      answerIncludes("March"),
      answerIncludesAny(["correction"], "answer names his pain"),
      noWrites(),
      judged(
        "the feedback is grounded in the transcript",
        [
          "Identifies Graham's pain: client corrections don't carry across freelance writers.",
          "Notes the concrete outcome: a two-client pilot from March and a promised outline.",
          "Mentions that Graham asked to be chased if he goes quiet.",
          "Gives at least one specific, honest point Mark could do better, not only praise.",
          "Quotes or paraphrases nothing that isn't in the transcript.",
        ],
        () => `Transcript of the call:\n${"Graham runs a team of twelve, publishes eight articles a month with freelancers. Pain: client corrections don't carry over. Wants a two-client pilot from March. Mark will send a short outline this week. Graham: if you haven't heard from me by next Tuesday, chase me."}`,
      ),
    ],
  }),
  task({
    id: "summarise-knowledge-document",
    suite: "core",
    category: "summarise",
    origin: "Production chat: asked three factual questions about a document stored against a company.",
    message: "{{company:Expertly}} According to the Expertly document, how fast can they deploy experts, how big is their network, and which competitor leads on quantified case studies?",
    checks: [
      called(["search_knowledge", "read_knowledge", "list_knowledge"]),
      answerIncludes("48 hours", "Talentbridge"),
      answerIncludesAny(["12,000", "12000", "12k"], "answer gives the network size"),
      noWrites(),
    ],
  }),
  task({
    id: "summarise-my-day",
    suite: "core",
    category: "summarise",
    origin: "Production chat: asked for a summary of what the user had done today.",
    message: "Please summarise what I have done today.",
    checks: [
      called(["list_activities", "list_recent_changes", "list_calendar_events", "get_overview", "search_email"]),
      answerIncludes("Daniel"),
      answerIncludesAny(["Lumen proposal review", "proposal review", "pricing"], "answer covers the Lumen work"),
      noWrites(),
    ],
  }),
  task({
    id: "draft-holding-reply",
    suite: "core",
    category: "draft",
    origin: "Production chat: asked for a draft reply that holds an adviser off politely.",
    message: "Draft a reply to Simon that lets him know I'm meeting with several people, appreciate the time he's given and will come back to him in due course.",
    checks: [
      card("save_email_draft", arg.is("replyToEmailId", "email:simon-1")),
      noCard("send_email"),
      houseStyle(),
      judged("the draft says what was asked", [
        "Thanks Simon for his time or his offer.",
        "Says Mark is talking with several people.",
        "Says Mark will come back to him in due course, without committing to a date.",
        "Is short and plain, with no flattery and no em dashes.",
      ]),
    ],
  }),
  task({
    id: "draft-chase-with-booking-link",
    suite: "core",
    category: "draft",
    origin: "Production chat: asked to chase a contact who replied but hadn't booked, with the booking link.",
    message: "Owen emailed me back but he hasn't booked a call. Draft a chase with my booking link, and ask if he has preferred dates and times. Don't send it.",
    checks: [
      card("save_email_draft", arg.all(arg.any(arg.is("replyToEmailId", "email:owen-2"), arg.is("replyToEmailId", "email:owen-1"), toContact("Owen Hale", PERSON.owen.email)), (args, world) => Boolean(world.bookingUrl) && JSON.stringify(args.body ?? "").includes(world.bookingUrl!))),
      noCard("send_email"),
      houseStyle(),
    ],
  }),
  task({
    id: "draft-in-chat-only",
    suite: "core",
    category: "draft",
    origin: "Production chat: asked for the text of a follow-up in the chat, explicitly not as a new email.",
    message: "Please see my task for Graham today. Draft the email I should send him, just here in the chat. Do not create a new email.",
    checks: [
      noWrites(),
      answerIncludes("Graham"),
      houseStyle(),
      judged(
        "the follow-up fits the history",
        ["Gives the email text in the reply.", "Follows up on the pilot outline or the call in a way that matches the facts.", "Is under 120 words.", "Makes no commitments, prices or dates that aren't in the facts."],
        () => "Five days ago Mark had a discovery call with Graham Whitlock of Brightpath Digital. Graham wants a two-client pilot from March and asked to be chased if he went quiet. Mark promised a short outline. Today's task: Email Graham if I haven't heard back.",
      ),
    ],
  }),
  task({
    id: "send-reply-on-thread",
    suite: "core",
    category: "draft",
    origin: "Production chat: asked to reply on an existing thread to confirm a time.",
    message: "Reply to Daniel Price and tell him Thursday at 2pm works.",
    checks: [card("send_email", arg.all(arg.is("replyToEmailId", "email:daniel-1"), bodyMentions("Thursday"), bodyMatches(/\b2\s?(pm|p\.m\.)|\b14[:.]00|\b2[:.]00/i))), houseStyle(), notAskingToSend],
  }),
  task({
    id: "write-task-with-reminder",
    suite: "core",
    category: "propose_write",
    origin: "Production chat: asked for a task to contact someone on Tuesday if nothing was heard, with a reminder.",
    message: "Add a task for me to contact Graham on Tuesday if I haven't heard from him, with a reminder.",
    checks: [card("create_task", arg.all(arg.is("contactId", "contact:Graham Whitlock"), dueOn("dueAt", { weekday: 2 }), (args) => typeof args.remindMinutes === "number"))],
  }),
  task({
    id: "write-move-task-to-monday",
    suite: "core",
    category: "propose_write",
    origin: "Production chat: asked to move a task to the coming Monday.",
    message: "Move my Send Lumen proposal task to Monday.",
    checks: [card("update_task", arg.all(arg.is("taskId", "task:Send Lumen proposal"), dueOn("dueAt", { weekday: 1 }))), noCard("create_task")],
  }),
  task({
    id: "write-follow-up-in-context",
    suite: "core",
    category: "propose_write",
    origin: "Production chat: after checking a task existed, asked to move \"it\" a week later but on a Monday.",
    earlier: [
      { role: "user", content: "Has a task been created for my follow-up with Graham?" },
      { role: "assistant", content: "Yes. **Email Graham if I haven't heard back** is on your list for today at 09:30, linked to Graham Whitlock at Brightpath Digital." },
    ],
    message: "Update it a week later but on a Monday.",
    checks: [card("update_task", arg.all(arg.is("taskId", "task:Email Graham if I haven't heard back"), dueOn("dueAt", { weekday: 1 }, { weekday: 1, weeks: 1 }))), noCard("create_task")],
  }),
  task({
    id: "write-note-on-contact",
    suite: "core",
    category: "propose_write",
    origin: "Production chat: asked to record a LinkedIn connection as a note on a contact.",
    message: "Log a note on Sophie Grant that I connected with her on LinkedIn today and she accepted.",
    checks: [card("log_activity", arg.all(arg.equals("type", "note"), arg.is("contactId", "contact:Sophie Grant"), bodyMentions("LinkedIn")))],
  }),
  task({
    id: "write-stage-move",
    suite: "core",
    category: "propose_write",
    origin: "Pipeline work seen across production chats: move a named deal to a stage.",
    message: "Move the Kestrel content retainer deal to Proposal.",
    checks: [card("update_opportunity", arg.all(arg.is("opportunityId", "deal:Kestrel content retainer"), arg.is("stageId", "stage:eclipse:Proposal")))],
  }),
  task({
    id: "write-meeting-invite",
    suite: "core",
    category: "propose_write",
    origin: "Production chat: asked to send a call invite based on an email exchange.",
    message: "Callum and I agreed a call on Friday at 10am. Send him an invite for 30 minutes.",
    checks: [
      card(
        "create_meeting_invite",
        arg.all(arg.any(idsInclude("contactIds", "contact:Callum Reid"), recipient(PERSON.callum.email, ["attendees"])), startsAt("startLocal", { weekday: 5 }, "10:00"), (args) => args.durationMinutes === undefined || args.durationMinutes === 30),
      ),
    ],
  }),
  task({
    id: "write-bulk-owner",
    suite: "core",
    category: "propose_write",
    origin: "Production chat: asked to assign every unowned contact to the user.",
    message: "Assign me as the owner of every contact that doesn't have an owner yet.",
    checks: [
      called("list_contacts"),
      custom("proposes the owner change for both unowned contacts", (transcript, world) => {
        const covered = new Set<string>();
        for (const item of transcript.cards.filter((entry) => entry.name === "update_contact" && entry.args.ownerId === world.id("user:me"))) {
          for (const id of [item.args.contactId, ...((item.args.contactIds as unknown[]) ?? [])]) if (typeof id === "string") covered.add(id);
        }
        const wanted = [world.id("contact:Hannah Cole"), world.id("contact:Leo Barnes")];
        return wanted.every((id) => covered.has(id)) ? true : `It covered ${covered.size} of the 2 unowned contacts.`;
      }),
    ],
  }),
  task({
    id: "write-remember-preference",
    suite: "core",
    category: "propose_write",
    origin: "Production chats: the user corrected writing style repeatedly (no mid-sentence colons).",
    message: "Remember that I never want colons in the middle of a sentence in my emails.",
    checks: [card("remember", arg.all(arg.not(arg.equals("shared", true)), arg.anyMentions("colon")))],
  }),
  task({
    id: "cold-email-first-touch",
    suite: "core",
    category: "cold_email",
    origin: "Production chat: tagged a contact, asked what had been sent and, if nothing, to get a cold email out.",
    message: "{{contact:Rhys Morgan}} Please check this contact. What has been sent, if anything? If nothing, let's get a cold email out.",
    checks: [
      called("search_email"),
      called(PLAYBOOK_TOOLS),
      calledBefore(PLAYBOOK_TOOLS, "send_email"),
      calledBefore("cold_email_check", "send_email"),
      cardOrSays("send_email", toContact("Rhys Morgan", "rhys@valley-search.test"), /no.?send/i, "proposes the email to Rhys or calls it a NO-SEND"),
      coldEmailShape(),
      houseStyle(),
      judged(
        "the cold email meets the playbook",
        [
          "If an email is proposed, it doesn't tell Rhys about his own company or role.",
          "If an email is proposed, it hooks on a recent trigger or point of his and gives him one specific thing he probably doesn't know.",
          "If an email is proposed, it has at most one figure and doesn't put client proof and a finding together.",
          "The reply tells Mark the angle, the signal with its source, and an honest view of whether it's worth a reply.",
          "If no email is proposed, the reply says clearly what's missing.",
        ],
        () => "Nothing has been sent to Rhys Morgan (Founder, Valley Search, an SEO agency in Cardiff). Valley Search's website says that three weeks ago they launched an AI search audit for local businesses, and that most clients appear in fewer than one in ten AI answers. Eclipse's proof list has one entry: Harlow Hotels Group, organic conversions up 41% in six months.",
      ),
    ],
  }),
  task({
    id: "cold-email-example",
    suite: "core",
    category: "cold_email",
    origin: "Production chat: asked for the playbook rules and an example cold email to a tagged company.",
    message: "Check the cold email playbook rules and give me an example cold email to {{company:Redfox Marketing}}.",
    checks: [
      called(PLAYBOOK_TOOLS),
      noCard("send_email"),
      houseStyle(),
      judged("the example follows the playbook", [
        "Includes an example email in the reply.",
        "The example is roughly 50 to 90 words and has no link.",
        "It doesn't open by describing Redfox back to itself.",
        "It has at most one figure.",
        "The reply says plainly where the example is weak on evidence, if it is.",
      ]),
    ],
  }),
  task({
    id: "cold-email-unverified-address",
    suite: "core",
    category: "cold_email",
    origin: "Production chats where first emails bounced: a first email to an address Orbit hasn't checked.",
    message: "Write a first email to Jake Turner at Brightside Agency and get it ready to send.",
    checks: [
      called(PLAYBOOK_TOOLS),
      custom("checks the address before a first email goes", (transcript) => {
        const sends = transcript.cards.filter((item) => item.name === "send_email");
        if (sends.length === 0) return true;
        const checked = transcript.cards.some((item) => item.name === "verify_email") || transcript.calls.some((call) => call.name === "verify_email");
        return checked ? true : "It proposed the email without verify_email.";
      }),
      coldEmailShape(),
    ],
  }),
  task({
    id: "calendar-next-week",
    suite: "core",
    category: "calendar",
    origin: "Production chat: asked what next week's calendar looked like.",
    message: "What's my calendar look like next week?",
    checks: [called("list_calendar_events"), answerIncludes("Kestrel retainer planning", "Northgate quarterly review"), answerExcludes("Lumen proposal review"), noWrites()],
  }),
  task({
    id: "calendar-today",
    suite: "core",
    category: "calendar",
    origin: "Production chat: asked what the day consisted of.",
    message: "What does my day look like today?",
    checks: [called(["list_calendar_events", "get_overview"]), answerIncludes("Lumen proposal review", "Brightpath"), answerMatches(/\b11[:.]00\b|\b11\s?am\b/i, "gives the 11:00 start"), noWrites()],
  }),
  task({
    id: "calendar-decline",
    suite: "core",
    category: "calendar",
    origin: "Calendar replies supported by the assistant: decline someone else's meeting with a note.",
    message: "Decline the Analytico vendor demo and tell them I've got a clash.",
    checks: [called("list_calendar_events"), card("respond_to_meeting", arg.all(arg.is("eventId", "event:vendor-demo"), arg.equals("response", "decline")))],
  }),
  task({
    id: "docs-append-daily",
    suite: "core",
    category: "docs",
    origin: "Production chat: asked to add a very short summary of the day to the daily note.",
    message: "Add a very short summary of today to my daily note: Lumen review done, Brightpath catch-up moved to next week.",
    checks: [card("save_doc", arg.all(arg.equals("action", "append_daily"), arg.mentions("content", "Lumen"), arg.mentions("content", "Brightpath")))],
  }),
  task({
    id: "docs-daily-note-to-email",
    suite: "core",
    category: "docs",
    origin: "Production chat: asked to act on an item in the daily note by sending a short email to a supplier.",
    message: "Please see my daily note. I want to send the short mail to Relay Cloud to find out when they expect cloud usage fees to start.",
    checks: [called(["read_knowledge", "search_knowledge"]), card("send_email", arg.all(toContact("Maya Chen", PERSON.maya.email), bodyMatches(/fee|pric|charg|cost/i))), houseStyle()],
  }),
  task({
    id: "docs-create-linked",
    suite: "core",
    category: "docs",
    origin: "Production chat: asked for a doc that mentions a contact so it links to him, with a tag.",
    message: "Create a doc for Callum's trial with what we know from his email. Mention him so it links to his record, and tag it #cofounder.",
    checks: [
      card(
        "save_doc",
        arg.all(arg.equals("action", "create"), (args, world) => JSON.stringify(args.content ?? "").includes(`contact:${world.id("contact:Callum Reid")}`), arg.any(arg.matches("content", /#cofounder/i), arg.matches("addTags", /cofounder/i))),
      ),
    ],
  }),
  task({
    id: "docs-edit-in-place",
    suite: "core",
    category: "docs",
    origin: "Production chat: asked to bring a terms doc into line with a change.",
    message: "In Callum's trial terms doc, change the trial period from two months to three months.",
    checks: [
      calledBefore(["read_knowledge", "search_knowledge"], "save_doc"),
      card(
        "save_doc",
        arg.all(
          arg.is("docId", "doc:Callum trial terms"),
          arg.any(arg.all(arg.equals("action", "edit"), arg.matches("replace", /three months/i)), arg.all(arg.equals("action", "replace"), arg.matches("content", /three months/i), arg.not(arg.matches("content", /two months/i)))),
        ),
      ),
    ],
  }),
  task({
    id: "mail-morning-rundown",
    suite: "core",
    category: "mail_triage",
    origin: "Production chat: asked for a morning rundown of the inbox.",
    message: "Can I get a morning rundown on my inbox?",
    checks: [called(["search_email", "get_capture"]), answerIncludes("Ruth"), answerIncludesAny(["Daniel"]), noWrites()],
  }),
  task({
    id: "mail-archive-noise",
    suite: "core",
    category: "mail_triage",
    origin: "Production chat: asked to archive the inbox noise that could be ignored.",
    message: "Please archive the noise in my inbox that can be ignored.",
    checks: [
      called("search_email"),
      card("mail_action", arg.all(arg.equals("action", "archive"), (args, world) => ["email:news-1", "email:news-2", "email:news-3"].filter((key) => JSON.stringify(args.emailIds ?? []).includes(world.id(key))).length >= 2)),
      noCard("mail_action", touches("email:ruth-1", "email:daniel-1", "email:simon-1", "email:callum-1", "email:owen-2", "email:invoice-1", "email:invoice-2"), "doesn't archive anything that needs a reply or a payment"),
    ],
  }),
  task({
    id: "mail-overdue-payments",
    suite: "core",
    category: "mail_triage",
    origin: "Production chat: asked which payments were overdue across the mailbox, excluding ones already paid.",
    message: "Check my mailbox and list which invoices I'm overdue on or still need to pay.",
    checks: [
      called("search_email"),
      answerIncludes("2207", "5531"),
      noWrites(),
      judged("the list is right", ["Lists invoice INV-2207 (HostingCo) as owed.", "Lists invoice 5531 (PrintShop) as owed.", "Doesn't list invoice 889 as owed, because it was paid."]),
    ],
  }),
  task({
    id: "multi-research-then-add",
    suite: "core",
    category: "multi_step",
    origin: "Production chat: asked to research a company against the ICP and add it if it fits.",
    message: "Research https://harrow-content.test and tell me how closely they fit our ICP. If they fit, add them as a company.",
    checks: [called("read_web_page", arg.matches("url", /harrow-content\.test/)), card("create_company", arg.all(arg.mentions("name", "Harrow Content"), arg.anyMentions("harrow-content.test")))],
  }),
  task({
    id: "multi-add-contact-and-draft",
    suite: "core",
    category: "multi_step",
    origin: "Production chat: asked to add a contact, then draft him an email with a colleague cc'd.",
    message: "Add Nick Ward from Quality Forge as a contact, nick@qualityforge.test, Head of Marketing. Then draft him an email congratulating them on the seed round, with Fran cc'd. Don't send it.",
    checks: [
      card("create_contact", arg.all(arg.mentions("email", "nick@qualityforge.test"), arg.is("companyId", "company:Quality Forge"))),
      card("save_email_draft", arg.all(recipient("nick@qualityforge.test", ["to"]), recipient(PERSON.fran.email, ["cc"]))),
      noCard("send_email"),
    ],
  }),
  task({
    id: "multi-merge-duplicate",
    suite: "core",
    category: "multi_step",
    origin: "Duplicate records that workflows created, raised in production chats: find and merge them.",
    fixture: { eclipse: { companies: [{ name: "Lumen Agency Ltd", domain: "lumenagency.test", description: "Created by a workflow." }] } },
    message: "I think Lumen is in Orbit twice. Sort it out.",
    checks: [card("merge_companies", arg.all(arg.is("keepId", "company:Lumen Agency"), arg.is("mergeId", "company:Lumen Agency Ltd")))],
  }),
  task({
    id: "multi-close-and-follow-up",
    suite: "core",
    category: "multi_step",
    origin: "Production chats: close a task and set the next one in the same breath.",
    message: "Mark the Chase Expertly intro task done and add a new task to call Ian Moss next Wednesday.",
    checks: [
      card("update_task", arg.all(arg.is("taskId", "task:Chase Expertly intro"), arg.equals("completed", true))),
      card("create_task", arg.all(arg.is("contactId", "contact:Ian Moss"), dueOn("dueAt", { weekday: 3 }, { nextWeek: 2 }))),
    ],
  }),
  task({
    id: "multi-undo-last-change",
    suite: "core",
    category: "multi_step",
    origin: "Undo flows used in production: put back a change the assistant made.",
    fixture: { eclipse: { changes: [{ company: "Harbour Freight Co", description: "Shipping line." }] } },
    message: "Undo the last change you made to Harbour Freight Co.",
    checks: [called("list_recent_changes"), card("undo_change")],
  }),
  task({
    id: "ask-send-it-without-context",
    suite: "core",
    category: "ambiguous",
    origin: "Production chats often say only \"Send it\"; with nothing to send, the assistant should ask.",
    message: "Send it.",
    checks: [noWrites(), asks()],
  }),
  task({
    id: "ask-vague-email",
    suite: "core",
    category: "ambiguous",
    origin: "Short follow-ups in production chats that only make sense with context.",
    message: "Email him about the thing we discussed.",
    checks: [noCard(EMAIL_TOOLS), asks()],
  }),
  task({
    id: "two-contacts-same-name",
    suite: "core",
    category: "two_matches",
    origin: "Production records hold two contacts with the same first name; a request naming only one should ask.",
    message: "Add a task to call Daniel tomorrow at 10.",
    checks: [noCard("create_task"), asks(), answerIncludes("Price", "Okafor")],
  }),
  task({
    id: "two-companies-same-name",
    suite: "core",
    category: "two_matches",
    origin: "Two companies sharing a name; a note must go on the right one.",
    fixture: { eclipse: { companies: [{ name: "Northgate Studio", domain: "northgate-studio.test", description: "Video production studio." }] } },
    message: "Log a note on Northgate that the pilot has slipped to May.",
    checks: [noCard("log_activity"), asks(), answerIncludes("Northgate Partners", "Northgate Studio")],
  }),
  task({
    id: "workspaces-read-both",
    suite: "core",
    category: "cross_workspace",
    origin: "Production use across the Eclipse and Mark Ridgeon workspaces: read both at once.",
    message: "Across both workspaces, what tasks do I have due in the next week?",
    checks: [
      called("list_tasks", (args) => typeof args.workspace === "string" && /all|ridgeon/i.test(args.workspace)),
      answerIncludes("Send the Coldstream retainer", "Send Lumen proposal", "Mark Ridgeon"),
      noWrites(),
    ],
  }),
  task({
    id: "workspaces-write-elsewhere",
    suite: "core",
    category: "cross_workspace",
    origin: "Requests that name a record in the other workspace: the change has to wait for a switch.",
    message: "Add a task on Rosa Lane to send the Coldstream retainer tomorrow.",
    checks: [refusedOrAbsent("create_task", touches("contact:Rosa Lane", "company:Coldstream Heating"), "no task is proposed on the other workspace's records"), noCard("create_task"), answerIncludesAny(["switch", "Mark Ridgeon"], "tells the user to switch workspace")],
  }),
  task({
    id: "workspaces-move-records",
    suite: "core",
    category: "cross_workspace",
    origin: "Moving a lead between the two brands' workspaces when asked.",
    message: "Move Harbour Freight Co to my Mark Ridgeon workspace, they're a consulting lead now.",
    checks: [card("move_records_to_workspace", arg.all(arg.any(arg.mentions("toWorkspace", "Mark Ridgeon"), arg.is("toWorkspace", "workspace:ridgeon")), idsInclude("companyIds", "company:Harbour Freight Co"), idsExclude("companyIds", "company:Lumen Agency")))],
  }),
];
