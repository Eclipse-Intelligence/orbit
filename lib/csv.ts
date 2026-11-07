export type CsvCell = string | number;

export const EXPORT_ROW_LIMIT = 10_000;

export type CsvExport = { rows: CsvCell[][]; total: number; exported: number; truncated: boolean };

export function exportNote(result: Pick<CsvExport, "total" | "exported" | "truncated">, noun: string) {
  if (!result.truncated) return null;
  const count = (value: number) => value.toLocaleString("en-GB");
  return `Exported ${count(result.exported)} of ${count(result.total)} ${noun}, the limit for one export.`;
}

function isPlainNumber(value: string) {
  return /^[+-]?[\d\s().-]+$/.test(value) && /\d/.test(value);
}

function escapeCell(cell: CsvCell) {
  let value = String(cell);
  if (/^[=+\-@\t\r]/.test(value) && !isPlainNumber(value)) value = `'${value}`;
  if (/[",\r\n]/.test(value)) value = `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: CsvCell[][]) {
  return rows.map((row) => row.map(escapeCell).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, rows: CsvCell[][]) {
  const blob = new Blob(["﻿", toCsv(rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
