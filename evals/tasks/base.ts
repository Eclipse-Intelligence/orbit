import { ECLIPSE_CONTEXT, ECLIPSE_IDEAL_CUSTOMER, ECLIPSE_WEBSITE } from "@/lib/assistant/eclipse";
import type { EclipseClient, Fixture } from "../types";

export const PERSON = {
  felix: { name: "Felix Arden", email: "felix@quillfeather.test" },
  felixOkoro: { name: "Felix Okoro", email: "felix.okoro@larkspur-media.test" },
  bram: { name: "Bram Kettle", email: "bram@larkspur-media.test" },
  ansel: { name: "Ansel Pike", email: "ansel@copperleaf-digital.test" },
  odile: { name: "Odile Marsh", email: "odile@fernhill-capital.test" },
  cyril: { name: "Cyril Dunmore", email: "cyril@sagebrook-experts.test" },
  lachlan: { name: "Lachlan Frew", email: "lachlan.frew@mailbox.test" },
  hector: { name: "Hector Vail", email: "hector@vail-advisory.test" },
  juno: { name: "Juno Frith", email: "juno@driftbox.test" },
  pippa: { name: "Pippa Quill", email: "pippa@anvilworks.test" },
  dora: { name: "Dora Kemp", email: "dora@metricove.test" },
};

const ECLIPSE_CLIENTS: EclipseClient[] = [
  { id: "cl-eclipse", name: "Eclipse", geo: "Eclipse appears in 29% of AI answers about content platforms." },
  { id: "cl-ridgeon", name: "Mark Ridgeon", geo: "Mark Ridgeon appears in 6% of AI answers about trades consultants." },
  { id: "cl-kittiwake", name: "Kittiwake Freight Software", geo: "Kittiwake Freight Software appears in 48% of AI answers about haulage software." },
];

export const ANSEL_TRANSCRIPT = `Mark: Thanks for joining, Ansel.
Ansel: No problem. There are nine of us and we put out about fifteen posts a month, most of them from contract writers.
Mark: Where does it go wrong?
Ansel: Brand voice. Each writer drifts, and our editors spend hours pulling copy back in line.
Mark: Keeping voice consistent across writers is what Eclipse's brand memory does.
Ansel: Then let's try it on one client from April.
Mark: I'll send a one-page plan this week.
Ansel: Great. If I've gone quiet by Tuesday, nudge me. My inbox is a mess.`;

