"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import { setThreadDomainRuleAction, setThreadFilingAction } from "@/app/(crm)/mail/actions";
import type { ThreadFiling, WorkspaceChoiceRef } from "@/lib/mail/view";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

function names(list: WorkspaceChoiceRef[]) {
  const labels = list.map((item) => item.name);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : (labels[0] ?? "");
}

function same(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function Tiles({ list }: { list: WorkspaceChoiceRef[] }) {
  return (
    <span aria-hidden className="flex shrink-0">
      {list.map((item, index) => (
        <WorkspaceTile key={item.id} id={item.id} name={item.name} className={index === 0 ? "size-4 rounded-[5px] text-[9px]" : "ring-popover -ml-1 size-4 rounded-[5px] text-[9px] ring-2"} />
      ))}
    </span>
  );
}

export default function ThreadFilingMenu({
  threadKey,
  filing,
  onChange,
  onMessage,
}: {
  threadKey: string;
  filing: ThreadFiling;
  onChange: (filing: ThreadFiling) => void;
  onMessage: (message: { text: string; error: boolean } | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const filed = filing.workspaces.filter((item) => filing.filedIn.includes(item.id));
  const label = names(filed);
  const allIds = filing.workspaces.map((item) => item.id);
  const everyLabel = filing.workspaces.length === 2 ? "Both" : "All";
  const choices = [
    ...filing.workspaces.map((item) => ({ key: item.id, ids: [item.id], label: item.name, tiles: [item] })),
    { key: "all", ids: allIds, label: everyLabel, tiles: filing.workspaces },
  ];

  async function choose(ids: string[], rule: boolean) {
    if (busy) return;
    setBusy(true);
    onMessage(null);
    const result = rule ? await setThreadDomainRuleAction(threadKey, ids) : await setThreadFilingAction(threadKey, ids);
    setBusy(false);
    if (result.error || !result.filing) {
      onMessage({ text: result.error ?? "That didn't file. Try again.", error: true });
      return;
    }
    onChange(result.filing);
    const chosen = names(filing.workspaces.filter((item) => ids.includes(item.id)));
    const kept = result.kept?.length ? ` Earlier emails stay in ${result.kept.join(" and ")}.` : "";
    if (rule) onMessage({ text: `@${filing.domain} now files in ${chosen}.${kept}`, error: false });
    else if (kept) onMessage({ text: kept.trim(), error: false });
  }

  return (
    <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`Filed in ${label}. Change where this email is filed`}
            className="data-[state=open]:text-foreground -mr-1.5 max-w-full min-w-0 gap-1.5 text-[13px] font-normal data-[state=open]:bg-white/6"
          >
            <Tiles list={filed} />
            <span className="truncate">{busy ? "Filing…" : `Filed in ${label}`}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[16rem]">
          <DropdownMenuLabel>File in</DropdownMenuLabel>
          {choices.map((choice) => (
            <DropdownMenuItem key={choice.key} className="max-sm:py-2.5" onSelect={() => void choose(choice.ids, false)}>
              <Tiles list={choice.tiles} />
              <span className="flex-1">{choice.label}</span>
              {same(choice.ids, filing.filedIn) && <span className="text-subtle">Now</span>}
            </DropdownMenuItem>
          ))}
          {filing.domain && (
            <>
              <DropdownMenuLabel>Everyone at @{filing.domain}</DropdownMenuLabel>
              {choices.map((choice) => (
                <DropdownMenuItem key={`domain-${choice.key}`} className="max-sm:py-2.5" onSelect={() => void choose(choice.ids, true)}>
                  <Tiles list={choice.tiles} />
                  <span className="flex-1">{choice.label}</span>
                  {filing.rule && same(choice.ids, filing.rule) && <span className="text-subtle">Now</span>}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
    </DropdownMenu>
  );
}
