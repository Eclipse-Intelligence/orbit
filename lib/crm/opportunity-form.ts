import type { OpportunityStatus, OpportunityWrite } from "@/lib/crm/types";

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function shown(formData: FormData, key: string) {
  return formData.has(key) ? text(formData, key) || null : undefined;
}

function chosenId(formData: FormData, key: string) {
  if (!formData.has(key)) return undefined;
  const value = text(formData, key);
  return value && value !== "none" && value !== "unassigned" ? value : null;
}

export function opportunityWriteFromForm(formData: FormData): OpportunityWrite {
  const editing = Boolean(text(formData, "id"));
  const probability = text(formData, "probability");
  return {
    companyId: formData.has("companyId") ? text(formData, "companyId") : undefined,
    ...(editing ? {} : { pipelineId: chosenId(formData, "pipelineId") ?? null }),
    name: formData.has("name") ? text(formData, "name") : undefined,
    stageId: chosenId(formData, "stageId") ?? undefined,
    primaryContactId: chosenId(formData, "primaryContactId"),
    value: shown(formData, "value"),
    currency: text(formData, "currency") || undefined,
    probability: probability ? Number(probability) : undefined,
    expectedCloseDate: shown(formData, "expectedCloseDate"),
    status: (text(formData, "status") || undefined) as OpportunityStatus | undefined,
    source: shown(formData, "source"),
  };
}
