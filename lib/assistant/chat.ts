import { AssistantError, StoppedError, complete, type ChatMessage, type ProviderState, type Source, type ToolCall } from "@/lib/assistant/gateway";
import { assistantModel, settingsFor, type ModelSource, type ReasoningLevel } from "@/lib/assistant/models";
import { chatFileNote, chatFilesFor, removeChatObjects, type ChatFile } from "@/lib/assistant/files";
import { connectedProviders } from "@/lib/ai-accounts/store";
import { systemPrompt } from "@/lib/assistant/prompt";
import { docLinkOf } from "@/lib/assistant/doc-link";
import { ACTION_ALTERNATIVES, ASSISTANT_TOOLS, actionAlternative, describeAction, findTool, recordNames, runTool, toolDescription, toolJson } from "@/lib/assistant/tools";
import { editsWithoutApproval } from "@/lib/assistant/docs";
import type { DocDiffLine } from "@/lib/docs/types";
import type { CompanionResult, Effort } from "@/companion/src/protocol";
import {
  CONTINUE_RESULT_TOOL,
  cancelCompanionJob,
  companionBusy,
  companionWorking,
  enqueueCompanionJob,
  failureReply,
  readCompanionJob,
} from "@/lib/companion/jobs";
import { companionOfflineMessage, companionOnline, listCompanions } from "@/lib/companion/pairing";
import { userLinks } from "@/lib/assistant/links";
import { aboutYouSection, getColleagues, getPersonalContext } from "@/lib/crm/personal-context";
import { memoryBriefing } from "@/lib/learning/memories";
import { latestBrief } from "@/lib/learning/nightly";
import { buildPrompt } from "@/lib/companion/transcript";
import { expandMentions, plainMentions } from "@/lib/mentions";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";

export const MAX_ROUNDS = 40;
export const STOPPED_MESSAGE = "I've stopped after a lot of steps. Ask again more narrowly, or say \"carry on\".";
export const FULL_MESSAGE = "I've read a lot in this step, more than the model can hold at once, so I've stopped here. Say \"carry on\" and I'll continue from what I found, or ask a narrower question.";
const EMPTY_REPLY = "I didn't get an answer back. Try again.";
const STOP_POLL_MS = 3_000;
const HISTORY_BUDGET = 900_000;
const OLD_RESULT_MAX = 100_000;
const CURRENT_RESULT_MAX = 400_000;
const COMPANION_POLL_MS = 500;
const COMPANION_CLAIM_MS = 20_000;
const TITLE_MAX = 80;
export const MESSAGE_MAX = 200_000;

export type ActionStatus = "pending" | "running" | "done" | "failed" | "declined";

export type AssistantAction = {
  id: string;
  name: string;
  title: string;
  lines: string[];
  status: ActionStatus;
  result?: string | null;
  alternative?: { key: "send"; label: string };
  chose?: "send";
  startedAt?: string;
  diff?: DocDiffLine[];
  docId?: string;
  unattended?: boolean;
};

export const UNATTENDED_NOTE = "Made without asking, because this doc lets the assistant edit it.";

export type ConversationSummary = {
  id: string;
  title: string;
  model: string;
  reasoning: ReasoningLevel;
  webSearch: boolean;
  updatedAt: string;
};

export type DisplayMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools: { id: string; name: string; label: string }[];
  actions: AssistantAction[];
  sources: Source[];
  files: ChatFile[];
  createdAt: string;
};

export type AssistantEvent =
  | { type: "conversation"; conversation: ConversationSummary }
  | { type: "user"; message: DisplayMessage }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "done" }
  | { type: "message"; message: DisplayMessage }
  | { type: "actions"; messageId: string; actions: AssistantAction[] }
  | { type: "done" }
  | { type: "ping" }
  | { type: "waiting"; message: string }
  | { type: "draft"; text: string }
  | { type: "error"; message: string };

type Emit = (event: AssistantEvent) => void;

type MessageRow = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  tool_name: string | null;
  actions: AssistantAction[] | null;
  sources: Source[] | null;
  provider_state: ProviderState | null;
  files?: ChatFile[] | null;
  created_at: Date | string;
};

type ConversationRow = {
  id: string;
  title: string;
  model: string;
  reasoning: ReasoningLevel;
  web_search: boolean;
  updated_at: Date | string;
  stopped_at: Date | string | null;
};

function summary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    reasoning: row.reasoning,
    webSearch: row.web_search,
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}

function display(row: MessageRow): DisplayMessage {
  return {
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    content: row.content,
    tools: (row.tool_calls ?? [])
      .filter((call) => !findTool(call.function.name)?.write)
      .map((call) => ({ id: call.id, name: call.function.name, label: findTool(call.function.name)?.label ?? call.function.name })),
    actions: row.actions ?? [],
    sources: row.sources ?? [],
    files: row.files ?? [],
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
  };
}

