"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import { SettingsCard } from "@/components/crm/settings-ui";
import {
  addMemoryAction,
  addWatchAction,
  connectGrokAction,
  deleteMarketNoteAction,
  forgetMemoryAction,
  learnNowAction,
  removeWatchAction,
  updateMemoryAction,
} from "@/app/(crm)/settings/learning/actions";
import type { MarketAgentStatus } from "@/lib/learning/grok";
import type { MarketNote, WatchItem, WatchKind } from "@/lib/learning/market";
import type { Memory, MemoryScope } from "@/lib/learning/memories";
import type { LearningKind, LearningStatus } from "@/lib/learning/nightly";
import { cn } from "@/lib/utils";

const AREA =
  "border-line-strong bg-secondary text-foreground placeholder:text-subtle focus-visible:border-ring w-full resize-y rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none transition-[border-color] duration-150 ease-power3-out";
const SELECT =
  "border-line-strong bg-secondary text-foreground focus-visible:border-ring h-9 w-full rounded-lg border px-2.5 text-[14px] outline-none transition-[border-color] duration-150 ease-power3-out";

const SCOPE_LABELS: Record<MemoryScope, string> = { personal: "You", business: "Business", market: "Market" };
const SCOPE_HINTS: Record<MemoryScope, string> = {
  personal: "Private to you: your preferences, corrections and how you work, learned from your conversations, decisions and draft edits.",
  business: "Shared with your workspace: customers, ICP, objections, competitors and what works, learned from deals, calls and replies.",
  market: "Shared with your workspace: themes, competitor moves and buying signals, learned from the market notes Grok Bot sends.",
};
const KIND_LABELS: Record<LearningKind, string> = { personal: "About you", business: "Business", market: "Market", brief: "Morning brief" };
const WATCH_LABELS: Record<WatchKind, string> = { topic: "Topic", competitor: "Competitor", person: "Person", account: "Target account", source: "Source" };

function when(iso: string | null) {
  if (!iso) return "never";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(new Date(iso));
}

function day(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(new Date(iso));
}

