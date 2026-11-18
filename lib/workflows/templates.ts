import { autoLayout, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from "@/lib/workflows/definition";

type StarterTemplate = {
  key: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
};

function graph(trigger: WorkflowDefinition["trigger"], nodes: Omit<WorkflowNode, "position">[], edges: WorkflowEdge[]): WorkflowDefinition {
  return autoLayout({
    version: 2,
    trigger,
    triggerPosition: { x: 0, y: 0 },
    nodes: nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } })),
    edges,
  });
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    key: "at-risk-follow-up",
    name: "Follow up when a client turns at risk",
    description: "Notifies the owner and creates a check-in task when a call puts a client at risk.",
    definition: graph(
      { type: "field_changed", object: "company", field: "health", to: "at_risk" },
      [
        {
          id: "notify_1",
          type: "notify",
          label: "Tell the owner",
          config: { to: "record_owner", title: "{{company.name}} looks at risk", body: "{{company.healthReason}}" },
        },
        {
          id: "create_task_1",
          type: "create_task",
          label: "Check in",
          config: {
            title: "Check in with {{company.name}}",
            notes: "Health turned At risk: {{company.healthReason}}",
            dueInDays: 1,
            assignee: "record_owner",
            link: "company",
            clickup: false,
          },
        },
      ],
      [
        { source: "trigger", handle: "out", target: "notify_1" },
        { source: "notify_1", handle: "out", target: "create_task_1" },
      ],
    ),
  },
  {
    key: "next-step",
    name: "Next step",
    description: "When you complete a task, suggests the next one and creates it after you approve.",
    definition: graph(
      { type: "task_completed", mine: true },
      [
        {
          id: "filter_repeat",
          type: "filter",
          label: "Not a repeating task?",
          config: { match: "all", conditions: [{ left: "{{task.repeats}}", op: "is", right: "false" }] },
        },
        {
          id: "filter_1",
          type: "filter",
          label: "Linked to someone?",
          config: {
            match: "any",
            conditions: [
              { left: "{{task.contactId}}", op: "is_not_empty" },
              { left: "{{task.companyId}}", op: "is_not_empty" },
              { left: "{{task.opportunityId}}", op: "is_not_empty" },
            ],
          },
        },
        {
          id: "ai_1",
          type: "ai",
          label: "Suggest the next step",
          config: {
            model: "claude-opus-5-5",
            context: true,
            prompt:
              "I've just completed this task: {{task.title}}\nIts notes: {{task.notes}}\nIts opportunity: {{task.opportunityName}}\nWho it is with: {{contact.name}} at {{company.name}}\n\nOpen tasks on the same records:\n{{task.openTasks}}\n\nSuggest the one next task that moves this on, from what was agreed, promised or asked for in what Orbit knows below. Leave nextTask empty when an open task already covers it, when nothing clearly follows, or when the task wasn't about anyone.",
            outputs: [
              { key: "nextTask", type: "text", description: "The next task as a short instruction naming who it is with, such as \"Send Jane the signed order form\". Empty if none." },
              { key: "dueOn", type: "text", description: "The day it should be done by, as YYYY-MM-DD, from today on. Empty if no day fits." },
              { key: "why", type: "text", description: "One sentence on why this is the next step." },
            ],
          },
        },
        {
          id: "filter_2",
          type: "filter",
          label: "Anything to do?",
          config: { match: "all", conditions: [{ left: "{{steps.ai_1.nextTask}}", op: "is_not_empty" }] },
        },
        {
          id: "approval_1",
          type: "approval",
          label: "Check with me",
          config: { title: "Next step: {{steps.ai_1.nextTask}}", details: "{{steps.ai_1.why}}\n\nAfter: {{task.title}}\nDue: {{steps.ai_1.dueOn}}\nAlso created in ClickUp if it's set up." },
        },
        {
          id: "create_task_1",
          type: "create_task",
          label: "Create it",
          config: {
            title: "{{steps.ai_1.nextTask}}",
            notes: "After {{task.title}}. {{steps.ai_1.why}}",
            dueInDays: "1",
            dueDate: "{{steps.ai_1.dueOn}}",
            assignee: "owner",
            link: "task",
            clickup: true,
          },
        },
      ],
      [
        { source: "trigger", handle: "out", target: "filter_repeat" },
        { source: "filter_repeat", handle: "out", target: "filter_1" },
        { source: "filter_1", handle: "out", target: "ai_1" },
        { source: "ai_1", handle: "out", target: "filter_2" },
        { source: "filter_2", handle: "out", target: "approval_1" },
        { source: "approval_1", handle: "out", target: "create_task_1" },
      ],
    ),
  },
  {
    key: "requests-to-linear",
    name: "Product requests to Linear",
    description: "Turns product requests from calls into Linear issues, after you approve.",
    definition: graph(
      { type: "call_summary_ready" },
      [
        {
          id: "ai_1",
          type: "ai",
          label: "Find requests",
          config: {
            model: "claude-haiku-5-5",
            prompt: "List any product or feature requests {{company.name}} made on this call.\n\n{{call.summary}}",
            outputs: [{ key: "requests", type: "list", description: "Each request as a short issue title. Empty if none." }],
          },
        },
        {
          id: "if_1",
          type: "if",
          label: "Any requests?",
          config: { match: "all", conditions: [{ left: "{{steps.ai_1.requests}}", op: "is_not_empty" }] },
        },
        {
          id: "approval_1",
          type: "approval",
          label: "Check with me",
          config: { title: "Create Linear issues for {{company.name}}?", details: "{{steps.ai_1.requests}}" },
        },
        { id: "loop_1", type: "loop", label: "Each request", config: { items: "{{steps.ai_1.requests}}", limit: 10 } },
        {
          id: "linear_issue_1",
          type: "linear_issue",
          label: "Create issue",
          config: { title: "{{loop.item}}", description: "Requested by {{company.name}} on a call, {{today}}.\n\n{{company.url}}", priority: "medium" },
        },
      ],
      [
        { source: "trigger", handle: "out", target: "ai_1" },
        { source: "ai_1", handle: "out", target: "if_1" },
        { source: "if_1", handle: "true", target: "approval_1" },
        { source: "approval_1", handle: "out", target: "loop_1" },
        { source: "loop_1", handle: "each", target: "linear_issue_1" },
      ],
    ),
  },
  {
    key: "job-changes",
    name: "Spot job changes",
    description: "Monthly web check on your quietest contacts. If someone has moved, updates them after you approve.",
    definition: graph(
      { type: "schedule", frequency: "monthly", dayOfMonth: 1, time: "08:00" },
      [
        {
          id: "find_records_1",
          type: "find_records",
          label: "Contacts to check",
          config: { object: "contact", lifecycles: [], openOpportunity: "any", order: "least_contacted", limit: 25, skipDays: 60 },
        },
        { id: "loop_1", type: "loop", label: "Each contact", config: { items: "{{steps.find_records_1.records}}", limit: 25 } },
        ...moveCheckNodes("Check {{contact.name}}"),
      ],
      [
        { source: "trigger", handle: "out", target: "find_records_1" },
        { source: "find_records_1", handle: "out", target: "loop_1" },
        { source: "loop_1", handle: "each", target: "ai_1" },
        ...moveCheckEdges(),
      ],
    ),
  },
  {
    key: "bounce-check",
    name: "Check if someone moved when an email bounces",
    description: "Looks up a contact when their email bounces. If they've moved, updates them after you approve.",
    definition: graph(
      { type: "email_received", kind: "bounce" },
      moveCheckNodes("Bounce from {{contact.name}}"),
      [{ source: "trigger", handle: "out", target: "ai_1" }, ...moveCheckEdges()],
    ),
  },
  {
    key: "daily-prospecting",
    name: "Daily prospecting",
    description: "Find, research and add to a campaign every weekday.",
    definition: graph(
      { type: "schedule", frequency: "weekdays", time: "07:00" },
      [
        {
          id: "ai_1",
          type: "ai",
          label: "Find companies",
          config: {
            model: "claude-sonnet-5-5",
            webSearch: true,
            prompt:
              "Find 20 companies that fit our ideal customer and that we haven't written to before. Limited companies only: no sole traders or partnerships. Give each company's web domain.",
            outputs: [{ key: "domains", type: "list", description: "Each company's web domain, such as acme.com." }],
          },
        },
        { id: "loop_1", type: "loop", label: "Each company", config: { items: "{{steps.ai_1.domains}}", parallel: true, atOnce: 20 } },
        {
          id: "ai_2",
          type: "ai",
          label: "Who to write to",
          config: {
            model: "claude-haiku-5-5",
            webSearch: true,
            prompt: "Find the founder, managing director or head of the team that would buy from us at {{loop.item}}. Only name someone a public source names.",
            outputs: [
              { key: "companyName", type: "text", description: "The company's name." },
              { key: "firstName", type: "text", description: "Their first name." },
              { key: "lastName", type: "text", description: "Their last name." },
              { key: "jobTitle", type: "text", description: "Their job title." },
            ],
          },
        },
        {
          id: "upsert_record_1",
          type: "upsert_record",
          label: "Company",
          config: { object: "company", name: "{{steps.ai_2.companyName}}", domain: "{{loop.item}}", create: true, useInRun: true },
        },
        {
          id: "upsert_record_2",
          type: "upsert_record",
          label: "Contact",
          config: {
            object: "contact",
            firstName: "{{steps.ai_2.firstName}}",
            lastName: "{{steps.ai_2.lastName}}",
            jobTitle: "{{steps.ai_2.jobTitle}}",
            companyId: "{{steps.upsert_record_1.id}}",
            tags: "Prospecting run {{today}}",
            create: true,
            useInRun: true,
          },
        },
        { id: "find_email_1", type: "find_email", config: {} },
        {
          id: "ai_3",
          type: "ai",
          label: "Research",
          config: {
            model: "claude-sonnet-5-5",
            webSearch: true,
            prompt:
              "Research {{company.name}} ({{company.domain}}) for a first email to {{contact.name}}, {{contact.jobTitle}}: news from the last three months, launches, hires, client wins, what they publish and who they compete with.",
            outputs: [{ key: "research", type: "text", description: "What you found, with dates." }],
          },
        },
        { id: "add_to_campaign_1", type: "add_to_campaign", config: { campaignId: "", campaignName: "", channel: "" } },
      ],
      [
        { source: "trigger", handle: "out", target: "ai_1" },
        { source: "ai_1", handle: "out", target: "loop_1" },
        { source: "loop_1", handle: "each", target: "ai_2" },
        { source: "ai_2", handle: "out", target: "upsert_record_1" },
        { source: "upsert_record_1", handle: "out", target: "upsert_record_2" },
        { source: "upsert_record_2", handle: "out", target: "find_email_1" },
        { source: "find_email_1", handle: "out", target: "ai_3" },
        { source: "ai_3", handle: "out", target: "add_to_campaign_1" },
      ],
    ),
  },
  {
    key: "linkedin-finished-then-email",
    name: "LinkedIn finished, then email",
    description: "Finished a LinkedIn campaign without replying: add to an email campaign.",
    definition: graph(
      { type: "campaign_event", event: "finished", channel: "linkedin" },
      ...prospectFlow(true, [{ id: "find_email_1", type: "find_email", config: {} }, campaignNode("Email campaign")]),
    ),
  },
  {
    key: "email-finished-then-linkedin",
    name: "Email finished, then LinkedIn",
    description: "Finished an email campaign without replying: add to a LinkedIn campaign.",
    definition: graph(
      { type: "campaign_event", event: "finished", channel: "email" },
      ...prospectFlow(true, [campaignNode("LinkedIn campaign")]),
    ),
  },
  {
    key: "linkedin-step-then-email",
    name: "At a LinkedIn step, add to an email campaign",
    description: "When a LinkedIn step goes out, add them to an email campaign too. Both keep running.",
    definition: graph(
      { type: "campaign_event", event: "step", channel: "linkedin", action: "message_sent", nth: 1 },
      ...prospectFlow(false, [{ id: "find_email_1", type: "find_email", config: {} }, campaignNode("Email campaign")]),
    ),
  },
  {
    key: "email-step-then-linkedin",
    name: "At an email step, add to a LinkedIn campaign",
    description: "When an email step goes out, add them to a LinkedIn campaign too. Both keep running.",
    definition: graph(
      { type: "campaign_event", event: "step", channel: "email", step: 1 },
      ...prospectFlow(false, [campaignNode("LinkedIn campaign")]),
    ),
  },
  {
    key: "email-then-linkedin",
    name: "Email, then LinkedIn",
    description: "Opened twice or clicked: add to a LinkedIn campaign.",
    definition: graph(
      { type: "campaign_event", event: "engaged", channel: "email" },
      [{ id: "add_to_campaign_1", type: "add_to_campaign", label: "LinkedIn campaign", config: { campaignId: "", campaignName: "", channel: "" } }],
      [{ source: "trigger", handle: "out", target: "add_to_campaign_1" }],
    ),
  },
  {
    key: "positive-reply",
    name: "Positive reply",
    description: "Add to the sales board and make a task.",
    definition: graph(
      { type: "campaign_event", event: "positive" },
      [
        { id: "board_1", type: "board", label: "Sales board", config: { boardId: "", stageId: "" } },
        {
          id: "create_task_1",
          type: "create_task",
          label: "Follow up",
          config: {
            title: "Reply to {{contact.name}}",
            notes: "{{campaign.category}} in {{campaign.name}}. {{campaign.threadUrl}}",
            dueInDays: 0,
            assignee: "owner",
            link: "contact",
            clickup: false,
          },
        },
      ],
      [
        { source: "trigger", handle: "out", target: "board_1" },
        { source: "board_1", handle: "out", target: "create_task_1" },
      ],
    ),
  },
];

