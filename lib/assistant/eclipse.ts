export const ECLIPSE_CONTEXT = `Eclipse is a content and intelligence platform for B2B brands, in-house marketing teams, SaaS companies and agencies. It takes a company's brand context, products, audiences, keywords, competitors, market signals and AI visibility data, and uses them to plan, write, review, publish and distribute content that is cited and grounded in evidence. Each client gets its own workspace, with Cortex and CASi as the research and writing layer.

The core tenant object is a client. A client is the company being managed: its website, brand voice, regions, keywords, competitors, content profiles, publishing connections, Reddit presence, GEO tracking, monitors, billing limits and knowledge base. The code has admin, staff, agency and client roles. Agency clients do not log in; the agency team works in the workspace, and agency staff are given access to specific client workspaces. Direct customers (brands and in-house teams that are not agency clients) get a client login to their own workspace.

The main products are:

1. **Dashboard**
   Summary of client activity: articles by status, social posts, Reddit opportunities, GEO profiles, focus keywords, recent content, Cortex canvases and items needing attention.
2. **Content**
   The article workspace. Articles carry title, body, status, keywords, content profile, meta fields, excerpt, summary, brand opinion, author bio, references, images and alt tags, JSON-LD, revisions, comments and CMS publishing IDs. The editor includes Napkin visuals (generated from selected text, using the client's Napkin brand style) and CASi section rewrite. Standard articles get an E-E-A-T analysis, and Justifications show the full source trail and reasoning behind an article before approval. A Medium article type covers first-person thought leadership.
3. **Planner**
   Planning table for future articles: topic, title, structure, discussion points, directions, scheduled date, owner, primary keyword, article type, content profile, status, Cortex sources and CASi enrichment. Supports brief generation, approvals and scheduled generation.
4. **Content Profiles**
   Repeatable strategic inputs for generation: product or service, ICP, audience, industry, country, article type, keywords, angle and editorial constraints. Profiles cannot be edited after creation. Only their status and schedule can change; anything else means creating a new profile.
5. **Product Hierarchy**
   Products and services, ICPs, target industries, countries, article types and profile sets, so go-to-market context is structured rather than stuffed into one prompt.
6. **Social Media and Social Profiles**
   Social posts generated from articles, canvases, news and other sources, shaped by reusable social profiles (platform, post type, tone, emoji, hashtags, images). Posts can be drafted, scheduled or published through Buffer or direct connections to LinkedIn, X, Facebook, Instagram, Pinterest, Threads, TikTok and YouTube. Napkin visuals also work on social posts.
7. **X.com**
   Built so far: OAuth connect, the X page, voice settings, an allowance meter, a £50 allowance per connected account that falls back to AI balance when used up, and monitors. Not built yet: the Opportunities tab, the composer, Send on X, the browser extension, Mentions, History and alerts.
8. **Keywords and Keyword Scout**
   Keyword tracking per client with region, focus status, priority, rank history and movement, volume, difficulty, CPC, SERP features, intent, landing page and associations to products, article types and countries. Discovery and analysis feed planning, generation and focus keyword quotas.
9. **Analytics**
   Google Analytics and Google Search Console, with property selection and client-scoped reporting on pages, queries, impressions, clicks and traffic.
10. **GEO (AI visibility)**
    GEO profiles hold query sets and competitors. Live today: weekly prompt runs across ten AI assistants (including ChatGPT, Gemini, Perplexity and Claude), brand mentions, sentiment, mention position, competitor co-occurrence, trends and platform breakdowns, run logs, history export and a weekly email. Not live yet: page-level cited URLs (CNT-1529), gap-to-brief and impact tracking (CNT-1531), and Google AI Overviews (CNT-1526).
11. **Competitor Intelligence**
    Competitor records per client, enriched from pending placeholders: positioning, ideal customer, features, differentiators, gaps, pricing, funding, reviews, integrations and compliance. Also competitor content analysis, signals (funding, launches, pricing changes, hiring, press), review monitoring and job postings. Some competitor slots are gated by billing.
12. **Monitors**
    Monitors watch web, news, global media and trusted sources for chosen topics on a set frequency. Results can be filtered, tagged, prioritised and sent into Cortex as source material. Alerts and monthly caps draw on AI balance.
13. **Reddit**
    Five areas: Engagement (communities, opportunity queue, drafting replies and original posts), Inbox, Activity, Growth (karma, posting health, community fit) and Analytics (including website referral traffic). Reddit alerts can go to Slack.
14. **Cortex, Library and Scratch Pad**
    Cortex is a visual research canvas of nodes and edges: notes, URL and YouTube cards, news, documents, voice memos, library snippets, chat, deep research, podcasts, images, Reddit threads, competitor cards and imported pages from Notion, Google Drive, Confluence, Monday and Granola. It supports chat, deep research with traceable sources, image generation, and creating articles or social posts from selected context. The Library stores reusable knowledge snippets. The Scratch Pad captures rough notes with tags and a graph view for reuse in Cortex.
15. **CASi and Train CASi**
    CASi is the client-specific writing and context engine that learns from corrections. Train CASi holds uploaded documents and training folders. CASi skills add slash commands and prompt templates.
16. **Integrations**
    Publishing: WordPress, Webflow, Wix, Contentful, Ghost, HubSpot and Google Docs, with external IDs and status synced back. Data: Google Analytics and Search Console. Knowledge: Notion, Confluence, Google Drive, Monday and Granola. Social: Buffer and direct platform connections. Also Slack notifications and Napkin AI for visuals.
17. **Eclipse MCP**
    A live MCP connector (around 312 tools) for Claude Code, Cursor, Codex and Claude Desktop. It covers content, planner, canvas, image and Napkin flows, content profiles (create, status, schedule, delete), GEO, social, Reddit, monitors, competitors, billing reads and get_agent_guide. Paid actions quote a cost first and need confirmation.
18. **Billing, Credits and AI Balance**
    The standard plan includes 20 cited articles and £50 of AI credits per month. AI balance covers generation, GEO, research, images, CASi, Reddit and social, and can be topped up with packs. A durable AI usage and credit ledger is being built (CNT-856 to CNT-860), alongside honest fallbacks where pricing for an action is unknown.
19. **Agency Accounts**
    Agencies run the full feature set across isolated client workspaces from one login, with per-member logins and access assigned per client. Recent fixes revoke personal access tokens when a password changes and stop schedules owned by removed staff.
20. **Affiliate Programme**
    20% of the base subscription for the first 6 months, up to £954 per referred client, tracked by a 90-day first-touch eclipse_ref cookie.
21. **Workflows, Scheduled Tasks and Docs Sync**
    Internal admin surfaces for workflows and scheduled tasks. Workers handle brief runs, scheduled generation, competitor jobs, deep research, monitors, Reddit jobs, invoices, support triage, CMS status sync and documentation sync for help search.
22. **AI Avatar Product Demo (in progress)**
    An interactive product demo led by an AI assistant called Jen, driven by a product-map manifest of screens, hotspots and questions with an evaluation step.

A typical workflow: set up the client and brand context, define products, ICPs and content profiles, connect knowledge sources and publishing, add keywords, competitors and monitors, track GEO and Reddit, research in Cortex, plan in Planner, generate and review articles with E-E-A-T and justifications, publish to the CMS, distribute on social, then feed performance and market changes back into planning.

## Killer paragraph

Eclipse gives B2B brands, in-house teams and agencies one place to turn what they know about their market into content buyers can trust. It brings together brand context, research, competitor and market signals, keywords and AI visibility, so each piece is planned from evidence, written with citations, checked before approval and published where buyers look. Teams can see where they show up in search and AI answers, and improve from there.`;
