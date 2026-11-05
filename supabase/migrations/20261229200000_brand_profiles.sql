create table if not exists crm.workspace_brands (
  workspace_id uuid primary key references crm.workspaces (id) on delete cascade,
  website text not null default '',
  what_you_sell text not null default '',
  tone text not null default '',
  playbook text not null default '',
  outreach_brief text not null default '',
  playbook_updated_at timestamptz,
  eclipse_tools boolean not null default false,
  updated_by uuid references crm.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_brands_website_length check (char_length(website) <= 300),
  constraint workspace_brands_what_you_sell_length check (char_length(what_you_sell) <= 6000),
  constraint workspace_brands_tone_length check (char_length(tone) <= 3000),
  constraint workspace_brands_playbook_length check (char_length(playbook) <= 60000),
  constraint workspace_brands_outreach_brief_length check (char_length(outreach_brief) <= 20000)
);

create index if not exists workspace_brands_updated_by_idx on crm.workspace_brands (updated_by);

drop trigger if exists workspace_brands_set_updated_at on crm.workspace_brands;
create trigger workspace_brands_set_updated_at
  before update on crm.workspace_brands
  for each row execute function private.set_updated_at();

alter table crm.workspace_brands enable row level security;
alter table crm.workspace_brands force row level security;

drop policy if exists workspace_brands_read on crm.workspace_brands;
create policy workspace_brands_read on crm.workspace_brands
  for select to authenticated
  using (workspace_id in (select private.user_workspace_ids()));

drop policy if exists workspace_brands_admin_insert on crm.workspace_brands;
create policy workspace_brands_admin_insert on crm.workspace_brands
  for insert to authenticated
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

drop policy if exists workspace_brands_admin_update on crm.workspace_brands;
create policy workspace_brands_admin_update on crm.workspace_brands
  for update to authenticated
  using (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id))
  with check (workspace_id in (select private.user_workspace_ids()) and private.is_workspace_admin(workspace_id));

revoke all on crm.workspace_brands from anon, authenticated, crm_agent;
grant select on crm.workspace_brands to authenticated;
grant insert (workspace_id, website, what_you_sell, tone, playbook, outreach_brief, playbook_updated_at, eclipse_tools, updated_by)
  on crm.workspace_brands to authenticated;
grant update (website, what_you_sell, tone, playbook, outreach_brief, playbook_updated_at, eclipse_tools, updated_by)
  on crm.workspace_brands to authenticated;

