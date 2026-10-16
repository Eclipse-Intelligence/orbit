"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { SettingsCard } from "@/components/crm/settings-ui";
import {
  disconnectAiAccountAction,
  finishClaudeAction,
  pollChatGptAction,
  startChatGptAction,
  startClaudeAction,
} from "@/app/(crm)/settings/ai-accounts";
import type { AiAccountSummary } from "@/lib/ai-accounts/store";
import { cn } from "@/lib/utils";

const MODELS: Record<AiAccountSummary["provider"], string> = {
  claude: "Opus 5.5, Sonnet 5.5 and Haiku 5.5",
  chatgpt: "GPT-6.1 Sol, GPT-6 Astra and GPT-6 Luna",
};

function Status({ on, children }: { on: boolean; children: string }) {
  return (
    <span className="caption-style text-subtle flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-success" : "bg-faint")} />
      {children}
    </span>
  );
}

function Row({ account, children, action }: { account: AiAccountSummary; children?: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-foreground text-[14px] leading-5 font-medium">{account.name}</span>
          <Status on={account.connected}>{account.connected ? `Connected${account.label ? ` as ${account.label}` : ""}` : "Not connected"}</Status>
          <span className="caption-style text-subtle">{MODELS[account.provider]}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      </div>
      {account.lastError && account.connected && <p className="caption-style text-danger leading-[1.4]">{account.lastError}</p>}
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
      account={account}
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
      {error && <p className="caption-style text-danger leading-[1.4]">{error}</p>}
    </Row>
  );
}

function ClaudeRow({ account }: { account: AiAccountSummary }) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const result = await startClaudeAction();
    setBusy(false);
    if ("error" in result) setError(result.error);
    else setUrl(result.url);
  }

  async function finish(event: FormEvent) {
    event.preventDefault();
    if (!pasted.trim()) return;
    setBusy(true);
    setError(null);
    const result = await finishClaudeAction(pasted);
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setUrl(null);
    setPasted("");
    router.refresh();
  }

  async function disconnect() {
    setBusy(true);
    const result = await disconnectAiAccountAction("claude");
    setBusy(false);
    if (result.error) setError(result.error);
    else router.refresh();
  }

  return (
    <Row
      account={account}
      action={
        url ? (
          <Button variant="ghost" size="sm" onClick={() => setUrl(null)}>
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
      {url && (
        <form onSubmit={finish} className="flex flex-col gap-3 rounded-lg bg-white/[0.03] p-3.5">
          <p className="caption-style text-subtle leading-[1.4]">
            Sign in to Claude and approve access. Claude then shows a code. Copy it and paste it here.
          </p>
          <div>
            <a href={url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "primary", size: "sm" })}>
              Open Claude sign-in
            </a>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="Paste the code from Claude"
              autoComplete="off"
              spellCheck={false}
              aria-label="Code from Claude"
            />
            <Button variant="secondary" size="md" type="submit" disabled={busy || !pasted.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </form>
      )}
      {error && <p className="caption-style text-danger leading-[1.4]">{error}</p>}
    </Row>
  );
}

export default function AiAccountsSettings({ accounts }: { accounts: AiAccountSummary[] }) {
  return (
    <SettingsCard
      id="ai-accounts"
      title="AI accounts"
      description="Use your own Claude or ChatGPT plan in the assistant. Models from a connected account appear in the assistant's model picker, and usage counts against that plan."
    >
      <div className="flex flex-col gap-5">
        {accounts.map((account) =>
          account.provider === "chatgpt" ? (
            <ChatGptRow key={account.provider} account={account} />
          ) : (
            <ClaudeRow key={account.provider} account={account} />
          ),
        )}
      </div>
    </SettingsCard>
  );
}
