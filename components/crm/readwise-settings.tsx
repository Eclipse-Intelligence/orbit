"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { removeReadwiseTokenAction, saveReadwiseTokenAction, setReadwiseWorkspaceAction, syncReadwiseAction } from "@/app/(crm)/settings/actions";
import { cn, GENERIC_ERROR } from "@/lib/utils";

export function ReadwiseSync({ lastError, children }: { lastError: string | null; children: ReactNode }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);

  async function sync() {
    setPending(true);
    setNote(null);
    const result = await syncReadwiseAction().catch(() => ({ error: GENERIC_ERROR, message: undefined }));
    setPending(false);
    setNote(result.error ? { error: true, text: result.error } : result.message ? { error: false, text: result.message } : null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => void sync()}>
          {pending ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      {note && !(note.error && note.text === lastError) && (
        <p role={note.error ? "alert" : "status"} className={cn("caption-style leading-[1.4]", note.error ? "text-danger" : "text-subtle")}>
          {note.text}
        </p>
      )}
    </div>
  );
}

export function ReadwiseWorkspace({ current, workspaces }: { current: string; workspaces: { id: string; name: string }[] }) {
  const router = useRouter();
  const [chosen, setChosen] = useState(current);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);

  async function choose(workspaceId: string) {
    const previous = chosen;
    setChosen(workspaceId);
    setPending(true);
    setNote(null);
    const result = await setReadwiseWorkspaceAction(workspaceId).catch(() => ({ error: GENERIC_ERROR }));
    setPending(false);
    if (result.error) {
      setChosen(previous);
      setNote({ error: true, text: result.error });
      return;
    }
    const name = workspaces.find((item) => item.id === workspaceId)?.name ?? "that workspace";
    setNote({ error: false, text: `New documents go to Knowledge in ${name} from the next sync. Items already in Knowledge stay where they are.` });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="readwise-workspace" className="caption-style text-subtle shrink-0">
          Add to Knowledge in
        </label>
        <NativeSelect
          id="readwise-workspace"
          value={chosen}
          disabled={pending}
          onChange={(event) => void choose(event.target.value)}
          className="w-auto min-w-[11rem] max-sm:min-w-0 max-sm:flex-1"
        >
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <p role={note?.error ? "alert" : "status"} className={cn("caption-style leading-[1.4]", note?.error ? "text-danger" : "text-subtle", !note && "sr-only")}>
        {note?.text}
      </p>
    </div>
  );
}

export function ReadwiseToken({ connected, hint }: { connected: boolean; hint: string | null }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ error?: string }>) {
    setPending(true);
    setError(null);
    const result = await action().catch(() => ({ error: GENERIC_ERROR }));
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setToken("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {connected ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[14px] leading-5">Your Reader is connected{hint ? ` · token ending ${hint}` : ""}</span>
          <HoldButton tone="neutral" disabled={pending} onConfirm={() => void run(removeReadwiseTokenAction)}>
            Hold to disconnect
          </HoldButton>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => saveReadwiseTokenAction(token));
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label="Your Readwise access token"
            placeholder="Your Readwise access token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="sm:flex-1"
          />
          <Button variant="secondary" size="sm" type="submit" className="h-9" disabled={pending || !token.trim()}>
            {pending ? "Checking…" : "Connect"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <p className="caption-style text-subtle leading-[1.4]">
        Each person connects their own Reader. Get your token at{" "}
        <a
          href="https://readwise.io/access_token"
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: "link", size: "none" }), "caption-style")}
        >
          readwise.io/access_token
        </a>
        . Only you can see it.
      </p>
    </div>
  );
}
