"use server";

import { headers } from "next/headers";
import { getUserActor } from "@/lib/auth/user";
import { clientIp } from "@/lib/booking/book";
import { CrmError } from "@/lib/crm/errors";
import { listContacts } from "@/lib/crm/contacts";
import {
  createProduct,
  createTemplate,
  listProducts,
  listTemplates,
  updateProduct,
  updateTemplate,
  type Product,
  type ProductInput,
  type Template,
} from "@/lib/proposals/catalogue";
import {
  archiveDocument,
  countersignDocument,
  createDocument,
  getDocument,
  reviseDocument,
  sendDocument,
  updateDocument,
  withdrawDocument,
  type DocumentDetail,
} from "@/lib/proposals/documents";

type Result<T> = { data?: T; error?: string };

async function run<T>(work: (user: NonNullable<Awaited<ReturnType<typeof getUserActor>>>) => Promise<T>): Promise<Result<T>> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in again." };
  try {
    return { data: await work(user) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message };
    console.error("Proposal action failed", error);
    return { error: "That didn't work. Try again." };
  }
}

export async function saveProductAction(id: string | null, input: ProductInput & { archived?: boolean }): Promise<Result<Product>> {
  return run((user) => (id ? updateProduct(user, id, input) : createProduct(user, input)));
}

export async function createTemplateAction(input: { name?: string; kind?: string; starter?: string; copyOf?: string }): Promise<Result<Template>> {
  return run((user) => createTemplate(user, input));
}

export async function saveTemplateAction(id: string, input: { name?: string; status?: string; blocks?: unknown; settings?: unknown }): Promise<Result<Template>> {
  return run((user) => updateTemplate(user, id, input));
}

export async function createProposalAction(input: {
  templateId: string;
  companyId: string;
  contactId: string;
  currency: string;
  items: { productId: string; quantity: number }[];
  title?: string;
}): Promise<Result<string>> {
  return run((user) => createDocument(user, input));
}

export async function saveProposalAction(id: string, input: Record<string, unknown>): Promise<Result<DocumentDetail>> {
  return run(async (user) => {
    await updateDocument(user, id, input);
    return getDocument(user, id);
  });
}

export async function sendProposalAction(
  id: string,
  input: { subject?: string; message?: string; from?: string; email: boolean },
): Promise<Result<{ detail: DocumentDetail; url: string; warning: string | null }>> {
  return run(async (user) => {
    const sent = await sendDocument(user, id, input);
    return { detail: await getDocument(user, id), url: sent.url, warning: sent.warning };
  });
}

export async function changeProposalAction(id: string, action: "revise" | "withdraw" | "archive" | "unarchive"): Promise<Result<DocumentDetail | null>> {
  return run(async (user) => {
    if (action === "revise") await reviseDocument(user, id);
    else if (action === "withdraw") await withdrawDocument(user, id);
    else {
      const detail = await getDocument(user, id);
      await archiveDocument(user, id, action === "archive");
      if (action === "archive" && detail.status === "draft") return null;
    }
    return getDocument(user, id);
  });
}

export async function countersignAction(id: string, input: { signatureText: string; title?: string }): Promise<Result<DocumentDetail>> {
  const store = await headers();
  return run((user) => countersignDocument(user, id, input, { ip: clientIp(store), userAgent: store.get("user-agent") }));
}

export async function proposalOptionsAction(companyId: string | null): Promise<
  Result<{ templates: Template[]; products: Product[]; contacts: { id: string; name: string; email: string | null; jobTitle: string | null }[] }>
> {
  return run(async (user) => {
    const [templates, products, contacts] = await Promise.all([
      listTemplates(user, { status: "usable" }),
      listProducts(user),
      companyId ? listContacts(user, { companyId, limit: 100 }) : Promise.resolve({ data: [] }),
    ]);
    return {
      templates,
      products,
      contacts: contacts.data.map((contact) => ({ id: contact.id, name: contact.name, email: contact.email, jobTitle: contact.jobTitle })),
    };
  });
}
