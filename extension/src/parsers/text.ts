export function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text : null;
}

export function textOf(element: Element | null | undefined): string | null {
  if (!element) return null;
  try {
    const visible = element.querySelector(':scope > span[aria-hidden="true"]');
    if (visible) {
      const text = clean(visible.textContent);
      if (text) return text;
    }
    const clone = element.cloneNode(true) as Element;
    clone.querySelectorAll(".visually-hidden, .sr-only, .a11y-text, script, style").forEach((node) => node.remove());
    return clean(clone.textContent);
  } catch {
    return null;
  }
}

export function safeAll(root: ParentNode | null | undefined, selector: string): Element[] {
  if (!root) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function safeOne(root: ParentNode | null | undefined, selector: string): Element | null {
  if (!root) return null;
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

export function firstElement(root: ParentNode | null | undefined, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const found = safeAll(root, selector).find((element) => textOf(element));
    if (found) return found;
  }
  return null;
}

export function firstText(root: ParentNode | null | undefined, selectors: string[]): string | null {
  return textOf(firstElement(root, selectors));
}

export function sectionTitled(root: ParentNode, anchorId: string, title: RegExp): Element | null {
  const anchor = safeOne(root, `#${anchorId}`);
  const byAnchor = anchor?.closest("section");
  if (byAnchor) return byAnchor;
  for (const section of safeAll(root, "section")) {
    const heading = firstText(section, ["h2", "h3", "[role=heading]"]);
    if (heading && title.test(heading)) return section;
  }
  return null;
}

export function splitName(name: string | null): { firstName: string | null; lastName: string | null; name: string | null } {
  const tidy = clean(name?.replace(/\([^)]*\)/g, " ").split(/,\s/)[0]);
  if (!tidy) return { firstName: null, lastName: null, name: null };
  const parts = tidy.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: null, name: tidy };
  return { firstName: parts[0], lastName: parts.slice(1).join(" "), name: tidy };
}

export function attr(element: Element | null | undefined, name: string): string | null {
  try {
    return clean(element?.getAttribute(name) ?? null);
  } catch {
    return null;
  }
}

export function headlineParts(headline: string | null): { jobTitle: string | null; companyName: string | null } {
  if (!headline) return { jobTitle: null, companyName: null };
  const first = clean(headline.split(/\s*[|•·]\s*/)[0]);
  if (!first) return { jobTitle: null, companyName: null };
  const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(first);
  if (at) return { jobTitle: clean(at[1]), companyName: clean(at[2]) };
  const comma = /^(.+?),\s+(.+)$/.exec(first);
  if (comma) return { jobTitle: clean(comma[1]), companyName: clean(comma[2]) };
  return { jobTitle: first, companyName: null };
}
