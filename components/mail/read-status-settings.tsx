"use client";

import { useState, useTransition } from "react";
import Switch from "@/components/_ui/switch";
import { setReadStatusesAction } from "@/app/(crm)/mail/actions";

export default function ReadStatusRow({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function change(value: boolean) {
    setOn(value);
    setError(null);
    startTransition(async () => {
      const result = await setReadStatusesAction(value);
      if (result.error) {
        setOn(!value);
        setError(result.error);
      }
    });
  }

  return (
    <div id="read-statuses" className="flex scroll-mt-4 flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col">
          <span className="text-[14px] leading-5">Read statuses</span>
          <span className="caption-style text-subtle">Adds a tracking image to emails you send. Image blocking can hide a read or show one early.</span>
        </span>
        <Switch checked={on} onChange={change} label="Read statuses" />
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
