import { redirect } from "next/navigation";
import AiFieldsSettings from "@/components/ai-fields/ai-fields-settings";
import WebChecksSettings, { type RuleColumn } from "@/components/crm/web-checks-settings";
import { getUserActor } from "@/lib/auth/user";
import { aiFieldStats, listAiFields, publicField, spendThisMonth } from "@/lib/ai-fields/fields";
import { listCompanyViews } from "@/lib/crm/company-views";
import { listTags } from "@/lib/crm/tags";
import { getEnrichmentSettings } from "@/lib/enrichment/settings";
import { listWebChecks, uncheckedCompanyCount, webChecksConfigured } from "@/lib/enrichment/web-checks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function AiFieldsSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const fields = await listAiFields(user);
  const [stats, spend, views, checks, enrichment, tags, unchecked] = await Promise.all([
    aiFieldStats(user, fields),
    spendThisMonth(user),
    listCompanyViews(user),
    listWebChecks(user),
    getEnrichmentSettings(user),
    listTags(user).catch(() => []),
    uncheckedCompanyCount(user),
  ]);
  const canAdmin = user.role === "owner" || user.role === "admin";
  const columns: Record<string, RuleColumn> = Object.fromEntries(
    checks
      .filter((check) => check.kind === "tag")
      .map((rule) => [
        rule.id,
        { tagged: tags.find((tag) => tag.name === rule.label)?.companies ?? 0, shown: fields.some((field) => field.webCheckId === rule.id) },
      ]),
  );
  return (
    <AiFieldsSettings fields={fields.map(publicField)} stats={stats} spend={spend.amount} views={views} configured={webChecksConfigured()} canAdmin={canAdmin}>
      <WebChecksSettings settings={enrichment} checks={checks} configured={webChecksConfigured()} canAdmin={canAdmin} unchecked={unchecked} columns={columns} />
    </AiFieldsSettings>
  );
}
