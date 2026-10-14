"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";
import {
  acceptActionItem,
  dismissActionItem,
  getInsightTranscript,
  summariseCall,
} from "@/lib/crm/call-insights";
import { TASKS_PATH } from "@/lib/crm/task-views";
import type { CallInsight } from "@/lib/crm/types";
import { revalidateRecordPages } from "@/lib/revalidate";

export type CallInsightActionState = {
  error?: string;
  field?: string;
  ok?: boolean;
  insight?: CallInsight;
};

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function refresh() {
  revalidatePath("/");
  revalidateRecordPages();
  revalidatePath("/contacts");
  revalidatePath("/activities");
  revalidatePath(TASKS_PATH);
}

export async function summariseCallAction(
  activityId: string,
  transcript: string,
): Promise<CallInsightActionState> {
  const user = await requireUser();
  try {
    const insight = await summariseCall(user, activityId, transcript, { source: "manual" });
    refresh();
    if (insight.status === "failed") {
      return { error: insight.error ?? "Could not summarise the call.", insight };
    }
    return { ok: true, insight };
  } catch (error) {
    return actionError(error);
  }
}

export async function acceptCallActionAction(
  insightId: string,
  itemId: string,
): Promise<CallInsightActionState> {
  const user = await requireUser();
  try {
    const accepted = await acceptActionItem(user, insightId, itemId, undefined, {
      provenance: { operation: "accept_call_action", source: "web" },
    });
    refresh();
    return { ok: true, insight: accepted.insight };
  } catch (error) {
    return actionError(error);
  }
}

export async function dismissCallActionAction(
  insightId: string,
  itemId: string,
): Promise<CallInsightActionState> {
  const user = await requireUser();
  try {
    const insight = await dismissActionItem(user, insightId, itemId);
    refresh();
    return { ok: true, insight };
  } catch (error) {
    return actionError(error);
  }
}

export async function callTranscriptAction(
  insightId: string,
): Promise<{ error?: string; transcript?: string }> {
  const user = await requireUser();
  try {
    return { transcript: await getInsightTranscript(user, insightId) };
  } catch (error) {
    return actionError(error);
  }
}
