"use client";

import { useId, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { createCompanyViewAction, deleteCompanyViewAction, updateCompanyViewAction } from "@/app/(crm)/ai-fields";
import type { CompanyView } from "@/lib/ai-fields/types";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

const ALL = "all";

export function useCurrentView(views: CompanyView[]) {
  const params = useSearchParams();
  const id = params.get("view");
  return views.find((view) => view.id === id) ?? null;
}

export function useOpenView() {
  const router = useRouter();
  return (view: CompanyView | null) => {
    if (!view) {
      router.replace("/", { scroll: false });
      return;
    }
    const params = new URLSearchParams(view.params);
    params.set("view", view.id);
    router.replace(`/?${params.toString()}`, { scroll: false });
  };
}

function currentParams() {
  const params = new URLSearchParams(window.location.search);
  params.delete("view");
  params.delete("page");
  return params.toString();
}

export function SaveViewDialog({ open, onOpenChange, view }: { open: boolean; onOpenChange: (open: boolean) => void; view?: CompanyView | null }) {
  const id = useId();
  const router = useRouter();
  const [name, setName] = useState(view?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    start(async () => {
      const result = view ? await updateCompanyViewAction(view.id, { name }) : await createCompanyViewAction(name, currentParams());
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      if (!view) {
        const params = new URLSearchParams(result.view.params);
        params.set("view", result.view.id);
        router.replace(`/?${params.toString()}`, { scroll: false });
      }
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(view?.name ?? "");
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[420px]">
        <DialogHeader className="pr-12">
          <DialogTitle>{view ? "Rename view" : "Save view"}</DialogTitle>
          <DialogDescription>{view ? "Everyone in the workspace sees the new name." : "Saves the current filters and sort for everyone in the workspace."}</DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="px-6 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Field label="Name" htmlFor={`${id}-name`} error={error ?? undefined}>
            <Input id={`${id}-name`} value={name} maxLength={60} autoFocus onChange={(event) => setName(event.target.value)} />
          </Field>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={`${id}-form`} variant="primary" size="sm" disabled={pending || !name.trim()}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ViewMenu({ views, canManage }: { views: CompanyView[]; canManage: boolean }) {
  const router = useRouter();
  const current = useCurrentView(views);
  const openView = useOpenView();
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!current) return;
    setError(null);
    const result = await deleteCompanyViewAction(current.id);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setDeleting(false);
    openView(null);
    router.refresh();
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="none" className="group h-[30px] gap-0 overflow-hidden text-[12px] data-[state=open]:bg-muted">
            <span className="text-subtle px-[9px] font-normal">View</span>
            <span aria-hidden className="h-full w-px bg-white/8" />
            <span className="flex items-center gap-1.5 px-[9px]">
              <span className="max-w-[12rem] truncate">{current?.name ?? "All companies"}</span>
              <ChevronDownIcon aria-hidden className="size-3 text-[#898b8d] transition-transform duration-200 ease-power3-out group-data-[state=open]:rotate-180" />
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[14rem]">
          <DropdownMenuLabel>View</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current?.id ?? ALL} onValueChange={(value) => openView(views.find((view) => view.id === value) ?? null)}>
            <DropdownMenuRadioItem value={ALL}>All companies</DropdownMenuRadioItem>
            {views.map((view) => (
              <DropdownMenuRadioItem key={view.id} value={view.id}>
                {view.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {canManage && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSaving(true)}>Save current filters as a view…</DropdownMenuItem>
              {current && (
                <>
                  <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename {current.name}…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDeleting(true)}>Delete {current.name}…</DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SaveViewDialog open={saving} onOpenChange={setSaving} />
      {current && <SaveViewDialog key={current.id} open={renaming} onOpenChange={setRenaming} view={current} />}
      {current && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${current.name}?`}
          description="The view goes for everyone in the workspace. Companies and their answers stay."
          confirmLabel="Delete view"
          onConfirm={() => void remove()}
        />
      )}
      {error && (
        <span role="alert" className="caption-style text-danger max-w-[20rem]">
          {error}
        </span>
      )}
    </>
  );
}

export function ViewSelect({ views, id }: { views: CompanyView[]; id: string }) {
  const current = useCurrentView(views);
  const openView = useOpenView();
  return (
    <Field label="View" htmlFor={id}>
      <NativeSelect id={id} value={current?.id ?? ALL} onChange={(event) => openView(views.find((view) => view.id === event.target.value) ?? null)}>
        <option value={ALL}>All companies</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}
