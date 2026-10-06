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

export function ExpandSidebarButton() {
  return (
    <Button
      variant="secondary"
      size="icon"
      className="hidden sidebar-collapsed:lg:inline-flex"
      aria-label="Expand sidebar"
      title="Expand sidebar"
      onClick={() => setSidebarCollapsed(false)}
    >
      <PanelIcon aria-hidden className="size-3.5" />
    </Button>
  );
}
