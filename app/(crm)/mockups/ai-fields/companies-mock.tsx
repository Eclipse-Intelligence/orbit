"use client";

import type { ReactNode } from "react";
import Button from "@/components/_ui/button";
import CountBadge from "@/components/_ui/count-badge";
import { ScrollArea } from "@/components/_ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/_ui/table";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/_ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import FilterMenu from "@/components/_common/filter-menu";
import { HealthMark, lifecycleTagBase, Monogram, RecordTag } from "@/components/beautifui/record-marks";
import SectionHeader from "@/components/crm/section-header";
import { SortHeader } from "@/components/crm/list-controls";
import TableFooter from "@/components/companies/table/table-footer";
import type { Viewer } from "@/components/crm/viewer";
import { RELATIONSHIP_META } from "@/lib/crm/relationship-score";
import { lifecycleLabel } from "@/lib/companies";
import { fitLabel } from "@/lib/enrichment/fit";
import { cn } from "@/lib/utils";
import ShareIcon from "@/public/assets/images/companies/toolbar/share.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import FilterIcon from "@/public/assets/images/_common/filter.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import { AiCellValue, AiHeader, AnswerDetail } from "./ai-cells";
import AddFieldDialog from "./add-field-dialog";
import { AgencyTypeFilter, GeoFilter, SortField, StaffRange, ViewMenu, AiFilterChip } from "./filters";
import { COMPANIES, FIELDS, GEO_PROSPECTS, NORTHLIGHT_GEO, type AiField, type MockCompany, type Scene } from "./mock-data";
import { usePhone } from "./use-phone";

type ColumnKey = "name" | "categories" | "last" | "strength" | "health" | "fit" | "geo" | "staff" | "type" | "domain" | "owner" | "add";

const COLUMNS: { key: ColumnKey; label: string; phoneOrder: string }[] = [
  { key: "name", label: "Company", phoneOrder: "max-sm:order-1" },
  { key: "categories", label: "Categories", phoneOrder: "max-sm:order-6" },
  { key: "last", label: "Last interaction", phoneOrder: "max-sm:order-7" },
  { key: "strength", label: "Relationship", phoneOrder: "max-sm:order-8" },
  { key: "health", label: "Health", phoneOrder: "max-sm:order-9" },
  { key: "fit", label: "Fit", phoneOrder: "max-sm:order-5" },
  { key: "geo", label: "Sells GEO", phoneOrder: "max-sm:order-2" },
  { key: "staff", label: "Staff", phoneOrder: "max-sm:order-3" },
  { key: "type", label: "Agency type", phoneOrder: "max-sm:order-4" },
  { key: "domain", label: "Domain", phoneOrder: "max-sm:order-10" },
  { key: "owner", label: "Owner", phoneOrder: "max-sm:order-11" },
  { key: "add", label: "Add column", phoneOrder: "max-sm:order-12" },
];

const CELL = "flex h-[35px] items-center";
const ROW = "col-span-full grid grid-cols-subgrid";

function fieldOf(key: ColumnKey) {
  return FIELDS.find((field) => field.key === key);
}

function orderOf(key: ColumnKey) {
  return COLUMNS.find((column) => column.key === key)?.phoneOrder;
}

function Relationship({ label }: { label: MockCompany["relationship"] }) {
  const item = RELATIONSHIP_META[label];
  return (
    <span className="text-subtle inline-flex items-center gap-2 text-[13px]">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: item.color }} />
      {item.label}
    </span>
  );
}

