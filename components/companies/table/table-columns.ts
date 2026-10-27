export const TABLE_COLUMNS = [
  { key: "name", label: "Company", className: "justify-start" },
  { key: "categories", label: "Categories", className: "justify-start" },
  { key: "last", label: "Last interaction", className: "justify-start" },
  { key: "strength", label: "Relationship", className: "justify-start" },
  { key: "health", label: "Health", className: "justify-start" },
  { key: "fit", label: "Fit", className: "justify-start" },
  { key: "domain", label: "Domain", className: "justify-start" },
  { key: "owner", label: "Owner", className: "justify-start" },
] as const;

export type TableColumnKey = (typeof TABLE_COLUMNS)[number]["key"];

export const TABLE_GRID_CLASS =
  "grid min-w-max grid-cols-[repeat(7,max-content)] justify-between";

export const TABLE_GRID_FIT_CLASS =
  "grid min-w-max grid-cols-[repeat(8,max-content)] justify-between";

export function tableColumns(fit: boolean) {
  return TABLE_COLUMNS.filter((column) => fit || column.key !== "fit");
}

export const TABLE_ROW_CLASS = "col-span-full grid grid-cols-subgrid";

export const TABLE_CELL_CLASS = "flex h-[35px] items-center";

export function columnClass(key: TableColumnKey) {
  return TABLE_COLUMNS.find((column) => column.key === key)?.className ?? "";
}
