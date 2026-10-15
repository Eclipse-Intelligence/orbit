import { SettingsCard } from "@/components/crm/settings-ui";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export default function AccountSettings({
  name,
  email,
  role,
  workspaceName,
}: {
  name: string;
  email: string;
  role: string;
  workspaceName: string;
}) {
  const rows = [
    { label: "Name", value: name },
    { label: "Sign-in email", value: email },
    { label: "Workspace", value: workspaceName },
    { label: "Role", value: ROLE_LABELS[role] ?? role },
  ];
  return (
    <SettingsCard
      id="account"
      title="Account"
      description="Who you are signed in as. Sign out from Account at the bottom of the sidebar."
    >
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div
            key={row.label}
            className="border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b py-2 first:pt-0 last:border-b-0 last:pb-0"
          >
            <dt className="caption-style text-subtle">{row.label}</dt>
            <dd className="min-w-0 truncate text-[14px] leading-5">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </SettingsCard>
  );
}
