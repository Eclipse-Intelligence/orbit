import type { UserActor } from "@/lib/crm/types";
import { listKnowledge } from "@/lib/knowledge/store";

export async function knowledgeOptions(actor: UserActor, companyId: string | null) {
  const [company, eclipse] = await Promise.all([
    companyId ? listKnowledge(actor, { companyId }).catch(() => []) : Promise.resolve([]),
    listKnowledge(actor, { eclipse: true }).catch(() => []),
  ]);
  const usable = (items: typeof eclipse) => items.filter((item) => item.status !== "failed" && !(item.kind === "file" && item.status === "pending"));
  return [
    ...usable(company).map((item) => ({ id: item.id, title: item.title, kind: item.kind, group: item.companyName ?? "Company" })),
    ...usable(eclipse).map((item) => ({ id: item.id, title: item.title, kind: item.kind, group: "Eclipse" })),
  ];
}
