"use client";

import Button from "@/components/_ui/button";

export default function CompaniesError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1>Companies could not be loaded</h1>
      <p className="text-muted-foreground max-w-[36rem]">
        The workspace data is unavailable right now. Try again once the database
        is reachable.
      </p>
      <Button variant="primary" size="md" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
