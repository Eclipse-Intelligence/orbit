"use client";

import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { ScrollArea } from "@/components/_ui/scroll-area";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/_ui/sheet";
import { signOutAction } from "@/app/(crm)/actions";
import { displayInitials } from "@/lib/companies";
import { useCompaniesStore } from "@/stores/companies-store";
import type { Viewer } from "@/components/crm/viewer";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export default function Profile({ viewer }: { viewer: Viewer }) {
  const router = useRouter();
  const profileOpen = useCompaniesStore((state) => state.profileOpen);
  const closeProfile = useCompaniesStore((state) => state.closeProfile);

  function showMine() {
    closeProfile();
    router.replace(`/?owner=${viewer.id}`, { scroll: false });
  }

  return (
    <Sheet open={profileOpen} onOpenChange={(open) => !open && closeProfile()}>
      <SheetContent side="right" className="sm:w-[480px] sm:max-w-[480px]">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <UsersIcon aria-hidden className="text-icon size-3.5" />
            <SheetTitle>Account</SheetTitle>
          </div>
          <SheetDescription className="sr-only">
            Signed-in user and workspace
          </SheetDescription>
          <SheetClose asChild>
            <Button variant="ghost" size="icon-sm" className="-mr-1" aria-label="Close">
              <XIcon aria-hidden className="text-foreground size-4" />
            </Button>
          </SheetClose>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex items-center gap-3 p-5 shadow-[inset_0_-1px_0_var(--line-strong)]">
            <span
              aria-hidden
              className="bg-muted flex size-[50px] items-center justify-center rounded-full text-[16px] shadow-[0px_6.25px_6.25px_0px_rgba(15,15,15,0.24),0px_0px_0px_1.563px_#232323]"
            >
              {displayInitials(viewer.name)}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="truncate">{viewer.name}</h2>
              <span className="caption-style text-soft block truncate">
                {[ROLE_LABELS[viewer.role] ?? viewer.role, viewer.workspaceName].filter(Boolean).join(" · ")}
              </span>
              <a
                href={`mailto:${viewer.email}`}
                className="caption-style text-soft hover:text-foreground ease-power3-in-out block truncate transition-colors duration-150"
              >
                {viewer.email}
              </a>
            </div>
          </div>
        </ScrollArea>

        <SheetFooter>
          <form action={signOutAction}>
            <Button type="submit" variant="subtle" size="sm">
              Sign out
            </Button>
          </form>
          <Button variant="primary" size="sm" onClick={showMine}>
            My companies
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