function notRepliedNode(): Omit<WorkflowNode, "position"> {
  return {
    id: "if_1",
    type: "if",
    label: "Not replied?",
    config: { match: "all", conditions: [{ left: "{{campaign.replied}}", op: "is", right: "false" }] },
  };
}

function prospectFlow(notReplied: boolean, tail: Omit<WorkflowNode, "position">[]): [Omit<WorkflowNode, "position">[], WorkflowEdge[]] {
  const nodes = [...(notReplied ? [notRepliedNode()] : []), companyCheckNode(), prospectCompanyNode(), prospectContactNode(), ...tail];
  const edges: WorkflowEdge[] = [
    ...(notReplied ? chain(["if_1:true", "if_company"]) : chain(["if_company"])),
    { source: "if_company", handle: "true", target: "upsert_record_2" },
    { source: "upsert_record_2", handle: "out", target: "upsert_record_1" },
    { source: "if_company", handle: "false", target: "upsert_record_1" },
  ];
  let source = "upsert_record_1";
  for (const node of tail) {
    edges.push({ source, handle: "out", target: node.id });
    source = node.id;
  }
  return [nodes, edges];
}

function companyCheckNode(): Omit<WorkflowNode, "position"> {
  return {
    id: "if_company",
    type: "if",
    label: "Company known?",
    config: {
      match: "any",
      conditions: [
        { left: "{{campaign.prospect.companyName}}", op: "is_not_empty" },
        { left: "{{campaign.prospect.website}}", op: "is_not_empty" },
      ],
    },
  };
}

