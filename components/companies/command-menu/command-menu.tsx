"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Kbd,
} from "@/components/_ui/command";
import { shortcutTarget, useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import { searchWorkspaceAction } from "@/app/(crm)/search";
import { companyHref, contactHref, opportunityHref } from "@/lib/crm/hrefs";
import type { Company, Contact, Opportunity } from "@/lib/crm/types";
import { SHORTCUTS, paletteMatches, shortcutKeys, type ShortcutDef, type ShortcutGroup } from "@/lib/shortcuts";
import DocsPaletteGroups, { type PaletteRecord } from "@/components/docs/docs-palette";
import { useDocsNavigate } from "@/components/docs/use-docs";
import { isDocsPath, pageHref } from "@/lib/docs/routes";
import { useDocsStore } from "@/stores/docs-store";

type Results = {
  query: string;
  companies: Company[];
  contacts: Contact[];
  opportunities: Opportunity[];
  failed?: boolean;
};

const PAGE_GROUPS = new Set<ShortcutGroup>(["Lists", "Selection", "Tasks", "Opportunities", "Records", "Calendar", "Capture", "Mail", "Docs"]);
const GENERAL_IDS = new Set(["assistant", "help", "settings", "notifications", "account"]);
const DOCS_PALETTE_IDS = new Set(["create-note", "docs-daily", "docs-search"]);

function Keys({ def, mac }: { def: ShortcutDef; mac: boolean }) {
  const keys = shortcutKeys(def, mac);
  if (keys.length === 0) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {keys.map((key, index) => (
        <Kbd key={index} aria-hidden>
          {key}
        </Kbd>
      ))}
    </span>
  );
}

