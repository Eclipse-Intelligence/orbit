import { withActor } from "@/lib/crm/context";
import { upsertCompanyInDb } from "@/lib/crm/companies";
import { upsertContactInDb } from "@/lib/crm/contacts";
import { createActivityInDb } from "@/lib/crm/activities";
import { CrmError } from "@/lib/crm/errors";
import {
  replayOrRun,
  requestHash,
  type MutationOptions,
  type MutationOutcome,
} from "@/lib/crm/mutate";
import { createOpportunityInDb } from "@/lib/crm/opportunities";
import { assertScope } from "@/lib/crm/scopes";
import { createTaskInDb } from "@/lib/crm/tasks";
import type { Actor, LeadInput, LeadResult, Provenance } from "@/lib/crm/types";

function assertLeadScopes(actor: Actor, input: LeadInput) {
  assertScope(actor.scopes, "leads:write");
  if (input.company) assertScope(actor.scopes, "companies:write");
  if (input.contact) assertScope(actor.scopes, "contacts:write");
  if (input.activity || (input.note && input.note.trim())) {
    assertScope(actor.scopes, "activities:write");
  }
  if (input.opportunity) assertScope(actor.scopes, "opportunities:write");
  if (input.task) assertScope(actor.scopes, "tasks:write");
}

export async function ingestLead(
  actor: Actor,
  input: LeadInput,
  options: MutationOptions = {},
): Promise<MutationOutcome<LeadResult>> {
  assertLeadScopes(actor, input);
  const note = input.note?.trim() ?? "";
  if (!input.company && !input.contact && !input.activity && !input.opportunity && !input.task && !note) {
    throw new CrmError(
      "invalid_input",
      "A lead needs a company, contact, note, opportunity, or next action.",
      400,
    );
  }
  const provenance: Provenance = options.provenance ?? { operation: "ingest_lead" };
  const hash = requestHash("ingest_lead", { input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const result: LeadResult = {
        company: null,
        contact: null,
        activity: null,
        opportunity: null,
        task: null,
        companyCreated: false,
        contactCreated: false,
        companyMatchedOn: null,
        contactMatchedOn: null,
      };

      if (input.company) {
        const company = await upsertCompanyInDb(db, actor, input.company, provenance);
        result.company = company.company;
        result.companyCreated = company.created;
        result.companyMatchedOn = company.matchedOn;
      }

      if (input.contact) {
        const companyId =
          input.contact.companyId === undefined
            ? (result.company?.id ?? null)
            : input.contact.companyId;
        if (
          input.contact.companyId &&
          result.company &&
          input.contact.companyId !== result.company.id
        ) {
          throw new CrmError(
            "invalid_input",
            "Contact company does not match the lead company.",
            400,
            { field: "companyId" },
          );
        }
        const contact = await upsertContactInDb(
          db,
          actor,
          { ...input.contact, companyId },
          provenance,
        );
        result.contact = contact.contact;
        result.contactCreated = contact.created;
        result.contactMatchedOn = contact.matchedOn;
      }

      if (input.opportunity) {
        const companyId = input.opportunity.companyId ?? result.company?.id ?? result.contact?.companyId;
        if (!companyId) {
          throw new CrmError("invalid_input", "An opportunity needs a company.", 400, {
            field: "companyId",
          });
        }
        const primaryContactId =
          input.opportunity.primaryContactId === undefined
            ? (result.contact?.id ?? null)
            : input.opportunity.primaryContactId;
        result.opportunity = await createOpportunityInDb(
          db,
          actor,
          { ...input.opportunity, companyId, primaryContactId: primaryContactId ?? undefined },
          provenance,
          result.company?.name,
        );
      }

      const activityInput =
        input.activity ??
        (note
          ? { type: "research" as const, title: "Lead", body: note }
          : undefined);
      if (activityInput) {
        result.activity = await createActivityInDb(
          db,
          actor,
          {
            ...activityInput,
            companyId:
              activityInput.companyId === undefined
                ? (result.company?.id ?? result.contact?.companyId ?? null)
                : activityInput.companyId,
            contactId:
              activityInput.contactId === undefined
                ? (result.contact?.id ?? null)
                : activityInput.contactId,
            opportunityId:
              activityInput.opportunityId === undefined
                ? (result.opportunity?.id ?? null)
                : activityInput.opportunityId,
          },
          provenance,
        );
      }

      if (input.task) {
        result.task = await createTaskInDb(
          db,
          actor,
          {
            ...input.task,
            companyId:
              input.task.companyId === undefined
                ? (result.company?.id ?? result.contact?.companyId ?? null)
                : input.task.companyId,
            contactId:
              input.task.contactId === undefined
                ? (result.contact?.id ?? null)
                : input.task.contactId,
            opportunityId:
              input.task.opportunityId === undefined
                ? (result.opportunity?.id ?? null)
                : input.task.opportunityId,
          },
          provenance,
        );
      }

      return result;
    }),
  );
}
