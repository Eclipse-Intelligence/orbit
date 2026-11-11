const MAIL_LINK = /^\[([^\]\n]+)\]\((\/mail\?thread=[^)\s]+)\)$/;

export type TaskLink = { label: string; href: string };

export function splitDescription(description: string | null) {
  const links: TaskLink[] = [];
  const text = (description ?? "")
    .split("\n")
    .filter((line) => {
      const match = MAIL_LINK.exec(line.trim());
      if (match) links.push({ label: match[1], href: match[2] });
      return !match;
    })
    .join("\n")
    .trim();
  return { text, links };
}

export function replaceDescriptionText(original: string | null, text: string) {
  const lines = (original ?? "").split("\n");
  const isLink = (line: string) => MAIL_LINK.test(line.trim());
  const slots = lines.flatMap((line, index) => (isLink(line) || !line.trim() ? [] : [index]));
  const fresh = text.trim() ? text.trim().split("\n") : [];
  const out: string[] = [];
  if (slots.length === 0) out.push(...fresh, ...(fresh.length && lines.some(isLink) ? [""] : []));
  const last = slots[slots.length - 1];
  let next = 0;
  lines.forEach((line, index) => {
    if (isLink(line)) {
      out.push(line.trim());
      return;
    }
    if (!slots.includes(index)) {
      if (slots.length > 0 && index > slots[0] && index < last) out.push("");
      else if (out.length > 0 && index > (last ?? -1)) out.push("");
      return;
    }
    if (index === last) {
      out.push(...fresh.slice(next));
      next = fresh.length;
    } else if (next < fresh.length) out.push(fresh[next++]);
  });
  const joined = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return joined || null;
}
