"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import Tag from "@/components/_ui/tag";
import { Textarea } from "@/components/_ui/textarea";
import { SettingsCard } from "@/components/crm/settings-ui";
import { archiveProofAction, saveProofAction } from "@/app/(crm)/proof";
import { PERMISSION_LABEL, PROOF_LIMITS, PROOF_PERMISSIONS, productSuggestions, type ProofEntry, type ProofPermission } from "@/lib/crm/proof-rules";

export default function ProofList({ entries, workspaceName }: { entries: ProofEntry[]; workspaceName: string }) {
  const [editing, setEditing] = useState<{ entry: ProofEntry | null } | null>(null);
  const products = useMemo(() => productSuggestions(entries, workspaceName), [entries, workspaceName]);
  const usual = useMemo(() => productSuggestions(entries, "")[0] ?? "", [entries]);

  function open(entry: ProofEntry | null) {
    setEditing({ entry });
  }

  return (
    <SettingsCard
      id="proof"
      title="Proof list"
      description="Client results the assistant may quote."
      action={
        <Button variant="secondary" size="sm" type="button" onClick={() => open(null)}>
          Add proof
        </Button>
      }
    >
      {entries.length === 0 ? (
        <p className="caption-style text-subtle">No proof</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Button variant="item" size="none" type="button" className="px-2 py-2.5" onClick={() => open(entry)}>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] leading-5 font-medium">{entry.client}</span>
                    <Tag size="sm" className="text-[12px]">
                      {PERMISSION_LABEL[entry.permission]}
                    </Tag>
                  </span>
                  <span className="text-soft line-clamp-2 text-[14px] leading-5">“{entry.result}”</span>
                  <span className="caption-style text-subtle">
                    {[entry.product, entry.description].filter(Boolean).join(". ")}
                  </span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={editing !== null} onOpenChange={(next) => !next && setEditing(null)}>
        <SheetContent side="right" className="sm:w-[480px] sm:max-w-[480px]">
          <SheetHeader>
            <SheetTitle>{editing?.entry ? "Edit proof" : "Add proof"}</SheetTitle>
            <SheetDescription className="sr-only">A client result the assistant can use in cold emails</SheetDescription>
            <SheetCloseButton />
          </SheetHeader>
          {editing && <ProofForm entry={editing.entry} products={products} usual={usual} onClose={() => setEditing(null)} />}
        </SheetContent>
      </Sheet>
    </SettingsCard>
  );
}

function ProofForm({ entry, products, usual, onClose }: { entry: ProofEntry | null; products: string[]; usual: string; onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const [client, setClient] = useState(entry?.client ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [product, setProduct] = useState(entry ? entry.product : usual);
  const [usedFor, setUsedFor] = useState(entry?.usedFor ?? "");
  const [result, setResult] = useState(entry?.result ?? "");
  const [measured, setMeasured] = useState(entry?.measured ?? "");
  const [permission, setPermission] = useState<ProofPermission | "">(entry?.permission ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  function invalid(field: string) {
    return error?.field === field ? true : undefined;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!client.trim()) return setError({ message: "Add the client's name.", field: "client" });
    if (!result.trim()) return setError({ message: "Add the result.", field: "result" });
    if (!permission) return setError({ message: "Choose whether they can be named.", field: "permission" });
    setPending(true);
    setError(null);
    const saved = await saveProofAction(entry?.id ?? null, { client, description, product, usedFor, result, measured, permission, approvedBy: entry?.approvedBy ?? "", reviewOn: entry?.reviewOn ?? null }).catch(() => ({
      error: "Couldn't save. Try again.",
      field: undefined,
    }));
    setPending(false);
    if (saved.error !== undefined) {
      setError({ message: saved.error, field: saved.field });
      return;
    }
    onClose();
    router.refresh();
  }

  async function remove() {
    if (!entry || pending) return;
    setPending(true);
    const removed = await archiveProofAction(entry.id).catch(() => ({ error: "Couldn't delete. Try again." }));
    setPending(false);
    if (removed.error) {
      setError({ message: removed.error });
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <form onSubmit={save} noValidate className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-4 overflow-auto p-5">
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error.message}
          </p>
        )}
        <label className="flex flex-col gap-2" htmlFor={`${id}-client`}>
          <span className="caption-style text-subtle">Client</span>
          <Input id={`${id}-client`} value={client} maxLength={PROOF_LIMITS.client} autoComplete="off" aria-invalid={invalid("client")} onChange={(event) => setClient(event.target.value)} />
        </label>
        <div className="flex flex-col gap-2">
          <label className="caption-style text-subtle" htmlFor={`${id}-result`}>
            Result
          </label>
          <Textarea
            id={`${id}-result`}
            value={result}
            maxLength={PROOF_LIMITS.result}
            className="min-h-24"
            placeholder="Went from two articles a month to eight"
            aria-invalid={invalid("result")}
            aria-describedby={`${id}-result-hint`}
            onChange={(event) => setResult(event.target.value)}
          />
          <span id={`${id}-result-hint`} className="caption-style text-subtle">
            The assistant uses this as written.
          </span>
        </div>
        <label className="flex flex-col gap-2" htmlFor={`${id}-permission`}>
          <span className="caption-style text-subtle">Naming</span>
          <NativeSelect id={`${id}-permission`} value={permission} aria-invalid={invalid("permission")} onChange={(event) => setPermission(event.target.value as ProofPermission)}>
            <option value="" disabled>
              Choose
            </option>
            {PROOF_PERMISSIONS.map((option) => (
              <option key={option} value={option}>
                {PERMISSION_LABEL[option]}
              </option>
            ))}
          </NativeSelect>
        </label>
        <div className="flex flex-col gap-2">
          <label className="caption-style text-subtle" htmlFor={`${id}-description`}>
            Description
          </label>
          <Input
            id={`${id}-description`}
            value={description}
            maxLength={PROOF_LIMITS.description}
            autoComplete="off"
            placeholder="A 12-person B2B SEO agency"
            aria-invalid={invalid("description")}
            aria-describedby={`${id}-description-hint`}
            onChange={(event) => setDescription(event.target.value)}
          />
          <span id={`${id}-description-hint`} className="caption-style text-subtle">
            Used instead of the name when they can&apos;t be named.
          </span>
        </div>
        <label className="flex flex-col gap-2" htmlFor={`${id}-product`}>
          <span className="caption-style text-subtle">Product</span>
          <Input
            id={`${id}-product`}
            value={product}
            maxLength={PROOF_LIMITS.product}
            autoComplete="off"
            list={`${id}-products`}
            aria-invalid={invalid("product")}
            onChange={(event) => setProduct(event.target.value)}
          />
          <datalist id={`${id}-products`}>
            {products.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-2" htmlFor={`${id}-used-for`}>
          <span className="caption-style text-subtle">Used it for</span>
          <Input id={`${id}-used-for`} value={usedFor} maxLength={PROOF_LIMITS.usedFor} autoComplete="off" onChange={(event) => setUsedFor(event.target.value)} />
        </label>
        <label className="flex flex-col gap-2" htmlFor={`${id}-measured`}>
          <span className="caption-style text-subtle">Measured</span>
          <Input
            id={`${id}-measured`}
            value={measured}
            maxLength={PROOF_LIMITS.measured}
            autoComplete="off"
            placeholder="When, and how"
            onChange={(event) => setMeasured(event.target.value)}
          />
        </label>
      </div>
      <SheetFooter>
        {entry && (
          <HoldButton onConfirm={remove} disabled={pending} className="mr-auto">
            Hold to delete
          </HoldButton>
        )}
        <Button variant="subtle" size="sm" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </SheetFooter>
    </form>
  );
}