function parseArgs(raw: string) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const MESSAGE_COLUMNS = "id, role, content, tool_calls, tool_call_id, tool_name, actions, sources, provider_state, files, created_at";
const CONVERSATION_COLUMNS = "id, title, model, reasoning, web_search, updated_at, stopped_at";

async function readConversation(db: Db, actor: UserActor, id: string) {
  if (!isUuid(id)) throw new CrmError("not_found", "Conversation not found.", 404);
  const result = await db.query<ConversationRow>(
    `select ${CONVERSATION_COLUMNS} from crm.assistant_conversations
     where id = $1 and user_id = $2 and workspace_id = $3 and archived_at is null`,
    [id, actor.userId, actor.workspaceId],
  );
  if (!result.rows[0]) throw new CrmError("not_found", "Conversation not found.", 404);
  return result.rows[0];
}

async function readMessages(db: Db, conversationId: string) {
  const result = await db.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from crm.assistant_messages where conversation_id = $1 order by seq`,
    [conversationId],
  );
  return result.rows;
}

async function insertMessage(
  actor: UserActor,
  conversationId: string,
  message: {
    role: "user" | "assistant" | "tool";
    content: string;
    toolCalls?: ToolCall[] | null;
    toolCallId?: string | null;
    toolName?: string | null;
    sources?: Source[] | null;
    model?: string | null;
    usage?: Record<string, unknown> | null;
    state?: ProviderState | null;
    files?: ChatFile[];
  },
) {
  return withActor(actor, async (db) => {
    const result = await db.query<MessageRow>(
      `insert into crm.assistant_messages
         (conversation_id, workspace_id, user_id, role, content, tool_calls, tool_call_id, tool_name, sources, model, usage, provider_state, files)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13::jsonb)
       returning ${MESSAGE_COLUMNS}`,
      [
        conversationId,
        actor.workspaceId,
        actor.userId,
        message.role,
        message.content,
        message.toolCalls && message.toolCalls.length > 0 ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId ?? null,
        message.toolName ?? null,
        message.sources && message.sources.length > 0 ? JSON.stringify(message.sources) : null,
        message.model ?? null,
        message.usage ? JSON.stringify(message.usage) : null,
        message.state ? JSON.stringify(message.state) : null,
        message.files && message.files.length > 0 ? JSON.stringify(message.files) : null,
      ],
    );
    if (message.files && message.files.length > 0) {
      const claimed = await db.query(
        "update crm.chat_files set conversation_id = $1, message_id = $2 where id = any($3::uuid[]) and message_id is null",
        [conversationId, result.rows[0].id, message.files.map((file) => file.id)],
      );
      if (claimed.rowCount !== message.files.length) throw new CrmError("not_found", "A file has expired. Attach it again.", 404, { field: "files" });
    }
    await db.query("update crm.assistant_conversations set updated_at = now() where id = $1", [conversationId]);
    return result.rows[0];
  });
}

async function saveActions(actor: UserActor, messageId: string, actions: AssistantAction[]) {
  await withActor(actor, (db) =>
    db.query("update crm.assistant_messages set actions = $2::jsonb where id = $1", [messageId, JSON.stringify(actions)]),
  );
}

async function claimActions(
  actor: UserActor,
  messageId: string,
  next: (action: AssistantAction) => AssistantAction["status"] | null,
  options: { strict: boolean; from?: AssistantAction["status"]; extra?: Partial<AssistantAction> },
) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ actions: AssistantAction[] | null }>("select actions from crm.assistant_messages where id = $1 for update", [messageId]);
    const current = result.rows[0]?.actions ?? [];
    const claimed: AssistantAction[] = [];
    const actions = current.map((action) => {
      const status = next(action);
      if (!status) return action;
      if (action.status !== (options.from ?? "pending")) {
        if (options.strict) throw new AssistantError("That action has already been handled.");
        return action;
      }
      claimed.push(action);
      return { ...action, ...options.extra, status };
    });
    if (claimed.length > 0) await db.query("update crm.assistant_messages set actions = $2::jsonb where id = $1", [messageId, JSON.stringify(actions)]);
    return { actions, claimed };
  });
}

async function patchAction(actor: UserActor, messageId: string, id: string, patch: Partial<AssistantAction>) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ actions: AssistantAction[] }>(
      `update crm.assistant_messages set actions = (
         select jsonb_agg(case when entry.item->>'id' = $2 then entry.item || $3::jsonb else entry.item end order by entry.position)
         from jsonb_array_elements(actions) with ordinality as entry(item, position)
       )
       where id = $1 returning actions`,
      [messageId, id, JSON.stringify(patch)],
    );
    return result.rows[0]?.actions ?? [];
  });
}

export async function listConversations(actor: UserActor): Promise<ConversationSummary[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<ConversationRow>(
      `select ${CONVERSATION_COLUMNS} from crm.assistant_conversations
       where user_id = $1 and workspace_id = $2 and archived_at is null
       order by updated_at desc limit 100`,
      [actor.userId, actor.workspaceId],
    );
    return result.rows.map(summary);
  });
}

const STUCK_MS = 6 * 60_000;
export const STUCK_RESULT = "This didn't finish. Check whether it happened before trying again.";

async function settleStuckActions(actor: UserActor, conversationId: string, rows: MessageRow[]) {
  const now = Date.now();
  const answered = new Set(rows.filter((row) => row.role === "tool").map((row) => row.tool_call_id));
  let settled = false;
  for (const row of rows) {
    const stuck = (action: AssistantAction) =>
      action.status === "running" && now - new Date(action.startedAt ?? row.created_at).getTime() > STUCK_MS;
    if (!(row.actions ?? []).some(stuck)) continue;
    const { claimed } = await claimActions(actor, row.id, (action) => (stuck(action) ? "failed" : null), {
      strict: false,
      from: "running",
      extra: { result: STUCK_RESULT },
    });
    for (const action of claimed) {
      settled = true;
      if (answered.has(action.id)) continue;
      await insertMessage(actor, conversationId, { role: "tool", content: toolJson({ error: STUCK_RESULT }), toolCallId: action.id, toolName: action.name });
    }
  }
  return settled;
}

export type Working = { where: "mac" | "orbit"; steps: number; current: string | null; since: string };

const MID_TURN_MS = 6 * 60_000;

type JobProgress = { status: string; created_at: Date; claimed_at: Date | null; events: { id: string; label: string; status: string }[] };

function workingState(rows: MessageRow[], conversation: ConversationRow, job: JobProgress | null): Working | null {
  const updatedAt = conversation.updated_at;
  if (job) {
    const done = new Set(job.events.filter((event) => event.status === "done").map((event) => event.id));
    const running = [...job.events].reverse().find((event) => event.status === "running" && !done.has(event.id));
    return { where: "mac", steps: done.size, current: running?.label ?? null, since: new Date(job.claimed_at ?? job.created_at).toISOString() };
  }
  const last = rows.at(-1);
  if (!last || Date.now() - new Date(updatedAt).getTime() > MID_TURN_MS) return null;
  const waitingOnTools = last.role === "assistant" && (last.tool_calls ?? []).length > 0 && !(last.actions ?? []).some((action) => action.status === "pending");
  if (last.role !== "user" && last.role !== "tool" && !waitingOnTools) return null;
  const since = [...rows].reverse().find((row) => row.role === "user")?.created_at ?? updatedAt;
  if (conversation.stopped_at && new Date(conversation.stopped_at) >= new Date(since)) return null;
  return { where: "orbit", steps: rows.filter((row) => row.role === "tool" && new Date(row.created_at) >= new Date(since)).length, current: null, since: new Date(since).toISOString() };
}

export async function getConversation(actor: UserActor, id: string) {
  const before = await withActor(actor, async (db) => {
    await readConversation(db, actor, id);
    return readMessages(db, id);
  });
  await settleStuckActions(actor, id, before);
  return withActor(actor, async (db) => {
    const conversation = await readConversation(db, actor, id);
    const messages = await readMessages(db, id);
    const job = await db.query<JobProgress>(
      `select status, created_at, claimed_at, events from crm.ai_companion_jobs
       where conversation_id = $1 and status in ('queued', 'running') order by created_at desc limit 1`,
      [id],
    );
    return {
      conversation: summary(conversation),
      messages: messages
        .filter((row) => row.role !== "tool")
        .filter((row) => row.role === "user" || row.content || (row.tool_calls ?? []).length > 0 || (row.actions ?? []).length > 0)
        .map(display),
      working: workingState(messages, conversation, job.rows[0] ?? null),
    };
  });
}

export async function deleteConversation(actor: UserActor, id: string, fetchImpl: typeof fetch = fetch) {
  const files = await withActor(actor, async (db) => {
    await readConversation(db, actor, id);
    const removed = await db.query<{ id: string }>("delete from crm.chat_files where conversation_id = $1 returning id", [id]);
    await db.query("delete from crm.assistant_conversations where id = $1", [id]);
    return removed.rows.map((row) => row.id);
  });
  await removeChatObjects(files, fetchImpl);
}

async function openConversation(
  actor: UserActor,
  input: { conversationId?: string | null; model: string; reasoning: ReasoningLevel; webSearch: boolean; title?: string },
) {
  return withActor(actor, async (db) => {
    if (input.conversationId) {
      await readConversation(db, actor, input.conversationId);
      const result = await db.query<ConversationRow>(
        `update crm.assistant_conversations set model = $2, reasoning = $3, web_search = $4, updated_at = now()
         where id = $1 returning ${CONVERSATION_COLUMNS}`,
        [input.conversationId, input.model, input.reasoning, input.webSearch],
      );
      return result.rows[0];
    }
    const result = await db.query<ConversationRow>(
      `insert into crm.assistant_conversations (workspace_id, user_id, title, model, reasoning, web_search)
       values ($1, $2, $3, $4, $5, $6) returning ${CONVERSATION_COLUMNS}`,
      [actor.workspaceId, actor.userId, input.title || "New chat", input.model, input.reasoning, input.webSearch],
    );
    return result.rows[0];
  });
}

function clipResult(content: string, max: number) {
  return content.length > max
    ? `${content.slice(0, max)}\n[Cut ${content.length - max} characters to save space. Call the tool again if you need the rest.]`
    : content;
}

function weight(message: ChatMessage) {
  const calls = message.role === "assistant" && message.tool_calls ? message.tool_calls.reduce((sum, call) => sum + call.function.arguments.length, 0) : 0;
  return (typeof message.content === "string" ? message.content.length : 0) + calls;
}

function userContent(row: MessageRow) {
  const note = chatFileNote(row.files ?? []);
  const typed = expandMentions(row.content);
  return note ? (typed.trim() ? `${typed}\n\n${note}` : note) : typed;
}

export function history(rows: MessageRow[], budget = HISTORY_BUDGET): ChatMessage[] {
  const answered = new Set(rows.filter((row) => row.role === "tool").map((row) => row.tool_call_id));
  const lastUser = rows.map((row) => row.role).lastIndexOf("user");
  const messages: ChatMessage[] = [];
  rows.forEach((row, index) => {
    if (row.role === "user") messages.push({ role: "user", content: userContent(row) });
    else if (row.role === "tool" && row.tool_call_id) {
      messages.push({ role: "tool", tool_call_id: row.tool_call_id, content: clipResult(row.content, index > lastUser ? CURRENT_RESULT_MAX : OLD_RESULT_MAX) });
    } else if (row.role === "assistant") {
      const calls = (row.tool_calls ?? []).filter((call) => answered.has(call.id));
      if (calls.length === 0 && !row.content.trim()) return;
      const state = row.provider_state ?? null;
      messages.push(
        calls.length > 0
          ? { role: "assistant", content: row.content || null, tool_calls: calls, state }
          : { role: "assistant", content: row.content || "", state },
      );
    }
  });
  const suffix = new Array<number>(messages.length + 1).fill(0);
  for (let index = messages.length - 1; index >= 0; index -= 1) suffix[index] = suffix[index + 1] + weight(messages[index]);
  if (suffix[0] <= budget) return messages;
  const starts = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  const start = starts.find((index) => suffix[index] <= budget) ?? starts[starts.length - 1] ?? 0;
  const kept = messages.slice(start);
  const first = kept[0];
  if (first?.role === "user") {
    kept[0] = { role: "user", content: `(Earlier parts of this conversation were left out to save space. Ask the user if you need something from them.)\n\n${first.content}` };
  }
  return kept;
}

function titleFrom(message: string) {
  const clean = plainMentions(message).replace(/\s+/g, " ").trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…` : clean || "New chat";
}

