import { ECLIPSE_CONTEXT, ECLIPSE_IDEAL_CUSTOMER, ECLIPSE_WEBSITE } from "@/lib/assistant/eclipse";
import type { EclipseClient, Fixture } from "../types";

export const PERSON = {
  daniel: { name: "Daniel Price", email: "daniel@lumen-agency.test" },
  danielOkafor: { name: "Daniel Okafor", email: "daniel.okafor@kestrel-media.test" },
  owen: { name: "Owen Hale", email: "owen@kestrel-media.test" },
  graham: { name: "Graham Whitlock", email: "graham@brightpath-digital.test" },
  ruth: { name: "Ruth Ellis", email: "ruth@northgate-partners.test" },
  ian: { name: "Ian Moss", email: "ian@expertly.test" },
  callum: { name: "Callum Reid", email: "callum.reid@mailbox.test" },
  simon: { name: "Simon Ashby", email: "simon@ashby-advisory.test" },
  maya: { name: "Maya Chen", email: "maya@relaycloud.test" },
  fran: { name: "Fran Lowe", email: "fran@qualityforge.test" },
  lena: { name: "Lena Park", email: "sales@analytico.test" },
};

const ECLIPSE_CLIENTS: EclipseClient[] = [
  { id: "cl-eclipse", name: "Eclipse", geo: "Eclipse is cited in 31% of AI answers about content platforms." },
  { id: "cl-ridgeon", name: "Mark Ridgeon", geo: "Mark Ridgeon is cited in 4% of AI answers about trade business consultants." },
  { id: "cl-northwind", name: "Northwind Logistics", geo: "Northwind Logistics is cited in 57% of AI answers about freight software." },
];

const GRAHAM_TRANSCRIPT = `Mark: Thanks for making time, Graham.
Graham: Happy to. We're a team of twelve and we publish about eight articles a month, mostly written by freelancers.
Mark: Where does it break down?
Graham: Corrections. A client fixes a fact in one article and it never carries over to the next freelancer.
Mark: That's the problem Eclipse's brand memory is built for.
Graham: Then I'd want a small pilot starting in March, two clients only.
Mark: I'll send a short outline this week.
Graham: Please do. And if you haven't heard from me by next Tuesday, chase me. I get buried in email.`;

