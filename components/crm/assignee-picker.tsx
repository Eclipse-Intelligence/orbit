"use client";

import { useId, useState, type ReactNode } from "react";
import { Input } from "@/components/_ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { ParticipantAvatar } from "@/components/docs/presence";
import { personParticipant } from "@/lib/docs/participants";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";

export type AssignableMember = { id: string; name: string };

export function MemberAvatar({ member, viewerId, size = "md", className }: { member: AssignableMember | null; viewerId: string; size?: "xs" | "sm" | "md" | "lg"; className?: string }) {
  return <ParticipantAvatar participant={personParticipant(member, viewerId)} size={size} className={className} />;
}

export default function AssigneePicker({
  members,
  value,
  viewerId,
  tagged = [],
  onPick,
  trigger,
  label,
  disabled = false,
  align = "start",
  handOnNote = false,
  triggerClassName,
}: {
  members: AssignableMember[];
  value: string | null;
  viewerId: string;
  tagged?: string[];
  onPick: (id: string) => void;
  trigger: ReactNode;
  label: string;
  disabled?: boolean;
  align?: "start" | "end";
  handOnNote?: boolean;
  triggerClassName?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const needle = search.trim().toLowerCase();
  const shown = needle ? members.filter((member) => member.name.toLowerCase().includes(needle)) : members;
  const active = shown.length > 0 ? Math.min(highlight, shown.length - 1) : -1;

  function close() {
    setOpen(false);
    setSearch("");
    setHighlight(0);
  }

  function choose(memberId: string) {
    close();
    if (memberId !== value) onPick(memberId);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setOpen(true);
          setHighlight(Math.max(0, members.findIndex((member) => member.id === value)));
        } else close();
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={label}
          title={label}
          aria-busy={disabled || undefined}
          className={cn("inline-flex max-w-full min-w-0 shrink-0 cursor-pointer items-center disabled:cursor-default disabled:opacity-60", triggerClassName)}
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[min(17rem,calc(100vw-2rem))] p-1">
        <div className="p-1">
          <label htmlFor={`${id}-search`} className="sr-only">
            Assign to
          </label>
          <Input
            id={`${id}-search`}
            role="combobox"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
            aria-autocomplete="list"
            value={search}
            autoComplete="off"
            placeholder="Assign to…"
            onChange={(event) => {
              setSearch(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (shown.length === 0) return;
                setHighlight((active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
              } else if (event.key === "Enter" && active >= 0) {
                event.preventDefault();
                choose(shown[active].id);
              }
            }}
            className="h-8 text-[13px]"
          />
        </div>
        <ul id={`${id}-list`} role="listbox" aria-label="Workspace members" className="flex max-h-64 flex-col overflow-y-auto">
          {shown.map((member, index) => {
            const selected = member.id === value;
            return (
              <li
                key={member.id}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => choose(member.id)}
                className={cn(
                  "ui-style text-soft flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left",
                  index === active && "text-foreground bg-white/5",
                  selected && "text-foreground",
                )}
              >
                <MemberAvatar member={member} viewerId={viewerId} />
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                {selected ? (
                  <CheckIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
                ) : (
                  tagged.includes(member.id) && <span className="caption-style text-subtle shrink-0">Tagged</span>
                )}
              </li>
            );
          })}
        </ul>
        {shown.length === 0 && <p className="caption-style text-subtle px-2.5 py-2">No one matches</p>}
        {handOnNote && (
          <p className="caption-style text-subtle border-line-strong mt-1 border-t px-2.5 pt-1.5 pb-2">
            {value === viewerId ? "Handing it on keeps you tagged, so you can still follow it." : "Reassigning it keeps you tagged, so you can still follow it."}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
