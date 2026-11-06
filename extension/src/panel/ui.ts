import { cx, h, uid, type Child } from "./dom";
import { icon, type IconName } from "./icons";

const TAG_PALETTE = [
  "oklch(0.76 0.13 70)",
  "oklch(0.77 0.16 122)",
  "oklch(0.80 0.15 101)",
  "oklch(0.62 0.18 293)",
  "oklch(0.71 0.16 48)",
  "oklch(0.72 0.10 221)",
  "oklch(0.64 0.19 27)",
  "oklch(0.66 0.21 323)",
  "oklch(0.70 0.13 162)",
  "oklch(0.67 0.19 3)",
];

const LIFECYCLE_BASE: Record<string, string> = {
  lead: TAG_PALETTE[0],
  prospect: TAG_PALETTE[5],
  customer: TAG_PALETTE[8],
  churned: "oklch(0.62 0.01 260)",
};

const TILE_TONES = ["orange", "purple", "blue", "green", "teal", "amber", "red", "yellow"] as const;

function hashOf(value: string) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

export function tagColour(label: string) {
  return TAG_PALETTE[hashOf(label) % TAG_PALETTE.length];
}

export function lifecycleColour(lifecycle: string) {
  return LIFECYCLE_BASE[lifecycle.toLowerCase()] ?? tagColour(lifecycle);
}

export function recordTag(label: string, base = tagColour(label)) {
  return h(
    "span",
    {
      class: "record-tag",
      style: {
        borderColor: `color-mix(in srgb, ${base} 32%, var(--card))`,
        color: `color-mix(in srgb, ${base} 92%, var(--foreground))`,
        background: `color-mix(in srgb, ${base} 18%, var(--card))`,
      },
    },
    label,
  );
}

export function workspaceTile(id: string, name: string, className = "") {
  const tone = TILE_TONES[hashOf(id) % TILE_TONES.length];
  const letter = Array.from(name.trim()).find((char) => /\p{L}|\p{N}/u.test(char)) ?? "?";
  return h("span", { class: cx("tile", `tone-${tone}`, className), "aria-hidden": "true" }, letter.toLocaleUpperCase("en-GB"));
}

export function initials(name: string | null | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "")).toUpperCase();
}

type ButtonOptions = {
  variant: "primary" | "secondary" | "muted" | "ghost";
  size?: "sm" | "md" | "icon";
  label?: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  icon?: IconName;
  iconAfter?: IconName;
  type?: "button" | "submit";
  id?: string;
};

export function button(options: ButtonOptions, ...children: Child[]) {
  return h(
    "button",
    {
      type: options.type ?? "button",
      id: options.id,
      class: cx("btn", `btn-${options.variant}`, `btn-${options.size ?? "sm"}`, options.className),
      "aria-label": options.label,
      "aria-pressed": options.pressed === undefined ? undefined : String(options.pressed),
      "aria-expanded": options.expanded === undefined ? undefined : String(options.expanded),
      disabled: options.disabled,
      onClick: options.onClick,
    },
    options.icon ? icon(options.icon) : null,
    ...children,
    options.iconAfter ? icon(options.iconAfter, "icon icon-xs") : null,
  );
}

export function status(tone: "in" | "new" | "maybe" | "wait", title: string, detail?: Child) {
  return h(
    "div",
    { class: "status", role: "status" },
    h("span", { class: cx("dot", `dot-${tone}`), "aria-hidden": "true" }),
    h("span", { class: "status-text" }, h("span", { class: "status-title" }, title), detail ? h("span", { class: "caption subtle" }, detail) : null),
  );
}

export function section(title: string, children: Child, action?: Child, className?: string) {
  return h(
    "section",
    { class: cx("section", className) },
    h("div", { class: "section-head" }, h("h3", { class: "eyebrow" }, title), action ?? null),
    children,
  );
}

export function card(children: Child, className?: string) {
  return h("div", { class: cx("card", className) }, children);
}

export function avatar(text: string, square = false) {
  return h("span", { class: cx("avatar", square && "avatar-square"), "aria-hidden": "true" }, text);
}

export function recordHead(options: { initials: string; name: string; lines: Child[]; square?: boolean; action?: Child }) {
  return h(
    "div",
    { class: "record-head" },
    avatar(options.initials, options.square),
    h(
      "div",
      { class: "record-head-text" },
      h("span", { class: "record-name" }, options.name),
      options.lines.filter((line) => line !== null && line !== undefined && line !== "").map((line) => h("span", { class: "caption soft" }, line)),
    ),
    options.action ? h("div", { class: "record-head-action" }, options.action) : null,
  );
}

