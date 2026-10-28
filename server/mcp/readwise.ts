import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { READER_CATEGORIES, READER_LOCATIONS } from "@/lib/readwise";
import { readerHighlights, readerList, readerRead } from "@/lib/readwise/reader";

type Fetcher = { fetchImpl?: typeof fetch };

const BUDGET_MS = 50_000;

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
      description:
        "Read one document from this person's Readwise Reader, 60,000 characters a part. Part 1 also has its note and every highlight with its note. To read, review, summarise or check a document, read every part in order until nextPart is null before answering, and never judge the whole document from part 1 alone. If you can't finish, say which parts you read. Read-only.",
      inputSchema: { id: z.string().min(1).max(200), part: z.number().int().min(1).max(10_000).optional() },
    },
    async (args) => run(() => readerRead(actor, args.id, args.part ?? 1, live())),
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
