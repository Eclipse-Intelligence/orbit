"use client";

import { useState, type ReactNode } from "react";
import { QuietTabs } from "@/components/crm/contact-activities";
import { cn } from "@/lib/utils";

type Pane = "details" | "activity";

export default function RecordLayout({
  summary,
  details,
  activity,
  activityCount,
}: {
  summary?: ReactNode;
  details: ReactNode;
  activity: ReactNode;
  activityCount?: number;
}) {
  const [pane, setPane] = useState<Pane>("details");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-20 lg:grid lg:grid-cols-[minmax(360px,2fr)_minmax(0,3fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden lg:pb-0">
      <div className="border-border min-w-0 lg:overflow-y-auto lg:border-r">
        {summary}
        <div className="border-line-strong border-b px-4 py-2 lg:hidden">
          <QuietTabs
            label="Show"
            items={[
              { id: "details", label: "Details" },
              { id: "activity", label: "Activity", count: activityCount },
            ]}
            value={pane}
            onChange={setPane}
          />
        </div>
        <div className={cn(pane !== "details" && "max-lg:hidden")}>
          {details}
        </div>
      </div>
      <div className={cn("min-w-0 lg:overflow-y-auto lg:pb-20", pane !== "activity" && "max-lg:hidden")}>
        {activity}
      </div>
    </div>
  );
}
