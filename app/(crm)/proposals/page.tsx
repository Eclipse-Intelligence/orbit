import { redirect } from "next/navigation";
import ProposalsScreen from "@/components/proposals/proposals-screen";
import { getUserActor } from "@/lib/auth/user";
import { listProducts, listTemplates } from "@/lib/proposals/catalogue";
import { listDocuments } from "@/lib/proposals/documents";

export const dynamic = "force-dynamic";

export const metadata = { title: "Proposals" };

export default async function ProposalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const params = await searchParams;
  const tab = params.tab === "templates" || params.tab === "products" ? params.tab : "proposals";
  const [documents, templates, archived, products] = await Promise.all([
    tab === "proposals" ? listDocuments(user) : Promise.resolve([]),
    tab === "templates" ? listTemplates(user) : Promise.resolve([]),
    tab === "templates" ? listTemplates(user, { status: "archived" }) : Promise.resolve([]),
    tab === "products" ? listProducts(user, { includeArchived: true }) : Promise.resolve([]),
  ]);
  return (
    <ProposalsScreen
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName }}
      tab={tab}
      documents={documents}
      templates={[...templates, ...archived]}
      products={products}
    />
  );
}