export const BASE: Fixture = {
  eclipse: {
    brand: { website: ECLIPSE_WEBSITE, whatYouSell: ECLIPSE_CONTEXT, whoItsFor: ECLIPSE_IDEAL_CUSTOMER },
    booking: true,
    companies: [
      { name: "Lumen Agency", domain: "lumen-agency.test", description: "Content agency of 30 people writing for B2B software clients.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Kestrel Media", domain: "kestrel-media.test", description: "SEO and content agency in Bristol.", industry: "Marketing agency", tags: ["agency"], lifecycle: "customer" },
      { name: "Brightpath Digital", domain: "brightpath-digital.test", description: "Digital agency of twelve that relies on freelance writers.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Northgate Partners", domain: "northgate-partners.test", description: "Investment firm that runs content for its portfolio companies.", industry: "Financial services" },
      { name: "Expertly", domain: "expertly.test", description: "Expert network for consultancies.", industry: "Professional services" },
      { name: "Redfox Marketing", domain: "redfox-marketing.test", description: "Performance marketing agency in Manchester.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Valley Search", domain: "valley-search.test", description: "SEO agency in Cardiff.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Quality Forge", domain: "qualityforge.test", description: "Software testing consultancy.", industry: "Software" },
      { name: "Harbour Freight Co", domain: "harbourfreight.test", description: "Freight forwarder in Felixstowe.", industry: "Logistics" },
      { name: "Relay Cloud", domain: "relaycloud.test", description: "Cloud development environments. A supplier, not a prospect.", industry: "Software" },
      { name: "Clever Otter", domain: "cleverotter.test", description: "Content studio for consumer brands.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Brightside Agency", domain: "brightside-agency.test", description: "GEO and content agency.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Tuesday Pixel", domain: "tuesdaypixel.test", description: "Design and content agency.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Ashby Advisory", domain: "ashby-advisory.test", description: "Commercial advisory for start-ups.", industry: "Consulting" },
    ],
    contacts: [
      { first: "Daniel", last: "Price", email: PERSON.daniel.email, company: "Lumen Agency", title: "Head of Content" },
      { first: "Owen", last: "Hale", email: PERSON.owen.email, company: "Kestrel Media", title: "Managing Director" },
      { first: "Daniel", last: "Okafor", email: PERSON.danielOkafor.email, company: "Kestrel Media", title: "SEO Lead" },
      { first: "Graham", last: "Whitlock", email: PERSON.graham.email, company: "Brightpath Digital", title: "Founder", notes: "OBE." },
      { first: "Ruth", last: "Ellis", email: PERSON.ruth.email, company: "Northgate Partners", title: "Partner" },
      { first: "Ian", last: "Moss", email: PERSON.ian.email, company: "Expertly", title: "CEO" },
      { first: "Amira", last: "Shah", email: "amira@redfox-marketing.test", company: "Redfox Marketing", title: "Marketing Director" },
      { first: "Rhys", last: "Morgan", email: "rhys@valley-search.test", company: "Valley Search", title: "Founder", linkedin: "https://www.linkedin.com/in/rhys-morgan-valley" },
      { first: "Fran", last: "Lowe", email: PERSON.fran.email, company: "Quality Forge", title: "Operations Director" },
      { first: "Maya", last: "Chen", email: PERSON.maya.email, company: "Relay Cloud", title: "Account Manager" },
      { first: "Sophie", last: "Grant", email: "sophie@cleverotter.test", company: "Clever Otter", title: "Head of Growth" },
      { first: "Jake", last: "Turner", email: "jake@brightside-agency.test", company: "Brightside Agency", title: "Founder" },
      { first: "Hannah", last: "Cole", email: "hannah@tuesdaypixel.test", company: "Tuesday Pixel", title: "Director", unowned: true },
      { first: "Leo", last: "Barnes", email: "leo@tuesdaypixel.test", company: "Tuesday Pixel", title: "Content Lead", unowned: true },
      { first: "Callum", last: "Reid", email: PERSON.callum.email, title: "Possible commercial co-founder" },
      { first: "Simon", last: "Ashby", email: PERSON.simon.email, company: "Ashby Advisory", title: "Founder" },
    ],
    deals: [
      { name: "Lumen content pilot", company: "Lumen Agency", stage: "Proposal", value: 3200, contact: "Daniel Price", close: { days: 21 } },
      { name: "Kestrel content retainer", company: "Kestrel Media", stage: "Working", value: 5400, contact: "Owen Hale", close: { days: 40 } },
      { name: "Northgate content audit", company: "Northgate Partners", stage: "New", value: 1100, contact: "Ruth Ellis" },
    ],
    tasks: [
      { title: "Email Graham if I haven't heard back", due: { days: 0, at: "09:30" }, contact: "Graham Whitlock", company: "Brightpath Digital" },
      { title: "Send Lumen proposal", due: { days: 2, at: "10:00" }, company: "Lumen Agency" },
      { title: "Prepare Kestrel retainer renewal", due: { days: 4, at: "10:00" }, company: "Kestrel Media" },
      { title: "Chase Expertly intro", due: { days: -3, at: "09:00" }, company: "Expertly", contact: "Ian Moss" },
      { title: "Book Northgate follow-up", due: { days: -6 }, company: "Northgate Partners", done: true },
    ],
    activities: [
      { key: "northgate-intro", type: "meeting", title: "Intro call with Ruth", body: "Ruth runs content for three portfolio companies. Wants a content audit before Q1 budgets.", at: { days: -20, at: "14:00" }, company: "Northgate Partners", contact: "Ruth Ellis" },
      { key: "northgate-note", type: "note", title: "Audit scope", body: "Ruth wants the audit to cover the two newest portfolio sites. Their CFO holds the budget.", at: { days: -12, at: "11:00" }, company: "Northgate Partners", contact: "Ruth Ellis" },
      { key: "northgate-email", type: "email", title: "Sent audit outline", body: "Sent Ruth the audit outline and a sample report.", at: { days: -9, at: "10:00" }, company: "Northgate Partners", contact: "Ruth Ellis" },
      {
        key: "brightpath-call",
        type: "meeting",
        title: "Discovery call with Graham",
        body: "Discovery call about freelance writers and client corrections.",
        at: { days: -5, at: "15:00" },
        company: "Brightpath Digital",
        contact: "Graham Whitlock",
        transcript: GRAHAM_TRANSCRIPT,
        summary: "Graham wants a two-client pilot from March. His main pain is that client corrections don't carry across freelancers. He asked to be chased if he goes quiet.",
      },
      { key: "harbour-note", type: "note", title: "Met at Logistics Expo", body: "Harbour Freight Co publish a monthly freight market report and want more inbound enquiries from shippers. No contact yet.", at: { days: -30, at: "12:00" }, company: "Harbour Freight Co" },
      { key: "daniel-call", type: "call", title: "Call with Daniel Price about the proposal", body: "Walked Daniel through pricing. He'll confirm the pilot scope by Thursday.", at: { days: 0, at: "09:45" }, company: "Lumen Agency", contact: "Daniel Price" },
    ],
    emails: [
      { key: "simon-1", from: PERSON.simon, to: ["me"], subject: "Following up on our chat", body: "Hi Mark,\n\nGood to talk on Tuesday. As I said, I'm happy to help with the commercial side of Eclipse if you want a sounding board, and I could give it a day a week from January. No rush, have a think and let me know.\n\nSimon", at: { days: -1, at: "08:10" } },
      { key: "owen-1", thread: "owen-thread", from: "me", to: [PERSON.owen], subject: "Quick call about Kestrel's content?", body: "Hi Owen,\n\nWould you be up for a 20 minute call to look at how Kestrel keeps client corrections consistent across writers?\n\nMark", at: { days: -6, at: "09:00" } },
      { key: "owen-2", thread: "owen-thread", from: PERSON.owen, to: ["me"], subject: "Re: Quick call about Kestrel's content?", body: "Thanks Mark, yes keen to chat. Next week is busy but the one after works.\n\nOwen", at: { days: -3, at: "17:40" } },
      { key: "daniel-1", from: PERSON.daniel, to: ["me"], subject: "Proposal questions", body: "Hi Mark,\n\nThanks for the call. Two quick questions on the pilot scope. Could we talk on Thursday, at 2pm or 4pm?\n\nDaniel", at: { days: -1, at: "16:20" } },
      { key: "callum-1", from: PERSON.callum, to: ["me"], subject: "Commercial plan", body: "Hi Mark,\n\nSome thoughts on the commercial plan. Short version: start with agencies of 10 to 50 people, run a three month trial on commission only, and review together in month two. I'm free for a call on Friday morning, 10am suits me.\n\nCallum", at: { days: -2, at: "19:05" } },
      { key: "ruth-1", from: PERSON.ruth, to: ["me"], subject: "Contract question before Friday", body: "Morning Mark,\n\nOur CFO wants to check the audit's payment terms before Friday's budget meeting. Can you confirm whether it's 50% up front?\n\nRuth", at: { days: 0, at: "08:05" } },
      { key: "news-1", from: { name: "SEO Weekly", email: "digest@seoweekly.test" }, to: ["me"], subject: "SEO Weekly: 12 links you missed", body: "This week's roundup of search news, tools and jobs.", at: { days: -1, at: "06:00" } },
      { key: "news-2", from: { name: "Martech Summit", email: "events@martechsummit.test" }, to: ["me"], subject: "Your webinar replay is ready", body: "Watch the replay of last week's session on AI search.", at: { days: -2, at: "12:00" } },
      { key: "news-3", from: { name: "DesignTool", email: "offers@designtool.test" }, to: ["me"], subject: "20% off annual plans this week", body: "Upgrade now and save 20% on annual plans.", at: { days: 0, at: "06:00" } },
      { key: "invoice-1", from: { name: "HostingCo Billing", email: "billing@hostingco.test" }, to: ["me"], subject: "Invoice INV-2207 is overdue", body: "Invoice INV-2207 for £84.00 was due 14 days ago. Please pay it to avoid your service being suspended.", at: { days: -10, at: "07:00" } },
      { key: "invoice-2", from: { name: "PrintShop Accounts", email: "accounts@printshop.test" }, to: ["me"], subject: "Payment reminder: invoice 5531", body: "Invoice 5531 for £212.50 is now 14 days overdue. Please arrange payment.", at: { days: -4, at: "07:30" } },
      { key: "invoice-3", from: { name: "ToolSuite Billing", email: "billing@toolsuite.test" }, to: ["me"], subject: "Receipt for invoice 889", body: "Thanks, we've received your payment of £49.00 for invoice 889. There's nothing more to pay.", at: { days: -6, at: "07:15" } },
      { key: "relay-1", from: PERSON.maya, to: ["me"], subject: "Your Relay Cloud trial", body: "Hi Mark,\n\nYour trial now includes cloud agents. We'll announce usage fees before general availability.\n\nMaya", at: { days: -12, at: "10:00" } },
    ],
    events: [
      { key: "lumen-review", subject: "Lumen proposal review", start: { days: 0, at: "11:00" }, minutes: 60, attendees: [PERSON.daniel] },
      { key: "brightpath-catchup", subject: "Brightpath catch-up", start: { days: 0, at: "15:00" }, minutes: 30, attendees: [PERSON.graham] },
      { key: "vendor-demo", subject: "Vendor demo: Analytico", start: { days: 2, at: "13:00" }, minutes: 45, attendees: [], organiser: PERSON.lena },
      { key: "kestrel-planning", subject: "Kestrel retainer planning", start: { nextWeek: 0, at: "10:00" }, minutes: 60, attendees: [PERSON.owen] },
      { key: "northgate-review", subject: "Northgate quarterly review", start: { nextWeek: 2, at: "14:00" }, minutes: 60, attendees: [PERSON.ruth] },
    ],
    docs: [
      { title: "Callum trial terms", content: "# Callum trial terms\n\n## Trial\nTrial period: two months, commission only.\n\n## Commission\n10% of first-year revenue on deals he sources.\n\n## Review\nReview together at the end of the trial." },
    ],
    daily: [{ day: { days: 0 }, text: "Email Relay Cloud to ask when cloud usage fees start. Keep it short." }],
    knowledge: [
      {
        title: "Expertly capabilities deck",
        company: "Expertly",
        content:
          "Expertly places vetted industry experts with consultancies. We can deploy an expert within 48 hours of a brief. Our network has 12,000 vetted experts across 40 sectors. Competitor landscape: Talentbridge leads on quantified case studies, while Expertly leads on speed.",
      },
    ],
    proof: [
      { client: "Harlow Hotels Group", description: "Hotel group publishing 20 articles a month.", result: "Organic conversions up 41% in six months.", measured: "Google Analytics, January to June." },
    ],
  },
  ridgeon: {
    brand: {
      website: "https://ridgeon-consulting.test",
      whatYouSell: "Mark Ridgeon helps trades and service businesses (heating, plumbing and electrical firms) put AI to work in quoting, scheduling and follow-up, through fractional COO projects of 6 to 12 weeks.",
      whoItsFor: "Owner-led trades businesses with 10 to 80 staff in the UK.",
    },
    companies: [
      { name: "Coldstream Heating", domain: "coldstream-heating.test", description: "Heating and cooling installer.", industry: "HVAC", lifecycle: "customer" },
      { name: "Pennine Plumbing", domain: "pennine-plumbing.test", description: "Plumbing firm with 25 engineers.", industry: "Plumbing" },
    ],
    contacts: [
      { first: "Rosa", last: "Lane", email: "rosa@coldstream-heating.test", company: "Coldstream Heating", title: "Operations Manager" },
      { first: "Tom", last: "Booth", email: "tom@pennine-plumbing.test", company: "Pennine Plumbing", title: "Owner" },
    ],
    tasks: [{ title: "Send the Coldstream retainer", due: { days: 3, at: "10:00" }, contact: "Rosa Lane", company: "Coldstream Heating" }],
    knowledge: [
      { title: "Coldstream quoting review", company: "Coldstream Heating", content: "Client confidential. Coldstream's average quote took 5.2 days. After the AI quoting assistant went live it took 1.1 days." },
    ],
    proof: [{ client: "Coldstream Heating", description: "Heating installer with 40 engineers.", result: "Quote turnaround cut from five days to one.", measured: "Job management system, March to May." }],
  },
  eclipseClients: ECLIPSE_CLIENTS,
  web: {
    "https://harrow-content.test": `<html><head><title>Harrow Content</title><meta name="description" content="Content agency for B2B software companies"></head><body><main><h1>Harrow Content</h1><p>Harrow Content is a London content agency of 25 people. We write articles, guides and case studies for B2B software clients, with a bench of 40 freelance writers.</p><p>Our clients publish weekly and expect every writer to follow their style and product facts. We are hiring two more editors this quarter.</p><p>Contact: hello@harrow-content.test</p></main></body></html>`,
    "https://valley-search.test": `<html><head><title>Valley Search</title></head><body><main><h1>Valley Search</h1><p>Valley Search is an SEO agency in Cardiff working with 30 local and national brands.</p><article><h2>News: we've launched an AI search audit</h2><p>Three weeks ago we launched an AI search audit for local businesses, checking how often ChatGPT and Gemini recommend them. Founder Rhys Morgan says most clients appear in fewer than one in ten answers.</p></article></main></body></html>`,
    "https://qualityforge.test/news": `<html><head><title>Quality Forge news</title></head><body><main><h1>Quality Forge raises a £2m seed round</h1><p>Quality Forge, the software testing consultancy, has raised £2m led by Northstar Ventures to hire 15 test engineers and open a Leeds office.</p></main></body></html>`,
  },
};
