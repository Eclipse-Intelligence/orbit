import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { archiveCompany } from "@/lib/crm/companies";
import { recordCommunication } from "@/lib/crm/communications";
import { archiveContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { bulkIngestLeads } from "@/lib/crm/leads";
import { archiveOpportunity, listOpportunities } from "@/lib/crm/opportunities";
import { savePipelineStages } from "@/lib/crm/pipeline";
import { archiveTask, updateTask } from "@/lib/crm/tasks";
import { WEBHOOK_EVENTS, createWebhook, listWebhookDeliveries } from "@/lib/crm/webhooks";
import { OPPORTUNITY_STATUSES, TASK_PRIORITIES, type Actor } from "@/lib/crm/types";

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof CrmError ? `${error.code}: ${error.message}` : "The CRM request failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function run(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    return toolFailure(error);
  }
}

const provenanceFields = {
  provenanceSource: z.string().nullable().optional(),
  provenanceUrl: z.string().nullable().optional(),
};

function provenance(args: { provenanceSource?: string | null; provenanceUrl?: string | null }, operation: string) {
  return { operation, source: args.provenanceSource, sourceUrl: args.provenanceUrl };
}

export function registerOperationTools(server: McpServer, actor: Actor) {
  server.registerTool(
    "search_opportunities",
    {
      description: "Search opportunities by name, company, or stage.",
      inputSchema: {
        query: z.string().optional(),
        company_id: z.uuid().optional(),
        status: z.enum(OPPORTUNITY_STATUSES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      run(() =>
        listOpportunities(actor, {
          query: args.query,
          companyId: args.company_id,
          status: args.status,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    "archive_company",
    {
      description: "Archive a company. The row stays in the database and can still be retrieved.",
      inputSchema: { id: z.uuid(), ...provenanceFields },
    },
    async (args) =>
      run(async () =>
        (await archiveCompany(actor, args.id, { provenance: provenance(args, "archive_company") })).body,
      ),
  );

  server.registerTool(
    "archive_contact",
    {
      description: "Archive a contact.",
      inputSchema: { id: z.uuid(), ...provenanceFields },
    },
    async (args) =>
      run(async () =>
        (await archiveContact(actor, args.id, { provenance: provenance(args, "archive_contact") })).body,
      ),
  );

  server.registerTool(
    "archive_opportunity",
    {
      description: "Archive an opportunity.",
      inputSchema: { id: z.uuid(), ...provenanceFields },
    },
    async (args) =>
      run(async () =>
        (
          await archiveOpportunity(actor, args.id, { provenance: provenance(args, "archive_opportunity") })
        ).body,
      ),
  );

  server.registerTool(
    "update_next_action",
    {
      description: "Update a next action. Omitted fields stay unchanged. completed true marks it done.",
      inputSchema: {
        id: z.uuid(),
        title: z.string().optional(),
        description: z.string().nullable().optional(),
        dueAt: z.string().nullable().optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        completed: z.boolean().optional(),
        companyId: z.uuid().nullable().optional(),
        contactId: z.uuid().nullable().optional(),
        opportunityId: z.uuid().nullable().optional(),
        ...provenanceFields,
      },
    },
    async (args) =>
      run(async () =>
        (
          await updateTask(
            actor,
            args.id,
            {
              title: args.title,
              description: args.description,
              dueAt: args.dueAt,
              priority: args.priority,
              completed: args.completed,
              companyId: args.companyId,
              contactId: args.contactId,
              opportunityId: args.opportunityId,
            },
            { provenance: provenance(args, "update_task") },
          )
        ).body,
      ),
  );

  server.registerTool(
    "archive_next_action",
    {
      description: "Archive a next action without marking it complete.",
      inputSchema: { id: z.uuid(), ...provenanceFields },
    },
    async (args) =>
      run(async () =>
        (await archiveTask(actor, args.id, { provenance: provenance(args, "archive_task") })).body,
      ),
  );

  server.registerTool(
    "record_email",
    {
      description:
        "File an email on the matching contact or company domain, and suggest a follow-up when that company has no open next action.",
      inputSchema: communicationShape("email"),
    },
    async (args) =>
      run(() =>
        recordCommunication(actor, {
          kind: "email",
          title: args.title,
          body: args.body,
          occurredAt: args.occurredAt,
          participantEmails: args.participantEmails,
          companyId: args.companyId,
          contactId: args.contactId,
        }),
      ),
  );

  server.registerTool(
    "record_meeting",
    {
      description:
        "File a meeting on the matching contact or company, and suggest a follow-up when that company has no open next action.",
      inputSchema: communicationShape("meeting"),
    },
    async (args) =>
      run(() =>
        recordCommunication(actor, {
          kind: "meeting",
          title: args.title,
          body: args.body,
          occurredAt: args.occurredAt,
          participantEmails: args.participantEmails,
          companyId: args.companyId,
          contactId: args.contactId,
        }),
      ),
  );

  server.registerTool(
    "bulk_add_leads",
    {
      description:
        "Ingest up to 50 leads. Each lead is saved on its own. The result reports which leads were created and which failed.",
      inputSchema: {
        leads: z
          .array(
            z.object({
              companyName: z.string().optional(),
              domain: z.string().nullable().optional(),
              contactEmail: z.string().nullable().optional(),
              contactFirstName: z.string().nullable().optional(),
              contactLastName: z.string().nullable().optional(),
              note: z.string().nullable().optional(),
            }),
          )
          .min(1)
          .max(50),
        ...provenanceFields,
      },
    },
    async (args) =>
      run(async () => {
        const result = await bulkIngestLeads(
          actor,
          args.leads.map((lead) => ({
            company:
              lead.companyName || lead.domain
                ? { name: lead.companyName, domain: lead.domain }
                : undefined,
            contact:
              lead.contactEmail || lead.contactFirstName || lead.contactLastName
                ? {
                    email: lead.contactEmail,
                    firstName: lead.contactFirstName,
                    lastName: lead.contactLastName,
                  }
                : undefined,
            note: lead.note,
          })),
          { provenance: provenance(args, "bulk_add_leads") },
        );
        return result.body;
      }),
  );

  server.registerTool(
    "create_webhook",
    {
      description:
        "Register an https endpoint for workspace events. Requires the admin scope. The signing secret is returned once.",
      inputSchema: {
        url: z.string(),
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
        description: z.string().nullable().optional(),
      },
    },
    async (args) =>
      run(() => createWebhook(actor, { url: args.url, events: args.events, description: args.description })),
  );

  server.registerTool(
    "list_webhook_deliveries",
    {
      description: "List recent webhook deliveries, including failures and the last error.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async (args) => run(() => listWebhookDeliveries(actor, args.limit ?? 50)),
  );

  server.registerTool(
    "configure_pipeline",
    {
      description:
        "Replace the default pipeline stages. Include every stage you want to keep, with exactly one won stage and one lost stage. A stage that still has opportunities cannot be removed.",
      inputSchema: {
        stages: z
          .array(
            z.object({
              id: z.uuid().optional(),
              name: z.string(),
              probability: z.number().int().optional(),
              isWon: z.boolean().optional(),
              isLost: z.boolean().optional(),
            }),
          )
          .min(2)
          .max(20),
      },
    },
    async (args) => run(() => savePipelineStages(actor, args.stages)),
  );
}

function communicationShape(kind: "email" | "meeting") {
  return {
    title: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    occurredAt: z.string().nullable().optional(),
    participantEmails: z.array(z.string()).max(20).optional(),
    companyId: z.uuid().nullable().optional(),
    contactId: z.uuid().nullable().optional(),
    kind: z.literal(kind).optional(),
  };
}
