"use client";

import LoadError from "@/components/_common/load-error";

export default function AppError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <LoadError retry={retry} className="min-h-dvh" />;
}
