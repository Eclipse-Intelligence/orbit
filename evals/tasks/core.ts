import {
  EMAIL_TOOLS,
  answerExcludes,
  answerIncludes,
  answerIncludesAny,
  answerMatches,
  arg,
  asks,
  called,
  calledBefore,
  card,
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
import { ANSEL_TRANSCRIPT, PERSON } from "./base";
import { PLAYBOOK_TOOL, playbookTopic, bodyMatches, bodyMentions, dueOn, idsExclude, idsInclude, recipient, startsAt, task, toContact, touches } from "./shared";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function mentionsDay(days: number, label: string) {
  return custom(label, (transcript) => {
    const iso = londonDay({ days });
    const [year, month, day] = iso.split("-").map(Number);
    const name = MONTHS[month - 1];
    const patterns = [
      new RegExp(`\\b0?${day}(st|nd|rd|th)?\\s+(of\\s+)?${name}`, "i"),
      new RegExp(`\\b${name}[a-z]*\\.?\\s+0?${day}(st|nd|rd|th)?\\b`, "i"),
      new RegExp(`\\b${iso}\\b`),
      new RegExp(`\\b0?${day}/0?${month}(/(${year}|${String(year).slice(2)}))?\\b`),
      new RegExp(`\\b${-days} days ago\\b`, "i"),
    ];
    return patterns.some((pattern) => pattern.test(transcript.answer)) ? true : `The answer doesn't give ${iso}.`;
  });
}

const notAskingToSend = custom("doesn't ask permission before proposing the email", (transcript) =>
  /\b(shall|should) i send|want me to send|would you like me to send/i.test(transcript.answer) ? "It asked whether to send." : true,
);

const NO_SEND = /\bNO[- ]?SEND\b/;

export const CORE_TASKS: EvalTask[] = [
  task({
    id: "find-anything-on-company",
    suite: "core",
    category: "find",
    origin: "Production chat, reworded: whether Orbit held anything on a named haulage firm.",
    message: "Is there anything on Saltmarsh Haulage in Orbit?",
    checks: [
      called(["search_records", "get_company", "list_companies"]),
      answerIncludesAny(["Eastern Freight Show", "haulage rates bulletin", "rates bulletin"], "answer gives what the note says"),
      linksRecord("company:Saltmarsh Haulage"),
      noWrites(),
    ],
  }),
  task({
    id: "find-contact-and-last-touch",
    suite: "core",
    category: "find",
    origin: "Production chat, reworded: who the contact at a company was and the history with them.",
    message: "Who do we deal with at Fernhill Capital, and when were we last in touch?",
    checks: [called(["search_records", "get_company", "list_contacts", "get_contact", "list_activities"]), answerIncludes("Odile Marsh"), mentionsDay(-9, "gives the date of the last logged touch"), noWrites()],
  }),
  task({
    id: "find-tasks-this-week",
    suite: "core",
    category: "find",
    origin: "Production chat (sent to the agent mailbox), reworded: the task list for the week.",
    message: "Which tasks have I got this week?",
    checks: [called("list_tasks"), answerIncludes("Send Quillfeather proposal", "Prepare Larkspur retainer renewal"), answerExcludes("Book Fernhill follow-up"), noWrites()],
  }),
  task({
    id: "find-what-an-email-said",
    suite: "core",
    category: "find",
    origin: "Production chat, reworded: what a possible partner's email proposed.",
    message: "Remind me what Lachlan proposed for the trial in his email.",
    checks: [called(["search_email", "get_email_thread"]), answerIncludesAny(["six week", "6 week", "six-week", "6-week"], "answer gives the trial length"), answerIncludes("retainer"), noWrites()],
  }),
  task({
    id: "summarise-company-history",
    suite: "core",
    category: "summarise",
    origin: "Production chat, reworded: a review of a tagged company, the history with it and what to do next.",
    message: "{{company:Fernhill Capital}} Where are we with this one, and what should I do next?",
    checks: [
      called("get_company", arg.is("companyId", "company:Fernhill Capital")),
      answerIncludes("Odile"),
      noWrites(),
      judged(
        "the summary is accurate and ends with a next step",
        [
          "Says Fernhill wants a content review, or that the review is the open opportunity.",
          "Mentions that the review outline was sent to Odile.",
          "Recommends one concrete next step that follows from the facts.",
          "Invents no facts, figures, meetings or people that aren't in the facts.",
        ],
        () =>
          "Fernhill Capital is an investment firm that runs content for its portfolio businesses. Contact: Odile Marsh, Partner. Intro call 20 days ago: Odile handles content for four portfolio businesses and wants a content review before the spring budget round. Note 12 days ago: the review should cover the three newest portfolio sites, and their finance director signs off. Email logged 9 days ago: sent Odile the review outline and an example report. Open deal: Fernhill content review, £1,850, stage New. Task done 6 days ago: Book Fernhill follow-up. Next week: Fernhill quarterly review, Wednesday at 14:00. Today Odile emailed asking whether the payment schedule is half on signing, before Thursday's board meeting.",
      ),
    ],
  }),
  task({
    id: "summarise-call-feedback",
    suite: "core",
    category: "summarise",
    origin: "Production chat, reworded: honest feedback on a recorded meeting with a named contact.",
    message: "Pull up my last meeting with Ansel Pike at Copperleaf Digital and tell me honestly how it went. The transcript is in Orbit.",
    checks: [
      called("get_call_transcript", arg.is("insightId", "insight:copperleaf-call")),
      answerIncludes("April"),
      answerIncludesAny(["voice"], "answer names his pain"),
      noWrites(),
      judged(
        "the feedback is grounded in the transcript",
        [
          "Identifies Ansel's pain: brand voice drifts between contract writers.",
          "Notes the concrete outcome: a one-client trial from April and a promised one-page plan.",
          "Mentions that Ansel asked to be nudged if he goes quiet.",
          "Gives at least one specific, honest point Mark could do better, not only praise.",
          "Quotes or paraphrases nothing that isn't in the transcript or the facts.",
        ],
        () => `Ansel Pike is Founder of Copperleaf Digital, a digital agency of nine that relies on contract writers. The call was 5 days ago. Summary on record: Ansel wants to trial Eclipse on one client from April, his main pain is brand voice drifting between contract writers, and he asked to be nudged if he goes quiet. Transcript:\n${ANSEL_TRANSCRIPT}`,
      ),
    ],
  }),
  task({
    id: "summarise-knowledge-document",
    suite: "core",
    category: "summarise",
    origin: "Production chat, reworded: three factual questions about a document stored against a company.",
    message: "{{company:Sagebrook Experts}} From their deck, how quickly can they place an expert, how many experts do they have, and who beats them on case studies?",
    checks: [called(["search_knowledge", "read_knowledge", "list_knowledge"]), answerIncludes("72 hours", "Mosswell Talent"), answerIncludesAny(["3,400", "3400"], "answer gives the bench size"), noWrites()],
  }),
  task({
    id: "summarise-my-day",
    suite: "core",
    category: "summarise",
    origin: "Production chat, reworded: a recap of what the user had done today.",
    message: "Recap what I've got done today.",
    checks: [
      called(["list_activities", "list_recent_changes", "list_calendar_events", "get_overview", "search_email"]),
      answerIncludes("Felix"),
      answerIncludesAny(["Quillfeather proposal review", "proposal review", "pricing"], "answer covers the Quillfeather work"),
      noWrites(),
    ],
  }),
  task({
    id: "draft-holding-reply",
    suite: "core",
    category: "draft",
    origin: "Production chat, reworded: a draft reply that politely holds an adviser's offer.",
    message: "Write a draft back to Hector. Say I'm talking to a few people, thank him for the offer, and that I'll get back to him later.",
    checks: [
      card("save_email_draft", arg.is("replyToEmailId", "email:hector-1")),
      noCard("send_email"),
      houseStyle(),
      judged("the draft says what was asked", [
        "Thanks Hector for his offer or his time.",
        "Says Mark is talking with a few people.",
        "Says Mark will get back to him later, without committing to a date.",
        "Is short and plain, with no flattery.",
      ]),
    ],
  }),
  task({
    id: "draft-chase-with-booking-link",
    suite: "core",
    category: "draft",
    origin: "Production chat, reworded: chase a contact who replied but hadn't booked, with the booking link.",
    message: "Bram replied but still hasn't picked a slot. Draft a nudge with my booking link asking which days and times suit him. Draft only.",
    checks: [
      card(
        "save_email_draft",
        arg.all(arg.any(arg.is("replyToEmailId", "email:bram-2"), arg.is("replyToEmailId", "email:bram-1"), toContact("Bram Kettle", PERSON.bram.email)), (args, world) => Boolean(world.bookingUrl) && JSON.stringify(args.body ?? "").includes(world.bookingUrl!)),
      ),
      noCard("send_email"),
      houseStyle(),
    ],
  }),
  task({
    id: "draft-in-chat-only",
    suite: "core",
    category: "draft",
    origin: "Production chat, reworded: the text of a follow-up written in the chat, explicitly not as a new email.",
    message: "Ansel's follow-up is on my list for today. Write the email here in the chat for me to copy. Don't make a draft or send anything.",
    checks: [
      noWrites(),
      answerIncludes("Ansel"),
      houseStyle(),
      judged(
        "the follow-up fits the history",
        ["Gives the email text in the reply.", "Follows up on the one-page plan or the call in a way that matches the facts.", "Is under 120 words.", "Makes no commitments, prices or dates that aren't in the facts."],
        () =>
          "Five days ago Mark had a discovery call with Ansel Pike, Founder of Copperleaf Digital. Ansel wants to trial Eclipse on one client from April, his pain is brand voice drifting between contract writers, and he asked to be nudged if he went quiet. Mark promised a one-page plan that week. Today's task: Chase Ansel if he's gone quiet. A Copperleaf catch-up is in the calendar today at 16:30.",
      ),
    ],
  }),
  task({
    id: "send-reply-on-thread",
    suite: "core",
    category: "draft",
    origin: "Production chat, reworded: answer an existing thread to confirm a time.",
    message: "Answer Felix Arden's email: Thursday at 2pm suits me.",
    checks: [card("send_email", arg.all(arg.is("replyToEmailId", "email:felix-1"), bodyMentions("Thursday"), bodyMatches(/\b2\s?(pm|p\.m\.)|\b14[:.]00|\b2[:.]00/i))), houseStyle(), notAskingToSend],
  }),
  task({
    id: "write-task-with-reminder",
    suite: "core",
    category: "propose_write",
    origin: "Production chat, reworded: a task to chase someone on Tuesday if nothing is heard, with a reminder.",
    message: "Set me a task to chase Ansel on Tuesday if he's gone quiet, with a reminder.",
    checks: [card("create_task", arg.all(arg.is("contactId", "contact:Ansel Pike"), dueOn("dueAt", { weekday: 2 }), (args) => typeof args.remindMinutes === "number"))],
  }),
  task({
    id: "write-task-for-tagged-teammate",
    suite: "core",
    category: "propose_write",
    origin: "Teammate tags: a task for a tagged teammate about a contact, without treating the teammate as a record.",
    message: "Give {{member:Tamsin Holt}} a task to call Wren Ashdown on Friday.",
    checks: [card("create_task", arg.all(arg.is("ownerId", "member:Tamsin Holt"), arg.is("contactId", "contact:Wren Ashdown"), dueOn("dueAt", { weekday: 5 })))],
  }),
  task({
    id: "write-move-task-to-monday",
    suite: "core",
    category: "propose_write",
    origin: "Production chats, reworded: move a named task to the coming Monday.",
    message: "Shift the Send Quillfeather proposal task to Monday.",
    checks: [card("update_task", arg.all(arg.is("taskId", "task:Send Quillfeather proposal"), dueOn("dueAt", { weekday: 1 }))), noCard("create_task")],
  }),
  task({
    id: "write-follow-up-in-context",
    suite: "core",
    category: "propose_write",
    origin: "Production chat, reworded: after checking a task existed, move \"it\" back a week to a Monday.",
    earlier: [
      { role: "user", content: "Is there a task for chasing Ansel?" },
      { role: "assistant", content: "Yes. **Chase Ansel if he's gone quiet** is on your list for today at 09:30, linked to Ansel Pike at Copperleaf Digital." },
    ],
    message: "Push it back a week, to the Monday.",
    checks: [card("update_task", arg.all(arg.is("taskId", "task:Chase Ansel if he's gone quiet"), dueOn("dueAt", { weekday: 1 }, { weekday: 1, weeks: 1 }))), noCard("create_task")],
  }),
  task({
    id: "write-note-on-contact",
    suite: "core",
    category: "propose_write",
    origin: "Production chat, reworded: record a LinkedIn connection as a note on a contact.",
    message: "Note on Wren Ashdown's record that we're now connected on LinkedIn.",
    checks: [card("log_activity", arg.all(arg.equals("type", "note"), arg.is("contactId", "contact:Wren Ashdown"), bodyMentions("LinkedIn")))],
  }),
  task({
    id: "write-chat-post-to-room",
    suite: "core",
    category: "propose_write",
    origin: "Team Chat: tell a room some deal news, posted only through the approval card.",
    fixture: { eclipse: { chat: [{ room: "sales", messages: [{ by: "colleague", text: "Any news from Quillfeather on the pilot?" }] }] } },
    message: "Let #sales in Chat know Felix confirmed the Quillfeather pilot scope.",
    checks: [
      card("team_chat", arg.all(arg.equals("action", "post"), arg.is("conversationId", "room:sales"), arg.mentions("text", "Quillfeather"))),
      custom("proposes one post", (transcript) => {
        const posts = transcript.cards.filter((item) => item.name === "team_chat").length;
        return posts <= 1 ? true : `It proposed ${posts} posts.`;
      }),
      noCard(EMAIL_TOOLS),
    ],
  }),
  task({
    id: "write-stage-move",
    suite: "core",
    category: "propose_write",
    origin: "Pipeline work seen across production chats: move a named deal to a stage.",
    message: "Put the Larkspur content retainer deal into Proposal.",
    checks: [card("update_opportunity", arg.all(arg.is("opportunityId", "deal:Larkspur content retainer"), arg.is("stageId", "stage:eclipse:Proposal")))],
  }),
  task({
    id: "write-meeting-invite",
    suite: "core",
    category: "propose_write",
    origin: "Production chat, reworded: send a call invite agreed by email.",
    message: "Lachlan and I settled on Friday at 10am. Invite him for half an hour.",
    checks: [
      card(
        "create_meeting_invite",
        arg.all(arg.any(idsInclude("contactIds", "contact:Lachlan Frew"), recipient(PERSON.lachlan.email, ["attendees"])), startsAt("startLocal", { weekday: 5 }, "10:00"), (args) => args.durationMinutes === undefined || args.durationMinutes === 30),
      ),
    ],
  }),
  task({
    id: "write-bulk-owner",
    suite: "core",
    category: "propose_write",
    origin: "Production chat, reworded: make the user the owner of every unowned contact.",
    message: "Any contact without an owner should be mine. Sort that out.",
    checks: [
      called("list_contacts"),
      custom("proposes the owner change for both unowned contacts", (transcript, world) => {
        const covered = new Set<string>();
        for (const item of transcript.cards.filter((entry) => entry.name === "update_contact" && entry.args.ownerId === world.id("user:me"))) {
          for (const id of [item.args.contactId, ...((item.args.contactIds as unknown[]) ?? [])]) if (typeof id === "string") covered.add(id);
        }
        const wanted = [world.id("contact:Mabel Thorne"), world.id("contact:Otis Penhale")];
        return wanted.every((id) => covered.has(id)) ? true : `It covered ${wanted.filter((id) => covered.has(id)).length} of the 2 unowned contacts.`;
      }),
    ],
  }),
  task({
    id: "write-remember-preference",
    suite: "core",
    category: "propose_write",
    origin: "Production chats where the user corrected writing style more than once.",
    message: "Keep in mind for good: no colons mid-sentence in anything you write for me.",
    checks: [card("remember", arg.all(arg.not(arg.equals("shared", true)), arg.anyMentions("colon")))],
  }),
  task({
    id: "cold-email-first-touch",
    suite: "core",
    category: "cold_email",
    origin: "Production chat, reworded: with a tagged contact, check what had been sent and, if nothing, write a first email.",
    message: "{{contact:Emrys Tallow}} Have I ever emailed this person? If not, put together a first email to them.",
    checks: [
      called("search_email"),
      called(PLAYBOOK_TOOL, playbookTopic, "reads the cold_email guide"),
      calledBefore(PLAYBOOK_TOOL, "send_email", "reads the cold_email guide before send_email", playbookTopic),
      calledBefore("cold_email_check", "send_email"),
      custom("proposes the email to Emrys or calls it a NO-SEND", (transcript, world) =>
        transcript.cards.some((item) => item.name === "send_email" && toContact("Emrys Tallow", "emrys@tarn-search.test")(item.args, world)) || NO_SEND.test(transcript.answer)
          ? true
          : `Its cards were ${transcript.cards.map((item) => item.name).join(", ") || "none"} and it didn't say NO-SEND.`,
      ),
      coldEmailShape(),
      houseStyle(),
      judged(
        "the first email meets the playbook",
        [
          "If an email is proposed, it doesn't tell Emrys about his own company or role.",
          "If an email is proposed, it hooks on a recent trigger or point of his and gives him one specific thing he probably doesn't know.",
          "If an email is proposed, its body (not counting the greeting and sign-off) is roughly 50 to 90 words, with at most one figure, and doesn't put client proof and a finding together.",
          "The reply tells Mark the angle, the signal with its source, and an honest view of whether it's worth a reply.",
          "If no email is proposed, the reply says clearly what's missing.",
        ],
        () => "Nothing has been sent to Emrys Tallow (Founder, Tarn Search, an SEO agency in Swansea). Tarn Search's website says that two weeks ago they launched a free answer engine check for dental and physio clinics, and that most clinics turn up in under a fifth of answers. Eclipse's proof list has one entry: Thistledown Inns, direct bookings up 27% in five months.",
      ),
    ],
  }),
  task({
    id: "cold-email-example",
    suite: "core",
    category: "cold_email",
    origin: "Production chat, reworded: an example first email to a tagged company, using the playbook.",
    message: "Using the playbook, show me what a first email to {{company:Bluejay Growth}} could look like.",
    checks: [
      called(PLAYBOOK_TOOL, playbookTopic, "reads the cold_email guide"),
      noCard("send_email"),
      houseStyle(),
      judged("the example follows the playbook", [
        "Includes an example email in the reply.",
        "The example's body (not counting the greeting and sign-off) is roughly 50 to 90 words and has no link.",
        "It doesn't open by describing Bluejay back to itself.",
        "It has at most one figure.",
        "If the example is weak on evidence, the reply says so plainly.",
      ]),
    ],
  }),
  task({
    id: "cold-email-unverified-address",
    suite: "core",
    category: "cold_email",
    origin: "Production chats where first emails bounced: a first email to an address Orbit hasn't checked.",
    message: "Get a first email to Rafe Collier at Sunfold Agency ready to go.",
    checks: [
      called(PLAYBOOK_TOOL, playbookTopic, "reads the cold_email guide"),
      custom("checks the address with verify_email, or calls it a NO-SEND without proposing a send", (transcript) => {
        const verified = transcript.cards.some((item) => item.name === "verify_email") || transcript.calls.some((call) => call.name === "verify_email");
        const sends = transcript.cards.some((item) => item.name === "send_email");
        if (verified) return true;
        if (!sends && NO_SEND.test(transcript.answer)) return true;
        return sends ? "It proposed the email without verify_email." : "It neither checked the address nor called it a NO-SEND.";
      }),
      coldEmailShape(),
    ],
  }),
  task({
    id: "calendar-next-week",
    suite: "core",
    category: "calendar",
    origin: "Production chat, reworded: what next week's calendar looks like.",
    message: "How does next week look in my diary?",
    checks: [called("list_calendar_events"), answerIncludes("Larkspur retainer planning", "Fernhill quarterly review"), answerExcludes("Quillfeather proposal review"), noWrites()],
  }),
  task({
    id: "calendar-today",
    suite: "core",
    category: "calendar",
    origin: "Production chat, reworded: what the day holds.",
    message: "What's on today?",
    checks: [called(["list_calendar_events", "get_overview"]), answerIncludes("Quillfeather proposal review", "Copperleaf"), answerMatches(/\b16[:.]30\b|\b4[:.]30\s?pm\b/i, "gives the 16:30 start"), noWrites()],
  }),
  task({
    id: "calendar-zoom-link",
    suite: "core",
    category: "calendar",
    origin: "Mark's report: meeting links written in an invite's notes weren't clickable, so he copied them by hand.",
    message: "What's the Zoom link for my 3pm?",
    checks: [
      called(["list_calendar_events", "get_overview"]),
      answerIncludes("https://us02web.zoom.us/j/84529173006?pwd=dHJ1c3RlZA.1"),
      answerExcludes("https://us02web.zoom.us/u/kd8xQ"),
      noWrites(),
    ],
  }),
  task({
    id: "calendar-agenda",
    suite: "core",
    category: "calendar",
    origin: "Follow-on to the Zoom link report: the agenda lives in the invite's description.",
    message: "What's on the agenda for the Driftbox call today?",
    checks: [called("list_calendar_events"), answerMatches(/annual discount/i, "names the second agenda item"), answerMatches(/runner/i, "names the hosted runner pricing item"), noWrites()],
  }),
  task({
    id: "calendar-decline",
    suite: "core",
    category: "calendar",
    origin: "Calendar replies supported by the assistant: decline someone else's meeting with a note.",
    message: "Turn down the Metricove demo, say something's come up.",
    checks: [called("list_calendar_events"), card("respond_to_meeting", arg.all(arg.is("eventId", "event:vendor-demo"), arg.equals("response", "decline")))],
  }),
  task({
    id: "docs-append-daily",
    suite: "core",
    category: "docs",
    origin: "Production chat, reworded: add a very short summary of the day to the daily note.",
    message: "Pop a two-line recap in today's daily note: Quillfeather review done, Copperleaf catch-up pushed to next week.",
    checks: [card("save_doc", arg.all(arg.equals("action", "append_daily"), arg.mentions("content", "Quillfeather"), arg.mentions("content", "Copperleaf")))],
  }),
  task({
    id: "docs-daily-note-to-email",
    suite: "core",
    category: "docs",
    origin: "Production chat, reworded: act on an item in the daily note by emailing a supplier.",
    message: "Look at my daily note. I need to send Driftbox a quick email asking when pricing for hosted runners kicks in.",
    checks: [called(["read_knowledge", "search_knowledge"]), card("send_email", arg.all(toContact("Juno Frith", PERSON.juno.email), bodyMatches(/pric|cost|charg|fee/i))), houseStyle()],
  }),
  task({
    id: "docs-create-linked",
    suite: "core",
    category: "docs",
    origin: "Production chat, reworded: a doc that mentions a contact so it links to him, with a tag.",
    message: "Start a doc on the Lachlan trial using what his email says. Mention him so it links to his record, and tag it #advisor.",
    checks: [card("save_doc", arg.all(arg.equals("action", "create"), (args, world) => JSON.stringify(args.content ?? "").includes(`contact:${world.id("contact:Lachlan Frew")}`), arg.matches("content", /#advisor\b/i)))],
  }),
  task({
    id: "docs-edit-in-place",
    suite: "core",
    category: "docs",
    origin: "Production chat, reworded: bring a terms doc into line with a change.",
    message: "Lachlan's trial terms doc says six weeks. Make it eight.",
    checks: [
      calledBefore(["read_knowledge", "search_knowledge"], "save_doc"),
      card(
        "save_doc",
        arg.all(
          arg.is("docId", "doc:Lachlan trial terms"),
          arg.any(arg.all(arg.equals("action", "edit"), arg.matches("replace", /eight weeks|8 weeks/i)), arg.all(arg.equals("action", "replace"), arg.matches("content", /eight weeks|8 weeks/i), arg.not(arg.matches("content", /six weeks/i)))),
        ),
      ),
    ],
  }),
  task({
    id: "mail-morning-rundown",
    suite: "core",
    category: "mail_triage",
    origin: "Production chat, reworded: a quick run through the inbox.",
    message: "Give me a quick run through my inbox.",
    checks: [called(["search_email", "get_capture"]), answerIncludes("Odile"), answerIncludes("Felix"), noWrites()],
  }),
  task({
    id: "mail-archive-noise",
    suite: "core",
    category: "mail_triage",
    origin: "Production chat, reworded: archive the inbox noise.",
    message: "Clear out the newsletters and promos from my inbox.",
    checks: [
      called("search_email"),
      card("mail_action", arg.all(arg.equals("action", "archive"), (args, world) => ["email:news-1", "email:news-2", "email:news-3"].filter((key) => JSON.stringify(args.emailIds ?? []).includes(world.id(key))).length >= 2)),
      noCard("mail_action", touches("email:odile-1", "email:felix-1", "email:hector-1", "email:lachlan-1", "email:bram-2", "email:invoice-1", "email:invoice-2"), "doesn't archive anything that needs a reply or a payment"),
    ],
  }),
  task({
    id: "mail-overdue-payments",
    suite: "core",
    category: "mail_triage",
    origin: "Production chat, reworded: which bills in the mailbox are still unpaid.",
    message: "Which bills in my inbox are still unpaid?",
    checks: [
      called("search_email"),
      answerIncludesAny(["RM-3118", "3118"], "answer lists the Rackmoor invoice"),
      answerIncludes("6042"),
      noWrites(),
      judged("the list is right", ["Lists invoice RM-3118 (Rackmoor Hosting) as owed.", "Lists invoice 6042 (Inkbarrow Print) as owed.", "Doesn't list invoice 714 as owed, because it was paid."]),
    ],
  }),
  task({
    id: "multi-research-then-add",
    suite: "core",
    category: "multi_step",
    origin: "Production chat, reworded: research a company against the ideal customer and add it if it fits.",
    message: "Have a look at https://larchmont-words.test, tell me how well they match our ideal customer, and add them if they're a fit.",
    checks: [called("read_web_page", arg.matches("url", /larchmont-words\.test/)), card("create_company", arg.all(arg.mentions("name", "Larchmont Words"), arg.anyMentions("larchmont-words.test")))],
  }),
  task({
    id: "multi-add-contact-and-draft",
    suite: "core",
    category: "multi_step",
    origin: "Production chat, reworded: add a contact, then draft him an email with a colleague copied.",
    message: "New contact: Arlo Venn, Head of Marketing at Anvilworks QA, arlo@anvilworks.test. Then draft him a note congratulating them on the funding round, cc Pippa. Draft only.",
    checks: [
      card("create_contact", arg.all(arg.address("email", "arlo@anvilworks.test"), arg.is("companyId", "company:Anvilworks QA"))),
      card("save_email_draft", arg.all(recipient("arlo@anvilworks.test", ["to"]), recipient(PERSON.pippa.email, ["cc"]))),
      noCard("send_email"),
    ],
  }),
  task({
    id: "multi-merge-duplicate",
    suite: "core",
    category: "multi_step",
    origin: "Duplicate records that workflows created, raised in production chats: find and merge them.",
    fixture: { eclipse: { companies: [{ name: "Quillfeather Studio Ltd", domain: "quillfeatherstudio.test", description: "Created by a workflow." }] } },
    message: "Quillfeather seems to be in Orbit twice. Can you tidy that up?",
    checks: [card("merge_companies", arg.all(arg.is("keepId", "company:Quillfeather Studio"), arg.is("mergeId", "company:Quillfeather Studio Ltd")))],
  }),
  task({
    id: "multi-close-and-follow-up",
    suite: "core",
    category: "multi_step",
    origin: "Production chats: close a task and set the next one in the same breath.",
    message: "Tick off the Chase Sagebrook intro task, and set a task to ring Cyril Dunmore next Wednesday.",
    checks: [
      card("update_task", arg.all(arg.is("taskId", "task:Chase Sagebrook intro"), arg.equals("completed", true))),
      card("create_task", arg.all(arg.is("contactId", "contact:Cyril Dunmore"), dueOn("dueAt", { weekday: 3 }, { nextWeek: 2 }))),
    ],
  }),
  task({
    id: "multi-undo-last-change",
    suite: "core",
    category: "multi_step",
    origin: "Undo flows used in production: put back a change the assistant made.",
    fixture: { eclipse: { changes: [{ company: "Saltmarsh Haulage", description: "Container shipping line." }] } },
    message: "Revert the last edit you made to Saltmarsh Haulage.",
    checks: [called("list_recent_changes"), card("undo_change", arg.is("changeId", "change:Saltmarsh Haulage"))],
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
    origin: "Two contacts share a first name; a request naming only one should ask.",
    message: "Remind me to ring Felix tomorrow at 10.",
    checks: [noCard("create_task"), asks(), answerIncludes("Arden", "Okoro")],
  }),
  task({
    id: "two-companies-same-name",
    suite: "core",
    category: "two_matches",
    origin: "Two companies sharing a name; a note must go on the right one.",
    fixture: { eclipse: { companies: [{ name: "Fernhill Films", domain: "fernhill-films.test", description: "Video production company." }] } },
    message: "Fernhill's pilot has moved to May, note that on the record.",
    checks: [noCard("log_activity"), asks(), answerIncludes("Fernhill Capital", "Fernhill Films")],
  }),
  task({
    id: "workspaces-read-both",
    suite: "core",
    category: "cross_workspace",
    origin: "Production use across the Eclipse and Mark Ridgeon workspaces: read both at once.",
    message: "What's due this coming week across both my workspaces?",
    checks: [
      called("list_tasks", (args) => typeof args.workspace === "string" && /all|ridgeon/i.test(args.workspace)),
      answerIncludes("Send the Brackenridge retainer", "Send Quillfeather proposal", "Mark Ridgeon"),
      noWrites(),
    ],
  }),
  task({
    id: "workspaces-write-elsewhere",
    suite: "core",
    category: "cross_workspace",
    origin: "Requests that name a record in the other workspace: the change has to wait for a switch.",
    message: "Put a task on Elsie Brock to send the Brackenridge retainer tomorrow.",
    checks: [
      refusedOrAbsent("create_task", touches("contact:Elsie Brock", "company:Brackenridge Heating"), "no task is proposed on the other workspace's records"),
      noCard("create_task"),
      answerIncludesAny(["switch", "Mark Ridgeon"], "tells the user to switch workspace"),
    ],
  }),
  task({
    id: "workspaces-move-records",
    suite: "core",
    category: "cross_workspace",
    origin: "Moving a lead between the two brands' workspaces when asked.",
    message: "Saltmarsh Haulage is a consulting lead now. Move them over to my Mark Ridgeon workspace.",
    checks: [
      card(
        "move_records_to_workspace",
        arg.all(arg.any(arg.mentions("toWorkspace", "Mark Ridgeon"), arg.is("toWorkspace", "workspace:ridgeon")), idsInclude("companyIds", "company:Saltmarsh Haulage"), idsExclude("companyIds", "company:Quillfeather Studio")),
      ),
    ],
  }),
];