function ColumnMenu({ field, children }: { field: AiField; children: ReactNode }) {
  return (
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel>{field.question}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Sort high to low</DropdownMenuItem>
        <DropdownMenuItem>Sort low to high</DropdownMenuItem>
        <DropdownMenuItem>Filter…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Edit field</DropdownMenuItem>
        <DropdownMenuItem>Check all again</DropdownMenuItem>
        <DropdownMenuItem>Hide column</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <PlusIcon aria-hidden className="size-3" />
          Add AI field
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HeaderCell({ column, scene }: { column: (typeof COLUMNS)[number]; scene: Scene }) {
  const field = fieldOf(column.key);
  let body: ReactNode = column.label;
  if (column.key === "add") {
    body = (
      <Button variant="ghost" size="icon-sm" aria-label="Add column" title="Add column">
        <PlusIcon aria-hidden className="size-3" />
      </Button>
    );
  } else if (field) {
    const sorted = scene === "filter" && field.key === "staff" ? "asc" : null;
    const header = <AiHeader field={field} direction={sorted} open={scene === "menu" && field.key === "staff"} />;
    body = scene === "menu" && field.key === "staff" ? <ColumnMenu field={field}>{header}</ColumnMenu> : header;
  } else if (["name", "last", "strength", "domain", "owner", "fit"].includes(column.key)) {
    body = <SortHeader label={column.label} direction={column.key === "name" && scene !== "filter" ? "asc" : null} onSort={() => undefined} />;
  }
  return (
    <TableHead role="columnheader" className={cn(CELL, "justify-start", column.phoneOrder, column.key === "add" && "pr-2")}>
      {column.key === "name" ? (
        <span className="flex items-center gap-2">
          <span className="size-6" />
          {body}
        </span>
      ) : (
        body
      )}
    </TableHead>
  );
}

function Row({ company, index, popover }: { company: MockCompany; index: number; popover?: ReactNode }) {
  const phone = usePhone();
  const tags = [
    { label: lifecycleLabel(company.lifecycle), base: lifecycleTagBase(company.lifecycle) },
    { label: company.size, base: undefined },
  ];
  const ai = (key: "geo" | "staff" | "type") => {
    const field = fieldOf(key);
    if (!field) return null;
    const value = <AiCellValue field={field} cell={company[key]} />;
    const active = Boolean(popover) && key === "geo";
    return (
      <TableCell role="cell" className={cn(CELL, orderOf(key))}>
        {active && !phone ? (
          <Popover open modal={false}>
            <PopoverAnchor asChild>
              <button type="button" aria-expanded className="-mx-1.5 rounded-md bg-white/6 px-1.5 py-1 outline-none">
                {value}
              </button>
            </PopoverAnchor>
            <PopoverContent align="start" side="bottom" className="w-[22rem] p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
              {popover}
            </PopoverContent>
          </Popover>
        ) : (
          <button
            type="button"
            aria-label={`${field.label} for ${company.name}. Show answer and sources`}
            className={cn("-mx-1.5 cursor-pointer rounded-md px-1.5 py-1 outline-none hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-ring/60", active && "bg-white/6")}
          >
            {value}
          </button>
        )}
      </TableCell>
    );
  };
  return (
    <TableRow role="row" className={cn(ROW, "group hover:bg-card/60 cursor-pointer")}>
      <TableCell role="cell" className={cn(CELL, orderOf("name"))}>
        <span className="flex min-w-[240px] items-center gap-2 max-sm:min-w-[172px]">
          <span className="flex size-6 shrink-0 items-center justify-center">
            <span className="text-subtle text-[11.5px] tabular-nums">{index + 1}</span>
          </span>
          <Monogram name={company.name} />
          <span className="max-w-[220px] truncate text-[13px] font-medium max-sm:max-w-[118px]">{company.name}</span>
        </span>
      </TableCell>
      <TableCell role="cell" className={cn(CELL, orderOf("categories"))}>
        <span className="flex max-w-[280px] items-center gap-1 overflow-hidden">
          {tags.map((tag) => (
            <RecordTag key={tag.label} label={tag.label} base={tag.base} />
          ))}
        </span>
      </TableCell>
      <TableCell role="cell" className={cn(CELL, orderOf("last"), "text-subtle text-[13px]")}>
        {company.last}
      </TableCell>
      <TableCell role="cell" className={cn(CELL, orderOf("strength"))}>
        <Relationship label={company.relationship} />
      </TableCell>
      <TableCell role="cell" className={cn(CELL, orderOf("health"))}>
        {company.health ? <HealthMark health={company.health} /> : <span className="text-subtle text-[13px]">Not set</span>}
      </TableCell>
      <TableCell role="cell" className={cn(CELL, orderOf("fit"), "text-[13px] tabular-nums")} title={company.fit === null ? undefined : fitLabel(company.fit)}>
        {company.fit === null ? <span className="text-faint">·</span> : company.fit.toFixed(1)}
      </TableCell>
      {ai("geo")}
      {ai("staff")}
      {ai("type")}
      <TableCell role="cell" className={cn(CELL, orderOf("domain"))}>
        <span className="max-w-[180px] truncate text-[13px] underline decoration-white/35 underline-offset-[3px]">{company.domain}</span>
      </TableCell>
      <TableCell role="cell" className={cn(CELL, orderOf("owner"), "text-subtle text-[13px]")}>
        {company.owner}
      </TableCell>
      <TableCell role="cell" className={cn(CELL, orderOf("add"))} />
    </TableRow>
  );
}

function Toolbar({ scene }: { scene: Scene }) {
  const filtering = scene === "filter";
  return (
    <div className="flex shrink-0 flex-col gap-2 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 sm:hidden">
          <Button variant="secondary" size="sm" aria-label={filtering ? "Filters, 3 active" : "Filters"} className={cn(filtering && "bg-muted")}>
            <FilterIcon aria-hidden className="size-3" />
            Filters
            {filtering && <CountBadge>3</CountBadge>}
          </Button>
          <Button variant="secondary" size="sm">
            <FilterIcon aria-hidden className="size-3" />
            Filter
          </Button>
        </div>
        <div className="hidden min-w-0 flex-wrap items-center gap-2 sm:flex">
          <ViewMenu value={filtering ? "geo" : "all"} />
          <Button variant="secondary" size="none" className="text-subtle h-[30px] gap-2 px-[9px] text-[12px] font-normal">
            <SearchIcon aria-hidden className="size-3" />
            Search companies
          </Button>
          <FilterMenu label="Owner" value="all" options={[{ value: "all", label: "All owners" }]} onChange={() => undefined} />
          <FilterMenu label="Lifecycle" value="any" options={[{ value: "any", label: "Any lifecycle" }]} onChange={() => undefined} />
          <Button variant="secondary" size="none" className="h-[30px] gap-1.5 px-[9px] text-[12px]">
            <FilterIcon aria-hidden className="size-3" />
            Filter
            {filtering && <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[11px] leading-4 tabular-nums">3</span>}
          </Button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" className="sm:hidden">
            Select
          </Button>
          <Button variant="secondary" size="sm" className="max-sm:hidden">
            Import
          </Button>
          <Button variant="secondary" size="sm">
            <ShareIcon aria-hidden className="size-3" />
            Export
          </Button>
          <Button variant="primary" size="sm" shortcut={["C", "O"]}>
            <PlusIcon aria-hidden className="size-3" />
            Add company
          </Button>
        </div>
      </div>
      {filtering && (
        <div className="flex flex-wrap items-center gap-2 max-sm:hidden">
          <AiFilterChip label="Sells GEO" value="Yes" />
          <Popover open modal={false}>
            <PopoverAnchor asChild>
              <span>
                <AiFilterChip label="Staff" value="5 to 30" open />
              </span>
            </PopoverAnchor>
            <PopoverContent align="start" className="w-[min(18rem,calc(100vw-2rem))] p-3" onOpenAutoFocus={(event) => event.preventDefault()}>
              <StaffRange />
            </PopoverContent>
          </Popover>
          <AiFilterChip label="Agency type" value="SEO, Content" />
          <span className="caption-style text-subtle">Sorted by Staff, low to high</span>
        </div>
      )}
    </div>
  );
}

function PhoneFilters() {
  return (
    <Sheet open>
      <SheetContent side="bottom" onInteractOutside={(event) => event.preventDefault()} onOpenAutoFocus={(event) => event.preventDefault()}>
        <SheetHeader className="px-4">
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription className="sr-only">Search, sort, and filter companies</SheetDescription>
          <Button variant="ghost" size="icon-sm" className="-mr-1" aria-label="Close filters">
            <XIcon aria-hidden className="text-foreground size-4" />
          </Button>
        </SheetHeader>
        <ScrollArea viewportClassName="max-h-[calc(85dvh-118px)]">
          <div className="flex flex-col gap-4 p-4">
            <ViewMenu phone value="geo" />
            <SortField />
            <div className="flex flex-col gap-1">
              <span className="eyebrow-style text-subtle px-2 py-1.5">AI fields</span>
              <GeoFilter />
              <div className="px-2 py-1.5">
                <StaffRange compact />
              </div>
              <AgencyTypeFilter />
            </div>
          </div>
        </ScrollArea>
        <div className="border-line-strong flex shrink-0 items-center justify-between gap-2 border-t px-4 py-3">
          <Button variant="ghost" size="sm">
            Clear
          </Button>
          <span className="flex items-center gap-1">
            <Button variant="secondary" size="sm">
              Save view
            </Button>
            <Button variant="primary" size="sm">
              Show {GEO_PROSPECTS.length}
            </Button>
          </span>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PhoneAnswer() {
  return (
    <Sheet open>
      <SheetContent side="bottom" onInteractOutside={(event) => event.preventDefault()} onOpenAutoFocus={(event) => event.preventDefault()}>
        <SheetHeader className="px-4">
          <SheetTitle>{NORTHLIGHT_GEO.company}</SheetTitle>
          <SheetDescription className="sr-only">AI field answer and sources</SheetDescription>
          <Button variant="ghost" size="icon-sm" className="-mr-1" aria-label="Close">
            <XIcon aria-hidden className="text-foreground size-4" />
          </Button>
        </SheetHeader>
        <ScrollArea viewportClassName="max-h-[calc(85dvh-56px)]">
          <AnswerDetail {...NORTHLIGHT_GEO} />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export default function CompaniesMock({ scene, viewer }: { scene: Scene; viewer: Viewer }) {
  const phone = usePhone();
  const rows = scene === "filter" ? GEO_PROSPECTS : COMPANIES;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Companies" viewer={viewer} />
      <Toolbar scene={scene} />
      <div className="border-border flex min-h-0 flex-1 flex-col border-t">
        <ScrollArea orientation="both" className="min-h-0 flex-1">
          <Table role="table" className="grid w-full min-w-max grid-cols-[repeat(12,max-content)] justify-between pb-24">
            <TableHeader role="rowgroup" className="contents">
              <TableRow role="row" className={cn(ROW, "group")}>
                {COLUMNS.map((column) => (
                  <HeaderCell key={column.key} column={column} scene={scene} />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody role="rowgroup" className="contents">
              {rows.map((company, index) => (
                <Row key={company.id} company={company} index={index} popover={scene === "cell" && company.id === "c1" ? <AnswerDetail {...NORTHLIGHT_GEO} /> : undefined} />
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
        <TableFooter page={1} count={rows.length} total={scene === "filter" ? GEO_PROSPECTS.length : 214} />
      </div>
      {(scene === "add" || scene === "number") && <AddFieldDialog type={scene === "number" ? "number" : "pick"} />}
      {scene === "cell" && phone && <PhoneAnswer />}
      {scene === "filter" && phone && <PhoneFilters />}
    </section>
  );
}