async function declinePending(actor: UserActor, conversationId: string, rows: MessageRow[], reason: string) {
  for (const row of rows) {
    if (!(row.actions ?? []).some((action) => action.status === "pending")) continue;
    const { claimed } = await claimActions(actor, row.id, (action) => (action.status === "pending" ? "declined" : null), { strict: false });
    for (const action of claimed) {
      await insertMessage(actor, conversationId, {
        role: "tool",
        content: toolJson({ declined: true, message: reason }),
        toolCallId: action.id,
        toolName: action.name,
      });
    }
  }
}

function companionTools() {
  return [
    ...ASSISTANT_TOOLS.map((tool) => ({
      name: tool.name,
      description: toolDescription(tool),
      parameters: tool.parameters,
      write: Boolean(tool.write),
    })),
    CONTINUE_RESULT_TOOL,
  ];
}

function toToolCall(call: { id: string; name: string; arguments: string }): ToolCall {
  return { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } };
}

export async function applyCompanionResult(actor: UserActor, conversationId: string, result: CompanionResult) {
  await withActor(actor, (db) => readConversation(db, actor, conversationId));
  const entries: { content: string; reads: ToolCall[] }[] = [];
  const writes: ToolCall[] = [];
  for (const step of result.steps) {
    const reads: ToolCall[] = [];
    for (const call of step.calls) {
      const tool = findTool(call.name);
      if (!tool) continue;
      (tool.write ? writes : reads).push(toToolCall(call));
    }
    if (step.text.trim() || reads.length > 0) entries.push({ content: step.text.trim(), reads });
  }
  if (entries.length === 0) entries.push({ content: writes.length > 0 ? "" : EMPTY_REPLY, reads: [] });
  const ids: string[] = [];
  let last: MessageRow | null = null;
  for (const [index, entry] of entries.entries()) {
    const final = index === entries.length - 1;
    const toolCalls = final ? [...entry.reads, ...writes] : entry.reads;
    last = await insertMessage(actor, conversationId, {
      role: "assistant",
      content: entry.content,
      toolCalls,
      sources: final ? result.sources : null,
      model: final ? result.model : null,
      usage: final ? result.usage : null,
    });
    ids.push(last.id);
    for (const call of entry.reads) {
      const output = result.results[call.id];
      await insertMessage(actor, conversationId, {
        role: "tool",
        content: output?.content ?? toolJson({ error: "No result came back for this tool." }),
        toolCallId: call.id,
        toolName: call.function.name,
      });
    }
  }
  if (writes.length > 0 && last) {
    const names = await recordNames(
      actor,
      writes.map((call) => parseArgs(call.function.arguments)),
      writes.map((call) => call.function.name),
    ).catch(() => new Map<string, string>());
    const actions: AssistantAction[] = writes.map((call) => ({
      id: call.id,
      name: call.function.name,
      ...describeAction(call.function.name, parseArgs(call.function.arguments), names),
      ...docLinkOf(call.function.name, parseArgs(call.function.arguments)),
      ...(actionAlternative(call.function.name) ? { alternative: actionAlternative(call.function.name) } : {}),
      status: "pending",
    }));
    await saveActions(actor, last.id, actions);
  }
  return ids;
}