with seeded as (
  insert into crm.workspace_brands (workspace_id, website, what_you_sell, tone, playbook, outreach_brief, playbook_updated_at, eclipse_tools)
  select w.id,
    $seed$https://geteclipse.co$seed$,
    $seed$Eclipse is a content and intelligence platform for B2B brands, in-house marketing teams, SaaS companies and agencies. It takes a company's brand context, products, audiences, keywords, competitors, market signals and AI visibility data, and uses them to plan, write, review, publish and distribute content that is cited and grounded in evidence. Each client gets its own workspace, with Cortex and CASi as the research and writing layer. Agencies run every client from one login in separate workspaces; direct customers get their own workspace.

The main areas are Content (articles with citations, an E-E-A-T review and the source trail behind each one), Planner (briefs and scheduled generation), Content Profiles and the Product Hierarchy (products, ICPs, industries and article types that steer generation), Social (posts from articles and other sources, scheduled or published), Keywords, Analytics (Google Analytics and Search Console), GEO (weekly prompt runs across ten AI assistants showing where and how a brand is mentioned alongside competitors), Competitor Intelligence, Monitors, Reddit, Cortex (a visual research canvas with deep research and traceable sources), CASi (the client-specific writing engine that learns from corrections), publishing integrations (WordPress, Webflow, Wix, Contentful, Ghost, HubSpot, Google Docs) and an MCP connector for AI tools. The standard plan includes 20 cited articles and £50 of AI credits a month.

For how any feature works, what is live and what isn't, read the docs with eclipse_docs rather than relying on this summary. For what may be said to prospects, the outreach brief in cold_email_playbook is the authority.

Eclipse gives B2B brands, in-house teams and agencies one place to turn what they know about their market into content buyers can trust. It brings together brand context, research, competitor and market signals, keywords and AI visibility, so each article is planned from evidence, written with citations, checked before approval and published where buyers look. Teams can see where they show up in search and AI answers, and improve from there.$seed$,
    '',
    $seed$# Writing a first email to a prospect (v2)

Goal. Write an email a busy, expert person finds worth replying to. They owe Mark nothing and get many of these, so the email has to give them something before it asks for anything. Passing the format checks is not enough.

## 1. Before you research
- Is it really cold? Check Orbit first with get_contact, get_company and search_email. If Mark already talks to anyone at the company, write a normal email through that person, not over their head. If you're writing to a colleague because the main contact went quiet, say Mark has already met or emailed the team and wants to start a conversation.
- Is there a warm way in? A mutual LinkedIn connection, an event or a past Cntent relationship beats any cold email. People remember the Cntent name, so use it.
- Do they fit? First come founder-led UK B2B content and SEO agencies of 5 to 30 staff. They serve B2B SaaS, IT, fintech or cyber clients and are adding AI visibility work. Second come UK B2B firms of 50 to 500 staff with a named content owner and a budget. Skip holding-group agencies, creative studios, startups with no content owner and local firms.
- Can you reach them properly? Use only a verified address, from verify_email or a valid check less than 30 days old. Never guess one. Send from a geteclipse.co address, never a personal mailbox.

## 2. Research (keep every source)
- What they sell. Use read_web_page on their home, product and services pages. Write it down so you never pitch it back to them.
- What they think. Use social_lookup to confirm their current role and read their recent posts. Note the exact point they made and the date.
- Triggers. Look for a hire, funding, a launch, a leadership change or a new market, less than about two months old. Check recall and the nightly market notes first, then the news if web search is on. Note the date and link.
- Eclipse material. Find an article with eclipse_articles and read it in full. Copy the exact sentences and figures you might use. Check every product claim on docs.geteclipse.co.
- Proof. Look through the proof list that comes with this playbook for the entry that fits them best.
- Evidence list. Record every fact with its source and date, what they already offer, and the exact wording of any proof or figure.

## 3. Pick one angle, or don't send
Every email carries one thing they probably don't know. There are three kinds.
- Proof. Use when a proof list entry fits them and the problem behind their trigger. The new information is what a team like theirs did and what changed.
- Finding. Use when there's no close proof match, or they've made a public point you can take one step further. The new information is a specific finding from an Eclipse article.
- Made for them. Use for direct B2B firms only, once Mark has prepared it by hand. The new information is something about their own brand, such as the buyer questions where they don't appear in AI answers.

Use one angle and at most one figure per email. Proof and a finding never go in the same email. Save the other for the follow-up.

Never offer an agency an AI visibility audit or snapshot. Selling that is their business. Pitch Eclipse as the system they'd run client work on.

These don't count as something new. Agreeing with them, repeating their point, describing their own business, or offering what they already sell.

Don't send (a NO-SEND) when any of these is true:
- There's no trigger, no public point and no matching proof.
- They already sell what you'd offer, and you have nothing else.
- The address isn't verified.
- Mark already talks to someone there.

Tell Mark what's missing.

## 4. Client proof
The proof list. Client proof lives in the proof list in Knowledge (Settings, Knowledge), and cold_email_playbook returns it as proofList. Mark keeps it, and everything on it is cleared to use exactly as it stands. Each entry has the client, a description, the product, what they used it for, the result, how it was measured, and whether they can be named.

How to use it:
- Use the entry as written. Don't check it against Orbit, mail, the company record or anything else, don't question its description, product, dates or wording, and don't ask whether it's approved. If the list says it, you can say it.
- Name the client if the entry says they can be named. If it says described only, use its description instead of the name.
- Keep the result's facts and figures as the entry has them. You can fit the sentence around them.
- Never invent proof. If it isn't on the list, it isn't proof.
- Pick the entry that fits them best. If none does, use a finding.
- Say what happened, not what will happen. Never write "we can do the same for you". Anything about the prospect uses "may" or "if".
- Use plain words, not multipliers. "Went from two articles a month to eight" is better than "4x".
- Save reference calls. Offer them after a meeting, never in a first email.

## 5. Write it
- Subject. Use 2 to 5 words that name the idea, written like a note from a colleague. Keep it lower case apart from names and acronyms. Leave out first names, client names, numbers, hype, a fake reply prefix, "quick question", urgency and emoji.
- Length. 50 to 90 words in 3 to 5 short sentences, often one line each, and never over 100. Cut general sentences before the specific one.
- Format. Plain text. No link and no attachment in a first email. No bullets, bold or colons.
- Shape:
  1. The hook. A few words on a recent trigger ("Saw you're hiring a head of content.") or their own public point ("Your 2 Oct post asked how teams choose prompts."). Skip it if the point stands on its own. Never open with a summary of their business.
  2. The problem. Optional. Frame it as common, never as something they have. "Teams that scale content quickly often can't tell whether it shows up in AI answers."
  3. The one thing. The proof line, the finding or the offer.
  4. One question. Make it easy to say no to. Usually it asks about their own method, which an expert can answer from experience. For the made-for-them angle, offer the specific thing ("Want me to send the five questions where you don't come up?"), and only once it's ready.
  5. Sign-off. Just "Mark". Orbit adds the signature.
- Voice. Mark's own emails are short and plain, with an easy way out. A little humility works ("even if it's not a fit"). Don't copy their phrases, don't praise their post, and avoid polished lines that sound machine-written.
- Never in a first email. A meeting request, the booking link, a video or Loom offer, a feature list, pricing or the pilot.

## 6. Follow-up
Every email, follow-ups included, goes to Mark for approval. The follow-up is approved with the first email, on the same card.
- Day 0. The first email. Set followUp on the same send_email, with afterDays 4 and the follow-up written now as its body, so Orbit sends it in the same thread only if nobody has replied. Run cold_email_check on the follow-up too, with firstTouch false, and fix what it flags. Don't set remindAfterDays as well.
- 3 to 5 working days later. One follow-up in the same thread, 30 to 60 words, using the other angle (proof after a finding, or a finding after proof). End with an easy way out. Never "following up on my last email". This is the followUp body from day 0.
- About a week after that. A LinkedIn connection request, with no note or one plain line. No pitch, and no mention of the emails.
- Then stop. No third email. It costs more replies than it brings in.
- 6 to 8 weeks later. A new first email, only if there's a new trigger or new proof, with a new subject in a new thread.

## 7. After a reply
- Interested. Answer what they asked. If a call makes sense, offer the booking page exactly as written, https://orbit.geteclipse.co/book/mark. Agencies who ask how to try it can hear about the Agency Pilot (£595, one month, no commitment). Offer a reference call only if the client agreed to take them.
- Not now. Ask when it would make sense, then create a dated task to check in. Put off without a date, these go silent.
- Not me. Ask who to talk to, then write to that person and say who suggested them.
- No. Thank them in one line and stop.
- Replied once but not buying. Later, ask the shortlist question in Mark's words. "I don't expect you're looking at this now. When you next review how you run client content, what would we need to show to make the shortlist?"

## 8. Never
- Invent or embellish facts, problems, timing, intent, customers or results.
- Use a figure or proof that isn't in your evidence or on the proof list.
- Use more than one figure, or put a finding and proof in the same email.
- Promise or imply the prospect will get a client's result. No guarantees, ROI claims or multipliers.
- Name a client whose proof list entry is described only.
- Use filler. "I hope this finds you well", "just checking in", "quick question", "I came across your profile", "I'd love to", "touch base", "circle back".
- Use hype words. Delve, unlock, leverage, game-changing, revolutionise, cutting-edge, seamless, synergy, supercharge, elevate, empower.
- Use teaser subjects, first names in subjects, templates that swap words around to dodge spam filters, or opening lines mass-written by AI.
- Mention personal details, or anything that would feel like surveillance.
- Use em dashes, en dashes or a colon mid-sentence, or call an article a "piece".

## 9. Check, judge, propose
- Run cold_email_check with the subject, the body, what their company already offers, and your evidence. For each proof entry, pass it with kind proof and its id from proofList as source. The check reads the entry from the list. Fix every failed check, in at most two rounds.
- Judge honestly whether this person, who gets a lot of these, would find it worth replying to. If not, improve it or call it a NO-SEND.
- When you propose send_email, tell Mark:
  - the angle, and the other angle the follow-up uses
  - the signal and its date
  - the new information and its source
  - the proof entry
  - the sending address and the address check
  - anything you couldn't verify

## 10. Measure
- Tag each prospect with the angle used, cold-proof, cold-finding or cold-offer, with tag_records.
- Track replies, positive replies and meetings by angle, and note which proof entries get replies.
- Judge an angle after about 50 sends, not 20. One reply in 20 could mean a true reply rate anywhere from about 1% to 24%.
- As a rough guide only, under 2% points to the list or address quality. 2 to 5% points to the wording or the offer, and 5 to 10% is good.
- Send no more than about 10 first emails a day from the main domain. If volume ever grows past that, use a separate sending domain.
- An open isn't a read. It can be an automatic security scan.

## Examples

### Proof, to an agency
Subject: client content as you grow

Hi [first name],

Saw you've started offering AI search work to your B2B clients.

[Client, named or described], [short description, such as a 12-person B2B SEO agency], moved their client content into Eclipse in [month]. [The result from the entry, in one plain sentence.]

How are you keeping research and sources consistent as the client list grows?

Mark

Why it works. The trigger is theirs, the proof comes from a team like theirs, there's one result, and the question is about their own method. It doesn't sell them AI visibility work, which they already sell.

### Finding, to an expert (the current standard, cut to one figure)
Subject: runs behind AI visibility scores

Hi David,

Your 2 Oct post asked how teams choose the prompts behind an AI visibility score. The harder question may be how many times each prompt runs. A brand named in 6 out of 20 runs could just as easily be named in 3 or 10 next time.

How many runs per prompt do you use before you report a change to a client?

Mark

Why it works. It takes his own question one step further and gives him one number he can use in client reporting. There's no link, and it doesn't pitch anything his agency already has.

### Made for them, to a direct B2B firm
Subject: buyer questions in ChatGPT

Hi [first name],

Saw you're hiring a head of content.

New content teams often can't tell whether anything they publish shows up when buyers ask ChatGPT or Perplexity.

Want me to send the five buyer questions where [company] doesn't come up today?

Mark

Why it works. The hire is a real trigger, the problem is framed as common, and the offer is about their brand and ready before the email goes. Use it only with firms that don't sell this themselves.

### Follow-up, after a finding
Hi David,

One more on this. [A described agency of a similar size] now [the change from the proof entry, in one plain sentence].

No need to reply if it's not on your list right now.

Mark

Why it works. It stays in the same thread, adds one new thing from the other angle, and gives him an easy way out.

### What not to do. Telling them about themselves
Hi Tyler,

Your CORE Analysis runs 200+ buyer prompts through five AI models, and your retainers include weekly AI visibility tracking. If the weekly budget is tighter than the analysis, one variance study suggests where to cut. ...

Why it misses. The first sentence tells Tyler what his own product does. He knows.

### What not to do. Proof as a pitch
Hi [first name],

We helped [client] get [result one], [result two] and [result three] in [time]. We can do the same for [company]. Have you got 15 minutes this week?

Why it misses. It stacks three results, promises the same outcome, asks for a meeting and gives no reason it's going to them now. It reads like every sales email they delete.$seed$,
    $seed$# Eclipse outreach brief (what you may say)

Who it's for. First, founder-led UK B2B content and SEO agencies of 5 to 30 staff serving B2B SaaS, IT, fintech or cyber clients, who are adding AI visibility work. Second, UK B2B firms of 50 to 500 staff with a named content owner and a budget.

Problems it solves. Content that is generic, unsupported or invisible in AI answers. Marketing teams that can't prove where they show up in AI search. Agencies handling many clients' content, research and reporting by hand.

What it does (safe to say):
- Plans, writes and reviews articles from the company's own brand context, products, audiences and competitors. Articles come with citations and an E-E-A-T review before approval.
- Tracks AI visibility with weekly prompt runs across ten AI assistants. It shows whether and how a brand is mentioned, alongside competitors.
- Turns research (news, competitors, Reddit, monitors) into planned content, and distributes it to social and the CMS.
- Gives agencies one place to run every client's content, in separate workspaces.

Check anything more specific on docs.geteclipse.co before saying it.

What you can offer:
- In a first email or follow-up, one of these. A finding from an Eclipse article. A proof line from the proof list. For direct B2B firms only, a short snapshot of how their brand shows up for a few buyer questions, prepared by hand before you offer it.
- After a reply, any of these. The live demo workspace (docs.geteclipse.co/getting-started/live-demo). A call through the booking page. The Agency Pilot (£595, one month, no commitment) for agencies. A reference call, where the client has agreed to take them.

Proof. Anything on the proof list in Knowledge can be used as it stands, naming the client only when the entry says they can be named. Figures from Eclipse's published articles may be quoted exactly. Claims on Eclipse's own marketing pages, such as the agency page's "97% of articles publish without a rewrite", count as proof only once they're on the proof list with how they were measured.

Don't claim:
- Guaranteed rankings or AI mentions.
- Traffic or revenue multipliers.
- That a client's result will repeat for the prospect.
- That Eclipse replaces a team.
- Features that aren't built yet.
- Anything about the prospect's own results.
- Client results that aren't on the proof list.
- Anything from a client's workspace.$seed$,
    null,
    true
  from crm.workspaces w
  where w.created_at < timestamptz '2026-11-05 00:00:00+00'
    and not exists (select 1 from crm.workspace_brands b where b.workspace_id = w.id)
  on conflict (workspace_id) do nothing
  returning workspace_id
)
insert into crm.enrichment_settings (workspace_id, icp_text, icp_hash)
select s.workspace_id, $seed$First, founder-led UK B2B content and SEO agencies of 5 to 30 staff serving B2B SaaS, IT, fintech or cyber clients, who are adding AI visibility work. Second, UK B2B firms of 50 to 500 staff with a named content owner and a budget.$seed$, left(encode(sha256(convert_to($seed$First, founder-led UK B2B content and SEO agencies of 5 to 30 staff serving B2B SaaS, IT, fintech or cyber clients, who are adding AI visibility work. Second, UK B2B firms of 50 to 500 staff with a named content owner and a budget.$seed$, 'UTF8')), 'hex'), 32)
from seeded s
on conflict (workspace_id) do update
  set icp_text = excluded.icp_text, icp_hash = excluded.icp_hash
  where crm.enrichment_settings.icp_text is null;
