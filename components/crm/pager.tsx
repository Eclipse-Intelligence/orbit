"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import { MAX_PAGE, PAGE_SIZE } from "@/components/crm/paging";
import { cn } from "@/lib/utils";

export default function Pager({
  page,
  count,
  total,
  noun,
  always = false,
  className,
}: {
  page: number;
  count: number;
  total: number;
  noun: [string, string];
  always?: boolean;
  className?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const start = (page - 1) * PAGE_SIZE;
  const hasPrevious = page > 1;
  const hasNext = start + count < total && page < MAX_PAGE;
  if (!always && !hasPrevious && !hasNext) return null;

  function href(target: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (target > 1) params.set("page", String(target));
    else params.delete("page");
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  const label =
    !hasPrevious && !hasNext
      ? `${count} ${count === 1 ? noun[0] : noun[1]}`
      : count === 0
        ? `No ${noun[1]} on this page · ${total} total`
        : `Showing ${start + 1}–${start + count} of ${total} ${noun[1]}`;

  return (
    <div
      data-quick-add-avoid="mobile"
      className={cn(
        "caption-style border-border flex shrink-0 items-center justify-between gap-3 py-3 pl-4 pr-4 md:pr-20",
        className,
      )}
    >
      <span className="text-foreground">{label}</span>
      {(hasPrevious || hasNext) && (
        <span className="flex items-center gap-1">
          {hasPrevious && (
            <Button variant="ghost" size="sm" href={href(page - 1)} data-shortcut="page-prev" title="Previous page ([)">
              Previous
            </Button>
          )}
          {hasNext && (
            <Button variant="ghost" size="sm" href={href(page + 1)} data-shortcut="page-next" title="Next page (])">
              Next
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
