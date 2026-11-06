"use client";

import { useEffect } from "react";
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/_ui/sheet";
import SidebarContent from "./sidebar-content";
import SidebarResizer from "./sidebar-resizer";
import type { CaptureStatus } from "@/lib/crm/capture";
import type { WorkspaceChoice } from "@/lib/auth/user";
import type { BoardSummary } from "@/lib/crm/types";
import { CAPTURE_SECTIONS, NO_CAPTURE_COUNTS, useCompaniesStore, type CaptureCounts } from "@/stores/companies-store";

export type SidebarWorkspace = { id: string; name: string; viewerName: string; choices: WorkspaceChoice[] };

type SidebarProps = {
  boards: BoardSummary[];
  companyCount: number;
  openActionCount: number;
  mailUnread: number;
  capture: CaptureStatus | null;
  workspace: SidebarWorkspace;
};

export default function Sidebar({ boards, companyCount, openActionCount, mailUnread, capture, workspace }: SidebarProps) {
  const sidebarOpen = useCompaniesStore((state) => state.sidebarOpen);
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);
  const setCapture = useCompaniesStore((state) => state.setCapture);
  useEffect(() => {
    const known = useCompaniesStore.getState().capture;
    const read = capture?.sections ?? NO_CAPTURE_COUNTS;
    const unread = new Set(capture?.failed ?? []);
    const sections = Object.fromEntries(
      CAPTURE_SECTIONS.map((id) => [id, unread.has(id) ? (known?.sections[id] ?? 0) : read[id]]),
    ) as CaptureCounts;
    setCapture({
      waiting: CAPTURE_SECTIONS.reduce((sum, id) => sum + sections[id], 0),
      fresh: capture?.fresh ?? 0,
      newestAt: capture?.newestAt ?? null,
      sections,
    });
  }, [setCapture, capture]);

  return (
    <>
      <aside className="relative hidden w-(--sidebar-width) shrink-0 border-r border-sidebar-border bg-sidebar sidebar-collapsed:lg:hidden docs-focus:lg:hidden lg:flex lg:flex-col">
        <SidebarContent
          boards={boards}
          companyCount={companyCount}
          openActionCount={openActionCount}
          mailUnread={mailUnread}
          capture={capture}
          workspace={workspace}
        />
        <SidebarResizer />
      </aside>

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          side="left"
          className="w-[254px] max-w-[85vw] border-sidebar-border bg-sidebar"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Companies, contacts, opportunities, and tasks.
          </SheetDescription>
          <SheetCloseButton label="Close menu" className="absolute top-3 right-3 z-10 mr-0" />
          <SidebarContent
            boards={boards}
            companyCount={companyCount}
            openActionCount={openActionCount}
            mailUnread={mailUnread}
            capture={capture}
            workspace={workspace}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
