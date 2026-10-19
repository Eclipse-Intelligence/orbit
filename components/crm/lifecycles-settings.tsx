"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { LifecycleMark } from "@/components/beautifui/record-marks";
import { SettingsCard } from "@/components/crm/settings-ui";
import { deleteLifecycleAction, renameLifecycleAction } from "@/app/(crm)/actions";
import { cleanLifecycle, LIFECYCLE_MAX_LENGTH } from "@/lib/companies";
import type { LifecycleCount } from "@/lib/crm/types";

function companies(count: number) {
  return `${count} ${count === 1 ? "company" : "companies"}`;
}

export default function LifecyclesSettings({ lifecycles }: { lifecycles: LifecycleCount[] }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const target = cleanLifecycle(draft);
  const merges =
    renaming !== null &&
    target !== null &&
    target.toLowerCase() !== renaming.toLowerCase() &&
    lifecycles.some((item) => item.value.toLowerCase() === target.toLowerCase() || item.label.toLowerCase() === target.toLowerCase());

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renaming || !target) return;
    setPending(true);
    setError(null);
    const result = await renameLifecycleAction(renaming, draft);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMessage(merges ? `Moved “${renaming}” into “${draft.trim()}”.` : `Renamed “${renaming}” to “${draft.trim()}”.`);
    setRenaming(null);
    router.refresh();
  }

  async function remove(name: string) {
    setPending(true);
    setError(null);
    const result = await deleteLifecycleAction(name);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMessage(`Deleted “${name}”. Its companies are now Lead.`);
    setDeleting(null);
    router.refresh();
  }

  return (
    <SettingsCard
      id="lifecycles"
      title="Lifecycles"
      description="Every company has one lifecycle. Lead, Prospect, Customer and Churned are built in (a won deal makes a company a Customer). Create your own, such as Consultant or Personal, from the Lifecycle on any company."
    >
      <ul className="flex flex-col">
        {lifecycles.map((item) => (
          <li
            key={item.value}
            className="border-border flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b py-2 first:pt-0 last:border-b-0 last:pb-0"
          >
            {renaming === item.value ? (
              <form className="flex min-w-0 flex-1 flex-col gap-1.5" onSubmit={rename}>
                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`rename-lifecycle-${item.value}`}>
                    New name for {item.label}
                  </label>
                  <Input
                    id={`rename-lifecycle-${item.value}`}
                    value={draft}
                    autoFocus
                    maxLength={LIFECYCLE_MAX_LENGTH}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    className="h-8 max-w-[240px]"
                  />
                  <Button variant="ghost" size="sm" type="button" disabled={pending} onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                  <Button variant="secondary" size="sm" type="submit" disabled={pending || !target}>
                    {pending ? "Saving…" : merges ? "Merge" : "Save"}
                  </Button>
                </div>
                {merges && <span className="caption-style text-subtle">That lifecycle already exists. Its companies and these will share it.</span>}
              </form>
            ) : (
              <span className="flex min-w-0 items-center gap-2">
                <LifecycleMark lifecycle={item.value} />
                <span className="caption-style text-subtle truncate">
                  {companies(item.companies)}
                  {item.builtIn ? " · built in" : ""}
                </span>
              </span>
            )}
            {!item.builtIn && renaming !== item.value && (
              <span className="flex shrink-0 items-center gap-1">
                {deleting === item.value ? (
                  <>
                    <span className="caption-style text-subtle mr-1">Move {companies(item.companies)} to Lead?</span>
                    <Button variant="ghost" size="sm" disabled={pending} onClick={() => setDeleting(null)}>
                      Keep
                    </Button>
                    <Button variant="ghost" size="sm" className="text-danger hover:text-danger" disabled={pending} onClick={() => remove(item.value)}>
                      {pending ? "Deleting…" : "Delete lifecycle"}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Rename ${item.label}`}
                      disabled={pending}
                      onClick={() => {
                        setDeleting(null);
                        setError(null);
                        setMessage(null);
                        setRenaming(item.value);
                        setDraft(item.label);
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${item.label}`}
                      disabled={pending}
                      onClick={() => {
                        setRenaming(null);
                        setError(null);
                        setMessage(null);
                        setDeleting(item.value);
                      }}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="caption-style text-subtle">
          {message}
        </p>
      )}
    </SettingsCard>
  );
}
