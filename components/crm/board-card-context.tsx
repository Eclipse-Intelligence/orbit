"use client";

import TaskTitle from "@/components/crm/task-title";
import { useEffect, useState } from "react";
import Link from "next/link";
import ActivityPad from "@/components/crm/activity-pad";
import { cardContextAction } from "@/app/(crm)/boards";
import { formatWhen, relativeWhen } from "@/lib/companies";
import { companyHref } from "@/lib/crm/hrefs";
import type { Activity, Task } from "@/lib/crm/types";

const TYPE_LABELS: Partial<Record<Activity["type"], string>> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  note: "Note",
};

export default function BoardCardContext({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [loaded, setLoaded] = useState<{ companyId: string; activities: Activity[]; tasks: Task[] } | null>(null);
  const [added, setAdded] = useState<Activity[]>([]);

  useEffect(() => {
    let live = true;
    void cardContextAction(companyId).then((result) => {
      if (live) setLoaded({ companyId, activities: result.activities, tasks: result.tasks });
    });
    return () => {
      live = false;
    };
  }, [companyId]);

  const current = loaded?.companyId === companyId ? loaded : null;
  const activities = [...added.filter((item) => item.companyId === companyId), ...(current?.activities ?? [])].slice(0, 5);

  return (
    <div className="flex flex-col gap-5">
      <ActivityPad fixedCompany={{ id: companyId, name: companyName }} onAdded={(activity) => setAdded((list) => [activity, ...list])} />
      <section className="flex flex-col gap-2" aria-label="Recent activity">
        <div className="flex items-center justify-between gap-2">
          <span className="caption-style text-subtle">Recent activity</span>
          <Link href={companyHref(companyId)} className="caption-style text-subtle hover:text-foreground underline underline-offset-2">
            Open {companyName}
          </Link>
        </div>
        {!current && added.length === 0 ? (
          <p className="caption-style text-subtle">Loading…</p>
        ) : activities.length === 0 ? (
          <p className="caption-style text-subtle">No activity</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {activities.map((activity) => (
              <li key={activity.id} className="flex flex-col gap-0.5">
                <span className="truncate text-[14px] leading-5">
                  {activity.title || TYPE_LABELS[activity.type] || "Activity"}
                </span>
                <span className="caption-style text-subtle" title={formatWhen(activity.occurredAt)}>
                  {[TYPE_LABELS[activity.type] ?? activity.type, relativeWhen(activity.occurredAt)].join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {current && current.tasks.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Open tasks">
          <span className="caption-style text-subtle">Open tasks</span>
          <ul className="flex flex-col gap-2.5">
            {current.tasks.map((task) => (
              <li key={task.id} className="flex flex-col gap-0.5">
                <span className="truncate text-[14px] leading-5"><TaskTitle task={task} /></span>
                {task.dueAt && <span className="caption-style text-subtle">Due {formatWhen(task.dueAt)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
