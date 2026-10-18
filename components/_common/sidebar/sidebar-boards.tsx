"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { createBoardAction } from "@/app/(crm)/boards";
import type { BoardSummary } from "@/lib/crm/types";
import { useCompaniesStore } from "@/stores/companies-store";
import SidebarNavItem from "./sidebar-nav-item";
import ColumnsIcon from "@/public/assets/images/companies/sidebar/columns.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

export default function SidebarBoards({
  boards,
  open,
  current,
}: {
  boards: BoardSummary[];
  open: boolean;
  current: (href: string) => boolean;
}) {
  const router = useRouter();
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);
  const [naming, setNaming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  async function create(value: string) {
    const name = value.trim();
    if (cancelled.current || !name) {
      cancelled.current = false;
      setNaming(false);
      setError(null);
      return;
    }
    setPending(true);
    const result = await createBoardAction(name);
    setPending(false);
    if (!result.board) {
      setError(result.error ?? "Could not create the board.");
      return;
    }
    setNaming(false);
    setError(null);
    setSidebarOpen(false);
    router.push(`/boards/${result.board.id}`);
  }

  if (!open) return null;

  return (
    <li>
      <ul aria-label="Boards" className="border-sidebar-border mb-1 ml-[15px] flex flex-col border-l pl-1.5">
        {boards.map((board) => (
          <SidebarNavItem
            key={board.id}
            href={`/boards/${board.id}`}
            icon={ColumnsIcon}
            label={board.name}
            count={board.count}
            active={current(`/boards/${board.id}`)}
          />
        ))}
        <li>
          {naming ? (
            <input
              autoFocus
              aria-label="New board name"
              placeholder="Board name"
              maxLength={120}
              disabled={pending}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  cancelled.current = true;
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => create(event.currentTarget.value)}
              className="bg-sidebar-primary text-foreground placeholder:text-subtle focus-visible:ring-ring/60 h-[30px] w-full rounded-lg px-2 text-[14px] outline-none focus-visible:ring-2"
            />
          ) : (
            <Button
              variant="nav"
              size="md"
              className="text-subtle h-[30px] gap-1.5 py-0"
              onClick={() => {
                setError(null);
                setNaming(true);
              }}
            >
              <PlusIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">New board</span>
            </Button>
          )}
          {error && (
            <p role="alert" className="caption-style text-danger px-2 pt-1">
              {error}
            </p>
          )}
        </li>
      </ul>
    </li>
  );
}