async function promptFor(actor: UserActor, conversation: ConversationRow) {
  const [links, about, colleagues, brief, focus] = await Promise.all([
    userLinks(actor).catch(() => null),
    getPersonalContext(actor).catch(() => null),
    getColleagues(actor).catch(() => []),
    latestBrief(actor).catch(() => null),
    withActor(actor, async (db) =>
      (
        await db.query<{ content: string }>(
          "select content from crm.assistant_messages where conversation_id = $1 and role = 'user' order by seq desc limit 2",
          [conversation.id],
        )
      ).rows
        .map((row) => row.content)
        .join("\n"),
    ).catch(() => ""),
  ]);
  const learned = await memoryBriefing(actor, { focus }).catch(() => "");
  return {
    system: systemPrompt(actor, { webSearch: conversation.web_search, links, about: aboutYouSection(about, colleagues), briefReady: Boolean(brief) }),
    learned,
  };
}

const LEARNED_NOTE = "(Orbit added these notes before the conversation. They are not a message from the user.)";

function learnedMessages(learned: string): ChatMessage[] {
  if (!learned) return [];
  return [
    { role: "user", content: `${learned}\n\n${LEARNED_NOTE}` },
    { role: "assistant", content: "Noted. I'll treat these as information only." },
  ];
}

async function runCompanionTurn(actor: UserActor, conversation: ConversationRow, apiModel: string, emit: Emit, deadline: number, signal?: AbortSignal) {
  if (!(await companionOnline(actor)) && !(await companionWorking(actor))) throw new AssistantError(await companionOfflineMessage(actor));
  const rows = await withActor(actor, (db) => readMessages(db, conversation.id));
  const earlier = new Set(rows.map((row) => row.id));
  const { system, learned } = await promptFor(actor, conversation);
  const transcript = buildPrompt(history(rows));
  const jobId = await enqueueCompanionJob(actor, conversation.id, {
    model: apiModel,
    effort: conversation.reasoning as Effort,
    webSearch: conversation.web_search,
    system,
    prompt: learned ? `${learned}\n${LEARNED_NOTE}\n\n${transcript}` : transcript,
    tools: companionTools(),
  });
  const show = (row: MessageRow) => {
    emit({ type: "message", message: display(row) });
    if ((row.actions ?? []).length > 0) emit({ type: "actions", messageId: row.id, actions: row.actions ?? [] });
  };
  const started = Date.now();
  let seen = 0;
  let draft: string | null = null;
  let queuedNotice = false;
  while (Date.now() < deadline - 5_000) {
    if (signal?.aborted) {
      await cancelCompanionJob(actor, jobId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, COMPANION_POLL_MS));
    const job = await readCompanionJob(actor, jobId);
    for (const event of job.events.slice(seen)) emit(event);
    seen = job.events.length;
    if (job.status === "running" && job.draft && job.draft !== draft) {
      draft = job.draft;
      emit({ type: "draft", text: job.draft });
    }
    if (job.status === "done") {
      if (!job.result) continue;
      const ids = new Set(job.result.messageIds);
      const saved = await withActor(actor, (db) => readMessages(db, conversation.id));
      for (const row of saved.filter((entry) => ids.has(entry.id))) show(row);
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      const saved = await withActor(actor, (db) => readMessages(db, conversation.id));
      for (const row of saved.filter((entry) => !earlier.has(entry.id) && entry.role === "assistant")) show(row);
      return;
    }
    if (job.status === "queued" && Date.now() - started > COMPANION_CLAIM_MS) {
      if (await companionBusy(actor, jobId)) {
        if (!queuedNotice) emit({ type: "waiting", message: "Waiting for your Mac to finish another answer." });
        queuedNotice = true;
        continue;
      }
      await cancelCompanionJob(actor, jobId);
      throw new AssistantError("Orbit Agent on your Mac isn't picking up. Check it's still running, then try again.");
    }
  }
  emit({ type: "waiting", message: "Still working on your Mac." });
}

