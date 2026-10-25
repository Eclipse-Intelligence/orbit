import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import type { Actor } from "@/lib/crm/types";
import { addMarketNotes, listWatchlist, MARKET_NOTES_PER_CALL, NOTE_KINDS } from "@/lib/learning/market";

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof CrmError ? `${error.code}: ${error.message}` : "The request failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function run(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    return toolFailure(error);
  }
}

export function registerLearningTools(server: McpServer, actor: Actor) {
  server.registerTool(
    "get_watchlist",
    {
      description: "The topics, competitors, people, target accounts and sources Eclipse wants watched. Research these, then send findings with add_market_notes.",
      inputSchema: {},
    },
    async () => run(async () => ({ watchlist: (await listWatchlist(actor)).map((item) => ({ kind: item.kind, label: item.label, url: item.url, notes: item.notes })) })),
  );

  server.registerTool(
    "add_market_notes",
    {
      description: `Send market findings to Orbit: news, posts, launches, hires, funding, buying signals on target accounts and research. Up to ${MARKET_NOTES_PER_CALL} notes per call. Notes with a link Orbit already has are skipped. Orbit learns from them overnight and puts the important ones in each member's morning brief.`,
      inputSchema: {
        notes: z
          .array(
            z.object({
              kind: z.enum(NOTE_KINDS).describe("news, post, launch, hire, funding, signal (a reason to contact an account now), research or other"),
              headline: z.string().max(300).describe("One line saying what happened."),
              summary: z.string().max(2000).optional().describe("Two or three factual sentences."),
              url: z.string().max(1000).optional().describe("The original article or post."),
              about: z.string().max(200).optional().describe("The company or person it concerns, spelled as in the watchlist."),
              publishedAt: z.string().optional().describe("When it was published, as an ISO date."),
            }),
          )
          .min(1)
          .max(MARKET_NOTES_PER_CALL),
      },
    },
    async (args) => run(() => addMarketNotes(actor, args.notes)),
  );
}
