import type { UserActor } from "@/lib/crm/types";
import type { DocsNav, DocsSeed, Page, PageFilter, PageSummary } from "@/lib/docs/client-types";
import { localDate } from "@/lib/docs/daily";
import { personParticipant } from "@/lib/docs/participants";
import type { DocsRoute } from "@/lib/docs/routes";
import { docsDailyNote, docsList, docsPage } from "@/lib/docs/view";

export type DocsInitial = {
  list: PageFilter;
  summaries: PageSummary[];
  page: Page | null;
};

export function docsSeed(user: UserActor): DocsSeed {
  return { now: new Date().toISOString(), workspaceId: user.workspaceId, viewer: { id: user.userId, name: user.fullName || user.email } };
}

export function emptyDocsNav(user: UserActor): DocsNav {
  return {
    viewer: personParticipant({ id: user.userId, name: user.fullName || user.email }, user.userId),
    folders: [],
    tags: [],
    dailyCount: 0,
    today: localDate(),
    todayNote: null,
  };
}

export async function loadDocsInitial(user: UserActor, route: DocsRoute): Promise<DocsInitial> {
  const date = route.date ?? (route.list.kind === "daily" && !route.pageId ? localDate() : null);
  const [summaries, first] = await Promise.all([
    docsList(user, route.list),
    route.pageId ? docsPage(user, route.pageId) : date ? docsDailyNote(user, date).catch(() => null) : Promise.resolve(null),
  ]);
  let page = first;
  if (!page && !route.pageId && route.list.kind !== "daily" && summaries[0]) page = await docsPage(user, summaries[0].id);
  return { list: route.list, summaries, page };
}