type TurnOptions = { deadline: number; fetchImpl?: typeof fetch; signal?: AbortSignal };

async function turnMarker(actor: UserActor, conversationId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ stopped_at: Date | null; last_user: string | null }>(
      `select c.stopped_at,
         (select m.id from crm.assistant_messages m where m.conversation_id = c.id and m.role = 'user' order by m.seq desc limit 1) as last_user
       from crm.assistant_conversations c where c.id = $1`,
      [conversationId],
    );
    const row = result.rows[0];
    return row ? `${row.stopped_at ? new Date(row.stopped_at).toISOString() : ""}|${row.last_user ?? ""}` : "";
  });
}

export async function connectedSources(actor: UserActor): Promise<ModelSource[]> {
  const [providers, companions] = await Promise.all([connectedProviders(actor), listCompanions(actor)]);
  return [...providers, ...(companions.length > 0 ? (["claude"] as const) : [])];
}

export async function stopConversation(actor: UserActor, id: string) {
  await withActor(actor, async (db) => {
    await readConversation(db, actor, id);
    await db.query("update crm.assistant_conversations set stopped_at = now() where id = $1", [id]);
  });
}

async function runLoop(actor: UserActor, conversation: ConversationRow, emit: Emit, options: TurnOptions) {
  const baseline = await turnMarker(actor, conversation.id).catch(() => null);
  const stop = new AbortController();
  const watch =
    baseline === null
      ? null
      : setInterval(() => {
          void turnMarker(actor, conversation.id).then(
            (marker) => {
              if (marker !== baseline) stop.abort();
            },
            () => undefined,
          );
        }, STOP_POLL_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  try {
    await runRounds(actor, conversation, emit, { ...options, signal });
  } catch (error) {
    if (!(error instanceof AssistantError)) throw error;
    if (error instanceof StoppedError || signal.aborted) return;
    const failed = await insertMessage(actor, conversation.id, {
      role: "assistant",
      content: failureReply(error.message),
    });
    emit({ type: "message", message: display(failed) });
  } finally {
    if (watch) clearInterval(watch);
  }
}

const DRAFT_EVERY_MS = 80;

function draftEmitter(emit: Emit) {
  let last = 0;
  return (text: string) => {
    const now = Date.now();
    if (now - last < DRAFT_EVERY_MS) return;
    last = now;
    emit({ type: "draft", text });
  };
}

async function runRounds(actor: UserActor, conversation: ConversationRow, emit: Emit, options: TurnOptions) {
  const { deadline, fetchImpl, signal } = options;
  const chosen = assistantModel(conversation.model);
  if (chosen?.source === "claude") return runCompanionTurn(actor, conversation, chosen.apiModel, emit, deadline, signal);
  const { system, learned } = await promptFor(actor, conversation);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (signal?.aborted) return;
    const rows = await withActor(actor, (db) => readMessages(db, conversation.id));
    const remaining = deadline - Date.now();
    if (remaining < 15_000) {
      const paused = await insertMessage(actor, conversation.id, {
        role: "assistant",
        content: "I ran out of time on this step. Say \"carry on\" and I'll pick up where I left off.",
      });
      emit({ type: "message", message: display(paused) });
      return;
    }
    const messages = history(rows);
    if (round > 0 && messages.reduce((sum, message) => sum + weight(message), 0) > HISTORY_BUDGET) {
      const full = await insertMessage(actor, conversation.id, { role: "assistant", content: FULL_MESSAGE });
      emit({ type: "message", message: display(full) });
      return;
    }
    const result = await complete({
      model: conversation.model,
      reasoning: conversation.reasoning,
      webSearch: conversation.web_search,
      messages: [{ role: "system", content: system }, ...learnedMessages(learned), ...messages],
      timeoutMs: Math.min(240_000, remaining - 5_000),
      fetchImpl,
      actor,
      signal,
      onText: draftEmitter(emit),
    });
    if (signal?.aborted) return;
    const saved = await insertMessage(actor, conversation.id, {
      role: "assistant",
      content: result.content.trim() || result.toolCalls.length > 0 ? result.content : EMPTY_REPLY,
      toolCalls: result.toolCalls,
      sources: result.sources,
      model: result.model,
      usage: result.usage,
      state: result.state ?? null,
    });
    if (result.toolCalls.length === 0) {
      emit({ type: "message", message: display(saved) });
      return;
    }
    emit({ type: "message", message: display(saved) });
    const reads = result.toolCalls.filter((call) => !findTool(call.function.name)?.write);
    const writes = result.toolCalls.filter((call) => findTool(call.function.name)?.write);
    await Promise.all(
      reads.map(async (call) => {
        const label = findTool(call.function.name)?.label ?? call.function.name;
        emit({ type: "tool", id: call.id, name: call.function.name, label, status: "running" });
        const output = await runTool(actor, call.function.name, parseArgs(call.function.arguments), { deadline: deadline - 20_000 });
        await insertMessage(actor, conversation.id, {
          role: "tool",
          content: toolJson(output),
          toolCallId: call.id,
          toolName: call.function.name,
        });
        emit({ type: "tool", id: call.id, name: call.function.name, label, status: "done" });
      }),
    );
    if (signal?.aborted) return;
    if (writes.length > 0) {
      const unattended = new Set<string>();
      for (const call of writes) {
        if (await editsWithoutApproval(actor, call.function.name, parseArgs(call.function.arguments)).catch(() => false)) unattended.add(call.id);
      }
      const names = await recordNames(
        actor,
        writes.map((call) => parseArgs(call.function.arguments)),
        writes.map((call) => call.function.name),
      ).catch(() => new Map<string, string>());
      let actions: AssistantAction[] = writes.map((call) => {
        const described = describeAction(call.function.name, parseArgs(call.function.arguments), names);
        const automatic = unattended.has(call.id);
        return {
          id: call.id,
          name: call.function.name,
          ...described,
          ...docLinkOf(call.function.name, parseArgs(call.function.arguments)),
          ...(automatic ? { lines: [...described.lines, UNATTENDED_NOTE], unattended: true } : {}),
          ...(actionAlternative(call.function.name) ? { alternative: actionAlternative(call.function.name) } : {}),
          status: automatic ? "running" : "pending",
          ...(automatic ? { startedAt: new Date().toISOString() } : {}),
        };
      });
      await saveActions(actor, saved.id, actions);
      emit({ type: "actions", messageId: saved.id, actions });
      for (const call of writes.filter((entry) => unattended.has(entry.id))) {
        const label = findTool(call.function.name)?.label ?? call.function.name;
        emit({ type: "tool", id: call.id, name: call.function.name, label, status: "running" });
        const output = (await runTool(actor, call.function.name, parseArgs(call.function.arguments), {
          deadline: deadline - 20_000,
          callId: call.id,
          unattended: true,
        })) as Record<string, unknown> | null;
        const failed = Boolean(output && typeof output === "object" && "error" in output);
        await insertMessage(actor, conversation.id, { role: "tool", content: toolJson(output), toolCallId: call.id, toolName: call.function.name });
        actions = await patchAction(actor, saved.id, call.id, { status: failed ? "failed" : "done", result: failed ? String((output as { error: unknown }).error) : null });
        emit({ type: "tool", id: call.id, name: call.function.name, label, status: "done" });
        emit({ type: "actions", messageId: saved.id, actions });
      }
      if (actions.some((action) => action.status === "pending")) return;
      continue;
    }
  }
  const stopped = await insertMessage(actor, conversation.id, {
    role: "assistant",
    content: STOPPED_MESSAGE,
  });
  emit({ type: "message", message: display(stopped) });
}

