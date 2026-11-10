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
      <h1>Couldn&apos;t load this page</h1>
      <Button variant="primary" size="md" onClick={retry}>
        Try again
      </Button>
    </section>
  );
}
