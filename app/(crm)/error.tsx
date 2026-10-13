"use client";

import LoadError from "@/components/_common/load-error";

export default function CompaniesError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <LoadError retry={retry} className="min-h-0 flex-1" />;
}
