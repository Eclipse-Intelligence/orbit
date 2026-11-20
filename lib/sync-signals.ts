import { publishLiveBatch } from "@/lib/docs/live/broadcast";
import { personTopic, workspaceTopic, type SyncedKind, type SyncedMessage } from "@/lib/docs/live/protocol";

export async function signalSynced(userId: string, kind: SyncedKind, origin?: string | null) {
  const payload: SyncedMessage = origin ? { kind, origin } : { kind };
  await publishLiveBatch([{ topic: personTopic(userId), event: "synced", payload }]).catch((error) =>
    console.error("Sync signal failed", error instanceof Error ? error.name : "unknown"),
  );
}

export async function signalCampaigns(workspaceId: string) {
  const payload: SyncedMessage = { kind: "campaigns" };
  await publishLiveBatch([{ topic: workspaceTopic(workspaceId), event: "synced", payload }]).catch((error) =>
    console.error("Campaign signal failed", error instanceof Error ? error.name : "unknown"),
  );
}
