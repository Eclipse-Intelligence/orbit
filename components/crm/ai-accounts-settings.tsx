"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { SettingsCard } from "@/components/crm/settings-ui";
import {
  createPairingCodeAction,
  disconnectAiAccountAction,
  listCompanionsAction,
  pollChatGptAction,
  revokeCompanionAction,
  startChatGptAction,
} from "@/app/(crm)/settings/ai-accounts";
import type { AiAccountSummary } from "@/lib/ai-accounts/store";
import type { CompanionSummary } from "@/lib/companion/pairing";
import { formatWhen } from "@/lib/companies";
import { cn } from "@/lib/utils";

const PRODUCTION_URL = "https://orbit.geteclipse.co";
const PAIR_POLL_MS = 3_000;

function Status({ on, children }: { on: boolean; children: string }) {
  return (
    <span className="caption-style text-subtle flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-success" : "bg-faint")} />
      {children}
    </span>
  );
}

function Row({
  title,
  status,
  on,
  detail,
  action,
  children,
}: {
  title: string;
  status: string;
  on: boolean;
  detail: string;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-foreground text-[14px] leading-5 font-medium">{title}</span>
          <Status on={on}>{status}</Status>
          <span className="caption-style text-subtle">{detail}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      </div>
      {children}
    </div>
  );
}

function ChatGptRow({ account }: { account: AiAccountSummary }) {
  const router = useRouter();
  const [code, setCode] = useState<{ userCode: string; url: string; intervalMs: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const live = useRef(0);

  useEffect(() => {
    if (!code) return;
    const run = ++live.current;
    let timer = 0;
    const tick = async () => {
      const result = await pollChatGptAction().catch(() => ({ status: "pending" as const }));
      if (run !== live.current) return;
      if (result.status === "connected") {
        setCode(null);
        router.refresh();
        return;
      }
      if (result.status === "failed") {
        setCode(null);
        setError("error" in result && result.error ? result.error : "ChatGPT sign-in failed.");
        return;
      }
      timer = window.setTimeout(tick, code.intervalMs);
    };
    timer = window.setTimeout(tick, code.intervalMs);
    return () => {
      live.current += 1;
      window.clearTimeout(timer);
    };
  }, [code, router]);

  async function start() {
    setBusy(true);
    setError(null);
    const result = await startChatGptAction();
    setBusy(false);
    if ("error" in result) setError(result.error);
    else setCode(result);
  }

  async function disconnect() {
    setBusy(true);
    const result = await disconnectAiAccountAction("chatgpt");
    setBusy(false);
    if (result.error) setError(result.error);
    else router.refresh();
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <Row
      title="ChatGPT"
      on={account.connected}
      status={account.connected ? `Connected${account.label ? ` as ${account.label}` : ""}` : "Not connected"}
      detail="GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Astra and GPT-6 Luna on your ChatGPT plan"
      action={
        code ? (
          <Button variant="ghost" size="sm" onClick={() => setCode(null)}>
            Cancel
          </Button>
        ) : account.connected ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={disconnect}>
            Disconnect
          </Button>
        ) : (
          <Button variant="primary" size="sm" disabled={busy} onClick={start}>
            Connect
          </Button>
        )
      }
    >
      {code && (
        <div className="flex flex-col gap-3 rounded-lg bg-white/[0.03] p-3.5">
          <p className="caption-style text-subtle leading-[1.4]">
            Open the ChatGPT sign-in page, sign in, and enter this code. This page connects by itself once you approve it.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={copy}
              className="text-foreground rounded-lg bg-white/[0.06] px-3 py-1.5 font-mono text-[16px] tracking-[0.12em] transition-colors duration-150 hover:bg-white/[0.1]"
              aria-label={`Copy code ${code.userCode}`}
            >
              {code.userCode}
            </button>
            <span className="caption-style text-subtle">{copied ? "Copied" : "Copy"}</span>
          </div>
          <div className="flex items-center gap-3">
            <a href={code.url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "primary", size: "sm" })}>
              Open ChatGPT sign-in
            </a>
            <span className="caption-style text-subtle">Waiting for approval…</span>
          </div>
        </div>
      )}
      {account.lastError && account.connected && <p className="caption-style text-danger leading-[1.4]">{account.lastError}</p>}
      {error && <p className="caption-style text-danger leading-[1.4]">{error}</p>}
    </Row>
  );
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="flex items-start gap-2 rounded-lg bg-black/30 p-2.5">
      <code className="text-soft min-w-0 flex-1 font-mono text-[12.5px] leading-5 break-all">{text}</code>
      <Button variant="secondary" size="sm" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function agentCommand(origin: string, code?: string) {
  const base = `npx -y --package=${origin}/downloads/orbit-agent.tgz orbit-agent`;
  const pair = code ? ` --pair ${code}` : "";
  return `${base}${pair}${origin === PRODUCTION_URL ? "" : ` --url ${origin}`} --install`;
}

