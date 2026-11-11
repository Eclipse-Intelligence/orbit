import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import ChatScreen, { type ChatInitial } from "@/components/chat/chat-screen";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { chatSegments, isChatId } from "@/lib/chat/routes";
import { getRoom, listConversations, listMessages, listThread, listThreads } from "@/lib/crm/chat";
import { CrmError } from "@/lib/crm/errors";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Chat" };

function requestTime() {
  return Date.now();
}

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null;
}

function failure(fallback: string) {
  return (error: unknown) => {
    if (!(error instanceof CrmError)) console.error(fallback, error);
    return { error: error instanceof CrmError ? error.message : fallback };
  };
}

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [{ slug = [] }, search] = await Promise.all([params, searchParams]);
  const view = chatSegments(slug);
  if (!view) notFound();
  const threadParam = single(search.thread);
  const messageParam = single(search.message);
  const thread = view.kind !== "home" && isChatId(threadParam) ? threadParam.toLowerCase() : null;
  const message = view.kind === "room" && isChatId(messageParam) ? messageParam.toLowerCase() : null;
  const roomId = view.kind === "room" ? view.id : null;

  const [sidebar, workspaces, room, page, threadData, threads] = await Promise.all([
    listConversations(user).catch(failure("Couldn't load Chat. Try again.")),
    getWorkspaceChoices(),
    roomId ? getRoom(user, roomId).catch(failure("Couldn't load the conversation. Try again.")) : null,
    roomId ? listMessages(user, roomId, { around: message ?? "unread" }).catch(failure("Couldn't load messages. Try again.")) : null,
    thread ? listThread(user, thread).catch(failure("Couldn't load the thread. Try again.")) : null,
    view.kind === "threads" ? listThreads(user).catch(failure("Couldn't load threads. Try again.")) : null,
  ]);

  const initial: ChatInitial = {
    location: { view, thread, message },
    sidebar: "error" in sidebar ? null : sidebar,
    room,
    page,
    thread: threadData,
    threads,
  };

  return (
    <ChatScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
        workspaceId: user.workspaceId,
      }}
      workspaces={workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
      initial={initial}
      now={requestTime()}
    />
  );
}