export async function sendMessage(
  actor: UserActor,
  input: { conversationId?: string | null; message: string; model: unknown; reasoning: unknown; webSearch: unknown; files?: unknown },
  emit: Emit,
  options: TurnOptions,
) {
  const message = input.message.trim();
  const files = await chatFilesFor(actor, input.files);
  if (!message && files.length === 0) throw new AssistantError("Type a message first.");
  if (message.length > MESSAGE_MAX) {
    throw new AssistantError(
      `That message is ${message.length.toLocaleString("en-GB")} characters. The limit is ${MESSAGE_MAX.toLocaleString("en-GB")}. Cut ${(message.length - MESSAGE_MAX).toLocaleString("en-GB")} characters and send it again.`,
    );
  }
  const settings = settingsFor(input.model, input.reasoning);
  const picked = assistantModel(settings.model);
  if (picked && picked.source !== "orbit") {
    const connected = await connectedSources(actor).catch(() => null);
    if (connected && !connected.includes(picked.source)) {
      throw new AssistantError(
        picked.source === "claude"
          ? "To use your Claude account, pair your Mac in Settings › Integrations, or pick one of Orbit's models."
          : "To use your ChatGPT account, connect it in Settings › Integrations, or pick one of Orbit's models.",
      );
    }
  }
  const conversation = await openConversation(actor, {
    conversationId: input.conversationId,
    model: settings.model,
    reasoning: settings.reasoning,
    webSearch: input.webSearch === true,
    title: titleFrom(message || files.map((file) => file.name).join(", ")),
  });
  emit({ type: "conversation", conversation: summary(conversation) });
  const rows = await withActor(actor, (db) => readMessages(db, conversation.id));
  await settleStuckActions(actor, conversation.id, rows);
  await declinePending(actor, conversation.id, rows, "The user moved on without confirming this action.");
  const user = await insertMessage(actor, conversation.id, { role: "user", content: message, files });
  emit({ type: "user", message: display(user) });
  await runLoop(actor, conversation, emit, options);
  emit({ type: "done" });
}

