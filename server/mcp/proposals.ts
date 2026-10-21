import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import type { Actor } from "@/lib/crm/types";
import { createProduct, listProducts, listTemplates, updateProduct } from "@/lib/proposals/catalogue";
import { createDocument, getDocument, listDocuments, updateDocument } from "@/lib/proposals/documents";

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof CrmError ? `${error.code}: ${error.message}` : "The proposal request failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function run(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    return toolFailure(error);
  }
}

const item = z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(10000).optional(), unitPrice: z.number().min(0).optional(), description: z.string().max(4000).optional() });

export function registerProposalTools(server: McpServer, actor: Actor) {
  server.registerTool(
    "list_proposals",
    {
      description: "List proposals and NDAs, newest first, with status, value, views and the Orbit link. status can be all, draft, open (waiting on a signature), sent, viewed, client_signed, completed, declined, withdrawn or expired.",
      inputSchema: { company_id: z.uuid().optional(), contact_id: z.uuid().optional(), status: z.string().max(20).optional(), kind: z.enum(["proposal", "nda"]).optional(), search: z.string().max(200).optional() },
    },
    async (args) =>
      run(async () => ({
        proposals: await listDocuments(actor, { companyId: args.company_id, contactId: args.contact_id, status: args.status, kind: args.kind, search: args.search, limit: 100 }),
      })),
  );

  server.registerTool(
    "get_proposal",
    { description: "One proposal or NDA with its products, wording, status, the client's link once sent, signatures and events.", inputSchema: { id: z.uuid() } },
    async (args) =>
      run(async () => {
        const detail = await getDocument(actor, args.id);
        return { ...detail, preview: undefined, version: detail.version ? { number: detail.version.number, hash: detail.version.hash } : null };
      }),
  );

  server.registerTool(
    "list_products",
    { description: "Products for proposals, with prices in GBP and USD and billing (one_off, monthly, yearly).", inputSchema: {} },
    async () => run(async () => ({ products: await listProducts(actor) })),
  );

  server.registerTool(
    "list_proposal_templates",
    { description: "Proposal and NDA templates. Only active ones can be used.", inputSchema: {} },
    async () => run(async () => ({ templates: (await listTemplates(actor)).map((template) => ({ id: template.id, name: template.name, kind: template.kind, status: template.status })) })),
  );

  server.registerTool(
    "create_proposal",
    {
      description:
        "Create a draft proposal or NDA from an active template for a contact at a company (they must work there), with products in GBP or USD. Workspace agent tokens pass owner_id (the member who sends and countersigns); personal tokens own it themselves.",
      inputSchema: {
        template_id: z.uuid(),
        company_id: z.uuid(),
        contact_id: z.uuid(),
        currency: z.enum(["GBP", "USD"]).optional(),
        items: z.array(item).max(50).optional(),
        title: z.string().max(200).optional(),
        owner_id: z.uuid().optional(),
      },
    },
    async (args) =>
      run(async () => {
        const id = await createDocument(
          actor,
          { templateId: args.template_id, companyId: args.company_id, contactId: args.contact_id, currency: args.currency, items: args.items, title: args.title, ownerId: args.owner_id },
          { operation: "create_proposal", source: "mcp" },
        );
        const detail = await getDocument(actor, id);
        return { id, href: detail.href, title: detail.title, total: detail.totalLabel, missing: detail.missing, placeholders: detail.placeholders };
      }),
  );

  server.registerTool(
    "update_proposal",
    {
      description: "Change a draft proposal: title, currency, valid_until (YYYY-MM-DD), items (replaces them) or blocks (replaces the wording; read them with get_proposal first).",
      inputSchema: {
        id: z.uuid(),
        title: z.string().max(200).optional(),
        currency: z.enum(["GBP", "USD"]).optional(),
        valid_until: z.string().max(10).optional(),
        items: z.array(item).max(50).optional(),
        blocks: z.array(z.record(z.string(), z.unknown())).max(60).optional(),
      },
    },
    async (args) =>
      run(async () => {
        await updateDocument(actor, args.id, { title: args.title, currency: args.currency, validUntil: args.valid_until, items: args.items, blocks: args.blocks }, { operation: "update_proposal", source: "mcp" });
        const detail = await getDocument(actor, args.id);
        return { id: args.id, total: detail.totalLabel, missing: detail.missing, placeholders: detail.placeholders };
      }),
  );

  server.registerTool(
    "save_product",
    {
      description: "Create a product for proposals, or update it when id is given.",
      inputSchema: {
        id: z.uuid().optional(),
        name: z.string().max(120).optional(),
        description: z.string().max(4000).optional(),
        price_gbp: z.number().min(0).nullable().optional(),
        price_usd: z.number().min(0).nullable().optional(),
        billing: z.enum(["one_off", "monthly", "yearly"]).optional(),
      },
    },
    async (args) =>
      run(async () => {
        const input = { name: args.name, description: args.description, priceGbp: args.price_gbp, priceUsd: args.price_usd, billing: args.billing };
        return { product: args.id ? await updateProduct(actor, args.id, input, { operation: "update_product", source: "mcp" }) : await createProduct(actor, input, { operation: "create_product", source: "mcp" }) };
      }),
  );
}
