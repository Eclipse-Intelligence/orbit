"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RowCheckbox } from "@/components/crm/bulk-bar";
import { RowTags } from "@/components/crm/tags";
import CompanyLogo from "@/components/companies/company-logo";
import { TableCell, TableRow } from "@/components/_ui/table";
import {
  ConnectionMark,
  HealthMark,
  lifecycleTagBase,
  RecordTag,
} from "@/components/beautifui/record-marks";
import { lifecycleLabel, relativeWhen } from "@/lib/companies";
import { companyHref } from "@/lib/crm/hrefs";
import type { Company } from "@/lib/crm/types";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import {
  TABLE_CELL_CLASS,
  TABLE_ROW_CLASS,
  columnClass,
  type TableColumnKey,
} from "./table-columns";

type CompanyRowProps = {
  company: Company;
  index: number;
  now: number;
  selected: boolean;
  revealed: boolean;
  selecting: boolean;
  onToggle: (range: boolean) => void;
  logoClientId: string | null;
};

function cellClass(key: TableColumnKey) {
  return cn(TABLE_CELL_CLASS, columnClass(key));
}

function stop(event: MouseEvent) {
  event.stopPropagation();
}

export default function CompanyRow({
  company,
  index,
  now,
  selected,
  revealed,
  selecting,
  onToggle,
  logoClientId,
}: CompanyRowProps) {
  const router = useRouter();
  const href = companyHref(company.id);
  const tags = [
    { label: lifecycleLabel(company.lifecycle), base: lifecycleTagBase(company.lifecycle) },
    ...(company.industry ? [{ label: company.industry, base: undefined }] : []),
    ...(company.sizeCategory ? [{ label: company.sizeCategory, base: undefined }] : []),
  ];

  return (
    <TableRow
      role="row"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a, button, input")) return;
        if (selecting) {
          onToggle(event.shiftKey);
          return;
        }
        if (event.metaKey || event.ctrlKey) {
          window.open(href, "_blank", "noopener");
          return;
        }
        router.push(href);
      }}
      data-active={selected}
      data-list-row=""
      data-row-href={href}
      className={cn(
        TABLE_ROW_CLASS,
        KEYBOARD_ROW_CLASS,
        "group hover:bg-card/60 data-[active=true]:bg-card cursor-pointer",
      )}
    >
      <TableCell role="cell" className={cellClass("name")}>
        <span className="flex min-w-[240px] items-center gap-2">
          <span className="relative flex size-6 shrink-0 items-center justify-center">
            <span
              className={cn(
                "text-subtle text-[11.5px] tabular-nums transition-opacity duration-150 group-focus-within:opacity-0 [@media(hover:hover)]:group-hover:opacity-0",
                revealed && "opacity-0",
              )}
            >
              {index + 1}
            </span>
            <RowCheckbox
              checked={selected}
              label={`Select ${company.name}`}
              revealed={revealed}
              onToggle={onToggle}
              className="absolute"
            />
          </span>
          <CompanyLogo company={company} clientId={logoClientId} />
          <Link
            href={href}
            onClick={(event) => {
              if (!selecting) return;
              event.preventDefault();
              onToggle(event.shiftKey);
            }}
            className="max-w-[220px] truncate text-[13px] font-medium underline-offset-[3px] rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {company.name}
          </Link>
          <RowTags tags={company.tags} className="flex-nowrap" />
        </span>
      </TableCell>
      <TableCell role="cell" className={cellClass("categories")}>
        <span className="flex max-w-[280px] items-center gap-1 overflow-hidden">
          {tags.map((tag) => (
            <RecordTag key={tag.label} label={tag.label} base={tag.base} />
          ))}
        </span>
      </TableCell>
      <TableCell role="cell" className={cn(cellClass("last"), "text-subtle text-[13px]")}>
        {relativeWhen(company.lastInteractionAt, now)}
      </TableCell>
      <TableCell role="cell" className={cellClass("strength")}>
        <ConnectionMark relationship={company.relationship} />
      </TableCell>
      <TableCell role="cell" className={cellClass("health")} title={company.healthReason ?? undefined}>
        {company.health ? <HealthMark health={company.health} /> : <span className="text-subtle text-[13px]">Not set</span>}
      </TableCell>
      <TableCell role="cell" className={cellClass("domain")} onClick={stop}>
        {company.domain ? (
          <a
            href={`https://${company.domain}`}
            target="_blank"
            rel="noreferrer"
            className="max-w-[180px] truncate text-[13px] underline decoration-white/35 underline-offset-[3px] hover:decoration-current"
          >
            {company.domain}
          </a>
        ) : (
          <span className="text-faint"><span aria-hidden>·</span><span className="sr-only">None</span></span>
        )}
      </TableCell>
      <TableCell role="cell" className={cn(cellClass("owner"), "text-subtle text-[13px]")}>
        {company.ownerName ?? "Unassigned"}
      </TableCell>
    </TableRow>
  );
}
