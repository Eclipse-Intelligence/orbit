import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createActivity, listActivities } from "@/lib/crm/activities";
import { getContact, listContacts, upsertContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { ingestLead } from "@/lib/crm/leads";
import {
  createOpportunity,
  listPipeline,
  updateOpportunity,
} from "@/lib/crm/opportunities";
import { findStaleRelationships, getCompanyContext, getDueActions } from "@/lib/crm/relationships";
import { completeTask, createTask } from "@/lib/crm/tasks";
import {
  ACTIVITY_TYPES,
  LIFECYCLES,
  OPPORTUNITY_STATUSES,
  TASK_PRIORITIES,
  TASK_VIEWS,
  type Actor,
  type CompanyWrite,
  type ContactWrite,
} from "@/lib/crm/types";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function toolFailure(error: unknown) {
  const message =
    error instanceof CrmError ? `${error.code}: ${error.message}` : "The CRM request failed.";
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
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
  return {
    operation,
    source: args.provenanceSource,
    sourceUrl: args.provenanceUrl,
  };
}

export function registerRelationshipTools(server: McpServer, actor: Actor) {
  server.registerTool(
    "search_contacts",
    {
      description: "Search people in the workspace by name, email, title, phone, or company.",
      inputSchema: {
        query: z.string().optional(),
        company_id: z.uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      run(() =>
        listContacts(actor, {
          query: args.query,
          companyId: args.company_id,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    "get_contact",
    {
      description: "Retrieve one contact by id.",
      inputSchema: { id: z.uuid() },
    },
    async (args) => run(async () => ({ contact: await getContact(actor, args.id) })),
  );

  server.registerTool(
    "upsert_contact",
    {
      description:
        "Create or update a contact. Matches email, then LinkedIn, then the same name at the same company. Omitted fields stay unchanged.",
      inputSchema: {
        companyId: z.uuid().nullable().optional(),
        firstName: z.string().nullable().optional(),
        lastName: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        jobTitle: z.string().nullable().optional(),
        linkedinUrl: z.string().nullable().optional(),
        ownerId: z.uuid().nullable().optional(),
        source: z.string().nullable().optional(),
        sourceReference: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        ...provenanceFields,
      },
    },
    async (args) =>
      run(async () => {
        const write: ContactWrite = {
          companyId: args.companyId,
          firstName: args.firstName,
          lastName: args.lastName,
          email: args.email,
          phone: args.phone,
          jobTitle: args.jobTitle,
          linkedinUrl: args.linkedinUrl,
          ownerId: args.ownerId,
          source: args.source,
          sourceReference: args.sourceReference,
          notes: args.notes,
        };
        const result = await upsertContact(actor, write, {
          provenance: provenance(args, "upsert_contact"),
        });
        return result.body;
      }),
  );

  server.registerTool(
    "add_lead",
    {
      description:
        "Ingest a lead in one step: match or create the company and contact, then optionally record a note, opportunity, and next action. Reuses the same company and contact when the domain or email already exists.",
      inputSchema: {
        companyName: z.string().optional(),
        domain: z.string().nullable().optional(),
        website: z.string().nullable().optional(),
        industry: z.string().nullable().optional(),
        lifecycle: z.enum(LIFECYCLES).optional(),
        contactFirstName: z.string().nullable().optional(),
        contactLastName: z.string().nullable().optional(),
        contactEmail: z.string().nullable().optional(),
        contactPhone: z.string().nullable().optional(),
        contactTitle: z.string().nullable().optional(),
        contactLinkedin: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
        opportunityName: z.string().optional(),
        opportunityValue: z.number().nullable().optional(),
        opportunityCurrency: z.string().nullable().optional(),
        taskTitle: z.string().optional(),
        taskDueAt: z.string().nullable().optional(),
        ...provenanceFields,
      },
    },
    async (args) =>
      run(async () => {
        const company: CompanyWrite | undefined =
          args.companyName || args.domain || args.website
            ? {
                name: args.companyName,
                domain: args.domain,
                website: args.website,
                industry: args.industry,
                lifecycle: args.lifecycle,
              }
            : undefined;
        const contact =
          args.contactEmail ||
          args.contactFirstName ||
          args.contactLastName ||
          args.contactLinkedin ||
          args.contactPhone
            ? {
                firstName: args.contactFirstName,
                lastName: args.contactLastName,
                email: args.contactEmail,
                phone: args.contactPhone,
                jobTitle: args.contactTitle,
                linkedinUrl: args.contactLinkedin,
              }
            : undefined;
        const result = await ingestLead(
          actor,
          {
            company,
            contact,
            note: args.note,
            opportunity: args.opportunityName
              ? {
                  name: args.opportunityName,
                  value: args.opportunityValue,
                  currency: args.opportunityCurrency,
                }
              : undefined,
            task: args.taskTitle
              ? { title: args.taskTitle, dueAt: args.taskDueAt }
              : undefined,
          },
          { provenance: provenance(args, "ingest_lead") },
        );
        return result.body;
      }),
  );

  server.registerTool(
    "add_activity",
    {
      description:
        "Append an interaction. Activities are not edited. Attach at least a company, contact, or opportunity.",
      inputSchema: {
        type: z.enum(ACTIVITY_TYPES).optional(),
        title: z.string().nullable().optional(),
        body: z.string().nullable().optional(),
        occurredAt: z.string().nullable().optional(),
        companyId: z.uuid().nullable().optional(),
        contactId: z.uuid().nullable().optional(),
        opportunityId: z.uuid().nullable().optional(),
        ...provenanceFields,
      },
    },
    async (args) =>
      run(async () => {
        const result = await createActivity(
          actor,
          {
            type: args.type,
            title: args.title,
            body: args.body,
            occurredAt: args.occurredAt,
            companyId: args.companyId,
            contactId: args.contactId,
            opportunityId: args.opportunityId,
          },
          { provenance: provenance(args, "create_activity") },
        );
        return result.body;
      }),
  );

  server.registerTool(
    "add_note",
    {
      description: "Append a note on a company, contact, or opportunity.",
      inputSchema: {
        body: z.string(),
        title: z.string().nullable().optional(),
        companyId: z.uuid().nullable().optional(),
        contactId: z.uuid().nullable().optional(),
        opportunityId: z.uuid().nullable().optional(),
        ...provenanceFields,
      },
    },
    async (args) =>
      run(async () => {
        const result = await createActivity(
          actor,
          {
            type: "note",
            title: args.title,
            body: args.body,
            companyId: args.companyId,
            contactId: args.contactId,
            opportunityId: args.opportunityId,
          },
          { provenance: provenance(args, "add_note") },
        );
        return result.body;
      }),
  );

  server.registerTool(
    "create_opportunity",
    {
      description:
        "Create an opportunity on a company. When stage is omitted, the first stage of the default pipeline is used. Won and lost stages set the status.",
      inputSchema: {
        companyId: z.uuid(),
        name: z.string(),
        primaryContactId: z.uuid().nullable().optional(),
        stageId: z.uuid().optional(),
        value: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
        probability: z.number().int().nullable().optional(),
        expectedCloseDate: z.string().nullable().optional(),
        status: z.enum(OPPORTUNITY_STATUSES).optional(),
        source: z.string().nullable().optional(),
        ...provenanceFields,
      },
    },
    async (args) =>
      run(async () => {
        const result = await createOpportunity(
          actor,
          {
            companyId: args.companyId,
            name: args.name,
            primaryContactId: args.primaryContactId,
            stageId: args.stageId,
            value: args.value,
            currency: args.currency,
            probability: args.probability,
            expectedCloseDate: args.expectedCloseDate,
            status: args.status,
            source: args.source,
          },
          { provenance: provenance(args, "create_opportunity") },
        );
        return result.body;
      }),
  );

  server.registerTool(
    "update_opportunity",
    {
      description:
        "Update an opportunity. Omitted fields stay unchanged. Changing the stage records opportunity.stage_changed.",
      inputSchema: {
        id: z.uuid(),
        name: z.string().optional(),
        stageId: z.uuid().optional(),
        status: z.enum(OPPORTUNITY_STATUSES).optional(),
        value: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
        probability: z.number().int().nullable().optional(),
        expectedCloseDate: z.string().nullable().optional(),
        primaryContactId: z.uuid().nullable().optional(),
        source: z.string().nullable().optional(),
        ...provenanceFields,
      },
    },
    async (args) =>
      run(async () => {
        const result = await updateOpportunity(
          actor,
          args.id,
          {
            name: args.name,
            stageId: args.stageId,
            status: args.status,
            value: args.value,
            currency: args.currency,
            probability: args.probability,
            expectedCloseDate: args.expectedCloseDate,
            primaryContactId: args.primaryContactId,
            source: args.source,
          },
          { provenance: provenance(args, "update_opportunity") },
        );
        return result.body;
      }),
  );

  server.registerTool(
    "create_next_action",
    {
      description: "Create a next action, with an optional due date and company, contact, or opportunity.",
      inputSchema: {
        title: z.string(),
        description: z.string().nullable().optional(),
        dueAt: z.string().nullable().optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        companyId: z.uuid().nullable().optional(),
        contactId: z.uuid().nullable().optional(),
        opportunityId: z.uuid().nullable().optional(),
        ...provenanceFields,
      },
    },
    async (args) =>
      run(async () => {
        const result = await createTask(
          actor,
          {
            title: args.title,
            description: args.description,
            dueAt: args.dueAt,
            priority: args.priority,
            companyId: args.companyId,
            contactId: args.contactId,
            opportunityId: args.opportunityId,
          },
          { provenance: provenance(args, "create_task") },
        );
        return result.body;
      }),
  );

  server.registerTool(
    "complete_next_action",
    {
      description: "Mark a next action complete. The completed time is kept if it was already set.",
      inputSchema: { id: z.uuid(), ...provenanceFields },
    },
    async (args) =>
      run(async () => {
        const result = await completeTask(actor, args.id, {
          provenance: provenance(args, "complete_task"),
        });
        return result.body;
      }),
  );

  server.registerTool(
    "get_due_actions",
    {
      description:
        "List next actions for overdue, today (including undated), upcoming, recently completed, or companies with no open next action (view none).",
      inputSchema: { view: z.enum(TASK_VIEWS).optional() },
    },
    async (args) => run(() => getDueActions(actor, args.view ?? "today")),
  );

  server.registerTool(
    "get_recent_activity",
    {
      description: "List the latest interactions in the workspace, newest first.",
      inputSchema: {
        company_id: z.uuid().optional(),
        contact_id: z.uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      run(() =>
        listActivities(actor, {
          companyId: args.company_id,
          contactId: args.contact_id,
          limit: args.limit ?? 20,
        }),
      ),
  );

  server.registerTool(
    "get_company_context",
    {
      description:
        "Return a company with its people, open opportunities, recent interactions, open next actions, and the last interaction.",
      inputSchema: { id: z.uuid() },
    },
    async (args) => run(() => getCompanyContext(actor, args.id)),
  );

  server.registerTool(
    "find_stale_relationships",
    {
      description:
        "Find companies with no interaction, or whose latest interaction is older than the given number of days. Defaults to 21 days.",
      inputSchema: {
        days: z.number().int().min(1).max(3650).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      run(async () => ({
        data: await findStaleRelationships(actor, args.days ?? 21, args.limit ?? 50),
      })),
  );

  server.registerTool(
    "list_pipeline_stages",
    {
      description: "List the stages of the default pipeline, including which stages are won or lost.",
      inputSchema: { unused: z.string().optional() },
    },
    async () => run(() => listPipeline(actor)),
  );
}
