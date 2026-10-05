"use client";

import type { ReactNode } from "react";
import Profile from "@/components/companies/profile/profile";
import type { Viewer } from "@/components/crm/viewer";

export default function CrmChrome({
  viewer,
  children,
}: {
  viewer: Viewer;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
      <Profile viewer={viewer} />
    </div>
  );
}
