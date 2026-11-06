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
import { NO_CAPTURE_COUNTS, useCompaniesStore } from "@/stores/companies-store";

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
  const waiting = capture?.waiting ?? 0;
  const fresh = capture?.fresh ?? 0;
  const newestAt = capture?.newestAt ?? null;
  const sections = capture?.sections ?? NO_CAPTURE_COUNTS;
  const { approvals, followUps, replies, tasks, toFile } = sections;

  useEffect(() => {
    setCapture({ waiting, fresh, newestAt, sections: { approvals, followUps, replies, tasks, toFile } });
  }, [setCapture, waiting, fresh, newestAt, approvals, followUps, replies, tasks, toFile]);

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
