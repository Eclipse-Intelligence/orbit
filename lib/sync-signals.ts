import { publishLiveBatch } from "@/lib/docs/live/broadcast";
import { personTopic, type SyncedKind, type SyncedMessage } from "@/lib/docs/live/protocol";

export async function signalSynced(userId: string, kind: SyncedKind) {
  const payload: SyncedMessage = { kind };
  await publishLiveBatch([{ topic: personTopic(userId), event: "synced", payload }]).catch((error) =>
    console.error("Sync signal failed", error instanceof Error ? error.name : "unknown"),
  );
}
