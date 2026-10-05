"use client";

import type { MouseEvent } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import Tag from "@/components/_ui/tag";
import { TableCell, TableRow } from "@/components/_ui/table";
import { LIFECYCLE_LABELS } from "@/lib/companies";
import { formatDate } from "@/lib/companies";
import type { Company } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import {
  TABLE_CELL_CLASS,
  TABLE_ROW_CLASS,
  columnClass,
  type TableColumnKey,
} from "./table-columns";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import DotsIcon from "@/public/assets/images/companies/table/dots-horizontal.svg";

type CompanyRowProps = {
  company: Company;
  selected: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
};

const LIFECYCLE_TONE = {
  lead: "amber",
  prospect: "blue",
  customer: "green",
  churned: "neutral",
} as const;

function cellClass(key: TableColumnKey) {
  return cn(TABLE_CELL_CLASS, columnClass(key));
}

function stop(event: MouseEvent) {
  event.stopPropagation();
}

export default function CompanyRow({
  company,
  selected,
  active,
  onToggle,
  onOpen,
}: CompanyRowProps) {
  return (
    <TableRow
      role="row"
      onClick={onOpen}
      data-active={active || selected}
      className={cn(
        TABLE_ROW_CLASS,
        "hover:bg-card/60 data-[active=true]:border-card data-[active=true]:bg-card cursor-pointer",
      )}
    >
      <TableCell role="cell" className={cellClass("name")}>
        <span className="flex items-center gap-5">
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            onClick={stop}
            aria-label={`Select ${company.name}`}
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{company.name}</span>
          </span>
        </span>
      </TableCell>
      <TableCell role="cell" className={cellClass("domain")}>
        {company.domain ?? "—"}
      </TableCell>
      <TableCell role="cell" className={cellClass("industry")}>
        {company.industry ?? "—"}
      </TableCell>
      <TableCell role="cell" className={cellClass("lifecycle")}>
        <Tag tone={LIFECYCLE_TONE[company.lifecycle]} size="sm">
          {LIFECYCLE_LABELS[company.lifecycle]}
        </Tag>
      </TableCell>
      <TableCell role="cell" className={cellClass("owner")}>
        {company.ownerName ?? "Unassigned"}
      </TableCell>
      <TableCell role="cell" className={cellClass("updated")}>
        <span className="flex items-center gap-1">
          <CalendarIcon aria-hidden className="text-foreground size-3.5 shrink-0" />
          <span className="tabular-nums">{formatDate(company.updatedAt)}</span>
        </span>
      </TableCell>
      <TableCell role="cell" className={cellClass("action")} onClick={stop}>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("text-foreground", active && "bg-white/6")}
          aria-label={`Open ${company.name} details`}
          onClick={onOpen}
        >
          <DotsIcon aria-hidden className="size-3" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
