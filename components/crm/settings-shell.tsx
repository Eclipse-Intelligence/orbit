"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import SectionHeader from "@/components/crm/section-header";
import SettingsHashRedirect from "@/components/crm/settings-hash-redirect";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import type { Viewer } from "@/components/crm/viewer";
import { SETTINGS_PATHS, SETTINGS_ROOT, settingsNav, type SettingsNavGroup } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function GroupHeading({ group, workspace, phone }: { group: SettingsNavGroup; workspace: { id: string; name: string }; phone?: boolean }) {
  if (!group.heading) return null;
  return (
    <div className={cn("flex flex-col gap-1", phone ? "px-1 pt-2 pb-1" : "px-2 pb-1")}>
      <h2 className="eyebrow-style text-subtle flex min-w-0 items-center gap-1.5 text-[11px]">
        {group.kind === "workspace" && (
          <WorkspaceTile id={workspace.id} name={workspace.name} className="size-3.5 rounded-[4px] text-[8px] tracking-normal" />
        )}
        <span className="truncate">{group.heading}</span>
      </h2>
      {group.caption && <p className="caption-style text-subtle">{group.caption}</p>}
    </div>
  );
}

export default function SettingsShell({
  viewer,
  workspace,
  multi,
  children,
}: {
  viewer: Viewer;
  workspace: { id: string; name: string };
  multi: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const content = useRef<HTMLDivElement>(null);
  const groups = settingsNav({ name: workspace.name, multi });
  const atRoot = pathname === SETTINGS_ROOT || pathname === `${SETTINGS_ROOT}/`;

  useEffect(() => {
    if (window.location.hash) return;
    content.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SettingsHashRedirect />
      <SectionHeader title="Settings" viewer={viewer} />
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="border-border hidden w-[15em] shrink-0 overflow-y-auto border-r lg:block">
          <div className="flex flex-col gap-5 p-3">
            {groups.map((group) => (
              <div key={group.kind} className="flex flex-col gap-1">
                <GroupHeading group={group} workspace={workspace} />
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const active = isActive(atRoot ? SETTINGS_PATHS.general : pathname, item.href);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "text-sidebar-foreground hover:text-foreground focus-visible:ring-ring/60 flex h-[30px] items-center rounded-lg px-2 text-[14px] leading-none transition-colors duration-150 outline-none focus-visible:ring-2",
                            active &&
                              "bg-sidebar-primary text-foreground shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]",
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <div ref={content} className="min-h-0 min-w-0 flex-1 overflow-auto px-4 pt-4 pb-20 sm:px-6 lg:px-10 lg:pt-8">
          {atRoot ? (
            <nav aria-label="Settings sections" className="mx-auto flex w-full max-w-[47.5em] flex-col gap-4 lg:hidden">
              {groups.map((group) => (
                <div key={group.kind} className="flex flex-col">
                  <GroupHeading group={group} workspace={workspace} phone />
                  <ul className="divide-border flex flex-col divide-y">
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className="text-soft hover:text-foreground focus-visible:ring-ring/60 flex min-h-12 items-center justify-between gap-3 rounded-lg px-1 text-[16px] transition-colors duration-150 outline-none focus-visible:ring-2"
                        >
                          {item.label}
                          <ChevronRightIcon aria-hidden className="text-faint size-4 shrink-0" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          ) : (
            <Link
              href={SETTINGS_ROOT}
              className="text-subtle hover:text-foreground focus-visible:ring-ring/60 -ml-1 mb-4 inline-flex h-8 items-center gap-1 rounded-lg px-1 text-[14px] transition-colors duration-150 outline-none focus-visible:ring-2 lg:hidden"
            >
              <ChevronLeftIcon aria-hidden className="size-4 shrink-0" />
              Settings
            </Link>
          )}
          {children}
        </div>
      </div>
    </section>
  );
}
