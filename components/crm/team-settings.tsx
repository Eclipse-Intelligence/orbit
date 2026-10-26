"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import { recordSelectClass } from "@/components/crm/record-form";
import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";
import { inviteAction, removeMemberAction, revokeInviteAction, setRoleAction } from "@/app/(crm)/team";
import { formatDateLabel } from "@/lib/date-input";
import type { Team } from "@/lib/crm/team";
import type { WorkspaceRole } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import CopyButton from "@/components/_ui/copy-button";

const ROLE_LABELS: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const ROLE_TONES = { owner: "purple", admin: "blue", member: "neutral" } as const;

type Sent = { link: string; email: string; sent: boolean; sendError?: string };

export default function TeamSettings({
  team,
  viewerId,
  viewerRole,
  mailboxConnected,
}: {
  team: Team;
  viewerId: string;
  viewerRole: WorkspaceRole;
  mailboxConnected: boolean;
}) {
  const router = useRouter();
  const canManage = viewerRole === "owner" || viewerRole === "admin";
  const isOwner = viewerRole === "owner";
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [send, setSend] = useState(mailboxConnected);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  async function invite() {
    setPending(true);
    setError(null);
    setSent(null);
    const result = await inviteAction({ email, role, send: send && mailboxConnected });
    setPending(false);
    if (result.error || !result.link || !result.email) {
      setError(result.error ?? "Couldn't create the invite.");
      return;
    }
    setSent({ link: result.link, email: result.email, sent: Boolean(result.sent), sendError: result.sendError });
    setEmail("");
    router.refresh();
  }

  async function run(action: () => Promise<{ error?: string }>) {
    setError(null);
    const result = await action();
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }


  return (
    <>
      <SettingsCard
        id="people"
        title="People"
        description="Everyone in this workspace sees and works on the same companies, contacts, deals, boards and activity. Each person connects their own email, calendar and AI account."
      >
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <ul className="flex flex-col">
          {team.members.map((member) => {
            const self = member.id === viewerId;
            const canChangeRole = isOwner && member.role !== "owner";
            const canRemove = canManage && !self && member.role !== "owner" && (member.role !== "admin" || isOwner);
            return (
              <li key={member.id} className="border-border flex flex-wrap items-center gap-3 border-b py-3 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px] leading-5">
                    {member.name}
                    {self && <span className="text-subtle"> (you)</span>}
                  </span>
                  <span className="caption-style text-subtle truncate">
                    {member.email} · Joined {formatDateLabel(member.joinedAt.slice(0, 10))}
                  </span>
                </span>
                {canChangeRole ? (
                  <select
                    aria-label={`${member.name}'s role`}
                    value={member.role}
                    onChange={(event) => void run(() => setRoleAction(member.id, event.target.value))}
                    className={cn(recordSelectClass, "h-8 w-auto")}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <Tag tone={ROLE_TONES[member.role]}>{ROLE_LABELS[member.role]}</Tag>
                )}
                {canRemove && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    onClick={() => setRemoving({ id: member.id, name: member.name })}
                  >
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </SettingsCard>

      {canManage && (
        <SettingsCard
          id="invite"
          title="Invite someone"
          description="They get a link to set their name and password, then sign in to this workspace."
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void invite();
            }}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="email"
                required
                aria-label="Email address"
                placeholder="name@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="flex-1"
              />
              <select
                aria-label="Role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                className={cn(recordSelectClass, "sm:w-36")}
              >
                <option value="member">Member</option>
                {isOwner && <option value="admin">Admin</option>}
              </select>
              <Button variant="primary" size="sm" type="submit" disabled={pending || !email.trim()} className="h-9">
                {pending ? "Inviting…" : "Invite"}
              </Button>
            </div>
            <label className="caption-style text-subtle flex items-center gap-2">
              <Checkbox checked={send && mailboxConnected} disabled={!mailboxConnected} onCheckedChange={(value) => setSend(value === true)} />
              {mailboxConnected ? "Email the invite from my Outlook" : "Connect Microsoft in Capture to email invites from Outlook. Until then, copy the link."}
            </label>
          </form>
          {sent && (
            <div role="status" className="border-line-strong bg-secondary flex flex-col gap-2 rounded-lg border p-3">
              <span className="text-[14px] leading-5">
                {sent.sent ? `Invite sent to ${sent.email}.` : `Invite ready for ${sent.email}. Send them this link:`}
              </span>
              {sent.sendError && <span className="caption-style text-danger">Couldn&apos;t email it: {sent.sendError}</span>}
              <div className="flex items-center gap-2">
                <Input readOnly value={sent.link} aria-label="Invite link" className="flex-1" onFocus={(event) => event.currentTarget.select()} />
                <CopyButton text={sent.link} className="h-9" />
              </div>
            </div>
          )}
          {team.invites.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="caption-style text-subtle">Waiting to join</span>
              <ul className="flex flex-col">
                {team.invites.map((item) => (
                  <li key={item.id} className="border-border flex flex-wrap items-center gap-3 border-b py-2.5 last:border-b-0">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[14px] leading-5">{item.email}</span>
                      <span className="caption-style text-subtle">
                        {ROLE_LABELS[item.role]} · Expires {formatDateLabel(item.expiresAt.slice(0, 10))}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEmail(item.email);
                        setRole(item.role);
                      }}
                    >
                      New link
                    </Button>
                    <Button variant="ghost" size="sm" className="text-danger" onClick={() => void run(() => revokeInviteAction(item.id))}>
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <SettingsDisclosure title="What each role can do" summary="Members, admins and the owner.">
            <ul className="caption-style text-subtle flex list-disc flex-col gap-1.5 pl-4 leading-[1.4]">
              <li>
                Members use everything: companies, contacts, deals, boards, tasks, activity, Mail, Capture, Calendar and the assistant. They
                connect their own Microsoft account, calendars, Granola and AI account.
              </li>
              <li>Members can&apos;t change workspace settings like ClickUp, enrichment and webhooks, or manage people.</li>
              <li>Admins can do everything except make other admins. Only the owner can change roles.</li>
              <li>Nobody can remove or demote the owner.</li>
              <li>Everything logged to a company or contact is visible to everyone. Each person&apos;s inbox and calendar stay private.</li>
              <li>Tasks are private to the person they&apos;re assigned to. The owner and admins can see everyone&apos;s.</li>
            </ul>
          </SettingsDisclosure>
        </SettingsCard>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? "this member"}?`}
        description="Their companies, contacts, deals and tasks move to you, and their email and calendar connections are disconnected. Everything they logged stays."
        confirmLabel="Remove from workspace"
        onConfirm={() => {
          const member = removing;
          if (member) void run(() => removeMemberAction(member.id));
        }}
      />
    </>
  );
}
