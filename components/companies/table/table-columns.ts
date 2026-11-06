export const TABLE_COLUMNS = [
  { key: "name", label: "Company", className: "justify-start max-sm:order-first" },
  { key: "categories", label: "Categories", className: "justify-start max-sm:order-1" },
  { key: "last", label: "Last interaction", className: "justify-start max-sm:order-1" },
  { key: "strength", label: "Relationship", className: "justify-start max-sm:order-1" },
  { key: "health", label: "Health", className: "justify-start max-sm:order-1" },
  { key: "fit", label: "Fit", className: "justify-start max-sm:order-1" },
  { key: "domain", label: "Domain", className: "justify-start max-sm:order-1" },
  { key: "owner", label: "Owner", className: "justify-start max-sm:order-1" },
] as const;

export type TableColumnKey = (typeof TABLE_COLUMNS)[number]["key"];

export type TableColumn = { key: string; label: string; className: string; aiFieldId?: string };

export const TABLE_GRID_CLASS = "grid min-w-max justify-between";

export const AI_CELL_CLASS = "justify-start";

export const ADD_CELL_CLASS = "justify-start pr-2 max-sm:order-2";

export function tableColumns(fit: boolean, aiFields: { id: string; label: string }[] = [], addColumn = false): TableColumn[] {
  const columns: TableColumn[] = [];
  for (const column of TABLE_COLUMNS) {
    if (column.key === "fit" && !fit) continue;
    columns.push({ ...column });
    if (column.key === "health" && !fit) columns.push(...aiFields.map((field) => ({ key: `ai:${field.id}`, label: field.label, className: AI_CELL_CLASS, aiFieldId: field.id })));
    if (column.key === "fit") columns.push(...aiFields.map((field) => ({ key: `ai:${field.id}`, label: field.label, className: AI_CELL_CLASS, aiFieldId: field.id })));
  }
  if (addColumn) columns.push({ key: "add", label: "Add column", className: ADD_CELL_CLASS });
  return columns;
}

export function gridTemplate(count: number) {
  return { gridTemplateColumns: `repeat(${count}, max-content)` };
}

export const TABLE_ROW_CLASS = "col-span-full grid grid-cols-subgrid";

export const TABLE_CELL_CLASS = "flex h-[35px] items-center";

export function columnClass(key: TableColumnKey) {
  return TABLE_COLUMNS.find((column) => column.key === key)?.className ?? "";
}
