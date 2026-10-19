import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import WorkflowEditor from "@/components/workflows/workflow-editor";
import { getUserActor } from "@/lib/auth/user";
import { getBoard, listBoards } from "@/lib/crm/boards";
import { listCompanies, listMembers } from "@/lib/crm/companies";
import { listContacts } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { listPipeline } from "@/lib/crm/opportunities";
import { getWorkflow, listRuns } from "@/lib/workflows/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const load = cache(async (id: string) => {
  const user = await getUserActor();
  if (!user) return { user: null, workflow: null };
  const workflow = await getWorkflow(user, id).catch((error: unknown) => {
    if (error instanceof CrmError && error.code === "not_found") return null;
    throw error;
  });
  return { user, workflow };
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { workflow } = await load(id);
  return { title: workflow?.name ?? "Workflow not found" };
}

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { user, workflow } = await load(id);
  if (!user) redirect("/login");
  if (!workflow) notFound();
  const query = await searchParams;
  const [runs, boards, pipeline, members, companies, contacts] = await Promise.all([
    workflow.mine ? listRuns(user, workflow.id) : Promise.resolve([]),
    listBoards(user),
    listPipeline(user),
    listMembers(user),
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    listContacts(user, { limit: 100 }),
  ]);
  const fullBoards = await Promise.all(boards.map((board) => getBoard(user, board.id)));
  return (
    <WorkflowEditor
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      workflow={workflow}
      runs={runs}
      options={{
        boards: fullBoards.map((board) => ({ id: board.id, name: board.name, stages: board.stages.map((stage) => ({ id: stage.id, name: stage.name })) })),
        salesStages: pipeline.stages.map((stage) => ({ id: stage.id, name: stage.name })),
        members: members.filter((member) => member.id !== user.userId).map((member) => ({ id: member.id, name: member.name })),
      }}
      records={{
        companies: companies.data.map((company) => ({ id: company.id, name: company.name })),
        contacts: contacts.data.map((contact) => ({ id: contact.id, name: contact.name })),
      }}
      initialRun={typeof query.run === "string" ? query.run : null}
    />
  );
}
