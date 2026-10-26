"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import InlineField from "@/components/crm/inline-field";
import { Detail, DetailList } from "@/components/crm/record-form";
import { SettingsCard } from "@/components/crm/settings-ui";
import { changePasswordAction, signOutAction, updateNameAction } from "@/app/(crm)/actions";

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
  passwords,
}: {
  name: string;
  email: string;
  role: string;
  workspaceName: string;
  passwords: boolean;
}) {
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "status" | "alert" } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const result = await changePasswordAction(String(form.get("password") ?? ""), String(form.get("confirm") ?? ""));
    setPending(false);
    if (result.error) {
      setMessage({ text: result.error, tone: "alert" });
      return;
    }
    setChanging(false);
    setMessage({ text: "Password changed.", tone: "status" });
  }

  return (
    <SettingsCard
      id="account"
      title="Account"
      description="Who you're signed in as."
      action={
        <form action={signOutAction}>
          <Button variant="secondary" size="sm" type="submit">
            Sign out
          </Button>
        </form>
      }
    >
      <DetailList>
        <InlineField
          label="Name"
          value={name}
          onSave={async (value) => {
            const result = await updateNameAction(value);
            if (result.error) return result.error;
            router.refresh();
            return null;
          }}
        />
        <Detail label="Email">{email}</Detail>
        <Detail label="Workspace">{workspaceName}</Detail>
        <Detail label="Role">{ROLE_LABELS[role] ?? role}</Detail>
      </DetailList>
      {passwords &&
        (changing ? (
          <form onSubmit={submit} className="flex flex-col gap-3 pt-2">
            <label className="flex flex-col gap-1.5">
              <span className="caption-style text-soft">New password</span>
              <Input name="password" type="password" autoComplete="new-password" minLength={8} required />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="caption-style text-soft">Repeat it</span>
              <Input name="confirm" type="password" autoComplete="new-password" minLength={8} required />
            </label>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" type="submit" disabled={pending}>
                {pending ? "Saving…" : "Change password"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button variant="secondary" size="sm" onClick={() => { setMessage(null); setChanging(true); }}>
              Change password
            </Button>
          </div>
        ))}
      {message && (
        <p role={message.tone} className={message.tone === "alert" ? "caption-style text-danger" : "caption-style text-success"}>
          {message.text}
        </p>
      )}
    </SettingsCard>
  );
}
