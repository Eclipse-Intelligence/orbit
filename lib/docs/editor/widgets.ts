import { WidgetType } from "@codemirror/view";
import type { MentionKind } from "@/lib/mentions";

function span(className: string, text?: string) {
  const node = document.createElement("span");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class HangingMark extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: HangingMark) {
    return other.text === this.text;
  }
  toDOM() {
    const holder = span("note-hang-anchor");
    holder.setAttribute("aria-hidden", "true");
    holder.append(span("note-hang", this.text));
    return holder;
  }
  ignoreEvent() {
    return false;
  }
}

export class BulletWidget extends WidgetType {
  constructor(
    readonly label: string | null,
    readonly raw: string | null,
  ) {
    super();
  }
  eq(other: BulletWidget) {
    return other.label === this.label && other.raw === this.raw;
  }
  toDOM() {
    const holder = span("note-bullet");
    holder.setAttribute("aria-hidden", "true");
    if (this.raw !== null) holder.append(span("note-bullet-raw", this.raw));
    else if (this.label !== null) holder.append(span("note-bullet-number", this.label));
    else holder.append(span("note-bullet-dot"));
    return holder;
  }
  ignoreEvent() {
    return false;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly hanging: string | null,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.hanging === this.hanging;
  }
  toDOM() {
    const holder = span("note-task-box");
    if (this.hanging) {
      const hang = span("note-hang-anchor");
      hang.setAttribute("aria-hidden", "true");
      hang.append(span("note-hang", this.hanging));
      holder.append(hang);
    }
    const box = span(`note-checkbox${this.checked ? " is-checked" : ""}`);
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.setAttribute("aria-label", this.checked ? "Done. Mark as not done" : "Not done. Mark as done");
    box.setAttribute("data-checkbox", "");
    holder.append(box);
    return holder;
  }
  ignoreEvent() {
    return false;
  }
}

const KIND_LABELS: Record<MentionKind, string> = { contact: "Person", company: "Company", task: "Task", opportunity: "Opportunity", proposal: "Proposal" };

export class MentionWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly kind: MentionKind,
    readonly id: string,
  ) {
    super();
  }
  eq(other: MentionWidget) {
    return other.name === this.name && other.kind === this.kind && other.id === this.id;
  }
  toDOM() {
    const chip = span(`note-mention note-mention-${this.kind}`);
    chip.setAttribute("data-mention-kind", this.kind);
    chip.setAttribute("data-mention-id", this.id);
    chip.setAttribute("title", KIND_LABELS[this.kind]);
    if (this.kind === "contact") {
      const letters = this.name
        .split(/\s+/)
        .map((part) => part[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase();
      const badge = span("note-mention-initials", letters);
      badge.setAttribute("aria-hidden", "true");
      chip.append(badge);
    } else {
      const icon = span("note-mention-icon");
      icon.setAttribute("aria-hidden", "true");
      chip.append(icon);
    }
    chip.append(document.createTextNode(this.name));
    return chip;
  }
  ignoreEvent() {
    return false;
  }
}

export class FenceLabel extends WidgetType {
  constructor(readonly language: string) {
    super();
  }
  eq(other: FenceLabel) {
    return other.language === this.language;
  }
  toDOM() {
    const label = span("note-fence-label", this.language);
    label.setAttribute("aria-hidden", "true");
    return label;
  }
}

export class EntryTime extends WidgetType {
  constructor(
    readonly time: string,
    readonly last: boolean,
  ) {
    super();
  }
  eq(other: EntryTime) {
    return other.time === this.time && other.last === this.last;
  }
  toDOM() {
    const holder = span(`note-entry-time${this.last ? " is-last" : ""}`);
    holder.append(span("note-entry-clock", this.time));
    const dot = span("note-entry-dot");
    dot.setAttribute("aria-hidden", "true");
    holder.append(dot);
    return holder;
  }
  ignoreEvent() {
    return false;
  }
}

export class DeletedText extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: DeletedText) {
    return other.text === this.text;
  }
  toDOM() {
    const node = document.createElement("del");
    node.className = "note-del";
    node.textContent = this.text;
    const label = span("sr-only", "Removed: ");
    node.prepend(label);
    return node;
  }
}
