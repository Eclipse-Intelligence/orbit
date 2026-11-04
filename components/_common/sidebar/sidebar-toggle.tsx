"use client";

import Button from "@/components/_ui/button";
import { setSidebarCollapsed } from "@/lib/sidebar";
import PanelIcon from "@/public/assets/images/_common/sidebar-panel.svg";

export function CollapseSidebarButton() {
  return (
    <Button
      variant="secondary"
      size="icon-sm"
      className="hidden shrink-0 lg:inline-flex"
      aria-label="Collapse sidebar"
      title="Collapse sidebar"
      onClick={() => setSidebarCollapsed(true)}
    >
      <PanelIcon aria-hidden className="size-3.5" />
    </Button>
  );
}

export function NewDot() {
  return <span aria-hidden className="bg-primary ring-background absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2" />;
}

export function ExpandSidebarButton({ dot = false }: { dot?: boolean }) {
  return (
    <Button
      variant="secondary"
      size="icon"
      className="relative hidden sidebar-collapsed:lg:inline-flex"
      aria-label={dot ? "Expand sidebar, new in Capture" : "Expand sidebar"}
      title="Expand sidebar"
      onClick={() => setSidebarCollapsed(false)}
    >
      <PanelIcon aria-hidden className="size-3.5" />
      {dot && <NewDot />}
    </Button>
  );
}