export const BASE: Fixture = {
  eclipse: {
    brand: { website: ECLIPSE_WEBSITE, whatYouSell: ECLIPSE_CONTEXT, whoItsFor: ECLIPSE_IDEAL_CUSTOMER },
    booking: true,
    companies: [
      { name: "Quillfeather Studio", domain: "quillfeather.test", description: "Content studio of 28 people writing for B2B software clients.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Larkspur Media", domain: "larkspur-media.test", description: "SEO and content agency in Exeter.", industry: "Marketing agency", tags: ["agency"], lifecycle: "customer" },
      { name: "Copperleaf Digital", domain: "copperleaf-digital.test", description: "Digital agency of nine that relies on contract writers.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Fernhill Capital", domain: "fernhill-capital.test", description: "Investment firm that runs content for its portfolio businesses.", industry: "Financial services" },
      { name: "Sagebrook Experts", domain: "sagebrook-experts.test", description: "Specialist network for consultancies.", industry: "Professional services" },
      { name: "Bluejay Growth", domain: "bluejay-growth.test", description: "Paid social and content agency in Leicester.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Tarn Search", domain: "tarn-search.test", description: "SEO agency in Swansea.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Anvilworks QA", domain: "anvilworks.test", description: "Software testing consultancy.", industry: "Software" },
      { name: "Saltmarsh Haulage", domain: "saltmarsh-haulage.test", description: "Road haulage firm in Ipswich.", industry: "Logistics" },
      { name: "Driftbox Cloud", domain: "driftbox.test", description: "Hosted build runners. A supplier, not a prospect.", industry: "Software" },
      { name: "Pebble Heron Studio", domain: "pebbleheron.test", description: "Content studio for food and drink brands.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Sunfold Agency", domain: "sunfold-agency.test", description: "Answer engine and content agency.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Velvet Grid", domain: "velvetgrid.test", description: "Design and content agency.", industry: "Marketing agency", tags: ["agency"] },
      { name: "Vail Advisory", domain: "vail-advisory.test", description: "Commercial advice for early-stage firms.", industry: "Consulting" },
    ],
    contacts: [
      { first: "Felix", last: "Arden", email: PERSON.felix.email, company: "Quillfeather Studio", title: "Head of Content" },
      { first: "Bram", last: "Kettle", email: PERSON.bram.email, company: "Larkspur Media", title: "Managing Director" },
      { first: "Felix", last: "Okoro", email: PERSON.felixOkoro.email, company: "Larkspur Media", title: "SEO Lead" },
      { first: "Ansel", last: "Pike", email: PERSON.ansel.email, company: "Copperleaf Digital", title: "Founder" },
      { first: "Odile", last: "Marsh", email: PERSON.odile.email, company: "Fernhill Capital", title: "Partner" },
      { first: "Cyril", last: "Dunmore", email: PERSON.cyril.email, company: "Sagebrook Experts", title: "CEO" },
      { first: "Ines", last: "Calloway", email: "ines@bluejay-growth.test", company: "Bluejay Growth", title: "Marketing Director" },
      { first: "Emrys", last: "Tallow", email: "emrys@tarn-search.test", company: "Tarn Search", title: "Founder" },
      { first: "Pippa", last: "Quill", email: PERSON.pippa.email, company: "Anvilworks QA", title: "Operations Director" },
      { first: "Juno", last: "Frith", email: PERSON.juno.email, company: "Driftbox Cloud", title: "Account Manager" },
      { first: "Wren", last: "Ashdown", email: "wren@pebbleheron.test", company: "Pebble Heron Studio", title: "Head of Growth" },
      { first: "Rafe", last: "Collier", email: "rafe@sunfold-agency.test", company: "Sunfold Agency", title: "Founder" },
      { first: "Mabel", last: "Thorne", email: "mabel@velvetgrid.test", company: "Velvet Grid", title: "Director", unowned: true },
      { first: "Otis", last: "Penhale", email: "otis@velvetgrid.test", company: "Velvet Grid", title: "Content Lead", unowned: true },
      { first: "Lachlan", last: "Frew", email: PERSON.lachlan.email, title: "Possible sales partner" },
      { first: "Hector", last: "Vail", email: PERSON.hector.email, company: "Vail Advisory", title: "Founder" },
    ],
    deals: [
      { name: "Quillfeather content pilot", company: "Quillfeather Studio", stage: "Proposal", value: 4600, contact: "Felix Arden", close: { days: 21 } },
      { name: "Larkspur content retainer", company: "Larkspur Media", stage: "Working", value: 7300, contact: "Bram Kettle", close: { days: 40 } },
      { name: "Fernhill content review", company: "Fernhill Capital", stage: "New", value: 1850, contact: "Odile Marsh" },
    ],
    tasks: [
      { title: "Chase Ansel if he's gone quiet", due: { days: 0, at: "09:30" }, contact: "Ansel Pike", company: "Copperleaf Digital" },
      { title: "Send Quillfeather proposal", due: { days: 1, at: "10:00" }, company: "Quillfeather Studio" },
      { title: "Prepare Larkspur retainer renewal", due: { days: 2, at: "10:00" }, company: "Larkspur Media" },
      { title: "Chase Sagebrook intro", due: { days: -3, at: "09:00" }, company: "Sagebrook Experts", contact: "Cyril Dunmore" },
      { title: "Book Fernhill follow-up", due: { days: -6 }, company: "Fernhill Capital", done: true },
    ],
    activities: [
      { key: "fernhill-intro", type: "meeting", title: "Intro call with Odile", body: "Odile handles content for four portfolio businesses and wants a content review before the spring budget round.", at: { days: -20, at: "14:00" }, company: "Fernhill Capital", contact: "Odile Marsh" },
      { key: "fernhill-note", type: "note", title: "Review scope", body: "Odile wants the review to cover the three newest portfolio sites. Their finance director signs off.", at: { days: -12, at: "11:00" }, company: "Fernhill Capital", contact: "Odile Marsh" },
      { key: "fernhill-email", type: "email", title: "Sent review outline", body: "Sent Odile the review outline and an example report.", at: { days: -9, at: "10:00" }, company: "Fernhill Capital", contact: "Odile Marsh" },
      {
        key: "copperleaf-call",
        type: "meeting",
        title: "Discovery call with Ansel",
        body: "Discovery call about contract writers and brand voice.",
        at: { days: -5, at: "15:00" },
        company: "Copperleaf Digital",
        contact: "Ansel Pike",
        transcript: ANSEL_TRANSCRIPT,
        summary: "Ansel wants to trial Eclipse on one client from April. His main pain is brand voice drifting between contract writers. He asked to be nudged if he goes quiet.",
      },
      { key: "saltmarsh-note", type: "note", title: "Met at the Eastern Freight Show", body: "Saltmarsh Haulage send out a quarterly haulage rates bulletin and want more enquiries from retailers. No contact yet.", at: { days: -30, at: "12:00" }, company: "Saltmarsh Haulage" },
      { key: "felix-call", type: "call", title: "Call with Felix Arden about the proposal", body: "Went through pricing with Felix. He'll confirm the pilot scope by Thursday.", at: { days: 0, at: "10:15" }, company: "Quillfeather Studio", contact: "Felix Arden" },
    ],
    emails: [
      { key: "hector-1", from: PERSON.hector, to: ["me"], subject: "Good to catch up", body: "Hi Mark,\n\nEnjoyed our chat on Monday. If it helps, I'm glad to introduce you to two investors I know, and I could spend a few hours a week on it from February. Think it over and let me know.\n\nHector", at: { days: -1, at: "08:10" } },
      { key: "bram-1", thread: "bram-thread", from: "me", to: [PERSON.bram], subject: "Twenty minutes on Larkspur's writer workflow?", body: "Hi Bram,\n\nWould a short call to look at how Larkspur keeps writers on brief be useful?\n\nMark", at: { days: -6, at: "09:00" } },
      { key: "bram-2", thread: "bram-thread", from: PERSON.bram, to: ["me"], subject: "Re: Twenty minutes on Larkspur's writer workflow?", body: "Hi Mark,\n\nHappy to talk. The next fortnight is packed, but after that is fine.\n\nBram", at: { days: -3, at: "17:40" } },
      { key: "felix-1", from: PERSON.felix, to: ["me"], subject: "A couple of questions on scope", body: "Hi Mark,\n\nThanks for today. I have two questions about the pilot scope. Is Thursday at 2pm or 4pm good for a call?\n\nFelix", at: { days: -1, at: "16:20" } },
      { key: "lachlan-1", from: PERSON.lachlan, to: ["me"], subject: "Thoughts on the partnership", body: "Hi Mark,\n\nHere's how I'd approach it. Focus on agencies of 5 to 20 people, start with a six week trial on a small monthly retainer, and review together in week four. Friday at 10am works for a call.\n\nLachlan", at: { days: -2, at: "19:05" } },
      { key: "odile-1", from: PERSON.odile, to: ["me"], subject: "Payment schedule before Thursday", body: "Hi Mark,\n\nOur finance director wants the payment schedule for the review before Thursday's board meeting. Is it half on signing?\n\nOdile", at: { days: 0, at: "08:05" } },
      { key: "news-1", from: { name: "Ranking Roundup", email: "digest@rankingroundup.test" }, to: ["me"], subject: "Ranking Roundup: this week in search", body: "This week's search news, tools and jobs.", at: { days: -1, at: "06:00" } },
      { key: "news-2", from: { name: "Signal Forum", email: "events@signalforum.test" }, to: ["me"], subject: "Recording: AI search panel", body: "Watch the recording of last week's panel on AI search.", at: { days: -2, at: "12:00" } },
      { key: "news-3", from: { name: "PaletteBox", email: "offers@palettebox.test" }, to: ["me"], subject: "Annual plans, 25% off this week", body: "Switch to an annual plan this week and save 25%.", at: { days: 0, at: "06:00" } },
      { key: "invoice-1", from: { name: "Rackmoor Hosting", email: "billing@rackmoor.test" }, to: ["me"], subject: "Invoice RM-3118 is overdue", body: "Invoice RM-3118 for £96.00 was due 12 days ago. Please pay it to keep your servers running.", at: { days: -10, at: "07:00" } },
      { key: "invoice-2", from: { name: "Inkbarrow Print", email: "accounts@inkbarrow.test" }, to: ["me"], subject: "Reminder: invoice 6042", body: "Invoice 6042 for £187.40 is now 16 days overdue. Please arrange payment.", at: { days: -4, at: "07:30" } },
      { key: "invoice-3", from: { name: "Toolwell Billing", email: "billing@toolwell.test" }, to: ["me"], subject: "Receipt for invoice 714", body: "Thanks, we've received £39.00 for invoice 714. Nothing more to pay.", at: { days: -6, at: "07:15" } },
      { key: "driftbox-1", from: PERSON.juno, to: ["me"], subject: "Your Driftbox trial", body: "Hi Mark,\n\nYour trial now includes hosted runners. We'll share pricing for them before the public launch.\n\nJuno", at: { days: -12, at: "10:00" } },
    ],
    events: [
      { key: "quillfeather-review", subject: "Quillfeather proposal review", start: { days: 0, at: "11:00" }, minutes: 60, attendees: [PERSON.felix] },
      { key: "copperleaf-catchup", subject: "Copperleaf catch-up", start: { days: 0, at: "16:30" }, minutes: 30, attendees: [PERSON.ansel] },
      { key: "vendor-demo", subject: "Metricove product demo", start: { days: 2, at: "13:00" }, minutes: 45, attendees: [], organiser: PERSON.dora },
      { key: "larkspur-planning", subject: "Larkspur retainer planning", start: { nextWeek: 0, at: "10:00" }, minutes: 60, attendees: [PERSON.bram] },
      { key: "fernhill-review", subject: "Fernhill quarterly review", start: { nextWeek: 2, at: "14:00" }, minutes: 60, attendees: [PERSON.odile] },
    ],
    docs: [
      { title: "Lachlan trial terms", content: "# Lachlan trial terms\n\n## Trial\nTrial period: six weeks, on a retainer of £800 a month.\n\n## Commission\n8% of first-year revenue on deals he brings in.\n\n## Review\nReview together in week four." },
    ],
    daily: [{ day: { days: 0 }, text: "Ask Driftbox when pricing for hosted runners kicks in. Keep it brief." }],
    knowledge: [
      {
        title: "Sagebrook Experts capability deck",
        company: "Sagebrook Experts",
        content: "Sagebrook Experts supplies vetted specialists to consultancies. We can place a specialist within 72 hours of a brief. Our bench has 3,400 vetted experts across 18 sectors. Competitors: Mosswell Talent leads on published case studies, while Sagebrook leads on speed.",
      },
      { title: "Thistledown Inns case study", content: "Thistledown Inns, a group of 14 country pubs with rooms, grew direct bookings 27% in five months after moving their content to Eclipse." },
    ],
    proof: [{ client: "Thistledown Inns", description: "Pub group with rooms publishing 12 articles a month.", result: "Direct bookings up 27% in five months.", measured: "Booking system, April to August." }],
  },
  ridgeon: {
    brand: {
      website: "https://ridgeon-consulting.test",
      whatYouSell: "Mark Ridgeon runs short operations projects for trades firms (heating, roofing and electrical), setting up AI for job booking, quoting and chasing invoices. Projects run 8 to 10 weeks.",
      whoItsFor: "UK trades firms with 15 to 60 staff, run by the owner.",
    },
    companies: [
      { name: "Brackenridge Heating", domain: "brackenridge-heating.test", description: "Heating installer.", industry: "HVAC", lifecycle: "customer" },
      { name: "Hollowell Plumbing", domain: "hollowell-plumbing.test", description: "Plumbing firm with 18 engineers.", industry: "Plumbing" },
    ],
    contacts: [
      { first: "Elsie", last: "Brock", email: "elsie@brackenridge-heating.test", company: "Brackenridge Heating", title: "Office Manager" },
      { first: "Ned", last: "Farrow", email: "ned@hollowell-plumbing.test", company: "Hollowell Plumbing", title: "Owner" },
    ],
    tasks: [{ title: "Send the Brackenridge retainer", due: { days: 2, at: "11:00" }, contact: "Elsie Brock", company: "Brackenridge Heating" }],
    knowledge: [{ title: "Brackenridge quoting review", company: "Brackenridge Heating", content: "Client confidential. Brackenridge's average quote took 3.8 days. With the AI quoting assistant it took 0.6 days." }],
    proof: [{ client: "Brackenridge Heating", description: "Heating installer with 22 engineers.", result: "Quotes went out the same day instead of after four days.", measured: "Job management system, January to March." }],
  },
  eclipseClients: ECLIPSE_CLIENTS,
  web: {
    "https://larchmont-words.test": `<html><head><title>Larchmont Words</title><meta name="description" content="Content agency for B2B software companies"></head><body><main><h1>Larchmont Words</h1><p>Larchmont Words is a Bristol content agency of 22 people. We write guides and case studies for B2B software companies with a pool of 35 freelance writers.</p><p>Every client expects our writers to follow their house style and product facts. We're adding two editors this quarter.</p><p>Contact: hello@larchmont-words.test</p></main></body></html>`,
    "https://tarn-search.test": `<html><head><title>Tarn Search</title></head><body><main><h1>Tarn Search</h1><p>Tarn Search is an SEO agency in Swansea working with 40 clinics and local brands.</p><article><h2>News: a free answer engine check</h2><p>Two weeks ago we launched a free answer engine check for dental and physio clinics, which shows how often ChatGPT and Gemini suggest them. Founder Emrys Tallow says most clinics turn up in under a fifth of answers.</p></article></main></body></html>`,
    "https://anvilworks.test/news": `<html><head><title>Anvilworks QA news</title></head><body><main><h1>Anvilworks QA raises £3.5m</h1><p>Anvilworks QA, the software testing consultancy, has raised £3.5m led by Hedgerow Capital to hire nine test engineers and open a Norwich office.</p></main></body></html>`,
  },
};
