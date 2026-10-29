import { StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { Participant, Presence } from "@/lib/docs/client-types";

export const setPresence = StateEffect.define<Presence[]>();

class CursorWidget extends WidgetType {
  constructor(
    readonly participant: Participant,
    readonly writing: boolean,
  ) {
    super();
  }
  eq(other: CursorWidget) {
    return other.participant.id === this.participant.id && other.writing === this.writing && other.participant.color === this.participant.color;
  }
  toDOM() {
    const agent = this.participant.kind !== "person";
    const holder = document.createElement("span");
    holder.className = agent ? "note-cursor note-cursor-agent" : "note-cursor";
    holder.style.setProperty("--cursor-color", this.participant.color);
    const bar = document.createElement("span");
    bar.className = "note-cursor-bar";
    bar.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "note-cursor-label";
    label.setAttribute("aria-hidden", "true");
    if (agent) {
      const icon = document.createElement("span");
      icon.className = this.participant.kind === "assistant" ? "note-cursor-sparkle" : "note-cursor-braces";
      label.append(icon);
    }
    label.append(document.createTextNode(this.participant.short));
    if (this.writing) {
      const dots = document.createElement("span");
      dots.className = "note-cursor-dots";
      for (let index = 0; index < 3; index += 1) dots.append(document.createElement("span"));
      label.append(dots);
    }
    const spoken = document.createElement("span");
    spoken.className = "sr-only";
    spoken.textContent = `${this.participant.name} is ${this.writing ? "writing" : "editing"} here`;
    holder.append(bar, label, spoken);
    return holder;
  }
  ignoreEvent() {
    return true;
  }
}

const agentLine = Decoration.line({ class: "note-agent-line" });

function decorate(list: Presence[], doc: Text): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const length = doc.length;
  for (const entry of list) {
    if (entry.cursor === null || entry.cursor < 0 || entry.cursor > length) continue;
    if (entry.participant.kind !== "person") ranges.push(agentLine.range(doc.lineAt(entry.cursor).from));
    if (entry.insertFrom !== undefined && entry.insertFrom >= 0 && entry.insertFrom < entry.cursor) {
      ranges.push(Decoration.mark({ class: entry.participant.kind === "person" ? "note-remote-selection" : "note-agent-wash" }).range(entry.insertFrom, entry.cursor));
    }
    ranges.push(Decoration.widget({ widget: new CursorWidget(entry.participant, Boolean(entry.writing)), side: 1 }).range(entry.cursor));
  }
  return Decoration.set(ranges, true);
}

export const presenceField = StateField.define<{ list: Presence[]; decorations: DecorationSet }>({
  create: () => ({ list: [], decorations: Decoration.none }),
  update(value, transaction) {
    let list = value.list;
    let changed = false;
    if (transaction.docChanged && list.length) {
      list = list.map((entry) => ({
        ...entry,
        cursor: entry.cursor === null ? null : transaction.changes.mapPos(entry.cursor, 1),
        insertFrom: entry.insertFrom === undefined ? undefined : transaction.changes.mapPos(entry.insertFrom, -1),
      }));
      changed = true;
    }
    for (const effect of transaction.effects) {
      if (effect.is(setPresence)) {
        list = effect.value;
        changed = true;
      }
    }
    if (!changed) return value;
    return { list, decorations: decorate(list, transaction.state.doc) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});
