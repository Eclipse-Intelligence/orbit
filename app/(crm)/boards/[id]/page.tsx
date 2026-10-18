import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import OpportunitiesScreen from "@/components/crm/opportunities-screen";
import { PAGE_SIZE, pageFromParams, pageOffset } from "@/components/crm/paging";
import { getUserActor } from "@/lib/auth/user";
import { getBoard } from "@/lib/crm/boards";
import { listCompanies } from "@/lib/crm/companies";
import { listContacts } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { listOpportunities } from "@/lib/crm/opportunities";
import { opportunityQueryFromSearchParams } from "@/lib/crm/validation";

export const dynamic = "force-dynamic";

const loadBoard = cache(async (id: string) => {
  const user = await getUserActor();
  if (!user) return { user: null, board: null };
  const board = await getBoard(user, id).catch((error: unknown) => {
    if (error instanceof CrmError && error.code === "not_found") return null;
    throw error;
  });
  return { user, board };
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { board } = await loadBoard(id);
  return { title: board?.name ?? "Board not found" };
}

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { user, board } = await loadBoard(id);
  if (!user) redirect("/login");
  if (!board) notFound();
  const resolved = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "string") query.set(key, value);
  }
  const filters = opportunityQueryFromSearchParams(query);
  const page = pageFromParams(query);
  filters.pipelineId = board.id;
  filters.limit = PAGE_SIZE;
  filters.offset = pageOffset(page);
  const [listed, companies, contacts] = await Promise.all([
    listOpportunities(user, filters),
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    listContacts(user, { limit: 100 }),
  ]);

  return (
    <OpportunitiesScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      opportunities={listed.data}
      total={listed.total}
      page={page}
      query={filters.query ?? ""}
      companies={companies.data}
      contacts={contacts.data}
      stages={board.stages}
      view={query.get("view") === "list" ? "list" : "board"}
      board={board}
    />
  );
}