export function facts(rows: { label: string; value: Child }[]) {
  return h(
    "dl",
    { class: "facts" },
    rows.map((row) => [h("dt", { class: "caption subtle" }, row.label), h("dd", null, row.value)]),
  );
}

export function stack(main: Child, sub: Child) {
  return h("span", { class: "stack" }, h("span", null, main), sub ? h("span", { class: "caption subtle" }, sub) : null);
}

type FieldOptions = {
  label: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  hint?: string;
  type?: string;
  id?: string;
  autofocus?: boolean;
};

function fieldShell(id: string, label: string, control: HTMLElement, hint?: string) {
  if (hint) control.setAttribute("aria-describedby", `${id}-hint`);
  return h(
    "div",
    { class: "field" },
    h("label", { class: "caption soft", for: id }, label),
    control,
    hint ? h("span", { id: `${id}-hint`, class: "caption subtle" }, hint) : null,
  );
}

export function textField(options: FieldOptions) {
  const id = options.id ?? uid("text");
  const input = h("input", {
    id,
    class: "input",
    type: options.type ?? "text",
    value: options.value,
    placeholder: options.placeholder,
    "data-autofocus": options.autofocus ? "true" : undefined,
    onInput: (event: Event) => options.onInput((event.target as HTMLInputElement).value),
  });
  return fieldShell(id, options.label, input, options.hint);
}

export function areaField(options: FieldOptions & { rows?: number }) {
  const id = options.id ?? uid("area");
  const area = h("textarea", {
    id,
    class: "input textarea",
    rows: String(options.rows ?? 4),
    placeholder: options.placeholder,
    "data-autofocus": options.autofocus ? "true" : undefined,
    onInput: (event: Event) => options.onInput((event.target as HTMLTextAreaElement).value),
  });
  (area as HTMLTextAreaElement).value = options.value;
  return fieldShell(id, options.label, area, options.hint);
}

export function selectField(options: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  hint?: string;
  id?: string;
  disabled?: boolean;
}) {
  const id = options.id ?? uid("select");
  const select = h(
    "select",
    {
      id,
      class: "input select",
      disabled: options.disabled,
      onChange: (event: Event) => options.onChange((event.target as HTMLSelectElement).value),
    },
    options.options.map((option) => h("option", { value: option.value, selected: option.value === options.value }, option.label)),
  );
  return fieldShell(id, options.label, select, options.hint);
}

export function checkbox(options: { id: string; checked: boolean; disabled?: boolean; label?: string; onChange: (checked: boolean) => void }) {
  return h("input", {
    id: options.id,
    type: "checkbox",
    class: "checkbox",
    checked: options.checked,
    disabled: options.disabled,
    "aria-label": options.label,
    onChange: (event: Event) => options.onChange((event.target as HTMLInputElement).checked),
  });
}

export function quickActions(actions: { key: string; label: string; icon: IconName }[], active: string | null, onPick: (key: string) => void, disabled = false) {
  return h(
    "div",
    { class: "quick-actions" },
    actions.map((action) =>
      button(
        {
          variant: action.key === active ? "muted" : "secondary",
          size: "md",
          className: cx("quick", action.key !== active && "soft"),
          pressed: action.key === active,
          disabled,
          icon: action.icon,
          onClick: () => onPick(action.key),
        },
        action.label,
      ),
    ),
  );
}

export function openInOrbit(onClick: () => void, label = "Open in Orbit") {
  return button({ variant: "secondary", size: "sm", className: "shrink-0", onClick, iconAfter: "external" }, label);
}

export function chips(values: string[]) {
  return h("span", { class: "chips" }, values.map((value) => recordTag(value)));
}

export function note(text: Child) {
  return h("p", { class: "caption subtle note" }, text);
}

export function alert(text: string) {
  return h("p", { class: "caption alert", role: "alert" }, text);
}

export function formActions(onCancel: () => void, submitLabel: string, onSubmit: () => void, busy: boolean) {
  return h(
    "div",
    { class: "form-actions" },
    button({ variant: "ghost", size: "sm", onClick: onCancel, disabled: busy }, "Cancel"),
    button({ variant: "primary", size: "sm", onClick: onSubmit, disabled: busy }, busy ? "Saving" : submitLabel),
  );
}
