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

export function joinDescription(text: string, links: TaskLink[]) {
  const lines = links.map((link) => `[${link.label}](${link.href})`).join("\n");
  const body = text.trim();
  const joined = [body, lines].filter(Boolean).join("\n\n");
  return joined || null;
}
