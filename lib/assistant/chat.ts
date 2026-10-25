import { AssistantError, complete, type ChatMessage, type ProviderState, type Source, type ToolCall } from "@/lib/assistant/gateway";
import { assistantModel, settingsFor, type ReasoningLevel } from "@/lib/assistant/models";
import { systemPrompt } from "@/lib/assistant/prompt";
import { ACTION_ALTERNATIVES, ASSISTANT_TOOLS, TOOL_BY_NAME, actionAlternative, describeAction, recordNames, runTool, toolJson } from "@/lib/assistant/tools";
import type { CompanionResult, Effort } from "@/companion/src/protocol";
import { cancelCompanionJob, enqueueCompanionJob, readCompanionJob } from "@/lib/companion/jobs";
import { companionOfflineMessage, companionOnline } from "@/lib/companion/pairing";
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

const MAX_ROUNDS = 24;
const COMPANION_POLL_MS = 1_000;
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
};

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
  created_at: Date | string;
};

type ConversationRow = {
  id: string;
  title: string;
  model: string;
  reasoning: ReasoningLevel;
  web_search: boolean;
  updated_at: Date | string;
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
      .filter((call) => !TOOL_BY_NAME.get(call.function.name)?.write)
      .map((call) => ({ id: call.id, name: call.function.name, label: TOOL_BY_NAME.get(call.function.name)?.label ?? call.function.name })),
    actions: row.actions ?? [],
    sources: row.sources ?? [],
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

const MESSAGE_COLUMNS = "id, role, content, tool_calls, tool_call_id, tool_name, actions, sources, provider_state, created_at";
const CONVERSATION_COLUMNS = "id, title, model, reasoning, web_search, updated_at";

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
  },
) {
  return withActor(actor, async (db) => {
    const result = await db.query<MessageRow>(
      `insert into crm.assistant_messages
         (conversation_id, workspace_id, user_id, role, content, tool_calls, tool_call_id, tool_name, sources, model, usage, provider_state)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb)
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
      ],
    );
    await db.query("update crm.assistant_conversations set updated_at = now() where id = $1", [conversationId]);
    return result.rows[0];
  });
}

async function saveActions(actor: UserActor, messageId: string, actions: AssistantAction[]) {
  await withActor(actor, (db) =>
    db.query("update crm.assistant_messages set actions = $2::jsonb where id = $1", [messageId, JSON.stringify(actions)]),
  );
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

export async function getConversation(actor: UserActor, id: string) {
  return withActor(actor, async (db) => {
    const conversation = await readConversation(db, actor, id);
    const messages = await readMessages(db, id);
    return {
      conversation: summary(conversation),
      messages: messages
        .filter((row) => row.role !== "tool")
        .filter((row) => row.role === "user" || row.content || (row.tool_calls ?? []).length > 0 || (row.actions ?? []).length > 0)
        .map(display),
    };
  });
}

export async function deleteConversation(actor: UserActor, id: string) {
  await withActor(actor, async (db) => {
    await readConversation(db, actor, id);
    await db.query("delete from crm.assistant_conversations where id = $1", [id]);
  });
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

function history(rows: MessageRow[]): ChatMessage[] {
  const answered = new Set(rows.filter((row) => row.role === "tool").map((row) => row.tool_call_id));
  const messages: ChatMessage[] = [];
  for (const row of rows) {
    if (row.role === "user") messages.push({ role: "user", content: expandMentions(row.content) });
    else if (row.role === "tool" && row.tool_call_id) messages.push({ role: "tool", tool_call_id: row.tool_call_id, content: row.content });
    else if (row.role === "assistant") {
      const calls = (row.tool_calls ?? []).filter((call) => answered.has(call.id));
      const state = row.provider_state ?? null;
      messages.push(
        calls.length > 0
          ? { role: "assistant", content: row.content || null, tool_calls: calls, state }
          : { role: "assistant", content: row.content || "", state },
      );
    }
  }
  return messages;
}

function titleFrom(message: string) {
  const clean = plainMentions(message).replace(/\s+/g, " ").trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…` : clean || "New chat";
}

async function declinePending(actor: UserActor, conversationId: string, rows: MessageRow[], reason: string) {
  for (const row of rows) {
    const pending = (row.actions ?? []).filter((action) => action.status === "pending");
    if (pending.length === 0) continue;
    for (const action of pending) {
      await insertMessage(actor, conversationId, {
        role: "tool",
        content: toolJson({ declined: true, message: reason }),
        toolCallId: action.id,
        toolName: action.name,
      });
    }
    await saveActions(
      actor,
      row.id,
      (row.actions ?? []).map((action) => (action.status === "pending" ? { ...action, status: "declined" as const } : action)),
    );
  }
}

function companionTools() {
  return ASSISTANT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    write: Boolean(tool.write),
  }));
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
      const tool = TOOL_BY_NAME.get(call.name);
      if (!tool) continue;
      (tool.write ? writes : reads).push(toToolCall(call));
    }
    if (step.text.trim() || reads.length > 0) entries.push({ content: step.text.trim(), reads });
  }
  if (entries.length === 0) entries.push({ content: writes.length > 0 ? "" : "I didn't get an answer back. Try again.", reads: [] });
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
    ).catch(() => new Map<string, string>());
    const actions: AssistantAction[] = writes.map((call) => ({
      id: call.id,
      name: call.function.name,
      ...describeAction(call.function.name, parseArgs(call.function.arguments), names),
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
  const learned = await memoryBriefing(actor, { brief: brief?.body ?? null, focus }).catch(() => "");
  return systemPrompt(actor, { webSearch: conversation.web_search, links, about: aboutYouSection(about, colleagues) + learned });
}

async function runCompanionTurn(actor: UserActor, conversation: ConversationRow, apiModel: string, emit: Emit, deadline: number) {
  if (!(await companionOnline(actor))) throw new AssistantError(await companionOfflineMessage(actor));
  const rows = await withActor(actor, (db) => readMessages(db, conversation.id));
  const jobId = await enqueueCompanionJob(actor, conversation.id, {
    model: apiModel,
    effort: conversation.reasoning as Effort,
    webSearch: conversation.web_search,
    system: await promptFor(actor, conversation),
    prompt: buildPrompt(history(rows)),
    tools: companionTools(),
  });
  const started = Date.now();
  let seen = 0;
  while (Date.now() < deadline - 5_000) {
    await new Promise((resolve) => setTimeout(resolve, COMPANION_POLL_MS));
    const job = await readCompanionJob(actor, jobId);
    for (const event of job.events.slice(seen)) emit(event);
    seen = job.events.length;
    if (job.status === "done") {
      const ids = new Set(job.result?.messageIds ?? []);
      const saved = await withActor(actor, (db) => readMessages(db, conversation.id));
      for (const row of saved.filter((entry) => ids.has(entry.id))) {
        emit({ type: "message", message: display(row) });
        if ((row.actions ?? []).length > 0) emit({ type: "actions", messageId: row.id, actions: row.actions ?? [] });
      }
      return;
    }
    if (job.status === "failed") throw new AssistantError(job.error ?? "Orbit Agent couldn't answer.");
    if (job.status === "cancelled") return;
    if (job.status === "queued" && Date.now() - started > COMPANION_CLAIM_MS) {
      await cancelCompanionJob(actor, jobId);
      throw new AssistantError("Orbit Agent on your Mac isn't picking up. Check it's still running, then try again.");
    }
  }
  emit({ type: "waiting", message: "Claude is still working on your Mac. The answer will appear here when it's ready." });
}

async function runLoop(
  actor: UserActor,
  conversation: ConversationRow,
  emit: Emit,
  deadline: number,
  fetchImpl?: typeof fetch,
) {
  const chosen = assistantModel(conversation.model);
  if (chosen?.source === "claude") return runCompanionTurn(actor, conversation, chosen.apiModel, emit, deadline);
  const system = await promptFor(actor, conversation);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
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
    const result = await complete({
      model: conversation.model,
      reasoning: conversation.reasoning,
      webSearch: conversation.web_search,
      messages: [{ role: "system", content: system }, ...history(rows)],
      timeoutMs: Math.min(240_000, remaining - 5_000),
      fetchImpl,
      actor,
    });
    const saved = await insertMessage(actor, conversation.id, {
      role: "assistant",
      content: result.content,
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
    const reads = result.toolCalls.filter((call) => !TOOL_BY_NAME.get(call.function.name)?.write);
    const writes = result.toolCalls.filter((call) => TOOL_BY_NAME.get(call.function.name)?.write);
    await Promise.all(
      reads.map(async (call) => {
        const label = TOOL_BY_NAME.get(call.function.name)?.label ?? call.function.name;
        emit({ type: "tool", id: call.id, name: call.function.name, label, status: "running" });
        const output = await runTool(actor, call.function.name, parseArgs(call.function.arguments));
        await insertMessage(actor, conversation.id, {
          role: "tool",
          content: toolJson(output),
          toolCallId: call.id,
          toolName: call.function.name,
        });
        emit({ type: "tool", id: call.id, name: call.function.name, label, status: "done" });
      }),
    );
    if (writes.length > 0) {
      const names = await recordNames(
        actor,
        writes.map((call) => parseArgs(call.function.arguments)),
      ).catch(() => new Map<string, string>());
      const actions: AssistantAction[] = writes.map((call) => ({
        id: call.id,
        name: call.function.name,
        ...describeAction(call.function.name, parseArgs(call.function.arguments), names),
        ...(actionAlternative(call.function.name) ? { alternative: actionAlternative(call.function.name) } : {}),
        status: "pending",
      }));
      await saveActions(actor, saved.id, actions);
      emit({ type: "actions", messageId: saved.id, actions });
      return;
    }
  }
  const stopped = await insertMessage(actor, conversation.id, {
    role: "assistant",
    content: "I've stopped after a lot of steps. Ask again more narrowly, or say \"carry on\".",
  });
  emit({ type: "message", message: display(stopped) });
}

export async function sendMessage(
  actor: UserActor,
  input: { conversationId?: string | null; message: string; model: unknown; reasoning: unknown; webSearch: unknown },
  emit: Emit,
  options: { deadline: number; fetchImpl?: typeof fetch },
) {
  const message = input.message.trim();
  if (!message) throw new AssistantError("Type a message first.");
  if (message.length > MESSAGE_MAX) {
    throw new AssistantError(
      `That message is ${message.length.toLocaleString("en-GB")} characters. The limit is ${MESSAGE_MAX.toLocaleString("en-GB")}. Cut ${(message.length - MESSAGE_MAX).toLocaleString("en-GB")} characters and send it again.`,
    );
  }
  const settings = settingsFor(input.model, input.reasoning);
  const conversation = await openConversation(actor, {
    conversationId: input.conversationId,
    model: settings.model,
    reasoning: settings.reasoning,
    webSearch: input.webSearch === true,
    title: titleFrom(message),
  });
  emit({ type: "conversation", conversation: summary(conversation) });
  const rows = await withActor(actor, (db) => readMessages(db, conversation.id));
  await declinePending(actor, conversation.id, rows, "The user moved on without confirming this action.");
  const user = await insertMessage(actor, conversation.id, { role: "user", content: message });
  emit({ type: "user", message: display(user) });
  await runLoop(actor, conversation, emit, options.deadline, options.fetchImpl);
  emit({ type: "done" });
}

export type ActionDecision = { id: string; approve: boolean; variant?: "send" };

export async function decideActions(
  actor: UserActor,
  input: { conversationId: string; decisions: ActionDecision[] },
  emit: Emit,
  options: { deadline: number; fetchImpl?: typeof fetch },
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
  let actions = owner.actions ?? [];
  const update = async (id: string, patch: Partial<AssistantAction>) => {
    actions = actions.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
    await saveActions(actor, owner.id, actions);
    emit({ type: "actions", messageId: owner.id, actions });
  };
  for (const action of chosen) {
    const call = (owner.tool_calls ?? []).find((entry) => entry.id === action.id);
    if (!decisions.get(action.id) || !call) {
      await insertMessage(actor, conversation.id, {
        role: "tool",
        content: toolJson({ declined: true, message: "The user declined this action." }),
        toolCallId: action.id,
        toolName: action.name,
      });
      await update(action.id, { status: "declined" });
      continue;
    }
    const alternative = variants.get(action.id) ? ACTION_ALTERNATIVES[action.name] : undefined;
    const chosenAlternative = alternative && alternative.key === variants.get(action.id) ? alternative : undefined;
    await update(action.id, { status: "running" });
    const output = (await runTool(actor, chosenAlternative?.tool ?? call.function.name, parseArgs(call.function.arguments))) as Record<string, unknown> | null;
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
  await runLoop(actor, conversation, emit, options.deadline, options.fetchImpl);
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
