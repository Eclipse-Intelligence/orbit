"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { SettingsCard } from "@/components/crm/settings-ui";
import { saveAgentSendersAction, setUpAgentMailboxAction, type AgentMailboxActionState } from "@/app/(crm)/settings/actions";
import type { AgentMailboxView } from "@/lib/agent-mail/mailbox";
import { formatWhen } from "@/lib/companies";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<string, string> = {
  received: "Received",
  working: "Working",
  replied: "Replied",
  superseded: "Continued in a later email",
  failed: "Failed",
  ignored: "Ignored",
  refused: "Not acted on",
  sent: "Sent",
};

type SenderDraft = { key: number; address: string; userId: string };

function draftsFrom(view: AgentMailboxView): SenderDraft[] {
  return view.senders.map((sender, index) => ({ key: index, address: sender.address, userId: sender.userId }));
}

function Status({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-success" : "bg-faint")} />
      {children}
    </span>
  );
}

export default function AgentMailboxSettings({ view }: { view: AgentMailboxView }) {
  const router = useRouter();
  const [address, setAddress] = useState(view.address);
  const [senders, setSenders] = useState<SenderDraft[]>(() => draftsFrom(view));
  const [nextKey, setNextKey] = useState(view.senders.length);
  const [shown, setShown] = useState(view);
  if (shown !== view) {
    setShown(view);
    setAddress(view.address);
    setSenders(draftsFrom(view));
    setNextKey(view.senders.length);
  }
  const [pending, setPending] = useState<"setup" | "senders" | null>(null);
  const [outcome, setOutcome] = useState<AgentMailboxActionState>({});

  async function run(kind: "setup" | "senders", action: () => Promise<AgentMailboxActionState>) {
    setPending(kind);
    setOutcome({});
    const result = await action();
    setPending(null);
    setOutcome(result);
    router.refresh();
  }

  function update(key: number, patch: Partial<SenderDraft>) {
    setSenders((current) => current.map((sender) => (sender.key === key ? { ...sender, ...patch } : sender)));
  }

  function add() {
    setSenders((current) => [...current, { key: nextKey, address: "", userId: view.members[0]?.id ?? "" }]);
    setNextKey((key) => key + 1);
  }

  const last = view.lastMessage;
  const description = (
    <span className="flex flex-col gap-1.5">
      <span>Email Orbit to give it work. Replies come back in the thread.</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!view.configured ? (
          <Status on={false}>MACHINE_MAIL_API_KEY isn&apos;t set</Status>
        ) : view.setUp ? (
          <Status on>
            <span className="min-w-0 wrap-anywhere">{view.address}</span>
          </Status>
        ) : (
          <Status on={false}>Not set up</Status>
        )}
        {view.setUp && <span>{view.lastReceivedAt ? `Last email ${formatWhen(view.lastReceivedAt)}` : "No email yet"}</span>}
      </span>
      {last && (
        <span className="wrap-anywhere">
          {`${last.from ?? "Unknown sender"}: ${last.subject?.trim() || "(no subject)"} · ${STATUS_LABELS[last.status] ?? last.status}`}
          {last.reason && (last.status === "ignored" || last.status === "refused") ? `. ${last.reason}` : ""}
        </span>
      )}
      {view.lastError && (
        <span className="text-danger" role="alert">
          {view.lastError}
        </span>
      )}
    </span>
  );

  if (!view.canAdmin) {
    return (
      <SettingsCard id="agent-mailbox" title="Agent mailbox" description={description}>
        {view.senders.length > 0 ? (
          <p className="caption-style text-subtle">{`Your work comes from ${view.senders.map((sender) => sender.address).join(", ")}.`}</p>
        ) : (
          <p className="caption-style text-subtle">Only owners and admins can set it up or change who can give it work.</p>
        )}
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      id="agent-mailbox"
      title="Agent mailbox"
      description={description}
      action={
        view.configured && (
          <Button
            variant={view.setUp ? "ghost" : "secondary"}
            size="sm"
            type="button"
            disabled={pending !== null || !address.trim()}
            onClick={() => void run("setup", () => setUpAgentMailboxAction(address))}
          >
            {pending === "setup" ? "Setting up…" : view.setUp ? "Check setup" : "Set up"}
          </Button>
        )
      }
    >
      {outcome.error && (
        <p role="alert" className="caption-style text-danger">
          {outcome.error}
        </p>
      )}
      {outcome.message && (
        <p role="status" className="caption-style text-soft">
          {outcome.message}
        </p>
      )}
      {!view.setUp && (
        <label className="flex flex-col gap-2" htmlFor="agent-mailbox-address">
          <span className="caption-style text-subtle">Address</span>
          <Input
            id="agent-mailbox-address"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={!view.configured}
          />
        </label>
      )}
      {view.setUp ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run("senders", () => saveAgentSendersAction(senders.map(({ address: from, userId }) => ({ address: from, userId }))));
          }}
        >
          <div className="flex flex-col gap-1">
            <h4 className="text-foreground leading-5">Who can give it work</h4>
            <p className="caption-style text-subtle">Mail from these addresses runs as the person beside it. Other mail is kept but never acted on.</p>
          </div>
          {senders.length === 0 && <p className="caption-style text-subtle">Nobody yet.</p>}
          <ul className="flex flex-col gap-4 sm:gap-2">
            {senders.map((sender, index) => (
              <li key={sender.key} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`Sender address ${index + 1}`}
                  placeholder="name@example.com"
                  value={sender.address}
                  onChange={(event) => update(sender.key, { address: event.target.value })}
                  className="min-w-0 sm:flex-1"
                />
                <div className="flex items-center gap-2">
                  <NativeSelect
                    aria-label={`Who owns work from sender ${index + 1}`}
                    value={sender.userId}
                    onChange={(event) => update(sender.key, { userId: event.target.value })}
                    className="min-w-0 flex-1 sm:w-48 sm:flex-none"
                  >
                    {view.members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    aria-label={`Remove sender ${index + 1}`}
                    onClick={() => setSenders((current) => current.filter((entry) => entry.key !== sender.key))}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={add} disabled={pending !== null}>
              Add address
            </Button>
            <Button variant="secondary" size="sm" type="submit" disabled={pending !== null}>
              {pending === "senders" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : (
        <p className="caption-style text-subtle">{`After setup, mail from ${view.defaults.join(" and ")} runs as you. Change it afterwards.`}</p>
      )}
    </SettingsCard>
  );
}
