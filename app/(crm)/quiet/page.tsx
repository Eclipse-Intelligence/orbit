import { redirect } from "next/navigation";
import Button from "@/components/_ui/button";
import { ConnectionMark, Monogram } from "@/components/beautifui/record-marks";
import SectionHeader from "@/components/crm/section-header";
import { RecordList, RecordRow } from "@/components/crm/record-form";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import { getUserActor } from "@/lib/auth/user";
import { relativeWhen } from "@/lib/companies";
import { companyHref } from "@/lib/crm/hrefs";
import { findStaleRelationships } from "@/lib/crm/relationships";

export const dynamic = "force-dynamic";

export default async function QuietPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const rows = await findStaleRelationships(user, 21, 100);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Quiet"
        viewer={{
          id: user.userId,
          name: user.fullName || user.email,
          email: user.email,
          role: user.role,
          workspaceName: user.workspaceName,
        }}
      />
      <p className="caption-style text-subtle px-4 py-4">
        Companies with no interaction in the last 21 days.
      </p>
      <KeyboardList sequence className="flex min-h-0 flex-1 flex-col">
      <RecordList count={rows.length} empty="Every company has been in touch recently.">
        {rows.map((row) => (
          <RecordRow
            key={row.company.id}
            mark={<Monogram name={row.company.name} />}
            title={row.company.name}
            meta={`${relativeWhen(row.lastActivityAt)} · ${row.openTaskCount} open task${row.openTaskCount === 1 ? "" : "s"}`}
            action={
              <span className="flex items-center gap-3">
                <ConnectionMark at={row.lastActivityAt} />
                <Button variant="ghost" size="sm" href={companyHref(row.company.id)}>
                  Open
                </Button>
              </span>
            }
          />
        ))}
      </RecordList>
      </KeyboardList>
    </section>
  );
}
