import type { WorkflowDefinition } from "@/lib/workflows/definition";

export type StarterTemplate = {
  key: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
};

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    key: "after-client-call",
    name: "After a client call",
    description:
      "When a call summary is ready, AI reads the call for sentiment, risks and product requests, logs a review note, alerts the account owner if the client looks at risk, and asks you before turning product requests into Linear issues.",
    definition: {
      trigger: { type: "call_summary_ready" },
      steps: [
        {
          id: "ai_1",
          type: "ai",
          label: "Read the call",
          config: {
            model: "claude-sonnet-5-5",
            prompt: [
              "Review this client call and assess how the relationship is going.",
              "",
              "Company: {{company.name}}",
              "Contact: {{contact.name}} ({{contact.jobTitle}})",
              "",
              "Summary:",
              "{{call.summary}}",
              "",
              "Key points:",
              "{{call.keyPoints}}",
              "",
              "Transcript:",
              "{{call.transcript}}",
            ].join("\n"),
            outputs: [
              { key: "sentiment", type: "choice", choices: ["Positive", "Neutral", "Negative"], description: "How the client felt overall." },
              { key: "health", type: "choice", choices: ["Healthy", "Watch", "At risk"], description: "Account health after this call." },
              { key: "risks", type: "list", description: "Specific risks to the relationship or renewal, each one sentence. Empty if none." },
              {
                key: "productRequests",
                type: "list",
                description: "Concrete product or feature requests the client made, each phrased as a short issue title. Empty if none.",
              },
            ],
          },
        },
        {
          id: "add_note_1",
          type: "add_note",
          label: "Log the review",
          config: {
            title: "Call review: {{steps.ai_1.health}}",
            body: [
              "Sentiment: {{steps.ai_1.sentiment}}",
              "Health: {{steps.ai_1.health}}",
              "",
              "Risks:",
              "{{steps.ai_1.risks}}",
              "",
              "Product requests:",
              "{{steps.ai_1.productRequests}}",
            ].join("\n"),
          },
        },
        {
          id: "if_1",
          type: "if",
          label: "At risk?",
          config: { match: "all", conditions: [{ left: "{{steps.ai_1.health}}", op: "is", right: "At risk" }] },
          then: [
            {
              id: "notify_1",
              type: "notify",
              label: "Alert the account owner",
              config: {
                to: "record_owner",
                title: "{{company.name}} looks at risk after a call",
                body: "{{steps.ai_1.risks}}",
              },
            },
          ],
          else: [],
        },
        {
          id: "if_2",
          type: "if",
          label: "Any product requests?",
          config: { match: "all", conditions: [{ left: "{{steps.ai_1.productRequests}}", op: "is_not_empty" }] },
          then: [
            {
              id: "approval_1",
              type: "approval",
              label: "Check the requests",
              config: {
                title: "Create Linear issues for {{company.name}}?",
                details: "{{steps.ai_1.productRequests}}",
              },
            },
            {
              id: "loop_1",
              type: "loop",
              label: "Each request",
              config: { items: "{{steps.ai_1.productRequests}}", limit: 10 },
              body: [
                {
                  id: "linear_issue_1",
                  type: "linear_issue",
                  label: "Create the issue",
                  config: {
                    title: "{{loop.item}}",
                    description: "Requested by {{company.name}} ({{contact.name}}) on a call, {{today}}.\n\nCall summary:\n{{call.summary}}\n\n{{company.url}}",
                    priority: "medium",
                  },
                },
              ],
            },
          ],
          else: [],
        },
      ],
    },
  },
];

export function starterTemplate(key: string) {
  return STARTER_TEMPLATES.find((template) => template.key === key) ?? null;
}
