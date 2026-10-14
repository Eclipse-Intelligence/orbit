"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { TagChip } from "@/components/crm/tags";
import { deleteTagAction, renameTagAction } from "@/app/(crm)/tags";
import { normalizeTag, TAG_MAX_LENGTH } from "@/lib/crm/normalize";
import type { TagCount } from "@/lib/crm/types";

function plural(value: number, noun: [string, string]) {
  return `${value} ${value === 1 ? noun[0] : noun[1]}`;
}

function usage(tag: TagCount) {
  const parts = [];
  if (tag.contacts > 0) parts.push(plural(tag.contacts, ["contact", "contacts"]));
  if (tag.companies > 0) parts.push(plural(tag.companies, ["company", "companies"]));
  return parts.join(" · ");
}

export default function TagsSettings({ tags }: { tags: TagCount[] }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const target = normalizeTag(draft);
  const merges =
    renaming !== null &&
    target !== renaming &&
    tags.some((tag) => tag.name === target);

  function startRename(name: string) {
    setDeleting(null);
    setError(null);
    setMessage(null);
    setRenaming(name);
    setDraft(name);
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renaming) return;
    if (target === renaming) {
      setRenaming(null);
      return;
    }
    setPending(true);
    setError(null);
    const result = await renameTagAction(renaming, draft);
    setPending(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setMessage(
      merges ? `Merged “${renaming}” into “${target}”.` : `Renamed “${renaming}” to “${target}”.`,
    );
    setRenaming(null);
    router.refresh();
  }

  async function remove(name: string) {
    setPending(true);
    setError(null);
    const result = await deleteTagAction(name);
    setPending(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setMessage(`Deleted “${name}”.`);
    setDeleting(null);
    router.refresh();
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-3">
      <h2>Tags</h2>
      <p className="caption-style text-subtle">
        Add tags from a contact or company, or select rows in a list. Renaming a tag to one that
        already exists merges them.
      </p>
      {tags.length === 0 ? (
        <p className="caption-style text-subtle">No tags yet.</p>
      ) : (
        <ul className="flex flex-col">
          {tags.map((tag) => (
            <li
              key={tag.name}
              className="border-border flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b py-2"
            >
              {renaming === tag.name ? (
                <form className="flex min-w-0 flex-1 flex-col gap-1.5" onSubmit={rename}>
                  <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={`rename-${tag.name}`}>
                      New name for {tag.name}
                    </label>
                    <Input
                      id={`rename-${tag.name}`}
                      value={draft}
                      autoFocus
                      maxLength={TAG_MAX_LENGTH}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setRenaming(null);
                      }}
                      className="h-8 max-w-[240px]"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={pending}
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </Button>
                    <Button variant="secondary" size="sm" type="submit" disabled={pending || !target}>
                      {pending ? "Saving…" : merges ? "Merge" : "Save"}
                    </Button>
                  </div>
                  {merges && (
                    <span className="caption-style text-subtle">
                      “{target}” already exists. Records with either tag will keep one “{target}”.
                    </span>
                  )}
                </form>
              ) : (
                <span className="flex min-w-0 items-center gap-2">
                  <TagChip name={tag.name} />
                  <span className="caption-style text-subtle truncate">{usage(tag)}</span>
                </span>
              )}
              {renaming !== tag.name && (
                <span className="flex shrink-0 items-center gap-1">
                  {deleting === tag.name ? (
                    <>
                      <span className="caption-style text-subtle mr-1">
                        Remove from {plural(tag.contacts + tag.companies, ["record", "records"])}?
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => setDeleting(null)}
                      >
                        Keep
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:text-danger"
                        disabled={pending}
                        onClick={() => remove(tag.name)}
                      >
                        {pending ? "Deleting…" : "Delete tag"}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Rename ${tag.name}`}
                        disabled={pending}
                        onClick={() => startRename(tag.name)}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${tag.name}`}
                        disabled={pending}
                        onClick={() => {
                          setRenaming(null);
                          setError(null);
                          setMessage(null);
                          setDeleting(tag.name);
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
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <p role="status" className="caption-style text-subtle empty:hidden">
        {message}
      </p>
    </div>
  );
}
