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
    description: "When a call leaves a client at risk, tell the account owner why and give them a task to check in tomorrow.",
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
    key: "requests-to-linear",
    name: "Product requests to Linear",
    description: "When a call summary is ready, AI picks out product requests and, once you approve, creates a Linear issue for each.",
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
    description:
      "Each month, check the contacts you've been quietest with on the web. When someone has moved, and you approve, note it, move them to their new company and give you two leads: them at the new place, and whoever replaced them.",
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
    description:
      "When an email to a contact bounces, look them up on the web. If they've moved, and you approve, note it, move them to their new company and create the two follow-up tasks.",
    definition: graph(
      { type: "email_received", kind: "bounce" },
      moveCheckNodes("Bounce from {{contact.name}}"),
      [{ source: "trigger", handle: "out", target: "ai_1" }, ...moveCheckEdges()],
    ),
  },
];

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
