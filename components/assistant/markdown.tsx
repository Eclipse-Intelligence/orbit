import type { ReactNode } from "react";
import Link from "next/link";

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function inline(text: string, key: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    const id = `${key}-${index++}`;
    if (token.startsWith("**")) {
      parts.push(
        <strong key={id} className="text-foreground font-medium">
          {inline(token.slice(2, -2), id)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      parts.push(
        <code key={id} className="bg-muted rounded px-1 py-px font-mono text-[12.5px]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      if (href.startsWith("/") && !href.startsWith("//")) {
        parts.push(
          <Link key={id} href={href} className="text-foreground underline decoration-white/30 underline-offset-2 hover:decoration-white">
            {inline(label, id)}
          </Link>,
        );
      } else if (/^https?:\/\//.test(href)) {
        parts.push(
          <a
            key={id}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline decoration-white/30 underline-offset-2 hover:decoration-white"
          >
            {inline(label, id)}
          </a>,
        );
      } else {
        parts.push(label);
      }
    } else {
      parts.push(
        <em key={id} className="italic">
          {inline(token.slice(1, -1), id)}
        </em>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: { text: string; depth: number }[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const LIST_ITEM = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;

function cells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) body.push(lines[index++]);
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(cells(lines[index++]));
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const items: { text: string; depth: number }[] = [];
      while (index < lines.length) {
        const next = LIST_ITEM.exec(lines[index]);
        if (next) {
          items.push({ text: next[3], depth: next[1].length >= 2 ? 1 : 0 });
          index += 1;
          continue;
        }
        if (lines[index].trim() && /^\s{2,}/.test(lines[index]) && items.length > 0) {
          items[items.length - 1].text += ` ${lines[index].trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !LIST_ITEM.test(lines[index]) &&
      !/^#{1,6}\s/.test(lines[index]) &&
      !lines[index].trim().startsWith("```")
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function withBreaks(text: string, key: string) {
  return text.split("\n").flatMap((line, index) => (index === 0 ? inline(line, `${key}-${index}`) : [<br key={`${key}-br-${index}`} />, ...inline(line, `${key}-${index}`)]));
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="text-soft flex flex-col gap-3 text-[14px] leading-6">
      {parseBlocks(text).map((block, index) => {
        const key = `b${index}`;
        if (block.kind === "heading") {
          return (
            <p key={key} className="text-foreground pt-1 text-[14px] leading-6 font-medium">
              {inline(block.text, key)}
            </p>
          );
        }
        if (block.kind === "rule") return <hr key={key} className="border-line-strong" />;
        if (block.kind === "code") {
          return (
            <pre key={key} className="bg-muted overflow-x-auto rounded-lg px-3 py-2 font-mono text-[12.5px] leading-5">
              {block.text}
            </pre>
          );
        }
        if (block.kind === "table") {
          return (
            <div key={key} className="border-line-strong overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-left text-[13px] leading-5">
                <thead>
                  <tr className="bg-white/[0.03]">
                    {block.head.map((cell, cellIndex) => (
                      <th key={cellIndex} className="text-subtle px-3 py-2 font-medium whitespace-nowrap">
                        {inline(cell, `${key}-h${cellIndex}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-line-strong border-t">
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="px-3 py-2 align-top">
                          {inline(cell, `${key}-${rowIndex}-${cellIndex}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={key} className={block.ordered ? "flex list-decimal flex-col gap-1 pl-5" : "flex list-disc flex-col gap-1 pl-5"}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className={item.depth > 0 ? "ml-4 marker:text-faint" : "marker:text-faint"}>
                  {inline(item.text, `${key}-${itemIndex}`)}
                </li>
              ))}
            </List>
          );
        }
        return <p key={key}>{withBreaks(block.text, key)}</p>;
      })}
    </div>
  );
}
