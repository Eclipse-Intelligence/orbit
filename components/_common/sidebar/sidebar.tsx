"use client";

import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/_ui/sheet";
import SidebarContent from "./sidebar-content";
import SidebarResizer from "./sidebar-resizer";
import type { WorkspaceChoice } from "@/lib/auth/user";
import type { BoardSummary } from "@/lib/crm/types";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { useCompaniesStore } from "@/stores/companies-store";

export type SidebarWorkspace = { id: string; name: string; viewerName: string; choices: WorkspaceChoice[] };

type SidebarProps = {
  boards: BoardSummary[];
  companyCount: number;
  openActionCount: number;
  workspace: SidebarWorkspace;
};

export default function Sidebar({ boards, companyCount, openActionCount, workspace }: SidebarProps) {
  const sidebarOpen = useCompaniesStore((state) => state.sidebarOpen);
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);

  return (
    <>
      <aside className="relative hidden w-(--sidebar-width) shrink-0 bg-sidebar sidebar-collapsed:lg:hidden docs-focus:lg:hidden lg:flex lg:flex-col">
        <SidebarContent
          boards={boards}
          companyCount={companyCount}
          openActionCount={openActionCount}
          workspace={workspace}
          settingsHref={SETTINGS_PATHS.general}
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
            workspace={workspace}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
