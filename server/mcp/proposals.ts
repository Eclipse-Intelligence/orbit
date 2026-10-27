import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import type { Actor } from "@/lib/crm/types";
import { createProduct, createTemplate, getTemplate, listProducts, listTemplates, updateProduct, updateTemplate } from "@/lib/proposals/catalogue";
import { BLOCKS_GUIDE, proposalForAgent, templateForAgent, templateSettings } from "@/lib/proposals/agent";
import { createDocument, getDocument, listDocuments, reviseDocument, updateDocument } from "@/lib/proposals/documents";
import { STARTER_TEMPLATES } from "@/lib/proposals/starters";
import { addStep, removeStep, updateStep } from "@/lib/proposals/steps";

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

const blocks = z.array(z.record(z.string(), z.unknown())).max(60);

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
        return proposalForAgent(await getDocument(actor, args.id));
      }),
  );

  server.registerTool(
    "list_products",
    { description: "Products for proposals, with prices in GBP and USD and billing (one_off, monthly, yearly).", inputSchema: {} },
    async () => run(async () => ({ products: await listProducts(actor) })),
  );

  server.registerTool(
    "list_proposal_templates",
    { description: "Proposal and NDA templates, and the starters a new template can begin from. Only active templates can be used.", inputSchema: {} },
    async () =>
      run(async () => ({
        templates: (await listTemplates(actor)).map((template) => ({ id: template.id, name: template.name, kind: template.kind, status: template.status })),
        starters: STARTER_TEMPLATES.map((starter) => ({ key: starter.key, name: starter.name, kind: starter.kind })),
      })),
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
      description: `Change a draft proposal: title, currency, valid_until (YYYY-MM-DD), items (replaces them) or blocks (replaces them; read them with get_proposal first). A sent one needs revise_proposal first. ${BLOCKS_GUIDE}`,
      inputSchema: {
        id: z.uuid(),
        title: z.string().max(200).optional(),
        currency: z.enum(["GBP", "USD"]).optional(),
        valid_until: z.string().max(10).optional(),
        items: z.array(item).max(50).optional(),
        blocks: blocks.optional(),
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
    "revise_proposal",
    {
      description:
        "Make changes to a sent, declined or withdrawn proposal or NDA: it becomes a draft again so update_proposal can edit it. Until a person sends it again from Orbit (to the same link), the client's page says it's being updated and can't be signed. Not possible once the client has signed.",
      inputSchema: { id: z.uuid() },
    },
    async (args) =>
      run(async () => {
        await reviseDocument(actor, args.id, { operation: "revise_proposal", source: "mcp" });
        const detail = await getDocument(actor, args.id);
        return { id: args.id, status: detail.status, href: detail.href };
      }),
  );

  server.registerTool(
    "update_proposal_steps",
    {
      description:
        "Change a proposal's live Next steps plan, in any status: add a step (title, side client or us, optional due_date YYYY-MM-DD), tick one off or untick it, or remove it (step_id from get_proposal). The client sees changes straight away.",
      inputSchema: {
        id: z.uuid(),
        action: z.enum(["add", "done", "undone", "remove"]),
        step_id: z.uuid().optional(),
        title: z.string().max(300).optional(),
        side: z.enum(["client", "us"]).optional(),
        due_date: z.string().max(10).optional(),
      },
    },
    async (args) =>
      run(async () => {
        const provenance = { operation: "update_proposal_steps", source: "mcp" };
        if (args.action === "add") return { steps: await addStep(actor, args.id, { title: args.title, side: args.side, dueDate: args.due_date }, provenance) };
        if (!args.step_id) throw new CrmError("invalid_input", "Give the step_id from get_proposal.", 400, { field: "step_id" });
        if (args.action === "remove") return { steps: await removeStep(actor, args.step_id, provenance) };
        return { steps: await updateStep(actor, args.step_id, { done: args.action === "done" }, provenance) };
      }),
  );

  server.registerTool(
    "get_proposal_template",
    { description: "One proposal or NDA template: name, kind, status, settings (accent colour, days valid) and every block, including the default Next steps.", inputSchema: { id: z.uuid() } },
    async (args) => run(async () => ({ template: templateForAgent(await getTemplate(actor, args.id)) })),
  );

  server.registerTool(
    "create_proposal_template",
    {
      description:
        "Create a proposal or NDA template from a starter (list_proposal_templates lists them), as a copy of another template (copy_of), or from blocks, which work as update_proposal describes, with default Next steps as items on a steps block (title, side, dueInDays). It starts as a draft; status active lets people use it.",
      inputSchema: {
        name: z.string().max(120).optional(),
        kind: z.enum(["proposal", "nda"]).optional(),
        starter: z.string().max(40).optional(),
        copy_of: z.uuid().optional(),
        blocks: blocks.optional(),
        accent: z.string().max(7).optional(),
        valid_days: z.number().int().min(1).max(365).optional(),
        status: z.enum(["draft", "active"]).optional(),
      },
    },
    async (args) =>
      run(async () => {
        const provenance = { operation: "create_proposal_template", source: "mcp" };
        let template = await createTemplate(actor, { name: args.name, kind: args.kind, starter: args.starter, copyOf: args.copy_of }, provenance);
        const settings = templateSettings(template, { accent: args.accent, validDays: args.valid_days });
        if (args.blocks !== undefined || args.status !== undefined || settings) {
          template = await updateTemplate(actor, template.id, { blocks: args.blocks, status: args.status, settings }, provenance);
        }
        return { template: templateForAgent(template) };
      }),
  );

  server.registerTool(
    "update_proposal_template",
    {
      description:
        "Change a proposal or NDA template: name, status (draft, active or archived), accent colour, days valid, or blocks (replaces them; read them with get_proposal_template first). Changes apply to proposals created afterwards.",
      inputSchema: {
        id: z.uuid(),
        name: z.string().max(120).optional(),
        status: z.enum(["draft", "active", "archived"]).optional(),
        accent: z.string().max(7).optional(),
        valid_days: z.number().int().min(1).max(365).optional(),
        blocks: blocks.optional(),
      },
    },
    async (args) =>
      run(async () => {
        const current = await getTemplate(actor, args.id);
        const template = await updateTemplate(
          actor,
          args.id,
          { name: args.name, status: args.status, blocks: args.blocks, settings: templateSettings(current, { accent: args.accent, validDays: args.valid_days }) },
          { operation: "update_proposal_template", source: "mcp" },
        );
        return { template: templateForAgent(template) };
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
