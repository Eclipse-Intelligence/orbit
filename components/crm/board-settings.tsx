"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { SheetFooter } from "@/components/_ui/sheet";
import Switch from "@/components/_ui/switch";
import { archiveBoardAction, updateBoardAction } from "@/app/(crm)/boards";
import { saveStagesAction } from "@/app/(crm)/settings/actions";
import type { Board } from "@/lib/crm/types";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

type StageRow = { key: string; id?: string; name: string };

export default function BoardSettings({
  board,
  count,
  onClose,
}: {
  board: Board;
  count: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(board.name);
  const [addOnWon, setAddOnWon] = useState(board.addOnWon);
  const [stages, setStages] = useState<StageRow[]>(
    board.stages.map((stage) => ({ key: stage.id, id: stage.id, name: stage.name })),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function move(index: number, direction: -1 | 1) {
    setStages((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save() {
    setPending(true);
    setError(null);
    const updated = await updateBoardAction(board.id, { name, addOnWon });
    if (updated.error) {
      setPending(false);
      setError(updated.error);
      return;
    }
    const saved = await saveStagesAction(
      stages.map((stage) => ({ id: stage.id, name: stage.name })),
      board.id,
    );
    setPending(false);
    if (saved.error) {
      setError(saved.error);
      return;
    }
    router.refresh();
    onClose();
  }

  async function remove() {
    const cards = count === 1 ? "1 company" : `${count} companies`;
    if (!window.confirm(`Delete ${board.name}? ${count > 0 ? `The ${cards} on it will be taken off.` : ""}`.trim())) return;
    setPending(true);
    const result = await archiveBoardAction(board.id);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onClose();
    router.push("/opportunities");
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-5 overflow-auto p-5">
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <label className="flex flex-col gap-2" htmlFor="board-name">
          <span className="caption-style text-subtle">Name</span>
          <Input id="board-name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="caption-style text-subtle pb-2">Stages</legend>
          <ul className="flex flex-col gap-2">
            {stages.map((stage, index) => (
              <li key={stage.key} className="flex items-center gap-1.5">
                <Input
                  aria-label={`Stage ${index + 1} name`}
                  maxLength={80}
                  value={stage.name}
                  onChange={(event) =>
                    setStages((current) =>
                      current.map((item) => (item.key === stage.key ? { ...item, name: event.target.value } : item)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${stage.name || `stage ${index + 1}`} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ChevronDownIcon aria-hidden className="size-3 rotate-180" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${stage.name || `stage ${index + 1}`} down`}
                  disabled={index === stages.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDownIcon aria-hidden className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${stage.name || `stage ${index + 1}`}`}
                  disabled={stages.length <= 1}
                  onClick={() => setStages((current) => current.filter((item) => item.key !== stage.key))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={stages.length >= 20}
              onClick={() =>
                setStages((current) => [...current, { key: `new-${current.length}-${Date.now()}`, name: "New stage" }])
              }
            >
              Add stage
            </Button>
          </div>
          <p className="caption-style text-subtle">A stage with companies on it stays until they move.</p>
        </fieldset>
        <div className="flex items-start justify-between gap-4">
          <span className="flex flex-col gap-1">
            <span className="text-[14px] leading-5">Add companies when a deal is won</span>
            <span className="caption-style text-subtle">
              When an opportunity is marked won, its company goes into the first stage here.
            </span>
          </span>
          <Switch checked={addOnWon} onChange={setAddOnWon} label="Add companies when a deal is won" />
        </div>
        <div className="border-border border-t pt-5">
          <Button variant="ghost" size="sm" className="text-danger" disabled={pending} onClick={remove}>
            Delete board
          </Button>
        </div>
      </div>
      <SheetFooter>
        <Button variant="subtle" size="sm" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={pending} data-shortcut="save" title="Save (⌘S)">
          {pending ? "Saving…" : "Save"}
        </Button>
      </SheetFooter>
    </form>
  );
}
