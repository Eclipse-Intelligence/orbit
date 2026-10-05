"use client";

import type { MouseEvent } from "react";
import { Checkbox } from "@/components/_ui/checkbox";
import { TableCell, TableRow } from "@/components/_ui/table";
import {
  ConnectionMark,
  lifecycleTagBase,
  Monogram,
  RecordTag,
} from "@/components/beautifui/record-marks";
import { LIFECYCLE_LABELS, relativeWhen } from "@/lib/companies";
import type { Company } from "@/lib/crm/types";
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
  selected: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
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
  selected,
  active,
  onToggle,
  onOpen,
}: CompanyRowProps) {
  const revealed = selected || active;
  const tags = [
    { label: LIFECYCLE_LABELS[company.lifecycle], base: lifecycleTagBase(company.lifecycle) },
    ...(company.industry ? [{ label: company.industry, base: undefined }] : []),
    ...(company.sizeCategory ? [{ label: company.sizeCategory, base: undefined }] : []),
  ];

  return (
    <TableRow
      role="row"
      onClick={onOpen}
      data-active={active || selected}
      className={cn(
        TABLE_ROW_CLASS,
        "group hover:bg-card/60 data-[active=true]:bg-card cursor-pointer",
      )}
    >
      <TableCell role="cell" className={cellClass("name")}>
        <span className="flex min-w-[240px] items-center gap-2">
          <span className="relative flex size-6 shrink-0 items-center justify-center">
            <span
              className={cn(
                "text-faint text-[11.5px] tabular-nums opacity-0 [@media(hover:hover)]:opacity-100",
                "[@media(hover:hover)]:group-hover:opacity-0! [@media(hover:hover)]:group-focus-within:opacity-0!",
                revealed && "opacity-0!",
              )}
            >
              {index + 1}
            </span>
            <Checkbox
              checked={selected}
              onCheckedChange={onToggle}
              onClick={stop}
              aria-label={`Select ${company.name}`}
              className={cn(
                "absolute [@media(hover:hover)]:opacity-0",
                "[@media(hover:hover)]:group-hover:opacity-100! [@media(hover:hover)]:group-focus-within:opacity-100!",
                revealed && "opacity-100!",
              )}
            />
          </span>
          <Monogram name={company.name} />
          <span className="max-w-[220px] truncate text-[13px] font-medium">{company.name}</span>
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
        {relativeWhen(company.lastInteractionAt)}
      </TableCell>
      <TableCell role="cell" className={cellClass("strength")}>
        <ConnectionMark at={company.lastInteractionAt} />
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
          <span className="text-faint">—</span>
        )}
      </TableCell>
      <TableCell role="cell" className={cn(cellClass("owner"), "text-subtle text-[13px]")}>
        {company.ownerName ?? "Unassigned"}
      </TableCell>
    </TableRow>
  );
}
