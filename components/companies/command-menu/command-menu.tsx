"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Kbd,
} from "@/components/_ui/command";
import { searchWorkspaceAction } from "@/app/(crm)/search";
import type { Company, Contact, Opportunity } from "@/lib/crm/types";
import { useCompaniesStore } from "@/stores/companies-store";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

type Results = {
  query: string;
  companies: Company[];
  contacts: Contact[];
  opportunities: Opportunity[];
};

export default function CommandMenu() {
  const router = useRouter();
  const open = useCompaniesStore((state) => state.searchOpen);
  const setOpen = useCompaniesStore((state) => state.setSearchOpen);
  const setNewCompanyOpen = useCompaniesStore((state) => state.setNewCompanyOpen);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<Results | null>(null);
  const actionRan = useRef(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const { searchOpen, setSearchOpen } = useCompaniesStore.getState();
      const target = event.target;
      if (
        !searchOpen &&
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      event.preventDefault();
      setSearchOpen(!searchOpen);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const trimmed = query.trim();
  const searching = Boolean(open && trimmed && remote?.query !== trimmed);
  const results = remote?.query === trimmed ? remote : null;

  useEffect(() => {
    if (!open || !trimmed) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      searchWorkspaceAction(trimmed).then((rows) => {
        if (!cancelled) setRemote({ query: trimmed, ...rows });
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmed, open]);

  function run(action: () => void) {
    actionRan.current = true;
    setOpen(false);
    action();
  }

  const empty = results
    ? results.companies.length + results.contacts.length + results.opportunities.length === 0
    : true;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search"
      description="Search companies, people, and opportunities"
      className="max-w-[640px]"
      onCloseAutoFocus={(event) => {
        if (actionRan.current) event.preventDefault();
        actionRan.current = false;
        setQuery("");
        setRemote(null);
      }}
    >
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search companies, people, and opportunities"
          trailing={<Kbd>Esc</Kbd>}
        />
        <CommandList>
          {searching && <p className="caption-style text-subtle px-4 py-6">Searching…</p>}
          {!searching && trimmed && empty && (
            <p className="caption-style text-subtle px-4 py-6">No records for “{trimmed}”</p>
          )}
          {!trimmed && <p className="caption-style text-subtle px-4 py-6">Type a name, email, or domain.</p>}
          {results && results.companies.length > 0 && (
            <CommandGroup heading="Companies">
              {results.companies.map((company) => (
                <CommandItem
                  key={company.id}
                  value={company.id}
                  onSelect={() => run(() => router.push(`/?record=${company.id}`))}
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
                  value={contact.id}
                  onSelect={() =>
                    run(() =>
                      router.push(`/contacts?q=${encodeURIComponent(contact.email || contact.name)}`),
                    )
                  }
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
                  value={opportunity.id}
                  onSelect={() =>
                    run(() => router.push(`/opportunities?q=${encodeURIComponent(opportunity.name)}`))
                  }
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{opportunity.name}</span>
                    <span className="caption-style text-subtle truncate">
                      {opportunity.companyName ?? "No company"}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem
              value="new-company"
              onSelect={() =>
                run(() => {
                  setNewCompanyOpen(true);
                  router.push("/");
                })
              }
            >
              <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-md shadow-[0px_0px_0px_1px_#232323]">
                <PlusIcon aria-hidden className="text-soft size-3" />
              </span>
              New Company
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <CommandFooter>
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            Open
          </span>
        </CommandFooter>
      </Command>
    </CommandDialog>
  );
}