function prospectCompanyNode(): Omit<WorkflowNode, "position"> {
  return {
    id: "upsert_record_2",
    type: "upsert_record",
    label: "Find or create company",
    config: { object: "company", name: "{{campaign.prospect.companyName}}", domain: "{{campaign.prospect.website}}", create: true, useInRun: true },
  };
}

function prospectContactNode(): Omit<WorkflowNode, "position"> {
  return {
    id: "upsert_record_1",
    type: "upsert_record",
    label: "Find or create contact",
    config: {
      object: "contact",
      email: "{{campaign.prospect.email}}",
      linkedinUrl: "{{campaign.prospect.linkedinUrl}}",
      firstName: "{{campaign.prospect.firstName}}",
      lastName: "{{campaign.prospect.lastName}}",
      jobTitle: "{{campaign.prospect.jobTitle}}",
      companyId: "{{steps.upsert_record_2.id}}",
      create: true,
      useInRun: true,
    },
  };
}

function campaignNode(label: string): Omit<WorkflowNode, "position"> {
  return { id: "add_to_campaign_1", type: "add_to_campaign", label, config: { campaignId: "", campaignName: "", channel: "" } };
}

function chain(order: string[]): WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];
  let source = "trigger";
  let handle = "out";
  for (const item of order) {
    const [target, next] = item.split(":");
    edges.push({ source, handle, target });
    source = target;
    handle = next ?? "out";
  }
  return edges;
}

