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
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const shown = needle ? members.filter((member) => member.name.toLowerCase().includes(needle)) : members;
  const handingOn = handOnNote && value === viewerId;

  function choose(memberId: string) {
    setOpen(false);
    setSearch("");
    if (memberId !== value) onPick(memberId);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" aria-label={label} title={label} className="inline-flex max-w-full min-w-0 shrink-0 cursor-pointer items-center disabled:cursor-default">
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
            value={search}
            autoComplete="off"
            placeholder="Assign to…"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && shown[0]) {
                event.preventDefault();
                choose(shown[0].id);
              }
            }}
            className="h-8 text-[13px]"
          />
        </div>
        <ul className="flex max-h-64 flex-col overflow-y-auto" aria-label="Workspace members">
          {shown.map((member) => {
            const selected = member.id === value;
            return (
              <li key={member.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => choose(member.id)}
                  className={cn(
                    "ui-style text-soft hover:text-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/5",
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
                </button>
              </li>
            );
          })}
          {shown.length === 0 && <li className="caption-style text-subtle px-2.5 py-2">No one matches</li>}
        </ul>
        {handingOn && (
          <p className="caption-style text-subtle border-line-strong mt-1 border-t px-2.5 pt-1.5 pb-2">Handing it on keeps you tagged, so you can still follow it.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
