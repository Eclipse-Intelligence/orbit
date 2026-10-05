"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { downloadCsv } from "@/lib/csv";
import {
  exportRecordsAction,
  importRecordsAction,
  type TransferResource,
} from "@/app/(crm)/transfer";
import ShareIcon from "@/public/assets/images/companies/toolbar/share.svg";

export default function RecordTransfer({
  resource,
  mode = "both",
}: {
  resource: TransferResource;
  mode?: "both" | "import";
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<"export" | "import" | null>(null);
  const canImport = resource === "companies" || resource === "contacts";

  async function exportCsv() {
    setPending("export");
    setMessage(null);
    try {
      const rows = await exportRecordsAction(resource);
      const day = new Date().toISOString().slice(0, 10);
      downloadCsv(`${resource}-${day}.csv`, rows);
    } catch {
      setMessage("Export failed.");
    } finally {
      setPending(null);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setPending("import");
    setMessage(null);
    try {
      const result = await importRecordsAction(resource, await file.text());
      if ("error" in result) {
        setMessage(result.error);
        return;
      }
      const parts = [
        result.created ? `${result.created} created` : "",
        result.updated ? `${result.updated} updated` : "",
        result.matched ? `${result.matched} matched` : "",
        result.errors.length ? `${result.errors.length} failed` : "",
      ].filter(Boolean);
      setMessage(parts.join(", ") || "Nothing to import.");
      router.refresh();
    } finally {
      setPending(null);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-1">
      {message && <span className="caption-style text-subtle max-w-40 truncate">{message}</span>}
      {canImport && (
        <>
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => onFile(event.target.files?.[0])}
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={pending !== null}
            onClick={() => input.current?.click()}
          >
            {pending === "import" ? "Importing…" : "Import"}
          </Button>
        </>
      )}
      {mode === "both" && (
        <Button variant="secondary" size="sm" type="button" onClick={exportCsv} disabled={pending !== null}>
          <ShareIcon aria-hidden className="size-3" />
          {pending === "export" ? "Exporting…" : "Export"}
        </Button>
      )}
    </div>
  );
}