function moveCheckNodes(label: string): Omit<WorkflowNode, "position">[] {
  return [
    {
      id: "ai_1",
      type: "ai",
      label,
      config: {
        model: "claude-sonnet-5-5",
        webSearch: true,
        context: true,
        linkedin: true,
        prompt:
          "Find out whether {{contact.name}} ({{contact.jobTitle}}) still works at {{contact.companyName}}. Their email is {{contact.email}} and their LinkedIn is {{contact.linkedinUrl}}.\n\nWhen their LinkedIn profile is given below, trust its current role over anything else. Otherwise search LinkedIn, the company's team page and recent news. Only say they have moved if a recent source names them at another organisation, and make sure it is the same person, not someone with the same name.",
        outputs: [
          { key: "stillThere", type: "choice", choices: ["yes", "no", "unsure"], description: "Do they still work there?" },
          { key: "newCompany", type: "text", description: "Their new company, if they moved." },
          { key: "newDomain", type: "text", description: "The new company's web domain, such as acme.com." },
          { key: "newTitle", type: "text", description: "Their new job title, if known." },
          { key: "confidence", type: "number", description: "How sure you are, from 0 to 100." },
          { key: "summary", type: "text", description: "One or two sentences on what you found and when." },
        ],
      },
    },
    {
      id: "filter_1",
      type: "filter",
      label: "Moved, and sure",
      config: {
        match: "all",
        conditions: [
          { left: "{{steps.ai_1.stillThere}}", op: "is", right: "no" },
          { left: "{{steps.ai_1.confidence}}", op: "greater_than", right: "79" },
        ],
      },
    },
    {
      id: "approval_1",
      type: "approval",
      label: "Check with me",
      config: {
        title: "{{contact.name}} seems to have moved to {{steps.ai_1.newCompany}}",
        details: "{{steps.ai_1.summary}}\n\nSources:\n{{steps.ai_1.sources}}",
      },
    },
    {
      id: "add_note_1",
      type: "add_note",
      label: "Note the move",
      config: {
        title: "Left {{contact.companyName}}",
        body: "{{contact.name}} seems to have left {{contact.companyName}} for {{steps.ai_1.newCompany}} as {{steps.ai_1.newTitle}}. Found {{today}}.\n\n{{steps.ai_1.summary}}\n\nSources:\n{{steps.ai_1.sources}}",
      },
    },
    {
      id: "create_task_1",
      type: "create_task",
      label: "Find their replacement",
      config: {
        title: "Find who replaced {{contact.name}} at {{contact.companyName}}",
        notes: "{{contact.name}} has moved to {{steps.ai_1.newCompany}}.",
        dueInDays: "3",
        assignee: "record_owner",
        link: "company",
        clickup: false,
      },
    },
    {
      id: "upsert_record_1",
      type: "upsert_record",
      label: "New company",
      config: { object: "company", name: "{{steps.ai_1.newCompany}}", domain: "{{steps.ai_1.newDomain}}", create: true, useInRun: false },
    },
    {
      id: "update_record_1",
      type: "update_record",
      label: "Move them",
      config: { object: "contact", field: "companyId", value: "{{steps.upsert_record_1.id}}" },
    },
    {
      id: "update_record_2",
      type: "update_record",
      label: "New title",
      config: { object: "contact", field: "jobTitle", value: "{{steps.ai_1.newTitle}}" },
    },
    {
      id: "create_task_2",
      type: "create_task",
      label: "Reach out",
      config: {
        title: "Congratulate {{contact.name}} on the move to {{steps.ai_1.newCompany}}",
        notes: "A warm contact at a new company. {{steps.upsert_record_1.url}}",
        dueInDays: "2",
        assignee: "record_owner",
        link: "contact",
        clickup: false,
      },
    },
  ];
}

function moveCheckEdges(): WorkflowEdge[] {
  const order = ["ai_1", "filter_1", "approval_1", "add_note_1", "create_task_1", "upsert_record_1", "update_record_1", "update_record_2", "create_task_2"];
  return order.slice(1).map((target, index) => ({ source: order[index], handle: "out", target }));
}

export function starterTemplate(key: string) {
  return STARTER_TEMPLATES.find((template) => template.key === key) ?? null;
}
