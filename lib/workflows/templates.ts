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
    key: "at-risk-after-call",
    name: "Flag at-risk clients after a call",
    description: "When a call summary is ready, AI judges the client's health and tells the account owner if they look at risk.",
    definition: graph(
      { type: "call_summary_ready" },
      [
        {
          id: "ai_1",
          type: "ai",
          label: "Judge health",
          config: {
            model: "claude-haiku-5-5",
            prompt: "How is our relationship with {{company.name}} after this call?\n\n{{call.summary}}",
            outputs: [
              { key: "health", type: "choice", choices: ["Healthy", "Watch", "At risk"], description: "Account health after this call." },
              { key: "reason", type: "text", description: "One sentence on why." },
            ],
          },
        },
        {
          id: "if_1",
          type: "if",
          label: "At risk?",
          config: { match: "all", conditions: [{ left: "{{steps.ai_1.health}}", op: "is", right: "At risk" }] },
        },
        {
          id: "notify_1",
          type: "notify",
          label: "Tell the owner",
          config: { to: "record_owner", title: "{{company.name}} looks at risk", body: "{{steps.ai_1.reason}}" },
        },
      ],
      [
        { source: "trigger", handle: "out", target: "ai_1" },
        { source: "ai_1", handle: "out", target: "if_1" },
        { source: "if_1", handle: "true", target: "notify_1" },
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
