import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import {
  getCompany,
  listCompanies,
  upsertCompany,
} from "@/lib/crm/companies";
import { LIFECYCLES, type Actor, type CompanyWrite } from "@/lib/crm/types";
import { registerRelationshipTools } from "@/server/mcp/relationships";

const writeShape = {
  name: z.string().optional(),
  domain: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  sizeCategory: z.string().nullable().optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  ownerId: z.uuid().nullable().optional(),
  source: z.string().nullable().optional(),
  sourceReference: z.string().nullable().optional(),
  provenanceSource: z.string().nullable().optional(),
  provenanceUrl: z.string().nullable().optional(),
};

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

function writeFromArgs(args: {
  name?: string;
  domain?: string | null;
  website?: string | null;
  description?: string | null;
  industry?: string | null;
  sizeCategory?: string | null;
  lifecycle?: CompanyWrite["lifecycle"];
  ownerId?: string | null;
  source?: string | null;
  sourceReference?: string | null;
}): CompanyWrite {
  return {
    name: args.name,
    domain: args.domain,
    website: args.website,
    description: args.description,
    industry: args.industry,
    sizeCategory: args.sizeCategory,
    lifecycle: args.lifecycle,
    ownerId: args.ownerId,
    source: args.source,
    sourceReference: args.sourceReference,
  };
}

export function createCrmMcpServer(actor: Actor) {
  const server = new McpServer(
    { name: "crm", version: "1.0.0" },
    {
      instructions:
        "Workspace CRM tools. Companies match by domain, then by name when no domain is known. Contacts match by email, then LinkedIn, then the same name at the same company. Use add_lead to record a company, person, note, opportunity, and next action together. Activities are append-only.",
    },
  );

  server.registerTool(
    "search_companies",
    {
      description:
        "Search companies in the authenticated workspace by name, domain, or industry.",
      inputSchema: {
        query: z.string().optional(),
        lifecycle: z.enum(LIFECYCLES).optional(),
        owner_id: z.uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      try {
        const result = await listCompanies(actor, {
          query: args.query,
          lifecycle: args.lifecycle,
          ownerId: args.owner_id,
          limit: args.limit,
          sort: "updated",
          order: "desc",
        });
        return toolResult(result);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_company",
    {
      description: "Retrieve one company by id, including archived companies.",
      inputSchema: { id: z.uuid() },
    },
    async (args) => {
      try {
        return toolResult({ company: await getCompany(actor, args.id) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "upsert_company",
    {
      description:
        "Create a company or update the existing company with the same domain, or the same name when neither record has a domain. Omitted fields are left unchanged.",
      inputSchema: writeShape,
    },
    async (args) => {
      try {
        const result = await upsertCompany(actor, writeFromArgs(args), {
          provenance: {
            operation: "upsert_company",
            source: args.provenanceSource,
            sourceUrl: args.provenanceUrl,
          },
        });
        return toolResult(result.body);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  registerRelationshipTools(server, actor);
  return server;
}
