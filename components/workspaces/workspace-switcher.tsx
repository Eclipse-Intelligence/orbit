"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import NewWorkspaceDialog from "@/components/workspaces/new-workspace-dialog";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import { switchWorkspaceAction } from "@/app/(crm)/workspaces";
import type { WorkspaceChoice } from "@/lib/auth/user";
import { sectionIndex } from "@/lib/workspace-paths";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import Logo from "@/public/assets/images/_common/logo.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

export default function WorkspaceSwitcher({
  workspaces,
  currentId,
  currentName,
  viewerName,
}: {
  workspaces: WorkspaceChoice[];
  currentId: string;
  currentName: string;
  viewerName: string;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = workspaces.some((item) => item.role === "owner");
  const waiting = workspaces.filter((item) => item.waiting && item.id !== currentId);

  async function choose(id: string) {
    if (id === currentId || pending) return;
    setPending(true);
    setError(null);
    const result = await switchWorkspaceAction(id);
    if (result.error) {
      setPending(false);
      setError(result.error);
      return;
    }
    window.location.assign(sectionIndex(pathname));
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col max-lg:mr-7">
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={touchOpen}>
        <DropdownMenuTrigger
          asChild
          onPointerDown={(event) => {
            const touch = event.pointerType !== "mouse";
            setTouchOpen(touch);
            if (touch) event.preventDefault();
          }}
          onClick={() => {
            if (touchOpen && !pending) setMenuOpen((open) => !open);
          }}
        >
          <Button
            variant="ghost"
            size="none"
            aria-label={`Workspace: ${currentName}. Switch workspace${waiting.length ? `. New in Capture in ${waiting.map((item) => item.name).join(" and ")}` : ""}`}
            disabled={pending}
            className="text-foreground hover:text-foreground -m-1 min-w-0 flex-1 justify-start gap-2 rounded-lg p-1 text-left font-normal active:scale-100 data-[state=open]:bg-white/6"
          >
            <Logo aria-hidden className="size-8 shrink-0 overflow-visible" />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="lead-style block truncate font-medium tracking-[-0.01em]">Orbit</span>
              <span className="caption-style text-subtle flex min-w-0 items-center gap-1">
                <span className="truncate">{currentName}</span>
                <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                {waiting.length > 0 && <span aria-hidden className="bg-primary size-1.5 shrink-0 rounded-full" />}
              </span>
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={10} className="w-[14.5rem]">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {workspaces.map((item) => {
            const selected = item.id === currentId;
            return (
              <DropdownMenuItem
                key={item.id}
                aria-current={selected ? "true" : undefined}
                className="max-lg:py-2.5"
                onSelect={() => void choose(item.id)}
              >
                <WorkspaceTile id={item.id} name={item.name} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {item.waiting && !selected && (
                  <span className="bg-primary size-1.5 shrink-0 rounded-full">
                    <span className="sr-only">New in Capture</span>
                  </span>
                )}
                {selected && (
                  <>
                    <CheckIcon aria-hidden className="text-foreground size-3.5 shrink-0" />
                    <span className="sr-only">(current)</span>
                  </>
                )}
              </DropdownMenuItem>
            );
          })}
          {canCreate && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-soft max-lg:py-2.5" onSelect={() => setCreating(true)}>
                <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
                  <PlusIcon className="size-3.5" />
                </span>
                New workspace
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <p role="alert" className="caption-style text-danger mt-2">
          {error}
        </p>
      )}
      {canCreate && (
        <NewWorkspaceDialog
          open={creating}
          onOpenChange={setCreating}
          defaultName={viewerName}
          onCreated={() => window.location.assign(sectionIndex(pathname))}
        />
      )}
    </div>
  );
}
