import { bindMailCache } from "@/components/mail/mail-cache";
import { forgetSharePeople } from "@/components/mail/share-client";
import { forgetQuotes } from "@/lib/chat/quotes";
import { forgetRecordCards } from "@/lib/chat/record-cards";

export function bindSessionCaches(userId: string) {
  if (typeof window === "undefined") return false;
  if (!bindMailCache(userId)) return false;
  forgetSharePeople();
  forgetQuotes();
  forgetRecordCards();
  return true;
}
