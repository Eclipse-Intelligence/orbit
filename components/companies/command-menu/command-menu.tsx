"use client";

import { useEffect, useRef, useState } from "react";
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
import { CommandCompanyRow, CommandTableHeader } from "./command-table";
import { searchCompaniesAction } from "@/app/(crm)/actions";
import type { Company } from "@/lib/crm/types";
import { useCompaniesStore } from "@/stores/companies-store";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

export default function CommandMenu({ companies: pageCompanies }: { companies: Company[] }) {
  const open = useCompaniesStore((state) => state.searchOpen);
  const setOpen = useCompaniesStore((state) => state.setSearchOpen);
  const openCompany = useCompaniesStore((state) => state.openCompany);
  const setNewCompanyOpen = useCompaniesStore((state) => state.setNewCompanyOpen);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<{ query: string; rows: Company[] } | null>(null);
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
  const companies = !trimmed
    ? pageCompanies
    : remote?.query === trimmed
      ? remote.rows
      : [];

  useEffect(() => {
    if (!open || !trimmed) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      searchCompaniesAction(trimmed).then((rows) => {
        if (!cancelled) setRemote({ query: trimmed, rows });
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

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search"
      description="Search companies by name, domain, or industry"
      className="max-w-[960px]"
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
          placeholder="Search companies by name or domain"
          trailing={<Kbd>Esc</Kbd>}
        />
        <CommandTableHeader />
        <CommandList>
          {companies.length === 0 && (
            <p className="caption-style text-subtle px-4 py-6">
              {searching
                ? "Searching…"
                : query.trim()
                  ? `No companies for “${query.trim()}”`
                  : "No companies yet."}
            </p>
          )}
          <CommandGroup>
            {companies.map((company) => (
              <CommandCompanyRow
                key={company.id}
                company={company}
                onSelect={() => run(() => openCompany(company))}
              />
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem
              value="new-company"
              onSelect={() => run(() => setNewCompanyOpen(true))}
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