function summaryText(status: LearningStatus) {
  if (status.status === "failed") return `Failed: ${status.error ?? "unknown error"}`;
  if (status.status === "running") return "Running now";
  const summary = status.summary;
  if (!summary) return "Done";
  if (summary.skipped) return summary.skipped;
  if (summary.brief) return "Brief written";
  const parts = [summary.added ? `${summary.added} new` : "", summary.updated ? `${summary.updated} updated` : "", summary.archived ? `${summary.archived} retired` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing changed";
}

export function LearningStatusCard({ statuses, canRunShared }: { statuses: LearningStatus[]; canRunShared: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kinds: LearningKind[] = canRunShared ? ["business", "market", "personal", "brief"] : ["personal", "brief"];
  const byKind = new Map(statuses.map((status) => [status.kind, status]));

  async function run() {
    setPending(true);
    setError(null);
    setMessage("Learning from today. This can take a couple of minutes.");
    const result = await learnNowAction();
    setPending(false);
    if (result.error || !result.result) {
      setMessage(null);
      setError(result.error ?? "Learning didn't finish.");
      return;
    }
    const failed = Object.entries(result.result)
      .filter(([, value]) => value?.error)
      .map(([kind]) => KIND_LABELS[kind as LearningKind].toLowerCase());
    const named = failed.length > 1 ? `${failed.slice(0, -1).join(", ")} and ${failed.at(-1)}` : failed[0];
    setMessage(failed.length ? `Finished, but ${named} failed. See above.` : "Done. The assistant uses it from your next message.");
    router.refresh();
  }

  return (
    <SettingsCard
      id="learning"
      title="How Orbit learns"
      description="Every night Orbit reads what happened that day and keeps short notes the assistant carries into every conversation: about you, about the business, and about the market. You can see, edit and forget everything below."
    >
      <div className="flex flex-col gap-4">
        <ul className="divide-sidebar-border flex flex-col divide-y">
          {kinds.map((kind) => {
            const status = byKind.get(kind);
            return (
              <li key={kind} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-[14px]">
                <span className="text-foreground">{KIND_LABELS[kind]}</span>
                <span className={cn("caption-style", status?.status === "failed" ? "text-danger" : "text-subtle")}>
                  {status ? `${summaryText(status)}, ${when(status.finishedAt)}` : "Not run yet"}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => void run()}>
            {pending ? "Learning…" : "Learn now"}
          </Button>
          <span className="caption-style text-subtle">Runs automatically overnight. Use this to catch up straight away.</span>
        </div>
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <p role="status" className="caption-style text-subtle">
          {message}
        </p>
      </div>
    </SettingsCard>
  );
}

function MemoryRow({ memory }: { memory: Memory }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(memory.title);
  const [body, setBody] = useState(memory.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<{ error?: string }>) {
    setBusy(true);
    setError(null);
    const result = await work();
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return false;
    }
    router.refresh();
    return true;
  }

  return (
    <li className="flex flex-col gap-2 py-3">
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await run(() => updateMemoryAction(memory.id, { title, body }))) setEditing(false);
          }}
        >
          <label className="sr-only" htmlFor={`memory-title-${memory.id}`}>
            Title
          </label>
          <Input id={`memory-title-${memory.id}`} value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
          <label className="sr-only" htmlFor={`memory-body-${memory.id}`}>
            Note
          </label>
          <textarea id={`memory-body-${memory.id}`} rows={3} value={body} maxLength={1200} onChange={(event) => setBody(event.target.value)} className={AREA} />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save note"}
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-[14px] font-medium">{memory.title}</span>
            <Tag tone="neutral" size="sm" className="text-[12px]">
              {memory.kind.replace(/_/g, " ")}
            </Tag>
            {memory.pinned && (
              <Tag tone="purple" size="sm" className="text-[12px]">
                Pinned
              </Tag>
            )}
          </div>
          {memory.body.trim() !== memory.title.trim() && <p className="text-soft text-[14px] leading-5 whitespace-pre-wrap">{memory.body}</p>}
          <div className="caption-style text-subtle flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {memory.origin === "learning" ? "Learned" : memory.origin === "assistant" ? "Saved by the assistant" : "Added by hand"} {day(memory.updatedAt)}, {memory.confidence} confidence
            </span>
            {memory.sources.map((source, index) =>
              source.url ? (
                <a key={index} href={source.url} target={source.url.startsWith("/") ? undefined : "_blank"} rel="noreferrer" className="hover:text-foreground underline underline-offset-2">
                  {source.label}
                </a>
              ) : (
                <span key={index}>{source.label}</span>
              ),
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => updateMemoryAction(memory.id, { pinned: !memory.pinned }))}>
              {memory.pinned ? "Unpin" : "Pin"}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => forgetMemoryAction(memory.id))}>
              Forget
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

export function MemoriesCard({ memories }: { memories: Record<MemoryScope, Memory[]> }) {
  const router = useRouter();
  const [scope, setScope] = useState<MemoryScope>("personal");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return memories[scope].filter((memory) => words.every((word) => `${memory.title} ${memory.body} ${memory.kind}`.toLowerCase().includes(word)));
  }, [memories, scope, search]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await addMemoryAction({ title, body, shared: scope !== "personal" });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setTitle("");
    setBody("");
    setAdding(false);
    router.refresh();
  }

  return (
    <SettingsCard id="memory" title="What Orbit has learned" description={SCOPE_HINTS[scope]}>
      <div className="flex flex-col gap-3">
        <div role="group" aria-label="Which notes" className="flex flex-wrap gap-1">
          {(Object.keys(SCOPE_LABELS) as MemoryScope[]).map((key) => (
            <Button key={key} variant={scope === key ? "secondary" : "ghost"} size="sm" aria-pressed={scope === key} onClick={() => setScope(key)}>
              {SCOPE_LABELS[key]} <span className="text-subtle tabular-nums">{memories[key].length}</span>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="memory-search">
            Search notes
          </label>
          <Input id="memory-search" type="search" value={search} placeholder="Search notes" onChange={(event) => setSearch(event.target.value)} className="min-w-0 flex-1" />
          {scope !== "market" && (
            <Button variant="secondary" size="sm" onClick={() => setAdding((open) => !open)} aria-expanded={adding} className="h-9">
              Add a note
            </Button>
          )}
        </div>
        {adding && (
          <form className="flex flex-col gap-3 rounded-lg bg-white/[0.025] p-3" onSubmit={add}>
            <Field label="Title" htmlFor="new-memory-title">
              <Input id="new-memory-title" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} placeholder={scope === "personal" ? "Keep first emails short" : "Agencies ask for a pilot first"} />
            </Field>
            <Field label="Note" htmlFor="new-memory-body" hint={scope === "personal" ? "Only you and your assistant see this." : "Every member's assistant sees this."}>
              <textarea id="new-memory-body" rows={3} value={body} maxLength={1200} onChange={(event) => setBody(event.target.value)} className={AREA} aria-describedby="new-memory-body-hint" />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" type="submit" disabled={busy || !body.trim()}>
                {busy ? "Saving…" : "Save note"}
              </Button>
              <Button variant="ghost" size="sm" type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
            {error && (
              <p role="alert" className="caption-style text-danger">
                {error}
              </p>
            )}
          </form>
        )}
        {shown.length ? (
          <ul className="divide-sidebar-border flex flex-col divide-y">
            {shown.map((memory) => (
              <MemoryRow key={memory.id} memory={memory} />
            ))}
          </ul>
        ) : (
          <p className="caption-style text-subtle py-2">{search ? "No notes match." : "Nothing learned here yet. It fills in after the first nightly run, or press Learn now."}</p>
        )}
      </div>
    </SettingsCard>
  );
}

export function WatchlistCard({ items }: { items: WatchItem[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<WatchKind>("competitor");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await addWatchAction({ kind, label, url, notes });
    setBusy(false);
    if (result.error) {
      setError({ message: result.error, field: result.field });
      return;
    }
    setLabel("");
    setUrl("");
    setNotes("");
    router.refresh();
  }

  async function remove(id: string) {
    const result = await removeWatchAction(id);
    if (result.error) setError({ message: result.error });
    else router.refresh();
  }

  return (
    <SettingsCard id="watchlist" title="Watchlist" description="What Grok Bot researches every night: topics, competitors, people, target accounts and sources. The assistant can change it too.">
      <div className="flex flex-col gap-4">
        <form className="grid gap-3 sm:grid-cols-[10rem_1fr]" onSubmit={add} noValidate>
          <Field label="Kind" htmlFor="watch-kind">
            <select id="watch-kind" value={kind} onChange={(event) => setKind(event.target.value as WatchKind)} className={SELECT}>
              {(Object.keys(WATCH_LABELS) as WatchKind[]).map((key) => (
                <option key={key} value={key}>
                  {WATCH_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name" htmlFor="watch-label" error={error?.field === "label" ? error.message : undefined}>
            <Input id="watch-label" value={label} maxLength={160} placeholder="Profound" onChange={(event) => setLabel(event.target.value)} aria-invalid={error?.field === "label" ? true : undefined} />
          </Field>
          <Field label="Link (optional)" htmlFor="watch-url" error={error?.field === "url" ? error.message : undefined} className="sm:col-start-2">
            <Input id="watch-url" type="url" inputMode="url" value={url} placeholder="https://x.com/tryprofound" onChange={(event) => setUrl(event.target.value)} aria-invalid={error?.field === "url" ? true : undefined} />
          </Field>
          <Field label="Why it's watched (optional)" htmlFor="watch-notes" className="sm:col-start-2">
            <Input id="watch-notes" value={notes} maxLength={500} placeholder="Closest competitor in AI visibility" onChange={(event) => setNotes(event.target.value)} />
          </Field>
          <div className="sm:col-start-2">
            <Button variant="secondary" size="sm" type="submit" disabled={busy || !label.trim()}>
              {busy ? "Adding…" : "Add to watchlist"}
            </Button>
          </div>
        </form>
        {error && !error.field && (
          <p role="alert" className="caption-style text-danger">
            {error.message}
          </p>
        )}
        {items.length ? (
          <ul className="divide-sidebar-border flex flex-col divide-y">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2">
                <Tag tone="neutral" size="sm" className="text-[12px]">
                  {WATCH_LABELS[item.kind]}
                </Tag>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-[14px]">
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                        {item.label}
                      </a>
                    ) : (
                      item.label
                    )}
                  </span>
                  {item.notes && <span className="caption-style text-subtle block truncate">{item.notes}</span>}
                </span>
                <Button variant="ghost" size="sm" aria-label={`Stop watching ${item.label}`} onClick={() => void remove(item.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="caption-style text-subtle">Nothing on the watchlist yet. Add your competitors, the people you follow and your target accounts.</p>
        )}
      </div>
    </SettingsCard>
  );
}

export function MarketNotesCard({ notes }: { notes: MarketNote[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsCard id="market-notes" title="Market notes received" description="The latest findings Grok Bot sent in. Orbit turns them into market notes overnight and puts the important ones in your morning brief.">
      {notes.length ? (
        <ul className="divide-sidebar-border flex flex-col divide-y">
          {notes.map((note) => (
            <li key={note.id} className="flex items-start gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="text-foreground block text-[14px] leading-5">
                  {note.url ? (
                    <a href={note.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                      {note.headline}
                    </a>
                  ) : (
                    note.headline
                  )}
                </span>
                <span className="caption-style text-subtle block">
                  {[note.kind, note.about, note.from ? `from ${note.from}` : null, day(note.publishedAt ?? note.createdAt), note.processedAt ? "learned" : "waiting for tonight"].filter(Boolean).join(" · ")}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete ${note.headline}`}
                onClick={async () => {
                  const result = await deleteMarketNoteAction(note.id);
                  if (result.error) setError(result.error);
                  else router.refresh();
                }}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="caption-style text-subtle">No market notes yet. Connect Grok Bot below and its first run will appear here.</p>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}

export function GrokCard({ status, mcpUrl, routine, canConnect }: { status: MarketAgentStatus; mcpUrl: string; routine: string; canConnect: boolean }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(what);
  }

  async function connect() {
    setBusy(true);
    setError(null);
    const result = await connectGrokAction();
    setBusy(false);
    if (result.error || !result.result) {
      setError(result.error ?? "Could not create the token.");
      return;
    }
    setToken(result.result.token);
    router.refresh();
  }

  return (
    <SettingsCard
      id="grok"
      title="Grok Bot"
      description="Grok Bot researches X and your news sources every night and sends what it finds here. Its token can only read the watchlist and send market notes."
    >
      <div className="flex flex-col gap-4 text-[14px] leading-5">
        <p className={cn("caption-style", status ? "text-soft" : "text-subtle")}>
          {status ? `Connected ${when(status.connectedAt)}. Last used ${when(status.lastUsedAt)}.` : "Not connected yet."}
        </p>
        <ol className="text-soft flex list-decimal flex-col gap-3 pl-5">
          <li>
            {canConnect ? (
              <span className="flex flex-col gap-2">
                <span>Create a token for Grok Bot. {status ? "Creating a new one stops the old one working." : ""}</span>
                <span>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void connect()}>
                    {busy ? "Creating…" : status ? "Replace token" : "Create token"}
                  </Button>
                </span>
                {token && (
                  <span className="flex flex-col gap-2 rounded-lg bg-white/[0.04] p-3">
                    <span className="text-foreground">Copy it now. Orbit won&apos;t show it again.</span>
                    <code className="text-foreground block font-mono text-[12px] break-all">{token}</code>
                    <span>
                      <Button variant="secondary" size="sm" onClick={() => void copy(token, "token")}>
                        {copied === "token" ? "Copied" : "Copy token"}
                      </Button>
                    </span>
                  </span>
                )}
              </span>
            ) : (
              "Ask an owner or admin to create a Grok Bot token."
            )}
          </li>
          <li className="flex flex-col gap-2">
            <span>
              In Grok Bot, open Settings, then Plugins, and add a custom MCP server named Orbit with this address and the header <code className="font-mono text-[12px]">Authorization: Bearer</code> followed by the token.
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <code className="text-foreground rounded bg-white/[0.04] px-2 py-1 font-mono text-[12px] break-all">{mcpUrl}</code>
              <Button variant="ghost" size="sm" onClick={() => void copy(mcpUrl, "url")}>
                {copied === "url" ? "Copied" : "Copy address"}
              </Button>
            </span>
          </li>
          <li className="flex flex-col gap-2">
            <span>Create a routine in Grok Bot that runs nightly with these instructions:</span>
            <label className="sr-only" htmlFor="grok-routine">
              Routine instructions
            </label>
            <textarea id="grok-routine" readOnly rows={8} value={routine} className={cn(AREA, "text-[13px]")} />
            <span>
              <Button variant="ghost" size="sm" onClick={() => void copy(routine, "routine")}>
                {copied === "routine" ? "Copied" : "Copy instructions"}
              </Button>
            </span>
          </li>
        </ol>
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