export default function CommandMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const navigateDocs = useDocsNavigate();
  const createNote = useDocsStore((state) => state.createNote);
  const { paletteOpen: open, setPaletteOpen: setOpen, paletteMode, listSearch, run, available, mac } = useShortcuts();
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<Results | null>(null);
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const actionRan = useRef(false);
  const creating = useRef(false);
  const listMode = paletteMode === "list" && listSearch !== null;

  const [seen, setSeen] = useState({ open, listMode });
  if (seen.open !== open || seen.listMode !== listMode) {
    setSeen({ open, listMode });
    if (open) setQuery(listMode ? (listSearch?.value ?? "") : "");
  }

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setPageIds(
        SHORTCUTS.filter(
          (def) => def.palette && (PAGE_GROUPS.has(def.group) || GENERAL_IDS.has(def.id)) && available(def.id),
        ).map((def) => def.id),
      );
      const add = shortcutTarget("add-record");
      const text = add?.textContent?.trim();
      setLabels(text && add?.tagName !== "INPUT" ? { "add-record": text } : {});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, available]);

  const trimmed = query.trim();
  const searching = Boolean(open && trimmed && remote?.query !== trimmed);
  const results = remote?.query === trimmed ? remote : null;

  useEffect(() => {
    if (!open || !trimmed) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      searchWorkspaceAction(trimmed).then(
        (rows) => {
          if (!cancelled) setRemote({ query: trimmed, ...rows });
        },
        () => {
          if (!cancelled)
            setRemote({ query: trimmed, companies: [], contacts: [], opportunities: [], failed: true });
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmed, open]);

  function go(action: () => void) {
    actionRan.current = true;
    setOpen(false);
    window.setTimeout(action, 60);
  }

  const docs = isDocsPath(pathname) && !listMode;
  const shownByDocs = (def: ShortcutDef) => !docs || !DOCS_PALETTE_IDS.has(def.id);
  const commands = SHORTCUTS.filter((def) => def.palette);
  const pageCommands = commands.filter(
    (def) => pageIds.includes(def.id) && !GENERAL_IDS.has(def.id) && paletteMatches(def, query) && shownByDocs(def),
  );
  const generalCommands = commands.filter(
    (def) => pageIds.includes(def.id) && GENERAL_IDS.has(def.id) && paletteMatches(def, query),
  );
  const createCommands = commands.filter((def) => def.group === "Create" && paletteMatches(def, query) && shownByDocs(def));
  const goCommands = commands.filter((def) => def.group === "Go to" && paletteMatches(def, query));
  const settingsCommands = trimmed ? commands.filter((def) => def.group === "Settings" && paletteMatches(def, query)) : [];

  const topRecord: PaletteRecord | null = results
    ? results.companies[0]
      ? { kind: "company", id: results.companies[0].id, name: results.companies[0].name }
      : results.contacts[0]
        ? { kind: "contact", id: results.contacts[0].id, name: results.contacts[0].name }
        : results.opportunities[0]
          ? { kind: "opportunity", id: results.opportunities[0].id, name: results.opportunities[0].name }
          : null
    : null;

  const recordCount = results ? results.companies.length + results.contacts.length + results.opportunities.length : 0;
  const nothing =
    !docs &&
    trimmed &&
    !searching &&
    !listMode &&
    recordCount === 0 &&
    pageCommands.length + createCommands.length + goCommands.length + settingsCommands.length + generalCommands.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search records and run actions"
      className="max-w-[640px]"
      onCloseAutoFocus={(event) => {
        if (actionRan.current) event.preventDefault();
        actionRan.current = false;
        setQuery("");
        setRemote(null);
      }}
    >
      <Command
        shouldFilter={false}
        loop
        onKeyDown={(event) => {
          if (!docs || event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || !trimmed) return;
          event.preventDefault();
          if (creating.current) return;
          creating.current = true;
          void createNote({ title: trimmed }).then((page) => {
            creating.current = false;
            if (page) go(() => navigateDocs(pageHref(page.id)));
          });
        }}
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={listMode ? `Search ${listSearch?.noun}…` : docs ? "Open a note, or type to create one" : "Type a command or search…"}
          trailing={
            docs ? (
              <span aria-hidden className="caption-style text-faint flex items-center gap-1.5">
                Docs
                <Kbd>⌘K</Kbd>
              </span>
            ) : (
              <Kbd>Esc</Kbd>
            )
          }
        />
        <CommandList>
          {docs && <DocsPaletteGroups query={query} record={topRecord} open={open} go={(href) => go(() => navigateDocs(href))} />}
          {listMode && listSearch && (
            <CommandGroup heading={`Search ${listSearch.noun}`}>
              <CommandItem value="list-search" onSelect={() => go(() => router.push(listSearch.hrefFor(query)))}>
                {trimmed ? (
                  <span className="truncate">
                    Show {listSearch.noun} matching “{trimmed}”
                  </span>
                ) : (
                  <span>{listSearch.value ? "Clear the search" : `Show all ${listSearch.noun}`}</span>
                )}
                <span className="ml-auto flex shrink-0 items-center">
                  <Kbd aria-hidden>Enter</Kbd>
                </span>
              </CommandItem>
            </CommandGroup>
          )}
          {pageCommands.length > 0 && (
            <CommandGroup heading="This page">
              {pageCommands.map((def) => (
                <CommandItem key={def.id} value={def.id} onSelect={() => go(() => run(def.id))}>
                  <span className="truncate">{labels[def.id] ?? def.label}</span>
                  <Keys def={def} mac={mac} />
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {trimmed && searching && <p className="caption-style text-subtle px-4 py-3">Searching records…</p>}
          {!searching && results?.failed && (
            <p role="alert" className="caption-style text-danger px-4 py-3">
              Search is unavailable right now. Try again in a moment.
            </p>
          )}
          {results && results.companies.length > 0 && (
            <CommandGroup heading="Companies">
              {results.companies.map((company) => (
                <CommandItem
                  key={company.id}
                  value={`company-${company.id}`}
                  onSelect={() => go(() => router.push(companyHref(company.id)))}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{company.name}</span>
                    <span className="caption-style text-subtle truncate">{company.domain ?? "No domain"}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {results && results.contacts.length > 0 && (
            <CommandGroup heading="People">
              {results.contacts.map((contact) => (
                <CommandItem
                  key={contact.id}
                  value={`contact-${contact.id}`}
                  onSelect={() => go(() => router.push(contactHref(contact.id)))}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{contact.name}</span>
                    <span className="caption-style text-subtle truncate">
                      {[contact.jobTitle, contact.companyName].filter(Boolean).join(" · ") || "No company"}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {results && results.opportunities.length > 0 && (
            <CommandGroup heading="Opportunities">
              {results.opportunities.map((opportunity) => (
                <CommandItem
                  key={opportunity.id}
                  value={`opportunity-${opportunity.id}`}
                  onSelect={() =>
                    go(() => router.push(opportunityHref(opportunity)))
                  }
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{opportunity.name}</span>
                    <span className="caption-style text-subtle truncate">
                      {opportunity.pipelineKind === "board"
                        ? [opportunity.pipelineName, opportunity.stageName].filter(Boolean).join(" · ")
                        : (opportunity.companyName ?? "No company")}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {!listMode && createCommands.length > 0 && (
            <CommandGroup heading="Create">
              {createCommands.map((def) => (
                <CommandItem key={def.id} value={def.id} onSelect={() => go(() => run(def.id))}>
                  <span className="truncate">{def.label}</span>
                  <Keys def={def} mac={mac} />
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {!listMode && goCommands.length > 0 && (
            <CommandGroup heading="Go to">
              {goCommands.map((def) => (
                <CommandItem key={def.id} value={def.id} onSelect={() => go(() => run(def.id))}>
                  <span className="truncate">{def.label}</span>
                  <Keys def={def} mac={mac} />
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {!listMode && settingsCommands.length > 0 && (
            <CommandGroup heading="Settings">
              {settingsCommands.map((def) => (
                <CommandItem key={def.id} value={def.id} onSelect={() => go(() => run(def.id))}>
                  <span className="truncate">{def.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {!listMode && generalCommands.length > 0 && (
            <CommandGroup heading="General">
              {generalCommands.map((def) => (
                <CommandItem key={def.id} value={def.id} onSelect={() => go(() => run(def.id))}>
                  <span className="truncate">{def.label}</span>
                  <Keys def={def} mac={mac} />
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {nothing && <p className="caption-style text-subtle px-4 py-6">Nothing matches “{trimmed}”</p>}
        </CommandList>
        <CommandFooter>
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd>
            {docs ? "Open" : "Run"}
          </span>
          {docs && (
            <span className="flex items-center gap-1.5">
              <Kbd>⌘</Kbd>
              <Kbd>Enter</Kbd>
              Create
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>Esc</Kbd>
            Close
          </span>
        </CommandFooter>
      </Command>
    </CommandDialog>
  );
}
