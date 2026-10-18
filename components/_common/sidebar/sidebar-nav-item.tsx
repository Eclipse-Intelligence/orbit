"use client";

import type { ComponentType, ReactNode, SVGProps } from "react";
import Button from "@/components/_ui/button";
import CountBadge from "@/components/_ui/count-badge";
import { useCompaniesStore } from "@/stores/companies-store";
import { cn } from "@/lib/utils";

type SidebarNavItemProps = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  href?: string;
  count?: number;
  active?: boolean;
  disabled?: boolean;
  tone?: "default" | "quiet";
  iconClassName?: string;
  accessory?: ReactNode;
};

export default function SidebarNavItem({
  icon: Icon,
  label,
  href,
  count,
  active = false,
  disabled = false,
  tone = "default",
  iconClassName,
  accessory,
}: SidebarNavItemProps) {
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);

  return (
    <li className={cn("relative", active && "mb-0.75")}>
      <Button
        variant="nav"
        size="md"
        href={disabled ? undefined : href}
        onClick={() => setSidebarOpen(false)}
        data-active={active}
        aria-current={active ? "page" : undefined}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        title={disabled ? "Not available yet" : undefined}
        className={cn(
          "group h-[30px] gap-1.5 py-0 data-[active=true]:h-8",
          tone === "quiet" && "text-subtle",
        )}
      >
        <Icon
          aria-hidden
          className={cn(
            "text-subtle ease-power3-out group-hover:text-icon group-data-[active=true]:text-icon size-3.5 shrink-0 transition-colors duration-150",
            iconClassName,
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {count !== undefined && <CountBadge>{count}</CountBadge>}
        {disabled && <span className="sr-only">Not available yet</span>}
        {accessory && <span aria-hidden className="w-5 shrink-0" />}
      </Button>
      {accessory && <span className="absolute inset-y-0 right-1 flex items-center">{accessory}</span>}
    </li>
  );
}
