export type Child = Node | string | number | null | undefined | false | Child[];

type Props = Record<string, unknown> | null | undefined;

const PROPERTIES = new Set(["value", "checked", "disabled", "selected", "indeterminate"]);

function append(parent: Node, child: Child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const item of child) append(parent, item);
    return;
  }
  parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
}

export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) {
      if (PROPERTIES.has(key)) (element as unknown as Record<string, unknown>)[key] = false;
      continue;
    }
    if (key === "class") element.className = String(value);
    else if (key === "trustedSvg") element.innerHTML = String(value);
    else if (key === "style" && typeof value === "object") Object.assign(element.style, value);
    else if (/^on/i.test(key)) {
      if (typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (PROPERTIES.has(key)) (element as unknown as Record<string, unknown>)[key] = value;
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  append(element, children);
  return element;
}

export function cx(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(" ");
}

const used = new Map<string, number>();

export function resetIds() {
  used.clear();
}

export function uid(key: string) {
  const base = `f-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "field"}`;
  const count = (used.get(base) ?? 0) + 1;
  used.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}
