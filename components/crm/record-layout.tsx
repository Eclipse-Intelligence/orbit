import type { ReactNode } from "react";

export default function RecordLayout({
  details,
  activity,
}: {
  details: ReactNode;
  activity: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-20 lg:grid lg:grid-cols-[minmax(360px,2fr)_minmax(0,3fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden lg:pb-0">
      <div className="border-border min-w-0 border-b lg:overflow-y-auto lg:border-r lg:border-b-0">
        {details}
      </div>
      <div className="min-w-0 lg:overflow-y-auto lg:pb-20">{activity}</div>
    </div>
  );
}
