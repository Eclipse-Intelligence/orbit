"use client";

import { useState } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import Markdown from "@/components/assistant/markdown";
import { dismissBriefAction } from "@/app/(crm)/settings/learning/actions";
import type { Brief } from "@/lib/learning/nightly";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";

export default function MorningBrief({ brief }: { brief: Brief }) {
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (hidden) return null;
  const date = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" }).format(new Date(`${brief.day}T12:00:00Z`));
  return (
    <section aria-labelledby="brief-heading" className="animate-rise-in flex flex-col gap-3 rounded-2xl bg-white/[0.03] px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2">
        <SparkleIcon aria-hidden className="text-primary-foreground size-3.5 shrink-0" />
        <h2 id="brief-heading" className="text-foreground text-[15px] font-medium">
          Morning brief
        </h2>
        <span className="caption-style text-subtle">{date}</span>
      </div>
      <div className="text-soft text-[14px] leading-[1.55]">
        <Markdown text={brief.body} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            const result = await dismissBriefAction(brief.id);
            if (result.error) setError(result.error);
            else setHidden(true);
          }}
        >
          Dismiss
        </Button>
        <Link href="/settings/learning" className="caption-style text-subtle hover:text-foreground rounded-full px-2 py-1 underline-offset-2 hover:underline">
          What Orbit has learned
        </Link>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
