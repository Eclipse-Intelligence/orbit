import { autoLayout, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from "@/lib/workflows/definition";

export type StarterTemplate = {
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
];

export function starterTemplate(key: string) {
  return STARTER_TEMPLATES.find((template) => template.key === key) ?? null;
}
