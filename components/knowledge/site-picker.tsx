"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Input } from "@/components/_ui/input";
import { addKnowledgePagesAction, mapSiteAction } from "@/app/(crm)/knowledge";
import type { KnowledgeTargetProp } from "@/components/knowledge/knowledge-panel";
import type { KnowledgeItem } from "@/lib/knowledge/store";
import type { SiteMap } from "@/lib/knowledge/site";

const SELECT_ALL_UP_TO = 100;

function plural(count: number, one: string, many: string) {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

export default function SitePicker({
  open,
  onOpenChange,
  target,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: KnowledgeTargetProp;
  onAdded: (items: KnowledgeItem[], added: number) => void;
}) {
  const [url, setUrl] = useState("");
  const [map, setMap] = useState<SiteMap | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<"mapping" | "adding" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlId = useId();
  const filterId = useId();

  const shown = useMemo(() => {
    if (!map) return [];
    const term = filter.trim().toLowerCase();
    return term ? map.pages.filter((page) => page.path.toLowerCase().includes(term)) : map.pages;
  }, [map, filter]);

  function reset() {
    setUrl("");
    setMap(null);
    setSelected(new Set());
    setFilter("");
    setBusy(null);
    setError(null);
  }

  async function find(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setBusy("mapping");
    setError(null);
    const result = await mapSiteAction(url);
    setBusy(null);
    if (!result.map) {
      setError(result.error ?? "Couldn't map that site.");
      return;
    }
    setMap(result.map);
    const pages = result.map.pages;
    setSelected(new Set((pages.length <= SELECT_ALL_UP_TO ? pages : pages.filter((page) => page.depth <= 1)).map((page) => page.url)));
  }

  async function add() {
    if (selected.size === 0 || busy) return;
    setBusy("adding");
    setError(null);
    const result = await addKnowledgePagesAction(target, [...selected]);
    setBusy(null);
    if (!result.items) {
      setError(result.error ?? "Couldn't add those pages.");
      return;
    }
    onAdded(result.items, result.added ?? 0);
    reset();
    onOpenChange(false);
  }

  function toggle(pageUrl: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(pageUrl);
      else next.delete(pageUrl);
      return next;
    });
  }

  function setShown(on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const page of shown) {
        if (on) next.add(page.url);
        else next.delete(page.url);
      }
      return next;
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy === "adding") return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[640px]">
        <DialogHeader className="pr-12">
          <DialogTitle>Add website</DialogTitle>
          <DialogDescription>{map ? `${plural(map.pages.length, "page", "pages")} on ${map.host}${map.truncated ? ", the first found" : ""}.` : "Find a site's pages and choose which to add."}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-6 py-4">
          {!map ? (
            <form onSubmit={find} className="flex items-center gap-2">
              <label htmlFor={urlId} className="sr-only">
                Website
              </label>
              <Input
                id={urlId}
                type="text"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                className="min-w-0 flex-1"
                autoFocus
              />
              <Button variant="primary" size="sm" type="submit" disabled={!url.trim() || busy !== null}>
                {busy === "mapping" ? "Finding pages" : "Find pages"}
              </Button>
            </form>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <label htmlFor={filterId} className="sr-only">
                  Filter pages
                </label>
                <Input id={filterId} type="search" placeholder="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} className="min-w-0 flex-1" />
                <Button variant="ghost" size="sm" onClick={() => setShown(true)}>
                  All
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShown(false)}>
                  None
                </Button>
              </div>
              <ul aria-label="Pages" className="flex flex-col">
                {shown.map((page) => (
                  <li key={page.url}>
                    <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/4">
                      <Checkbox checked={selected.has(page.url)} onCheckedChange={(state) => toggle(page.url, state === true)} aria-label={page.path} />
                      <span className="ui-style min-w-0 flex-1 truncate">{page.path}</span>
                    </label>
                  </li>
                ))}
                {shown.length === 0 && <li className="caption-style text-subtle px-2 py-2">No pages match.</li>}
              </ul>
            </>
          )}
          {busy === "mapping" && (
            <p role="status" className="sr-only">
              Finding pages
            </p>
          )}
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
        </div>
        {map && (
          <DialogFooter>
            <Button variant="ghost" size="md" onClick={reset} disabled={busy !== null}>
              Back
            </Button>
            <Button variant="primary" size="md" onClick={() => void add()} disabled={selected.size === 0 || busy !== null}>
              {busy === "adding" ? "Adding" : `Add ${plural(selected.size, "page", "pages")}`}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
