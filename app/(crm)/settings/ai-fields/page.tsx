import { redirect } from "next/navigation";
import AiFieldsSettings from "@/components/ai-fields/ai-fields-settings";
import { getUserActor } from "@/lib/auth/user";
import { aiFieldStats, listAiFields, publicField, spendThisMonth } from "@/lib/ai-fields/fields";
import { listCompanyViews } from "@/lib/crm/company-views";
import { listTags } from "@/lib/crm/tags";
import { getEnrichmentSettings } from "@/lib/enrichment/settings";
import { listWebChecks, webChecksConfigured } from "@/lib/enrichment/web-checks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function AiFieldsSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const fields = await listAiFields(user);
  const [stats, spend, views, rules, enrichment, tags] = await Promise.all([
    aiFieldStats(user, fields),
    spendThisMonth(user),
    listCompanyViews(user),
    listWebChecks(user, "tag"),
    getEnrichmentSettings(user),
    listTags(user).catch(() => []),
  ]);
  return (
    <AiFieldsSettings
      fields={fields.map(publicField)}
      stats={stats}
      spend={spend.amount}
      views={views}
      rules={rules.map((rule) => ({ id: rule.id, label: rule.label, question: rule.question, tagged: tags.find((tag) => tag.name === rule.label)?.companies ?? 0 }))}
      fit={enrichment.webIcp}
      configured={webChecksConfigured()}
      canAdmin={user.role === "owner" || user.role === "admin"}
    />
  );
}
