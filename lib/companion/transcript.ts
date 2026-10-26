import type { ChatMessage } from "@/lib/assistant/gateway";

const OLD_RESULT_MAX = 8_000;
const CURRENT_RESULT_MAX = 40_000;
const TRANSCRIPT_MAX = 600_000;

function escape(text: string) {
  return text.replace(/<\s*\/\s*(conversation|user|assistant|tool_call|tool_result|learned_notes)\s*>/gi, "<\\/$1>");
}

function attribute(text: string) {
  return text.replace(/[^\w-]/g, "").slice(0, 120);
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n[cut ${text.length - max} characters]` : text;
}

export function buildPrompt(messages: ChatMessage[]) {
  const turns = messages.filter((message) => message.role !== "system");
  const lastUser = turns.map((message) => message.role).lastIndexOf("user");
  const endsWithUser = lastUser === turns.length - 1 && lastUser >= 0;
  const earlier = endsWithUser ? turns.slice(0, lastUser) : turns;
  const names = new Map<string, string>();
  const blocks: string[] = [];

  earlier.forEach((message, index) => {
    const current = index > lastUser;
    if (message.role === "user") {
      blocks.push(`<user>\n${escape(message.content)}\n</user>`);
    } else if (message.role === "assistant") {
      if (message.content) blocks.push(`<assistant>\n${escape(message.content)}\n</assistant>`);
      for (const call of message.tool_calls ?? []) {
        names.set(call.id, call.function.name);
        blocks.push(`<tool_call id="${attribute(call.id)}" name="${attribute(call.function.name)}">\n${escape(call.function.arguments || "{}")}\n</tool_call>`);
      }
    } else if (message.role === "tool") {
      const name = names.get(message.tool_call_id) ?? "tool";
      const body = clip(message.content, current ? CURRENT_RESULT_MAX : OLD_RESULT_MAX);
      blocks.push(`<tool_result id="${attribute(message.tool_call_id)}" name="${attribute(name)}">\n${escape(body)}\n</tool_result>`);
    }
  });

  let total = blocks.reduce((sum, block) => sum + block.length, 0);
  let dropped = 0;
  while (total > TRANSCRIPT_MAX && blocks.length > 1) {
    total -= blocks.shift()!.length;
    dropped += 1;
  }

  const history =
    blocks.length > 0
      ? `Earlier in this conversation${dropped ? ` (the oldest ${dropped} entries are left out)` : ""}:\n<conversation>\n${blocks.join("\n")}\n</conversation>`
      : "";

  if (endsWithUser) {
    const latest = (turns[lastUser] as { content: string }).content;
    return history ? `${history}\n\nThe user's latest message:\n${latest}` : latest;
  }
  return `${history}\n\nThe user has just approved or cancelled the actions you proposed. Their results are the last tool results above. Tell the user briefly what happened, then carry on with anything left to do.`;
}
