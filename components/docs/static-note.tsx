import { useMemo } from "react";
import { staticLines, type StaticLine, type StaticSegment } from "@/lib/docs/editor/static";
import type { WidgetSpec } from "@/lib/docs/editor/plan";
import { alignClass, type TableCell, type TableView } from "@/lib/docs/editor/tables";

function Widget({ spec }: { spec: WidgetSpec }) {
  if (spec.kind === "hang") return <span aria-hidden className="note-hang-anchor" />;
  if (spec.kind === "bullet") {
    return (
      <span aria-hidden className="note-bullet">
        {spec.label ? <span className="note-bullet-number">{spec.label}</span> : <span className="note-bullet-dot" />}
      </span>
    );
  }
  if (spec.kind === "checkbox") {
    return (
      <span className="note-task-box">
        <span role="checkbox" aria-checked={spec.checked} aria-label={spec.checked ? "Done" : "Not done"} className={spec.checked ? "note-checkbox is-checked" : "note-checkbox"} />
      </span>
    );
  }
  if (spec.kind === "mention") {
    const letters = spec.name
      .split(/\s+/)
      .map((part) => part[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase();
    return (
      <span className={`note-mention note-mention-${spec.mentionKind}`}>
        {spec.mentionKind === "contact" || spec.mentionKind === "member" ? (
          <span aria-hidden className="note-mention-initials">
            {letters}
          </span>
        ) : (
          <span aria-hidden className="note-mention-icon" />
        )}
        <span className="note-mention-name">{spec.name}</span>
      </span>
    );
  }
  if (spec.kind === "fence") {
    return (
      <span aria-hidden className="note-fence-label">
        {spec.language}
      </span>
    );
  }
  return (
    <span className="note-entry-time">
      <span className="note-entry-clock">{spec.time}</span>
      <span aria-hidden className="note-entry-dot" />
    </span>
  );
}

const PLAIN_CLASSES = new Set(["note-wikilink", "is-unresolved", "note-tag"]);

function Segment({ segment, plain }: { segment: StaticSegment; plain: boolean }) {
  if ("widget" in segment) return <Widget spec={segment.widget} />;
  if (plain) {
    const className = segment.className
      .split(" ")
      .filter((name) => name && !PLAIN_CLASSES.has(name) && name !== "note-link")
      .join(" ");
    const href = segment.attributes?.["data-href"];
    if (href) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={className ? `note-link ${className}` : "note-link"}>
          {segment.text}
        </a>
      );
    }
    return className ? <span className={className}>{segment.text}</span> : <>{segment.text}</>;
  }
  if (!segment.className) return <>{segment.text}</>;
  return (
    <span className={segment.className} {...segment.attributes}>
      {segment.text}
    </span>
  );
}

function Cell({ cell, plain }: { cell: TableCell; plain: boolean }) {
  return (
    <span className="note-table-cell">
      {cell.segments.map((segment, part) => (
        <Segment key={part} segment={segment} plain={plain} />
      ))}
    </span>
  );
}

function StaticTable({ table, line, plain }: { table: TableView; line: number; plain: boolean }) {
  return (
    <div className="note-table-widget" data-line={line}>
      <div className="note-table-scroll">
        <table className="note-table">
          <thead>
            <tr>
              {table.header.map((cell, column) => (
                <th key={column} scope="col" className={alignClass(table.align[column]) || undefined}>
                  <Cell cell={cell} plain={plain} />
                </th>
              ))}
            </tr>
          </thead>
          {table.rows.length > 0 && (
            <tbody>
              {table.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} className={alignClass(table.align[column]) || undefined}>
                      <Cell cell={cell} plain={plain} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

function Lines({ lines, plain }: { lines: StaticLine[]; plain: boolean }) {
  return lines.map((line, index) =>
    line.table ? (
      <StaticTable key={index} table={line.table} line={line.line} plain={plain} />
    ) : (
      <div key={index} className={line.className} data-line={line.line}>
        {line.segments.length ? line.segments.map((segment, part) => <Segment key={part} segment={segment} plain={plain} />) : <br />}
      </div>
    ),
  );
}

export default function StaticNote({ body, daily = false }: { body: string; daily?: boolean }) {
  const lines = useMemo(() => staticLines(body, { daily }), [body, daily]);
  return (
    <div aria-hidden className={daily ? "cm-editor note-editor note-editor-daily" : "cm-editor note-editor"}>
      <div className="cm-scroller">
        <div className="cm-content cm-lineWrapping">
          <Lines lines={lines} plain={false} />
        </div>
      </div>
    </div>
  );
}

export function PublicNote({ body }: { body: string }) {
  return (
    <div className="cm-editor note-editor note-public">
      <div className="cm-scroller">
        <div className="cm-content cm-lineWrapping">
          <Lines lines={staticLines(body, { maxLines: Number.MAX_SAFE_INTEGER })} plain />
        </div>
      </div>
    </div>
  );
}