function AgentRow({ companions }: { companions: CompanionSummary[] }) {
  const router = useRouter();
  const [pairing, setPairing] = useState<{ code: string; origin: string; known: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState(PRODUCTION_URL);
  const online = companions.find((companion) => companion.online);

  useEffect(() => {
    if (!pairing) return;
    let live = true;
    const timer = window.setInterval(async () => {
      const latest = await listCompanionsAction().catch(() => null);
      if (!live || !latest) return;
      if (latest.length > pairing.known) {
        setPairing(null);
        router.refresh();
      }
    }, PAIR_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [pairing, router]);

  useEffect(() => {
    if (!online) {
      const timer = window.setInterval(() => router.refresh(), 15_000);
      return () => window.clearInterval(timer);
    }
  }, [online, router]);

  async function start() {
    setBusy(true);
    setError(null);
    const result = await createPairingCodeAction();
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setOrigin(window.location.origin);
    setPairing({ code: result.code, origin: window.location.origin, known: companions.length });
  }

  async function remove(id: string) {
    setBusy(true);
    const result = await revokeCompanionAction(id);
    setBusy(false);
    if (result.error) setError(result.error);
    else router.refresh();
  }

  return (
    <Row
      title="Claude"
      on={Boolean(online)}
      status={
        online
          ? `Orbit Agent running on ${online.name}`
          : companions.length > 0
            ? "Orbit Agent paired, not running"
            : "Not connected"
      }
      detail="Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 through Claude Code on your Mac, on your Claude plan"
      action={
        pairing ? (
          <Button variant="ghost" size="sm" onClick={() => setPairing(null)}>
            Cancel
          </Button>
        ) : (
          <Button variant={companions.length > 0 ? "secondary" : "primary"} size="sm" disabled={busy} onClick={start}>
            Pair a Mac
          </Button>
        )
      }
    >
      {pairing && (
        <ol className="flex flex-col gap-3 rounded-lg bg-white/[0.03] p-3.5">
          <li className="caption-style text-subtle leading-[1.4]">
            1. Make sure Claude Code is installed and signed in on your Mac. Run <code className="text-soft font-mono">claude</code>, then{" "}
            <code className="text-soft font-mono">/login</code> if it asks.
          </li>
          <li className="flex flex-col gap-2">
            <span className="caption-style text-subtle leading-[1.4]">2. In Terminal, run:</span>
            <CopyLine text={agentCommand(pairing.origin, pairing.code)} />
          </li>
          <li className="caption-style text-subtle leading-[1.4]">
            3. That&apos;s it: Orbit Agent now runs in the background, starts when you log in and restarts if it stops, so you can close Terminal. This page updates when your Mac connects. The code works for 10 minutes.
          </li>
        </ol>
      )}
      {companions.length > 0 && (
        <ul className="flex flex-col gap-2">
          {companions.map((companion) => (
            <li key={companion.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-foreground truncate text-[13px] leading-5">{companion.name}</span>
                <Status on={companion.online}>
                  {companion.online ? "Running" : companion.lastSeenAt ? `Last seen ${formatWhen(companion.lastSeenAt)}` : "Not seen yet"}
                </Status>
              </div>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(companion.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {companions.length > 0 && !online && !pairing && (
        <div className="flex flex-col gap-2">
          <span className="caption-style text-subtle leading-[1.4]">
            To start it and keep it running (it will then start by itself whenever you log in), run this once in Terminal on your Mac:
          </span>
          <CopyLine text={agentCommand(origin)} />
        </div>
      )}
      {error && <p className="caption-style text-danger leading-[1.4]">{error}</p>}
    </Row>
  );
}

export default function AiAccountsSettings({ accounts, companions }: { accounts: AiAccountSummary[]; companions: CompanionSummary[] }) {
  const chatgpt = accounts.find((account) => account.provider === "chatgpt");
  return (
    <SettingsCard
      id="ai-accounts"
      title="AI accounts"
      description="Use your own Claude or ChatGPT plan in the assistant. Models from a connected account appear in the assistant's model picker, and usage counts against that plan."
    >
      <div className="flex flex-col gap-5">
        <AgentRow companions={companions} />
        {chatgpt && <ChatGptRow account={chatgpt} />}
      </div>
    </SettingsCard>
  );
}
