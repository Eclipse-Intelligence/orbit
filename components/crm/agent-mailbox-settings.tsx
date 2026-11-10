"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { SettingsCard } from "@/components/crm/settings-ui";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import { runHeldAgentMailAction, saveAgentSendersAction, setUpAgentMailboxAction, type AgentMailboxActionState } from "@/app/(crm)/settings/actions";
import type { AgentMailboxView } from "@/lib/agent-mail/mailbox";
import { formatWhen } from "@/lib/companies";
import { cn, GENERIC_ERROR } from "@/lib/utils";

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

const FAILED = new Set(["failed", "ignored", "refused"]);

type SenderDraft = { key: number; address: string; userId: string; problem: string | null };

function draftsFrom(view: AgentMailboxView): SenderDraft[] {
  return view.senders.map((sender, index) => ({ key: index, address: sender.address, userId: sender.userId, problem: sender.problem }));
}

function Status({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-success" : "bg-faint")} />
      {children}
    </span>
  );
}

export default function AgentMailboxSettings({ view, isOwner }: { view: AgentMailboxView; isOwner: boolean }) {
  const router = useRouter();
  const [address, setAddress] = useState(view.address);
  const [senders, setSenders] = useState<SenderDraft[]>(() => draftsFrom(view));
  const [nextKey, setNextKey] = useState(view.senders.length);
  const saved = JSON.stringify([view.address, view.senders.map((sender) => [sender.address, sender.userId])]);
  const [shownSaved, setShownSaved] = useState(saved);
  if (shownSaved !== saved) {
    setShownSaved(saved);
    setAddress(view.address);
    setSenders(draftsFrom(view));
    setNextKey(view.senders.length);
  }
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AgentMailboxActionState>({});

  async function run(kind: string, action: () => Promise<AgentMailboxActionState>) {
    setPending(kind);
    setOutcome({});
    const result = await action().catch((): AgentMailboxActionState => ({ error: GENERIC_ERROR }));
    setPending(null);
    setOutcome(result);
    if (kind !== "senders" || !result.error) router.refresh();
  }

  function update(key: number, patch: Partial<SenderDraft>) {
    setSenders((current) => current.map((sender) => (sender.key === key ? { ...sender, ...patch, problem: null } : sender)));
  }

  function add() {
    setSenders((current) => [...current, { key: nextKey, address: "", userId: view.members[0]?.id ?? "", problem: null }]);
    setNextKey((key) => key + 1);
  }

  const lastHeld = view.lastMessage
    ? view.held.some((item) => item.receivedAt === view.lastMessage?.receivedAt && (item.subject ?? "") === (view.lastMessage?.subject ?? ""))
    : false;
  const last = view.lastMessage && FAILED.has(view.lastMessage.status) && !lastHeld ? view.lastMessage : null;
  const description = (
    <span className="flex flex-col gap-1.5">
      <span>Email Orbit to give it work.</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <WorkspaceTile id={view.workspaceId} name={view.workspaceName} className="size-4 rounded-[5px] text-[9px]" />
          <span className="min-w-0 wrap-anywhere">{`For ${view.workspaceName}`}</span>
        </span>
        {!view.configured ? (
          <Status on={false}>{isOwner ? "MACHINE_MAIL_API_KEY isn't set" : "Not set up"}</Status>
        ) : view.setUp ? (
          <Status on>
            <span className="min-w-0 wrap-anywhere">{view.address}</span>
          </Status>
        ) : (
          <Status on={false}>Not set up</Status>
        )}
        {view.setUp && <span>{view.lastReceivedAt ? `Last email ${formatWhen(view.lastReceivedAt)}` : "No email yet"}</span>}
      </span>
      {view.lastError && (
        <span className="text-danger" role="alert">
          {view.lastError}
        </span>
      )}
    </span>
  );

  const lastFailure = last ? (
    <p className="caption-style text-subtle wrap-anywhere">
      {`${last.from ?? "Unknown sender"}: ${last.subject?.trim() || "(no subject)"} · ${STATUS_LABELS[last.status] ?? last.status}`}
      {last.reason ? `. ${last.reason}` : ""}
    </p>
  ) : null;

  const held =
    view.held.length > 0 ? (
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <h4 className="text-foreground leading-5">Held by MachineMail</h4>
          <p className="caption-style text-subtle">Filtered by MachineMail. Run one only if you sent it.</p>
        </div>
        <ul className="flex flex-col gap-2">
          {view.held.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="caption-style text-soft min-w-0 wrap-anywhere">
                {`${item.subject?.trim() || "(no subject)"} · ${formatWhen(item.receivedAt)}`}
                {item.reason ? `. ${item.reason}` : ""}
              </span>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                className="self-start sm:self-auto"
                disabled={pending !== null}
                onClick={() => void run(`held:${item.id}`, () => runHeldAgentMailAction(item.id))}
              >
                {pending === `held:${item.id}` ? "Starting…" : "Run anyway"}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  if (!view.canAdmin) {
    return (
      <SettingsCard id="agent-mailbox" title="Agent mailbox" description={description}>
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
        {lastFailure}
        {held}
        {view.senders.length > 0 ? (
          <p className="caption-style text-subtle">{`Mail from ${view.senders.map((sender) => sender.address).join(", ")} runs as you.`}</p>
        ) : (
          <p className="caption-style text-subtle">Only owners and admins can change this.</p>
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
      {lastFailure}
      {held}
      {!view.setUp && (
        <label className="flex flex-col gap-2" htmlFor="agent-mailbox-address">
          <span className="caption-style text-subtle">Address</span>
          <Input
            id="agent-mailbox-address"
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder={view.placeholder}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={!view.configured}
          />
        </label>
      )}
      {view.setUp && (
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
              <li key={sender.key} className="flex flex-col gap-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    type="text"
                    inputMode="email"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`Sender address ${index + 1}`}
                    aria-invalid={sender.problem ? true : undefined}
                    aria-describedby={sender.problem ? `agent-sender-problem-${sender.key}` : undefined}
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
                </div>
                {sender.problem && (
                  <p id={`agent-sender-problem-${sender.key}`} className="caption-style text-danger">
                    {sender.problem}
                  </p>
                )}
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
      )}
      {!view.setUp && <p className="caption-style text-subtle">After setup, mail from your own addresses runs as you.</p>}
    </SettingsCard>
  );
}
