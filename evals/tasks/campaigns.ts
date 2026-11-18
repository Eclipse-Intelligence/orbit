import { EMAIL_TOOLS, answerExcludes, answerIncludes, arg, called, card, custom, noCard, noWrites } from "../checks";
import type { EvalTask } from "../types";
import { idsInclude, task } from "./shared";

const RUN_NAMES = [
  "Ada", "Bea", "Cal", "Dov", "Eli", "Fen", "Gus", "Hal", "Isa", "Jem",
  "Kit", "Lux", "Mae", "Nel", "Oz", "Pim", "Quin", "Ros", "Sol", "Tam",
  "Uma", "Vic", "Wyn", "Xan", "Yva", "Zed", "Arlo", "Bo", "Cy", "Di",
];

export const AGENCY_RUN = RUN_NAMES.map((first) => ({ first, last: "Runwell", email: `${first.toLowerCase()}@runwell-agency.test`, title: "Founder", tags: ["agency-run"] }));

const RUN_KEYS = AGENCY_RUN.map((person) => `contact:${person.first} ${person.last}`);

const CAMPAIGNS = [
  { name: "Agency outreach", channel: "email" as const },
  { name: "Agency founders", channel: "linkedin" as const, sender: "me" as const },
];

function oneCard(tool: string) {
  return custom(`proposes one ${tool}`, (transcript) => {
    const count = transcript.cards.filter((item) => item.name === tool).length;
    return count === 1 ? true : `It proposed ${count}.`;
  });
}

export const CAMPAIGN_TASKS: EvalTask[] = [
  task({
    id: "campaign-add-run-to-linkedin",
    suite: "core",
    category: "propose_write",
    origin: "Campaigns plan, phase 7: add a prospecting run's people to the LinkedIn campaign, not the email one.",
    fixture: { eclipse: { contacts: AGENCY_RUN, campaigns: CAMPAIGNS } },
    earlier: [
      { role: "user", content: "Who did today's agency run find?" },
      { role: "assistant", content: `30 people, all tagged agency-run: ${AGENCY_RUN.map((person) => `${person.first} ${person.last}`).join(", ")}.` },
    ],
    message: "Add these 30 to the agency LinkedIn campaign.",
    checks: [
      card("campaign_action", arg.all(arg.equals("action", "add"), arg.is("campaignId", "campaign:Agency founders"), idsInclude("contactIds", ...RUN_KEYS)), "proposes adding all 30 to Agency founders"),
      noCard("campaign_action", arg.is("campaignId", "campaign:Agency outreach"), "doesn't use the email campaign"),
      oneCard("campaign_action"),
      noCard(EMAIL_TOOLS),
    ],
  }),
  task({
    id: "campaign-who-accepted-this-week",
    suite: "core",
    category: "find",
    origin: "Campaigns plan, phase 7: who accepted a LinkedIn invite this week.",
    fixture: {
      eclipse: {
        contacts: [
          { first: "Tobias", last: "Garrow", email: "tobias@garrow-studio.test", title: "Founder" },
          { first: "Leona", last: "Fitch", email: "leona@fitchworks.test", title: "Managing Director" },
          { first: "Morwenna", last: "Hale", email: "morwenna@halecraft.test", title: "Founder" },
          { first: "Caspian", last: "Rook", email: "caspian@rookhouse.test", title: "Director" },
        ],
        campaigns: [
          {
            name: "Agency founders",
            channel: "linkedin",
            sender: "me",
            prospects: [
              { contact: "Tobias Garrow", invited: { days: -6 }, accepted: { days: -1, at: "11:20" } },
              { contact: "Leona Fitch", invited: { days: -5 }, accepted: { days: 0, at: "08:40" } },
              { contact: "Morwenna Hale", invited: { days: -12 }, accepted: { days: -9, at: "10:00" } },
              { contact: "Caspian Rook", invited: { days: -1 } },
            ],
          },
        ],
      },
    },
    message: "Who accepted this week?",
    checks: [
      called("campaigns"),
      answerIncludes("Tobias", "Leona"),
      answerExcludes("Morwenna", "Caspian"),
      noWrites(),
    ],
  }),
  task({
    id: "campaign-reply-on-linkedin",
    suite: "core",
    category: "propose_write",
    origin: "Campaigns plan, phase 7: reply to a prospect in their LinkedIn conversation, not by email.",
    fixture: {
      eclipse: {
        contacts: [{ first: "Sarah", last: "Lindqvist", email: "sarah@marrowgate.test", company: "Quillfeather Studio", title: "Founder" }],
        campaigns: [
          { name: "Agency outreach", channel: "email", prospects: [{ contact: "Sarah Lindqvist", invited: { days: -10 } }] },
          {
            name: "Agency founders",
            channel: "linkedin",
            sender: "me",
            prospects: [{ contact: "Sarah Lindqvist", invited: { days: -8 }, accepted: { days: -6 }, reply: { at: { days: -1, at: "16:05" }, text: "Happy to chat. Are you free on Thursday?" } }],
          },
        ],
      },
    },
    message: "Reply to Sarah on LinkedIn: Thursday at 2pm works, I'll send an invite.",
    checks: [
      card(
        "campaign_action",
        arg.all(
          arg.equals("action", "reply"),
          arg.any(arg.is("prospectId", "prospect:Agency founders:Sarah Lindqvist"), arg.all(arg.is("contactId", "contact:Sarah Lindqvist"), arg.equals("channel", "linkedin"))),
          arg.mentions("text", "Thursday"),
        ),
        "proposes a LinkedIn reply to Sarah",
      ),
      noCard("campaign_action", arg.any(arg.is("prospectId", "prospect:Agency outreach:Sarah Lindqvist"), arg.equals("channel", "email")), "doesn't reply by email"),
      oneCard("campaign_action"),
      noCard(EMAIL_TOOLS),
    ],
  }),
];
