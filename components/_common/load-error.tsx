"use client";

import Button from "@/components/_ui/button";
import { cn } from "@/lib/utils";

export default function LoadError({
  retry,
  className,
}: {
  retry: () => void;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col items-center justify-center gap-4 px-6 text-center",
        className,
      )}
    >
      <h1>This page could not be loaded</h1>
      <p className="text-muted-foreground max-w-[36rem]">
        Orbit couldn&apos;t load this page. Check your connection, then try
        again.
      </p>
      <Button variant="primary" size="md" onClick={retry}>
        Try again
      </Button>
    </section>
  );
}
