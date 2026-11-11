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
  const isLink = (line: string) => MAIL_LINK.test(line.trim());
  const lines = (original ?? "").split("\n");
  const anchors: { after: number; gap: boolean; line: string }[] = [];
  let count = 0;
  lines.forEach((line, index) => {
    if (isLink(line)) anchors.push({ after: count, gap: count > 0 && index > 0 && !lines[index - 1].trim(), line: line.trim() });
    else if (line.trim()) count += 1;
  });
  const typed = text.replace(/^\s*\n|\s+$/g, "");
  if (anchors.length === 0) return typed.trim() ? typed : null;
  const fresh = typed.trim() ? typed.split("\n") : [];
  const total = fresh.filter((line) => line.trim()).length;
  const out: string[] = [];
  let swallow = false;
  const place = (seen: number) => {
    for (const anchor of anchors) {
      if (Math.min(anchor.after, total) !== seen) continue;
      if (anchor.gap && out.length > 0 && out[out.length - 1].trim()) {
        out.push("");
        swallow = true;
      }
      out.push(anchor.line);
    }
  };
  place(0);
  let seen = 0;
  for (const line of fresh) {
    if (!line.trim() && swallow) {
      swallow = false;
      continue;
    }
    swallow = false;
    out.push(line);
    if (!line.trim()) continue;
    seen += 1;
    place(seen);
  }
  const joined = out.join("\n").trim();
  return joined || null;
}
