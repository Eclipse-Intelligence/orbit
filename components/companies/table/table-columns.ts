export const TABLE_COLUMNS = [
  { key: "name", label: "Company", className: "justify-start" },
  { key: "domain", label: "Domain", className: "justify-start" },
  { key: "industry", label: "Industry", className: "justify-start" },
  { key: "lifecycle", label: "Lifecycle", className: "justify-start" },
  { key: "owner", label: "Owner", className: "justify-start" },
  { key: "updated", label: "Updated", className: "justify-start" },
  { key: "action", label: "Action", className: "justify-center" },
] as const;

export type TableColumnKey = (typeof TABLE_COLUMNS)[number]["key"];

export const TABLE_GRID_CLASS =
  "grid min-w-max grid-cols-[repeat(7,max-content)] justify-between";

export const TABLE_ROW_CLASS = "col-span-full grid grid-cols-subgrid";

export const TABLE_CELL_CLASS = "flex items-center";

export function columnClass(key: TableColumnKey) {
  return TABLE_COLUMNS.find((column) => column.key === key)?.className ?? "";
}
