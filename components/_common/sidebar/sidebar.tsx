"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/_ui/sheet";
import SidebarContent from "./sidebar-content";
import SidebarResizer from "./sidebar-resizer";
import type { BoardSummary } from "@/lib/crm/types";
import { useCompaniesStore } from "@/stores/companies-store";

type SidebarProps = {
  boards: BoardSummary[];
  approvals: number;
  companyCount: number;
  openActionCount: number;
  mailUnread: number;
  workspaceName: string;
};

export default function Sidebar({ boards, approvals, companyCount, openActionCount, mailUnread, workspaceName }: SidebarProps) {
  const sidebarOpen = useCompaniesStore((state) => state.sidebarOpen);
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);

  return (
    <>
      <aside className="relative hidden w-(--sidebar-width) shrink-0 border-r border-sidebar-border bg-sidebar sidebar-collapsed:lg:hidden lg:flex lg:flex-col">
        <SidebarContent
          boards={boards}
          approvals={approvals}
          companyCount={companyCount}
          openActionCount={openActionCount}
          mailUnread={mailUnread}
          workspaceName={workspaceName}
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
            Companies, contacts, opportunities, activities, and tasks.
          </SheetDescription>
          <SidebarContent
            boards={boards}
            approvals={approvals}
            companyCount={companyCount}
            openActionCount={openActionCount}
          mailUnread={mailUnread}
            workspaceName={workspaceName}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