export type ActionDecision = { id: string; approve: boolean; variant?: "send" };

export async function decideActions(
  actor: UserActor,
  input: { conversationId: string; decisions: ActionDecision[] },
  emit: Emit,
  options: TurnOptions,
) {
  const { conversation, rows } = await withActor(actor, async (db) => ({
    conversation: await readConversation(db, actor, input.conversationId),
    rows: await readMessages(db, input.conversationId),
  }));
  emit({ type: "conversation", conversation: summary(conversation) });
  const decisions = new Map(input.decisions.map((decision) => [decision.id, decision.approve]));
  const variants = new Map(input.decisions.map((decision) => [decision.id, decision.variant]));
  const owner = rows.find((row) => (row.actions ?? []).some((action) => decisions.has(action.id)));
  if (!owner || decisions.size === 0) throw new AssistantError("That action is no longer available.");
  const chosen = (owner.actions ?? []).filter((action) => decisions.has(action.id));
  if (chosen.length !== decisions.size) throw new AssistantError("Some of those actions are no longer available.");
  if (chosen.some((action) => action.status !== "pending")) throw new AssistantError("That action has already been handled.");
  const callFor = (id: string) => (owner.tool_calls ?? []).find((entry) => entry.id === id);
  const runs = (action: AssistantAction) => Boolean(decisions.get(action.id) && callFor(action.id));
  const claim = await claimActions(actor, owner.id, (action) => (decisions.has(action.id) ? (runs(action) ? "running" : "declined") : null), {
    strict: true,
    extra: { startedAt: new Date().toISOString() },
  });
  let actions = claim.actions;
  emit({ type: "actions", messageId: owner.id, actions });
  const update = async (id: string, patch: Partial<AssistantAction>) => {
    actions = await patchAction(actor, owner.id, id, patch);
    emit({ type: "actions", messageId: owner.id, actions });
  };
  for (const action of claim.claimed) {
    const call = callFor(action.id);
    if (!runs(action) || !call) {
      await insertMessage(actor, conversation.id, {
        role: "tool",
        content: toolJson({ declined: true, message: "The user declined this action." }),
        toolCallId: action.id,
        toolName: action.name,
      });
      continue;
    }
    const alternative = variants.get(action.id) ? ACTION_ALTERNATIVES[action.name] : undefined;
    const chosenAlternative = alternative && alternative.key === variants.get(action.id) ? alternative : undefined;
    const output = (await runTool(actor, chosenAlternative?.tool ?? call.function.name, parseArgs(call.function.arguments), {
      deadline: options.deadline - 20_000,
      callId: call.id,
    })) as Record<string, unknown> | null;
    const failed = Boolean(output && typeof output === "object" && "error" in output);
    await insertMessage(actor, conversation.id, {
      role: "tool",
      content: toolJson(
        chosenAlternative && output && typeof output === "object"
          ? { ...output, note: `The user chose ${chosenAlternative.label}, so this ran ${chosenAlternative.tool} instead of ${action.name}.` }
          : output,
      ),
      toolCallId: action.id,
      toolName: action.name,
    });
    await update(action.id, {
      status: failed ? "failed" : "done",
      result: failed ? String((output as { error: unknown }).error) : null,
      ...(chosenAlternative && !failed ? { chose: chosenAlternative.key, title: chosenAlternative.title(action.title), lines: chosenAlternative.lines(action.lines) } : {}),
    });
  }
  if (actions.some((entry) => entry.status === "pending")) {
    emit({ type: "done" });
    return;
  }
  await runLoop(actor, conversation, emit, options);
  emit({ type: "done" });
}

export function readDecisions(body: Record<string, unknown>): ActionDecision[] | null {
  const variant = (value: unknown) => (value === "send" ? { variant: "send" as const } : {});
  if (typeof body.actionId === "string") return [{ id: body.actionId, approve: body.approve === true, ...variant(body.variant) }];
  if (!Array.isArray(body.decisions)) return null;
  const decisions = body.decisions.flatMap((entry) =>
    entry && typeof entry === "object" && typeof (entry as ActionDecision).id === "string"
      ? [{ id: (entry as ActionDecision).id, approve: (entry as ActionDecision).approve === true, ...variant((entry as ActionDecision).variant) }]
      : [],
  );
  return decisions.length > 0 && decisions.length <= 100 ? decisions : null;
}
