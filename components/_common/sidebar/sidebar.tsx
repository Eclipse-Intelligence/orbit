"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/_ui/sheet";
import SidebarContent from "./sidebar-content";
import SidebarResizer from "./sidebar-resizer";
import { useCompaniesStore } from "@/stores/companies-store";

type SidebarProps = {
  companyCount: number;
  openActionCount: number;
  workspaceName: string;
};

export default function Sidebar({ companyCount, openActionCount, workspaceName }: SidebarProps) {
  const sidebarOpen = useCompaniesStore((state) => state.sidebarOpen);
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);

  return (
    <>
      <aside className="relative hidden w-(--sidebar-width) shrink-0 border-r border-sidebar-border bg-sidebar lg:flex lg:flex-col">
        <SidebarContent
          companyCount={companyCount}
          openActionCount={openActionCount}
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
            Companies, contacts, opportunities, activities, and next actions.
          </SheetDescription>
          <SidebarContent
            companyCount={companyCount}
            openActionCount={openActionCount}
            workspaceName={workspaceName}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
