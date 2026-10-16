export const ECLIPSE_CONTEXT = `Eclipse is a B2B SaaS platform for B2B companies and content marketing agencies that turns company context, market data, competitor intelligence, keyword data, AI visibility data, and connected knowledge sources into content workflows. It is not just an article generator. It is closer to a content operating system: plan what to publish, generate and review content, create social distribution, track SEO and AI-search visibility, monitor competitors and Reddit opportunities, and feed all of that back into a client-specific AI workspace called Cortex/CASi.

The core tenant object is a client. A client represents the company being managed: its website, brand voice, target regions, keywords, competitors, content profiles, publishing connections, Reddit presence, GEO tracking, billing limits, and knowledge base. Users can be admin, staff, agency, or client. Admin/staff/agency users can operate across clients; client users operate inside their own client workspace.

The main products are:

1. Dashboard
   A summary layer showing client activity: article counts, published/new/in-progress content, social posts, Reddit opportunities, GEO profiles, focus keywords, recent content, recent social posts, Cortex canvases, and items needing attention.
2. Content
   The article workspace. Eclipse stores generated articles with title, body, status, metadata, keywords, content profile, meta title, meta description, excerpt, summary, brand opinion, author bio, references, images, alt tags, EEAT analysis, keyword optimization, JSON-LD, revisions, comments, CMS publishing IDs, and read/unread state. Articles can be edited, reviewed, exported, published to connected CMSs, and used as sources for social posts.
3. Planner
   A planning table for future articles. Planner rows can contain topic, title, structure, discussion points, additional directions, scheduled date, owner, primary keyword, article type, content profile, status, Cortex source references, and CASi enrichment state. Planner supports generating or enriching article briefs and then turning approved/scheduled rows into generated content.
4. Content Profiles
   Content profiles define the repeatable strategic inputs for content generation: product/service, ICP, audience, industry, country, article type, target keyword set, angle, reader emotion, distribution goal, headline preferences, and other editorial constraints. They are the bridge between raw client brand setup and consistent generated articles.
5. Product Hierarchy
   Eclipse models product/service lines, ICPs, target industries, countries, article types, and profile sets. This lets a client or operator define structured go-to-market context instead of stuffing everything into one prompt.
6. Social Media
   Eclipse generates social posts from articles, scratch pads, canvases, news, or other source material. Social profiles define platform, post type, tone/settings such as emoji, hashtags, and images. Posts can be drafts, in progress, scheduled, or published. Supported/directly modeled platforms include LinkedIn, X/Twitter, Facebook, Bluesky, Instagram, TikTok, YouTube, Threads, and Buffer-style publishing flows.
7. Social Profiles
   A configuration area for reusable social generation profiles. These control how a post should be written for a given platform and post type.
8. Keywords
   SEO keyword tracking and management. Keywords belong to clients and include region, focus status, priority, usage count, Keyword.com identifiers, CPC, best/start/current rank, rank movement, search volume, difficulty, SERP features, search intent, landing page, sync status, author assignment, product/article-type/country associations, and soft deletion when historical relationships must be preserved.
9. Keyword Scout / Keyword Analysis
   Eclipse includes keyword discovery and analysis endpoints, plus assistant-thread style keyword analysis. Keyword data is intended to influence content planning, article generation, focus keyword quotas, and rank movement reporting.
10. Analytics
    Google Analytics and Google Search Console integrations provide performance data around content, pages, and search. The app includes Google property selection and analytics overview routes for client-scoped reporting.
11. GEO Dashboard
    GEO means AI visibility / generative engine optimization. It tracks whether and how a brand appears in AI platform answers. GEO profiles contain groups of queries. Queries can run across platforms such as ChatGPT, Gemini, Perplexity, Claude, SearchGPT, DeepSeek, Mistral, Llama, Kimi, Grok, and others. Eclipse stores raw responses, extracted brand mentions, sentiment, mention type, mention position, competitor co-occurrence, weekly metrics, trends, platform breakdowns, and strategic insights.
12. GEO Profiles, Tracking, And Logs
    GEO Profiles define query sets and tracking settings. Tracking runs queries and records visibility. Logs/history show raw run outputs and processing status. The dashboard then summarizes visibility score, strongest/weakest platforms, sentiment, competitor positioning, and trend over time.
13. Competitor Intelligence
    Eclipse tracks competitor companies for each client. Competitors may start as pending placeholders and then become active after enrichment. Competitor records include domain, name, logo, positioning, ideal customer, use cases, features, differentiators, gaps, pricing, longevity/funding, reviews, services, integrations, security/compliance, and missing data. Some competitor slots can be locked/unlocked through billing logic.
14. Competitor Content Intelligence
    Eclipse stores competitor blog posts, scraped content, article-level analysis, compiled blog intelligence, topics, keywords, strengths, weaknesses, gaps, posting frequency, and client opportunities. It also stores competitor signals such as funding, product launches, pricing changes, leadership, hiring, and press.
15. Competitor Social / Review / Job Signals
    Competitor intelligence also includes social mentions, review-site intelligence, and job postings. These are used to infer positioning, pain points, hiring direction, market movement, and content opportunities.
16. Reddit
    Eclipse monitors subreddits for opportunities, brand mentions, competitor mentions, SERP-linked Reddit threads, and intent signals. It stores monitored subreddits, scored opportunities, suggested angles, Reddit brand mentions, posts/comments created from Eclipse, comment trees, rate-limit style activity, and karma snapshots. The UI includes Growth, Analytics, My Activity, and an engagement workflow for drafting or sending useful replies.
17. Cortex
    Cortex is a visual AI research and ideation workspace. It uses canvases made of nodes and edges. Node types include text notes, sticky notes, URL cards, YouTube cards, latest news, social media cards, document cards, voice memos, library snippets, chat nodes, deep research nodes, podcast cards, Notion pages, Google Docs, Confluence pages, Granola notes, Monday items/docs, groups, generated content cards, image nodes, Reddit threads, and competitor cards. Cortex can ingest sources, process them, save knowledge snippets, run chat/deep research, and generate content from selected context.
18. Cortex Library
    The Library stores reusable knowledge snippets extracted from sources and canvas nodes. Snippets have source metadata, processed structured content, tags, checksums, usage counts, custom notes, and saved views. This is the durable knowledge layer that Cortex and CASi can reuse.
19. CASi / Train CASi
    CASi is the client-specific AI assistant/context layer. Train CASi lets users upload and organize documents, connect knowledge sources, and build the material CASi should use when assisting with content, planning, and research. There is also a CASi skills system with enabled skills, slash commands, prompt templates, provider handlers, versioning, and requirements.
20. Integrations
    Eclipse connects to CMSs, analytics tools, social platforms, and knowledge sources. The codebase includes integrations for Google Analytics, Google Search Console, Contentful, HubSpot, Webflow, WordPress, Wix, Google Docs, Slack, Reddit, Buffer, direct social platforms, Notion, Google Drive, Confluence, Granola, Monday.com, and Nango-managed OAuth flows. Publishing integrations store external IDs/status back on Eclipse content or social records.
21. CMS Publishing
    Articles can carry publishing state for Contentful, Webflow, WordPress, HubSpot, and Google Docs. Eclipse tracks external entry/item/post/file IDs, published timestamps, environments, slugs, statuses, and CMS removal sync.
22. Billing, Credits, And Quotas
    Eclipse has subscription/billing state on users and clients, plan fields, AI balance tracking, monthly allocation, credit transactions, competitor-slot billing, focus keyword quotas, subreddit quotas, trials, invoicing, and upgrade flows. AI-heavy actions can be gated by balance or plan limits.
23. Agency And Client Management
    Admin/staff/agency users can create and manage clients, assign agency ownership, onboard clients, edit brand/company details, manage users, view client settings, and operate across client contexts. Client users have a narrower workspace focused on their own content, insights, settings, and client details.
24. Prospect
    There is an admin-only prospecting area with campaigns, lists, prospects, and campaign detail pages. This appears separate from the core client-facing content/GEO/competitor workflow and is likely used for GTM or outbound operations.
25. Workflow Pipelines And Scheduled Tasks
    Admin-only/internal surfaces exist for workflows and scheduled tasks. Backend workers handle article brief runs, planner scheduled generation, competitor jobs, deep research, documentation sync, Reddit jobs, invoices, prospect work, support triage, CMS status sync, and idea-hub/Cortex processing.
26. Support And Documentation
    Eclipse includes support/admin routes and a documentation sync/retrieval system. The documentation services parse, embed, sync, retrieve, and transform citations, likely to support help/docs search or assistant context.
27. Demo Mode
    Demo access is a public route at /api/demo/:industry. It logs visitors into a persistent demo client/user, marks the session as demo, expires the session after 30 minutes, and redirects into /content. A demo guard blocks most write requests while allowing safe reads and a few status/logout endpoints. Current demo coverage exists structurally but needs fuller multi-industry seeded data, now tracked in CNT-530.

A typical Eclipse workflow looks like this: set up a client profile and brand context, define products/ICPs/content profiles, connect sources and publishing integrations, add keywords and competitors, monitor GEO and Reddit, use Cortex/CASi to research and assemble context, plan articles in Planner, generate and review content, publish to CMS, generate social distribution, then track performance and market changes back into future planning.

## Killer paragraph

Eclipse is a B2B content operating system for teams and agencies that need content to shape buyer decisions, not just fill a calendar. It connects client context, research, buyer language, keywords, competitor intelligence, AI visibility, approvals, publishing and performance data into one workflow, so every asset is planned, created, reviewed and improved from evidence. The result is content that helps buyers understand the problem, trust the claims and choose with confidence before sales gets involved.`;
