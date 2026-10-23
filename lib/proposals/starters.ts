import type { Block, DocumentKind, TemplateSettings } from "@/lib/proposals/model";

type Starter = { key: string; kind: DocumentKind; name: string; blocks: Block[]; settings: TemplateSettings };

const NDA_GENERAL =
  "This agreement is governed by the law of England and Wales, and the courts of England and Wales have exclusive jurisdiction. It is the whole agreement between the parties about its subject. Neither party may assign it without the other's written consent. A change to it only counts if it is in writing and signed by both parties.";

export const STARTER_TEMPLATES: Starter[] = [
  {
    key: "proposal",
    kind: "proposal",
    name: "Proposal",
    settings: { accent: "#4124fb", validDays: 30, logo: null },
    blocks: [
      { id: "b1", type: "cover", title: "{{proposal.title}}", subtitle: "Prepared for {{contact.name}} at {{company.name}} by {{sender.name}}, {{workspace.name}}." },
      {
        id: "b2",
        type: "section",
        heading: "Why we're writing",
        body: "Hi {{contact.firstName}},\n\nThank you for your time. This proposal sets out how {{workspace.name}} can help {{company.name}}, what is included and what it costs.",
      },
      {
        id: "b3",
        type: "section",
        heading: "What we'll do",
        body: "- [Describe the first deliverable]\n- [Describe the second deliverable]\n- [Describe how you'll report on progress]",
      },
      { id: "b4", type: "pricing", heading: "Investment", intro: "Prices exclude VAT. This proposal is valid until {{proposal.validUntil}}." },
      {
        id: "b5",
        type: "section",
        heading: "Next steps",
        body: "Sign below to accept. We'll countersign, send you a signed copy and book a kick-off call within two working days.",
      },
      {
        id: "b6",
        type: "terms",
        heading: "Terms and conditions",
        body: "Signing this proposal means you accept it and our terms and conditions.",
        linkLabel: "Read our terms and conditions",
        linkUrl: "https://geteclipse.co/terms",
      },
    ],
  },
  {
    key: "mutual-nda",
    kind: "nda",
    name: "Mutual NDA",
    settings: { accent: "#4124fb", validDays: 30, logo: null },
    blocks: [
      { id: "b1", type: "cover", title: "Mutual non-disclosure agreement", subtitle: "Between {{workspace.name}} and {{company.name}}, dated {{today}}." },
      {
        id: "b2",
        type: "section",
        heading: "1. Purpose",
        body: "{{workspace.name}} and {{company.name}} want to share confidential information with each other to discuss a possible working relationship (the Purpose).",
      },
      {
        id: "b3",
        type: "section",
        heading: "2. Confidential information",
        body: "Confidential information is any information one party (the Discloser) shares with the other (the Recipient) about its business, customers, products, plans or finances, in any form, that is marked confidential or that a reasonable person would understand to be confidential.",
      },
      {
        id: "b4",
        type: "section",
        heading: "3. Obligations",
        body: "The Recipient will:\n\n- use confidential information only for the Purpose;\n- keep it secure and not disclose it, except to its employees and advisers who need it for the Purpose and are bound by similar duties;\n- return or destroy it when asked.",
      },
      {
        id: "b5",
        type: "section",
        heading: "4. Exclusions",
        body: "These obligations do not apply to information that is or becomes public through no fault of the Recipient, that the Recipient already lawfully had, that it receives lawfully from someone else, that it develops independently, or that it must disclose by law or a court order (after telling the Discloser where lawful).",
      },
      {
        id: "b6",
        type: "section",
        heading: "5. Term",
        body: "This agreement starts on the date it is signed by both parties and lasts for two years. The duties of confidentiality continue for three years after it ends.",
      },
      { id: "b7", type: "section", heading: "6. General", body: NDA_GENERAL },
    ],
  },
  {
    key: "one-way-nda",
    kind: "nda",
    name: "One-way NDA",
    settings: { accent: "#4124fb", validDays: 30, logo: null },
    blocks: [
      { id: "b1", type: "cover", title: "Non-disclosure agreement", subtitle: "From {{company.name}} to {{workspace.name}}, dated {{today}}." },
      {
        id: "b2",
        type: "section",
        heading: "1. Purpose",
        body: "{{workspace.name}} (the Discloser) will share confidential information with {{company.name}} (the Recipient) so the Recipient can evaluate working with the Discloser (the Purpose).",
      },
      {
        id: "b3",
        type: "section",
        heading: "2. Confidential information",
        body: "Confidential information is any information the Discloser shares about its business, customers, products, plans or finances, in any form, that is marked confidential or that a reasonable person would understand to be confidential.",
      },
      {
        id: "b4",
        type: "section",
        heading: "3. Obligations",
        body: "The Recipient will use confidential information only for the Purpose, keep it secure, share it only with employees and advisers who need it and are bound by similar duties, and return or destroy it when asked.",
      },
      {
        id: "b5",
        type: "section",
        heading: "4. Exclusions",
        body: "These obligations do not apply to information that is or becomes public through no fault of the Recipient, that the Recipient already lawfully had, that it receives lawfully from someone else, that it develops independently, or that it must disclose by law.",
      },
      { id: "b6", type: "section", heading: "5. Term", body: "The duties of confidentiality last for three years from the date this agreement is signed by both parties." },
      { id: "b7", type: "section", heading: "6. General", body: NDA_GENERAL },
    ],
  },
];
