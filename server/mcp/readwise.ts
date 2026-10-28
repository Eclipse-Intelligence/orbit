import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { READER_CATEGORIES, READER_LOCATIONS } from "@/lib/readwise";
import { readerHighlights, readerList, readerRead } from "@/lib/readwise/reader";

type Fetcher = { fetchImpl?: typeof fetch };

const BUDGET_MS = 80_000;

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof CrmError ? `${error.code}: ${error.message}` : "The Readwise Reader request failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function run(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    return toolFailure(error);
  }
}

export function registerReaderTools(server: McpServer, actor: UserActor, options: Fetcher = {}) {
  const live = () => ({ fetchImpl: options.fetchImpl, deadline: Date.now() + BUDGET_MS });

  server.registerTool(
    "reader_list",
    {
      description:
        "List documents in this person's own Readwise Reader, with titles, authors, links, locations, tags, dates and ids. Read-only.",
      inputSchema: {
        location: z.enum(READER_LOCATIONS).optional(),
        category: z.enum(READER_CATEGORIES).optional(),
        tags: z.array(z.string().max(100)).max(5).optional(),
        updated_after: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        page_cursor: z.string().max(2000).optional(),
      },
    },
    async (args) =>
      run(() =>
        readerList(
          actor,
          { location: args.location, category: args.category, tag: args.tags, updatedAfter: args.updated_after, limit: args.limit, pageCursor: args.page_cursor },
          live(),
        ),
      ),
  );

  server.registerTool(
    "reader_read",
    {
      description: "Read one document from this person's Readwise Reader in full, with its highlights and notes. Read-only.",
      inputSchema: { id: z.string().min(1).max(200) },
    },
    async (args) => run(() => readerRead(actor, args.id, live())),
  );

  server.registerTool(
    "reader_highlights",
    {
      description: "Recent highlights and notes from this person's Readwise Reader, optionally for one document or documents with a tag. Read-only.",
      inputSchema: {
        document_id: z.string().max(200).optional(),
        tag: z.string().max(100).optional(),
        updated_after: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) =>
      run(() => readerHighlights(actor, { documentId: args.document_id, tag: args.tag, updatedAfter: args.updated_after, limit: args.limit }, live())),
  );
}
